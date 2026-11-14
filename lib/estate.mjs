/**
 * FK 回滚设置 —— Electron 运行时状态体检与重置（v1.5.2 新增）
 *
 * ⚠️ 为什么需要这个模块（2026-10-22 真实事故）：
 *
 *   事故现象：DSH 完全无法启动，弹「Web authentication failed」
 *   .bat 还原配置也没用，「禁用第三方插件」按钮也没用。
 *
 *   根因：认证状态库（Chromium 的 LevelDB / SQLite）被强杀进程写坏。
 *
 *     ① Electron 主进程启动 Host 子进程
 *     ② Host 用随机 token 生成 authenticatedUrl
 *     ③ Electron fetch 该 URL，期望 303 + Set-Cookie
 *     ④ cookie 的签名密钥来自 credentials 里的 browser-session 记录
 *     ⑤ 密钥或 cookie 库损坏 → 永远返回 401 → "Web authentication failed"
 *
 *   而这条链路和「DSH 配置文件」完全无关，所以：
 *     · 快照还原（只覆盖 5 个配置文件）救不了
 *     · 禁用插件（只清 patch + bundles）救不了
 *
 *   → 必须单独检查、单独重置。
 *
 * ─────────────────────────────────────────────────────────────
 * 设计原则
 * ─────────────────────────────────────────────────────────────
 *
 *   ① 只读检查，绝不动文件（check 阶段）
 *   ② 重置前必须备份（可撤销）
 *   ③ 明确告知会丢什么（浏览器会话凭据、UI 偏好 —— 不含账号）
 *
 * ⚠️ 本模块负责【体检 + 重置】，不负责【备份】。
 *    备份 Cookies 没有意义：它每次启动重新生成，且不含账号信息。
 *    详见 lib/core.mjs 里 ESTATE_CRITICAL_FILES 的注释。
 *   ④ 绝不自动重置（必须人工确认）
 *
 * @module dsh-fk-rollback/lib/estate
  *
 * @version 1.5.3
 * @module 模块二
 */

