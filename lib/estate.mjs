/**
 * FK 回滚设置 —— Electron 运行时状态体检与重置（v1.6.1 新增）
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
 * @version 1.5.1
 * @module 模块二
 */

import {
  existsSync, readdirSync, statSync, copyFileSync, mkdirSync,
  unlinkSync as unlinkFile, rmdirSync as rmdirDir,
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

/**
 * 已知安全、无需检查的大目录（避免体检时扫太多文件）。
 */
export const IGNORED_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUPersistentCache',
  'Partitions', 'blob_storage', 'logs', 'desktop',
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
export function isAppRunning() {
  if (process.platform !== 'win32') {
    return { running: null, reason: '非 Windows，跳过进程检测' }
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

  try {
    const out = execFileSync(tasklist, ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    const hit = /DeepSeek Harness\.exe/i.test(out)
    const count = (out.match(/DeepSeek Harness\.exe/gi) || []).length
    return { running: hit, count, reason: hit ? `检测到 ${count} 个 DSH 进程在运行` : '没有 DSH 进程' }
  } catch (e) {
    // tasklist 在没有匹配时返回非 0，也算「没在跑」
    return { running: false, reason: `进程检测完成（${String(e?.status ?? 'ok')}）` }
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
