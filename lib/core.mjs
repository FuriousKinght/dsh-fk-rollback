/**
 * FK 回滚设置 —— 共享核心库
 *
 * 本文件同时被两半使用：
 *   · dsh-rollback.mjs（命令行脚本，DSH 崩了也能跑）
 *   · entry.js（插件 Host 半边）
 *
 * 零第三方依赖：只用 node:fs / node:path / node:crypto / node:zlib。
 * 这样脚本可以独立运行，不受 node_modules 状态影响。
 *
 * @module dsh-fk-rollback/lib/core
  *
 * @version 1.6.0
 * @module 模块四 + 模块五
 */

import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync,
  renameSync, statSync, lstatSync, writeFileSync, copyFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path'

// 2026-10-29 audit: locateUserData used to be duplicated here with a
// near-identical copy in estate.mjs (only one error string differed).
// estate.mjs never imports this file, so reusing it introduces no cycle.
import { locateUserData } from './estate.mjs'

// 保持对外 API 不变：本模块原本自己 export 过 locateUserData。
// 现在只是把 estate.mjs 的实现转发出去，调用方不用改。
export { locateUserData }

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 快照要存的 5 个配置文件。顺序即「写入顺序」，热重载的必须在最后。 */
export const SNAPSHOT_FILES = [
  'pnpm-workspace.yaml',
  'compatibility.json',
  'pnpm-lock.yaml',
  'package.json',
  'cordis.patch.yml',
]

/** 热重载的那个文件 —— 回滚时最后写，避免中间态触发重载崩溃。 */
export const HOT_RELOAD_FILE = 'cordis.patch.yml'

/**
 * 快照内 Electron 状态的子目录名。
 *
 * ⚠️ 2026-10-22 用户裁定：状态也纳入快照，统一管理
 *   「当拍摄快照时，profiles/desktop/ + AppData/Roaming/ 都写进去！
 *    统一用快照做管理！不要在意占用存储大小！」
 *
 * 所以快照 = 配置文件（平铺在快照根）+ 运行时状态（在这个子目录）
 */
export const ESTATE_SUBDIR = 'estate'

/**
 * 纳入快照的 Electron userData 条目。
 *
 * 只包含「会影响 DSH 能否启动」的部分，
 * 排除纯缓存（Cache / Code Cache / GPUCache 等 —— 那是几十上百 MB 的垃圾）。
 */
export const ESTATE_ENTRIES = [
  'Network',
  'shared_proto_db',
  'Local Storage',
  'Session Storage',
  'WebStorage',
  'Preferences',
  'lockfile',
]


/**
 * 递归复制目录（自己实现，兼容老 Node）。
 *
 * @returns {{copied: number, skipped: number, locked: string[]}}
 *   `locked` = 因被占用而没复制成的文件。
 *
 * ⚠️ 2026-10-22 结论：locked 属于【正常情况】，不是缺陷。
 *
 *   典型例子 Network/Cookies —— Chromium 独占打开（Win32Error=32），
 *   任何进程都读不到。但 cookie 每次启动都重新生成，不备份它对还原毫无影响：
 *
 *     start: async () => {
 *         const ready = await host.start();
 *         hostCookie = await authenticateWebHost(ready.url);  // ← 每次换新 cookie
 *     }
 *
 *   所以这里只【记录】locked 文件供诊断，不把它当成备份失败。
 */
export function cpDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  let names
  try { names = readdirSync(src) } catch { return { copied: 0, skipped: 0, locked: [] } }
  let copied = 0
  let skipped = 0
  const locked = []
  for (const n of names) {
    const s = join(src, n)
    const d = join(dest, n)
    let st
    try { st = statSync(s) } catch { skipped += 1; continue }
    if (st.isDirectory()) {
      const r = cpDir(s, d)
      copied += r.copied
      skipped += r.skipped
      for (const x of r.locked) locked.push(n + '/' + x)
    } else {
      try {
        copyFileSync(s, d)
        copied += 1
      } catch (e) {
        skipped += 1
        // EBUSY / EACCES / WinError 32 = 被占用
        const code = e?.code ?? ''
        if (code === 'EBUSY' || code === 'EACCES' || code === 'EPERM') {
          locked.push(n)
        }
      }
    }
  }
  return { copied, skipped, locked }
}

/**
 * 状态备份里「必须有的关键文件」。
 *
 * ⚠️ 2026-10-22 重要结论：**当前没有任何关键文件**（空数组）。
 *
 *   ── 为什么曾经有，为什么又删掉 ──
 *
 *   起初把 `Network/Cookies` 列为关键文件，缺了就把备份判为「不完整」。
 *   这个判断是**错的**，源码与实测双重否定：
 *
 *   ① cookie 每次启动都重新生成（app.asar lib/main.js 的 start()）：
 *
 *        const ready = await host.start();
 *        hostCookie = await authenticateWebHost(ready.url);   // 换新 cookie
 *
 *      cookie 的 payload 只有 authority / issuedAt / expiresAt，
 *      全部只在当前进程内有效 —— 备份一份旧 cookie 到磁盘毫无用处。
 *
 *   ② 坏掉的库 Chromium 自己会重建（实测）：
 *      2026-10-22 08:43:49 启动成功，而 Cookies 的 mtime 是 11:26:08，
 *      说明那是 DSH 自己写出的全新空库，不是从任何备份恢复的。
 *
 *   ── 那 Cookies 到底是什么 ──
 *
 *   它是**本机进程间的握手凭据**（DSH 主进程 ↔ 本地 Host 子进程），
 *   不是账号登录态。账号在 $DSH_HOME/.credentials.yaml：
 *
 *     records:
 *       deepseek-account-platform/default:
 *         payload: { token, issuer }      ← 这才是真正的账号身份
 *
 *   所以 2026-10-22 那次事故里，cookie 库坏了导致 DSH 起不来，
 *   但用户账号信息完好 —— 重启后并没有要求重新登录，与事实相符。
 *
 *   ── 结论 ──
 *
 *   Cookies 不进快照是**正确设计**，不该告警、不该判「不完整」。
 *   它的【损坏】仍由 estate 体检检查（那是病根，必须能发现），
 *   但它的【内容】不需要备份。
 *
 *   本数组保留为空，供将来确有「缺了就还原不了」的文件时使用。
 */
export const ESTATE_CRITICAL_FILES = []

/** 递归算目录大小。 */
export function dirSize(dir) {
  let total = 0
  let names
  try { names = readdirSync(dir) } catch { return 0 }
  for (const n of names) {
    const p = join(dir, n)
    let st
    try { st = statSync(p) } catch { continue }
    total += st.isDirectory() ? dirSize(p) : st.size
  }
  return total
}

/** 递归删除目录。 */
export function rmDir(dir) {
  let names
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    const p = join(dir, n)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) rmDir(p)
    else { try { rmSync(p, { force: true }) } catch { /* 跳过被锁文件 */ } }
  }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

/**
 * 把 Electron 状态抓进快照目录。
 *
 * @param {string} snapDir  快照目录
 * @param {object} [opts]
 * @returns {{ok: boolean, copied: string[], bytes: number, skipped: number, reason?: string}}
 */
export function snapshotEstate(snapDir, opts = {}) {
  const loc = locateUserData(opts)
  if (!loc.ok) {
    return { ok: false, copied: [], bytes: 0, skipped: 0, reason: loc.reason }
  }
  const dest = join(snapDir, ESTATE_SUBDIR)
  mkdirSync(dest, { recursive: true })

  const copied = []
  const lockedFiles = []
  let bytes = 0
  let skipped = 0

  for (const name of ESTATE_ENTRIES) {
    const src = join(loc.dir, name)
    if (!existsSync(src)) continue
    const dst = join(dest, name)
    try {
      let st
      try { st = statSync(src) } catch { continue }
      if (st.isDirectory()) {
        const r = cpDir(src, dst)
        skipped += r.skipped
        for (const x of r.locked) lockedFiles.push(name + '/' + x)
        bytes += dirSize(dst)
      } else {
        try {
          copyFileSync(src, dst)
          bytes += statSync(dst).size
        } catch (e) {
          skipped += 1
          const code = e?.code ?? ''
          if (code === 'EBUSY' || code === 'EACCES' || code === 'EPERM') lockedFiles.push(name)
        }
      }
      copied.push(name)
    } catch (e) {
      skipped += 1
    }
  }

  // 诊断信息：哪些文件因被占用没复制（属于正常，不影响还原）
  const notCopied = [...lockedFiles]

  writeJsonAtomic(join(dest, 'estate-meta.json'), {
    capturedAt: new Date().toISOString(),
    capturedAtMs: Date.now(),
    userDataDir: loc.dir,
    entries: copied,
    bytes,
    skipped,
    notCopied,
    // 说明：这里不再有 complete / missingCritical 字段。
    // 原因见 ESTATE_CRITICAL_FILES 的注释 —— Cookies 不需要备份，
    // 缺它属于正常，不该让整份备份被判为「不完整」。
    note: 'Cookies 不在备份范围：它是每次启动重建的进程握手凭据，'
      + '不是账号登录态（账号在 $DSH_HOME/.credentials.yaml）。'
      + '它的损坏由 estate 体检负责发现，不由备份负责复原。',
  })

  return {
    ok: true, copied, bytes, skipped,
    notCopied,
    lockedFiles,
  }
}