import {
  existsSync, readdirSync, statSync, copyFileSync, mkdirSync,
  unlinkSync as unlinkFile, rmdirSync as rmdirDir, rmSync,
  readFileSync, writeFileSync,
  renameSync as renameFs,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

// ─────────────────────────────────────────────────────────────
// Electron userData 目录定位
// ─────────────────────────────────────────────────────────────

/**
 * 找出 Electron 的 userData 根目录。
 *
 * Windows 上默认是：
 *   %APPDATA%\<appName>
 * 对 DSH 就是：
 *   C:\Users\<user>\AppData\Roaming\@deepseek-ai\dsh-desktop
 *
 * @param {object} [opts]
 * @param {string} [opts.appData]  显式指定（测试用）
 * @returns {{ok: boolean, dir?: string, candidates?: string[], reason?: string}}
 */
export function locateUserData(opts = {}) {
  if (opts.appData) {
    return existsSync(opts.appData)
      ? { ok: true, dir: opts.appData }
      : { ok: false, reason: `指定的目录不存在：${opts.appData}` }
  }

  const roaming = process.env.APPDATA
    || (process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Roaming') : null)

  if (!roaming) {
    return { ok: false, reason: '拿不到 %APPDATA%（不是 Windows，或环境变量缺失）' }
  }

  // 优先找 DSH 的（@deepseek-ai/dsh-desktop），再退到常见名
  const candidates = [
    join(roaming, '@deepseek-ai', 'dsh-desktop'),
    join(roaming, 'DeepSeek Harness'),
    join(roaming, 'dsh-desktop'),
  ]

  for (const c of candidates) {
    if (existsSync(c)) return { ok: true, dir: c }
  }

  return {
    ok: false,
    reason: '没找到 Electron 的 userData 目录',
    candidates,
  }
}

// ─────────────────────────────────────────────────────────────
// 需要检查 / 重置的条目
// ─────────────────────────────────────────────────────────────

/**
 * 认证与状态相关的关键路径。
 *
 * `critical: true` 的条目损坏会导致「认证失败 / 无法启动」；
 * 其余是「可能引起异常」的次要项。
 */
export const ESTATE_ITEMS = [
  // ── 认证核心 ──
  { rel: 'Network/Cookies', kind: 'file', critical: true,
    what: '认证 cookie 库（Chromium SQLite）',
    loss: '浏览器会话凭据（不含账号；账号在 .credentials.yaml）' },
  { rel: 'Network/Cookies-journal', kind: 'file', critical: true, sidecar: true,
    what: 'cookie 库的写前日志（异常残留会阻止写入）',
    loss: '不影响数据，但非 0 且程序已退出说明上次是强杀' },
  { rel: 'Network/Trust Tokens', kind: 'file', critical: false,
    what: 'Trust Token 库', loss: '几乎无影响' },
  { rel: 'Network/Trust Tokens-journal', kind: 'file', critical: false, sidecar: true,
    what: 'Trust Token 日志', loss: '几乎无影响' },

  // ── Chromium 通用状态库 ──
  { rel: 'shared_proto_db', kind: 'dir', critical: true,
    what: '共享 proto 数据库（LevelDB）',
    loss: '部分站点状态丢失，通常无感知' },
  { rel: 'Local Storage', kind: 'dir', critical: false,
    what: '网页 localStorage', loss: '界面偏好可能重置' },
  { rel: 'Session Storage', kind: 'dir', critical: false,
    what: '网页 sessionStorage', loss: '当前会话临时数据' },
  { rel: 'WebStorage', kind: 'dir', critical: false,
    what: 'WebStorage 汇总', loss: '次要' },

  // ── 可能阻止启动的锁/残留 ──
  { rel: 'lockfile', kind: 'file', critical: true,
    what: '单实例锁（残留会导致「另一个实例在运行」）',
    loss: '无（删除后自动重建）' },
  { rel: 'Preferences', kind: 'file', critical: false,
    what: 'Electron 偏好设置', loss: '窗口大小等偏好重置' },
]

// ─────────────────────────────────────────────────────────────
// 体检
// ─────────────────────────────────────────────────────────────

/**
 * 判断某个 LevelDB / SQLite 目录是否「看起来被写坏」。
 *
 * 判定依据（实测总结）：
 *   · 目录存在但所有文件都是 0 字节 → 被清空（写坏的特征）
 *   · 关键文件（CURRENT / MANIFEST-*）为 0 字节 → LevelDB 无法打开
 *
 * @param {string} dir
 * @returns {{suspicious: boolean, reason?: string, files: Array}}
 */
export function inspectLevelDbDir(dir) {
  const files = []
  let totalBytes = 0
  let zeroCount = 0
  let currentZero = false
  let manifestZero = false

  try {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (!st.isFile()) continue
      files.push({ name: n, size: st.size })
      totalBytes += st.size
      if (st.size === 0) zeroCount += 1
      if (n === 'CURRENT' && st.size === 0) currentZero = true
      if (n.startsWith('MANIFEST') && st.size === 0) manifestZero = true
    }
  } catch (e) {
    return { suspicious: true, reason: `目录读不了：${String(e?.message ?? e)}`, files }
  }

  if (files.length === 0) {
    return { suspicious: false, reason: '空目录（尚未使用）', files }
  }
  if (totalBytes === 0) {
    return {
      suspicious: true,
      reason: `目录里 ${files.length} 个文件全是 0 字节 —— 数据库被清空，通常是强杀进程导致的`,
      files,
    }
  }
  if (currentZero || manifestZero) {
    return {
      suspicious: true,
      reason: `关键文件为 0 字节（${currentZero ? 'CURRENT' : ''}${currentZero && manifestZero ? ' / ' : ''}${manifestZero ? 'MANIFEST' : ''}）—— LevelDB 打不开`,
      files,
    }
  }
  if (zeroCount > 0 && zeroCount === files.length - 1) {
    // 只有一个文件非 0，其余全 0 —— 也可疑但不一定坏
    return { suspicious: false, reason: '大部分文件为 0 字节（可能正常，视 LevelDB 版本）', files }
  }
  return { suspicious: false, files }
}

/**
 * 检查整个 Electron 状态目录。
 *
 * @param {object} [opts]
 * @param {string} [opts.appData]
 * @returns {{ok: boolean, dir?: string, problems: Array, notices: Array, items: Array}}
 */
export function checkEstate(opts = {}) {
  const loc = locateUserData(opts)
  if (!loc.ok) {
    return {
      ok: false,
      reason: loc.reason,
      candidates: loc.candidates,
      problems: [],
      notices: [],
      items: [],
    }
  }

  const root = loc.dir
  const problems = []
  const notices = []
  const items = []

  for (const item of ESTATE_ITEMS) {
    const p = join(root, item.rel.replace(/\//g, '\\'))
    if (!existsSync(p)) {
      items.push({ ...item, present: false })
      continue
    }

    let st
    try { st = statSync(p) } catch {
      items.push({ ...item, present: true, error: true })
      continue
    }
    const size = st.isDirectory() ? null : st.size
    const mtimeMs = st.mtimeMs

    const entry = { ...item, present: true, size, mtimeMs }

    if (item.kind === 'dir') {
      const insp = inspectLevelDbDir(p)
      entry.suspicious = insp.suspicious
      entry.inspectReason = insp.reason
      entry.fileCount = insp.files.length
      if (insp.suspicious && item.critical) {
        problems.push({
          code: 'estate-corrupt',
          severity: 'fatal',
          path: item.rel,
          message: `${item.what} 疑似损坏：${insp.reason}`,
          what: item.what,
          reason: insp.reason,
        })
      } else if (insp.suspicious) {
        notices.push({
          code: 'estate-suspicious',
          severity: 'info',
          path: item.rel,
          message: `${item.what} 可疑：${insp.reason}`,
          what: item.what,
          reason: insp.reason,
        })
      }
    } else {
      // 文件类
      if (item.sidecar) {
        // -journal / -wal：非 0 且程序没在跑 = 上次没正常关闭
        if (size !== null && size > 0) {
          notices.push({
            code: 'estate-journal-remnant',
            severity: 'info',
            path: item.rel,
            message: `${item.what} 有 ${size} 字节残留 —— 上次可能不是正常退出`,
            what: item.what,
            reason: `journal/wal 残留 ${size} B`,
          })
        }
      } else if (size === 0 && item.rel === 'lockfile') {
        // 0 字节 lockfile 是正常的（存在即代表锁）
        entry.suspicious = false
      } else if (size === 0 && item.critical) {
        entry.suspicious = true
        problems.push({
          code: 'estate-empty-file',
          severity: 'fatal',
          path: item.rel,
          message: `${item.what} 是 0 字节 —— 空文件通常意味着写入被中断`,
          what: item.what,
          reason: '0 字节',
        })
      }
    }

    items.push(entry)
  }

  return {
    ok: true,
    dir: root,
    problems,
    notices,
    items,
  }
}

/**
 * 判断当前是否有 DSH / Electron 进程在跑（重置前必须确认已关闭）。
 *
 * ⚠️ 用 tasklist 检测，但必须走绝对路径 —— 有的机器 PATH 里没有 System32
 *    （见 lib/restart.mjs 里记录的同一条教训）。
 *
 * @returns {{running: boolean|null, reason: string, count?: number}}
 */
/**
 * 进程检测的短期缓存。
 *
 * `tasklist` 是外部进程，实测每次约 270ms。而面板首屏、Cookie 估算、
 * 清理前置检查会在几秒内反复问同一个问题 —— 答案显然不会变。
 * 3 秒窗口足以覆盖一次面板加载，又不至于让「刚关掉 DSH」的结论过时。
 */
let _appRunCache = null
let _appRunCacheAt = 0
const APP_RUN_CACHE_MS = 3000

/**
 * 清掉进程检测缓存。
 *
 * ⚠️ 生产代码【不需要】调用它 —— 3 秒缓存自己会过期。
 *   存在的唯一目的是：测试脚本里连续判断「DSH 关了没」时，
 *   不必真的等 3 秒。见 verify 脚本。
 */
export function clearAppRunningCache() {
  _appRunCache = null
  _appRunCacheAt = 0
}

/**
 * 内核核心包清单 —— 与 check.mjs 的 DSH_CORE_SCOPED_PACKAGES 保持一致。
 *
 * 为什么重复定义而不 import：estate.mjs 不依赖 check.mjs（保持单向依赖）。
 */
export const CORE_SCOPED_PACKAGES = ['dsh-scope', 'dsh-system-prompt', 'dsh-llm']

/**
 * 隔离 profile 里的内核核心包副本（2026-11-04 事故的自动修复）。
 *
 * 背景：插件安装把官方核心包装进 profile 的 node_modules/@deepseek-ai/，
 *      与内核自带副本形成两套模块实例 → dsh-scope 的 === 判断失效 →
 *      所有 Agent 预设 broken → 会话无法创建/恢复。
 *
 *      这个问题【回滚快照救不了】—— 快照不含 node_modules。
 *      只能把这些目录移走。本函数就是干这件事。
 *
 * 做法：移动到 <DSH_HOME>/_backup-core-copy-<时间戳>/@deepseek-ai/
 *      移动不删除 —— 便于排查，也便于反悔。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} opts.profile
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.force]
 * @param {string} [opts.backupTo]
 */
export function quarantineCoreCopies(opts = {}) {
  const home = opts.home
  const profile = opts.profile
  const dryRun = Boolean(opts.dryRun)

  if (typeof home !== 'string' || home === '' || typeof profile !== 'string' || profile === '') {
    return { ok: false, dryRun, reason: 'missing home/profile', moved: [], failed: [], notFound: [] }
  }

  const scopedDir = join(home, 'profiles', profile, 'node_modules', '@deepseek-ai')

  // (1) process check
  if (!opts.force && !dryRun) {
    const run = isAppRunning()
    if (run.running) {
      return {
        ok: false, dryRun: false, moved: [], failed: [], notFound: [],
        reason: 'DSH is still running (' + run.reason + ') -- fully quit DSH first, '
          + 'or the files under node_modules may be locked and the move will fail',
      }
    }
  }

  // (2) find copies
  const present = []
  const notFound = []
  for (const name of CORE_SCOPED_PACKAGES) {
    const p = join(scopedDir, name)
    if (existsSync(p)) present.push({ name, path: p })
    else notFound.push(name)
  }

  if (present.length === 0) {
    return {
      ok: true, dryRun, moved: [], failed: [], notFound,
      reason: 'no core package copies found -- already clean',
    }
  }

  if (dryRun) {
    return {
      ok: true, dryRun: true,
      moved: present.map((x) => ({ name: x.name, wouldMove: true })),
      failed: [], notFound,
      reason: 'would quarantine ' + present.length + ' core package copies',
    }
  }

  // (3) backup dir
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 15)
  const backupRoot = opts.backupTo || join(home, '_backup-core-copy-' + stamp)
  const destScoped = join(backupRoot, '@deepseek-ai')

  try {
    mkdirSync(destScoped, { recursive: true })
  } catch (e) {
    return {
      ok: false, dryRun: false, moved: [], failed: [], notFound,
      reason: 'cannot create backup dir: ' + String(e?.message ?? e),
    }
  }

  // (4) move one by one
  const moved = []
  const failed = []
  for (const item of present) {
    const dest = join(destScoped, item.name)
    try {
      if (existsSync(dest)) {
        try { rmSync(dest, { recursive: true, force: true }) } catch { /* ignore */ }
      }
      renameFs(item.path, dest)
      moved.push({ name: item.name, from: item.path, to: dest })
    } catch (e) {
      failed.push({ name: item.name, reason: String(e?.message ?? e) })
    }
  }

  // (5) remove the empty @deepseek-ai shell
  let emptyDirMoved = false
  try {
    if (existsSync(scopedDir) && readdirSync(scopedDir).length === 0) {
      renameFs(scopedDir, join(backupRoot, '@deepseek-ai-empty'))
      emptyDirMoved = true
    }
  } catch { /* ignore */ }

  return {
    ok: failed.length === 0,
    dryRun: false,
    backupRoot,
    moved,
    failed,
    notFound,
    emptyDirMoved,
  }
}

// ─────────────────────────────────────────────────────────────
// 用户级代理环境变量（2026-11-14 事故的修复能力）
// ─────────────────────────────────────────────────────────────

/** 会被 DSH / Node 当作 HTTP 代理的变量名（大小写都查）。 */
export const PROXY_ENV_NAMES = [
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy',
]

/** 代理变量备份文件名。 */
export const PROXY_BACKUP_FILE = 'proxy-env-backup.json'

/** 跑一段 PowerShell，返回 stdout。失败抛错。 */
function runPowerShell(script, timeoutMs = 20000) {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const ps = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * 读当前用户级（User scope）的代理环境变量。
 *
 * ⚠️ 为什么读 User scope 而不是 process.env：
 *    process.env 是 DSH 启动时继承的快照。用户改完变量后
 *    DSH 进程里还是旧值 —— 判断「注册表里有什么」必须直接读注册表。
 *
 * @returns {{ ok: boolean, values: Record<string,string>, error?: string }}
 */
export function getUserProxyEnv() {
  const values = {}
  try {
    // 一次 PowerShell 读全部，比逐个快
    const names = PROXY_ENV_NAMES.map((k) => `'${k}'`).join(',')
    const script = `@(${names}) | ForEach-Object { `
      + `"$_=" + [Environment]::GetEnvironmentVariable($_, 'User') }`
    const out = runPowerShell(script)
    for (const line of String(out ?? '').split(/\r?\n/)) {
      const s = line.trim()
      if (s === '') continue
      const i = s.indexOf('=')
      if (i <= 0) continue
      const key = s.slice(0, i)
      const val = s.slice(i + 1)
      if (val !== '') values[key] = val
    }
    return { ok: true, values }
  } catch (e) {
    return { ok: false, values, error: String(e?.message ?? e) }
  }
}

/**
 * 删掉指定的用户级代理环境变量（设为 null）。
 *
 * ⚠️ 安全设计：
 *    · 只删调用方明确指定的键 —— 不做「全删」这种危险默认
 *    · 删之前先备份原值到 proxy-env-backup.json
 *    · 可以 dryRun 预演
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string[]} opts.keys     要删的变量名
 * @param {boolean} [opts.dryRun]
 * @returns {{ ok:boolean, dryRun:boolean, removed:object[], failed:object[], backupPath?:string }}
 */
export function clearUserProxyEnv(opts = {}) {
  const home = opts.home
  const keys = Array.isArray(opts.keys) ? opts.keys.filter((k) => typeof k === 'string' && k !== '') : []
  const dryRun = Boolean(opts.dryRun)

  if (keys.length === 0) {
    return { ok: false, dryRun, removed: [], failed: [], reason: '没有指定要删的变量名' }
  }

  // ① 先读现状
  const before = getUserProxyEnv()
  if (!before.ok) {
    return { ok: false, dryRun, removed: [], failed: [], reason: '读取用户级环境变量失败：' + (before.error ?? '') }
  }

  const present = keys.filter((k) => Object.prototype.hasOwnProperty.call(before.values, k))
  if (present.length === 0) {
    return { ok: true, dryRun, removed: [], failed: [], reason: '这些变量本来就不存在（已经是干净的）' }
  }

  if (dryRun) {
    return {
      ok: true, dryRun: true,
      removed: present.map((k) => ({ key: k, value: before.values[k], wouldRemove: true })),
      failed: [],
    }
  }

  // ② 备份原值
  let backupPath = null
  try {
    const root = typeof home === 'string' && home !== '' ? home : os_homedir()
    mkdirSync(root, { recursive: true })
    backupPath = join(root, PROXY_BACKUP_FILE)
    const bak = {
      at: new Date().toISOString(),
      note: '2026-11-14 事故修复前备份：这些用户级代理变量指向失效代理，'
        + '导致 DSH 0.2.2 所有 provider 报 "DeepSeek Messages transport failed"。',
      values: {},
    }
    for (const k of present) bak.values[k] = before.values[k]
    writeFileSync(backupPath, JSON.stringify(bak, null, 2) + '\n', 'utf8')
  } catch (e) {
    return {
      ok: false, dryRun: false, removed: [], failed: [],
      reason: '写备份失败（为安全起见不继续删除）：' + String(e?.message ?? e),
    }
  }

  // ③ 逐个删除
  const removed = []
  const failed = []
  for (const k of present) {
    try {
      runPowerShell(`[Environment]::SetEnvironmentVariable('${k}', $null, 'User')`)
      removed.push({ key: k, value: before.values[k] })
    } catch (e) {
      failed.push({ key: k, reason: String(e?.message ?? e) })
    }
  }

  // ④ 复查
  const after = getUserProxyEnv()
  const stillThere = after.ok
    ? removed.map((r) => r.key).filter((k) => Object.prototype.hasOwnProperty.call(after.values, k))
    : []

  return {
    ok: failed.length === 0 && stillThere.length === 0,
    dryRun: false,
    backupPath,
    removed,
    failed,
    stillThere,
  }
}

/**
 * 从备份恢复代理环境变量。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @returns {{ ok:boolean, restored:object[], failed:object[], reason?:string }}
 */
export function restoreUserProxyEnv(opts = {}) {
  const home = opts.home
  if (typeof home !== 'string' || home === '') {
    return { ok: false, restored: [], failed: [], reason: '缺少 home' }
  }
  const backupPath = join(home, PROXY_BACKUP_FILE)
  if (!existsSync(backupPath)) {
    return { ok: false, restored: [], failed: [], reason: '没有找到备份文件：' + backupPath }
  }
  let bak
  try {
    bak = JSON.parse(readFileSync(backupPath, 'utf8'))
  } catch (e) {
    return { ok: false, restored: [], failed: [], reason: '备份文件损坏：' + String(e?.message ?? e) }
  }
  const values = bak?.values ?? {}
  const restored = []
  const failed = []
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== 'string' || v === '') continue
    try {
      runPowerShell(`[Environment]::SetEnvironmentVariable('${k}', '${String(v).replace(/'/g, "''")}', 'User')`)
      restored.push({ key: k, value: v })
    } catch (e) {
      failed.push({ key: k, reason: String(e?.message ?? e) })
    }
  }
  return { ok: failed.length === 0, restored, failed, backupPath }
}

/** os.homedir 的薄封装（避免再多一个顶层 import）。 */
function os_homedir() {
  try {
    return process.env.USERPROFILE || process.env.HOME || process.cwd()
  } catch { return process.cwd() }
}

export function isAppRunning() {
  if (process.platform !== 'win32') {
    return { running: null, reason: '非 Windows，跳过进程检测' }
  }

  // 命中缓存直接返回（省掉 270ms 的进程启动开销）
  const now = Date.now()
  if (_appRunCache !== null && (now - _appRunCacheAt) < APP_RUN_CACHE_MS) {
    return _appRunCache
  }

  // 定位 tasklist.exe（绝对路径）
  const roots = [process.env.SystemRoot, process.env.windir, 'C:\\Windows'].filter(Boolean)
  let tasklist = null
  for (const r of roots) {
    const c = join(r, 'System32', 'tasklist.exe')
    try { if (statSync(c).isFile()) { tasklist = c; break } } catch { /* 下一个 */ }
  }
  if (!tasklist) {
    return { running: null, reason: '找不到 tasklist.exe，无法检测' }
  }

  const remember = (r) => {
    _appRunCache = r
    _appRunCacheAt = Date.now()
    return r
  }

  try {
    const out = execFileSync(tasklist, ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    const hit = /DeepSeek Harness\.exe/i.test(out)
    const count = (out.match(/DeepSeek Harness\.exe/gi) || []).length
    return remember({ running: hit, count, reason: hit ? `检测到 ${count} 个 DSH 进程在运行` : '没有 DSH 进程' })
  } catch (e) {
    // tasklist 在没有匹配时返回非 0，也算「没在跑」
    return remember({ running: false, reason: `进程检测完成（${String(e?.status ?? 'ok')}）` })
  }
}

// ─────────────────────────────────────────────────────────────
// 重置（带备份）
// ─────────────────────────────────────────────────────────────

/**
 * 备份某个条目到指定目录。
 *
 * @param {string} root     userData 根
 * @param {string} rel      相对路径
 * @param {string} backupDir 备份目录
 * @returns {{ok: boolean, dest?: string, bytes?: number, reason?: string}}
 */
function backupOne(root, rel, backupDir) {
  const src = join(root, rel.replace(/\//g, '\\'))
  if (!existsSync(src)) return { ok: true, dest: null, bytes: 0 }

  const destName = rel.replace(/\//g, '__')
  const dest = join(backupDir, destName)
  try {
    mkdirSync(backupDir, { recursive: true })
    let st
    try { st = statSync(src) } catch { return { ok: false, reason: '源读不到' } }

    if (st.isDirectory()) {
      cpRecursive(src, dest)
      return { ok: true, dest, bytes: dirSize(dest) }
    }
    copyFileSync(src, dest)
    return { ok: true, dest, bytes: statSync(dest).size }
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) }
  }
}

/** 递归复制（不引 fs.cpSync，兼容老 Node）。 */
function cpRecursive(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const n of readdirSync(src)) {
    const s = join(src, n)
    const d = join(dest, n)
    let st
    try { st = statSync(s) } catch { continue }
    if (st.isDirectory()) cpRecursive(s, d)
    else { try { copyFileSync(s, d) } catch { /* 跳过锁定的文件 */ } }
  }
}

/** 目录总大小。 */
function dirSize(dir) {
  let t = 0
  try {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) t += dirSize(p)
      else t += st.size
    }
  } catch { /* 忽略 */ }
  return t
}


