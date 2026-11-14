/**
 * FK 回滚插件 · 重启助手（WMI 拉起）
 *
 * @version 1.5.3
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
 * 清理累积的认证 Cookie（v1.5.2 新增）。
 *
 * 为什么放在这个文件里：
 *   本进程由 WMI 拉起，**活在 DSH 进程树之外**。
 *   它把 DSH 杀干净、等到端口释放之后，Chromium 对 Cookies 库的
 *   独占锁就没了 —— 这是唯一能安全改这个库的时刻。
 *   用户点一次「重启」，就能顺道把累积的 Cookie 清掉，
 *   不必自己「先退出 DSH，再双击 .bat，再打开」。
 *
 * 依据（2026-10-26 事故）：
 *   · cookie 名 = "dsh-auth-" + sha256("127.0.0.1:端口")
 *   · 端口每次启动都变 → 每次新增一个，旧的不清理
 *   · 累积到 71 个时请求头 16,584 B > Node 上限 16,384
 *   · → HPE_HEADER_OVERFLOW → "Web authentication failed" 起不来
 *   · 旧 cookie 的 authority 含旧端口，下次启动永远匹配不上，
 *     所以删掉它们【不会影响任何功能】，账号也不在这里。
 *
 * 失败绝不阻断重启：清理是加分项，重启才是用户的真实意图。
 *
 * @param {object|null} cfg  { dbPath, backupDir, markerPath }
 * @returns {{removed?:number, skipped?:string, error?:string, backupPath?:string}}
 */
