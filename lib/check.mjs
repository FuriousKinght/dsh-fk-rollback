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
 * @version 1.5.1
 * @module 模块二
 */

import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync,
} from 'node:fs'
import { join, relative } from 'node:path'
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
