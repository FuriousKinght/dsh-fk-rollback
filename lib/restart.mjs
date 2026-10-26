/**
 * FK 回滚设置 —— 内置重启能力（2026-10-20 移植）
 *
 * ⚠️ 为什么内置而不是依赖别的插件：
 *   用户反馈「我要把插件发布出去，不可能要人安装套装吧，必须按个重启插件」
 *
 *   原来「立即重启」按钮依赖 dsh-fk-restart-button，用户得装两个插件。
 *   发布场景下这不可接受 —— 所以把重启能力搬进来，零外部依赖。
 *
 * ⚠️ 逻辑来源与致谢：
 *   移植自 dsh-fk-restart-button（同作者自研）。
 *   WMI 创建助手、taskkill /T 杀树、隐藏窗口等坑都已在该插件里实测并注释，
 *   这里保留关键说明，避免后人重踩。
 *
 * ─────────────────────────────────────────────────────────────
 * 核心原理（务必理解，否则改动会踩坑）
 * ─────────────────────────────────────────────────────────────
 *
 * DSH 桌面版是 Electron：
 *   DeepSeek Harness.exe (PID A)  ← 拥有窗口
 *        └─ spawn → Host 进程 (PID B)  ← 本插件在这里，带 IPC 通道
 *
 * 重启的唯一办法：杀掉 A、重新启动 A。
 * 但只杀 A 不够 —— B（还占着 webServer 端口）会变成孤儿，端口不释放，
 * 重启后的新实例起不来。所以必须 taskkill /T 杀整棵树。
 *
 * 问题来了：如果助手进程是我们正常 spawn 的，它也在那棵树里，会被一起杀掉。
 *
 * 解法：用 WMI 的 Win32_Process.Create 创建助手进程 ——
 *       它的父进程是 WmiPrvSE.exe，不在我们的进程树里，能活下来完成重启。
 *
 * ─────────────────────────────────────────────────────────────
 * 其他必须知道的坑（都实测过）
 * ─────────────────────────────────────────────────────────────
 *
 * ① 不能按裸名调 system32 程序（powershell.exe / taskkill.exe）
 *    有的机器 PATH 被写坏（System32 不在 PATH），裸名 spawn 会 ENOENT。
 *    → 统一用 systemBinary() 走绝对路径。
 *
 * ② WMI 创建进程时必须传 ProcessStartupInformation { ShowWindow: 0 }
 *    不传会分配控制台 → 弹出一个可见终端窗口 → 用户关掉窗口就杀掉助手。
 *    （实测：plain 模式弹出 2 个终端窗口；ShowWindow=0 是 0 个）
 *
 * ③ 助手必须跑在 DSH 自带的 node.exe 上，不能用 PowerShell 脚本实现
 *    实测该机器上 WMI 创建的 powershell.exe 会"access denied"秒退。
 *    而且 node 能避开 CJK 路径的编码问题。
 *
 * ④ 端口不能写死 19387
 *    实测某些构建不传 --port，服务端绑动态端口（如 59292）。
 *    写死会导致助手等一个不存在的端口，白白耗掉 40 秒宽限期。
 *    → 用 discoverPort() 从请求的 Host 头里读真实端口。
 *
 * ⑤ 助手配置走 sidecar config.json（UTF-8），助手脚本里不出现任何路径
 *    因为 exe 路径可能含 CJK（例如安装目录是中文），写进脚本会有编码风险。
 *
 * @module dsh-fk-rollback/lib/restart
  *
 * @version 1.5.1
 * @module 重启能力（v1.3.0 内置）
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 兜底端口。仅在无法从请求头发现真实端口时用。 */
const FALLBACK_PORT = 19387

/** 重启助手脚本（与本模块同目录）。 */
const HELPER_SCRIPT = fileURLToPath(new URL('./relaunch-helper.cjs', import.meta.url))

/** 助手读取的 sidecar 配置文件名。 */
const HELPER_CONFIG = 'config.json'

/**
 * 本次进程的身份令牌。
 *
 * 前端靠它判断「回来的还是不是同一个 DSH」——
 * 重启必然产生新进程 = 新令牌 = 页面该刷新了。
 */
export const BOOT_TOKEN = randomUUID()

// ─────────────────────────────────────────────────────────────
// 端口发现
// ─────────────────────────────────────────────────────────────

let observedPort = null

/**
 * 从请求头里发现本 Host 实际监听的端口。
 *
 * @param {object} req  incoming request（Host 头带 authority）
 * @returns {number}    端口，或兜底值
 */
export function discoverPort(req) {
  if (observedPort !== null) return observedPort
  try {
    const host = req?.headers?.host
    if (typeof host === 'string' && host !== '') {
      const match = /:(\d+)$/.exec(host)
      if (match !== null) {
        const port = Number.parseInt(match[1], 10)
        if (Number.isInteger(port) && port > 0 && port < 65536) {
          observedPort = port
          return observedPort
        }
      }
    }
  } catch { /* 落到兜底 */ }
  return observedPort ?? FALLBACK_PORT
}