// ─────────────────────────────────────────────────────────────
// 重置入口
// ─────────────────────────────────────────────────────────────

/**
 * 重置 Electron 状态（带备份）。
 *
 * ⚠️ 调用前必须确认 DSH 已完全退出 —— 文件被占用时删除会失败。
 *
 * @param {object} opts
 * @param {string} [opts.appData]     userData 根（默认自动定位）
 * @param {string[]} [opts.only]      只重置这些 rel（默认：全部 critical）
 * @param {boolean} [opts.dryRun]     只报告不删除
 * @param {boolean} [opts.force]      跳过「DSH 正在运行」的检查
 * @param {string} [opts.backupTo]    备份目录（默认 userData 同级 rollback-estate-backup-<时间>）
 * @returns {{ok: boolean, dryRun: boolean, backupDir?: string, removed: Array, failed: Array, skipped: Array, reason?: string}}
 */
export function resetEstate(opts = {}) {
  const loc = locateUserData(opts)
  if (!loc.ok) {
    return { ok: false, dryRun: Boolean(opts.dryRun), removed: [], failed: [], skipped: [], reason: loc.reason }
  }
  const root = loc.dir

  // ① 进程检查（除非 force）
  if (!opts.force && !opts.dryRun) {
    const run = isAppRunning()
    if (run.running) {
      return {
        ok: false, dryRun: false, removed: [], failed: [], skipped: [],
        reason: `DSH 还在运行（${run.reason}）—— 必须先完全退出，否则文件被占用删不掉`,
      }
    }
  }

  // ② 选出要处理的条目
  const wanted = Array.isArray(opts.only) && opts.only.length > 0
    ? ESTATE_ITEMS.filter((i) => opts.only.includes(i.rel))
    : ESTATE_ITEMS.filter((i) => i.critical)

  // ③ 备份目录
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 15)
  const backupDir = opts.backupTo || join(root, '..', `rollback-estate-backup-${stamp}`)

  const removed = []
  const failed = []
  const skipped = []

  for (const item of wanted) {
    const src = join(root, item.rel.replace(/\//g, '\\'))
    if (!existsSync(src)) {
      skipped.push({ path: item.rel, reason: '不存在' })
      continue
    }

    if (opts.dryRun) {
      removed.push({ path: item.rel, bytes: null, wouldDelete: true, what: item.what })
      continue
    }

    // 备份
    const bk = backupOne(root, item.rel, backupDir)
    if (!bk.ok) {
      failed.push({ path: item.rel, reason: '备份失败：' + bk.reason })
      continue
    }

    // 删除
    try {
      if (statSync(src).isDirectory()) rmRecursive(src)
      else unlinkFile(src)
      removed.push({ path: item.rel, bytes: bk.bytes, backup: bk.dest, what: item.what })
    } catch (e) {
      failed.push({ path: item.rel, reason: String(e?.message ?? e) })
    }
  }

  return {
    ok: failed.length === 0,
    dryRun: Boolean(opts.dryRun),
    backupDir,
    removed,
    failed,
    skipped,
  }
}

/** 递归删除（自己实现，避免依赖 fs.rmSync 的版本差异）。 */
function rmRecursive(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) rmRecursive(p)
    else { try { unlinkFile(p) } catch { /* 跳过被锁文件 */ } }
  }
  try { rmdirDir(dir) } catch { /* 目录非空则留着 */ }
}