/**
 * 从快照还原 Electron 状态。
 *
 * ⚠️ 必须先完全退出 DSH —— 状态文件被占用写不进去。
 *
 * @param {string} snapDir  快照目录
 * @param {object} [opts]
 * @returns {{ok: boolean, restored: string[], bytes: number, skipped: string[], reason?: string}}
 */
export function restoreEstate(snapDir, opts = {}) {
  const src = join(snapDir, ESTATE_SUBDIR)
  if (!existsSync(src)) {
    return { ok: false, restored: [], bytes: 0, skipped: [], reason: '快照里没有状态部分' }
  }
  const loc = locateUserData(opts)
  if (!loc.ok) {
    return { ok: false, restored: [], bytes: 0, skipped: [], reason: loc.reason }
  }

  const restored = []
  const skipped = []
  const failed = []
  let bytes = 0

  for (const name of ESTATE_ENTRIES) {
    const s = join(src, name)
    if (!existsSync(s)) { skipped.push(name); continue }
    const d = join(loc.dir, name)
    const bak = d + '.fk-before-restore'
    let movedOld = false
    try {
      let st
      try { st = statSync(s) } catch { skipped.push(name); continue }
      // 旧内容先挪走；移动失败就保留原内容并报告，绝不能删掉再试。
      if (existsSync(d)) {
        try { rmDir(bak) } catch { /* 忽略 */ }
        renameSync(d, bak)
        movedOld = true
      }
      if (st.isDirectory()) {
        const r = cpDir(s, d)
        if (r.skipped > 0) throw new Error(`${r.skipped} 个文件复制失败或被占用`)
        bytes += dirSize(d)
      } else {
        copyFileSync(s, d)
        bytes += statSync(d).size
      }
      restored.push(name)
      if (movedOld) { try { rmDir(bak) } catch { /* 备份残留不影响本次还原 */ } }
    } catch (e) {
      // 复制失败时撤销这一项，避免留下半套状态。
      let restoreError = null
      try {
        if (existsSync(d)) {
          try { rmSync(d, { recursive: true, force: true }) } catch (cleanupError) { restoreError = String(cleanupError?.message ?? cleanupError) }
        }
        if (movedOld && existsSync(bak)) {
          renameSync(bak, d)
          if (existsSync(bak)) restoreError = '旧状态已移回但备份目录仍有残留'
        }
      } catch (rollbackError) {
        restoreError = String(rollbackError?.message ?? rollbackError)
      }
      failed.push(`${name}: ${String(e?.message ?? e)}${restoreError ? `；撤销失败，保留 ${bak}：${restoreError}` : ''}`)
    }
  }

  return {
    ok: failed.length === 0,
    restored, bytes, skipped, failed,
    ...(failed.length === 0 ? {} : { reason: `${failed.length} 个状态条目还原失败` }),
  }
}

/** DSH 启动的必需条目（源码 app-boot requiredStartupEntryIds）。 */
export const REQUIRED_ENTRY_IDS = [
  'agent-loop', 'webserver', 'web-runtime', 'modules',
  'connection', 'headless-runner', 'acp', 'sdk-jsonrpc-server',
]

/** 快照根目录名（放在 $DSH_HOME 下，profile 外面）。 */
export const SNAPSHOT_ROOT = 'rollback-snapshots'

/** 当前存储格式版本。读到更高的版本要拒绝操作（fail-closed）。 */
export const STORE_VERSION = 1

/** 各类快照的保留配额。 */
export const KEEP = {
  daily: 3,       // 昨天、今天、明天
  rolling: 3,     // 最近 3 个（内容不同才建）
  checkpoints: 50,
  // 回滚前快照独立配额（2026-10-20 用户要求单独存放）：
  // 每次回滚都会产生一份「回滚前的现场」，保留最近 10 次足够追溯，
  // 不占用手动快照的 50 个名额。
  restorePoints: 10,
}

/** rolling 的最小间隔：2 小时。 */
export const ROLLING_INTERVAL_MS = 2 * 60 * 60 * 1000

/** 退出码（.bat 靠它判断结果）。 */
export const EXIT = {
  OK: 0,
  GENERAL: 1,
  ARGS: 2,
  NO_PROFILE: 3,
  NO_SNAPSHOT: 4,
  PERMISSION: 5,
  NO_SPACE: 6,
  NEEDS_HUMAN: 7,
  PARTIAL: 8,
}

// ─────────────────────────────────────────────────────────────
// 基础工具
// ─────────────────────────────────────────────────────────────

/** 读 JSON，失败返回 null。 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 原子写 JSON：先写带进程标识的 .tmp 再 rename。 */
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(tmp, path)
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* 已 rename 或清理失败 */ }
  }
}

const SNAPSHOT_TYPES = new Set(['daily', 'rolling', 'checkpoints', 'restore-points'])
const SAFE_ID = /^\d{8}-\d{6}-\d{3}$/
const SAFE_SLOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isWithin(root, path) {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\') && !isAbsolute(rel))
}

function assertNoSymlinkPath(root, path) {
  const base = resolve(root)
  const target = resolve(path)
  if (!isWithin(base, target)) throw new Error(`路径越界：${target}`)
  let cur = base
  const parts = relative(base, target).split(/[\\/]/).filter(Boolean)
  for (const part of parts) {
    cur = join(cur, part)
    try {
      if (lstatSync(cur).isSymbolicLink()) throw new Error(`拒绝符号链接/junction：${cur}`)
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e
    }
  }
}

/** 安全固定槽名；拒绝空值、路径分隔符、盘符和 Windows 保留名。 */
export function assertSafeSlot(slot) {
  const s = String(slot ?? '')
  if (!SAFE_SLOT.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) {
    throw new Error(`固化槽名不合法：${s}`)
  }
  return s
}

/**
 * 解析并验证索引里的快照目录。只接受四类池下的时间戳 ID。
 * dir 永远不能直接交给删除、复制或还原函数。
 */
export function snapshotPath(root, entry) {
  if (!entry || typeof entry.dir !== 'string' || typeof entry.id !== 'string') {
    throw new Error('快照索引项缺少安全 id/dir')
  }
  const match = /^(daily|rolling|checkpoints|restore-points)\/(\d{8}-\d{6}-\d{3})$/.exec(entry.dir)
  if (!match || match[2] !== entry.id || !SAFE_ID.test(entry.id) || !SNAPSHOT_TYPES.has(match[1])) {
    throw new Error(`快照目录不合法：${entry.dir}`)
  }
  const path = resolve(root, match[1], match[2])
  assertNoSymlinkPath(root, path)
  return path
}

