/**
 * FK 回滚设置 —— 插件 Host 半边
 *
 * 职责（严格限定，避免拖垮 DSH）：
 *   ① 启动时：写 boot-log、建 daily 快照、记基线
 *   ② turn/end 时：检测配置变化，满足条件的建 rolling 快照
 *   ③ 给 Client 半边提供 HTTP 端点（快照列表 / 创建 / 还原 / 体检）
 *
 * ⚠️ 安全要求（评审 §九）：
 *   · 本插件是 bundle 插件，自己也进 bundles 列表
 *   · 所有 apply() 必须 try/catch，异常绝不能冒泡
 *   · turn/end 钩子内异常绝不能影响对话
 *
 * @module dsh-fk-rollback
  *
 * @version 1.5.1
 * @module 宿主接线（模块一~六的 Http 端点与钩子）
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as C from './lib/core.mjs'
import { runCheck, computeEffectivePlugins } from './lib/check.mjs'
import { listSessionSummaries, traceFile, configTimeline } from './lib/trace.mjs'
import { logError, readErrorLog, buildDiagnosticBundle, writeDiagnosticBundle } from './lib/elog.mjs'
import * as R from './lib/restart.mjs'

/** 插件名（必须等于 package.json 的 name）。 */
export const name = 'dsh-fk-rollback'

/**
 * 依赖的服务。
 *
 * `webServer` 是必需的（要注册 HTTP 端点给客户端用）。
 * 其余服务（timer / locale）都非必需 —— 本插件不依赖它们。
 *
 * 与 dsh-fk-restart-button 的写法一致（`export const inject = ['webServer']`）。
 */
export const inject = ['webServer']

/** 启动时用的 DSH 版本（由外面注入或探测）。 */
let DSH_VERSION = null

/**
 * 已订阅过钩子的 ctx 实例。
 *
 * ⚠️ DSH 的 Fiber 会对同一 ctx 多次调用 apply()，
 *    用 WeakSet 防止事件被重复订阅（不影响 ctx 被回收）。
 */
const hookedContexts = new WeakSet()

/**
 * 插件主体。
 *
 * @param {import('cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  // ⚠️ 整体包在 try/catch 里 —— 本插件出任何问题都不能拖垮 DSH
  try {
    const home = C.resolveHome(config?.home)
    const profile = config?.profile
      ?? process.env.DSH_PROFILE
      ?? C.pickRecentProfile(home)
      ?? 'desktop'

    const ctxInfo = { home, profile }

    // ⚠️ apply() 可能被 DSH 的 Fiber 机制重复调用 ——
    //    所有「只需一次」的工作都要有幂等保护，否则会重复注册路由/重复写日志。
    //    （2026-10-19 实测：重复注册导致每次启动写 15 条 duplicate route 错误）

    // ── ① 启动钩子：boot-log + daily + 基线 ──
    safeRun('startup-hook', () => onStartup(ctxInfo, ctx), ctx)

    // ⚠️ 幂等保护（2026-10-19 实测）：
    //   DSH 的 Fiber 会让 apply() 在同一 ctx 上被调用多次。
    //   如果不挡，同一事件会被订阅 3 次 →
    //     · turn/end 被处理 3 次
    //     · 装插件时建 3 份快照（前两份被去重挡住，但白跑）
    //   用 WeakSet 记住「这个 ctx 已经订阅过」。
    if (hookedContexts.has(ctx)) {
      safeLog(ctx, 'apply', null, 're-apply（已订阅过，跳过钩子注册）')
      return
    }
    hookedContexts.add(ctx)

    // ── ② 每轮对话结束：变化检测 + rolling ──
    //   ⚠️ 必须带 { global: true }，否则收不到别的会话的事件
    try {
      ctx.on('session/event', (session, event) => {
        try {
          if (event?.type !== 'turn/end') return
          onTurnEnd(ctxInfo, session, event)
        } catch (e) {
          // 绝不能冒泡 —— 否则会打断用户的对话
          safeLog(ctx, 'turn-end-hook', e)
        }
      }, { global: true })
    } catch (e) {
      safeLog(ctx, 'register-session-hook', e)
    }

    // ── ①b 插件管理事件：装/卸/启用/禁用后立刻存快照 + 体检 ──
    //
    // ⚠️ 2026-10-19 用户指出：「假设用户安装了一个插件，这时候我们的钩子是否能触发？」
    //    答案原本是【不会】—— 这是个真漏洞。
    //
    //    旧行为：装插件 → 改 package.json → 【我的钩子什么都不做】
    //            → 用户重启 DSH → 如果新插件让 DSH 起不来 → 最近的快照是几小时前的
    //
    //    新行为：订阅 dsh-plugin-manager 的 changed 事件（源码已核实存在）
    //            → 变化后立刻存快照（标记为 auto-plugin-change）
    //            → 立刻体检一次，把问题写进 errors.log
    //
    //    ⚠️ 这个事件在【变化之后】才发（源码 this.change() 末尾 emit），
    //       所以「变化前」的状态拿不到 —— 那份由「上一次快照」承担。
    //       但「变化后」立刻存一份，就能和上一次形成对比。
    try {
      ctx.on('plugin-manager/changed', (payload) => {
        try {
          onPluginManagerChanged(ctxInfo, payload)
        } catch (e) {
          safeLog(ctx, 'plugin-changed-hook', e)
        }
      }, { global: true })
    } catch (e) {
      safeLog(ctx, 'register-plugin-changed-hook', e)
    }

    // ── ①c 「装插件前」快照（2026-10-19 用户要求）──
    //
    // 源码时序（dsh-plugin-manager 的 install()）：
    //   this.change(async (result) => {
    //     const files = await this.readRestoredFiles()   ← DSH 自己备份 4 文件
    //     announce("installing", {...})                  ← ★ 这里！磁盘还是干净的
    //     run = await this.runPnpm(["add", spec])        ← 真正改磁盘
    //     announce("applying")
    //   })
    //   emit("plugin-manager/changed")                   ← 全部完成后
    //
    // ⇒ 在 installing 阶段存快照 = 真正的「装插件前」
    //   （changed 事件只能拿到「装后」，上一版就是这个缺口）
    //
    // payload: { requestId, phase, registry?, index?, total? }
    //   · 没有包名 —— 靠时间线辨认即可（用户已确认可以）
    //   · index > 1 表示多 registry 重试（前一次已 restoreFiles 还原了磁盘）
    try {
      ctx.on('plugin-manager/install-state', (payload) => {
        try {
          onInstallState(ctxInfo, payload)
        } catch (e) {
          safeLog(ctx, 'install-state-hook', e)
        }
      }, { global: true })
    } catch (e) {
      safeLog(ctx, 'register-install-state-hook', e)
    }

    // ── ③ HTTP 端点（给 Client 半边用）──
    safeRun('http-routes', () => registerRoutes(ctx, ctxInfo), ctx)

    safeLog(ctx, 'apply', null, 'ok')
  } catch (e) {
    // 连最外层都失败了也不能抛
    try { ctx?.logger?.warn?.(`[dsh-fk-rollback] apply 失败（已忽略）: ${e?.message}`) } catch { /* 忽略 */ }
  }
}





