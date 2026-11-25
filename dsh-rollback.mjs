#!/usr/bin/env node
/**
 * FK 回滚插件 · 模块二~六：命令行入口
 *
 * @version 1.6.0
 */
/**
 * FK 回滚设置 —— 命令行脚本（模块六）
 *
 * 纯 Node，零第三方依赖。DSH 崩了也能跑，这是最后的兜底手段。
 *
 * 用法：
 *   node dsh-rollback.mjs <command> [options]
 *
 * ⚠️ 如果 PATH 里没有 node，用 DSH 自带的运行时：
 *     <DSH安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
 *   或者直接双击同目录的 `还原DSH配置.bat`（会自动探测）。
 *
 * @module dsh-fk-rollback/dsh-rollback
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import * as C from './lib/core.mjs'
import { runCheck, computeEffectivePlugins, listDshPackages, parsePatchSubset, parseProxyValue, isPortListeningSync } from './lib/check.mjs'
import { traceFile, listSessionSummaries } from './lib/trace.mjs'
import * as E from './lib/estate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** DSH 版本：显式参数/环境变量优先，否则读取实际安装包。 */
function detectDshVersion(explicit, home) {
  if (typeof explicit === 'string' && explicit) return explicit
  if (typeof process.env.DSH_VERSION === 'string' && process.env.DSH_VERSION) return process.env.DSH_VERSION
  try {
    const require = createRequire(import.meta.url)
    const manifest = require('@deepseek-ai/dsh/package.json')
    if (manifest?.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string' && manifest.version) return manifest.version
  } catch { /* 独立脚本环境没有可解析的安装包，继续查 manifest */ }
  const candidates = []
  if (process.env.DSH_INSTALL_DIR) candidates.push(process.env.DSH_INSTALL_DIR)
  if (process.env.DSH_NODE_EXECUTABLE) {
    try {
      const exeDir = dirname(process.env.DSH_NODE_EXECUTABLE)
      candidates.push(join(exeDir, '..', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'))
      candidates.push(join(exeDir, '..', '..', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'))
    } catch { /* 忽略 */ }
  }
  if (home) {
    candidates.push(join(home, 'dsh-runtimes', 'dsh-primary-runtime'))
    candidates.push(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', '@deepseek-ai', 'dsh'))
  }
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string' && pkg.version) return pkg.version
    } catch { /* 尝试下一个已验证候选 */ }
  }
  return null
}

// ─────────────────────────────────────────────────────────────
// 参数解析（手写，零依赖）
// ─────────────────────────────────────────────────────────────

const GLOBAL_FLAGS = new Set(['help', 'h', 'version', 'v', 'json', 'verbose', 'dry-run', 'force', 'home-layer'])
const GLOBAL_VALUES = new Set(['home', 'profile', 'dsh-version'])
const VALUE_OPTIONS = new Set([
  'home', 'profile', 'dsh-version', 'name', 'note', 'origin', 'slot',
  'backup-to', 'app-data', 'days', 'tail',
])
const FLAG_OPTIONS = new Set([
  'help', 'h', 'version', 'v', 'json', 'verbose', 'dry-run', 'force',
  'unpin', 'show', 'clear', 'pin', 'restore', 'fix', 'clean-cookies',
  'reset', 'daily', 'last-good', 'from-pool', 'home-layer',
])
const COMMAND_OPTIONS = {
  list: [],
  show: [],
  status: [],
  check: ['json', 'verbose', 'home-layer'],
  diagnose: ['json', 'verbose'],
  snapshot: ['daily', 'name', 'note', 'origin'],
  proxy: ['fix', 'restore', 'dry-run'],
  core: ['dry-run', 'force', 'backup-to'],
  estate: ['clean-cookies', 'reset', 'dry-run', 'force', 'app-data'],
  restore: ['last-good', 'from-pool', 'dry-run'],
  trace: ['days'],
  sessions: ['days'],
  prune: ['dry-run'],
  fix: ['unpin', 'show', 'clear', 'pin', 'slot'],
  paths: [],
  oplog: ['tail'],
}
const POSITIONAL_LIMITS = { show: 1, fix: 1, restore: 1, trace: 1 }
const ORIGINS = new Set(['auto', 'ai', 'user'])

function positiveInteger(value, name) {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) die(C.EXIT.ARGS, `${name} 必须是正整数`)
  return n
}

function parseArgs(argv) {
  const opts = { _: [] }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      opts._.push(...argv.slice(i + 1))
      break
    }
    if (!a.startsWith('--')) {
      opts._.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const key = a.slice(2, eq < 0 ? undefined : eq)
    if (!key || !FLAG_OPTIONS.has(key) && !VALUE_OPTIONS.has(key)) {
      die(C.EXIT.ARGS, `未知选项：--${key || a.slice(2)}`)
    }
    if (seen.has(key)) die(C.EXIT.ARGS, `选项重复：--${key}`)
    seen.add(key)

    if (FLAG_OPTIONS.has(key)) {
      if (eq >= 0) die(C.EXIT.ARGS, `--${key} 不接受值`)
      opts[key] = true
      continue
    }

    let value
    if (eq >= 0) value = a.slice(eq + 1)
    else {
      value = argv[i + 1]
      if (value === undefined || value === '--' || value.startsWith('--')) {
        die(C.EXIT.ARGS, `--${key} 缺少值`)
      }
      i += 1
    }
    if (value === '') die(C.EXIT.ARGS, `--${key} 缺少值`)
    opts[key] = value
  }

  const setFlag = (...keys) => keys.filter((key) => opts[key] === true)
  const countFlags = (...keys) => setFlag(...keys).length
  if (opts.help || opts.h || opts.version || opts.v) {
    if (opts._.length > 0 || seen.size > setFlag('help', 'h', 'version', 'v').length) {
      die(C.EXIT.ARGS, '--help/--version 不能与命令或其他选项一起使用')
    }
    return opts
  }
  if (opts._.length === 0) die(C.EXIT.ARGS, '缺少命令；用 --help 查看可用命令')
  const cmd = opts._[0]
  if (!Object.prototype.hasOwnProperty.call(COMMAND_OPTIONS, cmd)) {
    die(C.EXIT.ARGS, `未知命令：${cmd}`)
  }
  const allowed = new Set([...GLOBAL_FLAGS, ...GLOBAL_VALUES, ...COMMAND_OPTIONS[cmd]])
  for (const key of seen) {
    if (!allowed.has(key)) die(C.EXIT.ARGS, `命令 ${cmd} 不接受 --${key}`)
  }

  const limit = POSITIONAL_LIMITS[cmd] ?? 0
  if (opts._.length - 1 > limit) die(C.EXIT.ARGS, `命令 ${cmd} 的位置参数过多`)
  if ((cmd === 'show' || cmd === 'fix') && opts._.length < 2 && !setFlag('show', 'clear', 'unpin', 'pin').length) {
    die(C.EXIT.ARGS, `${cmd} 需要快照 ID`)
  }
  if (cmd === 'restore') {
    const selectors = countFlags('last-good', 'from-pool') + (opts._.length > 1 ? 1 : 0)
    if (selectors > 1) die(C.EXIT.ARGS, 'restore 的快照 ID、--last-good、--from-pool 只能选一个')
    if (opts['last-good'] && opts['from-pool']) die(C.EXIT.ARGS, '--last-good 与 --from-pool 不能同时使用')
  }
  const actions = (names) => countFlags(...names)
  if (cmd === 'proxy' && actions(['fix', 'restore']) > 1) die(C.EXIT.ARGS, 'proxy 的 --fix 与 --restore 不能同时使用')
  if (cmd === 'proxy' && opts['dry-run'] && !opts.fix) die(C.EXIT.ARGS, 'proxy --dry-run 需要配合 --fix')
  if (cmd === 'estate' && actions(['clean-cookies', 'reset']) > 1) die(C.EXIT.ARGS, 'estate 的 --clean-cookies 与 --reset 不能同时使用')
  if (cmd === 'check' && opts['home-layer'] && (opts.json || opts.verbose)) {
    die(C.EXIT.ARGS, 'check --home-layer 不能与 --json/--verbose 一起使用')
  }
  if (cmd === 'fix' && actions(['unpin', 'show', 'clear']) > 1) die(C.EXIT.ARGS, 'fix 的 --unpin/--show/--clear 只能选一个')
  if (cmd === 'fix' && opts.pin && actions(['unpin', 'show', 'clear']) > 0) die(C.EXIT.ARGS, 'fix --pin 不能与 --unpin/--show/--clear 一起使用')
  if (cmd === 'fix' && opts._.length > 1 && actions(['unpin', 'show', 'clear']) > 0) {
    die(C.EXIT.ARGS, 'fix 的 --unpin/--show/--clear 不能同时指定快照 ID')
  }
  if (opts.origin !== undefined && !ORIGINS.has(opts.origin)) {
    die(C.EXIT.ARGS, '--origin 只能是 auto、ai 或 user')
  }
  if (opts.days !== undefined) opts.days = positiveInteger(opts.days, '--days')
  if (opts.tail !== undefined) opts.tail = positiveInteger(opts.tail, '--tail')
  if (opts.profile !== undefined && (opts.profile === '.' || opts.profile === '..' || /[\\/]/.test(opts.profile))) {
    die(C.EXIT.ARGS, '--profile 必须是单个目录名')
  }
  if (opts.slot !== undefined && (opts.slot === '.' || opts.slot === '..' || /[\\/]/.test(opts.slot))) {
    die(C.EXIT.ARGS, '--slot 必须是单个目录名')
  }
  return opts
}

/** 解析上下文：home + profile。 */
function resolveCtx(opts) {
  const home = C.resolveHome(opts.home)
  const profile = opts.profile ?? process.env.DSH_PROFILE ?? C.pickRecentProfile(home) ?? 'desktop'
  const profileDir = join(home, 'profiles', profile)
  const root = C.snapshotDir(home, profile)
  return { home, profile, profileDir, root }
}

/** 统一出错处理。 */
function die(code, msg) {
  console.error(`\n  ✗ ${msg}\n`)
  process.exit(code)
}

// ─────────────────────────────────────────────────────────────
// 命令实现
// ─────────────────────────────────────────────────────────────


/** fix —— 固化某个快照，作为 .bat 紧急救场的固定数据源 */
function cmdFix(opts) {
  const { root } = resolveCtx(opts)
  const idx = C.readIndex(root)

  // --unpin：取消钉住，让启动钩子恢复自动跟随当天 daily
  if (opts.unpin) {
    const slot = opts.slot ?? C.FIXED_SLOT_DEFAULT
    const cur = C.readFixedSlot(root, slot)
    if (!cur) {
      die(C.EXIT.NO_SNAPSHOT, '当前没有固化副本，无需取消钉住')
    }
    const mp = join(C.fixedSlotDir(root, slot), 'meta.json')
    const meta = C.readJson(mp) ?? {}
    const was = meta.pin === true
    meta.pin = false
    // 保留 fixedBy 原值，只改 pin
    C.writeJsonAtomic(mp, meta)
    console.log('')
    if (was) {
      console.log(`  ✅ 已取消钉住：${meta.fromName}`)
      console.log('     下次 DSH 启动时会被当天的 daily 快照替换。')
    } else {
      console.log(`  ⓘ 这份副本本来就没钉住：${meta.fromName}`)
      console.log('     它会在下次启动时被当天 daily 替换。')
    }
    console.log('')
    return C.EXIT.OK
  }

  // --show：查看当前固化状态
  if (opts.show) {
    const slots = C.listFixedSlots(root)
    if (slots.length === 0) {
      console.log('\n  （当前没有固化任何快照）')
      console.log('  ⚠️ .bat 将无法工作 —— 它只使用固化副本，不读快照池。')
      console.log('     补救：① 重启 DSH（启动钩子会自动固化当天 daily）')
      console.log('           ② 或手动：dsh-rollback.mjs fix <快照ID>\n')
      return C.EXIT.OK
    }
    console.log('\n  已固化：')
    for (const s of slots) {
      const m = s.meta ?? {}
      const marker = s.slot === C.FIXED_SLOT_DEFAULT ? '  ← .bat 默认使用' : ''
      console.log(`\n  [${s.slot}]${marker}`)
      console.log(`    来源快照: ${m.fromName ?? '?'}（${m.fromId ?? '?'}）`)
      // ⭐ 2026-10-23：钉住状态决定下次启动会不会被当天 daily 替换
      if (m.pin === true) {
        console.log(`    钉住:     📌 是 —— 启动时不会自动替换`)
      } else {
        console.log(`    钉住:     🔄 否 —— 下次启动会被当天 daily 替换`)
      }
      if (m.replacedFrom?.fromName) {
        console.log(`    上次替换: ${m.replacedFrom.fromName}`)
      }
      console.log(`    快照时间: ${m.fromCreatedAt ? new Date(Date.parse(m.fromCreatedAt)).toLocaleString('zh-CN') : '?'}`)
      console.log(`    固化于:   ${m.fixedAt ? new Date(Date.parse(m.fixedAt)).toLocaleString('zh-CN') : '?'}`)
      console.log(`    大小:     ${Math.round((m.bytes ?? 0) / 1024)} KB`)
      console.log(`    完整性:   ${s.ok ? '✅ 5/5 齐全' : '⚠️ 缺文件（' + s.present.length + '/5）'}`)
      console.log(`    路径:     ${s.dir}`)
    }
    console.log('')
    return C.EXIT.OK
  }

  // --clear：取消固化
  if (opts.clear) {
    const r = C.unfixSlot(root, opts.slot)
    if (r.removed) console.log(`\n  ✅ 已取消固化（槽位：${opts.slot ?? C.FIXED_SLOT_DEFAULT}）`)
    else console.log('\n  ⓘ 该槽位本来就没有固化')
    console.log('  ⚠️ 现在 .bat 无法工作（它只使用固化副本）。')
    console.log('     下次 DSH 启动时会自动重新固化当天 daily。\n')
    return C.EXIT.OK
  }

  const id = opts._[0]
  if (!id) {
    const slot = opts.slot ?? C.FIXED_SLOT_DEFAULT
    const cur = C.readFixedSlot(root, slot)
    if (!cur) die(C.EXIT.NO_SNAPSHOT, '当前没有固化副本，无法设置钉住状态')
    const mp = join(C.fixedSlotDir(root, slot), 'meta.json')
    const meta = C.readJson(mp) ?? {}
    meta.pin = true
    C.writeJsonAtomic(mp, meta)
    console.log(`\n  📌 已钉住当前固化副本：${meta.fromName ?? cur.meta?.fromName ?? '?'}`)
    console.log('     启动时不会自动替换；取消：dsh-rollback.mjs fix --unpin\n')
    return C.EXIT.OK
  }

  const e = (idx.entries ?? []).find((x) => x.id === id)
  if (!e) die(C.EXIT.NO_SNAPSHOT, `找不到快照：${id}`)

  let r
  try {
    // ⭐ 2026-10-23：pin 决定这份副本是否"钉住"
    //   不钉住 → 下次启动会被当天的 daily 自动替换
    //   钉住   → 一直保留，除非手动 --unpin
    r = C.fixSnapshot({
      root, entry: e, slot: opts.slot,
      pin: Boolean(opts.pin),
    })
  } catch (err) {
    die(C.EXIT.NO_SNAPSHOT, err.message)
  }

  console.log(`\n  ✅ 已固化`)
  console.log(`     来源快照: ${r.fromName}`)
  console.log(`     槽位:     ${r.slot}${r.slot === C.FIXED_SLOT_DEFAULT ? '（.bat 默认使用）' : ''}`)
  const cfgFiles = Math.min(r.files, C.SNAPSHOT_FILES.length)
  console.log(`     配置:     ${cfgFiles}/5 个文件`)
  if (r.estateCopied) {
    console.log(`     状态:     ✅ 已包含（cookie / LevelDB，${Math.round(r.estateBytes / 1024)} KB）`)
  } else {
    console.log(`     状态:     ⚠️ 这份快照没有状态部分 —— .bat 只能还原配置`)
  }
  console.log(`     合计:     ${Math.round(r.bytes / 1024)} KB`)
  console.log(`     路径:     ${r.dir}`)
  console.log('')
  if (opts.pin) {
    console.log('  📌 已钉住 —— .bat 会一直用这一份，启动钩子不会替换。')
    console.log('     取消钉住：dsh-rollback.mjs fix --unpin')
  } else {
    console.log('  🔄 未钉住 —— 下次 DSH 启动时，会把当天的 daily 快照固化过来替换它。')
    console.log('     想固定这一份：dsh-rollback.mjs fix ' + e.id + ' --pin')
  }
  console.log('')
  console.log('  ⚠️ 从此 .bat 直接使用这份固定副本：')
  console.log('     · 快照池怎么顶替都不会影响它')
  console.log('     · 只有执行 `fix --clear` 才会取消')
  console.log('')
  return C.EXIT.OK
}


/**
 * estate —— Electron 运行时状态体检 / 重置
 *
 * ⚠️ 为什么有这个命令（2026-10-22 事故）：
 *   认证状态库（Cookies / shared_proto_db）被强杀进程写坏后，
 *   DSH 报「Web authentication failed」，完全起不来。
 *   而快照还原只覆盖 5 个配置文件，救不了这类故障。
 *
 * 用法：
 *   estate                 只检查（只读，安全）
 *   estate --reset         重置（需先完全退出 DSH）
 *   estate --reset --dry-run  预演
 *   estate --reset --force 跳过进程检查（不推荐）
 */
/**
 * core —— 隔离内核核心包副本（2026-11-04 事故的自动修复）
 *
 * 为什么单独一个命令：
 *   这类问题【回滚救不了】（快照不含 node_modules），
 *   必须有人真的把那些目录移走。之前 FK 只报不修，用户以为无解。
 */
/**
 * proxy —— 诊断并修复代理环境变量（2026-11-14 事故）
 *
 * 三个动作：
 *   proxy            看当前用户级代理变量 + 端口是否活着
 *   proxy --fix      删掉指向失效代理的变量（先备份）
 *   proxy --restore  从备份恢复
 */
async function cmdProxy(opts) {
  const { home } = resolveCtx(opts)

  console.log('')
  console.log('  代理环境变量诊断' + (opts.fix ? '【修复】' : opts.restore ? '【恢复】' : ''))
  console.log('  ' + '-'.repeat(62))

  // ── 恢复 ──
  if (opts.restore) {
    const r = E.restoreUserProxyEnv({ home })
    if (!r.ok && r.restored.length === 0) {
      console.log('')
      console.log(`  ⚠️ ${r.reason ?? '恢复失败'}`)
      console.log('')
      return C.EXIT.ARGS
    }
    console.log('')
    console.log('  已恢复：')
    for (const x of r.restored) console.log(`    ✓ ${x.key} = ${x.value}`)
    console.log('')
    console.log(`  来源：${r.backupPath}`)
    console.log('')
    console.log('  ⚠️ 记得【完全重启 DSH】才会生效。')
    console.log('')
    return r.ok ? C.EXIT.OK : C.EXIT.PARTIAL
  }

  // ── 读现状 ──
  const cur = E.getUserProxyEnv()
  if (!cur.ok) {
    console.log('')
    console.log(`  ⚠️ 读不到用户级环境变量：${cur.error ?? ''}`)
    console.log('')
    return C.EXIT.GENERAL
  }

  const names = Object.keys(cur.values)
  if (names.length === 0) {
    console.log('')
    console.log('  ✅ 当前用户没有任何代理环境变量（干净状态）')
    console.log('')
    console.log('     ⓘ 如果你还是遇到「所有模型都报 transport failed」，')
    console.log('       那原因不在这里，请跑 dsh-rollback check 看其它项。')
    console.log('')
    return C.EXIT.OK
  }

  console.log('')
  console.log('  用户级（注册表 HKCU\\Environment）代理变量：')
  // 按 host:port 归并
  const groups = new Map()
  for (const [k, v] of Object.entries(cur.values)) {
    const p = parseProxyValue(v)
    const id = p.valid ? `${p.host}:${p.port}` : `(无法解析) ${v}`
    if (!groups.has(id)) groups.set(id, { keys: [], parsed: p })
    groups.get(id).keys.push(k)
  }

  let deadCount = 0
  const deadKeys = []
  for (const [id, g] of groups) {
    let status
    if (g.parsed.valid) {
      const isLocal = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(g.parsed.host).toLowerCase())
      if (isLocal) {
        const probe = isPortListeningSync(g.parsed.port)
        if (probe.listening) {
          status = '✅ 代理在运行'
        } else {
          status = '❌ 代理没有运行 ← 这就是故障原因'
          deadCount += 1
          deadKeys.push(...g.keys)
        }
      } else {
        status = 'ⓘ 远程代理，不做探活'
      }
    } else {
      status = '⚠️ 无法解析这个值'
    }
    console.log('')
    console.log(`    ${g.keys.join(' / ')}`)
    console.log(`      值：${cur.values[g.keys[0]]}`)
    console.log(`      状态：${status}`)
  }

  console.log('')

  if (deadCount === 0) {
    console.log('  ✅ 所有本机代理端口都在正常运行')
    console.log('')
    return C.EXIT.OK
  }

  // ── 有死的 ──
  console.log('  ⚠️ 有代理变量指向没有运行的端口。')
  console.log('     这会让 DSH 0.2.2 的所有模型统一报 "DeepSeek Messages transport failed"。')
  console.log('')

  if (!opts.fix) {
    console.log('     两个选择：')
    console.log('       A. 启动代理软件（如果确实需要代理）')
    console.log(`       B. 删掉这些变量：dsh-rollback proxy --fix`)
    console.log('')
    console.log('     ⓘ 加 --dry-run 可以先看会删什么，不动手。')
    console.log('')
    return C.EXIT.NO_SNAPSHOT
  }

  // ── 执行修复 ──
  const r = E.clearUserProxyEnv({
    home,
    keys: deadKeys,
    dryRun: Boolean(opts['dry-run']),
  })

  if (r.dryRun) {
    console.log('  【预演】将删除：')
    for (const x of r.removed) console.log(`    · ${x.key} = ${x.value}`)
    console.log('')
    console.log('  ⚠️ 这是预演，未做任何修改。去掉 --dry-run 才会真的删。')
    console.log('')
    return C.EXIT.OK
  }

  if (r.reason && r.removed.length === 0 && r.failed.length === 0) {
    console.log(`  ⓘ ${r.reason}`)
    console.log('')
    return C.EXIT.OK
  }

  console.log('  已删除：')
  for (const x of r.removed) console.log(`    ✓ ${x.key}（原值：${x.value}）`)
  if (r.failed.length > 0) {
    console.log('')
    console.log('  失败：')
    for (const f of r.failed) console.log(`    ✗ ${f.key}：${f.reason}`)
  }
  console.log('')
  console.log('  备份（原值已存，可反悔）：')
  console.log(`    ${r.backupPath}`)
  console.log('')
  console.log('  ⚠️ 必须【完全退出 DSH 再启动】才会生效 ——')
  console.log('     环境变量在进程启动时读取，已运行的进程不会重新读。')
  console.log('')
  console.log('  反悔：dsh-rollback proxy --restore')
  console.log('')

  return r.ok ? C.EXIT.OK : C.EXIT.PARTIAL
}

async function cmdCore(opts) {
  const { home, profile } = resolveCtx(opts)
  const dryRun = Boolean(opts['dry-run'])

  console.log('')
  console.log('  内核核心包副本隔离' + (dryRun ? '【预演】' : ''))
  console.log('  ' + '-'.repeat(62))
  console.log(`  DSH_HOME : ${home}`)
  console.log(`  profile  : ${profile}`)
  console.log(`  目标目录 : ${join(home, 'profiles', profile, 'node_modules', '@deepseek-ai')}`)
  console.log('')

  // 先在运行的检查（quarantineCoreCopies 内部也会查，这里先展示给用户）
  if (!dryRun && !opts.force) {
    const run = E.isAppRunning()
    console.log(`  DSH 进程：${run.reason}`)
    if (run.running) {
      console.log('')
      die(C.EXIT.ARGS,
        'DSH 还在运行 —— node_modules 里的文件可能被占用，移动会失败。\n'
        + '    请先【完全退出 DSH】（关窗口 + 确认托盘图标消失），再跑这条命令。')
    }
    console.log('')
  }

  const r = E.quarantineCoreCopies({
    home, profile,
    dryRun,
    force: Boolean(opts.force),
    ...(typeof opts['backup-to'] === 'string' ? { backupTo: opts['backup-to'] } : {}),
  })

  if (!r.ok && r.reason) {
    // 没找到副本不算错误
    if (r.moved.length === 0 && r.failed.length === 0) {
      console.log(`  ⓘ ${r.reason}`)
      console.log('')
      return C.EXIT.OK
    }
    die(C.EXIT.ARGS, r.reason)
  }

  if (dryRun) {
    if (r.moved.length === 0) {
      console.log('  ✅ 没有需要隔离的副本（已经是干净状态）')
      console.log('')
      return C.EXIT.OK
    }
    console.log(`  将隔离 ${r.moved.length} 个核心包副本：`)
    for (const m of r.moved) console.log(`    · @deepseek-ai/${m.name}`)
    console.log('')
    console.log('  ⚠️ 这是预演，未做任何修改。去掉 --dry-run 才会真正移动。')
    console.log('')
    return C.EXIT.OK
  }

  if (r.moved.length === 0) {
    console.log(`  ✅ ${r.reason ?? '没有需要隔离的副本'}`)
    if (r.notFound.length > 0) {
      console.log(`     （未找到：${r.notFound.join(', ')} —— 正常）`)
    }
    console.log('')
    return C.EXIT.OK
  }

  console.log('  已隔离：')
  for (const m of r.moved) {
    console.log(`    ✓ @deepseek-ai/${m.name}`)
  }
  if (r.emptyDirMoved) {
    console.log('    ✓ node_modules/@deepseek-ai（空目录，一并移走）')
  }
  console.log('')
  console.log('  备份位置（移动，不是删除 —— 便于排查和反悔）：')
  console.log(`    ${r.backupRoot}`)
  console.log('')
  if (r.failed.length > 0) {
    console.log('  ⚠️ 有失败项：')
    for (const f of r.failed) console.log(`    ✗ @deepseek-ai/${f.name}：${f.reason}`)
    console.log('')
  }
  console.log('  ✅ 完成。现在启动 DSH，然后跑一次确认：')
  console.log('     dsh-rollback check')
  console.log('')
  console.log('  ⓘ 为什么要移走这几个包：')
  console.log('    它们与内核自带的同名包形成两套模块实例，')
  console.log('    导致 dsh-scope 的作用域判断失效（按对象身份 ===，两份实例认不出彼此）')
  console.log('    → 所有 Agent 预设报 prompt section is already registered')
  console.log('    → 新建会话、恢复会话全部失败。')
  console.log('')
  console.log('  ⓘ cosmokit / schemastery 不在此列 —— 它们用 Symbol.for 做跨实例识别，')
  console.log('    多一份无害，可以保留。')
  console.log('')
  return r.failed.length > 0 ? C.EXIT.PARTIAL : C.EXIT.OK
}

async function cmdEstate(opts) {
  // parseArgs 不转换驼峰，所以 --app-data 会落在 opts['app-data'] 上。
  // 统一成一个变量，供下面的检查与清理共用。
  const appDataOpt = opts.appData ?? opts['app-data']

  // ── 清理认证 Cookie（v1.5.2 新增）──
  //
  // 对应 2026-10-26 事故：
  //   DSH 每次启动用 sha256(host:端口) 生成 cookie 名，旧的不清理，
  //   累积 71 个后请求头 16,584 B > Node 上限 16,384
  //   → HPE_HEADER_OVERFLOW → "Web authentication failed" 起不来。
  if (opts['clean-cookies']) {
    const dryRun = Boolean(opts['dry-run'])
    const { root } = resolveCtx(opts)

    console.log('')
    console.log('  清理累积的认证 Cookie' + (dryRun ? '【预演】' : ''))
    console.log('  ' + '-'.repeat(62))

    // 前置：进程检查（cleanAuthCookies 内部也会查，这里先展示给用户看）
    if (!dryRun && !opts.force) {
      const run = E.isAppRunning()
      console.log(`  DSH 进程：${run.reason}`)
      if (run.running) {
        console.log('')
        die(C.EXIT.ARGS,
          'DSH 还在运行 —— Cookies 库被 Chromium 独占锁定，删不掉。\n'
          + '    请先【完全退出 DSH】（关窗口 + 确认托盘图标消失），再跑这条命令。')
      }
      console.log('')
    }

    // 备份放到快照根下，用户容易找到（而不是系统临时目录）
    const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 15)
    const backupDir = join(root, 'cookie-backups', stamp)

    const r = await E.cleanAuthCookies({
      dryRun,
      force: Boolean(opts.force),
      backupDir: dryRun ? undefined : backupDir,
      ...appDataOpt ? { appData: appDataOpt } : {},
    })

    if (!r.ok && r.reason) die(C.EXIT.ARGS, r.reason)

    if (dryRun) {
      if (r.removed === 0 && r.wouldRemove === undefined) {
        console.log(`  ⓘ ${r.reason ?? '没有需要清理的 cookie'}`)
        console.log('')
        return C.EXIT.OK
      }
      console.log(`  库内 cookie：${r.totalBefore}`)
      console.log(`  待删 dsh-auth-*：${r.wouldRemove}`)
      console.log('')
      console.log('  ⚠️ 这是预演，未做任何修改。去掉 --dry-run 才会真正删除。')
      console.log('')
      return C.EXIT.OK
    }

    if (r.removed === 0) {
      console.log(`  ⓘ ${r.reason ?? '没有需要清理的 cookie'}`)
      if (r.totalBefore !== undefined) {
        console.log(`     库内共 ${r.totalBefore} 个 cookie，但没有累积的 dsh-auth-*`)
      }
      console.log('')
      return C.EXIT.OK
    }

    console.log('  已删除：')
    console.log(`    ✓ ${r.removed} 个 dsh-auth-* cookie`)
    if (r.after !== null && r.after !== undefined) {
      console.log(`    ✓ 剩余 dsh-auth-*：${r.after} 个`)
    }
    if (r.journalRemoved) {
      console.log('    ✓ Cookies-journal 已清理')
    } else if (r.journalExistedBefore) {
      console.log('    ⓘ Cookies-journal 由 SQLite 自行清理（正常）')
    }
    console.log('')
    console.log('  备份：')
    console.log(`    ${r.backupPath}`)
    console.log('')
    console.log('  ✅ 完成。现在启动 DSH 即可。')
    console.log('  ⓘ 账号不受影响 —— 登录凭据在 $DSH_HOME/.credentials.yaml，')
    console.log('    不在 Cookie 里。下次启动会自动签发新的认证 Cookie。')
    console.log('')
    return C.EXIT.OK
  }

  // ── 重置模式（最后手段：备份也没有时才用）──
  if (opts.reset) {
    const dryRun = Boolean(opts['dry-run'])
    console.log('')
    console.log('  Electron 运行时状态重置' + (dryRun ? '【预演】' : ''))
    console.log('  ' + '-'.repeat(62))

    if (!dryRun && !opts.force) {
      const run = E.isAppRunning()
      console.log(`  DSH 进程：${run.reason}`)
      if (run.running) {
        console.log('')
        die(C.EXIT.ARGS,
          'DSH 还在运行 —— 状态文件被占用，删不掉。\n'
          + '    请先【完全退出 DSH】，再跑这条命令。\n'
          + '    ⚠️ 不要加 --force 硬来，那会留下半删状态的库，比现在更糟。')
      }
      console.log('')
    }

    const r = E.resetEstate({
      dryRun,
      force: Boolean(opts.force),
      ...appDataOpt ? { appData: appDataOpt } : {},
    })
    if (!r.ok && r.reason) die(C.EXIT.ARGS, r.reason)

    if (dryRun) {
      console.log('  将要处理的条目：')
      for (const x of r.removed) {
        console.log(`    · ${x.path}`)
        console.log(`      ${x.what}`)
      }
      console.log('')
      console.log('  ⚠️ 这是预演，未做任何修改。')
      console.log('')
      return C.EXIT.OK
    }

    console.log(`  备份目录：${r.backupDir}`)
    console.log('')
    if (r.removed.length > 0) {
      console.log('  已重置：')
      for (const x of r.removed) {
        console.log(`    ✓ ${x.path}  (${Math.round((x.bytes ?? 0) / 1024)} KB)`)
      }
    }
    if (r.failed.length > 0) {
      console.log('')
      console.log('  ❌ 失败：')
      for (const x of r.failed) console.log(`    ${x.path}  ${x.reason}`)
      return C.EXIT.NO_SNAPSHOT
    }

    console.log('')
    console.log('  ✅ 完成。重新打开 DSH 会重建这些状态。')
    console.log('  ⚠️ 浏览器会话凭据已重置（不影响账号登录态 —— 账号信息在 .credentials.yaml 里）')
    console.log('')
    return C.EXIT.OK
  }

  // ── 检查模式（默认，只读）──
  let cookieNeedsClean = false
  const chk = E.checkEstate(appDataOpt ? { appData: appDataOpt } : {})

  console.log('')
  console.log('  Electron 运行时状态体检')
  console.log('  ' + '-'.repeat(62))

  if (!chk.ok) {
    console.log(`  ⚠️ ${chk.reason}`)
    if (chk.candidates) {
      console.log('  试过这些位置：')
      for (const c of chk.candidates) console.log(`    ${c}`)
    }
    console.log('')
    console.log('  （这不是问题 —— 可能你还没启动过桌面版 DSH）')
    console.log('')
    return C.EXIT.OK
  }

  const run = E.isAppRunning()
  console.log(`  目录：${chk.dir}`)
  console.log(`  DSH：${run.reason}`)
  console.log('')

  if (chk.problems.length === 0 && chk.notices.length === 0) {
    console.log('  ✅ 认证与状态库看起来正常')
  }
  if (chk.problems.length > 0) {
    console.log('  ❌ 致命问题（会导致 DSH 起不来且找不到原因）：')
    for (const p of chk.problems) {
      console.log(`    · ${p.path}`)
      console.log(`      ${p.message}`)
    }
    console.log('')
  }
  if (chk.notices.length > 0) {
    console.log('  ⓘ 提示（一般不影响使用）：')
    for (const p of chk.notices) console.log(`    · ${p.path}  —  ${p.message}`)
    console.log('')
  }

  console.log('  条目明细：')
  for (const it of chk.items) {
    const flag = it.suspicious ? ' ⚠️' : ''
    const sz = it.present ? (it.size === null ? '[目录]' : `${it.size} B`) : '不存在'
    console.log(`    ${String(it.rel).padEnd(32)} ${sz.padEnd(12)}${flag}`)
  }
  console.log('')

  // ── 认证 Cookie 累积检测（v1.5.2 新增）──
  //
  // 2026-10-26 事故：DSH 每次启动用 sha256(host:端口) 生成 cookie 名，
  // 端口动态变化 → 每次新增一个 → 累积 71 个后请求头超 16 KB → 起不来。
  const ck = await E.checkAuthCookies(appDataOpt ? { appData: appDataOpt } : {})

  console.log('  ── 认证 Cookie 累积 ──')

  if (!ck.readable) {
    // 读不到：多半是 DSH 在运行（Chromium 独占锁定）
    console.log(`    ⓘ ${ck.reason ?? '内容读不到'}`)
    if (ck.running) {
      console.log('      这是正常的 —— Cookies 库运行时被 Chromium 独占。')
      console.log('      如需检查累积情况，请完全退出 DSH 后重跑本命令。')
    }

    // ⭐ 用「基线 + 启动次数」给一个估算值，否则用户完全看不到数量概念
    try {
      const { root } = resolveCtx(opts)
      const bootLog = C.readBootLog(root)
      const boots = (bootLog.records ?? []).length
      const est = E.estimateAuthCookies(root, boots)
      if (est) {
        const ratio = (est.count * 228) / E.COOKIE_BUDGET
        const pct = (ratio * 100).toFixed(0)
        const icon = ratio >= 1 ? '🔴' : ratio >= 0.95 ? '⚠️' : ratio >= 0.85 ? 'ⓘ' : '✅'
        console.log('')
        console.log(`    ${icon} 估算 ${est.count} 个（占上限约 ${pct}%）`)
        console.log(`       自 ${new Date(Date.parse(est.baselineAt)).toLocaleString('zh-CN', { hour12: false })} 清理后`)
        console.log(`       已启动 ${est.bootsSince} 次 · 每次启动 +1 个`)
        if (ratio >= 0.85) {
          console.log('       ⚠️ 接近上限，建议尽快清理')
        }
      } else {
        console.log('')
        console.log('    ⓘ 没有清理基线，无法估算数量')
        console.log('      跑一次 dsh-rollback estate --clean-cookies 后会建立基线')
      }
    } catch { /* 估算失败不影响主流程 */ }
  } else if (ck.cookies) {
    const c = ck.cookies
    const pct = (c.ratio * 100).toFixed(1)

    if (c.level === 'normal') {
      console.log(`    ✅ ${c.auth} 个 dsh-auth-*（请求头 ${c.headerBytes} B / 上限 ${c.budget} B，占 ${pct}%）`)
    } else {
      const icon = c.level === 'fatal' ? '🔴' : c.level === 'error' ? '⚠️' : 'ⓘ'
      const verdict = c.level === 'fatal'
        ? '已达上限 —— 这就是 DSH 起不来的原因'
        : c.level === 'error'
          ? '接近上限 —— 再重启几次就会起不来'
          : '开始累积 —— 建议清理'
      console.log(`    ${icon} ${c.auth} 个 dsh-auth-*（请求头 ${c.headerBytes} B / 上限 ${c.budget} B，占 ${pct}%）`)
      console.log(`       ${verdict}`)
      if (c.ports.length > 1) {
        console.log(`       涉及 ${c.ports.length} 个不同端口（每次启动换一个端口 → 多一个 cookie）`)
      }
      if (c.oldest && c.newest) {
        const d = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
        console.log(`       最早 ${d(c.oldest)}  →  最晚 ${d(c.newest)}`)
      }
      console.log('')
      console.log('       修复：完全退出 DSH，然后运行')
      console.log('         dsh-rollback estate --clean-cookies')
      console.log('       或直接双击插件目录里的「清除旧Cookies.bat」')
      cookieNeedsClean = c.level !== 'normal'
    }
  }
  console.log('')

  if (chk.problems.length > 0) {
    // ⚠️ 有些问题【回滚救不了】—— 必须分开说，否则用户会白试一遍。
    //
    //   2026-11-04 事故：node_modules 里的核心包副本导致所有预设 broken。
    //   用户试了回滚，发现无效 —— 因为快照根本不含 node_modules。
    const coreDup = chk.problems.filter((x) => x.code === 'core-package-duplicate')
    const others = chk.problems.filter((x) => x.code !== 'core-package-duplicate')

    if (coreDup.length > 0) {
      console.log('  👉 内核核心包副本 —— 这个问题【回滚救不了】')
      console.log('')
      console.log('     原因：快照只备份 5 个配置文件 + Electron 状态，')
      console.log('           不包含 node_modules（设计如此：它本可由 lockfile 重建）。')
      console.log('           但核心包副本不在 lockfile 里，pnpm 既不重建也不清理它。')
      console.log('')
      console.log('     正确做法（移动，不要删除，便于排查）：')
      console.log('       1. 完全退出 DSH')
      console.log('       2. 新建备份目录，例如：')
      console.log('          mkdir "<DSH_HOME>\_backup-core-copy-<日期>"')
      console.log('       3. 把这些目录移进去：')
      for (const p of coreDup) {
        const pkgs = Array.isArray(p.packages) ? p.packages : []
        for (const name of pkgs) {
          console.log(`          node_modules\\@deepseek-ai\\${name}`)
        }
      }
      console.log('       4. 启动 DSH，再跑一次 dsh-rollback check 确认')
      console.log('')
      console.log('     ⚠️ 注意：cosmokit / schemastery 是纯工具库，')
      console.log('        有些插件依赖它们，可以保留（只报警告，不致命）。')
      console.log('')
    }

    if (others.length > 0) {
      console.log('  👉 其余问题 —— 状态已包含在快照里，直接还原即可：')
      console.log('       1. 完全退出 DSH')
      console.log('       2. dsh-rollback list                # 看有哪些快照')
      console.log('       3. dsh-rollback restore <快照id>    # 配置 + 状态一起还原')
      console.log('')
      console.log('     如果所有快照都没有状态部分，只能重置（会清掉浏览器会话凭据）：')
      console.log('       dsh-rollback estate --reset')
      console.log('')
    }

    return C.EXIT.NO_SNAPSHOT
  }

  if (cookieNeedsClean) {
    console.log('  ⚠️ 认证 Cookie 需要清理（见上）。')
    console.log('')
    return C.EXIT.NO_SNAPSHOT
  }

  console.log('  💡 状态已自动包含在快照里，用 snapshot 备份、restore 还原。')
  console.log('')
  return C.EXIT.OK
}

