/**
 * FK 回滚设置 —— 错误日志（模块）
 *
 * 目标：出问题时，用户能把「一份能看懂的文件」发给开发者。
 *
 * 设计原则（2026-10-19 用户要求）：
 *   ① 只记「异常」与「关键操作」，不记正常流水
 *   ② 每条包含足够的上下文（时间、来源、操作、错误、环境）
 *   ③ 脱敏：API key / token 一律替换
 *   ④ 自动滚动：单文件超 1 MB 就归档，最多保留 3 个归档
 *   ⑤ 一键导出：生成一份可直接发出去的 txt
 *
 * ⚠️ 绝不能因为写日志失败而影响主流程 —— 所有写入都包 try/catch。
 *
 * @module dsh-fk-rollback/lib/elog
  *
 * @version 1.5.1
 * @module 错误日志
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 单个日志文件的最大字节数（超过就滚动）。 */
export const MAX_LOG_BYTES = 1024 * 1024      // 1 MB

/** 保留几个归档。 */
export const KEEP_ARCHIVES = 3

/** 脱敏规则。 */
const REDACT_RULES = [
  [/sk-[a-zA-Z0-9]{16,}/g, 'sk-***'],
  [/ghp_[a-zA-Z0-9]{20,}/g, 'ghp-***'],
  [/ghu_[a-zA-Z0-9]{20,}/g, 'ghu-***'],
  [/xox[baprs]-[a-zA-Z0-9-]{10,}/g, 'xox-***'],
  [/Bearer\s+[A-Za-z0-9._\-]{16,}/g, 'Bearer ***'],
  [/(api[_-]?key|apikey|token|password|passwd|secret|credential)\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/gi, '$1=***'],
  [/[A-Za-z0-9+/]{40,}={0,2}/g, (m) => (m.length > 60 ? '<长串已省略>' : m)],
]

/**
 * 脱敏。
 * @param {string} s
 * @returns {string}
 */
export function redactText(s) {
  let out = String(s ?? '')
  for (const [re, rep] of REDACT_RULES) {
    try { out = out.replace(re, rep) } catch { /* 忽略 */ }
  }
  return out
}

/** 日志目录 = 快照根。 */
function logDir(root) {
  return root
}

/** 当前日志文件路径。 */
export function logPath(root) {
  return join(logDir(root), 'errors.log')
}

/**
 * 滚动日志（超过 MAX_LOG_BYTES 时）。
 * errors.log → errors.1.log → errors.2.log → errors.3.log（最旧的丢弃）
 */
function rotateIfNeeded(root) {
  const p = logPath(root)
  try {
    if (!existsSync(p)) return
    if (statSync(p).size < MAX_LOG_BYTES) return

    // 从最旧的开始往后移
    for (let i = KEEP_ARCHIVES - 1; i >= 1; i--) {
      const from = join(root, `errors.${i}.log`)
      const to = join(root, `errors.${i + 1}.log`)
      if (existsSync(from)) {
        try { if (existsSync(to)) unlinkSync(to) } catch { /* 忽略 */ }
        try { renameSync(from, to) } catch { /* 忽略 */ }
      }
    }
    const first = join(root, 'errors.1.log')
    try { if (existsSync(first)) unlinkSync(first) } catch { /* 忽略 */ }
    renameSync(p, first)
  } catch { /* 忽略 —— 滚动失败不能影响写日志 */ }
}

/**
 * 写一条错误日志。
 *
 * @param {string} root
 * @param {object} entry
 * @param {string} entry.level     error | warn | fatal
 * @param {string} entry.source    来源（plugin / cli / hook / route / api ...）
 * @param {string} entry.op        正在做什么（如 'restore' / 'snapshot' / 'turn-end'）
 * @param {string} [entry.message] 错误信息
 * @param {Error|string} [entry.error] 错误对象或堆栈
 * @param {object} [entry.context] 额外上下文（会脱敏后序列化）
 */
