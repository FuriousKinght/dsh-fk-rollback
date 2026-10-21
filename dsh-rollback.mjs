#!/usr/bin/env node
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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import * as C from './lib/core.mjs'
import { runCheck, computeEffectivePlugins, listDshPackages, parsePatchSubset } from './lib/check.mjs'
import { traceFile, listSessionSummaries } from './lib/trace.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ─────────────────────────────────────────────────────────────
// 参数解析（手写，零依赖）
// ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const key = a.slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i += 1 }
        else opts[key] = true
      }
    } else {
      opts._.push(a)
    }
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
  if (!id) die(C.EXIT.ARGS, 'fix 需要一个快照 ID（或用 --show 查看 / --clear 取消）')

  const e = (idx.entries ?? []).find((x) => x.id === id)
  if (!e) die(C.EXIT.NO_SNAPSHOT, `找不到快照：${id}`)

  let r
  try {
    r = C.fixSnapshot({ root, entry: e, slot: opts.slot })
  } catch (err) {
    die(C.EXIT.NO_SNAPSHOT, err.message)
  }

  console.log(`\n  ✅ 已固化`)
  console.log(`     来源快照: ${r.fromName}`)
  console.log(`     槽位:     ${r.slot}${r.slot === C.FIXED_SLOT_DEFAULT ? '（.bat 默认使用）' : ''}`)
  console.log(`     文件:     ${r.files}/5 个，${Math.round(r.bytes / 1024)} KB`)
  console.log(`     路径:     ${r.dir}`)
  console.log('')
  console.log('  ⚠️ 从此 .bat 直接使用这份固定副本：')
  console.log('     · 快照池怎么顶替都不会影响它')
  console.log('     · 只有执行 `fix --clear` 才会取消')
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
  const report = runCheck({ home, profile, baseline, dshVersion: opts['dsh-version'] })

  if (opts.json) {
    console.log(JSON.stringify({ profile, ...report }, null, 2))
    return C.EXIT.OK
  }

  // 分层输出（2026-10-19 重做）：只报真问题，正常状态单独归拢
  const icon = { fatal: '❌', error: '⚠️ ', warn: '🟡', info: 'ⓘ' }
  const problems = report.problems ?? []
  const notices = report.notices ?? []
  const normal = report.normal ?? []
  const acked = report.acknowledged ?? []

  console.log(`\n  DSH 配置体检 — ${profile}`)
  console.log(`  ${'-'.repeat(60)}`)
  console.log(`\n  ${problems.length + notices.length === 0 ? '✅' : '⚠️ '} ${report.verdict ?? ''}`)
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
  console.log('')

  return report.counts.fatal > 0 ? C.EXIT.NO_SNAPSHOT : C.EXIT.OK
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

  const report = runCheck({ home, profile, dshVersion: opts['dsh-version'] })
  // ⭐ 自动探测创建来源：有 DSH_SESSION_ID → AI，否则 → 用户
  const org = C.detectOrigin(opts.origin)

  const r = C.createSnapshot({
    home, profile, type,
    origin: opts.origin ?? org.origin,     // 显式指定优先（钩子传 'auto'）
    name: opts.name,
    note: opts.note,
    dshVersion: opts['dsh-version'],
    health: { overall: report.overall, counts: report.counts, issues: report.issues.slice(0, 20) },
  })
  C.pruneSnapshots(C.snapshotDir(home, profile))

  console.log(`\n  ✅ 快照已创建`)
  console.log(`     id:   ${r.id}`)
  console.log(`     名称: ${r.meta.name}`)
  console.log(`     来源: ${C.ORIGIN_LABEL[r.meta.origin] ?? r.meta.origin}`)
  console.log(`     大小: ${Math.round(r.bytes / 1024)} KB`)
  console.log(`     体检: ${report.overall}${report.issues.length ? `（${report.issues.length} 条提示）` : ''}\n`)
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

  const snapDir = join(root, target.dir)
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
    dshVersion: opts['dsh-version'],
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
  const after = runCheck({ home, profile, dshVersion: opts['dsh-version'] })
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

  console.log(`\n  ${'='.repeat(58)}`)
  if (r.failed.length === 0) {
    console.log(`   还原完成！请重新启动 DSH。`)
    console.log(`   回滚前的状态已存为：${before.id}`)
  } else {
    console.log(`   部分文件未还原成功（${r.failed.length}/${C.SNAPSHOT_FILES.length}）`)
  }
  console.log(`  ${'='.repeat(58)}\n`)

  return r.failed.length === 0 ? C.EXIT.OK : C.EXIT.PARTIAL
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
  const report = runCheck({ home, profile, dshVersion: opts['dsh-version'] })

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
  const r = C.pruneSnapshots(root)
  console.log(`\n  已清理 ${r.removed.length} 个过期快照`)
  for (const x of r.removed) console.log(`    - ${x}`)
  console.log('')
  return C.EXIT.OK
}

/** diagnose —— 诊断（DSH 能启动但界面点不动时用）。 */
function cmdDiagnose(opts) {
  const { home, profile } = resolveCtx(opts)
  const report = runCheck({ home, profile, dshVersion: opts['dsh-version'] })

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
    check                       静态体检
      --json                      JSON 输出
      --home-layer                只检查 $DSH_HOME/cordis.patch.yml
    diagnose                    诊断（含依赖图、home 层排查）

  ── 创建类 ──
    snapshot                    手动创建快照
      --daily                     建为每日快照
      --name <名称>               自定义名称
      --note <备注>               备注
      --origin <auto|ai|user>     强制指定来源（默认自动探测）

  ── 还原类 ──
    restore <id>                还原到指定快照
    restore --last-good         自动选最佳快照
      --dry-run                   只显示会改什么，不写文件

  ── 溯源类 ──
    trace [文件]                谁在什么时候改过这个文件
      --days <n>                  回溯天数（默认 7）
    sessions                    列出最近会话

  ── 维护类 ──
    prune                       清理过期快照
    oplog                       查看操作日志
      --tail <n>                  只看最后 N 条

  ── 通用选项 ──
    --profile <name>            指定 profile（默认自动探测）
    --home <path>               指定 DSH_HOME
    --dsh-version <v>           当前 DSH 版本（用于 engines 检查）

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
  oplog: cmdOplog,
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || opts.h) { showHelp(); process.exit(C.EXIT.OK) }
  if (opts.version || opts.v) { console.log('dsh-rollback v1.4.0'); process.exit(C.EXIT.OK) }

  const cmd = opts._[0]
  const fn = COMMANDS[cmd]
  if (!fn) {
    if (!cmd) { showHelp(); process.exit(C.EXIT.ARGS) }
    die(C.EXIT.ARGS, `未知命令：${cmd}\n  跑 \`--help\` 看可用命令`)
  }

  // ⚠️ 命令名本身要从位置参数里移出，否则 show/trace 会把命令名当成第一个参数。
  opts._ = opts._.slice(1)

  const t0 = Date.now()
  let code = C.EXIT.OK
  try {
    code = fn(opts) ?? C.EXIT.OK
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

main()