/** paths —— 显示所有关键路径 */
function cmdPaths(opts) {
  const { home, profile, profileDir, root } = resolveCtx(opts)
  const HERE = dirname(fileURLToPath(import.meta.url))
  const fixed = C.readFixedSlot(root)

  console.log('\n  FK 回滚插件 · 路径一览')
  console.log('  ' + '-'.repeat(62))
  console.log(`  DSH_HOME      ${home}`)
  console.log(`  profile       ${profile}`)
  console.log(`  profile 目录  ${profileDir}`)
  console.log('')
  console.log(`  快照根        ${root}`)
  console.log(`    daily       ${join(root, 'daily')}`)
  console.log(`    rolling     ${join(root, 'rolling')}`)
  console.log(`    checkpoints ${join(root, 'checkpoints')}`)
  console.log(`  固化区        ${C.fixedDir(root)}`)
  if (fixed) {
    console.log(`    bat-default ← 来源「${fixed.meta.fromName}」`)
    console.log(`                  固化于 ${new Date(Date.parse(fixed.meta.fixedAt)).toLocaleString('zh-CN')}`)
  } else {
    console.log(`    bat-default （未固化 —— .bat 走快照池）`)
  }
  console.log('')
  console.log(`  插件目录      ${HERE}`)
  console.log(`  脚本          ${join(HERE, 'dsh-rollback.mjs')}`)
  console.log(`  紧急脚本      ${join(HERE, '还原DSH配置.bat')}`)
  console.log('')
  console.log(`  node.exe      ${process.execPath}`)
  console.log(`  错误日志      ${join(root, 'errors.log')}`)
  console.log('')
  return C.EXIT.OK
}

