/**
 * FK 回滚插件 · 重启助手（WMI 拉起）
 *
 * @version 1.5.1
 */
// dsh-restart-button — relaunch helper.
//
// This file is the one piece of the plugin that runs OUTSIDE the DSH process
// tree. It is started through WMI (`Win32_Process.Create`), which parents it to
// WmiPrvSE.exe rather than to DSH, so it survives the `taskkill /T` that takes
// DSH down and is still there to start the app again.
//
// It is a Node script rather than PowerShell for a measured reason: on this
// machine a WMI-created `powershell.exe` fails to start at all ("access denied",
// no output, no log), while the bundled `node.exe` runs correctly from the very
// same context - including from a path containing CJK. Node also reads its own
// configuration as UTF-8 with no codec questions, which matters because the
// application path may contain non-ASCII characters (e.g. a CJK install dir).
//
// Usage: node relaunch-helper.cjs <config.json path>
//
// The config carries: appPid, exePath, port, workingDir, env.

'use strict'

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const configPath = process.argv[2]
const logPath = configPath === undefined
  ? path.join(__dirname, 'relaunch.log')
  : path.join(path.dirname(configPath), 'relaunch.log')

/** Append one timestamped line. Never throws: a log failure must not stop a restart. */
function log(message) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()}  ${message}\n`, 'utf8')
  } catch {
    /* logging is best effort */
  }
}

/** Promise-based sleep. */
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms) })

/**
 * Read a Windows executable's PE subsystem.
 *
 * Needed because `windowsHide` means different things for the two programs this
 * helper deals with, and getting it wrong is invisible until someone looks at the
 * screen. Subsystem 2 is a GUI application and 3 is a console application; the
 * value is read from the header rather than assumed from the file name, so a
 * future rename cannot silently change the answer.
 *
 * @param file - absolute path of an executable.
 * @returns 2 for GUI, 3 for console, or null when it cannot be determined.
 */
function peSubsystem(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const header = Buffer.alloc(4096)
    const read = fs.readSync(fd, header, 0, header.length, 0)
    if (read < 64 || header.toString('ascii', 0, 2) !== 'MZ') return null
    const peOffset = header.readUInt32LE(0x3c)
    if (peOffset + 24 > read) return null
    if (header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null
    const optional = peOffset + 24
    const magic = header.readUInt16LE(optional)
    if (magic !== 0x10b && magic !== 0x20b) return null
    // Subsystem sits at offset 68 in both PE32 and PE32+ optional headers.
    return header.readUInt16LE(optional + 68)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

/**
 * Resolve a Windows system binary by absolute path.
 *
 * Nothing in this file may call a system tool by BARE NAME. Measured on the
 * machine this plugin was written for: its machine-level PATH has two mangled
 * entries (`%Syste;Root%\system32` instead of `%SystemRoot%\system32`), so
 * System32 is not on PATH and bare-name spawns fail with ENOENT while the same
 * binaries run perfectly when given a full path. That is what broke the restart
 * button once already.
 *
 * @param parts - path segments below the Windows directory.
 * @returns the absolute path that exists, or null.
 */
function systemBinary(parts) {
  const roots = [process.env.SystemRoot, process.env.windir, 'C:\\Windows']
  const seen = new Set()
  for (const root of roots) {
    if (typeof root !== 'string' || root === '' || seen.has(root)) continue
    seen.add(root)
    const candidate = path.join(root, ...parts)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* try the next root */
    }
  }
  return null
}

const TASKLIST = systemBinary(['System32', 'tasklist.exe'])
const TASKKILL = systemBinary(['System32', 'taskkill.exe'])

/**
 * Whether a PID is still alive.
 *
 * `process.kill(pid, 0)` is used rather than `tasklist`, because it needs no
 * external binary at all: a signal of 0 performs the permission and existence
 * checks and stops there. EPERM means the process EXISTS but belongs to someone
 * else, which for this purpose counts as alive.
 *
 * @param pid - process id.
 * @returns whether it is still running.
 */
function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Image name of a PID, or null when it cannot be determined.
 *
 * @param pid - target process id.
 * @returns the executable's file name, e.g. "DeepSeek Harness.exe", or null.
 */
function imageNameOf(pid) {
  if (TASKLIST === null) return null
  const result = spawnSync(TASKLIST, ['/FI', `PID eq ${String(pid)}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const line = String(result.stdout ?? '').trim().split('\n')[0] ?? ''
  const match = /^"([^"]+)"/.exec(line.trim())
  return match === null ? null : match[1]
}