export function logError(root, entry) {
  try {
    mkdirSync(root, { recursive: true })
    rotateIfNeeded(root)

    const now = new Date()
    const pad = (n, w = 2) => String(n).padStart(w, '0')
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
      + `.${pad(now.getMilliseconds(), 3)}`

    const lines = []
    lines.push(`[${ts}] [${String(entry.level ?? 'error').toUpperCase()}] ${entry.source ?? '-'} / ${entry.op ?? '-'}`)
    if (entry.message) lines.push(`  消息: ${redactText(entry.message)}`)

    // 堆栈只取前 12 行（够定位，不刷屏）
    if (entry.error) {
      const stack = entry.error && typeof entry.error === 'object'
        ? (entry.error.stack || entry.error.message || String(entry.error))
        : String(entry.error)
      const trimmed = String(stack).split('\n').slice(0, 12).join('\n   ')
      lines.push(`  堆栈: ${redactText(trimmed)}`)
    }

    if (entry.context && typeof entry.context === 'object') {
      try {
        const j = JSON.stringify(entry.context, (k, v) => {
          if (typeof v === 'string') return redactText(v).slice(0, 300)
          if (typeof v === 'object' && v !== null) {
            try { JSON.stringify(v); return v } catch { return '<不可序列化>' }
          }
          return v
        })
        if (j && j !== '{}') lines.push(`  上下文: ${j.slice(0, 1200)}`)
      } catch { /* 忽略 */ }
    }

    lines.push('')   // 空行分隔，便于人读
    appendFileSync(logPath(root), lines.join('\n') + '\n', 'utf8')
    return true
  } catch {
    return false   // 绝不因为写日志失败而影响主流程
  }
}

/**
 * 读错误日志（新的在前）。
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {number} [opts.limit]  最多返回多少条，默认 100
 * @returns {{entries: Array<{raw: string, ts: string, level: string, source: string, op: string}>, total: number, bytes: number}}
 */
export function readErrorLog(root, opts = {}) {
  const limit = Number(opts.limit ?? 100)
  const p = logPath(root)
  if (!existsSync(p)) return { entries: [], total: 0, bytes: 0 }

  let text = ''
  let bytes = 0
  try {
    text = readFileSync(p, 'utf8')
    bytes = Buffer.byteLength(text)
  } catch {
    return { entries: [], total: 0, bytes: 0 }
  }

  // 以「带时间戳的行」为界切分
  const blocks = []
  let cur = null
  for (const line of text.split('\n')) {
    const m = /^\[([\d\-: .]+)\] \[(\w+)\] (\S+) \/ (\S+)/.exec(line)
    if (m) {
      if (cur) blocks.push(cur)
      cur = { ts: m[1], level: m[2], source: m[3], op: m[4], lines: [line] }
    } else if (cur) {
      cur.lines.push(line)
    }
  }
  if (cur) blocks.push(cur)

  const entries = blocks.slice(-limit).reverse().map((b) => ({
    raw: b.lines.join('\n').trimEnd(),
    ts: b.ts, level: b.level, source: b.source, op: b.op,
  }))
  return { entries, total: blocks.length, bytes }
}

/**
 * 生成一份可直接发给开发者的诊断包（纯文本）。
 *
 * 内容顺序（越靠前越重要）：
 *   ① 概要（版本 / 时间 / 问题数）
 *   ② 错误日志（最近的）
 *   ③ 体检结果
 *   ④ 环境信息（DSH 版本、profile、路径、5 个文件大小与哈希）
 *   ⑤ 快照清单
 *   ⑥ 最近的配置改动
 *
 * @param {object} opts
 * @param {string} opts.root      快照根
 * @param {string} opts.home
 * @param {string} opts.profile
 * @param {string} [opts.dshVersion]
 * @param {object} [opts.check]   runCheck 结果
 * @param {object} [opts.index]   index.json
 * @param {object} [opts.timeline] configTimeline 结果
 * @returns {string}
 */