/** list —— 列出快照（按类型分组）。 */
function cmdList(opts) {
  const { root } = resolveCtx(opts)
  const idx = C.readIndex(root)
  C.assertStoreVersion(idx)

  const entries = (idx.entries ?? []).slice()
  const bootLog = C.readBootLog(root)

  if (entries.length === 0) {
    console.log('\n  （还没有任何快照）\n')
    return C.EXIT.OK
  }

  const groups = { daily: [], rolling: [], manual: [], 'before-restore': [] }
  for (const e of entries) {
    const t = groups[e.type] ? e.type : 'manual'
    groups[t].push(e)
  }

  const show = (title, arr) => {
    if (arr.length === 0) return
    console.log(`\n  ── ${title}（${arr.length}）──`)
    arr.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
    for (const e of arr) {
      const g = C.computeGrade(e, bootLog)
      const stars = { 'verified-strong': '*****', verified: '****', 'static-ok': '***', failed: '*' }[g] ?? '?'
      const ts = new Date(e.createdAtMs ?? 0).toLocaleString('zh-CN', { hour12: false })
      const orgLabel = C.ORIGIN_LABEL[e.origin] ?? (e.origin || '?')
      console.log(`    ${stars.padEnd(6)} ${ts}  ${String(e.name ?? '').padEnd(26)} ${String(orgLabel).padEnd(5)} ${Math.round((e.size ?? 0) / 1024)} KB  [${g}]`)
      // 回滚记录额外说明「这是回滚到哪份之前的现场」
      if (e.type === 'before-restore' && e.restoreInfo) {
        console.log(`           ↳ 回滚到「${e.restoreInfo.targetName || '?'}」之前的现场`
          + (e.restoreInfo.reason ? `（${e.restoreInfo.reason}）` : ''))
      }
      console.log(`           id: ${e.id}`)
    }
  }

  const total = entries.reduce((s, e) => s + (e.size ?? 0), 0)
  console.log(`\n  共 ${entries.length} 个快照 · 占用 ${(total / 1024 / 1024).toFixed(2)} MB`)
  show('每日快照', groups.daily)
  show('手动快照', groups.manual)
  show('滚动快照', groups.rolling)
  // ⚠️ 2026-10-20 用户要求：回滚前快照单独存放并说明
  show('回滚记录（每次回滚前的现场）', groups['before-restore'])
  console.log('')
  return C.EXIT.OK
}