/** restoreSnapshot 只接受快照根下四类时间戳目录或固定救援槽。 */
function assertRestoreSnapshotPath(root, snap) {
  const base = resolve(root)
  const target = resolve(snap)
  const rel = relative(base, target)
  const pool = /^(daily|rolling|checkpoints|restore-points)[\\/](\d{8}-\d{6}-\d{3})$/.exec(rel)
  const fixed = /^fixed[\\/]([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(rel)
  if (!pool && !fixed) throw new Error(`还原目录不合法：${rel || target}`)
  if (pool && !SNAPSHOT_TYPES.has(pool[1])) throw new Error(`还原快照类型不合法：${pool[1]}`)
  if (fixed) assertSafeSlot(fixed[1])
  assertNoSymlinkPath(base, target)
}

function removePath(path) {
  try { rmSync(path, { recursive: true, force: true }) } catch { /* best effort */ }
}

function withRootLock(root, fn) {
  mkdirSync(root, { recursive: true })
  const lock = join(root, '.write.lock')
  const deadline = Date.now() + 15000
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      break
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
      try {
        const st = lstatSync(lock)
        if (!st.isFile() || st.isSymbolicLink()) throw new Error('索引锁文件异常，拒绝操作')
        if (Date.now() - st.mtimeMs > 30000) rmSync(lock, { force: true })
      } catch (le) {
        if (le?.code !== 'ENOENT') throw le
      }
      if (Date.now() >= deadline) throw new Error('等待快照索引锁超时')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + Math.floor(Math.random() * 25))
    }
  }
  try { return fn() } finally {
    try { rmSync(lock, { force: true }) } catch { /* 进程退出后可按过期时间恢复 */ }
  }
}

/** 文件 SHA256（前 16 位足够区分）。 */
export function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

/** 本地日期字符串 YYYY-MM-DD。 */
export function localDate(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 快照 ID：YYYYMMDD-HHmmss-SSS（含毫秒，防同秒冲突）。 */
export function makeSnapshotId(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    + `-${p(d.getMilliseconds(), 3)}`
}

/** 解析 DSH_HOME。 */
export function resolveHome(explicit) {
  if (explicit) return resolve(explicit)
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  return resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
}

/**
 * 选默认 profile：读 profiles/ 下 cordis.yml 的 mtime，取最新的。
 * @returns {string|null}
 */
export function pickRecentProfile(home) {
  const dir = join(home, 'profiles')
  if (!existsSync(dir)) return null
  let best = null
  let bestMtime = 0
  for (const name of readdirSync(dir)) {
    const marker = join(dir, name, 'cordis.yml')
    try {
      const m = statSync(marker).mtimeMs
      if (m > bestMtime) { bestMtime = m; best = name }
    } catch { /* 没有 marker 的跳过 */ }
  }
  return best ?? 'desktop'
}

// ─────────────────────────────────────────────────────────────
// 指纹（用于 boot-log 与「状态一致」判定）
// ─────────────────────────────────────────────────────────────

/**
 * 算 5 个文件的指纹。
 * @returns {{perFile: Record<string,string|null>, aggregate: string}}
 */
export function fingerprint(profileDir) {
  const perFile = {}
  for (const f of SNAPSHOT_FILES) {
    perFile[f] = sha256(join(profileDir, f))
  }
  const aggregate = createHash('sha256')
    .update(SNAPSHOT_FILES.map((f) => `${f}=${perFile[f] ?? 'missing'}`).join('|'))
    .digest('hex').slice(0, 32)
  return { perFile, aggregate }
}

// ─────────────────────────────────────────────────────────────
// 固化区（fixed/）—— 专供 .bat 紧急救场
// ─────────────────────────────────────────────────────────────
//
// ⚠️ 关键设计（2026-10-20 用户指出）：
//
//   快照池（daily/rolling/checkpoints）会按配额**自动顶替最旧的**，
//   适用于「DSH 能启动、只是配置有问题」的场景。
//
//   但 .bat 是「DSH 完全起不来」时的最后手段 ——
//   那时用户没法打开面板、没法慢慢选快照，
//   如果 .bat 依赖的快照刚好被顶掉了，就是死路。
//
//   所以固化区单独存放：**不参与任何自动清理**，
//   只有用户主动取消固化才会删除。

/** 固化区目录名。 */
export const FIXED_DIR = 'fixed'

/** .bat 默认使用的固化槽位名。 */
export const FIXED_SLOT_DEFAULT = 'bat-default'

/** 固化区根的路径。 */
export function fixedDir(root) {
  return join(root, FIXED_DIR)
}

/** 某个固化槽的路径。 */
export function fixedSlotDir(root, slot = FIXED_SLOT_DEFAULT) {
  const safe = assertSafeSlot(slot)
  const base = fixedDir(root)
  const dest = resolve(base, safe)
  assertNoSymlinkPath(base, dest)
  return dest
}

/**
 * 把某个快照固化成 .bat 的固定数据源。
 *
 * @param {object} opts
 * @param {string} opts.root        快照根
 * @param {object} opts.entry       index.entries 里的那一项
 * @param {string} [opts.slot]      槽位名，默认 bat-default
 * @returns {{slot: string, dir: string, files: number, bytes: number, fromName: string}}
 * @throws 源快照不存在 / 校验失败
 */
export function fixSnapshot(opts) {
  const { root, entry } = opts
  const slot = assertSafeSlot(opts.slot ?? FIXED_SLOT_DEFAULT)
  const src = snapshotPath(root, entry)
  const dest = fixedSlotDir(root, slot)
  const srcMeta = readJson(join(src, 'meta.json'))
  if (!srcMeta) throw new Error(`源快照无效（缺 meta.json）：${src}`)

  const bad = []
  for (const f of SNAPSHOT_FILES) {
    const rec = srcMeta.files?.[f]
    const sourceFile = join(src, f)
    let st = null
    try { st = lstatSync(sourceFile) } catch (e) { if (e?.code !== 'ENOENT') bad.push(`${f}: 读不了`) }
    if (!rec || typeof rec.exists !== 'boolean') { bad.push(`${f}: 无有效记录`); continue }
    if (rec.exists) {
      if (!st || !st.isFile() || st.isSymbolicLink()) bad.push(`${f}: 不是普通文件或不存在`)
      else if (sha256(sourceFile) !== rec.sha256) bad.push(`${f}: SHA256 不符`)
    } else if (st) {
      bad.push(`${f}: 记录为不存在，但文件存在`)
    }
  }
  if (bad.length > 0) throw new Error(`源快照已损坏，拒绝固化：\n  ${bad.join('\n  ')}`)

  const base = fixedDir(root)
  mkdirSync(base, { recursive: true })
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const tmp = resolve(base, `.${slot}.${token}.tmp`)
  const old = resolve(base, `.${slot}.${token}.old`)
  removePath(tmp)
  mkdirSync(tmp, { recursive: true })
  let replaced = false
  try {
    let bytes = 0
    let files = 0
    for (const f of SNAPSHOT_FILES) {
      const rec = srcMeta.files[f]
      if (!rec.exists) continue
      const sourceFile = join(src, f)
      const targetFile = join(tmp, f)
      copyFileSync(sourceFile, targetFile)
      if (sha256(targetFile) !== rec.sha256) throw new Error(`固化写入校验失败：${f}`)
      bytes += statSync(targetFile).size
      files += 1
    }

    const estateSrc = join(src, ESTATE_SUBDIR)
    let estateCopied = false
    let estateBytes = 0
    if (existsSync(estateSrc)) {
      const r = cpDir(estateSrc, join(tmp, ESTATE_SUBDIR))
      if (r.skipped > 0) throw new Error(`固化状态复制失败：${r.skipped} 个文件`)
      estateCopied = true
      estateBytes = dirSize(join(tmp, ESTATE_SUBDIR))
      bytes += estateBytes
      files += 1
    }

    const meta = {
      storeVersion: STORE_VERSION,
      id: srcMeta.id,
      type: srcMeta.type,
      slot,
      fromId: entry.id,
      fromName: entry.name,
      fromCreatedAt: entry.createdAt,
      fixedAt: new Date().toISOString(),
      fixedAtMs: Date.now(),
      fileCount: files,
      bytes,
      fingerprint: entry.fingerprint ?? null,
      estate: estateCopied ? { included: true, bytes: estateBytes } : { included: false },
      fixedBy: opts.fixedBy ?? 'user',
      pin: opts.pin === true,
      files: srcMeta.files,
      note: '这是 .bat 紧急救场用的固定副本，不参与快照池的自动清理',
    }
    writeJsonAtomic(join(tmp, 'meta.json'), meta)
    assertNoSymlinkPath(base, dest)
    if (existsSync(dest)) renameSync(dest, old)
    try {
      renameSync(tmp, dest)
      replaced = true
    } catch (e) {
      // 新副本没上位：优先把旧副本放回；回退失败也必须保留 old。
      if (existsSync(old)) {
        try { renameSync(old, dest) } catch { /* old 是唯一旧副本，交给人工恢复 */ }
      }
      throw e
    }
    removePath(old)
    return { slot, dir: dest, files, bytes, fromName: entry.name, estateCopied, estateBytes }
  } finally {
    removePath(tmp)
    if (replaced) removePath(old)
  }
}


/**
 * 自动把「当天（或最近）的 daily 快照」固化到 bat-default。
 *
 * ⚠️ 这是 .bat 数据源的唯一日常更新通道（2026-10-20 用户裁定）：
 *   「每天启动的快照自动作为固化给 .bat 脚本」
 *
 * 设计要点：
 *   · 只挑 daily 类型，且 health 不是 broken
 *   · 已经固化过同一份（fromId 相同）→ 跳过，避免每次启动都重写
 *   · 固化失败不抛错（启动钩子不能因它中断）
 *
 * @returns {{updated: boolean, reason: string, fromName?: string}}
 */
export function autoFixDaily(root, opts = {}) {
  try {
    const idx = readIndex(root)
    const entries = idx.entries ?? []

    // 挑最近的 daily
    //
    // ⚠️ 不按 health 过滤（2026-10-20 实测踩坑）：
    //   启动钩子建 daily 时把 runCheck 的结论写进了 health。
    //   如果那一刻体检是 fatal（例如插件刚损坏、测试 profile），
    //   这份 daily 的 health 就是 'fatal' ——
    //   但它是【当天启动时的真实配置】，正是 .bat 需要的数据。
    //   过滤掉它会导致 .bat 永远拿不到固化副本。
    //
    //   健康判断属于「还原后要不要用」的范畴，不属于「该不该固化」。
    //   若调用方确实只想要健康快照，可传 { requireHealthy: true }。
    let daily = entries
      .filter((e) => e.type === 'daily' && !['fatal', 'error', 'broken'].includes(healthOf(e)))
      .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))

    if (opts.requireHealthy) {
      daily = daily.filter((e) => healthOf(e) !== 'unknown')
    }

    if (daily.length === 0) {
      return { updated: false, reason: '没有可用的 daily 快照' }
    }

    const target = daily[0]

    // 已经是这一份了？跳过（避免每次启动都重写磁盘）
    const cur = readFixedSlot(root)
    if (cur && cur.meta?.fromId === target.id) {
      return { updated: false, reason: '固化副本已是最新的 daily', fromName: cur.meta.fromName }
    }

    // ⭐ 2026-10-23 改：只有「钉住」才跳过
    //
    // 旧逻辑看 fixedBy==='user' 就永久跳过，导致用户手动固化过一次之后，
    // .bat 再也不更新，永远还原一份陈旧配置（用户自己早忘了这回事）。
    //
    // 用户真实意图：「.bat 应该是今天启动的那份配置」。
    // 所以默认跟随最新 daily；
    // 只有用户显式 pin=true（"我就要这一份，别动"）才保留。
    if (cur && cur.meta?.pin === true && !opts.force) {
      return {
        updated: false,
        reason: `固化副本已被钉住（${cur.meta.fromName}），不自动覆盖；` +
          '取消钉住：dsh-rollback.mjs fix --unpin',
        fromName: cur.meta.fromName,
        pinned: true,
      }
    }

    const r = fixSnapshot({ root, entry: target, slot: FIXED_SLOT_DEFAULT })

    // 标记这是自动固化，并把「换掉了哪一份」记下来供追溯
    const dest = fixedSlotDir(root, FIXED_SLOT_DEFAULT)
    const mp = join(dest, 'meta.json')
    const meta = readJson(mp) ?? {}
    meta.fixedBy = 'auto-daily'
    meta.pin = false
    if (cur) {
      // 记录被替换掉的那一份，将来查「.bat 为什么换了」有据可依
      meta.replacedFrom = {
        fromId: cur.meta?.fromId ?? null,
        fromName: cur.meta?.fromName ?? null,
        fixedAt: cur.meta?.fixedAt ?? null,
        fixedBy: cur.meta?.fixedBy ?? null,
        pinned: cur.meta?.pin === true,
      }
    } else {
      meta.replacedFrom = null
    }
    writeJsonAtomic(mp, meta)

    const replaced = cur && cur.meta?.fromName && cur.meta.fromName !== r.fromName
      ? `（替换掉旧副本：${cur.meta.fromName}）`
      : ''
    return {
      updated: true,
      reason: `已固化最新 daily：${r.fromName}${replaced}`,
      fromName: r.fromName,
      replacedFrom: cur?.meta?.fromName ?? null,
    }
  } catch (e) {
    // 启动钩子不能因为固化失败而中断
    return { updated: false, reason: `自动固化失败：${String(e?.message ?? e)}` }
  }
}