/** 显式设置端口（测试或已知端口时用）。 */
export function setPort(port) {
  if (Number.isInteger(port) && port > 0 && port < 65536) observedPort = port
}

// ─────────────────────────────────────────────────────────────
// 路径工具
// ─────────────────────────────────────────────────────────────

/**
 * 在目录下深度受限地搜索 node.exe。
 *
 * @param {string} dir
 * @param {number} depth
 * @returns {string|null}
 */
function findNodeBinary(dir, depth) {
  if (depth < 0) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === 'node.exe') {
      return join(dir, entry.name)
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = findNodeBinary(join(dir, entry.name), depth - 1)
    if (found !== null) return found
  }
  return null
}

/**
 * 按绝对路径定位 Windows 系统程序。
 *
 * ⚠️ 绝不能按裸名 spawn（见文件头「坑 ①」）。
 *
 * @param {string[]} parts  例如 ['System32', 'taskkill.exe']
 * @returns {string|null}
 */
export function systemBinary(parts) {
  const roots = [process.env.SystemRoot, process.env.windir, 'C:\\Windows']
  const seen = new Set()
  for (const root of roots) {
    if (typeof root !== 'string' || root === '' || seen.has(root)) continue
    seen.add(root)
    const candidate = join(root, ...parts)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch { /* 试下一个根 */ }
  }
  return null
}

/**
 * 找到 DSH 自带的 node.exe（助手要跑在它上面）。
 *
 * ⚠️ 不能用 process.execPath —— 那是 Electron 二进制，
 *    不加 ELECTRON_RUN_AS_NODE 会再开一个 DSH 实例。
 *
 * @returns {string|null}
 */
export function resolveNode() {
  const exeDir = dirname(process.execPath)
  const explicit = join(
    exeDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe',
  )
  try {
    if (statSync(explicit).isFile()) return explicit
  } catch { /* 走搜索 */ }
  return findNodeBinary(join(exeDir, 'resources', 'runtime'), 6)
}

/** 助手配置/日志放哪。 */
function helperDir() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'restart-helper')
  return join(tmpdir(), 'dsh-restart-helper')
}

// ─────────────────────────────────────────────────────────────
// 目标解析
// ─────────────────────────────────────────────────────────────

/**
 * 判断这台机器上能不能重启。
 *
 * @returns {{ok: true, appPid: number, exePath: string, appName: string, workingDir: string}
 *          | {ok: false, reason: string}}
 */
export function resolveTarget() {
  if (process.platform !== 'win32') {
    return { ok: false, reason: '自动重启目前只支持 Windows 桌面版 DSH。请手动关闭 DSH 再打开。' }
  }
  const appPid = process.ppid
  const exePath = process.execPath
  if (typeof appPid !== 'number' || appPid <= 1) {
    return { ok: false, reason: '读不到父进程 PID，无法确定要重启哪个进程。请手动关闭 DSH 再打开。' }
  }
  if (typeof exePath !== 'string' || exePath === '' || extname(exePath).toLowerCase() !== '.exe') {
    return { ok: false, reason: '当前进程不是由桌面应用启动的。请手动关闭 DSH 再打开。' }
  }
  if (process.connected !== true || typeof process.send !== 'function') {
    return {
      ok: false,
      reason: '当前不是桌面版 DSH（Host 与 Electron 之间没有 IPC 通道）。'
        + '如果这是命令行启动的 dsh web，请直接在终端里重启它。',
    }
  }
  return {
    ok: true,
    appPid,
    exePath,
    appName: basename(exePath),
    // 工作目录要沿用，不能瞎编：
    // Host 从 Electron 主进程继承 cwd，profile 的 sandbox workspaceRoot 由它推导。
    // 从别的地方启动会悄悄改变默认工作区。
    workingDir: process.cwd() === '' ? dirname(exePath) : process.cwd(),
  }
}

// ─────────────────────────────────────────────────────────────
// 启动助手
// ─────────────────────────────────────────────────────────────

/**
 * 写配置并通过 WMI 创建助手进程。
 *
 * @param {object} target     resolveTarget() 的返回值
 * @param {boolean} [dryRun]  只校验不真杀
 * @param {number} [graceMs]  杀之前等多久
 * @param {number|null} [port]
 * @returns {Promise<{helperPid: number|null, error?: string, dir?: string, logPath?: string, node?: string}>}
 */