/** Whether anything is listening on the port. */
function portBusy(port) {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const settle = (value) => {
      try { socket.destroy() } catch { /* already gone */ }
      done(value)
    }
    socket.setTimeout(700)
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.once('timeout', () => settle(false))
  })
}

/**
 * Start the application and report its PID, or null on failure.
 *
 * The `try/catch` is NOT what makes this safe, and believing it was is a mistake
 * that has already been made here once. `spawn` reports a missing or unrunnable
 * executable asynchronously through an `'error'` event, not by throwing - measured:
 * spawning a nonexistent path returned normally with `child.pid === undefined` and
 * fired `'error'` with ENOENT a moment later. An `'error'` event with no listener
 * is rethrown as an uncaught exception, so the old version would have crashed the
 * helper on the third failed attempt and never written the "reopen DSH by hand"
 * line that the failure ladder exists to produce.
 *
 * So the listener is the fix, and the promise waits for either outcome: `'spawn'`
 * (the process really started) or `'error'` (it did not).
 *
 * WHY `windowsHide` IS FALSE HERE, WHILE THE HELPER'S OWN CREATION USES SW_HIDE
 *
 * These look like the same problem and are not, and treating them as one caused a
 * real regression: the app was relaunched into the background with no visible
 * window.
 *
 * The two programs are different PE kinds - measured from their headers:
 *
 *   DeepSeek Harness.exe  subsystem 2 = GUI (windows)
 *   node.exe              subsystem 3 = CONSOLE
 *
 * `windowsHide: true` maps to libuv's UV_PROCESS_WINDOWS_HIDE, which sets BOTH
 * CREATE_NO_WINDOW and STARTF_USESHOWWINDOW with SW_HIDE. For a console program
 * that hides the console - correct, and what the helper needs. For a GUI program
 * there is no console to hide, so the same flag applies SW_HIDE to the process's
 * own first window: the application starts, fully functional, with no window on
 * screen. That is exactly what a user reported.
 *
 * The application draws its own window and must be left to do so. The console
 * window the user saw came from the HELPER's creation, not from here.
 *
 * @param exePath - absolute path of the application executable.
 * @param workingDir - directory to start it in, or null.
 * @param env - extra environment variables to merge over this process's.
 * @returns the new process id, or null when it could not be started.
 */
function launch(exePath, workingDir, env) {
  return new Promise((resolve) => {
    // The flag is derived from the binary rather than hardcoded, and logged, so a
    // wrong answer here is visible in the restart log instead of only on screen.
    // A GUI binary must never be hidden: `windowsHide` would apply SW_HIDE to its
    // own window and it would start with nothing on screen. A console binary must
    // be hidden, or it allocates a console the user can see and close.
    const subsystem = peSubsystem(exePath)
    const hide = subsystem === 3
    log(`launch: subsystem=${String(subsystem ?? 'unknown')} windowsHide=${String(hide)} (${subsystem === 2 ? 'GUI: window must stay visible' : subsystem === 3 ? 'console: hide the console' : 'unknown: leaving the window visible'})`)

    let child
    try {
      child = spawn(exePath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: hide,
        ...(workingDir === null || workingDir === undefined ? {} : { cwd: workingDir }),
        env: { ...process.env, ...env },
      })
    } catch (error) {
      // A synchronous throw is still possible for argument errors, so it is kept
      // as well - it just is not the path a missing file takes.
      log(`launch threw: ${String(error && error.message ? error.message : error)}`)
      resolve(null)
      return
    }

    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    child.once('error', (error) => {
      log(`launch failed: ${String(error && error.code ? error.code : error)} ${exePath}`)
      settle(null)
    })
    child.once('spawn', () => {
      const pid = child.pid ?? null
      try {
        child.unref()
      } catch {
        /* unref is best effort; the process is already running */
      }
      settle(pid)
    })
  })
}