export function buildDiagnosticBundle(opts) {
  const { root, home, profile, dshVersion, check, index, timeline } = opts
  const now = new Date()
  const L = []

  L.push('═══════════════════════════════════════════════════════')
  L.push('  DSH 回滚插件 · 诊断报告')
  L.push('═══════════════════════════════════════════════════════')
  L.push('')
  L.push('生成时间：' + now.toLocaleString('zh-CN'))
  L.push('DSH 版本：' + (dshVersion ?? '(未知)'))
  L.push('profile：' + profile)
  L.push('DSH_HOME：' + home)
  L.push('快照目录：' + root)
  L.push('')

  // ① 概要
  L.push('── 概要 ──')
  if (check) {
    L.push('体检结论：' + (check.verdict ?? check.overall ?? '?'))
    L.push('  真问题 ' + (check.problems ?? []).length
      + ' · 提示 ' + (check.notices ?? []).length
      + ' · 正常状态 ' + (check.normal ?? []).length
      + ' · 已确认 ' + (check.acknowledged ?? []).length)
  }
  const elog = readErrorLog(root, { limit: 200 })
  L.push('错误日志：' + elog.total + ' 条（' + Math.round(elog.bytes / 1024) + ' KB）')
  L.push('')

  // ② 错误日志
  L.push('── 错误日志（最近 ' + elog.entries.length + ' 条）──')
  if (elog.entries.length === 0) {
    L.push('（无记录）')
  } else {
    for (const e of elog.entries) {
      L.push(e.raw)
      L.push('')
    }
  }

  // ③ 体检
  L.push('── 体检结果 ──')
  if (check) {
    const dump = (arr, title) => {
      if (!arr || arr.length === 0) return
      L.push(title + '（' + arr.length + '）')
      for (const it of arr) {
        L.push('  [' + it.severity + '] ' + it.code + (it.package ? ' · ' + it.package : ''))
        L.push('    ' + (it.message ?? ''))
        if (it.file) L.push('    文件：' + it.file)
      }
      L.push('')
    }
    dump(check.problems, '真问题')
    dump(check.notices, '提示')
    dump(check.normal, '正常状态')
    dump(check.acknowledged, '已确认可接受')
  } else {
    L.push('（未运行体检）')
    L.push('')
  }

  // ④ 环境
  L.push('── 环境 ──')
  L.push('5 个配置文件：')
  const FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json']
  for (const f of FILES) {
    const p = join(home, 'profiles', profile, f)
    try {
      const st = statSync(p)
      L.push('  ' + f.padEnd(24) + String(st.size).padStart(8) + ' B   ' + st.mtime.toLocaleString('zh-CN'))
    } catch {
      L.push('  ' + f.padEnd(24) + '   （不存在）')
    }
  }
  L.push('')

  // ⑤ 快照清单
  L.push('── 快照清单 ──')
  const entries = (index && index.entries) || []
  if (entries.length === 0) {
    L.push('（无快照）')
  } else {
    for (const e of entries.slice().sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))) {
      L.push('  ' + String(e.type).padEnd(16) + (e.name ?? '').padEnd(26)
        + String(Math.round((e.size ?? 0) / 1024)).padStart(6) + ' KB   ' + (e.id ?? ''))
    }
  }
  L.push('')

  // ⑥ 配置改动
  L.push('── 最近配置改动（最多 30 条）──')
  const changes = (timeline && timeline.changes) || []
  if (changes.length === 0) {
    L.push('（最近没有配置改动）')
  } else {
    for (const c of changes.slice(0, 30)) {
      L.push('  ' + new Date(c.t).toLocaleString('zh-CN') + '  '
        + (c.source === 'user' ? '你' : 'AI') + ' ' + c.action
        + '  [' + (c.files || []).join(', ') + ']')
    }
  }
  L.push('')

  L.push('═══════════════════════════════════════════════════════')
  L.push('  报告结束。请把整份内容发给开发者。')
  L.push('═══════════════════════════════════════════════════════')

  return L.join('\n')
}

/**
 * 把诊断包写到文件（放在快照根下，文件名带时间）。
 * @returns {string} 文件路径
 */
export function writeDiagnosticBundle(root, text) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const name = `diagnostic-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`
  const p = join(root, name)
  writeFileSync(p, text, 'utf8')
  return p
}