// ─────────────────────────────────────────────────────────────
// 「装插件前」快照（2026-10-19 新增）
// ─────────────────────────────────────────────────────────────

/**
 * 已处理过的安装请求（requestId → true）。
 *
 * ⚠️ 为什么要去重：install() 内部是多 registry 重试循环
 *    for (const [index, registry] of plan.entries()) {
 *      if (index > 0) await this.restoreFiles(files)   // 还原文
 *      announce("installing", { index, total })
 *      run = await runPnpm(["add", spec])
 *      if (ok) break
 *    }
 *    → 同一个 requestId 可能被 announce 多次，不能每次都建快照。
 *
 * 上限 50 条，避免长期运行后内存无界增长。
 */
const handledInstalls = new Set()

/**
 * install-state 触发时：在「装插件前」存一份快照。
 *
 * @param {{home: string, profile: string}} ctxInfo
 * @param {{requestId?: string, phase?: string, index?: number, total?: number}} payload
 */
function onInstallState(ctxInfo, payload) {
  // 只在真正的「开始安装」阶段动作
  if (payload?.phase !== 'installing') return

  const requestId = payload?.requestId
  if (!requestId) return                      // 没有 requestId 就没法去重，跳过

  // 去重：同一次安装只存一份「装前」
  if (handledInstalls.has(requestId)) return

  // 上限保护
  if (handledInstalls.size >= 50) {
    const first = handledInstalls.values().next().value
    handledInstalls.delete(first)
  }
  handledInstalls.add(requestId)

  const { home, profile } = ctxInfo
  const root = C.snapshotDir(home, profile)
  const profileDir = join(home, 'profiles', profile)

  try {
    // ① 体检（记录「装前」的健康状态，供事后对比）
    const report = safeRunValue('install-pre-check',
      () => runCheck({ home, profile, dshVersion: DSH_VERSION }), null)

    // ② 判重 —— ⚠️ 这里不能用「指纹相同就跳过」（2026-10-19 实测踩过）
    //
    //   原因：启动钩子每天会建 daily 快照，如果用户在「刚启动后」装插件，
    //        当前指纹与那份 daily 完全相同 → 去重逻辑会误判成「不用建」，
    //        结果「装插件前」这份关键快照【永远不出现】。
    //
    //   正确判据：只有当「已经有一份【装插件前】快照」且它的指纹也相同时，
    //            才跳过。daily 不算数 —— 它的语义是「当天首启」，不是「装前」。
    //
    //   为什么不能只看「有没有装前快照」：
    //     用户可能连装多个插件，每次都需要新的「装前」基准点。
    //     所以用「最新一份装前快照的指纹」比对。
    const fp = C.fingerprint(profileDir)
    const idx = C.readIndex(root)
    const preSnaps = (idx.entries ?? []).filter((e) => /^装插件前 /.test(String(e.name ?? '')))
    const lastPre = preSnaps
      .slice().sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))[0]
    if (lastPre && lastPre.fingerprint === fp.aggregate) {
      // 上一次「装前」快照和现在内容一致 → 确实不用重复
      return
    }

    // ③ 存快照
    const now = new Date()
    const p2 = (v) => String(v).padStart(2, '0')
    const hhmm = `${p2(now.getHours())}:${p2(now.getMinutes())}`
    const attempt = payload.index && payload.total
      ? `（第 ${payload.index}/${payload.total} 次尝试）`
      : ''

    C.createSnapshot({
      home, profile, type: 'manual',
      origin: 'auto',                    // ⭐ 检测到安装动作自动留痕
      name: `装插件前 ${C.localDate()} ${hhmm}`,
      note: `检测到即将安装插件，自动留痕${attempt}`,
      dshVersion: DSH_VERSION,
      health: report ?? { overall: 'unknown', counts: {}, issues: [] },
    })
    C.pruneSnapshots(root, { currentFingerprint: fp.aggregate })

    // ④ 记一条日志（装前不写 errors.log 的 error，用 warn 记录事实即可）
    //    只有体检本来就有问题才写 —— 没问题就不污染日志
    if ((report?.problems ?? []).length > 0) {
      try {
        logError(root, {
          level: 'warn',
          source: 'install-pre',
          op: 'installing',
          message: `装插件前已自动留痕一份快照；装前体检有 ${report.problems.length} 个问题`,
          context: {
            requestId,
            verdict: report.verdict,
            problems: (report.problems ?? []).slice(0, 3).map((x) => ({
              code: x.code, severity: x.severity,
            })),
          },
        })
      } catch { /* 忽略 */ }
    }
  } catch (e) {
    try {
      logError(root, {
        level: 'error',
        source: 'install-pre',
        op: 'installing',
        message: `装插件前建快照失败: ${e?.message ?? e}`,
        error: e instanceof Error ? e : undefined,
        context: { requestId },
      })
    } catch { /* 忽略 */ }
  }
}

// ─────────────────────────────────────────────────────────────
// 插件管理事件钩子（2026-10-19 新增）
// ─────────────────────────────────────────────────────────────

/** reason 的中文说明（源码取值：install / remove / bundle / plugin）。 */
const PM_REASON_TEXT = {
  install: '安装插件',
  remove: '移除插件',
  bundle: '启用/禁用 bundle',
  plugin: '启用/禁用插件',
}

/**
 * 插件管理发生变化时：立刻存快照 + 体检 + 记录。
 *
 * @param {{home: string, profile: string}} ctxInfo
 * @param {{reason?: string}} payload
 */
function onPluginManagerChanged(ctxInfo, payload) {
  const { home, profile } = ctxInfo
  const root = C.snapshotDir(home, profile)
  const profileDir = join(home, 'profiles', profile)

  const reason = payload?.reason ?? 'unknown'
  const reasonText = PM_REASON_TEXT[reason] ?? reason

  // ① 体检（这次不是为了健康分级，是为了「装完立刻知道有没有事」）
  const report = safeRunValue('plugin-changed-check',
    () => runCheck({ home, profile, dshVersion: DSH_VERSION }), null)

  // ② 立刻存一份快照（类型用 manual，但名字标出来源）
  try {
    const fp = C.fingerprint(profileDir)
    const idx = C.readIndex(root)
    idx.sched = idx.sched ?? {}

    // 内容没变就不重复建（比如 DSH 内部刷新触发的事件）
    const latest = (idx.entries ?? [])
      .slice().sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))[0]
    if (latest && latest.fingerprint === fp.aggregate) {
      // 内容相同 → 只更新体检记录，不建快照
      recordPluginChange(root, reason, reasonText, report, true)
      return
    }

    const now = new Date()
    const p2 = (n2) => String(n2).padStart(2, '0')
    const hhmm = `${p2(now.getHours())}:${p2(now.getMinutes())}`

    C.createSnapshot({
      home, profile, type: 'manual',
      origin: 'auto',                    // ⭐
      name: `${reasonText}后 ${C.localDate()} ${hhmm}`,
      note: `插件管理事件自动留痕（reason: ${reason}）`,
      dshVersion: DSH_VERSION,
      health: report ?? { overall: 'unknown', counts: {}, issues: [] },
    })

    // ③ rolling 计时基准也要更新，避免 turn/end 立刻又建一份相同的
    C.updateIndex(root, (i2) => {
      i2.sched = i2.sched ?? {}
      i2.sched.lastRollingAt = Date.now()
      i2.sched.lastRollingFingerprint = fp.aggregate
    })
    C.pruneSnapshots(root, { currentFingerprint: fp.aggregate })

    recordPluginChange(root, reason, reasonText, report, false)
  } catch (e) {
    try {
      logError(root, {
        level: 'error',
        source: 'plugin-changed',
        op: reason,
        message: `插件管理事件后建快照失败: ${e?.message ?? e}`,
        error: e instanceof Error ? e : undefined,
      })
    } catch { /* 忽略 */ }
  }
}