/** check —— 体检。 */
function cmdCheck(opts) {
  const { home, profile } = resolveCtx(opts)
  const dshVersion = detectDshVersion(opts['dsh-version'], home)

  // --home-layer：只检查 home 层
  if (opts['home-layer']) {
    const p = join(home, 'cordis.patch.yml')
    if (!existsSync(p)) {
      console.log('\n  ⓘ home 层 patch 不存在（可容忍）\n')
      return C.EXIT.OK
    }
    try {
      const t = readFileSync(p, 'utf8')
      const r = parsePatchSubset(t)
      if (r.ok) {
        console.log(`\n  ✅ home 层 patch 可解析（${t.length} B，${r.count} 条目）\n`)
        return C.EXIT.OK
      }
      console.log('\n  ❌ [fatal] home-layer-unparsable')
      console.log(`     $DSH_HOME\\cordis.patch.yml 无法解析`)
      console.log(`     路径：${p}`)
      console.log(`     原因：${r.reason}（第 ${r.line} 行）`)
      console.log('')
      console.log('     ⓘ 这个文件在 profile 层之后生效，它坏了 DSH 起不来。')
      console.log('     🔴 本插件不负责修复它（home 层不在快照范围内）。')
      console.log('        请手动处理：删除该文件（缺失可容忍）或修复其 YAML 语法。\n')
      return C.EXIT.NO_SNAPSHOT
    } catch (e) {
      console.log(`\n  ❌ 读取失败：${e.code}\n`)
      return C.EXIT.PERMISSION
    }
  }

  const baseline = readBaseline(opts)
  const report = runCheck({ home, profile, baseline, dshVersion })

  if (opts.json) {
    console.log(JSON.stringify({ profile, ...report }, null, 2))
    return report.counts.fatal > 0 ? C.EXIT.NO_SNAPSHOT : C.EXIT.OK
  }

  // 分层输出（2026-10-19 重做）：只报真问题，正常状态单独归拢
  const icon = { fatal: '❌', error: '⚠️ ', warn: '🟡', info: 'ⓘ' }
  const problems = report.problems ?? []
  const notices = report.notices ?? []
  const normal = report.normal ?? []
  const acked = report.acknowledged ?? []

  console.log(`\n  DSH 配置体检 — ${profile}`)
  console.log(`  ${'-'.repeat(60)}`)
  // 有「回滚治不了」的问题时，verdict 不能笼统写「建议回滚」
  const NON_RESTORABLE = ['core-package-duplicate', 'proxy-env-dead', 'crash-recent']
  const hasNonRestorable = problems.some((x) => NON_RESTORABLE.includes(x.code))
  const verdictText = hasNonRestorable && report.counts.fatal > 0
    ? '有致命问题 —— 其中有的【回滚救不了】，请看下方专项指引'
    : (report.verdict ?? '')
  console.log(`\n  ${problems.length + notices.length === 0 ? '✅' : '⚠️ '} ${verdictText}`)
  console.log(`  真问题 ${problems.length} · 提示 ${notices.length}`
    + ` · 正常状态 ${normal.length}（无需处理）`
    + (acked.length ? ` · 已确认 ${acked.length}` : ''))

  const dump = (arr) => {
    for (const it of arr) {
      console.log(`    ${icon[it.severity] ?? '·'} ${it.message}`)
      if (it.hint) console.log(`       💡 ${it.hint}`)
      if (it.file) console.log(`       文件：${it.file}`)
      console.log(`       码：${it.code}`)
    }
  }

  if (problems.length > 0) {
    console.log(`\n  ── 需要处理（${problems.length}）──`)
    dump(problems)
  }
  if (notices.length > 0) {
    console.log(`\n  ── 提示（${notices.length}）· 一般不影响使用 ──`)
    dump(notices)
  }
  // 正常状态：除非 --verbose，否则只给一行汇总
  if (normal.length > 0) {
    if (opts.verbose) {
      console.log(`\n  ── 正常状态（${normal.length}）· 无需处理 ──`)
      dump(normal)
    } else {
      console.log(`\n  ⓘ ${normal.length} 项属于 DSH 的正常状态（如升级遗留的符号链接、`
        + `覆盖官方插件配置），不影响使用。`)
      console.log(`     用 --verbose 可查看明细。`)
    }
  }
  if (acked.length > 0) {
    console.log(`\n  ── 已确认可接受（${acked.length}）──`)
    if (opts.verbose) dump(acked)
    else console.log(`     （已不计入判断；用 --verbose 查看，或在面板里管理）`)
  }

  // ── 修复指引 ──
  //
  // ⚠️ 必须区分「回滚能救」与「回滚救不了」两类问题。
  //
  //   2026-11-04 事故：node_modules/@deepseek-ai/ 里的核心包副本
  //   导致所有 Agent 预设 broken。用户第一反应是回滚 —— 但无效，
  //   因为快照设计上就不含 node_modules。白试一遍很挫败。
  if (problems.length > 0) {
    // 分类：哪些【回滚/还原快照治不了】，必须单独说
    const NO_RESTORE_CODES = ['core-package-duplicate', 'proxy-env-dead', 'crash-recent']
    const coreDup = problems.filter((x) => x.code === 'core-package-duplicate')
    const proxyDead = problems.filter((x) => x.code === 'proxy-env-dead')
    const others = problems.filter((x) => !NO_RESTORE_CODES.includes(x.code))

    // ── 崩溃：还原快照也治不了 ──
    const crashRecent = problems.filter((x) => x.code === 'crash-recent')
    if (crashRecent.length > 0) {
      console.log('  👉 DSH 崩过 —— 这个问题【还原快照也救不了】')
      console.log('')
      console.log('     原因：崩溃是程序运行时的错误（比如 Electron 主进程竞态、')
      console.log('           某个插件抛异常），不是配置文件坏了。')
      console.log('           快照只备份 5 个配置文件，还原不了一个已经发生的崩溃。')
      console.log('')
      console.log('     该怎么看：')
      for (const p of crashRecent) {
        console.log('       日志：' + String(p.file ?? ''))
      }
      console.log('')
      console.log('     注意：崩溃报告只记录【第一个】错误，后续错误会被丢弃，')
      console.log('           所以里面未必是真因 —— 要结合当时的操作判断。')
      console.log('')
      console.log('     如果是插件引起的：')
      console.log('       · 先把可疑插件禁用，重启观察')
      console.log('       · 反复崩 → 用 FK 的【快照】回滚到崩溃前（配置层可能被带坏）')
      console.log('     如果是 DSH 自身的 bug：')
      console.log('       · 降级到上一个版本（比如 rc.3 → rc.2）')
      console.log('')
    }

    if (proxyDead.length > 0) {
      console.log('  👉 代理环境变量指向失效代理 —— 这个问题【回滚/重启都救不了】')
      console.log('')
      console.log('     原因：变量存在【注册表】（HKCU\\Environment），')
      console.log('           既不在快照范围内，也不会随 DSH 重启而改变。')
      console.log('')
      console.log('     它为什么让所有模型都挂：')
      console.log('       DSH 0.2.2 起会在启动时读取 HTTP_PROXY / HTTPS_PROXY，')
      console.log('       把全局 HTTP dispatcher 换成指向该代理的 ProxyAgent。')
      console.log('       代理没开 → 每一条出站请求全部失败 →')
      console.log('       所有 provider 统一报 "DeepSeek Messages transport failed"。')
      console.log('       这个报错完全不指向真因，换模型、换 provider、查密钥都是白试。')
      console.log('')
      for (const p of proxyDead) {
        const pkgs = Array.isArray(p.packages) ? p.packages : []
        if (pkgs.length > 0) console.log(`     涉及：${pkgs.join('、')}`)
      }
      console.log('')
      console.log('     两个选择（任选一个，然后【完全重启 DSH】）：')
      console.log('       A. 启动代理软件（如果确实需要代理）')
      console.log('       B. 删掉这两个用户级变量：')
      console.log('            [Environment]::SetEnvironmentVariable("HTTP_PROXY",$null,"User")')
      console.log('            [Environment]::SetEnvironmentVariable("HTTPS_PROXY",$null,"User")')
      console.log('')
    }

    if (coreDup.length > 0) {
      console.log('  👉 内核核心包副本 —— 这个问题【回滚救不了】')
      console.log('')
      console.log('     原因：快照只备份 5 个配置文件 + Electron 状态，不含 node_modules。')
      console.log('           （设计如此：它本可由 lockfile 重建。但核心包副本不在 lockfile 里，')
      console.log('            pnpm 既不重建也不清理它 —— 所以只能手动移走。）')
      console.log('')
      console.log('     正确做法（移动，不要删除，便于排查）：')
      console.log('       1. 完全退出 DSH（关窗口 + 确认托盘图标消失）')
      console.log('       2. 新建备份目录：')
      console.log('          mkdir "<DSH_HOME>\_backup-core-copy-<日期>"')
      console.log('       3. 把这些目录移进去：')
      for (const p of coreDup) {
        const pkgs = Array.isArray(p.packages) ? p.packages : []
        for (const name of pkgs) {
          console.log(`          ${join(profileDirName(home, profile), 'node_modules', '@deepseek-ai', name)}`)
        }
      }
      console.log('       4. 启动 DSH，再跑一次 dsh-rollback check 确认')
      console.log('')
      console.log('     ⓘ cosmokit / schemastery 是纯工具库，有些插件依赖它们，')
      console.log('       可以保留（只报警告，不致命）。')
      console.log('')
    }

    if (others.length > 0) {
      console.log('  👉 其余问题 —— 可尝试还原快照：')
      console.log('       dsh-rollback list                # 看有哪些快照')
      console.log('       dsh-rollback restore <快照id>    # 配置 + 状态一起还原')
      console.log('')
    }
  }
  console.log('')

  return report.counts.fatal > 0 ? C.EXIT.NO_SNAPSHOT : C.EXIT.OK
}