// ─────────────────────────────────────────────────────────────
// 认证 Cookie 累积检测（v1.5.2 新增）
// ─────────────────────────────────────────────────────────────
//
// ⚠️ 为什么需要这块（2026-10-26 事故）：
//
//   DSH 每次启动都会：
//     ① Host 监听一个【动态端口】（如 63360）
//     ② 用 sha256("127.0.0.1:63360") 生成 cookie 名 → "dsh-auth-XXXX"
//     ③ Chromium 把 cookie 存进 Network/Cookies（host_key = 127.0.0.1）
//     ④ 下次启动端口变成 64245 → 名字不同 → 又存一个
//     ⑤ 旧 cookie 【永不清理】
//
//   累积到 71 个时：
//     请求头 Cookie: dsh-auth-A=...; dsh-auth-B=... ...（71 个）
//     = 16,584 字节 > Node.js maxHeaderSize 16,384
//     → 服务端 HPE_HEADER_OVERFLOW → 断连 → ECONNRESET
//     → net.fetch 失败 → "desktop welcome: Web authentication failed"
//
//   实测（Node 24.21.0）：
//     70 个 = 16,356 B  → 200 OK
//     71 个 = 16,584 B  → 崩溃
//
// ⚠️ 检查窗口限制：
//
//   DSH 运行时 Cookies 被 Chromium 独占锁定，
//   shutil 式复制、sqlite 只读打开、Win32 共享读 全部失败。
//   只有在 DSH 【完全退出】后才能读。
//
//   但这不是问题 —— 因为：
//     · DSH 能正常启动时 → 用户不需要这个检查（有 GUI 可用）
//     · DSH 起不来时     → 正是未运行状态 → 可读 → 可检查
//   唯一有意义的检测窗口正好可用。