/**
 * 读取某个固化槽的信息。
 * @returns {object|null} meta.json 内容，或 null（未固化）
 */
export function readFixedSlot(root, slot = FIXED_SLOT_DEFAULT) {
  const dest = fixedSlotDir(root, slot)
  if (!existsSync(dest)) return null
  const meta = readJson(join(dest, 'meta.json'))
  if (!meta) return null
  // 顺便校验文件还在不在
  const present = SNAPSHOT_FILES.filter((f) => existsSync(join(dest, f)))
  return {
    slot,
    dir: dest,
    meta,                                    // ⚠️ 保留 meta 包装（CLI/UI 都按这个访问）
    present,
    ok: present.length === SNAPSHOT_FILES.length,
  }
}

/** 取消固化（删除整个槽）。 */
export function unfixSlot(root, slot = FIXED_SLOT_DEFAULT) {
  const dest = fixedSlotDir(root, slot)
  if (!existsSync(dest)) return { removed: false }
  rmSync(dest, { recursive: true, force: true })
  return { removed: true }
}

/** 列出所有固化槽。 */
export function listFixedSlots(root) {
  const dir = fixedDir(root)
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const d = join(dir, name)
    try {
      assertSafeSlot(name)
      if (!lstatSync(d).isDirectory() || lstatSync(d).isSymbolicLink()) continue
    } catch { continue }
    const meta = readJson(join(d, 'meta.json'))
    const present = SNAPSHOT_FILES.filter((f) => existsSync(join(d, f)))
    out.push({
      slot: name,
      dir: d,
      meta,
      present,
      ok: present.length === SNAPSHOT_FILES.length,
    })
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// 快照目录管理
// ─────────────────────────────────────────────────────────────

/** 该 profile 的快照根。 */
export function snapshotDir(home, profile) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new Error(`profile 名称不合法：${profile}`)
  }
  return join(home, SNAPSHOT_ROOT, profile)
}

/**
 * 快照类型 → 目录名。
 *
 * ⚠️ 索引里的 `dir` 必须用【目录名】而不是 `type`，否则路径对不上。
 *
 * 2026-10-20 变更（用户要求）：
 *   「回滚后会生成一个回滚前的快照，建议把这一栏单独存放，
 *    并且说明是某某时间段的回滚」
 *   → before-restore 从 checkpoints/ 独立到 restore-points/
 *   → 它是「某次回滚之前的现场」，语义和手动快照完全不同，混在一起会乱
 */
export function dirNameOf(type) {
  // ⚠️ 2026-11-01 BUG 修复：这个函数原本只接受【type】值，
  //    但 pruneSnapshots() 的循环传的是【目录名】。
  //
  //    pruneSnapshots:
  //      for (const type of ['daily','rolling','checkpoints','restore-points'])
  //        tierDir(root, type)
  //
  //    于是 dirNameOf('restore-points') 不匹配 'before-restore'，
  //    落到 return 'checkpoints' 兜底 →
  //    配额检查一直在扫 checkpoints 目录，
  //    restore-points 里的回滚记录从来没被清理过。
  //
  //    实测后果：配额写 10，实际堆到 18 个，10-21/10-22 的老快照全部残留。
  //
  //    修法：两种写法都认，做成幂等映射（输入目录名就原样返回）。
  if (type === 'daily') return 'daily'
  if (type === 'rolling') return 'rolling'

  // 回滚前快照：type 与目录名都接受
  if (type === 'before-restore' || type === 'restore-points') return 'restore-points'

  // 手动快照：type 'manual' 与目录名 'checkpoints' 都接受
  if (type === 'manual' || type === 'checkpoints') return 'checkpoints'

  // 未知类型：保持原兜底行为（当成手动快照目录），
  // 这样历史上任何传错的值都不会变成「找不到目录」而静默跳过清理。
  return 'checkpoints'
}