/**
 * 把这次插件变更记进 errors.log（不是错误，但用户需要知道发生了什么）。
 *
 * level 的选择：
 *   · 体检有 fatal/error → 记 error（用户真的需要处理）
 *   · 其他              → 记 info 级别（用 warn 通道，因为 errors.log 只收 warn/error/fatal）
 */
function recordPluginChange(root, reason, reasonText, report, skippedSnapshot) {
  try {
    const problems = report?.problems ?? []
    const hasProblem = (report?.counts?.fatal ?? 0) > 0 || problems.length > 0

    // 没问题就不写日志（避免污染）
    if (!hasProblem) return

    logError(root, {
      level: (report?.counts?.fatal ?? 0) > 0 ? 'error' : 'warn',
      source: 'plugin-changed',
      op: reason,
      message: `${reasonText}后体检发现 ${problems.length} 个问题`
        + (report?.counts?.fatal > 0 ? `（含 ${report.counts.fatal} 个致命）` : '')
        + (skippedSnapshot ? '。配置内容未变，未重复建快照。' : '。已自动留痕一份快照。'),
      context: {
        reason,
        verdict: report?.verdict,
        problems: problems.slice(0, 5).map((x) => ({
          code: x.code, severity: x.severity, message: x.message,
        })),
      },
    })
  } catch { /* 忽略 */ }
}

// ─────────────────────────────────────────────────────────────
// 启动钩子
// ─────────────────────────────────────────────────────────────

/**
 * 本次进程内是否已经跑过启动钩子。
 *
 * ⚠️ 同样因为 apply() 可能被多次调用 —— 启动钩子若重复跑，
 *    会给 boot-log 写重复记录、甚至重复建 daily。
 */
let startupRan = false

function onStartup({ home, profile }, ctxLocal) {
  if (startupRan) return
  startupRan = true

  const root = C.snapshotDir(home, profile)
  const profileDir = join(home, 'profiles', profile)

  // 探测 DSH 版本
  DSH_VERSION = detectDshVersion(home, profile)

  // ① 体检（用于健康分级）
  const report = safeRunValue('startup-check',
    () => runCheck({ home, profile, dshVersion: DSH_VERSION }), null)

  // ② 算指纹
  const fp = C.fingerprint(profileDir)

  // ③ 写 boot-log（按指纹记，供 verified 判定）
  C.appendBootLog(root, {
    at: Date.now(),
    fingerprint: fp.aggregate,
    result: report && report.counts.fatal > 0 ? 'fail' : 'ok',
    dshVersion: DSH_VERSION,
    health: report?.overall ?? 'unknown',
    changedFiles: [],
  })

  // ④ 记启动基线（供条目数比对）
  try {
    const patchPath = join(profileDir, 'cordis.patch.yml')
    if (existsSync(patchPath)) {
      const text = readFileSync(patchPath, 'utf8')
      C.writeJsonAtomic(join(root, 'launch-baseline.json'), {
        at: Date.now(),
        entryCount: patchEntryCount(text),
        fingerprint: fp.aggregate,
        dshVersion: DSH_VERSION,
      })
    }
  } catch { /* 忽略 */ }

  // ⑤ 当天第一次启动 → 建 daily 快照
  try {
    const idx0 = C.readIndex(root)
    const today = C.localDate()
    if (idx0.sched?.lastDailyDate !== today) {
      C.createSnapshot({
        home, profile, type: 'daily',
        origin: 'auto',                    // ⭐ 钩子自动创建，不是 AI 也不是用户
        dshVersion: DSH_VERSION,
        name: `每日快照 ${today}`,
        health: report ?? { overall: 'unknown', counts: {}, issues: [] },
      })
      // ⚠️ 必须【重新读】索引，不能在 createSnapshot 之前读的旧对象上改完再写回。
      // 那样写回的是「不含刚建 daily 条目」的旧数组，daily 会被从索引里抹掉
      // —— 目录建成了、列表里却看不到。（2026-10-19 实际踩过这个坑）
      C.updateIndex(root, (idx) => {
        idx.sched = idx.sched ?? {}
        // ⭐ 同时初始化 rolling 计时基准，避免首启就多建一份相同的 rolling
        idx.sched.lastDailyDate = today
        idx.sched.lastRollingAt = Date.now()
        idx.sched.lastRollingFingerprint = fp.aggregate
      })
      C.pruneSnapshots(root)
    }
  } catch { /* 忽略 */ }

  // ⑥ 自动固化：把当天的 daily 快照同步到 .bat 的数据源
  //
  // ⚠️ 2026-10-20 用户裁定：
  //   「.bat 只能是使用固化的副本，快照什么样子不归他管。
  //    因为 .bat 是最大的底牌，最后的兜底！不能去依赖快照，
  //    每天启动的快照自动作为固化给 .bat 脚本」
  //
  // 所以每次启动都要把「最新的健康 daily」复制到 fixed/bat-default/，
  // 让 .bat 永远有一份独立于快照池的数据。
  //
  // 为什么放在 daily 创建之后：确保刚建的 daily 能被固化过去。
  try {
    const fix = C.autoFixDaily(root)
    if (fix.updated) {
      safeLog(ctxLocal, 'auto-fix-daily', null, fix.reason)
    }
  } catch { /* 固化失败不能让启动钩子中断 */ }
}

// ─────────────────────────────────────────────────────────────
// turn/end 钩子
// ─────────────────────────────────────────────────────────────