/** Node.js 默认 maxHeaderSize（字节）。 */
export const HEADER_LIMIT = 16384

/**
 * 其他请求头预留字节数。
 *
 * Host / User-Agent / Accept / Accept-Encoding / Accept-Language
 * 实测合计约 400 字节（Electron net.fetch 的真实组合）。
 */
export const HEADER_RESERVE = 400

/** 留给 Cookie 头的可用字节。 */
export const COOKIE_BUDGET = HEADER_LIMIT - HEADER_RESERVE   // 15984

/**
 * 分级阈值（占预算的百分比）。
 *
 * 依据实测：70 个刚好通过、71 个崩溃。
 * 换算成字节：70×228 ≈ 15,960 B。
 */
export const COOKIE_LEVELS = {
  /** ≥ 100%：已经会崩，或下一次必崩 */
  fatal: 1.0,
  /** ≥ 95%：约 66 个，10 次启动内必崩 */
  error: 0.95,
  /** ≥ 85%：约 59 个，建议清理 */
  warn: 0.85,
}

/** 认证 cookie 名前缀（来自 dsh-client-connection 的 COOKIE_PREFIX）。 */
const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** Cookie 基线文件名（放在快照根下，供面板估算用）。 */
export const COOKIE_BASELINE_FILE = 'cookie-baseline.json'