/** 三类快照各自的子目录。 */
export function typeDir(root, type) {
  return join(root, dirNameOf(type))
}

/** 读 index.json。损坏或缺失时返回空骨架。 */
export function readIndex(root) {
  const path = join(root, 'index.json')
  if (!existsSync(path)) {
    return {
      storeVersion: STORE_VERSION,
      profile: null,
      entries: [],
      policy: { maxCheckpoints: KEEP.checkpoints, maxDays: 30 },
      sched: { lastDailyDate: null, lastRollingAt: 0, lastRollingFingerprint: null },
    }
  }
  const idx = readJson(path)
  if (!idx || typeof idx !== 'object' || Array.isArray(idx)) {
    throw new Error('快照索引损坏，拒绝用空索引覆盖它')
  }
  return idx
}

/** 写 index.json（原子）。 */
export function writeIndex(root, idx) {
  mkdirSync(root, { recursive: true })
  writeJsonAtomic(join(root, 'index.json'), idx)
}

/**
 * fail-closed：读到未来的 storeVersion 就拒绝操作。
 * @throws {Error} 版本高于本代码
 */
export function assertStoreVersion(idx) {
  const v = idx?.storeVersion
  if (v !== STORE_VERSION) {
    throw new Error(
      v === undefined
        ? '快照索引缺少 storeVersion，拒绝操作以免按旧逻辑误改数据。'
        : `快照索引的 storeVersion 是 ${String(v)}，本工具只支持 ${STORE_VERSION}。拒绝操作。`,
    )
  }
}

/** 兼容索引里的字符串与 meta 里的 { overall }，未知值按 unknown 处理。 */
export function healthOf(entry) {
  const raw = typeof entry?.health === 'string' ? entry.health : entry?.health?.overall
  return ['ok', 'warn', 'error', 'fatal', 'broken', 'unknown'].includes(raw) ? raw : 'unknown'
}


// ─────────────────────────────────────────────────────────────
// 确认可接受（acknowledged · §3.5）
// ─────────────────────────────────────────────────────────────

/**
 * 读 acknowledged.json。
 * @returns {{[code: string]: {[key: string]: {ackedAt, reason, signature}}}}
 */
export function readAcknowledged(root) {
  return readJson(join(root, 'acknowledged.json')) ?? {}
}

/** 写 acknowledged.json（原子）。 */
export function writeAcknowledged(root, data) {
  mkdirSync(root, { recursive: true })
  writeJsonAtomic(join(root, 'acknowledged.json'), data)
}

/**
 * 算某条 issue 的签名（用于「确认失效」判定）。
 *
 * §3.5：确认时记录相关文件哈希；下次体检比对，
 * 签名一致 → 静默；签名变了 → 重新提示。
 *
 * @param {object} issue   体检 issue
 * @param {string} profileDir
 * @returns {string} 16 位签名
 */
export function issueSignature(issue, profileDir) {
  const parts = [issue.code ?? '', issue.package ?? '', issue.entryId ?? '']
  // 把相关文件的内容哈希算进来
  const files = []
  if (issue.file) files.push(issue.file)
  if (issue.code === 'bundle-overrides-seam' || issue.code === 'duplicate-user-id') {
    files.push('cordis.patch.yml')
  }
  if (issue.code === 'engines-exact-mismatch' && issue.package) {
    files.push(`node_modules/${issue.package}/package.json`)
  }
  for (const f of files) {
    const h = sha256(join(profileDir, f))
    if (h) parts.push(f + '=' + h)
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

/**
 * 过滤掉「已确认可接受且签名仍有效」的 issue。
 *
 * @param {Array} issues
 * @param {object} acked   readAcknowledged() 的返回值
 * @param {string} profileDir
 * @returns {{kept: Array, ackedCount: number}}
 */
export function filterAcknowledged(issues, acked, profileDir) {
  const kept = []
  let ackedCount = 0
  for (const it of issues) {
    const byCode = acked?.[it.code]
    // key 优先用 package，其次 entryId，最后 '*'
    const key = it.package ?? it.entryId ?? '*'
    const rec = byCode?.[key]
    if (!rec) { kept.push(it); continue }
    const sig = issueSignature(it, profileDir)
    if (rec.signature && rec.signature === sig) {
      // 签名一致 → 静默，但仍记一条 info 供台账查看
      kept.push({ ...it, acknowledged: true, ackedAt: rec.ackedAt, ackReason: rec.reason })
      ackedCount += 1
    } else {
      // 签名变了 → 重新提示，并标注
      kept.push({ ...it, ackExpired: true })
    }
  }
  return { kept, ackedCount }
}

/**
 * 原子地更新索引：总是在【最新】的索引上改，避免读-改-写覆盖。
 *
 * ⚠️ 踩过的坑：先 readIndex、再 createSnapshot（它会 push 并写盘）、
 * 然后在旧对象上改 sched 再 writeIndex —— 会把刚建的条目抹掉。
 * 凡是「创建快照之后还要改索引」的地方，一律用本函数。
 */
export function updateIndex(root, mutator) {
  return withRootLock(root, () => {
    const idx = readIndex(root)
    assertStoreVersion(idx)
    mutator(idx)
    writeIndex(root, idx)
    return idx
  })
}

// ─────────────────────────────────────────────────────────────
// 创建快照（有序提交：先数据，后索引）
// ─────────────────────────────────────────────────────────────

/**
 * 创建一个快照。
 *
 * 有序提交：先写 5 个文件副本，全部成功后最后写 meta.json。
 * meta.json 存在 = 快照完整；缺它 = 半截，会被视为无效。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} opts.profile
 * @param {'daily'|'rolling'|'manual'|'before-restore'} opts.type
 * @param {string} [opts.name]
 * @param {string} [opts.note]
 * @param {string} [opts.dshVersion]
 * @param {object} [opts.health]
 * @returns {{id: string, dir: string, bytes: number}}
 */
export function createSnapshot(opts) {
  const { home, profile, type } = opts
  if (!['daily', 'rolling', 'manual', 'before-restore'].includes(type)) throw new Error(`快照类型不合法：${type}`)
  if (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) throw new Error('profile 名称不合法')
  const root = snapshotDir(home, profile)
  const dir = typeDir(root, type)
  mkdirSync(dir, { recursive: true })

  let id = makeSnapshotId()
  let snapDir = join(dir, id)
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(snapDir, { mode: 0o700 })
      break
    } catch (e) {
      if (e?.code !== 'EEXIST' || attempt >= 20) throw e
      // 同毫秒或系统时钟回拨时换一个 ID，绝不能复用别人正在写的目录。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
      const next = makeSnapshotId()
      if (next === id) throw new Error('快照 ID 冲突，请重试')
      id = next
      snapDir = join(dir, next)
    }
  }

  const files = {}
  let bytes = 0

  // ① 先写数据
  for (const f of SNAPSHOT_FILES) {
    const src = join(home, 'profiles', profile, f)
    if (existsSync(src)) {
      const dst = join(snapDir, f)
      copyFileSync(src, dst)
      const size = statSync(dst).size
      bytes += size
      files[f] = { size, sha256: sha256(dst), exists: true }
    } else {
      // 记录「不存在」，还原时据此删除
      files[f] = { size: 0, sha256: null, exists: false }
    }
  }

  // ② 校验写入结果
  for (const f of SNAPSHOT_FILES) {
    if (files[f].exists && sha256(join(snapDir, f)) !== files[f].sha256) {
      rmSync(snapDir, { recursive: true, force: true })
      throw new Error(`写入校验失败：${f}`)
    }
  }

  // ②b ⭐ 抓 Electron 运行时状态（2026-10-22 用户裁定：统一进快照）
  //
  // 「当拍摄快照时，profiles/desktop/ + AppData/Roaming/ 都写进去！
  //  统一用快照做管理！不要在意占用存储大小！」
  //
  // 状态部分失败不影响配置部分（配置是主业务）——
  // 但要如实记录，还原时才知道这份快照有没有状态。
  let estateInfo = { ok: false, copied: [], bytes: 0, skipped: 0, reason: '未尝试' }
  if (opts.estate !== false) {
    try {
      estateInfo = snapshotEstate(snapDir, opts.estateOpts ?? {})
    } catch (e) {
      estateInfo = { ok: false, copied: [], bytes: 0, skipped: 0, reason: String(e?.message ?? e) }
    }
  }
  if (estateInfo.ok) bytes += estateInfo.bytes

  // ③ 记录创建来源；名称去重和索引提交必须在同一把锁内。
  const org = detectOrigin(opts.origin)
  let fp

  const meta = {
    id,
    type,
    origin: org.origin,              // auto / ai / user
    sessionId: org.sessionId,        // AI 创建时记下是哪个会话
    // §2.11：重名自动编号（首次不带序号，第二次起加 ②③…）
    name: opts.name
      ? String(opts.name).trim().slice(0, 50)
      : defaultName(type, id),
    note: opts.note ?? '',
    // ⭐ 回滚详情（仅 before-restore 类型有）：
    //   { at, targetId, targetName, reason }
    //   UI 靠它说明「这是哪次回滚之前的现场」
    restoreInfo: opts.restoreInfo ?? null,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    dshVersion: opts.dshVersion ?? null,
    storeVersion: STORE_VERSION,
    fingerprint: null,
    perFileFingerprint: {},
    health: opts.health ?? { overall: 'unknown', counts: {}, issues: [] },
    files,
    // ⭐ 运行时状态部分的记录
    estate: estateInfo.ok
      ? {
        included: true,
        entries: estateInfo.copied,
        bytes: estateInfo.bytes,
        skipped: estateInfo.skipped,
        dir: ESTATE_SUBDIR,
        // 诊断：未复制的文件（正常情况，如被 Chromium 锁定的 Cookies）
        notCopied: estateInfo.notCopied ?? estateInfo.lockedFiles ?? [],
      }
      : {
        included: false,
        reason: estateInfo.reason,
      },
    excluded: {
      'cordis.yml': { reason: '每次启动被重写为固定模板' },
      'node_modules': { reason: '可由 lockfile 重建' },
      '*.bak-*': { reason: '历史备份' },
      '$DSH_HOME/cordis.patch.yml': { reason: 'home 级，按裁定排除' },
    },
    rolledBackAt: null,
  }
  writeJsonAtomic(join(snapDir, 'meta.json'), meta)

  // ④ 数据先落盘；锁内重读索引、去重并提交。失败则清掉未登记孤儿。
  let committed = false
  try {
    withRootLock(root, () => {
      const idx = readIndex(root)
      assertStoreVersion(idx)
      fp = fingerprint(join(home, 'profiles', profile))
      meta.fingerprint = fp.aggregate
      meta.perFileFingerprint = fp.perFile
      if (opts.name) meta.name = dedupeName(root, opts.name)
      writeJsonAtomic(join(snapDir, 'meta.json'), meta)
      idx.profile = profile
      idx.entries = idx.entries ?? []
      idx.entries.push({
        id, type,
        origin: meta.origin,
        sessionId: meta.sessionId,
        dir: `${dirNameOf(type)}/${id}`,
        name: meta.name, note: meta.note,
        restoreInfo: meta.restoreInfo,
        createdAt: meta.createdAt, createdAtMs: meta.createdAtMs,
        size: bytes, dshVersion: meta.dshVersion,
        health: healthOf(meta), fingerprint: fp.aggregate,
        hasEstate: Boolean(meta.estate?.included),
        estateBytes: meta.estate?.bytes ?? 0,
      })
      writeIndex(root, idx)
    })
    committed = true
  } finally {
    if (!committed) removePath(snapDir)
  }

  return { id, dir: snapDir, bytes, meta }
}