/** profile 目录名（用于打印路径提示）。 */
function profileDirName(home, profile) {
  return join(home, 'profiles', profile)
}

/** 读启动基线（体检的比对基准）。 */
function readBaseline(opts) {
  const { root } = resolveCtx(opts)
  const p = join(root, 'launch-baseline.json')
  const b = C.readJson(p)
  return b
}

/** snapshot —— 手动创建快照。 */
function cmdSnapshot(opts) {
  const { home, profile } = resolveCtx(opts)
  const type = opts.daily ? 'daily' : 'manual'
  const dshVersion = detectDshVersion(opts['dsh-version'], home)

  const report = runCheck({ home, profile, dshVersion })
  // ⭐ 自动探测创建来源：有 DSH_SESSION_ID → AI，否则 → 用户
  const org = C.detectOrigin(opts.origin)

  const r = C.createSnapshot({
    home, profile, type,
    origin: opts.origin ?? org.origin,     // 显式指定优先（钩子传 'auto'）
    name: opts.name,
    note: opts.note,
    dshVersion,
    health: { overall: report.overall, counts: report.counts, issues: report.issues.slice(0, 20) },
  })
  C.pruneSnapshots(C.snapshotDir(home, profile))

  console.log(`\n  ✅ 快照已创建`)
  console.log(`     id:   ${r.id}`)
  console.log(`     名称: ${r.meta.name}`)
  console.log(`     来源: ${C.ORIGIN_LABEL[r.meta.origin] ?? r.meta.origin}`)
  console.log(`     大小: ${Math.round(r.bytes / 1024)} KB`)
  console.log(`     体检: ${report.overall}${report.issues.length ? `（${report.issues.length} 条提示）` : ''}`)

  // 状态部分（2026-10-22 最终版：Cookies 不进快照，也不再提示）
  const es = r.meta.estate
  if (es?.included) {
    const kb = Math.round((es.bytes ?? 0) / 1024)
    const cnt = (es.entries ?? []).length
    console.log(`     状态: ${kb} KB（${cnt} 个条目）`)
  } else if (es) {
    console.log(`     状态: 未包含（${es.reason ?? '未知原因'}）`)
  }
  console.log('')
  return C.EXIT.OK
}