/**
 * 惰性加载 node:sqlite。
 *
 * Node 22.5+ 提供实验性内置 SQLite；Node 24 已稳定可用。
 * 用动态 import 而不是顶层 import —— 老 Node 上本模块仍可工作（只是没有 cookie 检查）。
 *
 * @returns {Promise<object|null>} null 表示当前 Node 不支持
 */
async function loadSqlite() {
  try {
    const m = await import('node:sqlite')
    return m && typeof m.DatabaseSync === 'function' ? m : null
  } catch {
    return null
  }
}

/**
 * 检查认证 Cookie 累积情况。
 *
 * @param {object} [opts]
 * @param {string} [opts.appData]  显式指定 Electron userData（测试用）
 * @param {boolean} [opts.force]   即使 DSH 在运行也尝试读（会失败，仅调试用）
 * @returns {Promise<object>}
 *   {
 *     ok: boolean,
 *     reason?: string,          // ok=false 时说明原因
 *     readable: boolean,        // 是否成功读到库
 *     running: boolean|null,    // DSH 是否在运行
 *     cookies?: {
 *       total: number,          // 库内 cookie 总数
 *       auth: number,           // dsh-auth-* 数量
 *       headerBytes: number,    // 这些 cookie 在请求头里占的字节
 *       budget: number,         // 可用预算
 *       ratio: number,          // headerBytes / budget
 *       level: 'normal'|'warn'|'error'|'fatal',
 *       ports: number[],        // 涉及的端口（去重）
 *       oldest?: number,        // 最早签发时间（ms）
 *       newest?: number,        // 最晚签发时间（ms）
 *     }
 *   }
 */