/**
 * 处理重名：首次不带序号，第二次起加 ②③④…
 *
 * 设计方案 §2.11（用户裁定）：
 *   「装插件前」→「装插件前②」→「装插件前③」
 *   注意第一次【不加】序号，第二次才是 ②。
 *
 * @param {string} root   快照根目录
 * @param {string} name   想用的名称
 * @param {string} [selfId] 自己（改自己的名字时排除自己）
 * @returns {string} 去重后的名称
 */
export function dedupeName(root, name, selfId) {
  const base = String(name ?? '').trim()
  if (!base) return base
  const CIRCLE = ['', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']

  // 收集已用名称（排除自己）
  const used = new Set()
  try {
    const idx = readIndex(root)
    for (const e of idx.entries ?? []) {
      if (selfId && e.id === selfId) continue
      if (e.name) used.add(String(e.name))
    }
  } catch { /* 忽略 */ }

  if (!used.has(base)) return base
  for (let k = 1; k < CIRCLE.length; k++) {
    const cand = base + CIRCLE[k]
    if (!used.has(cand)) return cand
  }
  // 兜底：超过 ⑩ 就用数字
  for (let k = CIRCLE.length; k < 999; k++) {
    const cand = `${base}(${k})`
    if (!used.has(cand)) return cand
  }
  return `${base}(${Date.now() % 1000})`
}


// ─────────────────────────────────────────────────────────────
// 创建来源（origin）：AI / 用户 / 自动
// ─────────────────────────────────────────────────────────────
//
// ⚠️ 2026-10-19 用户指出：「快照标签全是手动，但这明明是你创建，应该写 AI/自动」
//
// 问题：旧实现只有 type 字段（manual/daily/rolling/before-restore），
//      没有记录「是谁触发的」——
//      用户手动点按钮 和 AI 在会话里跑命令，都记成 manual。
//
// 判定依据（实测有效）：
//   · AI 在会话里执行命令时，DSH 会注入 DSH_SESSION_ID 环境变量
//   · 用户在终端手动跑、或双击 .bat 时，没有这个变量
//   · 自动钩子（turn/end / plugin-changed / install-state）由插件内部调用，
//     显式传 origin='auto'
//
// 于是可以三者区分：
//   origin='auto'   → 钩子自动建的（每日/滚动/装插件前后/回滚前）
//   origin='ai'     → AI 在会话里建的（有 DSH_SESSION_ID）
//   origin='user'   → 用户手动建的（无 DSH_SESSION_ID）
//

/**
 * 探测创建来源。
 *
 * @param {string} [explicit] 显式指定（自动钩子会传 'auto'）
 * @returns {{origin: string, sessionId: string|null}}
 */
export function detectOrigin(explicit) {
  if (explicit) {
    return { origin: explicit, sessionId: null }
  }
  const sid = process.env.DSH_SESSION_ID
  if (sid && String(sid).trim() !== '') {
    return { origin: 'ai', sessionId: String(sid) }
  }
  return { origin: 'user', sessionId: null }
}

/** origin → 中文标签（UI 用）。 */
export const ORIGIN_LABEL = {
  auto: '自动',
  ai: 'AI',
  user: '手动',
}

/** 默认名称。 */
export function defaultName(type, id) {
  // id = YYYYMMDD-HHmmss-SSS
  const d = id.slice(0, 8)
  const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  if (type === 'daily') return `每日快照 ${date}`
  const t = id.slice(9, 13)
  const hh = `${t.slice(0, 2)}:${t.slice(2, 4)}`
  if (type === 'rolling') return `滚动快照 ${date} ${hh}`
  // 回滚前快照的默认名（调用方通常会传更具体的 name，见 entry.js 的 restore）
  if (type === 'before-restore') return `回滚前 ${date} ${hh}`
  return `${date} ${hh}`
}

// ─────────────────────────────────────────────────────────────
// 保留与滚动
// ─────────────────────────────────────────────────────────────

/** 从索引、ISO 时间或目录名取得快照时间；无法确认时返回 null。 */
function snapshotCreatedAtMs(entry, id) {
  const raw = Number(entry?.createdAtMs)
  if (Number.isFinite(raw) && raw > 0) return raw
  const iso = Date.parse(entry?.createdAt ?? '')
  if (Number.isFinite(iso)) return iso
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d{3}$/.exec(id ?? '')
  if (m === null) return null
  const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)
  return Number.isFinite(at) ? at : null
}

/**
 * 按数量和天数清理快照池。
 *
 * 数量规则：
 *   · checkpoints = policy.maxCheckpoints（默认 50）
 *   · daily / rolling = 3 / 3，restore-points = 10，均独立计数
 *
 * 天数规则（2026-11-25 修复）：
 *   · 四类快照统一受 policy.maxDays 约束；之前只保存设置、从未执行
 *   · fixed/ 是 .bat 的独立救援副本，永不自动清理
 *   · 与当前配置一致的 ● 不删；无法确认创建时间的条目不删
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {string} [opts.currentFingerprint]
 * @param {boolean} [opts.dryRun] 只返回将删除的路径，不修改磁盘或索引
 * @returns {{removed: string[], expired: string[], dryRun: boolean}}
 */
