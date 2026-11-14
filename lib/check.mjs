/**
 * FK 回滚设置 —— 体检模块
 *
 * 只读检查 DSH 配置健康度。产出 issue 列表，每个 issue 带 `file` 字段，
 * 供模块三（溯源）联动。
 *
 * 零第三方依赖：YAML 用自实现子集（只解析我们需要的行）。
 *
 * @module dsh-fk-rollback/lib/check
  *
 * @version 1.5.3
 * @module 模块二
 */

import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'   // 代理端口探活（2026-11-14 事故）
import { SNAPSHOT_FILES, REQUIRED_ENTRY_IDS } from './core.mjs'
import { checkEstate } from './estate.mjs'


// ─────────────────────────────────────────────────────────────
// 「已知的正常状态」白名单
// ─────────────────────────────────────────────────────────────
//
// ⚠️ 这是本插件最重要的一个设计决定（2026-10-19 用户质问后补）。
//
// 用户原话：
//   「一个普通的用户，如果安装使用这个插件，他怎么能分辨出来问题？」
//
// 答案：他分辨不出来。所以插件必须替他分辨 ——
//   把「DSH 本来就有的正常形态」和「真的出了事」分开，
//   正常的不打扰、不计数、不要求确认，只在用户主动展开时才出现。
//
// 判定原则：这条提示出现时，DSH 是否能正常工作？
//   · 能 → 它是正常状态，不该报警
//   · 不能 → 它才是问题
//
export const NORMAL_CODES = {
  // 悬空符号链接：DSH 升级后 .pnpm 目录被清，遗留的链接指不到目标。
  // DSH 自己从 app.asar 解析官方包，这类链接根本不会被用到。
  'bundle-link-dangling': 'DSH 升级遗留的链接，官方包从 asar 加载，无影响',

  // 用户层覆盖服务行（ui-chat / permission / ...）：
  // 这是 DSH 明确支持的「能力接缝」，改官方插件配置的标准写法。
  'bundle-overrides-seam': 'DSH 支持的配置方式，改官方插件参数时会用到',

  // 官方包的 engines.dsh 与当前版本不一致：DSH 已内置豁免逻辑，
  // 只有用户主动装的第三方插件才需要关心。
  'engines-range-unclear': '官方包的版本声明，DSH 自行处理',

  // 官方包只存在于 app.asar，不会解压到 node_modules —— DSH 直接从 asar 加载。
  // 实测：3 个 experimental 包都这样，DSH 启动完全正常。
  'bundle-official-from-asar': 'DSH 官方包由 asar 提供，node_modules 里没有是正常的',
}

// ─────────────────────────────────────────────────────────────
// 代理环境变量检查（2026-11-14 事故）
// ─────────────────────────────────────────────────────────────

/**
 * 会被 DSH / Node 当作 HTTP 代理的环境变量名。
 *
 * 大小写两种都列 —— 各库处理不一致；Windows 环境变量本身不分大小写，
 * 但 process.env 的键会保留写入时的大小写。
 */
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy',
]

/**
 * 同步判断本机端口有没有在监听（用 netstat）。
 *
 * ⚠️ 为什么必须同步：
 *    runCheck() 是同步函数，有 12 处调用点（entry.js 7 处 + CLI 5 处）。
 *    为了一个端口探测把它全改成 async，改动面太大、风险太高。
 *    netstat 一次约 30ms，完全可接受。
 *
 * @returns {{ listening: boolean, reason?: string }}
 */
export function isPortListeningSync(port) {
  // 非本机端口不做判断（调用方已过滤，这里再兜一次）
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0 || p > 65535) {
    return { listening: false, reason: 'bad port' }
  }
  try {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows'
    const netstat = join(sysRoot, 'System32', 'NETSTAT.EXE')
    const out = execFileSync(netstat, ['-ano', '-p', 'TCP'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const suffix = ':' + String(p)
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const cols = line.trim().split(/\s+/)
      const local = cols[1] ?? ''
      if (local.endsWith(suffix)) return { listening: true }
    }
    return { listening: false, reason: 'not listening' }
  } catch (e) {
    // netstat 不可用（比如非 Windows）→ 不做判断，避免误报
    return { listening: true, reason: 'cannot probe: ' + String(e?.code ?? e?.message ?? e) }
  }
}

/** 解析代理字符串 → { valid, host, port, protocol }。 */
export function parseProxyValue(raw) {
  const v = String(raw ?? '').trim()
  if (v === '') return { valid: false, reason: 'empty' }
  const withScheme = v.includes('://') ? v : 'http://' + v
  try {
    const u = new URL(withScheme)
    const host = u.hostname
    if (host === '') return { valid: false, reason: 'no host' }
    const portStr = u.port !== '' ? u.port : (u.protocol === 'https:' ? '443' : '80')
    const port = Number(portStr)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return { valid: false, reason: 'bad port' }
    }
    return { valid: true, host, port, protocol: u.protocol.replace(':', '') }
  } catch (e) {
    return { valid: false, reason: String(e?.message ?? e).slice(0, 60) }
  }
}

/** 是不是本机地址 —— 只有本机代理才值得探活。 */
function isLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

/**
 * 检查代理环境变量是否指向一个没有运行的代理。
 *
 * ⚠️ 2026-11-14 事故：
 *    用户级 HTTP_PROXY/HTTPS_PROXY 指向 127.0.0.1:7897，但代理软件没开。
 *    DSH 0.2.2 起在启动时读这两个变量，把全局 dispatcher 换成 ProxyAgent，
 *    于是每一条出站请求全挂 → 所有 provider 统一报
 *    "DeepSeek Messages transport failed"。
 *
 *    这个报错完全不指向真因，用户换模型、换 provider、查密钥全都白试。
 *    而且它不是配置问题 —— 重启 / 回滚快照都没用（变量在注册表里）。
 *
 * 保守判据（避免误报）：
 *    · 只探 127.0.0.1 / localhost —— 远程代理探不通可能只是防火墙
 *    · 端口能连上就不报
 *    · 变量没设置就什么都不做
 *
 * @param {Function} add
 * @param {object} [opts]
 * @param {object} [opts.env]    自定义环境（测试用）
 * @param {Function} [opts.probe] 自定义探活（测试用）
 */
export function scanProxyEnv(add, opts = {}) {
  const env = opts.env ?? process.env
  const probe = opts.probe ?? isPortListeningSync

  const found = []
  for (const key of PROXY_ENV_KEYS) {
    const raw = env[key]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    found.push({ key, raw: raw.trim(), ...parseProxyValue(raw) })
  }
  if (found.length === 0) return { checked: 0, dead: [], alive: [], unparsable: [] }

  const targets = new Map()
  for (const f of found) {
    if (!f.valid) continue
    const id = f.host + ':' + String(f.port)
    if (!targets.has(id)) targets.set(id, { host: f.host, port: f.port, keys: [] })
    targets.get(id).keys.push(f.key)
  }

  const dead = []
  const alive = []
  const unparsable = found.filter((f) => !f.valid)

  for (const [, target] of targets) {
    if (!isLoopbackHost(target.host)) {
      alive.push({ ...target, skipped: 'remote' })
      continue
    }
    const r = probe(target.port)
    if (r.listening) alive.push(target)
    else dead.push({ ...target, reason: r.reason ?? 'not listening' })
  }

  if (dead.length > 0) {
    const list = dead.map((d) => `${d.keys.join(' / ')} = ${d.host}:${d.port}`).join('、')

    add('fatal', 'proxy-env-dead',
      `${list} —— 这个代理端口【没有进程在监听】。`
      + 'DSH 0.2.2 起会在启动时读取代理环境变量，把全局 HTTP dispatcher 换成指向该代理的 ProxyAgent，'
      + '于是每一条出站请求全部失败：'
      + '所有模型（官方 + 全部第三方）统一报 "DeepSeek Messages transport failed"，'
      + '换模型、换 provider、查密钥全都无效。',
      {
        file: '(用户环境变量)',
        packages: dead.map((d) => d.keys.join('/')),
        hint: '要么启动代理软件，要么删掉变量后【完全重启 DSH】：'
          + ' [Environment]::SetEnvironmentVariable("HTTP_PROXY",$null,"User"); '
          + '[Environment]::SetEnvironmentVariable("HTTPS_PROXY",$null,"User")'
          + '  ⚠️ 重启 / 回滚快照都治不了这个 —— 变量存在注册表里，不在快照范围内。',
      })
  }

  return { checked: found.length, dead, alive, unparsable }
}