export async function checkAuthCookies(opts = {}) {
  const loc = locateUserData(opts)
  if (!loc.ok) {
    return { ok: false, reason: loc.reason, readable: false, running: null }
  }

  const cookiesPath = join(loc.dir, 'Network', 'Cookies')
  if (!existsSync(cookiesPath)) {
    return {
      ok: true, readable: false, running: null,
      reason: '没有 Cookies 库（DSH 可能还没启动过）',
    }
  }

  const run = isAppRunning()
  const running = run.running === true

  // ── 快路径（2026-10-27 性能修复）──
  //
  // DSH 在运行时，Chromium 独占锁定 Cookies 库，尝试打开【必然失败】。
  // 而那次失败的尝试实测要 1400ms —— 凭空让面板首屏卡 1.4 秒。
  //
  // 既然结论已知（读不到），就别去试。
  // 1715ms → 约 270ms（现在还有 isAppRunning 缓存，实测 ~0ms）。
  // 指定了 appData 时不用快路径：调用方明确要求读某个目录
  // （测试、多 userData、或排障），就该尊重它，而不是拿「本机 DSH 在跑」挡回去。
  if (running && opts.force !== true && opts.appData === undefined) {
    return {
      ok: true, readable: false, running: true,
      reason: 'DSH 正在运行，Cookies 库被 Chromium 独占锁定 —— 请完全退出 DSH 后重跑',
    }
  }

  const sqlite = await loadSqlite()
  if (sqlite === null) {
    return {
      ok: true, readable: false, running,
      reason: `当前 Node 不支持 node:sqlite（需要 22.5+），无法检查 Cookie 内容`,
    }
  }

  // ── 尝试读取 ──
  // ⚠️ 不要复制到临时文件：DSH 运行时 copyFileSync 会 EBUSY。
  //    直接只读打开，成功说明没被锁。
  let db = null
  try {
    db = new sqlite.DatabaseSync(cookiesPath, { readOnly: true })
  } catch (e) {
    const locked = running || /busy|locked|unable to open/i.test(String(e?.message ?? e))
    return {
      ok: true, readable: false, running,
      reason: locked
        ? 'DSH 正在运行，Cookies 库被 Chromium 独占锁定 —— 请完全退出 DSH 后重跑'
        : `Cookies 库打不开：${String(e?.message ?? e).slice(0, 120)}`,
    }
  }

  const result = {
    ok: true, readable: true, running,
  }

  try {
    // 表可能不存在（不是 Chromium 的 cookie 库结构）
    let total = 0
    try {
      const r = db.prepare('SELECT COUNT(*) AS n FROM cookies').get()
      total = Number(r?.n ?? 0)
    } catch (e) {
      result.cookies = null
      result.reason = 'Cookies 库结构异常（找不到 cookies 表）'
      return result
    }

    // 只统计认证 cookie
    const rows = db.prepare(
      'SELECT name, value FROM cookies WHERE name LIKE ?'
    ).all(`${AUTH_COOKIE_PREFIX}%`)

    let headerBytes = 0
    const ports = new Set()
    let oldest = null
    let newest = null

    for (const row of rows) {
      const name = String(row.name ?? '')
      const value = String(row.value ?? '')
      // 请求头里的实际占用：name + '=' + value + '; '
      headerBytes += name.length + 1 + value.length + 2

      // 从 value 里解析 authority（payload 是 v1.<base64url(JSON)>.<sig>）
      try {
        const parts = value.split('.')
        if (parts.length >= 2) {
          const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
          const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
          if (typeof json.authority === 'string') {
            const m = json.authority.match(/:(\d+)$/)
            if (m) ports.add(Number(m[1]))
          }
          if (typeof json.issuedAt === 'number') {
            if (oldest === null || json.issuedAt < oldest) oldest = json.issuedAt
            if (newest === null || json.issuedAt > newest) newest = json.issuedAt
          }
        }
      } catch { /* payload 解析失败不影响字节统计 */ }
    }

    const ratio = headerBytes / COOKIE_BUDGET
    let level = 'normal'
    if (ratio >= COOKIE_LEVELS.fatal) level = 'fatal'
    else if (ratio >= COOKIE_LEVELS.error) level = 'error'
    else if (ratio >= COOKIE_LEVELS.warn) level = 'warn'

    result.cookies = {
      total,
      auth: rows.length,
      headerBytes,
      budget: COOKIE_BUDGET,
      ratio,
      level,
      ports: [...ports].sort((a, b) => a - b),
      oldest: oldest ?? undefined,
      newest: newest ?? undefined,
    }
    return result
  } finally {
    try { db.close() } catch { /* 忽略 */ }
  }
}

/**
 * 清理累积的认证 Cookie（带备份）。
 *
 * ⚠️ 硬性前提：DSH 必须完全退出。
 *    Chromium 独占锁定 Cookies 时写不进去。
 *
 * @param {object} opts
 * @param {string} [opts.appData]
 * @param {string} [opts.backupDir]  备份目录（默认：系统临时目录下 dsh-cookie-backup-<时间戳>）
 * @param {boolean} [opts.dryRun]    只报告不修改
 * @param {boolean} [opts.force]     跳过 DSH 运行检查（会失败，仅用于确认错误信息）
 * @returns {Promise<object>}
 */