export function pruneSnapshots(root, opts = {}) {
  const dryRun = Boolean(opts.dryRun)
  return withRootLock(root, () => {
    const removed = []
    const expired = []
    const idx = readIndex(root)
    assertStoreVersion(idx)
    const policy = idx.policy ?? {}
    const checkpoints = Number(policy.maxCheckpoints)
    const days = Number(policy.maxDays)
    const quota = {
      daily: KEEP.daily,
      rolling: KEEP.rolling,
      checkpoints: Number.isInteger(checkpoints) && checkpoints > 0 ? checkpoints : KEEP.checkpoints,
      'restore-points': KEEP.restorePoints ?? 10,
    }
    const maxDays = Number.isFinite(days) && days > 0 ? days : null
    const cutoff = maxDays === null ? null : Date.now() - maxDays * 86400000
    const curFp = opts.currentFingerprint ?? (() => {
      try {
        const profileName = root.split(/[\\/]/).pop()
        const home = root.replace(/[\\/]rollback-snapshots[\\/][^\\/]+$/, '')
        return fingerprint(join(home, 'profiles', profileName)).aggregate
      } catch { return null }
    })()

    for (const type of ['daily', 'rolling', 'checkpoints', 'restore-points']) {
      const dir = typeDir(root, type)
      if (!existsSync(dir)) continue
      const dirs = readdirSync(dir).filter((n) => {
        if (!SAFE_ID.test(n)) return false
        try { return lstatSync(join(dir, n)).isDirectory() && !lstatSync(join(dir, n)).isSymbolicLink() } catch { return false }
      }).sort()
      const sameFp = curFp
        ? (idx.entries ?? []).filter((e) => e.fingerprint === curFp)
          .sort((a2, b2) => (b2.createdAtMs ?? 0) - (a2.createdAtMs ?? 0))
        : []
      const dotName = sameFp[0]?.id ?? null
      const discard = (id) => {
        const path = snapshotPath(root, { id, dir: `${type}/${id}`, type })
        const rel = `${type}/${id}`
        if (!dryRun) rmSync(path, { recursive: true, force: true })
        ;(dryRun ? expired : removed).push(rel)
        dirs.splice(dirs.indexOf(id), 1)
      }

      if (cutoff !== null) {
        for (const id of dirs.slice()) {
          if (id === dotName) continue
          const entry = (idx.entries ?? []).find((e) => e.dir === `${type}/${id}`)
          const at = snapshotCreatedAtMs(entry, id)
          if (at !== null && at < cutoff) discard(id)
        }
      }
      while (dirs.length > quota[type]) {
        const victim = dirs.find((n) => n !== dotName)
        if (victim === undefined) break
        discard(victim)
      }
    }

    if (!dryRun && removed.length > 0) {
      idx.entries = (idx.entries ?? []).filter((e) => !removed.includes(e.dir))
      writeIndex(root, idx)
    }
    return { removed, expired, dryRun }
  })
}

// ─────────────────────────────────────────────────────────────
// 还原（两阶段写入 + 固定顺序）
// ─────────────────────────────────────────────────────────────

/**
 * 两阶段还原：全部写 .tmp → 全部成功后逐个 rename。
 * rename 顺序固定，热重载文件放最后。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} opts.profile
 * @param {string} opts.snapshotDir    含 meta.json 的快照目录
 * @returns {{restored: string[], skipped: string[], bytes: number}}
 * @throws 快照校验失败 / 写入失败
 */