/** show —— 快照详情。 */
function cmdShow(opts) {
  const { root } = resolveCtx(opts)
  const id = opts._[0]
  if (!id) die(C.EXIT.ARGS, 'show 需要快照 ID')

  const idx = C.readIndex(root)
  const e = (idx.entries ?? []).find((x) => x.id === id)
  if (!e) die(C.EXIT.NO_SNAPSHOT, `找不到快照：${id}`)

  const dir = join(root, e.dir)
  const meta = C.readJson(join(dir, 'meta.json'))
  const bootLog = C.readBootLog(root)

  console.log(`\n  快照详情`)
  console.log(`  ${'-'.repeat(60)}`)
  console.log(`  名称：    ${e.name}`)
  console.log(`  备注：    ${e.note || '(无)'}`)
  console.log(`  内部 ID： ${e.id}`)
  console.log(`  类型：    ${e.type}`)
  console.log(`  创建于：  ${new Date(e.createdAtMs ?? 0).toLocaleString('zh-CN', { hour12: false })}`)
  console.log(`  大小：    ${Math.round((e.size ?? 0) / 1024)} KB`)
  console.log(`  DSH 版本：${e.dshVersion ?? '(未记录)'}`)
  console.log(`  健康等级：${C.computeGrade(e, bootLog)}`)
  console.log(`  体检结果：${e.health ?? '(未记录)'}`)
  console.log(`\n  文件清单：`)
  for (const f of C.SNAPSHOT_FILES) {
    const rec = meta?.files?.[f]
    const now = C.sha256(join(dir, f))
    const ok = rec?.exists ? (now === rec.sha256) : !existsSync(join(dir, f))
    console.log(`    ${ok ? '✓' : '✗'} ${f.padEnd(22)} ${rec?.exists ? `${String(rec.size).padStart(7)} B  ${rec.sha256}` : '(快照中不存在)'}`)
  }
  console.log('')
  return C.EXIT.OK
}