function onTurnEnd({ home, profile }, session, event) {
  const root = C.snapshotDir(home, profile)
  const profileDir = join(home, 'profiles', profile)

  const idx = C.readIndex(root)
  idx.sched = idx.sched ?? {}

  // 条件一：距上次 ≥ 2 小时
  const now = Date.now()
  const last = idx.sched.lastRollingAt ?? 0
  if (now - last < C.ROLLING_INTERVAL_MS) return

  // 条件二：内容有变化
  const fp = C.fingerprint(profileDir)
  if (fp.aggregate === idx.sched.lastRollingFingerprint) return    // 内容没变 → 跳过

  // 建 rolling
  C.createSnapshot({
    home, profile, type: 'rolling',
    origin: 'auto',                      // ⭐
    dshVersion: DSH_VERSION,
    name: C.defaultName('rolling', C.makeSnapshotId()),
    health: { overall: 'unknown', counts: {}, issues: [] },
  })
  // ⚠️ 同上：重新读索引，别拿 createSnapshot 之前的旧对象覆盖写回
  C.updateIndex(root, (idx) => {
    idx.sched = idx.sched ?? {}
    idx.sched.lastRollingAt = now
    idx.sched.lastRollingFingerprint = fp.aggregate
  })
  C.pruneSnapshots(root)
}

// ─────────────────────────────────────────────────────────────
// HTTP 端点
// ─────────────────────────────────────────────────────────────

/**
 * 已注册过路由的 webServer 实例（WeakSet）。
 *
 * ⚠️ 2026-10-19 实测发现的 bug：
 *   DSH 的 Fiber 机制会让 apply() 被调用多次（同一进程内重复挂载），
 *   每次都重新注册全部路由 → dsh-host-webserver 抛
 *     "webserver: duplicate exact route ..."
 *   被我的 try/catch 挡住不会崩，但**每次启动都往 errors.log 写 15 条错误**。
 *
 *   用 WeakSet 记住「这个 webServer 实例已经注册过」，
 *   重复挂载时直接跳过。WeakSet 不会阻止实例被回收。
 */
const registeredServers = new WeakSet()