export function restoreSnapshot(opts) {
  const { home, profile, snapshotDir: snap } = opts
  const profileDir = join(home, 'profiles', profile)
  const root = snapshotDir(home, profile)
  assertNoSymlinkPath(home, profileDir)
  assertRestoreSnapshotPath(root, snap)

  const meta = readJson(join(snap, 'meta.json'))
  if (!meta) throw new Error('快照无效：找不到 meta.json')

  // 旧 fixed 格式没有 files/storeVersion：只信它自己的聚合指纹，且 5 个文件必须齐全。
  // 不读快照池或 index；无法证明完整性就拒绝。
  const relSnap = relative(resolve(root), resolve(snap))
  const legacyFixed = /^fixed[\\/][A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(relSnap)
    && meta.storeVersion === undefined
    && (meta.files === undefined || typeof meta.files === 'number')
  if (legacyFixed) {
    if (typeof meta.fingerprint !== 'string' || meta.fingerprint.length === 0
      || fingerprint(snap).aggregate !== meta.fingerprint) {
      throw new Error('旧固化副本指纹不符，拒绝还原')
    }
    meta.storeVersion = STORE_VERSION
    meta.files = Object.fromEntries(SNAPSHOT_FILES.map((f) => {
      const st = lstatSync(join(snap, f))
      if (!st.isFile() || st.isSymbolicLink()) throw new Error(`旧固化副本文件无效：${f}`)
      return [f, { exists: true, size: st.size, sha256: sha256(join(snap, f)) }]
    }))
  } else {
    assertStoreVersion(meta)
  }

  // ① 校验快照完整性；记录为不存在但磁盘仍有文件也拒绝。
  const problems = []
  for (const f of SNAPSHOT_FILES) {
    const rec = meta.files?.[f]
    const sourceFile = join(snap, f)
    let st = null
    try { st = lstatSync(sourceFile) } catch (e) { if (e?.code !== 'ENOENT') problems.push(`${f}: 读不了`) }
    if (!rec || typeof rec.exists !== 'boolean') { problems.push(`${f}: 无有效记录`); continue }
    if (rec.exists) {
      if (!st || !st.isFile() || st.isSymbolicLink()) problems.push(`${f}: 不是普通文件或不存在`)
      else if (sha256(sourceFile) !== rec.sha256) problems.push(`${f}: SHA256 与记录不符（快照可能已损坏）`)
    } else if (st) {
      problems.push(`${f}: 记录为不存在，但文件存在`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`快照校验失败，未做任何修改：\n  ${problems.join('\n  ')}`)
  }

  // ② 阶段 A：全部写 .tmp。失败只清本次临时文件，绝不碰 rescue。
  const staged = []
  try {
    for (const f of SNAPSHOT_FILES) {
      const rec = meta.files[f]
      const tmp = join(profileDir, `${f}.fk-tmp`)
      if (rec.exists) {
        copyFileSync(join(snap, f), tmp)
        staged.push({ f, tmp, action: 'write' })
      } else {
        staged.push({ f, tmp: null, action: 'delete' })
      }
    }
  } catch (e) {
    // 连导致失败的那个临时路径也清掉；只碰 .fk-tmp，不碰 rescue。
    for (const f of SNAPSHOT_FILES) {
      try { rmSync(join(profileDir, `${f}.fk-tmp`), { force: true }) } catch { /* 保留阻塞项，不改 rescue */ }
    }
    throw new Error(`还原预写失败，未修改配置文件：${e.message}`)
  }

  // ③ 阶段 B：逐个 rename（已记录，失败可撤销）
  //
  // ⚠️ 顺序有硬约束：cordis.patch.yml 必须【最后】写。
  //
  //   它是 DSH 的热重载触发文件。如果先写它、再写别的文件，
  //   DSH 可能在中途读到「patch 已更新但 package.json 还是旧的」这种
  //   半成品组合，从而在还原过程中崩溃。
  //
  //   2026-10-29 审计发现：原实现只是「恰好」让它在 SNAPSHOT_FILES 末尾，
  //   而 HOT_RELOAD_FILE 常量定义了却没人用 —— 谁调整了数组顺序就会静默破坏这个约束。
  //   现在显式排序，不依赖数组顺序。
  const ordered = staged.slice().sort((a, b) => {
    const rank = (x) => (x.f === HOT_RELOAD_FILE ? 1 : 0)
    return rank(a) - rank(b)
  })

  const done = []
  const rescued = []
  let completed = false
  try {
    for (const s of ordered) {
      const target = join(profileDir, s.f)
      if (s.action === 'write') {
        // 先备份当前内容（供撤销）
        if (existsSync(target)) {
          const rescue = join(profileDir, `${s.f}.fk-rescue`)
          copyFileSync(target, rescue)
          rescued.push({ f: s.f, rescue })
        }
        renameSync(s.tmp, target)
      } else if (s.action === 'delete' && existsSync(target)) {
        const rescue = join(profileDir, `${s.f}.fk-rescue`)
        renameSync(target, rescue)
        rescued.push({ f: s.f, rescue })
      }
      done.push(s.f)
    }
    completed = true
  } catch (e) {
    // 反向撤销；任何撤销失败都保留救援副本，绝不能 finally 盲删。
    const rollbackErrors = []
    for (const r of rescued.reverse()) {
      const target = join(profileDir, r.f)
      try {
        if (existsSync(target)) rmSync(target, { force: true })
        if (existsSync(r.rescue)) renameSync(r.rescue, target)
        else rollbackErrors.push(`${r.f}: 救援副本不存在`)
      } catch (rollbackError) {
        rollbackErrors.push(`${r.f}: ${String(rollbackError?.message ?? rollbackError)}`)
      }
    }
    for (const s of staged) if (s.tmp) rmSync(s.tmp, { force: true })
    throw new Error(
      `还原失败${rollbackErrors.length === 0 ? '，已撤销' : '，撤销也未完成'}：${e.message}`
      + (rollbackErrors.length === 0 ? '' : `；${rollbackErrors.join('；')}。救援副本已保留。`),
    )
  } finally {
    if (completed) {
      for (const r of rescued) rmSync(r.rescue, { force: true })
    }
    for (const s of staged) if (s.tmp) rmSync(s.tmp, { force: true })
  }

  // ④ 回滚后校验
  const verify = []
  let bytes = 0
  for (const f of SNAPSHOT_FILES) {
    const target = join(profileDir, f)
    const rec = meta.files[f]
    const now = sha256(target)
    let diskExists = true
    try { diskExists = lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink() } catch { diskExists = false }
    const ok = rec.exists ? (diskExists && now === rec.sha256) : !diskExists
    if (ok) bytes += rec.size ?? 0
    verify.push({ file: f, ok })
  }

  const failed = verify.filter((v) => !v.ok).map((v) => v.file)

  // ⑤ ⭐ 还原 Electron 运行时状态（2026-10-22 用户裁定：统一进快照）
  //
  // 状态部分失败不阻塞配置部分的结论，但会如实返回。
  // 调用方（CLI/GUI）据此提示「配置好了但状态没还原」这种情况。
  let estateResult = null
  if (opts.estate !== false && meta.estate?.included) {
    try {
      estateResult = restoreEstate(snap, opts.estateOpts ?? {})
    } catch (e) {
      estateResult = {
        ok: false, restored: [], bytes: 0, skipped: [],
        reason: String(e?.message ?? e),
      }
    }
    if (estateResult.ok) bytes += estateResult.bytes ?? 0
  } else if (meta.estate && meta.estate.included === false) {
    estateResult = {
      ok: false, restored: [], bytes: 0, skipped: [],
      reason: `这份快照没包含状态部分（${meta.estate.reason ?? '未知原因'}）`,
    }
  }

  return {
    restored: SNAPSHOT_FILES.filter((f) => !failed.includes(f)),
    failed,
    bytes,
    meta,
    estate: estateResult,
  }
}

// ─────────────────────────────────────────────────────────────
// 选取最佳快照（--last-good）
// ─────────────────────────────────────────────────────────────

/**
 * 选「最佳还原点」。
 *
 * 优先级（2026-10-20 按用户裁定调整）：
 *   ① 今天的 daily 快照        —— 设计意图：「.bat 默认走当天的启动配置」
 *   ② 最近一天的 daily 快照     —— 今天还没启动过时，用昨天的启动配置
 *   ③ verified-strong
 *   ④ verified
 *   ⑤ static-ok
 *   ⑥ failed
 *   ⑦ null
 *
 * ⚠️ 为什么 daily 优先于「健康等级」：
 *   旧实现只按健康等级+时间选，实测会选中「回滚前 15:29」这类
 *   before-restore 快照，而不是「每日快照 10:17」。
 *   但用户的设计意图是「恢复到今天开机时的样子」——
 *   那正是当天首启建的 daily 快照。
 *
 *   健康等级降级链保留，作为「没有 daily 可用」时的兜底。
 *
 * @returns {{entry: object, level: string, reason: string}|null}
 */
export function pickLastGood(root, home, profile, bootLog) {
  const idx = readIndex(root)
  const entries = (idx.entries ?? []).slice()

  const gradeOf = (e) => computeGrade(e, bootLog)
  const at = (lvl) => entries
    .filter((e) => gradeOf(e) === lvl)
    .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))

  // ── ①② daily 优先（含「今天」和「最近一天」两档）──
  //
  // ⚠️ 但必须排除【坏掉的】快照（health fatal/broken）：
  //    2026-10-20 实测发现，若无条件选 daily，会选中一份
  //    health=fatal 的坏快照 —— 还原它等于还原到坏配置。
  //    旧逻辑靠「健康降级链」天然避开了 broken，新逻辑必须显式排除。
  //
  // 用本地日期判断「今天」，而不是 UTC —— 用户在东八区，
  // 22:00 之后 UTC 还是「昨天」，会导致误判。
  const dailyEntries = entries
    .filter((e) => e.type === 'daily' && !['fatal', 'error', 'broken', 'unknown'].includes(healthOf(e)) && gradeOf(e) !== 'broken')
    .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))

  if (dailyEntries.length > 0) {
    const todayKey = localDateKey(new Date())
    const todayDaily = dailyEntries.find((e) => localDateKey(new Date(e.createdAtMs ?? 0)) === todayKey)
    if (todayDaily) {
      return {
        entry: todayDaily,
        level: 'today-daily',
        reason: `今天的启动快照（${localDateKey(new Date(todayDaily.createdAtMs ?? 0))}）`,
      }
    }
    // ② 最近一天的 daily
    return {
      entry: dailyEntries[0],
      level: 'latest-daily',
      reason: `最近一次的启动快照（${localDateKey(new Date(dailyEntries[0].createdAtMs ?? 0))}）`,
    }
  }

  // ── ③~⑥ 健康等级降级链（没有 daily 时的兜底）──
  let hit = at('verified-strong')
  if (hit.length) return { entry: hit[0], level: 'verified-strong', reason: '启动成功 ≥3 次且从未失败' }

  hit = at('verified')
  if (hit.length) return { entry: hit[0], level: 'verified', reason: '启动成功过' }

  hit = at('static-ok')
  if (hit.length) return { entry: hit[0], level: 'static-ok', reason: '静态体检通过，尚无启动验证' }

  hit = at('failed')
  if (hit.length) return { entry: hit[0], level: 'failed', reason: '曾启动失败过' }

  // ⑦ 全 broken / 无
  return null
}

/**
 * 本地日期键（YYYY-MM-DD），用于判断「是不是今天」。
 *
 * ⚠️ 不能用 toISOString().slice(0,10)：那是 UTC 日期，
 *    东八区 00:00-08:00 之间会得到前一天，导致「今天的 daily」判断失败。
 *
 * @param {Date} d
 * @returns {string}
 */
export function localDateKey(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 算某个快照的健康等级（按指纹查 boot-log）。 */
export function computeGrade(entry, bootLog) {
  const health = healthOf(entry)
  if (health === 'fatal' || health === 'error' || health === 'broken') return 'broken'
  if (health === 'unknown') return 'static-ok'
  const recs = (bootLog?.records ?? []).filter((r) => r.fingerprint === entry.fingerprint)
  const ok = recs.filter((r) => r.result === 'ok').length
  const fail = recs.filter((r) => r.result === 'fail').length
  if (ok >= 3 && fail === 0) return 'verified-strong'
  if (ok >= 1 && fail === 0) return 'verified'
  if (fail > 0) return 'failed'
  return 'static-ok'
}

// ─────────────────────────────────────────────────────────────
// boot-log（启动记录，按指纹记）
// ─────────────────────────────────────────────────────────────

/** 读 boot-log.jsonl。 */
export function readBootLog(root) {
  const p = join(root, 'boot-log.jsonl')
  if (!existsSync(p)) return { records: [] }
  const records = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  return { records }
}

/** 追加一条启动记录。 */
export function appendBootLog(root, record) {
  const p = join(root, 'boot-log.jsonl')
  mkdirSync(dirname(p), { recursive: true })
  try {
    writeFileSync(p, `${JSON.stringify(record)}\n`, { flag: 'a' })
  } catch { /* 写失败不影响主流程 */ }
}
