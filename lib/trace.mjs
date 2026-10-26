/**
 * FK 回滚设置 —— 会话溯源（模块三）
 *
 * 只回答三个可验证的事实：
 *   ① 哪个会话
 *   ② 做了什么操作（工具名 + 完整参数）
 *   ③ 碰了哪些文件
 *
 * 不判断「是不是装插件」、不判断「是不是危险操作」、不标注因果关系。
 *
 * ⚠️ 绝对只读：会话日志是 DSH 的核心数据。
 *
 * @module dsh-fk-rollback/lib/trace
  *
 * @version 1.5.1
 * @module 模块三
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 索引只保留这几类事件（其余丢弃，节省内存与体积）。 */
const INDEXED_TYPES = new Set(['tool/call', 'command/run', 'workspace/changes', 'session/title', 'session'])

/** 脱敏规则：这些模式命中就替换掉。 */
const REDACT = [
  [/sk-[a-zA-Z0-9]{20,}/g, 'sk-***'],
  [/ghp_[a-zA-Z0-9]{30,}/g, 'ghp_***'],
  [/(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[\w-]{16,}/gi, '$1=***'],
]

/** 对字符串脱敏。 */
export function redact(s) {
  let out = String(s ?? '')
  for (const [re, rep] of REDACT) out = out.replace(re, rep)
  return out
}

// ─────────────────────────────────────────────────────────────
// 多帧 zstd 解码（必须逐帧，官方文档确认）
// ─────────────────────────────────────────────────────────────

/**
 * 解压多帧 zstd 流。
 *
 * ⚠️ 直接 zstdDecompressSync(整个文件) 只能拿到第一帧。
 * 实测：13 MB 文件直接解压只得 244 B；逐帧解压得 13,510 条事件。
 *
 * @param {Buffer} buf
 * @returns {string} 拼接后的 JSONL 文本
 */
export function decompressMultiFrame(buf) {
  const positions = []
  let i = 0
  while (i < buf.length - 4) {
    const idx = buf.indexOf(ZSTD_MAGIC, i)
    if (idx < 0) break
    positions.push(idx)
    i = idx + 4
  }
  if (positions.length === 0) return ''

  let all = ''
  for (let k = 0; k < positions.length; k++) {
    const start = positions[k]
    const end = k + 1 < positions.length ? positions[k + 1] : buf.length
    try {
      all += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch { /* 跳过坏帧 */ }
  }
  return all
}

// ─────────────────────────────────────────────────────────────
// 会话格式探测
// ─────────────────────────────────────────────────────────────

/**
 * 探测会话日志格式版本。
 * 遇到不支持的版本 → 跳过，绝不用老逻辑硬解。
 */
export function detectSessionFormat(path) {
  const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(basename(path))
  if (!m) return { ok: false, reason: '文件名不符合已知格式' }
  const ver = Number(m[1])
  if (ver === 4) return { ok: true, version: 4 }
  if (ver > 4) return { ok: false, reason: `会话格式 v${ver} 比本工具支持的 v4 新，跳过以免误读` }
  return { ok: false, reason: `不支持的旧格式 v${ver}` }
}

// ─────────────────────────────────────────────────────────────
// 扫描会话
// ─────────────────────────────────────────────────────────────

/**
 * 列出所有工作区下的会话文件。
 * @returns {Array<{sessionId, workspace, path, size, mtimeMs}>}
 */
export function listSessions(home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const out = []
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws)
    let subs
    try {
      if (!statSync(wsDir).isDirectory()) continue
      subs = readdirSync(wsDir)
    } catch { continue }
    for (const s of subs) {
      if (!s.startsWith('session-')) continue
      const p = join(wsDir, s, 'session.v4.jsonl.zstd')
      try {
        const st = statSync(p)
        if (!st.isFile()) continue
        out.push({
          sessionId: s,
          workspace: ws,
          path: p,
          size: st.size,
          mtimeMs: st.mtimeMs,
        })
      } catch { /* 跳过 */ }
    }
  }
  return out
}

/**
 * 解析一个会话，产出索引（只保留有价值的字段）。
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {number} [opts.sinceMs]  只保留这个时间之后的事件
 * @returns {{ok, title, sessionId, events, reason?}}
 */