export async function startHelper(target, dryRun = false, graceMs = undefined, port = null) {
  const node = resolveNode()
  if (node === null) {
    return { helperPid: null, error: '找不到 DSH 自带的 node.exe，无法启动重启助手' }
  }

  const dir = helperDir()
  try { mkdirSync(dir, { recursive: true }) } catch { /* 写盘失败下面会报 */ }

  // ⚠️ 只转发「定位 DSH 状态」用的变量。
  //    绝不转发所有 DSH_* —— 本进程带着 DSH_SESSION_ID / DSH_WEB_URL / DSH_SHELL，
  //    那些描述的是「即将被杀掉的会话」，重启后的新实例不该继承。
  const env = {}
  for (const key of ['DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR']) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }

  const configPath = join(dir, HELPER_CONFIG)
  try {
    writeFileSync(configPath, JSON.stringify({
      appPid: target.appPid,
      exePath: target.exePath,
      port: Number.isInteger(port) && port > 0 ? port : FALLBACK_PORT,
      workingDir: target.workingDir ?? null,
      env,
      dryRun,
      ...(graceMs === undefined ? {} : { graceMs }),
      requestedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
  } catch (e) {
    return { helperPid: null, error: '写重启助手配置失败：' + String(e?.message ?? e) }
  }

  // CreateProcess 直接解析这行 —— 没有 shell 介入，普通引号即可，
  // CJK 路径也安全（全程 UTF-16）。
  const commandLine = `"${node}" "${HELPER_SCRIPT}" "${configPath}"`

  // ⚠️ ProcessStartupInformation 不是可选项（见文件头「坑 ②」）
  const psCommand = 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create '
    + '-Arguments @{ '
    + `CommandLine = '${commandLine.replace(/'/g, "''")}'; `
    + 'ProcessStartupInformation = ([ciminstance]::new((Get-CimClass -ClassName Win32_ProcessStartup)) | '
    + 'ForEach-Object { $_.ShowWindow = 0; $_ }) '
    + '} | Select-Object -ExpandProperty ProcessId'

  const shell = systemBinary(['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'])
  if (shell === null) {
    return {
      helperPid: null,
      error: '找不到 powershell.exe（System32\\WindowsPowerShell\\v1.0），无法通过 WMI 创建重启助手',
      dir,
      logPath: join(dir, 'relaunch.log'),
      node,
    }
  }

  const created = await new Promise((resolve) => {
    let child
    try {
      child = spawn(shell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ pid: null, error: `${shell} 启动失败：${String(e?.code ?? e?.message ?? e)}` })
      return
    }
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    // 失败原因要原样带出，不能统一成「powershell 启动失败」——
    // error.code 能区分 ENOENT / EPERM，这是当初 PATH 问题查不出来的原因。
    child.on('error', (error) => {
      resolve({ pid: null, error: `${shell} 启动失败：${String(error.code ?? error.message)}` })
    })
    child.on('close', (code) => {
      const pid = Number.parseInt(out.trim(), 10)
      if (Number.isFinite(pid) && pid > 0) resolve({ pid })
      else {
        const detail = err.trim() || out.trim() || '(没有输出)'
        resolve({ pid: null, error: `WMI 没有返回进程号（powershell 退出码 ${String(code)}）：${detail}` })
      }
    })
  })

  return {
    helperPid: created.pid,
    error: created.error,
    dir,
    logPath: join(dir, 'relaunch.log'),
    node,
  }
}

// ─────────────────────────────────────────────────────────────
// 对外主入口
// ─────────────────────────────────────────────────────────────

/**
 * 请求重启 DSH。
 *
 * @param {object} [opts]
 * @param {object} [opts.req]      用于发现端口
 * @param {number} [opts.port]     显式端口
 * @param {boolean} [opts.dryRun]  只校验
 * @param {number} [opts.graceMs]
 * @returns {Promise<{ok: boolean, error?: string, helperPid?: number, detail?: object}>}
 */
export async function requestRestart(opts = {}) {
  const target = resolveTarget()
  if (!target.ok) {
    return { ok: false, error: target.reason, detail: { stage: 'resolve-target' } }
  }

  const port = Number.isInteger(opts.port) && opts.port > 0
    ? opts.port
    : discoverPort(opts.req)

  const started = await startHelper(target, Boolean(opts.dryRun), opts.graceMs, port)
  if (started.error) {
    return {
      ok: false,
      error: started.error,
      detail: {
        stage: 'start-helper',
        dir: started.dir,
        logPath: started.logPath,
        node: started.node,
      },
    }
  }

  return {
    ok: true,
    helperPid: started.helperPid,
    detail: {
      stage: 'started',
      target: target.appName,
      appPid: target.appPid,
      port,
      dir: started.dir,
      logPath: started.logPath,
      // 助手会在 ~1.2 秒后开始杀进程 —— 前端应在这之前把响应读完
      graceMs: typeof opts.graceMs === 'number' ? opts.graceMs : 1200,
    },
  }
}

/**
 * 不带副作用的能力探测（给 /restart-helper 端点用）。
 *
 * @returns {{available: boolean, reason?: string, target?: object}}
 */
export function probeRestartCapability() {
  const target = resolveTarget()
  if (!target.ok) return { available: false, reason: target.reason }
  const node = resolveNode()
  if (node === null) return { available: false, reason: '找不到 DSH 自带的 node.exe' }
  const shell = systemBinary(['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'])
  if (shell === null) return { available: false, reason: '找不到 powershell.exe（WMI 需要它）' }
  return {
    available: true,
    target: {
      appName: target.appName,
      appPid: target.appPid,
      node,
      shell,
      helper: HELPER_SCRIPT,
    },
  }
}