/** restore —— 还原。 */
function cmdRestore(opts) {
  const { home, profile, root } = resolveCtx(opts)
  const dryRun = Boolean(opts['dry-run'])
  const dshVersion = detectDshVersion(opts['dsh-version'], home)

  let target = null
  let why = ''

  // ─────────────────────────────────────────────────────────────
  // .bat 的数据源（2026-10-20 用户最终裁定）
  // ─────────────────────────────────────────────────────────────
  //
  // 用户原话：
  //   「.bat 只能是使用固化的副本，快照什么样子不归他管。
  //    因为 .bat 是最大的底牌，最后的兜底！不能去依赖快照，
  //    每天启动的快照自动作为固化给 .bat 脚本」
  //
  // 所以：
  //   · 无参数调用（= .bat 的行为）→ 只用固化副本
  //   · 没有固化副本 → 明确报错，【绝不】偷偷回退到快照池
  //     （否则就违反了「不依赖快照」的要求）
  //   · 要手动指定某份快照 / 用 --last-good → 那是「人在操作」，不是 .bat
  //
  const isBatInvocation = opts._.length === 0 && !opts['last-good'] && !opts['from-pool']

  if (isBatInvocation) {
    const fixedSlot = C.readFixedSlot(root)

    if (!fixedSlot) {
      die(C.EXIT.NO_SNAPSHOT,
        '没有可用的固化副本 —— .bat 无法工作。\n'
        + '    原因：还没有任何快照被固化过。\n'
        + '    说明：.bat 只使用【固化副本】，不读快照池（这是设计约定）。\n'
        + '    补救：\n'
        + '      ① 先让 DSH 正常启动一次（会自动把当天 daily 快照固化）\n'
        + '      ② 或手动固化：dsh-rollback.mjs fix <快照ID>\n'
        + '      ③ 或临时从快照池还原：dsh-rollback.mjs restore --from-pool')
    }

    if (!fixedSlot.ok) {
      die(C.EXIT.NO_SNAPSHOT,
        `固化副本不完整（${fixedSlot.present.length}/5 文件）：${fixedSlot.dir}\n`
        + '    请重新固化：dsh-rollback.mjs fix <快照ID>')
    }

    target = {
      id: 'fixed:' + fixedSlot.meta.fromId,
      name: `固化副本「${fixedSlot.meta.fromName}」`,
      dir: `${C.FIXED_DIR}/${fixedSlot.slot}`,
      createdAtMs: fixedSlot.meta.fixedAtMs,
      health: 'unknown',
      fingerprint: fixedSlot.meta.fingerprint ?? null,
    }
    why = `固化副本（固化于 ${new Date(Date.parse(fixedSlot.meta.fixedAt)).toLocaleString('zh-CN')}）`
    console.log(`\n  ⭐ 使用固化副本（.bat 的唯一数据源，不依赖快照池）`)
    console.log(`     来源：${fixedSlot.meta.fromName}`)
    console.log(`     固化于：${new Date(Date.parse(fixedSlot.meta.fixedAt)).toLocaleString('zh-CN')}`)
    console.log(`     方式：${fixedSlot.meta.fixedBy === 'auto-daily' ? '每日启动自动固化' : '用户手动指定'}`)
    console.log(`     路径：${fixedSlot.dir}\n`)
  } else if (opts['last-good'] || opts['from-pool']) {
    // 显式要求「从快照池选」—— 这是人在操作，不是 .bat 的路径
    const bootLog = C.readBootLog(root)
    const pick = C.pickLastGood(root, home, profile, bootLog)
    if (!pick) {
      die(C.EXIT.NO_SNAPSHOT,
        '找不到可用快照。\n'
        + '    可能原因：① 从没建过快照 ② 全部快照都不健康\n'
        + '    补救：先跑 `snapshot` 建一个，或检查快照目录')
    }
    target = pick.entry
    why = `${pick.level} —— ${pick.reason}`
  } else {
    const id = opts._[0]
    const idx = C.readIndex(root)
    C.assertStoreVersion(idx)
    target = (idx.entries ?? []).find((x) => x.id === id)
    if (!target) die(C.EXIT.NO_SNAPSHOT, `找不到快照：${id}`)
    why = '用户指定'
  }

  let snapDir
  try {
    snapDir = target.dir.startsWith(`${C.FIXED_DIR}/`)
      ? C.fixedSlotDir(root, target.dir.slice(C.FIXED_DIR.length + 1))
      : C.snapshotPath(root, target)
  } catch (e) {
    die(C.EXIT.NO_SNAPSHOT, e.message)
  }
  const meta = C.readJson(join(snapDir, 'meta.json'))
  if (!meta) die(C.EXIT.NO_SNAPSHOT, `快照目录缺少 meta.json：${snapDir}`)

  // ── 预检：算出「将被移除 / 恢复」 ──
  //   ⚠️ 两边都必须用 computeEffectivePlugins（含 patch 里的 insert 插件），
  //   否则 insert-only 插件会被误报为「将被移除」。
  const liveDir = join(home, 'profiles', profile)
  const patchNow = existsSync(join(liveDir, 'cordis.patch.yml'))
    ? readFileSync(join(liveDir, 'cordis.patch.yml'), 'utf8') : null
  const effNow = computeEffectivePlugins(liveDir, patchNow)

  const snapPatch = existsSync(join(snapDir, 'cordis.patch.yml'))
    ? readFileSync(join(snapDir, 'cordis.patch.yml'), 'utf8') : null
  const effSnap = computeEffectivePlugins(snapDir, snapPatch)

  console.log(`\n${dryRun ? '  [预演模式] 不会修改任何文件\n' : ''}`)
  console.log(`  已选定快照：${target.name}`)
  console.log(`  可靠性依据：${why}`)
  console.log(`  创建于：${new Date(target.createdAtMs ?? 0).toLocaleString('zh-CN', { hour12: false })}`)
  console.log(`  id：${target.id}`)

  // 将被移除（两端都用 computeEffectivePlugins，排除官方包）
  const removed = [...effNow]
    .filter((n) => !effSnap.has(n))
    .filter((n) => !n.startsWith('@deepseek-ai/'))     // 官方包不算「移除」
    .sort()

  console.log(`\n  ── 将被移除（当前有，快照里没有）──`)
  if (removed.length === 0) console.log('    （无）')
  for (const n of removed.slice(0, 12)) console.log(`    ✗ ${n}`)
  if (removed.length > 12) console.log(`    …还有 ${removed.length - 12} 项`)

  // 自我移除陷阱警告
  const SELF = ['dsh-fk-rollback', 'dsh-fk-restart-button']
  const selfRemoved = removed.filter((n) => SELF.includes(n))
  if (selfRemoved.length > 0) {
    console.log(`\n  🔴 注意：以下插件是本工具自身的一部分：`)
    for (const n of selfRemoved) console.log(`      ✗ ${n}`)
    console.log(`      回滚并重启后：快照面板会消失、「立即重启」按钮会失效。`)
    console.log(`      后续请用「还原DSH配置.bat」或本脚本继续操作。`)
  }

  if (dryRun) {
    console.log(`\n  ⚠ 这是预演，未做任何修改。去掉 --dry-run 才会真正执行。\n`)
    return C.EXIT.OK
  }

  // ── ⑧ 还原前先给当前状态拍快照 ──
  console.log(`\n  正在创建回滚前快照…`)
  const before = C.createSnapshot({
    home, profile, type: 'before-restore',
    origin: 'auto',                     // ⭐ 回滚流程自动存
    dshVersion,
    health: { overall: 'unknown', counts: {}, issues: [] },
    name: `回滚前 ${C.localDate()} ${new Date().toTimeString().slice(0, 5)}`,
  })
  console.log(`    ✓ 已存为：${before.id}`)

  // ── 还原 ──
  console.log(`\n  正在还原（两阶段写入，patch 最后）…`)
  let r
  try {
    r = C.restoreSnapshot({ home, profile, snapshotDir: snapDir })
  } catch (e) {
    die(C.EXIT.PERMISSION, e.message)
  }

  for (const f of r.restored) console.log(`    ✓ ${f}`)
  for (const f of r.failed) console.log(`    ✗ ${f}  ← 未还原成功`)

  // ── 复检 ──
  const after = runCheck({ home, profile, dshVersion })
  console.log(`\n  还原后体检：${after.overall}`)
  if (after.counts.fatal > 0) {
    console.log(`    ❌ 仍有 fatal：`)
    for (const it of after.issues.filter((x) => x.severity === 'fatal').slice(0, 5)) {
      console.log(`       ${it.message}`)
    }
    console.log(`\n  请检查排查顺序：`)
    console.log(`    1. home 层 patch：node dsh-rollback.mjs check --home-layer`)
    console.log(`    2. DSH 本体包：node_modules/@deepseek-ai/dsh-* 是否完整`)
    console.log(`    3. DSH 安装目录是否被移动`)
    console.log(`    都正常 → 请重装 DSH`)
  }

  // ⭐ 状态还原结果（2026-10-22 审计发现：之前没告诉用户）
  const esr = r.estate
  if (esr) {
    if (esr.restored && esr.restored.length > 0) {
      console.log(`\n  运行时状态已还原：${esr.restored.join('、')}`)
      console.log(`    大小：${Math.round((esr.bytes ?? 0) / 1024)} KB`)
      if (esr.skipped?.length) {
        console.log(`    跳过：${esr.skipped.join('、')}`)
        console.log(`          （这些条目在备份时就不存在，不是还原失败）`)
      }
    } else {
      console.log(`\n  ⚠️ 运行时状态未还原：${esr.reason ?? '未知原因'}`)
      console.log(`     配置已还原，但认证类故障可能仍然存在。`)
      console.log(`     如果 DSH 报「Web authentication failed」，说明这份快照没带状态。`)
    }
  } else {
    console.log(`\n  ⓘ 这份快照不含运行时状态（旧格式），只还原了配置。`)
  }

  console.log(`\n  ${'='.repeat(58)}`)
  const estateFailed = r.estate?.ok === false
  if (r.failed.length === 0 && !estateFailed) {
    console.log(`   还原完成！请重新启动 DSH。`)
    console.log(`   回滚前的状态已存为：${before.id}`)
  } else if (r.failed.length > 0) {
    console.log(`   部分文件未还原成功（${r.failed.length}/${C.SNAPSHOT_FILES.length}）`)
  } else {
    console.log(`   配置文件已还原，但运行时状态还原失败`)
    console.log(`   回滚前的状态已存为：${before.id}`)
  }
  console.log(`  ${'='.repeat(58)}\n`)

  return r.failed.length === 0 && !estateFailed ? C.EXIT.OK : C.EXIT.PARTIAL
}

/** 读快照里的 bundles（用于差异对比）。 */
function readSnapBundles(snapDir) {
  const p = join(snapDir, 'package.json')
  const d = C.readJson(p)
  return new Set(d?.dsh?.profile?.bundles ?? [])
}

/** trace —— 谁改过这个文件。 */
function cmdTrace(opts) {
  const { home } = resolveCtx(opts)
  const file = typeof opts._[0] === 'string' ? opts._[0] : undefined
  const days = Number(opts.days ?? 7)

  console.log(`\n  溯源${file ? `：${file}` : '（全部操作）'}`)
  console.log(`  时间范围：最近 ${days} 天`)
  console.log(`  ${'-'.repeat(60)}`)

  const r = traceFile({ home, file, days })

  console.log(`\n  扫描了 ${r.scanned}/${r.total} 个会话，命中 ${r.hits.length} 条\n`)

  for (const h of r.hits.slice(0, 40)) {
    const ts = new Date(h.t).toLocaleString('zh-CN', { hour12: false })
    console.log(`  【${ts}】会话「${h.sessionTitle ?? '(无标题)'}」`)
    console.log(`    操作：${h.name ?? h.type}`)
    console.log(`    参数：${(h.args ?? '').slice(0, 180)}`)
    if (h.files?.length) console.log(`    涉及文件：${h.files.slice(0, 4).join(', ')}`)
    console.log('')
  }
  if (r.hits.length > 40) console.log(`  …还有 ${r.hits.length - 40} 条\n`)

  if (r.skipped.length) {
    console.log(`  ⓘ 跳过 ${r.skipped.length} 个会话：`)
    for (const s of r.skipped.slice(0, 5)) console.log(`     ${s.sessionId.slice(0, 24)}：${s.reason}`)
    console.log('')
  }

  console.log(`  ⓘ 只列出事实，不判断哪一步「导致了问题」。`)
  console.log(`  ⓘ 参数已脱敏（API key 等替换为 ***）。\n`)
  return C.EXIT.OK
}

/** sessions —— 列出会话。 */
function cmdSessions(opts) {
  const { home } = resolveCtx(opts)
  const days = Number(opts.days ?? 7)
  const list = listSessionSummaries(home, { days })

  console.log(`\n  最近 ${days} 天的会话（${list.length} 个）`)
  console.log(`  ${'-'.repeat(60)}`)
  for (const s of list) {
    const last = s.lastAt
      ? new Date(s.lastAt).toLocaleString('zh-CN', { hour12: false })
      : (s.fileMtimeMs ? new Date(s.fileMtimeMs).toLocaleString('zh-CN', { hour12: false }) : '?')
    console.log(`  ${last}  ${String(s.title).slice(0, 38).padEnd(40)} ${s.eventCount ?? 0} 操作`)
    if (!s.ok) console.log(`      ⓘ 跳过：${s.reason}`)
  }
  console.log('')
  return C.EXIT.OK
}

/** status —— 当前状态摘要。 */
function cmdStatus(opts) {
  const { home, profile, root } = resolveCtx(opts)
  const idx = C.readIndex(root)
  const report = runCheck({ home, profile, dshVersion: detectDshVersion(opts['dsh-version'], home) })

  console.log(`\n  DSH 配置状态 — ${profile}`)
  console.log(`  ${'-'.repeat(60)}`)
  console.log(`  体检：      ${report.overall}`)
  console.log(`  快照数：    ${(idx.entries ?? []).length}`)
  console.log(`  最近快照：  ${(idx.entries ?? []).slice(-1)[0]?.name ?? '(无)'}`)
  console.log(`  5 文件合计：${Math.round(C.SNAPSHOT_FILES.reduce((s, f) => {
    try { return s + statSync(join(home, 'profiles', profile, f)).size } catch { return s }
  }, 0) / 1024)} KB`)
  console.log(`  home 层：   ${existsSync(join(home, 'cordis.patch.yml')) ? '存在' : '不存在'}\n`)
  return C.EXIT.OK
}