export function indexSession(path, opts = {}) {
  const fmt = detectSessionFormat(path)
  if (!fmt.ok) return { ok: false, reason: fmt.reason, events: [] }

  let buf
  try {
    buf = readFileSync(path)
  } catch (e) {
    return { ok: false, reason: `读取失败：${e.code}`, events: [] }
  }

  const text = decompressMultiFrame(buf)
  if (!text) return { ok: false, reason: '解压后为空', events: [] }

  const since = opts.sinceMs ?? 0
  let title = null
  let sessionId = null
  const events = []

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }

    if (o.type === 'session') {
      sessionId = o.id ?? sessionId
      continue
    }
    if (o.type === 'session/title') {
      title = o.data?.title ?? title
      continue
    }
    if (!INDEXED_TYPES.has(o.type)) continue
    if (o.time && o.time < since) continue

    // 提取涉及的文件路径
    const files = extractFiles(o)

    events.push({
      t: o.time ?? 0,
      type: o.type,
      name: o.data?.name ?? null,
      files,
      args: redact(summarizeArgs(o)),
    })
  }

  return { ok: true, title, sessionId, events, format: fmt.version }
}

/**
 * 从事件里提取「被操作的文件路径」。
 *
 * ⚠️ 关键：必须区分「路径」与「文件内容」。
 *   编辑操作的事件里同时有 file_path（路径）和 new_string（正文）。
 *   若把正文也扫一遍，就会出现误报 ——
 *   实测教训：改设计文档时，因正文里提到 cordis.patch.yml，
 *   就被误判成「改过 cordis.patch.yml」。
 *
 * 所以：只从「结构性字段」取路径，跳过内容字段。
 */
const CONTENT_KEYS = new Set([
  'new_string', 'old_string', 'content', 'text', 'command',
  'stdout', 'stderr', 'output', 'prompt', 'message',
])

function extractFiles(o) {
  const found = new Set()

  const addPath = (v) => {
    if (typeof v !== 'string' || v.length < 4 || v.length > 500) return
    // 必须是看起来像配置文件的路径（含扩展名）
    if (!/\.(json|ya?ml|lock)$/i.test(v)) return
    found.add(v)
  }

  const scan = (v, key = null) => {
    if (typeof v === 'string') {
      if (key !== null && CONTENT_KEYS.has(key)) return     // 跳过正文
      // 只看「像路径」的：含目录分隔符或盘符
      if (/[\\/]/.test(v) || /^[\w.-]+\.(json|ya?ml|lock)$/i.test(v)) addPath(v)
      return
    }
    if (Array.isArray(v)) { for (const x of v) scan(x, key); return }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) scan(x, k)
    }
  }

  // 优先取明确的结构字段
  const d = o.data ?? {}
  for (const k of ['file_path', 'filePath', 'path', 'files', 'paths', 'file']) {
    if (d[k] !== undefined) scan(d[k], k)
  }

  // ⚠️ 关键修正（2026-10-19）：
  //   tool/call 的 `arguments` 是【JSON 字符串】，不是对象。
  //   实测形态：{"name":"edit","arguments":"{\"file_path\":\"D:\\\\...\\\\cordis.patch.yml\"}"}
  //   直接 scan 这个字符串只能看到转义文本，路径提不出来 → 永远 0 命中。
  //   必须先 parse 再扫，且 parse 后仍要跳过 new_string 这类内容字段。
  if (typeof d.arguments === 'string') {
    try {
      const parsed = JSON.parse(d.arguments)
      if (parsed && typeof parsed === 'object') {
        for (const k of ['file_path', 'filePath', 'path', 'files', 'paths', 'file']) {
          if (parsed[k] !== undefined) scan(parsed[k], k)
        }
        for (const [k, v] of Object.entries(parsed)) {
          if (['file_path', 'filePath', 'path', 'files', 'paths', 'file'].includes(k)) continue
          scan(v, k)
        }
      }
    } catch { /* 不是合法 JSON 就跳过 */ }
  }

  // 再扫其余字段（跳过内容字段与已处理的 arguments）
  for (const [k, v] of Object.entries(d)) {
    if (['file_path', 'filePath', 'path', 'files', 'paths', 'file', 'arguments'].includes(k)) continue
    scan(v, k)
  }

  return [...found].slice(0, 12)
}

/** 把参数压缩成一行摘要（脱敏后）。 */
function summarizeArgs(o) {
  if (o.type === 'command/run') {
    const d = o.data ?? {}
    return `${d.name ?? ''} ${d.args ?? ''}`.trim()
  }
  if (o.type === 'tool/call') {
    const d = o.data ?? {}
    let a = ''
    try {
      a = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? {})
    } catch { a = String(d.arguments ?? '') }
    return `${d.name ?? ''} ${a}`.trim().slice(0, 600)
  }
  if (o.type === 'workspace/changes') {
    return '(工作区变更)'
  }
  return ''
}