async function main() {
  let config
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    log(`cannot read ${String(configPath)}: ${String(error.message)}`)
    process.exit(2)
  }

  const appPid = Number(config.appPid)
  const exePath = String(config.exePath)
  const port = Number(config.port)
  const workingDir = config.workingDir ?? null
  const env = config.env ?? {}
  // How long to wait before killing anything. The default covers the round trip
  // of the HTTP response that started this helper; the field exists so a caller
  // that needs a longer runway can ask for one without editing this file.
  const graceMs = Number.isFinite(Number(config.graceMs)) ? Number(config.graceMs) : 1200
  // Check everything, kill nothing. Used to exercise the creation path - and the
  // route that drives it - without restarting a DSH that may be mid-task.
  const dryRun = config.dryRun === true

  log(`start: helper pid ${String(process.pid)}; appPid=${String(appPid)} port=${String(port)} exe=${exePath}${dryRun ? ' [DRY RUN]' : ''}`)

  // Let the HTTP response that started this helper reach the browser first.
  await sleep(graceMs)

  // A dry run reports exactly what it found and stops. Reporting is the point: the
  // failure that motivated this mode was a restart that did nothing visible, where
  // the only clue was a log line nobody had reason to open.
  if (dryRun) {
    const expected = path.basename(exePath)
    const actual = imageNameOf(appPid)
    const busy = await portBusy(port)
    log(`dry run: target alive=${String(alive(appPid))} image=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
    log(`dry run: port ${String(port)} busy=${String(busy)}`)
    log(`dry run: tasklist=${JSON.stringify(TASKLIST)} taskkill=${JSON.stringify(TASKKILL)}`)
    log(`dry run: launch target exists=${String(fs.existsSync(exePath))}`)
    const verdict = actual !== null && actual.toLowerCase() === expected.toLowerCase()
      ? 'target verified, everything needed is present; a real run would kill and relaunch'
      : 'target NOT verified; a real run would refuse'
    log(`dry run: ${verdict}`)
    log('done')
    process.exit(0)
  }

  // Never kill a process that is not the application binary. If the PID was
  // reused, or this is not the desktop app at all, stopping here is the whole
  // difference between a restart and a wrecked session.
  if (!alive(appPid)) {
    log('target pid is already gone; nothing to kill')
  } else {
    const expected = path.basename(exePath)
    const actual = imageNameOf(appPid)
    if (actual !== null && actual.toLowerCase() !== expected.toLowerCase()) {
      log(`REFUSING to kill pid ${String(appPid)}: image is "${actual}", expected "${expected}"`)
      process.exit(3)
    }
    if (actual === null) {
      // The image name could not be read, so the check that makes this safe did
      // not run. Killing anyway would be the difference between a restart and a
      // wrecked session if the PID had been reused, so it does not happen.
      log(`REFUSING to kill pid ${String(appPid)}: could not read its image name to verify it is "${expected}"`)
      process.exit(3)
    }

    if (TASKKILL === null) {
      log('cannot find taskkill.exe under System32; not killing anything')
      process.exit(4)
    }

    // ── 优雅关闭优先（2026-10-22 事故后改进）─────────────────────────
    //
    // ⚠️ 为什么不能直接 /F：
    //   DSH 桌面版 = Electron。强制终止（/F）会让 Chromium 的 LevelDB
    //   （Cookies / shared_proto_db）来不及 flush 写缓冲，导致库结构损坏。
    //   2026-10-22 的真实事故就是：强杀 → 状态库坏 → DSH 报
    //   "Web authentication failed" 完全起不来，而配置快照救不了它。
    //
    //   DSH 官方自己的 stop() 就是这么做的（app.asar lib/main.js）：
    //     child.send({ type: "shutdown" })
    //     → 等 10s → child.kill("SIGTERM")
    //     → 等 5s  → child.kill("SIGKILL")
    //
    //   这里用 taskkill 的等价序列（不带 /F == 请求关闭，带 /F == 强杀）：
    //   ① taskkill /T          → 等 8s  （给 Chromium 机会 flush + 关库）
    //   ② taskkill /T /F       → 等 5s  （还不退才强杀）
    //   ③ 仍不退 → 走原来的 40s 清理等待，最终报 WARNING
    //
    //   代价：重启慢约 8 秒。收益：几乎不会再写坏状态库。

    const runTaskkill = (args, label) => {
      const r = spawnSync(TASKKILL, args, { windowsHide: true })
      // taskkill writes its message in the console codepage (GBK on this machine),
      // so the text decodes to mojibake under UTF-8; the exit status is the part
      // that can be trusted, and the text is kept only when it survives as ASCII.
      const text = r.stdout === null ? '' : r.stdout.toString('utf8')
      const ascii = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? ` ${text.trim()}` : ''
      log(`${label} exit=${String(r.status)}${ascii}`)
      return r
    }

    const GRACEFUL_WAIT_MS = 8000
    const FORCED_WAIT_MS = 5000

    log('graceful shutdown: asking the app to close (no /F) so Chromium can flush its LevelDB')
    runTaskkill(['/PID', String(appPid), '/T'], 'taskkill(graceful)')

    let gone = false
    for (let waited = 0; waited < GRACEFUL_WAIT_MS; waited += 400) {
      await sleep(400)
      if (!alive(appPid)) { gone = true; break }
    }

    if (gone) {
      log(`app exited gracefully after ~${String(Math.round(GRACEFUL_WAIT_MS / 1000))}s; state flushed properly`)
    } else {
      log('app did NOT exit gracefully; escalating to forced kill (this may risk state corruption)')
      runTaskkill(['/PID', String(appPid), '/T', '/F'], 'taskkill(forced)')
      for (let waited = 0; waited < FORCED_WAIT_MS; waited += 400) {
        await sleep(400)
        if (!alive(appPid)) { gone = true; break }
      }
      if (gone) log('app exited after forced kill')
      else log('WARNING: app is still alive after forced kill')
    }
  }

  // Wait for the process AND the listening port to clear. The port is the one
  // that actually matters: starting the app while the old server still holds it
  // gives an app that cannot serve, which is worse than not restarting.
  //
  // `port` comes from the config, written by the Host from the port it observed
  // itself being served on - not from a constant. The host assigns its port
  // dynamically, so a guessed number would make this loop wait for something that
  // was never bound.
  const deadline = Date.now() + 40000
  let cleared = false
  while (Date.now() < deadline) {
    const busy = await portBusy(port)
    if (!alive(appPid) && !busy) {
      cleared = true
      break
    }
    await sleep(400)
  }
  // Said differently depending on what actually happened. The previous version
  // logged "process and port are clear; launching" unconditionally, which is a
  // lie in precisely the case the log exists to explain - and a reader chasing a
  // failed restart would have been told everything was fine.
  if (cleared) {
    log('process and port are clear; launching')
  } else {
    log(
      `WARNING: after 40s the old process is ${alive(appPid) ? 'still alive' : 'gone'} `
      + `and port ${String(port)} is still held; launching anyway`,
    )
  }

  let started = null
  for (let attempt = 1; attempt <= 3 && started === null; attempt += 1) {
    started = await launch(exePath, workingDir, env)
    log(started === null ? `launch attempt ${String(attempt)} failed` : `launched pid ${String(started)} on attempt ${String(attempt)}`)
    if (started === null) await sleep(800)
  }

  if (started === null) {
    log('LAUNCH FAILED - DSH has to be reopened by hand')
    process.exit(4)
  }
  log('done')
}

main().catch((error) => {
  log(`helper failed: ${String(error && error.stack ? error.stack : error)}`)
  process.exit(1)
})