function cleanAuthCookies(cfg) {
  if (cfg === null || typeof cfg !== 'object') return { skipped: 'no config' }
  const dbPath = cfg.dbPath
  if (typeof dbPath !== 'string' || dbPath === '') return { skipped: 'no dbPath' }
  if (!fs.existsSync(dbPath)) return { skipped: 'cookies db not found' }

  // ① 先备份 —— 不备份就不删，宁可返回错误
  let backupPath = null
  try {
    const dir = String(cfg.backupDir ?? path.join(path.dirname(dbPath), '_cookie-backup'))
    fs.mkdirSync(dir, { recursive: true })
    backupPath = path.join(dir, 'Cookies')
    fs.copyFileSync(dbPath, backupPath)
  } catch (e) {
    return { error: `backup failed: ${String(e && e.message ? e.message : e)}` }
  }

  // ② 统计 + 删除
  // ── 统计 + 删除（一次打开，先读后删）──
  //
  // 这里是【唯一能拿到真实值的地方】：DSH 已退出、Chromium 已释放独占锁。
  // 所以除了删除，还要把看到的真实情况完整记下来 ——
  // 面板运行时读不到，只能靠这份快照说话。
  let removed = 0
  let observed = 0
  let total = 0
  let headerBytes = 0
  let oldest = null
  let newest = null
  const portList = []
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      const WHERE = "host_key IN ('127.0.0.1','localhost') AND name LIKE 'dsh-auth-%'"

      try { total = Number(db.prepare('SELECT COUNT(*) AS n FROM cookies').get().n ?? 0) } catch { total = 0 }

      const rows = db.prepare(`SELECT name, value FROM cookies WHERE ${WHERE}`).all()
      observed = rows.length
      const seenPorts = new Set()
      for (const r of rows) {
        const nm = String(r.name ?? '')
        const val = String(r.value ?? '')
        headerBytes += nm.length + 1 + val.length + 2
        try {
          const parts = val.split('.')
          if (parts.length >= 2) {
            const j = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
            if (typeof j.authority === 'string') {
              const m = j.authority.match(/:(\d+)$/)
              if (m) seenPorts.add(Number(m[1]))
            }
            if (typeof j.issuedAt === 'number') {
              if (oldest === null || j.issuedAt < oldest) oldest = j.issuedAt
              if (newest === null || j.issuedAt > newest) newest = j.issuedAt
            }
          }
        } catch { /* payload 解析失败不影响计数 */ }
      }
      portList.push(...[...seenPorts].sort((a, b) => a - b))

      if (observed > 0) {
        db.prepare(`DELETE FROM cookies WHERE ${WHERE}`).run()
        removed = observed
      }
    } finally {
      try { db.close() } catch { /* 忽略 */ }
    }
  } catch (e) {
    return { error: `delete failed: ${String(e && e.message ? e.message : e)}`, backupPath }
  }

  // ③ 清 0 字节 journal（残留会让 Chromium 以为事务未完成）
  try {
    const j = `${dbPath}-journal`
    if (fs.existsSync(j) && fs.statSync(j).size === 0) fs.unlinkSync(j)
  } catch { /* 忽略 */ }

  // ④ 无论清掉几个，都留下这份「实测快照」
  //
  //   ⚠️ 不能以 removed > 0 为条件（原实现的缺陷）：
  //      那样「这次没有 cookie 需要清」就什么也不记，
  //      面板永远显示「还没有实测记录」，用户永远无法核对推算值。
  //
  //   快照是面板唯一的真实数据来源，必须每次都写。
  const snapshot = {
    at: new Date().toISOString(),
    observed,                    // 真实 dsh-auth-* 数量（窗口期实测）
    total,                       // 库内 cookie 总数（含非 dsh-auth）
    removed,                     // 这次清掉几个
    headerBytes,                 // 这些 cookie 在请求头里占多少字节
    headerBudget: 15984,         // Node maxHeaderSize 16384 - 其他头 400
    ratio: headerBytes / 15984,
    ports: portList,             // 涉及的端口（证明每次启动换一个）
    oldest: oldest ?? null,
    newest: newest ?? null,
    backupPath,
    source: 'relaunch-helper',
    // 谁触发的这次重启（两个插件共用 restart-helper/，靠它区分来源）
    triggeredBy: typeof cfg.triggeredBy === 'string' ? cfg.triggeredBy : null,
  }
  if (typeof cfg.markerPath === 'string' && cfg.markerPath !== '') {
    try {
      fs.mkdirSync(path.dirname(cfg.markerPath), { recursive: true })
      fs.writeFileSync(cfg.markerPath, JSON.stringify(snapshot, null, 2), 'utf8')
    } catch { /* 标记写失败不影响清理 */ }
  }

  return { removed, observed, total, headerBytes, ports: portList.length, backupPath }
}

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
    //   2026-10-30 实测修正 —— 原来那套「①②③」两个地方都是错的：
    //
    //   **错误一：`taskkill /T` 不带 /F，永远到不了主进程。**
    //   /T 深度优先，先打子进程。Electron 的子进程回答
    //   "can only be terminated forcefully (with /F option)"，
    //   跑 app.asar 的子进程回答 "The process cannot terminate itself."，
    //   轮到主进程时报 "One or more child processes were still running." 就放弃 ——
    //   exit=128，主进程根本没收到 WM_CLOSE。5 次重启（07:59/08:56/13:02/13:31/13:54）
    //   全是 exit=128，这条优雅路径从来没成功过。
    //   实测对照：不带 /T 时 exit=0，出现 "SUCCESS: Sent termination signal"。
    //
    //   **错误二：就算 WM_CLOSE 送到了，DSH 也不会退。**
    //   读 app.asar/lib/main.js 的 before-quit：
    //       event.preventDefault()                       // 先阻止退出
    //       if (skipQuitConfirmation || sessionEnding) { finishQuit(); return }
    //       quitConfirmation.confirm().then(...)         // 否则弹「确认退出」对话框
    //   WM_CLOSE 最终走到这里 → 取消退出 + 弹框等人点。自动重启时没人点，
    //   所以原来那 8 秒是每次必赔的死等（14:29 那次 exit=0 但仍是
    //   "did NOT exit gracefully"）。
    //
    //   真正 flush 的地方在 finishQuit() → backend.close()，只有退出没被阻止才执行。
    //   要走到它得用 DSH 自己的 shutdown 指令，不是窗口消息 —— 那是另一个改动。
    //
    //   现在：发 WM_CLOSE（万一有人手点确认还能走优雅），只等 1.5 秒，然后强杀。

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

    const GRACEFUL_WAIT_MS = 1500
    const FORCED_WAIT_MS = 5000

    log('graceful shutdown: WM_CLOSE to the app root (no /T, no /F)')
    runTaskkill(['/PID', String(appPid)], 'taskkill(graceful)')

    let gone = false
    let waitedMs = 0
    for (; waitedMs < GRACEFUL_WAIT_MS; waitedMs += 400) {
      await sleep(400)
      if (!alive(appPid)) { gone = true; break }
    }

    if (gone) {
      log(`app exited gracefully after ~${String(Math.round(waitedMs / 1000) || '1')}s; state flushed properly`)
    } else {
      log('app did NOT exit gracefully; escalating to forced kill (may risk state corruption)')
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

  // ───────────────────────────────────────────────────────────
  // ⭐ v1.5.2：趁 DSH 已经完全退出、端口已释放的空窗期清理 Cookie
  //
  //   Chromium 只在 DSH 活着时独占 Cookies 库；这一刻没人持有它，
  //   是唯一能安全改写的时机。清理失败不影响重启。
  // ───────────────────────────────────────────────────────────
  if (config.cookies !== undefined && config.cookies !== null) {
    try {
      const r = cleanAuthCookies(config.cookies)
      if (r.error !== undefined) {
        log(`cookie cleanup FAILED (continuing): ${r.error}`)
      } else if (r.skipped !== undefined) {
        log(`cookie cleanup skipped: ${r.skipped}`)
      } else {
        log(r.removed > 0
          ? `cookie cleanup removed ${String(r.removed)} dsh-auth-* (backup: ${String(r.backupPath)})`
          : 'cookie cleanup: nothing to remove')
      }
    } catch (e) {
      log(`cookie cleanup threw (continuing): ${String(e && e.message ? e.message : e)}`)
    }
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