// ─────────────────────────────────────────────────────────────
// 溯源主入口
// ─────────────────────────────────────────────────────────────

/**
 * 查「谁在什么时候改过这个文件」。
 *
 * 四步，全部是事实筛选，无任何猜测：
 *   ① 按时间筛选
 *   ② 按文件筛选（参数里出现目标文件的任一路径形式）
 *   ③ 按时间排序
 *   ④ 输出时间线（不做任何标注）
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} [opts.file]     目标文件名或路径，省略则返回全部操作
 * @param {number} [opts.days]     回溯天数，默认 7
 * @param {number} [opts.sinceMs]
 * @returns {{hits: Array, scanned: number, skipped: Array}}
 */
export function traceFile(opts) {
  const { home, file, days = 7 } = opts
  const sinceMs = opts.sinceMs ?? (Date.now() - days * 86400 * 1000)

  const sessions = listSessions(home)
  const hits = []
  const skipped = []
  let scanned = 0

  // 第一层：文件 mtime 快速排除
  const candidates = sessions.filter((s) => s.mtimeMs >= sinceMs)

  for (const s of candidates) {
    scanned += 1
    const r = indexSession(s.path, { sinceMs })
    if (!r.ok) { skipped.push({ sessionId: s.sessionId, reason: r.reason }); continue }

    for (const e of r.events) {
      // 第二层：按文件筛选
      //   ⚠️ 只看 e.files（结构化提取出来的路径），
      //   不扫 e.args（那是操作参数的正文，会误报）。
      if (file) {
        const needle = String(file).toLowerCase().replace(/\\/g, '/')
        const matched = e.files.some((f) => {
          const norm = String(f).toLowerCase().replace(/\\/g, '/')
          return norm === needle || norm.endsWith('/' + needle) || norm.endsWith(needle)
        })
        if (!matched) continue
      }
      hits.push({
        t: e.t,
        sessionId: s.sessionId,
        sessionTitle: r.title,
        type: e.type,
        name: e.name,
        files: e.files,
        args: e.args,
      })
    }
  }

  // 第三层：按时间排序
  hits.sort((a, b) => a.t - b.t)

  return { hits, scanned, skipped, total: candidates.length }
}



// ─────────────────────────────────────────────────────────────
// 面向用户的「配置改动时间线」
// ─────────────────────────────────────────────────────────────
//
// ⚠️ 2026-10-19 用户批评后重做：
//   「你的溯源完完全全就是把所有会话调出来给用户看，工具用户怎么看得懂？」
//
// 旧版问题：默认查「全部操作」，把 1711 条 pwsh/edit/read 都列出来。
// 那不是溯源，那是日志浏览器 —— 用户完全不知道自己在看什么。
//
// 新版只回答一个问题：
//   「我的 5 个配置文件，最近被谁改过？」
//
// 关键过滤（三层）：
//   ① 只看真正【改了文件内容】的操作
//      · write / edit / create 类工具
//      · 或者工作区变更事件
//      ✗ 排除 read / grep / glob / web_search / todo_write（这些不碰文件）
//   ② 只看碰过【5 个配置文件中至少一个】的操作
//      ✗ 排除改设计文档、改代码的
//   ③ 每条只保留「用户能懂的摘要」，不列命令行原文
//

/** 5 个配置文件（与 core.SNAPSHOT_FILES 一致）。 */
const CONFIG_FILES = [
  'package.json',
  'cordis.patch.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'compatibility.json',
]

/** 会改动文件内容的工具（白名单）。其余一律不算「改配置」。 */
const MUTATING_TOOLS = new Set([
  'write', 'edit', 'create', 'multiedit', 'str_replace',
  'apply_patch', 'notebookedit', 'delete', 'move', 'copy',
])

/**
 * 该事件是否「改动了文件」。
 * @returns {boolean}
 */
function isMutating(e) {
  if (e.type === 'workspace/changes') return true
  const name = String(e.name ?? '').toLowerCase()
  return MUTATING_TOOLS.has(name)
}

/**
 * 该事件碰到的文件里，是否有 5 个配置文件之一。
 * @returns {string[]} 命中的配置文件名
 */
function configFilesTouched(e) {
  const hits = new Set()
  const consider = (p) => {
    const norm = String(p ?? '').toLowerCase().replace(/\\/g, '/')
    for (const cf of CONFIG_FILES) {
      if (norm === cf || norm.endsWith('/' + cf)) hits.add(cf)
    }
  }
  for (const f of e.files ?? []) consider(f)
  return [...hits]
}