/** prune —— 清理过期快照。 */
function cmdPrune(opts) {
  const { root } = resolveCtx(opts)
  const dryRun = Boolean(opts['dry-run'])
  const r = C.pruneSnapshots(root, { dryRun })
  const list = dryRun ? r.expired : r.removed
  console.log(`\n  ${dryRun ? '将清理' : '已清理'} ${list.length} 个过期快照${dryRun ? '（预演，未修改）' : ''}`)
  for (const x of list) console.log(`    - ${x}`)
  console.log('')
  return C.EXIT.OK
}

/** diagnose —— 诊断（DSH 能启动但界面点不动时用）。 */
function cmdDiagnose(opts) {
  const { home, profile } = resolveCtx(opts)
  const report = runCheck({ home, profile, dshVersion: detectDshVersion(opts['dsh-version'], home) })

  console.log(`\n  DSH 配置诊断 — ${profile}`)
  console.log(`  ${'='.repeat(60)}`)

  console.log(`\n  【1】基础配置`)
  const fatal = report.issues.filter((x) => x.severity === 'fatal')
  const err = report.issues.filter((x) => x.severity === 'error')
  if (fatal.length === 0 && err.length === 0) {
    console.log(`    ✓ 无 fatal / error`)
  } else {
    for (const it of [...fatal, ...err]) console.log(`    ✗ ${it.message}`)
  }

  console.log(`\n  【2】服务依赖检查`)
  const overrides = report.issues.filter((x) => x.code === 'dangerous-user-override' || x.code === 'dangerous-service-override')
  if (overrides.length === 0) {
    console.log(`    ✓ 未发现危险的服务覆盖`)
  } else {
    for (const it of overrides) console.log(`    ✗ ${it.message}`)
    console.log(`\n    ⓘ 若被覆盖服务的 provider 自身 inject 包含该服务 → 会形成循环依赖`)
    console.log(`      症状：DSH 能启动，但所有 agent 功能失效（waiting for web）`)
  }

  console.log(`\n  【3】home 层`)
  const hp = join(home, 'cordis.patch.yml')
  if (!existsSync(hp)) {
    console.log(`    ✓ 不存在（可容忍）`)
  } else {
    const hf = report.issues.find((x) => x.code === 'home-layer-unparsable')
    if (hf) {
      console.log(`    ✗ $DSH_HOME\\cordis.patch.yml 无法解析！`)
      console.log(`      这是「本插件救不了、DSH 弹窗也救不了」的死角。`)
      console.log(`      请手动删除或修复：${hp}`)
    } else {
      console.log(`    ✓ 可解析`)
    }
  }

  console.log(`\n  【4】建议`)
  if (report.overall === 'ok') {
    console.log(`    配置无明显问题。若 DSH 仍异常，请检查：`)
    console.log(`      □ node_modules/@deepseek-ai/dsh-* 是否完整`)
    console.log(`      □ DSH 安装目录是否被移动`)
    console.log(`      □ 是否重装 DSH`)
  } else {
    console.log(`    跑一次 restore --last-good 试试：`)
    console.log(`      node dsh-rollback.mjs restore --last-good`)
  }
  console.log(`\n  ${'='.repeat(60)}\n`)
  return report.counts.fatal > 0 ? C.EXIT.NO_SNAPSHOT : C.EXIT.OK
}

/** oplog —— 查看操作日志。 */
function cmdOplog(opts) {
  const { root } = resolveCtx(opts)
  const p = join(root, 'oplog.jsonl')
  if (!existsSync(p)) { console.log('\n  （暂无操作日志）\n'); return C.EXIT.OK }
  const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim())
  const tail = Number(opts.tail ?? 20)
  console.log(`\n  操作日志（最后 ${Math.min(tail, lines.length)} 条）`)
  console.log(`  ${'-'.repeat(60)}`)
  for (const l of lines.slice(-tail)) {
    try {
      const o = JSON.parse(l)
      const ts = new Date(o.at).toLocaleString('zh-CN', { hour12: false })
      console.log(`  ${ts}  ${String(o.cmd).padEnd(10)} ${String(o.result ?? '').padEnd(8)} ${o.durationMs ?? 0}ms`)
    } catch { /* 跳过坏行 */ }
  }
  console.log('')
  return C.EXIT.OK
}

/** 写 oplog 一行。 */
function writeOplog(root, entry) {
  try {
    const p = join(root, 'oplog.jsonl')
    mkdirSync(root, { recursive: true })
    appendFileSync(p, `${JSON.stringify(entry)}\n`)
  } catch { /* 写失败不影响主流程 */ }
}

// ─────────────────────────────────────────────────────────────
// 帮助
// ─────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
  FK 回滚设置 —— DSH 配置快照与回滚

  ⚠️ 如果 PATH 里没有 node，用 DSH 自带的运行时（<DSH安装目录>\resources\runtime\...\node.exe）。

  用法：node dsh-rollback.mjs <命令> [选项]

  ── 查看类 ──
    list                        列出所有快照（按类型分组）
    show <id>                   快照详情
    status                      当前配置状态摘要

  ── 检查类 ──
    check                       静态体检（已装好的配置）
      --json                      JSON 输出
      --verbose                  显示正常状态与已确认项
      --home-layer                只检查 $DSH_HOME/cordis.patch.yml
                             fatal 返回 4；error/warn 返回 0（信息可见但不阻断）

    diagnose                    诊断（含依赖图、home 层排查）

  ── 创建类 ──
    snapshot                    手动创建快照
      --daily                     建为每日快照
      --name <名称>               自定义名称
      --note <备注>               备注
      --origin <auto|ai|user>     强制指定来源（默认自动探测）

  proxy                     诊断代理环境变量（所有模型报 transport failed 时用）
    --fix                     删掉指向失效代理的变量（先备份，可 --restore 反悔）
    --dry-run                 配合 --fix 使用，只显示会删什么
    --restore                 从备份恢复
                            ⚠️ 变量在注册表里，回滚快照治不了

  core                      隔离内核核心包副本（装插件后预设全坏时用）
    --dry-run                 只显示会移走什么，不实际移动
    --backup-to <目录>         自定义备份位置（默认 <DSH_HOME>/_backup-core-copy-<时间戳>）
                            ⚠️ 这类问题【回滚救不了】—— 快照不含 node_modules

  estate                    体检 Electron 运行时状态（认证库 / cookie 库 / 锁文件）
  estate --clean-cookies    清理累积的 dsh-auth-* Cookie（需先完全退出 DSH）
    --dry-run                 只显示会删多少，不实际删除
  estate --reset            重置运行时状态（会清掉浏览器会话凭据；最后手段）
                            ⚠️ 备份/还原不用它 —— 已并入 snapshot / restore
  以上都支持 --app-data <路径> 指定 Electron userData（默认自动探测）

  ── 还原类 ──
    restore <id>                还原到指定快照
    restore --last-good         自动选最佳快照
      --dry-run                   只显示会改什么，不写文件

  ── 溯源类 ──
    trace [文件]                谁在什么时候改过这个文件
      --days <n>                  回溯天数（默认 7）
    sessions                    列出最近会话

  ── 维护类 ──
  ── .bat 固化类 ──
  fix <id> [--pin]            把某个快照固化为 .bat 的数据源
    --pin [--slot <名称>]         钉住指定快照；无 ID 时钉住当前固化副本
    （不加 --pin）                下次启动时自动换成当天的 daily
  fix --unpin [--slot <名称>]    取消钉住，恢复跟随当天 daily
  fix --show                   查看当前固化状态（含是否钉住）
  fix --clear [--slot <名称>]    取消固化（.bat 将无法工作）
    --slot <名称>                固化槽位（默认 bat-default）

    prune [--dry-run]             按数量 + 天数清理快照（不清理 fixed/）
    oplog                       查看操作日志
      --tail <n>                  只看最后 N 条

  ── 通用选项 ──
    --profile <name>            指定 profile（默认自动探测）
    --home <path>               指定 DSH_HOME
    --dsh-version <v>           当前 DSH 版本（默认读取实际安装包）

  退出码：
    0 成功   1 一般错误   2 参数错误   3 profile 不存在
    4 快照不存在/损坏   5 权限/占用   6 磁盘不足
    7 需人工介入   8 部分成功
`)
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

const COMMANDS = {
  list: cmdList,
  check: cmdCheck,
  snapshot: cmdSnapshot,
  show: cmdShow,
  restore: cmdRestore,
  trace: cmdTrace,
  sessions: cmdSessions,
  status: cmdStatus,
  prune: cmdPrune,
  fix: cmdFix,
  paths: cmdPaths,
  diagnose: cmdDiagnose,
  estate: cmdEstate,
  core: cmdCore,
  proxy: cmdProxy,
  oplog: cmdOplog,
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || opts.h) { showHelp(); process.exit(C.EXIT.OK) }
  if (opts.version || opts.v) { console.log('dsh-rollback v1.6.0'); process.exit(C.EXIT.OK) }

  const cmd = opts._[0]
  const fn = COMMANDS[cmd]
  // 命令名本身要从位置参数里移出，否则 show/trace 会把命令名当成第一个参数。
  opts._ = opts._.slice(1)

  const t0 = Date.now()
  let code = C.EXIT.OK
  try {
    code = (await fn(opts)) ?? C.EXIT.OK
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (/EACCES|EPERM|EBUSY/.test(msg)) die(C.EXIT.PERMISSION, msg)
    if (/ENOSPC/.test(msg)) die(C.EXIT.NO_SPACE, msg)
    die(C.EXIT.GENERAL, msg)
  }

  // 记录操作日志
  try {
    const { root } = resolveCtx(opts)
    writeOplog(root, {
      at: new Date().toISOString(),
      cmd,
      args: process.argv.slice(3).map(redactArg),
      result: code === 0 ? 'ok' : (code === 8 ? 'partial' : 'failed'),
      exit: code,
      durationMs: Date.now() - t0,
    })
  } catch { /* 忽略 */ }

  process.exit(code)
}

/** 参数脱敏。 */
function redactArg(a) {
  return String(a).replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***').slice(0, 200)
}

await main()