function registerRoutes(ctx, ctxInfo) {
  // 与 dsh-fk-restart-button 一致：用 ctx.webServer 直接取服务
  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  if (!webServer?.register) return

  // 幂等：同一个 webServer 实例只注册一次
  if (registeredServers.has(webServer)) return
  registeredServers.add(webServer)

  const base = '/plugins/dsh-fk-rollback'
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => { s += c })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch { resolve({}) } })
  })

  // ── GET /info ── 体检 + 状态
  const infoHandler = async (req, res) => {
    try {
      if (req.method !== 'GET') return json(res, 405, { error: 'only GET' })
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)
      const report = runCheck({ home, profile, dshVersion: DSH_VERSION })
      const idx = C.readIndex(root)
      const bootLog = C.readBootLog(root)

      // 决定 5/6：● 当前状态 = 5 文件 SHA256 全等，且只标最新那一个
      const cur = currentFingerprint(ctxInfo)
      const entries = (idx.entries ?? []).map((e) => ({
        ...e,
        grade: C.computeGrade(e, bootLog),
        isCurrent: cur.aggregate !== null && e.fingerprint === cur.aggregate,
      }))
      // 只给最新的那一个打 ●
      const sameFp = entries.filter((e) => e.isCurrent)
        .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
      for (const e of entries) e.isCurrent = sameFp.length > 0 && e.id === sameFp[0].id

      // 决定 24：未重启提醒 —— 回滚后当前指纹变了，但还没被 boot-log 记录
      const lastBoot = (bootLog.records ?? []).slice(-1)[0]
      const pendingRestart = Boolean(
        idx.sched?.rolledBackAt
        && (!lastBoot || lastBoot.at < idx.sched.rolledBackAt),
      )

      const total = entries.reduce((s, e) => s + (e.size ?? 0), 0)
      return json(res, 200, {
        profile,
        dshVersion: DSH_VERSION,
        check: report,
        entries,
        total,
        dir: root,
        pendingRestart,
        rolledBackAt: idx.sched?.rolledBackAt ?? null,
        policy: idx.policy ?? { maxCheckpoints: 50, maxDays: 30 },
        // ⭐ 固化状态（.bat 用的那份固定数据源）
        fixed: C.readFixedSlot(root),
        // ⭐ 路径信息（面板上显示 .bat 脚本在哪 —— 用户要求）
        paths: (() => {
          try {
            const pluginDir = dirname(fileURLToPath(import.meta.url))
            return {
              pluginDir,
              batPath: join(pluginDir, '还原DSH配置.bat'),
              scriptPath: join(pluginDir, 'dsh-rollback.mjs'),
              snapshotRoot: root,
              fixedDir: C.fixedDir(root),
              nodeExe: process.execPath,
            }
          } catch { return null }
        })(),
      })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  // ── POST /snapshot ── 手动创建
  const snapshotHandler = async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 405, { error: 'only POST' })
      const body = await readBody(req)
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)

      // 决定 7：重复创建警告 —— 当前指纹与最新快照相同则提示（除非用户确认）
      if (!body.force) {
        const cur = currentFingerprint(ctxInfo)
        const idx0 = C.readIndex(root)
        const latest = (idx0.entries ?? [])
          .slice().sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))[0]
        if (latest && cur.aggregate && latest.fingerprint === cur.aggregate) {
          return json(res, 200, {
            needConfirm: true,
            latestName: latest.name,
            latestAt: latest.createdAtMs,
            message: '当前配置与最新的快照完全一致，再建一份内容会重复。',
          })
        }
      }

      const report = runCheck({ home, profile, dshVersion: DSH_VERSION })
      const r = C.createSnapshot({
        home, profile, type: 'manual',
        name: body.name, note: body.note,
        dshVersion: DSH_VERSION,
        health: { overall: report.overall, counts: report.counts, issues: report.issues.slice(0, 20) },
      })

      // 状态部分已由 C.createSnapshot 内部自动纳入（2026-10-22 用户裁定）：
      // 一次 createSnapshot 同时抓配置 + Electron 状态，不再需要单独备份。

      C.pruneSnapshots(root)
      // 把状态信息告诉面板（2026-10-22：不再传「完整度」，Cookies 不进快照）
      const es = r.meta?.estate
      return json(res, 200, {
        ok: true,
        id: r.id,
        bytes: r.bytes,
        name: C.defaultName('manual', r.id),
        estate: es
          ? {
            included: Boolean(es.included),
            bytes: es.bytes ?? 0,
            entries: (es.entries ?? []).length,
          }
          : null,
      })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  // ── POST /restore ── 还原（必须显式 POST，绝不自动）
  const restoreHandler = async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 405, { error: 'only POST' })
      const body = await readBody(req)
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)

      // 解析目标快照
      let target = null
      let pickWhy = ''
      if (body.id) {
        const idx = C.readIndex(root)
        target = (idx.entries ?? []).find((x) => x.id === body.id)
        if (!target) return json(res, 404, { error: `找不到快照：${body.id}` })
        pickWhy = '用户指定'
      } else {
        const bootLog = C.readBootLog(root)
        const pick = C.pickLastGood(root, home, profile, bootLog)
        if (!pick) return json(res, 404, { error: '找不到可用快照' })
        target = pick.entry
        pickWhy = `${pick.level} —— ${pick.reason}`
      }

      // 决定 26/27：算四分区清单（用于确认框，也用于 dry-run）
      const plan = buildRestorePlan(ctxInfo, root, target)

      if (body.dryRun) {
        return json(res, 200, { dryRun: true, target, plan, reason: pickWhy })
      }

      // ── 回滚前快照（2026-10-20 用户要求：单独存放 + 说明是哪次回滚）──
      //
      // 用户原话：「回滚后，会生成一个回滚前的快照，我建议把这一栏单独存放，
      //           并且说明是某某时间段的回滚」
      //
      // 所以：
      //   · 存到独立的 restore-points/ 目录（不再混在 checkpoints/）
      //   · 名字里写明「回滚到哪份」
      //   · meta 里记录前后状态，供 UI 展示完整来龙去脉
      const hhmm = (() => {
        const d = new Date()
        const p = (x) => String(x).padStart(2, '0')
        return p(d.getHours()) + ':' + p(d.getMinutes())
      })()
      const before = C.createSnapshot({
        home, profile, type: 'before-restore',
        origin: 'auto',                  // ⭐ 回滚流程自动存的安全副本
        name: `回滚前 ${C.localDate()} ${hhmm}`,
        note: `回滚到「${target.name}」（${pickWhy}）之前的状态`,
        dshVersion: DSH_VERSION,
        health: { overall: 'unknown', counts: {}, issues: [] },
        // ⭐ 记录回滚详情 —— UI 靠它说明「这是哪次回滚的现场」
        restoreInfo: {
          at: Date.now(),
          targetId: target.id,
          targetName: target.name,
          reason: pickWhy,
        },
      })

      const snapDir = join(root, target.dir)
      let r
      try {
        r = C.restoreSnapshot({ home, profile, snapshotDir: snapDir })
      } catch (err) {
        // 还原失败是最严重的场景，必须留下完整记录
        try {
          logError(root, {
            level: 'fatal',
            source: 'restore',
            op: 'restore',
            message: `还原到快照「${target.name}」（${target.id}）失败：${err?.message ?? err}`,
            error: err instanceof Error ? err : undefined,
            context: { targetId: target.id, targetName: target.name, snapshotDir: snapDir },
          })
        } catch { /* 忽略 */ }
        throw err
      }
      const after = runCheck({ home, profile, dshVersion: DSH_VERSION })

      // 决定 24：记录回滚时刻 → 供「未重启提醒」判定
      if (r.failed.length === 0) {
        C.updateIndex(root, (idx2) => {
          idx2.sched = idx2.sched ?? {}
          idx2.sched.rolledBackAt = Date.now()
        })
      }

      return json(res, 200, {
        ok: r.failed.length === 0,
        restored: r.restored,
        failed: r.failed,
        beforeId: before.id,
        targetName: target.name,
        plan,
        check: after,
        needRestart: r.failed.length === 0,
      })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  // ── GET /trace ── 溯源
  const traceHandler = async (req, res, url) => {
    try {
      if (req.method !== 'GET') return json(res, 405, { error: 'only GET' })
      const file = url?.searchParams?.get('file') ?? undefined
      const days = Number(url?.searchParams?.get('days') ?? 7)
      const r = traceFile({ home: ctxInfo.home, file, days })
      return json(res, 200, { ...r, hits: r.hits.slice(0, 200) })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  // ── GET /sessions ── 会话列表
  const sessionsHandler = async (req, res, url) => {
    try {
      if (req.method !== 'GET') return json(res, 405, { error: 'only GET' })
      const days = Number(url?.searchParams?.get('days') ?? 7)
      const list = listSessionSummaries(ctxInfo.home, { days })
      return json(res, 200, { sessions: list.slice(0, 100) })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  // ── GET /restart-helper ── 探测重启插件是否在（供「立即重启」按钮）
  //
  // ⚠️ 2026-10-20 用户反馈：「现在重启按钮是灰的，无法点击」
  //
  // 根因：旧实现只在 cordis.patch.yml 文本里 grep 插件名，
  //      但 dsh-fk-restart-button 是通过 profile 的【bundles】注册的，
  //      patch 里根本没有它的名字 → 探测永远返回 false → 按钮永远灰。
  //
  // 修法：以 bundles / dependencies 为准（那才是真实的安装证据），
  //      patch 只作为兜底。
  // ── GET /restart-helper ── 探测重启能力
  //
  // ⚠️ 2026-10-20 v1.3.0：不再依赖外部插件
  //   用户要求「发布出去，不可能要人安装套装吧，必须按个重启插件」
  //   → 重启能力已经内置到 lib/restart.mjs，自我探测即可。
  const restartInfoHandler = async (req, res) => {
    try {
      if (req.method !== 'GET') return json(res, 405, { error: 'only GET' })

      const probe = R.probeRestartCapability()

      // 顺带把端口记下来（后面真重启时用）
      try { R.setPort(R.discoverPort(req)) } catch { /* 忽略 */ }

      return json(res, 200, {
        available: probe.available,
        reason: probe.reason ?? null,
        // 内置重启，没有外部依赖
        builtin: true,
        target: probe.target ?? null,
        bootToken: R.BOOT_TOKEN,
        endpoint: '/plugins/dsh-fk-rollback/restart',
      })
    } catch (e) {
      return json(res, 500, { available: false, error: String(e?.message ?? e) })
    }
  }

  // ── POST /restart ── 转发重启请求到重启插件
  //
  // 为什么由我们转发、而不是让浏览器直接调重启插件：
  //   · 保持前端只有一个 API 前缀（/plugins/dsh-fk-rollback/*）
  //   · 重启插件可能不在（未安装），这里能给出统一的可读错误
  //   · 未来若重启实现变化，只改这一处
  //
  // ⚠️ 重启插件要求 POST（GET 会 405），这里用 POST 转发。
  // ── POST /restart ── 重启 DSH（内置实现，零外部依赖）
  //
  // ⚠️ 2026-10-20 v1.3.0：从「转发到 dsh-fk-restart-button」改为【内置】。
  //   原实现的三个问题：
  //     · 用户必须额外装一个重启插件 → 发布场景不可接受
  //     · 转发要处理超时/端口/新旧路由 → 复杂且易错（实测最坏 20.6 秒）
  //     · 外部插件不在时只能报错
  //   现在直接用 lib/restart.mjs：WMI 创建助手 → taskkill /T 杀树 → 自动重开。
  //
  // 响应会在助手真正动手（~1.2 秒宽限期）之前返回，
  // 前端收到 ok 后应立即提示「正在重启」，不要等连接断开。
  const restartHandler = async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'only POST' })

      const probe = R.probeRestartCapability()
      if (!probe.available) {
        return json(res, 409, {
          ok: false,
          error: trimSentence(probe.reason)
            + ' 配置已经写好，手动关闭 DSH 再打开即可生效。',
          builtin: true,
          hint: 'manual',
        })
      }

      // 端口：优先用请求头里的真实端口（有些构建不传 --port）
      const port = R.discoverPort(req)
      R.setPort(port)

      const r = await R.requestRestart({ req, port })
      if (!r.ok) {
        return json(res, 500, {
          ok: false,
          error: trimSentence(r.error) + ' 配置已经写好，手动关闭 DSH 再打开即可生效。',
          builtin: true,
          hint: 'manual',
          detail: r.detail,
        })
      }

      return json(res, 200, {
        ok: true,
        builtin: true,
        helperPid: r.helperPid,
        detail: r.detail,
        hint: '正在重启 DSH —— 窗口会短暂关闭后自动重开',
        // 助手在这之后约 1.2 秒动手；前端可据此安排提示
        graceMs: r.detail?.graceMs ?? 1200,
      })
    } catch (e) {
      return json(res, 500, {
        ok: false,
        error: trimSentence(String(e?.message ?? e)) + ' 可以手动关闭 DSH 再打开。',
        builtin: true,
      })
    }
  }

  // ── POST /rename ── 重命名 / 备注（决定 2、3）
  const renameHandler = async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 405, { error: 'only POST' })
      const body = await readBody(req)
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)
      const id = body.id
      if (!id) return json(res, 400, { error: '缺少快照 id' })

      const idx = C.readIndex(root)
      const e = (idx.entries ?? []).find((x) => x.id === id)
      if (!e) return json(res, 404, { error: `找不到快照：${id}` })

      // 决定 43：每日快照不可重命名（名字锁定为「每日快照 YYYY-MM-DD」）
      if (e.type === 'daily' && body.name !== undefined) {
        return json(res, 400, { error: '每日快照不可重命名（名字由日期决定）' })
      }

      // 决定 19：名称 50 字、备注 500 字
      let name = body.name
      let note = body.note
      if (typeof name === 'string') {
        name = name.trim().slice(0, 50)
        if (name === '') return json(res, 400, { error: '名称不能为空' })
      }
      if (typeof note === 'string') note = note.trim().slice(0, 500)

      // §2.11：改名时也去重（排除自己，否则改回原名会被加序号）
      if (name !== undefined) name = C.dedupeName(root, name, id)

      // 更新 meta.json 与索引（两边都要，否则详情页与列表不一致）
      const snapDir = join(root, e.dir)
      const metaPath = join(snapDir, 'meta.json')
      if (existsSync(metaPath)) {
        const meta = C.readJson(metaPath) ?? {}
        if (name !== undefined) meta.name = name
        if (note !== undefined) meta.note = note
        C.writeJsonAtomic(metaPath, meta)
      }
      C.updateIndex(root, (i2) => {
        const t = (i2.entries ?? []).find((x) => x.id === id)
        if (!t) return
        if (name !== undefined) t.name = name
        if (note !== undefined) t.note = note
      })
      return json(res, 200, { ok: true, id, name, note })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  // ── POST /delete ── 删除快照（决定 21、22）
  const deleteHandler = async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 405, { error: 'only POST' })
      const body = await readBody(req)
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)
      const id = body.id
      if (!id) return json(res, 400, { error: '缺少快照 id' })
      if (!body.confirmed) return json(res, 400, { error: '需要 confirmed: true' })

      const idx = C.readIndex(root)
      const e = (idx.entries ?? []).find((x) => x.id === id)
      if (!e) return json(res, 404, { error: `找不到快照：${id}` })

      // 决定 21：删除「当前状态那一份」需要额外确认
      const cur = currentFingerprint(ctxInfo)
      const isCurrent = e.fingerprint === cur.aggregate
      if (isCurrent && !body.force) {
        return json(res, 409, {
          error: '这是当前配置状态的快照。删掉它会失去「回到现在」的还原点。',
          needsForce: true,
        })
      }

      const dir = join(root, e.dir)
      try { rmSync(dir, { recursive: true, force: true }) } catch (err) {
        return json(res, 500, { error: `删除目录失败：${err.message}` })
      }
      C.updateIndex(root, (i2) => {
        i2.entries = (i2.entries ?? []).filter((x) => x.id !== id)
      })
      return json(res, 200, { ok: true, id })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  // ── POST /policy ── 保留策略（决定 30）
  const policyHandler = async (req, res) => {
    try {
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)
      if (req.method === 'GET') {
        const idx = C.readIndex(root)
        return json(res, 200, { policy: idx.policy ?? { maxCheckpoints: 50, maxDays: 30 } })
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' })
      const body = await readBody(req)
      const maxCheckpoints = Number(body.maxCheckpoints)
      const maxDays = Number(body.maxDays)
      if (!Number.isFinite(maxCheckpoints) || maxCheckpoints < 1) {
        return json(res, 400, { error: 'maxCheckpoints 至少为 1' })
      }
      if (!Number.isFinite(maxDays) || maxDays < 1) {
        return json(res, 400, { error: 'maxDays 至少为 1' })
      }
      C.updateIndex(root, (i2) => { i2.policy = { maxCheckpoints, maxDays } })
      return json(res, 200, { ok: true, policy: { maxCheckpoints, maxDays } })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  // ── POST /export ── 导出快照（决定 32：文件夹复制）
  const exportHandler = async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 405, { error: 'only POST' })
      const body = await readBody(req)
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)
      const id = body.id
      if (!id) return json(res, 400, { error: '缺少快照 id' })

      const idx = C.readIndex(root)
      const e = (idx.entries ?? []).find((x) => x.id === id)
      if (!e) return json(res, 404, { error: `找不到快照：${id}` })

      const src = join(root, e.dir)

      // §2.17（用户裁定）：
      //   · 默认导出到【插件目录】下的 exports\，不是 $DSH_HOME
      //   · 文件名用【完整 ID】，不用 ID_名称 拼接
      //   理由：导出是「本机临时备份」，插件卸载时一起消失是预期行为。
      const pluginDir = join(dirname(fileURLToPath(import.meta.url)))
      const destDir = body.dest || join(pluginDir, 'exports')
      mkdirSync(destDir, { recursive: true })
      const dest = join(destDir, e.id)
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      cpSync(src, dest, { recursive: true })

      // 统计实际复制了什么（供「进度提示」用）
      const copied = []
      for (const f of C.SNAPSHOT_FILES) {
        const fp2 = join(dest, f)
        if (existsSync(fp2)) copied.push({ file: f, size: statSync(fp2).size })
      }
      return json(res, 200, {
        ok: true,
        dest,
        copied,
        totalBytes: copied.reduce((s2, x) => s2 + x.size, 0),
        hint: '导出在插件目录下，卸载插件时会一起消失（这是预期行为）',
      })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  // ── GET /health-history ── 体检历史（决定 17）
  const healthHistoryHandler = async (req, res) => {
    try {
      if (req.method !== 'GET') return json(res, 405, { error: 'only GET' })
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)
      const p = join(root, 'health-history.jsonl')
      const records = []
      if (existsSync(p)) {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          if (!line.trim()) continue
          try { records.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
        }
      }
      return json(res, 200, { records: records.slice(-50).reverse() })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }


  // ── POST /acknowledge ── 确认可接受 / 取消确认（§3.5 + §2.16b）
  const ackHandler = async (req, res) => {
    try {
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)

      if (req.method === 'GET') {
        return json(res, 200, { acknowledged: C.readAcknowledged(root) })
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' })

      const body = await readBody(req)
      const code = body.code
      if (!code) return json(res, 400, { error: '缺少 code' })
      const key = body.key ?? body.package ?? body.entryId ?? '*'

      const data = C.readAcknowledged(root)

      // 取消确认
      if (body.remove) {
        if (data[code]) {
          delete data[code][key]
          if (Object.keys(data[code]).length === 0) delete data[code]
        }
        C.writeAcknowledged(root, data)
        return json(res, 200, { ok: true, removed: true })
      }

      // 新增/更新确认
      const reason = String(body.reason ?? '').trim().slice(0, 200)
      if (!reason) return json(res, 400, { error: '请填写理由' })

      // 算签名（§3.5：文件变化后确认自动失效）
      const profileDir = join(home, 'profiles', profile)
      const sig = C.issueSignature(
        { code, package: body.package, entryId: body.entryId, file: body.file },
        profileDir,
      )

      data[code] = data[code] ?? {}
      data[code][key] = {
        ackedAt: new Date().toISOString(),
        reason,
        signature: sig,
      }
      C.writeAcknowledged(root, data)
      return json(res, 200, { ok: true, signature: sig })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }


  // ── GET /config-changes ── 用户视角的配置改动时间线（2026-10-19 新增）
  //
  // 与 /trace 的区别：
  //   /trace          = 原始事件（保留给高级用户/diagnose 用）
  //   /config-changes = 只回答「我的配置文件被谁改过」，三层过滤 + 人话摘要
  const configChangesHandler = async (req, res, url) => {
    try {
      if (req.method !== 'GET') return json(res, 405, { error: 'only GET' })
      const days = Number(url?.searchParams?.get('days') ?? 7)
      const file = url?.searchParams?.get('file') || undefined
      const r = configTimeline({ home: ctxInfo.home, days, file })
      return json(res, 200, r)
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }


  // ── GET /errors ── 读错误日志（新的在前）
  const errorsHandler = async (req, res, url) => {
    try {
      if (req.method === 'GET') {
        const root = C.snapshotDir(ctxInfo.home, ctxInfo.profile)
        const limit = Number(url?.searchParams?.get('limit') ?? 100)
        const r = readErrorLog(root, { limit })
        return json(res, 200, r)
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' })

      // POST：记录一条「前端捕获到的错误」
      const body = await readBody(req)
      const root = C.snapshotDir(ctxInfo.home, ctxInfo.profile)
      logError(root, {
        level: body.level || 'error',
        source: body.source || 'client',
        op: body.op || 'unknown',
        message: body.message,
        error: body.stack,
        context: body.context,
      })
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  // ── GET/POST /diagnostic ── 生成诊断报告（用户可直接发给开发者）
  const diagnosticHandler = async (req, res, url) => {
    try {
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)

      const check = runCheck({ home, profile, dshVersion: DSH_VERSION })
      const index = C.readIndex(root)
      let timeline = { changes: [] }
      try { timeline = configTimeline({ home, days: 7 }) } catch { /* 忽略 */ }

      const text = buildDiagnosticBundle({
        root, home, profile,
        dshVersion: DSH_VERSION,
        check, index, timeline,
      })

      // GET：直接返回文本（前端可展示/复制）
      if (req.method === 'GET') {
        const wantFile = url?.searchParams?.get('file') === '1'
        if (wantFile) {
          const p = writeDiagnosticBundle(root, text)
          return json(res, 200, { ok: true, path: p, text })
        }
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(text)
        return
      }
      // POST：写成文件
      if (req.method === 'POST') {
        const p = writeDiagnosticBundle(root, text)
        return json(res, 200, { ok: true, path: p, bytes: Buffer.byteLength(text) })
      }
      return json(res, 405, { error: 'GET or POST' })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }


  // ── /fix ── 固化：把某个快照做成 .bat 的固定数据源（2026-10-20）
  //
  // 用户诉求：「用户可以在快照列表，选择某个快照制作成 .bat」
  //
  // 语义：
  //   · 把快照的 5 个文件【复制】到 fixed/bat-default/
  //   · 固化区不参与快照池的自动清理
  //   · 池子里的原快照被顶掉，也不影响 .bat
  //   · 随时可以取消（恢复成「.bat 走快照池」）
  const fixHandler = async (req, res) => {
    try {
      const { home, profile } = ctxInfo
      const root = C.snapshotDir(home, profile)

      // GET → 查看当前固化状态
      if (req.method === 'GET') {
        const slot = C.readFixedSlot(root)
        const slots = C.listFixedSlots(root)
        return json(res, 200, { current: slot, all: slots })
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' })

      const body = await readBody(req)

      // 取消固化
      if (body.remove) {
        const r = C.unfixSlot(root, body.slot)
        return json(res, 200, { ok: true, removed: r.removed })
      }

      // ⭐ 2026-10-23：只切换钉住状态（不动文件）
      if (body.togglePin) {
        const slot = body.slot ?? C.FIXED_SLOT_DEFAULT
        const cur = C.readFixedSlot(root, slot)
        if (!cur) return json(res, 400, { error: '当前没有固化副本' })
        const mp = join(C.fixedSlotDir(root, slot), 'meta.json')
        const meta = C.readJson(mp) ?? {}
        meta.pin = body.togglePin === 'on'
        C.writeJsonAtomic(mp, meta)
        return json(res, 200, { ok: true, pin: meta.pin, fromName: meta.fromName })
      }

      // 固化指定快照
      const id = body.id
      if (!id) return json(res, 400, { error: '缺少快照 id' })

      const idx = C.readIndex(root)
      const e = (idx.entries ?? []).find((x) => x.id === id)
      if (!e) return json(res, 404, { error: `找不到快照：${id}` })

      let r
      try {
        // body.pin 为 true 时钉住；默认不钉住（跟随当天 daily）
        r = C.fixSnapshot({ root, entry: e, slot: body.slot, pin: body.pin === true })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) })
      }
      return json(res, 200, {
        ok: true,
        slot: r.slot,
        fromName: r.fromName,
        files: r.files,
        bytes: r.bytes,
        dir: r.dir,
        pin: body.pin === true,
      })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  }

  const routes = [
    ['/fix', fixHandler, 'exact'],
    ['/errors', errorsHandler, 'exact'],
    ['/diagnostic', diagnosticHandler, 'exact'],
    ['/config-changes', configChangesHandler, 'exact'],
    ['/acknowledge', ackHandler, 'exact'],
    ['/info', infoHandler, 'exact'],
    ['/snapshot', snapshotHandler, 'exact'],
    ['/restore', restoreHandler, 'exact'],
    ['/trace', traceHandler, 'exact'],
    ['/sessions', sessionsHandler, 'exact'],
    ['/restart-helper', restartInfoHandler, 'exact'],
    ['/restart', restartHandler, 'exact'],
    ['/rename', renameHandler, 'exact'],
    ['/delete', deleteHandler, 'exact'],
    ['/policy', policyHandler, 'exact'],
    ['/export', exportHandler, 'exact'],
    ['/health-history', healthHistoryHandler, 'exact'],
  ]

  for (const [suffix, handler, kind] of routes) {
    try {
      const wrapped = (req, res) => {
        // 解析 URL（拿 query 参数）
        let url = null
        try { url = new URL(req.url, 'http://localhost') } catch { /* 忽略 */ }
        Promise.resolve(handler(req, res, url)).catch((e) => {
          // ⚠️ 端点异常必须记日志 —— 这是用户能交出来的最有用线索
          try {
            logError(C.snapshotDir(ctxInfo.home, ctxInfo.profile), {
              level: 'error',
              source: 'route',
              op: suffix,
              message: `HTTP 端点 ${suffix} 处理失败: ${e?.message ?? e}`,
              error: e instanceof Error ? e : undefined,
              context: { method: req.method, url: req.url },
            })
          } catch { /* 忽略 */ }
          try { json(res, 500, { error: String(e?.message ?? e) }) } catch { /* 忽略 */ }
        })
      }
      webServer.register({ kind, path: base + suffix, handler: wrapped })
    } catch (e) {
      safeLog(ctx, `route:${suffix}`, e)
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 安全辅助
// ─────────────────────────────────────────────────────────────

/**
 * 算回滚的四分区清单（决定 26 / 27）。
 *
 *  ① 将被移除：当前有、目标快照没有的插件
 *  ② 将被恢复：目标快照有、当前没有的插件
 *  ③ 保持不变：两边都有
 *  ④ 完全不受影响：固定文案（会话、node_modules、插件源码、npm 包）
 *
 * 移除项的时间标注从【快照时间】推断，不用会话日志（决定 27）。
 */
function buildRestorePlan({ home, profile }, root, target) {
  const liveDir = join(home, 'profiles', profile)
  const snapDir = join(root, target.dir)

  const readText = (base, f) => {
    try {
      const p = join(base, f)
      return existsSync(p) ? readFileSync(p, 'utf8') : null
    } catch { return null }
  }

  const effNow = computeEffectivePlugins(liveDir, readText(liveDir, 'cordis.patch.yml'))
  const effSnap = computeEffectivePlugins(snapDir, readText(snapDir, 'cordis.patch.yml'))

  const SELF = ['dsh-fk-rollback', 'dsh-fk-restart-button']

  const removed = [...effNow].filter((n) => !effSnap.has(n) && !n.startsWith('@deepseek-ai/')).sort()
  const added = [...effSnap].filter((n) => !effNow.has(n) && !n.startsWith('@deepseek-ai/')).sort()
  const kept = [...effNow].filter((n) => effSnap.has(n)).sort()

  // 时间标注：从目标快照时间到「下一个更新快照」的时间
  const idx = C.readIndex(root)
  const all = (idx.entries ?? []).slice().sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0))
  const i = all.findIndex((e) => e.id === target.id)
  const next = i >= 0 ? all[i + 1] : undefined
  const fmt = (ms) => {
    const d = new Date(ms ?? 0)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const window = next
    ? `${fmt(target.createdAtMs)} — ${fmt(next.createdAtMs)} 期间新增`
    : `${fmt(target.createdAtMs)} 之后新增`

  return {
    snapshotAt: target.createdAtMs,
    snapshotName: target.name,
    removed: removed.map((n) => ({ name: n, inferredAt: window })),
    added,
    kept: kept.slice(0, 40),
    keptCount: kept.length,
    selfRemoved: removed.filter((n) => SELF.includes(n)),
    unaffected: [
      '会话聊天记录（不在快照范围）',
      'node_modules 里的文件',
      '插件源码（plugin-src）',
      'npm 全局包',
    ],
  }
}

/** 去掉结尾的句号/感叹号，避免拼接时出现「。。」。 */
function trimSentence(s) {
  return String(s ?? '').replace(/[。！!.\s]+$/g, '')
}

/** 算当前配置指纹（用于「是不是当前状态」判定）。 */
function currentFingerprint({ home, profile }) {
  try { return C.fingerprint(join(home, 'profiles', profile)) } catch { return { aggregate: null } }
}

/** 执行可能失败的操作，异常吞掉并记日志。 */
function safeRun(label, fn, ctx) {
  try { return fn() } catch (e) { safeLog(ctx, label, e); return null }
}

/** 同上，但返回额外出参。 */
function safeRunValue(label, fn, fallback) {
  try { return fn() } catch { return fallback }
}

/**
 * 记一条警告（连日志失败都吞掉）。
 *
 * ⚠️ 2026-10-19：除了打 ctx.logger，还要写进 errors.log ——
 *    ctx.logger 的输出用户看不到，出问题时没法交给开发者。
 *    这里拿不到 root 时就不写文件（不影响主流程）。
 */
function safeLog(ctx, label, e, okMsg) {
  try {
    if (e) ctx?.logger?.warn?.(`[dsh-fk-rollback] ${label} 失败（已忽略）: ${e?.message ?? e}`)
    else if (okMsg) ctx?.logger?.info?.(`[dsh-fk-rollback] ${label}: ${okMsg}`)
  } catch { /* 忽略 */ }

  if (e) {
    try {
      const root = ctxInfoRoot(ctx)
      if (root) {
        logError(root, {
          level: 'warn',
          source: 'plugin',
          op: label,
          message: `插件内部操作失败（已忽略，不影响 DSH）: ${e?.message ?? e}`,
          error: e instanceof Error ? e : undefined,
          context: { label },
        })
      }
    } catch { /* 忽略 */ }
  }
}

/** 从 ctx 里尽力拿到快照根（拿不到就返回 null）。 */
function ctxInfoRoot(ctx) {
  try {
    const home = C.resolveHome()
    const profile = process.env.DSH_PROFILE || C.pickRecentProfile(home) || 'desktop'
    return C.snapshotDir(home, profile)
  } catch { return null }
}

/** 数 patch 顶层条目数（供基线比对）。 */
function patchEntryCount(text) {
  let n = 0
  for (const line of text.split(/\r?\n/)) {
    if (/^-\s/.test(line.trim()) && line.length - line.trimStart().length === 0) n += 1
  }
  return n
}

/** 探测 DSH 版本：读 asar 里的 dsh/package.json（失败则返回 null）。 */
function detectDshVersion(home, profile) {
  // ① 尝试从 profile 的 lockfile / manifest 里找
  // ② 尝试从运行中的 DSH 环境变量
  try {
    if (process.env.DSH_VERSION) return process.env.DSH_VERSION
  } catch { /* 忽略 */ }
  return null
}