/**
 * 判断改动来源：用户自己 / AI / 未知。
 *
 * DSH 的 `command/run` 事件带 `source.kind === 'user'` 表示手动触发。
 * agent 的工具调用则没有这个标记。
 */
function sourceOf(raw) {
  const k = raw?.data?.source?.kind ?? raw?.source?.kind
  if (k === 'user') return 'user'
  return 'ai'
}

/**
 * 把一条原始事件压缩成「用户能看懂的一句话」。
 *
 * ✗ 不输出命令行原文
 * ✓ 只输出「做了什么动作 + 改了哪些文件」
 */
function humanize(raw, e) {
  const files = configFilesTouched(e)
  const tool = String(e.name ?? '').toLowerCase()

  let action
  if (e.type === 'workspace/changes') action = '文件被改动'
  else if (tool === 'write' || tool === 'create') action = '写入了文件'
  else if (tool === 'edit' || tool === 'multiedit' || tool === 'str_replace') action = '编辑了文件'
  else if (tool === 'delete') action = '删除了文件'
  else if (tool === 'move') action = '移动了文件'
  else if (tool === 'copy') action = '复制了文件'
  else action = '改动了文件'

  return {
    t: e.t,
    action,
    files,
    source: sourceOf(raw),
    sessionTitle: null,   // 由外层补
  }
}

/**
 * 【新】面向用户的配置改动时间线。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {number} [opts.days]      回溯天数，默认 7
 * @param {string} [opts.file]      只看某个配置文件（可选）
 * @returns {{
 *   changes: Array<{t, action, files, source, sessionTitle}>,
 *   byFile: {[file: string]: number},
 *   sessions: number,
 *   totalChanges: number,
 *   hasAny: boolean,
 * }}
 */
export function configTimeline(opts) {
  const { home, file } = opts
  const days = Number(opts.days ?? 7)
  const sinceMs = Date.now() - days * 86400 * 1000

  const sessions = listSessions(home).filter((s) => s.mtimeMs >= sinceMs)
  const changes = []
  const byFile = {}
  const seen = new Set()

  for (const s of sessions) {
    const fmt = detectSessionFormat(s.path)
    if (!fmt.ok) continue

    let buf
    try { buf = readFileSync(s.path) } catch { continue }
    const text = decompressMultiFrame(buf)
    if (!text) continue

    let title = null
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }

      if (o.type === 'session/title') { title = o.data?.title ?? title; continue }
      if (!o.time || o.time < sinceMs) continue
      if (!INDEXED_TYPES.has(o.type)) continue

      const e = {
        t: o.time,
        type: o.type,
        name: o.data?.name ?? null,
        files: extractFiles(o),
        args: '',
      }

      // ① 只看改文件的
      if (!isMutating(e)) continue
      // ② 只看碰过配置文件的
      const touched = configFilesTouched(e)
      if (touched.length === 0) continue
      // ③ 可选：按文件筛
      if (file && !touched.some((f) => f === file)) continue

      // 去重（同一秒同一动作同文件只留一条）
      const key = `${e.t}|${e.name}|${touched.join(',')}`
      if (seen.has(key)) continue
      seen.add(key)

      for (const f of touched) byFile[f] = (byFile[f] ?? 0) + 1
      const h = humanize(o, e)
      h.sessionTitle = title
      changes.push(h)
    }
  }

  changes.sort((a, b) => b.t - a.t)   // 最新在前

  return {
    changes,
    byFile,
    sessions: sessions.length,
    totalChanges: changes.length,
    hasAny: changes.length > 0,
  }
}

/** 列出会话摘要（标题 + 时间跨度 + 操作数）。 */
export function listSessionSummaries(home, opts = {}) {
  const sinceMs = opts.sinceMs ?? (Date.now() - (opts.days ?? 7) * 86400 * 1000)
  const sessions = listSessions(home).filter((s) => s.mtimeMs >= sinceMs)
  const out = []
  for (const s of sessions) {
    const r = indexSession(s.path, { sinceMs })
    out.push({
      sessionId: s.sessionId,
      title: r.title ?? '(无标题)',
      ok: r.ok,
      reason: r.reason,
      eventCount: r.events?.length ?? 0,
      firstAt: r.events?.[0]?.t ?? 0,
      lastAt: r.events?.[r.events.length - 1]?.t ?? 0,
      fileMtimeMs: s.mtimeMs,     // ⭐ 无事件时用文件时间兜底显示
      size: s.size,
    })
  }
  return out.sort((a, b) => b.lastAt - a.lastAt)
}