export async function cleanAuthCookies(opts = {}) {
  const loc = locateUserData(opts)
  if (!loc.ok) {
    return { ok: false, reason: loc.reason, removed: 0 }
  }

  const cookiesPath = join(loc.dir, 'Network', 'Cookies')
  if (!existsSync(cookiesPath)) {
    return { ok: true, removed: 0, reason: '没有 Cookies 库，无需清理' }
  }

  // ① 进程检查
  if (!opts.force && !opts.dryRun) {
    const run = isAppRunning()
    if (run.running) {
      return {
        ok: false, removed: 0,
        reason: `DSH 还在运行（${run.reason}）—— 必须先完全退出，`
          + '否则 Cookies 被 Chromium 独占，删不掉',
      }
    }
  }

  const sqlite = await loadSqlite()
  if (sqlite === null) {
    return {
      ok: false, removed: 0,
      reason: '当前 Node 不支持 node:sqlite（需要 22.5+），无法清理',
    }
  }

  // ② 先读出要删多少（dry-run 也要有数字）
  let before = 0
  let totalBefore = 0
  try {
    const ro = new sqlite.DatabaseSync(cookiesPath, { readOnly: true })
    try {
      totalBefore = Number(ro.prepare('SELECT COUNT(*) AS n FROM cookies').get()?.n ?? 0)
      before = Number(ro.prepare(
        "SELECT COUNT(*) AS n FROM cookies WHERE host_key IN ('127.0.0.1','localhost') AND name LIKE ?"
      ).get(`${AUTH_COOKIE_PREFIX}%`)?.n ?? 0)
    } finally {
      try { ro.close() } catch { /* 忽略 */ }
    }
  } catch (e) {
    // 读不到时要把「是不是 DSH 在跑」说清楚 —— 否则用户只看到
    // "unable to open database file"，根本不知道该怎么办。
    const stillRunning = isAppRunning().running === true
    return {
      ok: false, removed: 0,
      reason: stillRunning
        ? 'DSH 正在运行，Cookies 库被 Chromium 独占锁定 —— 请完全退出 DSH 后重试'
        : `Cookies 库读不了：${String(e?.message ?? e).slice(0, 140)}`,
    }
  }

  if (before === 0) {
    return {
      ok: true, removed: 0, totalBefore,
      reason: '没有累积的 dsh-auth-* cookie，无需清理',
    }
  }

  if (opts.dryRun) {
    return {
      ok: true, dryRun: true, wouldRemove: before, totalBefore,
      reason: `将删除 ${before} 个 dsh-auth-* cookie（库内共 ${totalBefore} 个）`,
    }
  }

  // ③ 备份
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 15)
  const backupDir = opts.backupDir
    || join(process.env.TEMP || process.env.TMP || loc.dir, `dsh-cookie-backup-${stamp}`)
  let backupPath = null
  try {
    mkdirSync(backupDir, { recursive: true })
    backupPath = join(backupDir, 'Cookies')
    copyFileSync(cookiesPath, backupPath)
  } catch (e) {
    return {
      ok: false, removed: 0,
      reason: `备份失败，已中止（不删无备份的数据）：${String(e?.message ?? e).slice(0, 120)}`,
    }
  }

  // ③b 记录 journal 当前状态（供最终报告用）
  const journalPathEarly = join(loc.dir, 'Network', 'Cookies-journal')
  const journalExistedBefore = existsSync(journalPathEarly)

  // ④ 删除
  let removed = 0
  try {
    const rw = new sqlite.DatabaseSync(cookiesPath)
    try {
      // ⚠️ 只删认证 cookie：
      //    · host 限定本机（不碰其他站点）
      //    · name 限定 dsh-auth-（不碰同域其他 cookie）
      const stmt = rw.prepare(
        "DELETE FROM cookies WHERE host_key IN ('127.0.0.1','localhost') AND name LIKE ?"
      )
      stmt.run(`${AUTH_COOKIE_PREFIX}%`)
      removed = before
    } finally {
      try { rw.close() } catch { /* 忽略 */ }
    }
  } catch (e) {
    return {
      ok: false, removed: 0, backupPath,
      reason: `删除失败：${String(e?.message ?? e).slice(0, 140)}`
        + '（备份已保留，可用它恢复）',
    }
  }

  // ⑤ 清 journal（0 字节残留会让 Chromium 认为事务未完成）
  //
  // ⚠️ 注意时序：SQLite 自己关闭连接时就会删掉空的 -journal，
  //    所以「我们没删」不代表有问题。分两个字段报告，避免误读。
  const journalPath = join(loc.dir, 'Network', 'Cookies-journal')
  let journalRemoved = false
  if (existsSync(journalPath)) {
    try {
      const st = statSync(journalPath)
      // 只删空的 journal；非 0 字节说明有未提交事务，留给 Chromium 自己处理
      if (st.size === 0) {
        rmSync(journalPath, { force: true })
        journalRemoved = true
      }
    } catch { /* 忽略 */ }
  }

  // ⑥ 复核
  let after = null
  try {
    const chk = new sqlite.DatabaseSync(cookiesPath, { readOnly: true })
    try {
      after = Number(chk.prepare(
        "SELECT COUNT(*) AS n FROM cookies WHERE name LIKE ?"
      ).get(`${AUTH_COOKIE_PREFIX}%`)?.n ?? 0)
    } finally {
      try { chk.close() } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }

  return {
    ok: true,
    removed,
    totalBefore,
    after,
    backupPath,
    backupDir,
    journalExistedBefore,
    journalRemoved,
  }
}

/**
 * 读取「Cookie 基线」。
 *
 * 为什么需要它：
 *   DSH 运行时 Cookies 读不到内容，但面板要能给出一个数量概念。
 *   唯一可靠的推算方式是「上次清理后的数量 + 之后启动了几次」。
 *
 *   实测（2026-10-26）：某个时间段内 boot-log 有 74 条记录，
 *   对应 71 个 cookie（偏差 +3，约 4%）—— 说明「每次启动 ≈ 1 个」成立。
 *
 * @param {string} root 快照根目录
 * @returns {object|null}
 */
export function readCookieBaseline(root) {
  const p = join(root, COOKIE_BASELINE_FILE)
  if (!existsSync(p)) return null
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'))
    return (typeof d?.cookieCount === 'number' && typeof d?.bootLogCount === 'number')
      ? d : null
  } catch {
    return null
  }
}

/**
 * 写入 Cookie 基线（清理成功后调用）。
 *
 * @param {string} root 快照根目录
 * @param {object} opts
 * @param {number} opts.cookieCount    清理后的实际数量（通常是 0）
 * @param {number} opts.bootLogCount   当时的 boot-log 总条数
 */
export function writeCookieBaseline(root, { cookieCount, bootLogCount }) {
  const p = join(root, COOKIE_BASELINE_FILE)
  const data = {
    at: new Date().toISOString(),
    cookieCount,
    bootLogCount,
    note: 'cleanAuthCookies 清理后写入，供面板估算累积情况',
  }
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8')
    return data
  } catch {
    return null
  }
}

/**
 * 估算当前认证 Cookie 数量（在内容读不到时使用）。
 *
 * 公式：基线数量 + (当前 boot 数 - 基线时的 boot 数)
 *
 * @param {string} root     快照根
 * @param {number} totalBoots 当前 boot-log 总条数
 * @returns {object|null} null 表示没有基线、无法估算
 */
export function estimateAuthCookies(root, totalBoots) {
  const base = readCookieBaseline(root)
  if (base === null) return null
  const delta = Math.max(0, Number(totalBoots) - base.bootLogCount)
  return {
    count: base.cookieCount + delta,
    bootsSince: delta,
    baselineAt: base.at,
    baselineCount: base.cookieCount,
    exact: false,
  }
}