/** 该 code 是否属于「已知的正常状态」。 */
export function isNormalCode(code) {
  return Object.prototype.hasOwnProperty.call(NORMAL_CODES, code)
}

// ─────────────────────────────────────────────────────────────
// 自实现 YAML 子集解析（避免第三方依赖）
// ─────────────────────────────────────────────────────────────

/**
 * 解析 cordis patch 的顶层结构。
 *
 * 只关心三件事：
 *   ① 顶层条目数（缩进为 0 的 `- ` 行）
 *   ② 每个条目的 id / insert 里的 id
 *   ③ 语法是否能解析
 *
 * ⚠️ 顶层条目必须【缩进为 0】。缩进的 `- id:` 是某个 key 下的列表项
 *   （例如 models: 下的模型列表），不是配置条目 —— 不能计入条目数，
 *   也不能当成 id 收集。
 *
 * 不处理锚点、多行字符串、类型转换 —— 那些我们用不到。
 *
 * @param {string} text
 * @returns {{ok: true, entries: Array, count: number} | {ok: false, reason: string, line: number}}
 */
export function parsePatchSubset(text) {
  const lines = text.split(/\r?\n/)
  const entries = []
  let current = null
  let insertIndent = -1        // insert 子项的缩进基线；-1 = 不在 insert 里

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const indent = line.length - line.trimStart().length

    // ── 只有缩进 0 的 `- key: value` 才是顶层条目 ──
    const topMatch = /^-\s+([\w@/.-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (indent === 0 && topMatch) {
      if (current) entries.push(current)
      current = { kind: topMatch[1], value: unquote(topMatch[2]), ids: [] }
      insertIndent = -1
      continue
    }

    // 缩进的列表项：只在 insert 语境下收集 id
    if (indent > 0 && topMatch) {
      if (current && current.kind === 'insert' && topMatch[1] === 'id') {
        const id = unquote(topMatch[2])
        if (id) current.ids.push(id)
      }
      continue
    }

    if (!current) {
      // ⚠️ 空数组 `[]` 是合法的 YAML —— 表示「没有任何 patch 条目」。
      //    全新 profile 的 cordis.patch.yml 就可能是这个（或只有注释）。
      //    2026-10-21 实测：之前会误报 bad-yaml，让用户以为配置坏了。
      if (indent === 0 && /^\[\s*\]$/.test(trimmed)) {
        continue
      }
      // 顶层 mapping（无外层列表）—— 接受，但不算条目
      const mapMatch = /^([\w@/.-]+)\s*:\s*(.*)$/.exec(trimmed)
      if (indent === 0 && mapMatch) {
        continue
      }
      if (indent > 0) continue
      return { ok: false, reason: `无法解析的行：${trimmed}`, line: i + 1 }
    }

    // insert 下的 `- id: xxx`
    if (indent > 0) {
      const sub = /^-\s+([\w@/.-]+)\s*:\s*(.*)$/.exec(trimmed)
      if (sub && current.kind === 'insert' && sub[1] === 'id') {
        const id = unquote(sub[2])
        if (id) current.ids.push(id)
        if (insertIndent < 0) insertIndent = indent
        continue
      }
      // 其它缩进行（config: 下的内容）一律忽略
      continue
    }

    // 顶层 `key: value`（如 insert: 本身已在上面处理）
    const kv = /^([\w@/.-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (kv && indent === 0) {
      continue
    }
  }
  if (current) entries.push(current)

  // 引号闭合检查（简单版：双引号数量应为偶数）
  const dq = (text.match(/"/g) ?? []).length
  if (dq % 2 !== 0) {
    return { ok: false, reason: '双引号未闭合', line: 0 }
  }

  return { ok: true, entries, count: entries.length }
}

/** 去掉包裹的单/双引号。 */
function unquote(s) {
  const t = String(s ?? '').trim()
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1)
  }
  return t
}

/** 取 patch 里所有条目 id。 */
export function patchEntryIds(text) {
  const r = parsePatchSubset(text)
  if (!r.ok) return []
  const ids = []
  for (const e of r.entries) {
    if (e.kind === 'id' && e.value) ids.push(e.value)
    for (const x of e.ids) ids.push(x)
  }
  return ids
}

// ─────────────────────────────────────────────────────────────
// 体检主体
// ─────────────────────────────────────────────────────────────

/**
 * 跑一次完整体检。
 *
 * @param {object} opts
 * @param {string} opts.home        DSH_HOME
 * @param {string} opts.profile     profile 名
 * @param {object} [opts.baseline]  基准（上次启动的指纹/条目数），可选
 * @param {string} [opts.dshVersion]
 * @returns {{overall: string, counts: object, issues: Array, checkedAt: string}}
 */
export function runCheck(opts) {
  const { home, profile, baseline } = opts
  const profileDir = join(home, 'profiles', profile)
  const issues = []

  const add = (severity, code, message, extra = {}) => {
    issues.push({ severity, code, message, ...extra })
  }

  // ── 检查 1：文件存在与可读 ──
  for (const f of SNAPSHOT_FILES) {
    const p = join(profileDir, f)
    if (existsSync(p)) {
      try { readFileSync(p) } catch (e) {
        add('error', 'missing-file', `无法读取 ${f}：${e.code}`, { file: f })
      }
    } else if (f !== 'compatibility.json') {
      // compatibility.json 允许不存在
      add('warn', 'missing-file', `${f} 不存在`, { file: f })
    }
  }

  // ── 检查 2：package.json 结构 + bundles ──
  const manifestPath = join(profileDir, 'package.json')
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    add('fatal', 'bad-json', `package.json 不是合法 JSON：${e.message}`, { file: 'package.json' })
  }

  let bundles = []
  if (manifest) {
    bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) {
      add('fatal', 'no-bundles', 'package.json 缺少 dsh.profile.bundles 数组', { file: 'package.json' })
      bundles = []
    } else if (bundles.length === 0) {
      add('fatal', 'empty-bundles', 'bundles 为空 —— DSH 起不来', { file: 'package.json' })
    } else {
      const dup = bundles.filter((b, i) => bundles.indexOf(b) !== i)
      if (dup.length) {
        add('warn', 'duplicate-bundles', `bundles 有重复项：${[...new Set(dup)].join(', ')}`, { file: 'package.json' })
      }
    }
  }

  // ── 检查 3：bundles 可解析性（junction + manifest） ──
  //   ⚠️ 关键规则（实测 + 对照 dsh-doctor 得出）：
  //
  //   ① install-scope 包（@deepseek-ai/*）不在 profile 的 node_modules，
  //      而在 profiles/ 下的共享 node_modules。
  //   ② 那层里可能有「指向 DSH 安装目录 .pnpm 的符号链接」——
  //      目标常常不存在（DSH 升级后遗留），但 **DSH 本身能从 asar 解析它们**。
  //      实测：@deepseek-ai/dsh-base 的链接目标 ENOENT，DSH 仍正常启动。
  //   ⇒ 所以：符号链接目标不存在【不是 fatal】，最多 info。
  //      判定「起不来」只能靠「profile 层连链接都没有」。
  const nmLocal = join(profileDir, 'node_modules')
  const nmShared = join(home, 'profiles', 'node_modules')
  for (const name of bundles) {
    const localPath = join(nmLocal, name)
    const sharedPath = join(nmShared, name)

    if (existsSync(localPath)) {
      checkBundleAt(localPath, name, add, opts)
      continue
    }
    // profile 层没有 → 看共享层
    let lst = null
    try { lst = lstatSync(sharedPath) } catch { /* 不存在 */ }

    if (!lst) {
      // ⚠️ 三层都找不到条目 —— 但这不一定是问题（2026-10-19 实测修正）。
      //
      //   官方 experimental 包（如 @deepseek-ai/dsh-experimental-auto-review）
      //   只存在于 app.asar 里，永远不会解压到 profiles/node_modules。
      //   DSH 直接从 asar 加载它们 → 「node_modules 里没有」是正常现象。
      //
      //   实测：desktop 的 bundles 里有 3 个 experimental 包，
      //        两层 node_modules 都没有，但 DSH 仍能正常 compose
      //        出 79,865 字节的完整配置树，零错误。
      //
      //   ⇒ 判定改为：
      //      · @deepseek-ai/* 官方包 → info（从 asar 加载，正常）
      //      · 第三方包缺失         → fatal（真的不会加载）
      if (name.startsWith('@deepseek-ai/')) {
        add('info', 'bundle-official-from-asar',
          `${name} 是 DSH 官方包，由 app.asar 直接提供（node_modules 里没有属正常）`,
          { file: 'package.json', package: name })
      } else {
        add('fatal', 'bundle-not-found',
          `bundles 里的第三方插件 ${name} 在 node_modules 找不到（该插件不会被加载）`,
          { file: 'package.json', package: name })
      }
      continue
    }

    if (lst.isSymbolicLink()) {
      // 是链接 —— 检查目标是否可达
      try {
        const real = realpathSync(sharedPath)
        checkBundleAt(real, name, add, opts)
      } catch {
        // 链接目标不存在。DSH 能从 asar 解析，所以只是提示
        add('info', 'bundle-link-dangling',
          `${name} 是符号链接，但目标不存在（DSH 升级后的常见遗留，DSH 自身可从 asar 解析）`,
          { file: 'package.json', package: name })
      }
      continue
    }

    checkBundleAt(sharedPath, name, add, opts)
  }

  // ── 检查 6：用户层 patch 结构 + 危险覆盖 ──
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let patchText = null
  try {
    patchText = readFileSync(patchPath, 'utf8')
  } catch (e) {
    add('fatal', 'missing-file', `无法读取 cordis.patch.yml：${e.code}`, { file: 'cordis.patch.yml' })
  }

  let patchCount = 0
  if (patchText !== null) {
    const parsed = parsePatchSubset(patchText)
    if (!parsed.ok) {
      add('fatal', 'bad-yaml', `cordis.patch.yml 语法错误：${parsed.reason}（第 ${parsed.line} 行）`,
        { file: 'cordis.patch.yml' })
    } else {
      patchCount = parsed.count
      const ids = patchEntryIds(patchText)

      // ⚠️ 重复判定要区分来源（实测得出）：
      //   `- insert:` 里创建的 id + 后续 `- id: X` 覆盖行
      //   = DSH 的合法组合（先插入行，再改它的 config）。
      //   例：whale-art / boot-animation 正是这种写法。
      //   只有【两条顶层覆盖行】用同一 id 才是真重复。
      const insertIds = new Set()
      const overrideIds = []
      for (const e of parsed.entries) {
        if (e.kind === 'insert') for (const x of e.ids) insertIds.add(x)
        else if (e.kind === 'id' && e.value) overrideIds.push(e.value)
      }
      // models: 这类 config 内部列表项不会进 entries，无需排除
      const trueDup = overrideIds.filter((x, i) => overrideIds.indexOf(x) !== i)
      const dupList = [...new Set(trueDup)].filter((x) => !insertIds.has(x))
      if (dupList.length) {
        add('warn', 'duplicate-user-id',
          `用户层有重复的覆盖行 id：${dupList.join(', ')}（后面的会覆盖前面的）`,
          { file: 'cordis.patch.yml' })
      }

      for (const id of ids) {
        if (REQUIRED_ENTRY_IDS.includes(id)) {
          add('error', 'dangerous-user-override',
            `用户层覆盖了 required 服务行 "${id}" —— 可能导致 DSH 起不来`,
            { file: 'cordis.patch.yml', entryId: id })
        }
      }
      // 服务行覆盖 —— ⚠️ 这是 DSH 明确支持的「能力接缝」，不是错误。
      //   对照 dsh-doctor：同样情况报 info（bundle-overrides-seam）。
      //   本机实测：ui-chat / ui-settings / permission / agent-preset-registry
      //   都是正常配置，不是危险操作。所以降为 info。
      const SEAM_IDS = ['web', 'ui-chat', 'ui-settings', 'permission', 'agent-preset-registry']
      for (const id of ids) {
        if (SEAM_IDS.includes(id)) {
          add('info', 'bundle-overrides-seam',
            `用户层覆盖了服务行 "${id}"（DSH 支持的能力接缝，正常）`,
            { file: 'cordis.patch.yml', entryId: id })
        }
      }

      // ── 检查 6b：循环依赖风险（§3.1c · P1+P2）──
      //   P1：用户层覆盖了核心服务行，且 config 指向第三方 provider
      //   P2：该 provider 自己的 inject 含这个服务 → 真的成环
      try {
        const risks = detectCircularRisk(patchText, profileDir)
        for (const r of risks) {
          add('error', 'circular-service-dependency',
            `循环依赖风险：${r.evidence}。症状是 DSH 能启动但所有 agent 功能失效（waiting for ${r.waitingFor}）。`,
            { file: 'cordis.patch.yml', entryId: r.id, package: r.provider })
        }
      } catch { /* 忽略 */ }
    }
  }

  // ── 检查 6c：同一 package 多个 client 源（2026-10-28 surfcore 事故）──
  //
  //   cordis.patch.yml 里两行 loader 条目（id 不同、name 不同）解析到同一个
  //   含 dsh.client 的 package.json 时，dsh-client-modules 的
  //   reconcilePackage() 会直接抛错，整个应用起不来：
  //     "package X resolves from multiple active Loader sources; remove one entry"
  //
  //   duplicate-user-id 查不出（那个只比 id），所以单独走一遍。
  try {
    // 收集各 bundle 的插件目录（它们自己的 cordis.patch.yml 也会加载 row）
    const bundleDirs = []
    try {
      const pkgPath = join(profileDir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8'))
        const names = pkgJson?.dsh?.profile?.bundles ?? []
        for (const nm of names) {
          const dir = join(profileDir, 'node_modules', nm.replace(/\//g, process.platform === 'win32' ? '\\' : '/'))
          if (existsSync(join(dir, 'cordis.patch.yml'))) {
            bundleDirs.push({ dir, label: nm })
          }
        }
      }
    } catch { /* 忽略 */ }
    scanClientSourceConflicts(profileDir, home, add, bundleDirs)
  } catch { /* 检查失败不影响其它项 */ }

  // ── 检查 6c：代理环境变量（2026-11-14 事故）──
  //
  //   用户级 HTTP_PROXY/HTTPS_PROXY 指向一个没启动的代理，
  //   DSH 0.2.2 起会把全局 dispatcher 换成 ProxyAgent →
  //   所有 provider 统一报 "DeepSeek Messages transport failed"。
  //   报错完全不指向真因，换模型换 provider 全都白试。
  try {
    scanProxyEnv(add)
  } catch { /* 环境变量读不到不影响其它检查 */ }

  // ── 检查 6d：内核核心包副本（2026-11-04 事故）──
  //
  //   插件安装把官方核心包装进 profile 的 node_modules，
  //   与内核自带副本形成两套模块实例 → 所有 Agent 预设 broken。
  //   实测：这种状态下 FK 原来报「一切正常」，回滚也无用（快照不含 node_modules）。
  try {
    scanCorePackageCopies(profileDir, home, opts.dshVersion, add)
  } catch { /* 检查失败不影响其它项 */ }

  // ── 检查 7：完整性与基准比对 ──
  if (baseline && typeof baseline.entryCount === 'number' && patchText !== null) {
    const drop = baseline.entryCount - patchCount
    if (baseline.entryCount > 0 && drop > 0) {
      const pct = drop / baseline.entryCount
      if (pct >= 0.3) {
        add('fatal', 'patch-entries-dropped',
          `cordis.patch.yml 条目数异常：${baseline.entryCount} → ${patchCount}（少了 ${Math.round(pct * 100)}%）`,
          { file: 'cordis.patch.yml' })
      } else {
        add('error', 'patch-entries-decreased',
          `cordis.patch.yml 条目数减少：${baseline.entryCount} → ${patchCount}`,
          { file: 'cordis.patch.yml' })
      }
    }
  }

  // ── 检查 8：lockfile link 路径 ──
  const lockPath = join(profileDir, 'pnpm-lock.yaml')
  if (existsSync(lockPath)) {
    try {
      const lock = readFileSync(lockPath, 'utf8')
      // 只做粗查：link: 路径里如果出现 "profiles/desktop/profiles" 这种重复层级，明显有问题
      const bad = lock.match(/link:[^\n]*profiles[\\/]\w+[\\/]profiles/g)
      if (bad) {
        add('error', 'lockfile-bad-link', `pnpm-lock.yaml 里有层级异常的 link 路径（共 ${bad.length} 处）`,
          { file: 'pnpm-lock.yaml' })
      }
    } catch { /* 忽略 */ }
  } else {
    add('warn', 'no-lockfile', 'pnpm-lock.yaml 不存在', { file: 'pnpm-lock.yaml' })
  }

  // ── 检查 9：pnpm-workspace.yaml 必须是 mapping ──
  const wsPath = join(profileDir, 'pnpm-workspace.yaml')
  if (existsSync(wsPath)) {
    try {
      const ws = readFileSync(wsPath, 'utf8')
      const firstMeaningful = ws.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'))
      if (firstMeaningful && !/^[\w.-]+\s*:/.test(firstMeaningful.trim()) && !/^-\s/.test(firstMeaningful.trim())) {
        add('error', 'workspace-not-mapping',
          'pnpm-workspace.yaml 顶层不是 YAML mapping —— readPolicy() 会抛异常',
          { file: 'pnpm-workspace.yaml' })
      }
    } catch { /* 忽略 */ }
  }

  // ── 检查 10：cordis.yml 形态是否合理 ──
  //
  // ⚠️ 2026-10-22 修正误报：
  //
  //   DSH 启动时会把「组合后的完整配置树」写进 cordis.yml ——
  //   实测 214 个条目 / 80 KB，含 43 处 !!js 表达式。
  //   这是【正常运行时产物】，不是用户该管的东西。
  //
  //   旧逻辑只读最后一行判断是不是 []，
  //   而配置树的最后一行是 `toolCallTimeoutMs: 120000` → 误报 warn。
  //
  //   正确判断：这个文件只有三种合法形态
  //     ① 纯注释（还没启动过）
  //     ② []（模板初始态）
  //     ③ YAML 列表（DSH 生成的配置树，顶层是 `- id:`）
  //   其他形态才提示。
  const rootCfg = join(profileDir, 'cordis.yml')
  if (existsSync(rootCfg)) {
    try {
      const t = readFileSync(rootCfg, 'utf8')
      const meaningful = t.split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))

      if (meaningful.length === 0) {
        // ① 纯注释 —— 正常
      } else if (meaningful.length === 1 && meaningful[0] === '[]') {
        // ② 模板初始态 —— 正常
      } else if (meaningful[0].startsWith('- id:') || meaningful[0] === '- id:') {
        // ③ DSH 生成的配置树 —— 正常（每次启动重写的产物）
      } else {
        // ④ 其他形态 —— 才提示可能是手工改坏了
        add('warn', 'root-config-unexpected',
          `cordis.yml 形态异常（首行：${meaningful[0].slice(0, 50)}）`
          + ' —— 它应由 DSH 自动生成（[] 或配置树），不该手写其他内容',
          { file: 'cordis.yml' })
      }
    } catch { /* 忽略 */ }
  }

  // ── 检查 11：home 层 patch 可解析性（纯只读） ──
  const homePatch = join(home, 'cordis.patch.yml')
  if (existsSync(homePatch)) {
    try {
      const hp = readFileSync(homePatch, 'utf8')
      const r = parsePatchSubset(hp)
      if (!r.ok) {
        add('fatal', 'home-layer-unparsable',
          `$DSH_HOME/cordis.patch.yml 无法解析：${r.reason} —— 它坏了 DSH 起不来，且本插件救不了`
          + `（home 层不在快照范围）。请手动删除或修复它。`,
          { file: '..\\cordis.patch.yml', absolutePath: homePatch })
      }
    } catch (e) {
      add('fatal', 'home-layer-unreadable', `$DSH_HOME/cordis.patch.yml 读取失败：${e.code}`,
        { absolutePath: homePatch })
    }
  }

  // ── ⭐ Electron 运行时状态体检（2026-10-22 事故后新增）──
  //
  // 为什么单独查这一块：
  //   事故现象：DSH 完全起不来，弹「Web authentication failed」，
  //   快照还原和「禁用第三方插件」按钮都无效。
  //
  //   根因是 Chromium 的认证状态库（Cookies / shared_proto_db）被强杀写坏，
  //   而这条链路和 DSH 配置文件无关 —— 所以配置体检完全查不到。
  //
  //   这里补上：只读检查，不修改任何东西。
  try {
    const es = checkEstate()
    if (es.ok) {
      for (const p of es.problems) {
        add('fatal', p.code, p.message, { path: p.path, estatePath: p.path })
      }
      for (const p of es.notices) {
        add('info', p.code, p.message, { path: p.path, estatePath: p.path })
      }
    }
  } catch { /* 状态体检失败不影响配置体检 */ }

  // ── §3.5 过滤「已确认可接受且签名仍有效」的项 ──
  //   被确认的项：不再计入健康判定，但仍返回（带 acknowledged 标记）供台账查看
  let finalIssues = issues
  let ackedCount = 0
  const ackPath = join(home, 'rollback-snapshots', profile, 'acknowledged.json')
  try {
    const acked = existsSync(ackPath) ? JSON.parse(readFileSync(ackPath, 'utf8')) : {}
    const r = filterAcknowledgedShallow(issues, acked)
    finalIssues = r.kept
    ackedCount = r.ackedCount
  } catch { /* 忽略 */ }

  // ── 分三层（2026-10-19 用户质问后重做）──
  //
  //   problems  = 真问题（fatal / error / warn）→ 用户要处理
  //   notices   = 提示（info，但会影响某功能）  → 看一眼就行
  //   normal    = 已知的正常状态                → 不用管，默认隐藏
  //
  // 关键：normal 和已确认的项【都不计入 counts】，也不影响 overall。
  const problems = []
  const notices = []
  const normal = []
  const acknowledged = []

  for (const it of finalIssues) {
    if (it.acknowledged) { acknowledged.push(it); continue }
    if (isNormalCode(it.code)) { normal.push(it); continue }
    if (it.severity === 'fatal' || it.severity === 'error') { problems.push(it); continue }
    if (it.severity === 'warn') { problems.push(it); continue }
    notices.push(it)
  }

  const counts = { fatal: 0, error: 0, warn: 0, info: 0 }
  for (const it of [...problems, ...notices]) counts[it.severity] = (counts[it.severity] ?? 0) + 1

  const overall = counts.fatal > 0 ? 'fatal'
    : counts.error > 0 ? 'error'
      : counts.warn > 0 ? 'warn' : 'ok'

  // 一句话结论：普通用户只看这句
  let verdict
  if (counts.fatal > 0) {
    verdict = '有致命问题 —— DSH 很可能起不来，建议尽快回滚到健康快照'
  } else if (counts.error > 0) {
    verdict = '有 ' + counts.error + ' 个错误 —— 某个功能可能失效，建议查看详情'
  } else if (counts.warn > 0) {
    verdict = '有 ' + counts.warn + ' 个警告 —— 一般不影响使用，可以稍后处理'
  } else {
    verdict = '一切正常'
  }

  return {
    overall, counts,
    verdict,
    problems,                 // ⭐ 真问题（UI 只显示这些）
    notices,
    normal,                   // ⭐ 正常状态（UI 默认隐藏）
    normalCount: normal.length,
    acknowledged,
    acknowledgedCount: acknowledged.length,
    issues: finalIssues,      // 兼容旧字段
    checkedAt: new Date().toISOString(),
  }
}

/**
 * 浅版过滤（check.mjs 内不依赖 core 的签名计算，签名由 core 提供）。
 * 这里只做「有没有确认过」的标记，签名校验交给 core。
 */
function filterAcknowledgedShallow(issues, acked) {
  const kept = []
  let ackedCount = 0
  for (const it of issues) {
    const key = it.package ?? it.entryId ?? '*'
    const rec = acked?.[it.code]?.[key]
    if (rec) {
      kept.push(Object.assign({}, it, {
        acknowledged: true,
        ackedAt: rec.ackedAt,
        ackReason: rec.reason,
      }))
      ackedCount += 1
    } else {
      kept.push(it)
    }
  }
  return { kept, ackedCount }
}


/**
 * 校验 client.js 里的模块 loader id / exports.name 是否与包名一致。
 *
 * @param {string} dir    插件目录
 * @param {string} ce     exports["./client"] 的相对路径
 * @param {string} name   package.json 的 name
 * @param {Function} add  问题收集器
 */
function checkClientLoaderId(dir, ce, name, add) {
  const file = join(dir, ce.replace(/^\.\//, ''))
  let src = null
  try {
    src = readFileSync(file, 'utf8')
  } catch { return }

  // 只扫前 200 行 —— loader 声明都在文件头部，全文扫会误伤注释里的示例
  const head = src.split('\n').slice(0, 200).join('\n')

  // ① __ModuleLoader__.load({ id: 'xxx', ... })
  const m = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[^}]*?\bid\s*:\s*['"]([^'"]+)['"]/s.exec(head)
  if (m) {
    const declared = m[1]
    if (declared !== name) {
      add('fatal', 'client-loader-id-mismatch',
        `client.js 的模块 id 是「${declared}」，与包名「${name}」不一致 —— `
        + 'DSH 会认为两个模块注册同一 factory（duplicate factory registration），启动直接中止',
        { file: `${name}/${ce.replace(/^\.\//, '')}`, package: name, entryId: declared })
    }
  }

  // ② exports.name = 'xxx'（部分插件还会再声明一次）
  const m2 = /exports\.name\s*=\s*['"]([^'"]+)['"]/.exec(head)
  if (m2) {
    const en = m2[1]
    // Host 侧的 export const name 常常是短名（去掉 dsh- 前缀），两种都接受
    const short = name.replace(/^dsh-/, '')
    const okForms = new Set([name, short])
    // 也允许 fk- 之类的风格差异：只要不是「明显另一个插件的名字」就算过
    // 判定标准：不能等于别的 dsh- 包名的短形式，且不能为空
    if (!okForms.has(en) && en.includes('-') && !short.includes(en) && !en.includes(short)) {
      add('warn', 'client-exports-name-mismatch',
        `client.js 的 exports.name 是「${en}」，与包名「${name}」风格不一致 —— `
        + '改名时容易漏改，可能引起模块重复注册',
        { file: `${name}/${ce.replace(/^\.\//, '')}`, package: name, entryId: en })
    }
  }
}

/**
 * 检查单个 bundle 目录（已确认存在的「真实目录」）。
 * 负责 client 导出与 engines.dsh 两项。
 */
function checkBundleAt(dir, name, add, opts) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    add('fatal', 'bundle-no-manifest',
      `${name} 目录里没有 package.json（junction 可能指向空）`,
      { file: 'package.json', package: name })
    return
  }

  let pkg = null
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { /* 忽略 */ }
  if (!pkg) return

  // ── client 导出（10-17 事故根因）──
  if (pkg?.dsh?.client) {
    const ce = resolveClientExport(pkg)
    if (!ce) {
      add('fatal', 'client-export-missing',
        `${name} 声明了 dsh.client，但 exports 里没有 "./client" —— DSH 起不来`,
        { file: `${name}/package.json`, package: name })
    } else if (!existsSync(join(dir, ce.replace(/^\.\//, '')))) {
      add('fatal', 'client-file-missing',
        `${name} 的 exports["./client"] 指向的文件不存在：${ce}`,
        { file: `${name}/package.json`, package: name })
    } else {
      // ── ⭐ client.js 的 module loader id 是否与包名一致 ──
      //
      // 2026-10-21 事故根因：
      //   OFM 插件改名时只改了 package.json / cordis.patch.yml，
      //   漏掉 client.js 第 22 行的 __ModuleLoader__.load({ id: ... })。
      //   Host 侧叫新名、前端仍报旧名 → DSH 认为两个模块注册同一 factory
      //   → "client-modules: duplicate factory registration"
      //   → dsh-client-modules 启动失败 → 全量启动中止（DSH 完全起不来）。
      //
      // 这个错误的特征是「静态看不出、启动才知道崩」，所以必须体检提前拦。
      checkClientLoaderId(dir, ce, name, add)
    }
  }

  // ── engines.dsh 精确锁定 ──
  const declared = pkg?.engines?.dsh
  if (typeof declared === 'string' && declared.trim() !== '' && opts.dshVersion) {
    const v = declared.trim()
    const isExact = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v)
    if (isExact && v !== opts.dshVersion) {
      add('error', 'engines-exact-mismatch',
        `${name} 的 engines.dsh 精确锁定在 ${v}，当前是 ${opts.dshVersion}`
        + '（DSH 会跳过它；可按需在 profile 的 compatibility.json 里加豁免）',
        { file: `${name}/package.json`, package: name })
    }
  }
}


// ─────────────────────────────────────────────────────────────
// 循环依赖检测（§3.1c · P1 窄规则 + P2 启发式）
// ─────────────────────────────────────────────────────────────

/** 核心服务行：覆盖它们才可能引发「waiting for X」死锁。 */
export const CORE_SERVICE_IDS = [
  'ui-chat', 'ui-settings', 'permission', 'agent-preset-registry',
  'agent-loop', 'web', 'webserver', 'web-runtime', 'modules', 'connection',
]

/** config 里指向第三方 provider 的键（P1 窄规则的第二个条件）。 */
const PROVIDER_KEYS = [
  'searchProvider', 'provider', 'preset', 'model', 'agentPreset',
  'defaultModel', 'toolWeb', 'webProvider',
]

/**
 * 从 patch 文本里提取「覆盖行的 config 中出现的 provider 值」。
 *
 * 这是纯文本扫描：找到 `- id: X` 之后、下一条 `- ` 之前的缩进块，
 * 在块里找 PROVIDER_KEYS 对应的值。
 *
 * @returns {Array<{id: string, providers: string[]}>}
 */
/**
 * 从 patch 文本里提取所有「loader 条目」（id / name / disabled）。
 *
 * parsePatchSubset() 只收集 id，但要判断「两个条目是否指向同一个 package」
 * 必须拿到 name，所以单独解析一遍。
 *
 * @param {string} text cordis.patch.yml 内容
 * @returns {Array<{id:string, name:string, disabled:boolean, line:number}>}
 */
export function parseLoaderRows(text) {
  const lines = text.split(/\r?\n/)
  const rows = []
  let cur = null

  /** 提交当前条目 */
  const flush = () => {
    if (cur !== null && cur.name !== '') rows.push(cur)
    cur = null
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\t/g, '  ')
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    // `- id: xxx` 或 `- id: "xxx"`（顶层或 insert 子项都算）
    const idM = /^-\s+id\s*:\s*(.+)$/.exec(trimmed)
    if (idM !== null) {
      flush()
      cur = {
        id: unquoteLoose(idM[1]),
        name: '',
        disabled: false,
        line: i + 1,
      }
      continue
    }

    if (cur === null) continue

    // 同级 key（不是新的 `- xxx:` 列表项）
    const kv = /^([\w@/.-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (kv === null) continue
    const key = kv[1]
    const val = unquoteLoose(kv[2])

    if (key === 'name' && cur.name === '') cur.name = val
    else if (key === 'disabled' && /^true$/i.test(val)) cur.disabled = true
  }
  flush()
  return rows
}

/** 去引号（宽松版，容忍尾部注释）。 */
function unquoteLoose(s) {
  let t = String(s ?? '').trim()
  // 去掉行尾注释（引号外）
  if (!t.startsWith('"') && !t.startsWith("'")) {
    const h = t.indexOf(' #')
    if (h > 0) t = t.slice(0, h).trim()
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * 把 loader 条目的 `name` 解析成「它归属的 package manifest」。
 *
 * 复刻 dsh-client-modules 的 locatePkgJson 语义（简化版）：
 *  · 包名（`surfcore`、`@scope/pkg`、`@scope/pkg/sub`）→ 在 node_modules 里逐级向上找
 *  · 相对路径（`./lib/x.js`）→ 相对 profile 目录解析，再向上找最近的 package.json
 *
 * @param {string} name    loader 条目的 name
 * @param {string} profileDir profile 目录
 * @param {string} home    DSH_HOME（用于在多个 node_modules 里找）
 * @returns {{packageName:string, pkgPath:string}|null}
 */
export function locatePkgForLoaderName(name, baseDir, home) {
  const nmDirs = [
    join(baseDir, 'node_modules'),
    join(home, 'profiles', 'desktop', 'node_modules'),
    join(home, 'node_modules'),
    // DSH 自带的插件也在 asar 里，这里探不到 —— 探不到就跳过，不算误报
  ]

  const isRelative = name.startsWith('./') || name.startsWith('../') || name.startsWith('/')

  if (isRelative) {
    // 相对路径：相对【本 patch 的 baseDir】解析，再向上找最近的 package.json
    let abs = name.startsWith('/') ? name : join(baseDir, name)
    // 文件可能带 .js 后缀，也可能是目录
    let probe = abs
    for (let depth = 0; depth < 8; depth += 1) {
      // 该路径本身是文件 → 从它的目录开始找
      const dir = (() => {
        try {
          if (existsSync(probe) && statSync(probe).isFile()) return dirnameOf(probe)
        } catch { /* 忽略 */ }
        return probe
      })()
      // 向上找 package.json
      let d = dir
      for (let up = 0; up < 12; up += 1) {
        const pj = join(d, 'package.json')
        if (existsSync(pj)) {
          try {
            const pkg = JSON.parse(readFileSync(pj, 'utf8'))
            if (typeof pkg?.name === 'string' && pkg.name !== '') {
              return { packageName: pkg.name, pkgPath: pj }
            }
          } catch { /* 忽略 */ }
        }
        const parent = dirnameOf(d)
        if (parent === d) break
        d = parent
      }
      break
    }
    return null
  }

  // 包名：可能在 node_modules 里，也可能有子路径
  for (const nm of nmDirs) {
    // 找最长可匹配的包根
    let pkgRoot = name
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const pj = join(nm, pkgRoot.replace(/\//g, sepChar()), 'package.json')
      if (existsSync(pj)) {
        try {
          const pkg = JSON.parse(readFileSync(pj, 'utf8'))
          if (typeof pkg?.name === 'string' && pkg.name !== '') {
            return { packageName: pkg.name, pkgPath: pj }
          }
        } catch { /* 忽略 */ }
      }
      // 逐段去掉尾部（@scope/pkg/sub → @scope/pkg → @scope）
      const idx = pkgRoot.lastIndexOf('/')
      if (idx <= 0) break
      pkgRoot = pkgRoot.slice(0, idx)
      if (pkgRoot.startsWith('@') && !pkgRoot.includes('/')) break
    }
  }
  return null
}

/** 路径分隔符（Windows 上 join 需要）。 */
function sepChar() {
  return process.platform === 'win32' ? '\\' : '/'
}

/** dirname 的薄包装（避免在文件顶部再加 import）。 */
function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i <= 0 ? p : p.slice(0, i)
}

/**
 * DSH 内核自带的核心包（不在 node_modules 里，由 app.asar 提供）。
 *
 * ⚠️ 2026-11-04 事故：这些包一旦出现在 profile 的 node_modules 里，
 *    就会和内核自带的同名包形成【两套模块实例】，导致：
 *
 *      dsh-scope        对象身份判断失效（它用 === 判 scope）
 *      dsh-system-prompt 提示词分层失效（全局层 vs agent scoped 层）
 *      cordis           服务与上下文实例分裂
 *         ↓
 *      插件注册提示词时不被识别为「当前 agent 作用域」
 *         ↓
 *      落到了全局层，而全局层已有同名段落
 *         ↓
 *      PromptLayer 抛 `prompt section "X" is already registered`
 *         ↓
 *      激活审计失败 → 所有 Agent 预设标记 broken → 会话无法创建/恢复
 *
 *    用户可见症状：新建会话失败、恢复会话失败、
 *    「所有预设同时报 prompt section 重复注册」。
 *
 * 判定策略（2026-11-04 实测 asar 源码得出）：
 *   · 只有【按对象身份判作用域】的包才致命 —— 即 Symbol.for = 0 的那三个
 *   · cordis / cosmokit / schemastery 用 Symbol.for 做全局注册表，
 *     两份实例能认出彼此 → 跨实例安全 → 不报警
 *     （2026-11-04 曾误报为 warn，用户质疑后查源码确认无害，已移除）
 */
const DSH_CORE_SCOPED_PACKAGES = {
  // 涉及「对象身份 / 作用域」的包 —— 有副本必然导致预设损坏
  'cordis': 'fatal',
  'dsh-scope': 'fatal',
  'dsh-system-prompt': 'fatal',
  'dsh-llm': 'fatal',

  // ⚠️ 2026-11-04 修正：cosmokit 与 schemastery 【不报警】。
  //
  //   我第一版把它们报成 warn，是【误报】。实测 asar 源码：
  //
  //     cordis        Symbol.for = 21                      → 跨实例安全
  //     cosmokit      Symbol.for = 1,  globalThis = 2      → 跨实例安全
  //     schemastery   Symbol.for = 2,  globalThis = 9      → 跨实例安全
  //        （Symbol.for("schemastery") + globalThis.__schemastery_index__）
  //
  //   它们用 Symbol.for 做全局注册表，两份实例能认出彼此 → 多一份无害。
  //   对比致命的那三个：Symbol.for = 0，纯按对象身份 (===) 判 → 多一份必冲突。
  //
  //   实测印证：用户保留了 cosmokit / schemastery 两份副本，
  //   DSH 启动正常、5 个预设全部 OK。
}

/** 读一个包的版本号。 */
function pkgVersionOf(pkgJsonPath) {
  try {
    const d = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    return typeof d?.version === 'string' ? d.version : null
  } catch { return null }
}

/**
 * 检查 profile 的 node_modules/@deepseek-ai/ 里有没有内核核心包的副本。
 *
 * @param {string} profileDir
 * @param {string} home
 * @param {string} dshVersion  当前 DSH 版本（用于判断「同版本副本」）
 * @param {Function} add
 */
export function scanCorePackageCopies(profileDir, home, dshVersion, add) {
  const scopedDir = join(profileDir, 'node_modules', '@deepseek-ai')
  if (!existsSync(scopedDir)) return

  let names
  try { names = readdirSync(scopedDir) } catch { return }

  const fatalHits = []

  for (const name of names) {
    const level = DSH_CORE_SCOPED_PACKAGES[name]
    if (level === undefined) continue          // 不是内核核心包，跳过

    const pkgJson = join(scopedDir, name, 'package.json')
    if (!existsSync(pkgJson)) continue

    const ver = pkgVersionOf(pkgJson)
    const sameVersion = typeof dshVersion === 'string'
      && typeof ver === 'string'
      && ver === dshVersion

    fatalHits.push({ name, ver, sameVersion })
  }

  // ── 致命：作用域类核心包有了副本 ──
  if (fatalHits.length > 0) {
    const list = fatalHits
      .map((x) => `@deepseek-ai/${x.name}${x.ver ? '@' + x.ver : ''}`)
      .join('、')

    add('fatal', 'core-package-duplicate',
      `profile 的 node_modules/@deepseek-ai/ 里有 ${fatalHits.length} 个 DSH 内核核心包的副本：${list}`
      + ' —— 它们会和内核自带的同名包形成【两套模块实例】，'
      + '导致 dsh-scope / dsh-system-prompt 的作用域判断失效，'
      + '表现为「所有 Agent 预设同时报 prompt section is already registered」、'
      + '新建会话与恢复会话全部失败。',
      {
        file: `node_modules/@deepseek-ai`,
        packages: fatalHits.map((x) => x.name),
        // 明说要做什么 —— 这个不能靠回滚解决
        hint: '把 node_modules/@deepseek-ai 下这些目录【移动】到备份处'
          + '（不要删除，便于排查），然后重启 DSH。'
          + '⚠️ 回滚快照救不了这个问题 —— 快照不包含 node_modules。',
      })
  }

}

/**
 * 检查「同一个 package 出现多个 client 源」—— 这是 DSH 的硬性约束。
 *
 * 源码依据（dsh-client-modules/lib/index.js）：
 *
 *   resolveMeta(loaderName, baseUrl):
 *     located = locatePkgJson(loaderName, baseUrl)
 *     if (!located) return null                          ← 解析不到就跳过
 *     decl = parseDshClient(pkg.dsh?.client)
 *     if (!decl || decl.platform !== 'web') return null  ← 不算 client 源
 *     return { packageName, meta }
 *
 *   reconcilePackage(packageName):
 *     sources = 所有 packageName 相同的 source
 *     if (sources.length > 1) throw
 *       `package X resolves from multiple active Loader sources: ...; remove one entry`
 *
 *   sourceKey = sourceKey(loaderName, baseUrl)   ← 按【原始 name】去重
 *
 * ⚠️ 必须遍历【所有 patch 源】，不能只看 profile 的：
 *
 *     每个 bundle（插件）自己的 cordis.patch.yml 也会被加载，
 *     而且它的 baseUrl 是【插件目录】而不是 profile 目录。
 *
 *     2026-10-28 surfcore 事故正是这种情况：
 *       surfcore/cordis.patch.yml 里两行
 *         name: surfcore          → 相对插件目录 → node_modules/surfcore/
 *         name: ./lib/qq-mode.js  → 相对插件目录 → node_modules/surfcore/lib/qq-mode.js
 *                                              → 向上找 → node_modules/surfcore/package.json
 *       两者归同一 package → DSH 起不来。
 *
 *     只查 profile 的 patch 会漏掉这个案子。
 *
 * @param {string} profileDir
 * @param {string} home
 * @param {Function} add  add(severity, code, message, extra)
 * @param {Array<{dir:string, label:string}>} [bundles] 各 bundle 插件目录
 */
export function scanClientSourceConflicts(profileDir, home, add, bundles = []) {
  // ── patch 源清单：profile 一层 + 每个 bundle 一层 ──
  const patchSources = [
    { dir: profileDir, label: 'profile 的 cordis.patch.yml' },
  ]
  for (const b of bundles) {
    if (typeof b?.dir === 'string' && b.dir !== '') {
      patchSources.push({ dir: b.dir, label: `${b.label ?? 'bundle'} 的 cordis.patch.yml` })
    }
  }

  // packageName -> [{ name, id, line, sourceLabel }]
  const byPackage = new Map()

  for (const src of patchSources) {
    const patchPath = join(src.dir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) continue

    let text
    try { text = readFileSync(patchPath, 'utf8') } catch { continue }

    const rows = parseLoaderRows(text)
    if (rows.length === 0) continue

    for (const row of rows) {
      if (row.disabled) continue
      // name 相对【本 patch 的目录】解析
      const loc = locatePkgForLoaderName(row.name, src.dir, home)
      if (loc === null) continue

      // 判断该 manifest 是否真的会注册 client 源
      let platform = null
      try {
        const pkg = JSON.parse(readFileSync(loc.pkgPath, 'utf8'))
        const decl = pkg?.dsh?.client
        if (decl !== undefined && decl !== null) {
          platform = typeof decl === 'object' ? decl.platform : 'web'
        }
      } catch { continue }
      if (platform !== 'web') continue   // 不是 client 源，DSH 会跳过

      const key = loc.packageName
      const arr = byPackage.get(key) ?? []
      arr.push({
        name: row.name,
        id: row.id,
        line: row.line,
        sourceLabel: src.label,
      })
      byPackage.set(key, arr)
    }
  }

  for (const [packageName, list] of byPackage) {
    // 按 loader name 去重（同 name = 同一个 sourceKey = 覆盖，不算两个源）
    const uniqueNames = [...new Set(list.map((x) => x.name))]
    if (uniqueNames.length <= 1) continue

    const detail = list
      .map((x) => `「${x.name}」（id: ${x.id}，${x.sourceLabel} 第 ${x.line} 行）`)
      .join('、')

    add('fatal', 'duplicate-client-source',
      `package「${packageName}」被 ${uniqueNames.length} 个不同的 loader 条目指向：${detail} —— `
      + 'DSH 启动时会在 dsh-client-modules 里抛「resolves from multiple active Loader sources」，'
      + '整个应用起不来。删掉其中一行即可。',
      {
        file: 'cordis.patch.yml',
        package: packageName,
        entryId: list[0].id,
        lines: list.map((x) => x.line),
        names: uniqueNames,
      })
  }
}

export function scanServiceOverrides(patchText) {
  const lines = String(patchText ?? '').split(/\r?\n/)
  const out = []
  let cur = null

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length

    // 顶层 `- id: X`
    const top = /^-\s+id\s*:\s*(.+)$/.exec(trimmed)
    if (indent === 0 && top) {
      if (cur) out.push(cur)
      cur = { id: unquote(top[1]), providers: [] }
      continue
    }
    // 其他顶层 `- ` 开新块
    if (indent === 0 && /^-\s+/.test(trimmed)) {
      if (cur) out.push(cur)
      cur = null
      continue
    }
    if (!cur) continue

    // 缩进行里找 provider 值
    for (const k of PROVIDER_KEYS) {
      const m = new RegExp(`^${k}\\s*:\\s*(.+)$`).exec(trimmed)
      if (m) {
        const v = unquote(m[1])
        if (v && !/^(true|false|null|~|\d+)$/.test(v)) cur.providers.push(v)
      }
    }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 启发式：扫插件的 client/index JS 里有没有 `inject` 数组字面量。
 *
 * ⚠️ 这是尽力而为 —— 只认可以静态看出的字面量，压缩过的动态写法会漏。
 * 文档必须标注「启发式，会漏」。
 *
 * @returns {Set<string>} 该插件 inject 的服务名集合
 */
export function scanPluginInject(pkgDir) {
  const names = new Set()
  const candidates = [
    join(pkgDir, 'lib', 'client.js'),
    join(pkgDir, 'lib', 'index.js'),
    join(pkgDir, 'client.js'),
    join(pkgDir, 'index.js'),
    join(pkgDir, 'entry.js'),
    join(pkgDir, 'src', 'index.mjs'),
  ]
  for (const f of candidates) {
    if (!existsSync(f)) continue
    let t
    try {
      t = readFileSync(f, 'utf8')
    } catch { continue }
    // 匹配 inject: [...]  或  var inject = [...]  或 inject = [...]
    for (const m of t.matchAll(/\binject\s*[:=]\s*\[([^\]]{0,400})\]/g)) {
      for (const s of m[1].matchAll(/['"]([\w@/.-]+)['"]/g)) names.add(s[1])
    }
    // Host 侧 ctx.inject("x") / ctx.inject(['x'])
    for (const m of t.matchAll(/\.inject\(\s*\[\s*([^\]]{0,400})\]/g)) {
      for (const s of m[1].matchAll(/['"]([\w@/.-]+)['"]/g)) names.add(s[1])
    }
    for (const m of t.matchAll(/\.inject\(\s*['"]([\w@/.-]+)['"]\s*\)/g)) names.add(m[1])
  }
  return names
}

/**
 * P1 + P2：判断是否存在「服务覆盖 → 循环等待」的风险。
 *
 * @param {string} patchText      用户层 cordis.patch.yml
 * @param {string} profileDir     profile 目录（用于读插件 inject）
 * @returns {Array<{id, provider, waitingFor, evidence}>}
 */
export function detectCircularRisk(patchText, profileDir) {
  const results = []
  const overrides = scanServiceOverrides(patchText)

  for (const ov of overrides) {
    if (!CORE_SERVICE_IDS.includes(ov.id)) continue
    if (ov.providers.length === 0) continue        // 只有覆盖、没有 provider 指向

    for (const provider of ov.providers) {
      // 找 provider 这个包在哪儿（可能在 dependencies / node_modules）
      const candidates = [
        join(profileDir, 'node_modules', provider),
        join(profileDir, '..', 'node_modules', provider),
      ]
      let dir = null
      for (const c of candidates) {
        if (existsSync(c)) { dir = c; break }
      }
      if (!dir) continue

      const injects = scanPluginInject(dir)
      // P2：该 provider 自己 inject 了这个服务 → 成环
      if (injects.has(ov.id)) {
        results.push({
          id: ov.id,
          provider,
          waitingFor: ov.id,
          evidence: `「${provider}」的 inject 含「${ov.id}」，而用户层又把「${ov.id}」指向了它`,
        })
      }
    }
  }
  return results
}

/** 从 package.json 的 exports 里解析 client 入口路径。 */
export function resolveClientExport(pkg) {
  const ex = pkg?.exports
  if (ex === undefined || ex === null) return null
  const entry = typeof ex === 'string' ? null : ex['./client']
  if (entry === undefined || entry === null) return null
  if (typeof entry === 'string') return entry
  return entry.default ?? entry.import ?? entry.require ?? null
}

// ─────────────────────────────────────────────────────────────
// 插件集（供 §2.7 / §6.4 共用）
// ─────────────────────────────────────────────────────────────

/**
 * 计算「有效插件集」= bundles ∪ dependencies ∪ patch 里【insert 行的 name】。
 *
 * ⚠️ 关键：只收 `insert:` 里的 name，不收顶层 `- id:` 覆盖行的 name。
 *   因为顶层覆盖行的 name 常是「服务提供者」（如 @deepseek-ai/dsh-ui-theme），
 *   而 config 内的列表项（如 models: 下的 DeepSeek-V4.1-Flash）根本不是包名。
 *
 *   实测教训：早先版本把 patch 里所有 name 都收进来，
 *   结果把模型名 "DeepSeek-V4.1-Flash" 当成了插件。
 *
 * dsh-fk-restart-button / dsh-whale-art 这类只靠 insert 加载的插件必须被算进来，
 * 否则会被误判为幽灵。
 */
export function computeEffectivePlugins(profileDir, patchText = null) {
  const out = new Set()
  let manifest = null
  try { manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) } catch { /* 忽略 */ }
  for (const b of manifest?.dsh?.profile?.bundles ?? []) out.add(b)
  for (const d of Object.keys(manifest?.dependencies ?? {})) out.add(d)

  const pt = patchText ?? (() => {
    const p = join(profileDir, 'cordis.patch.yml')
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  })()

  if (pt) {
    const parsed = parsePatchSubset(pt)
    if (parsed.ok) {
      for (const e of parsed.entries) {
        // 只从 insert 段里取 name（那才是「新增一个插件」）
        if (e.kind === 'insert' && e.value) out.add(e.value)
      }
    }
    // 兜底：行内 `name:` 且值看起来像包名（含 dsh- 或 @scope/ 或已知插件前缀）
    for (const m of pt.matchAll(/^\s+name\s*:\s*['"]?([\w@/.-]+)['"]?\s*$/gm)) {
      const v = m[1]
      if (/^(dsh-|@[\w-]+\/|dshmarket)/.test(v)) out.add(v)
    }
  }
  return out
}

/** node_modules 顶层里「自带 dsh 字段」的包（用于幽灵检测，避免 hoisted 误报）。 */
export function listDshPackages(profileDir) {
  const nm = join(profileDir, 'node_modules')
  if (!existsSync(nm)) return []
  const out = []
  for (const name of readdirSync(nm)) {
    if (name.startsWith('.')) continue
    const pkgPath = join(nm, name, 'package.json')
    if (!existsSync(pkgPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg?.dsh) out.push(name)
    } catch { /* 忽略 */ }
  }
  return out
}
