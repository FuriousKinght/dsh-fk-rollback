#!/usr/bin/env node
/**
 * FK 回滚插件 · 安装/修复助手
 *
 * 解决的具体问题（2026-10-25 朋友实测报错）：
 *
 *   [WARN] Moving dsh-fk-rollback to "node_modules\.ignored\dsh-fk-rollback_1".
 *          It is not in the dependency tree and pnpm has no record of installing it.
 *   [ERROR] Symlink path is the same as the target path
 *
 *   pnpm 源码（symlinkDir）:
 *       if (target === path) throw new Error('Symlink path is the same as the target path')
 *
 *   成因：node_modules 里有一个「不是 pnpm 装的」dsh-fk-rollback 目录
 *        （手动解压/复制进去的），pnpm 先把它移到 .ignored，
 *        再重建链接时路径算重了 → 报错。
 *
 * 本脚本做四件事，幂等，可反复运行：
 *   ① 确认插件在 <DSH_HOME>/plugin-src/dsh-fk-rollback
 *   ② 删掉 node_modules 里那个非法目录 + .ignored 残留
 *   ③ 把 dependencies 写成 pnpm 能识别的精确形式
 *   ④ 把 dsh-fk-rollback 加进 dsh.profile.bundles
 *
 * 用法（在解压出来的 dsh-fk-rollback 目录里）：
 *   node install.mjs
 *   node install.mjs --home "C:\Users\Administrator\.dsh"
 *   node install.mjs --dry-run
 *
 * @version 1.5.1
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync,
  lstatSync, cpSync, realpathSync,
} from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const VER = '1.6.0'

/**
 * ⚠️ 关键：Windows 不允许删除「进程当前工作目录」及其祖先。
 *
 *   2026-10-25 朋友实测踩到：
 *     他把插件解压到了 node_modules\dsh-fk-rollback，
 *     然后就在那个目录里运行 node install.mjs，
 *     于是脚本要删这个目录时抛 EPERM。
 *
 *   验证过：先 process.chdir() 离开，同一个 rmSync 就能成功。
 *
 *   所以脚本一开始就把 CWD 迁到一个绝对安全的位置（用户主目录），
 *   之后所有相对路径都用 HERE 拼，不再依赖 CWD。
 */
const SAFE_CWD = homedir()
try {
  process.chdir(SAFE_CWD)
} catch (e) {
  // 连主目录都切不了，退到临时目录
  try { process.chdir(process.env.TEMP || process.env.TMP || SAFE_CWD) } catch { /* 继续，后面会报 */ }
}

// ─────────────────────────────────────────────────────────────
// 参数
// ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
function argOf(name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined
}

// 不用 ANSI 颜色码：
// Windows 的 cmd.exe / 旧版 PowerShell 不会解释它们，
// 用户看到的是 "[32m✓[0m" 这种乱码，反而困惑。
// 用纯文本标记，任何终端都清楚。
const out = (s = '') => console.log(s)
const ok = (s) => console.log('  [OK]   ' + s)
const warn = (s) => console.log('  [note] ' + s)
const bad = (s) => console.log('  [FAIL] ' + s)

// ─────────────────────────────────────────────────────────────
// 找 DSH_HOME
// ─────────────────────────────────────────────────────────────

function findHome() {
  const explicit = argOf('--home')
  if (explicit) return resolve(explicit)
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)

  const cands = [
    join(homedir(), '.dsh'),
    join(HERE, '..', '..'),          // 插件放在 <DSH_HOME>/plugin-src/x 时，上两级就是 home
  ]
  // 常见自定义盘符
  for (const drive of ['D:', 'C:', 'E:', 'F:']) {
    cands.push(join(drive, '\\', 'dsh-data'))
  }
  for (const c of cands) {
    try {
      if (existsSync(join(c, 'profiles'))) return resolve(c)
    } catch { /* 下一个 */ }
  }
  return null
}

out('')
out('═'.repeat(62))
out(`  FK 回滚插件 · 安装/修复助手  v${VER}`)
out('═'.repeat(62))
out('')

const HOME = findHome()
if (!HOME) {
  bad('找不到 DSH 数据目录（含 profiles 的那个文件夹）')
  out('')
  out('  请显式指定：')
  out('    node install.mjs --home "C:\\Users\\Administrator\\.dsh"')
  out('')
  process.exit(2)
}

const PROFILE = 'desktop'
const PROFILE_DIR = join(HOME, 'profiles', PROFILE)
const NM_DIR = join(PROFILE_DIR, 'node_modules')
const TARGET = join(HOME, 'plugin-src', 'dsh-fk-rollback')
const PKG_JSON = join(PROFILE_DIR, 'package.json')

out(`  DSH_HOME : ${HOME}`)
out(`  profile  : ${PROFILE_DIR}`)
out(`  插件目标 : ${TARGET}`)
if (dryRun) out(`  模式     : 预演（不写任何文件）`)
out('')

/**
 * ⚠️ 2026-10-26 新增：检测 DSH 是否在运行。
 *
 *   真实事故：在 DSH 运行时跑本脚本，
 *   配置改完了但 pnpm install 装不上（文件被占用），
 *   留下「package.json 有依赖、node_modules 没链接」的半成品状态，
 *   DSH 下次启动就报 cannot resolve profile bundle。
 *
 *   所以先检测，运行中就让用户选：
 *     - 继续（只改配置，装依赖留给 DSH 启动时自动做）
 *     - 退出（用户先关 DSH 再来跑完整流程）
 */
function dshRunning() {
  if (process.platform !== 'win32') return null
  try {
    const tl = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe')
    const o = execFileSync(tl, ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    const c = (o.match(/DeepSeek Harness\.exe/gi) || []).length
    return c > 0 ? c : 0
  } catch {
    return null
  }
}

if (!existsSync(PKG_JSON)) {
  bad(`${PKG_JSON} 不存在`)
  out('')
  out('  请先启动一次 DSH，让它生成 desktop profile，再运行本脚本。')
  out('')
  process.exit(3)
}

// ─────────────────────────────────────────────────────────────
// ① 确认插件文件就位
// ─────────────────────────────────────────────────────────────

// ⭐ 2026-10-26：先看 DSH 是否在运行
//
//   在运行 → pnpm install 会失败，并留下「有依赖声明、无 node_modules 链接」
//   的半成品状态，DSH 下次启动报 cannot resolve profile bundle。
//   所以：运行中只做配置部分，并明确告知下一步怎么补依赖。
const dshCount = dshRunning()
let configOnly = false
if (dshCount === null) {
  warn('无法检测 DSH 进程（非 Windows 或 tasklist 不可用）')
} else if (dshCount > 0) {
  warn(`检测到 ${dshCount} 个 DSH 进程正在运行`)
  out('')
  out('  DSH 运行时无法完成依赖安装（文件被占用），会留下半成品状态，')
  out('  导致下次启动报 "cannot resolve profile bundle"。')
  out('')
  if (argv.includes('--config-only')) {
    out('  按 --config-only 继续：只改配置，不装依赖。')
    configOnly = true
  } else {
    out('  请选择：')
    out('')
    out('   A) 现在退出 DSH，然后重新运行本脚本（推荐，一次到位）')
    out('   B) 只改配置，稍后重启 DSH 让它自己装依赖：')
    out('        node install.mjs --config-only')
    out('')
    out('  什么也不做就退出，避免留下半成品。')
    out('')
    process.exit(0)
  }
} else {
  ok('DSH 没有运行，可以完整安装')
}
out('')

out('[1/4] 检查插件文件')

const SELF_IS_TARGET = (() => {
  try { return realpathSync(HERE).toLowerCase() === realpathSync(TARGET).toLowerCase() }
  catch { return false }
})()

if (SELF_IS_TARGET) {
  ok('插件已经在正确位置')
} else if (existsSync(TARGET)) {
  ok('目标目录已存在（视为已就位）')
  const havePkg = existsSync(join(TARGET, 'package.json'))
  if (!havePkg) {
    warn('但缺少 package.json —— 将用当前目录的内容覆盖')
    if (!dryRun) {
      rmSync(TARGET, { recursive: true, force: true })
      mkdirSync(TARGET, { recursive: true })
      cpSync(HERE, TARGET, { recursive: true })
    }
    ok('已复制')
  }
} else {
  if (dryRun) {
    ok(`将复制 ${HERE} -> ${TARGET}`)
  } else {
    mkdirSync(dirname(TARGET), { recursive: true })
    cpSync(HERE, TARGET, { recursive: true })
    ok(`已复制到 ${TARGET}`)
  }
}

// 关键校验：目标里必须有入口文件
for (const need of ['package.json', 'entry.js', 'lib/client.js', 'dsh-rollback.mjs']) {
  if (existsSync(join(TARGET, need))) continue
  bad(`缺少 ${need} —— 压缩包可能解压不完整`)
  process.exit(4)
}
ok('入口文件齐全')

// ─────────────────────────────────────────────────────────────
// ② 清理 node_modules 里的非法目录
// ─────────────────────────────────────────────────────────────

out('')
out('[2/4] 清理 node_modules（这是 pnpm 报错的直接原因）')

const strayDir = join(NM_DIR, 'dsh-fk-rollback')
const ignoredDir = join(NM_DIR, '.ignored')

function classifyLink(p) {
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return 'symlink'
    return st.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'missing'
  }
}

const kind = classifyLink(strayDir)
if (kind === 'missing') {
  ok('node_modules 里没有 dsh-fk-rollback —— 不会冲突')
} else if (kind === 'symlink') {
  // junction 指向别处，删掉它不影响源
  warn(`node_modules/dsh-fk-rollback 是个链接（${kind}），移除以便 pnpm 重建`)
  if (!dryRun) {
    try {
      rmSync(strayDir, { force: true })
      ok('已移除旧链接')
    } catch (e) {
      bad('移除失败（DSH 可能还在运行）：' + String(e?.message ?? e))
    }
  }
} else if (kind === 'dir') {
  bad('node_modules/dsh-fk-rollback 是一个【真实目录】')
  out('      说明插件曾被手动复制到 node_modules，pnpm 因此判定它为「孤儿」')
  out('      并挪到 .ignored，随后重建链接时路径冲突 → 就是你看到的报错')
  if (!dryRun) {
    try {
      rmSync(strayDir, { recursive: true, force: true })
      ok('已删除该目录')
    } catch (e) {
      bad('删除失败：' + String(e?.message ?? e))
      out('')
      out('  按顺序试这几种办法：')
      out('')
      out('  1) 完全退出 DSH（关窗口 + 确认托盘图标消失），再跑一次本脚本')
      out('')
      out('  2) 如果你现在就在这个目录里（提示符形如')
      out('       ...\\node_modules\\dsh-fk-rollback> ），')
      out('     先切到别处再运行：')
      out('       cd %USERPROFILE%')
      out('       node "<本脚本完整路径>"')
      out('')
      out('  3) 手动删掉它（会在资源管理器里删不掉时，用管理员 PowerShell）：')
      out(`       Remove-Item -Recurse -Force "${strayDir}"`)
      out('')
      out('  删不掉通常是因为有程序占着它——DSH 没退干净，或终端正开在里面。')
      out('')
      process.exit(5)
    }
  }
}

if (existsSync(ignoredDir)) {
  warn('清理 node_modules/.ignored 残留')
  if (!dryRun) {
    try { rmSync(ignoredDir, { recursive: true, force: true }); ok('已清理') }
    catch { warn('清理失败（可忽略）') }
  }
} else {
  ok('没有 .ignored 残留')
}

// ─────────────────────────────────────────────────────────────
// ③ 写 dependencies（用绝对路径 link:）
// ─────────────────────────────────────────────────────────────

out('')
out('[3/4] 注册依赖到 profiles/desktop/package.json')

const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'))
pkg.dependencies ??= {}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []

// ⚠️ 路径形式很关键：
//   相对路径（link:../../plugin-src/...）依赖 package.json 所在深度，
//   一旦目录结构稍有不同就会指错，且报错信息完全不指向真正原因。
//   这里用【绝对路径】，正向斜杠，pnpm 在所有平台都能解析。
const linkSpec = 'link:' + TARGET.replace(/\\/g, '/')

const before = pkg.dependencies['dsh-fk-rollback']
pkg.dependencies['dsh-fk-rollback'] = linkSpec

if (!pkg.dsh.profile.bundles.includes('dsh-fk-rollback')) {
  pkg.dsh.profile.bundles.push('dsh-fk-rollback')
}

if (before === linkSpec) {
  ok(`dependencies 已是正确形式`)
} else if (before === undefined) {
  ok(`新增依赖：${linkSpec}`)
} else {
  warn(`修正依赖写法：${before}`)
  ok(`          -> ${linkSpec}`)
}
ok(`bundles 已包含 dsh-fk-rollback`)

if (!dryRun) {
  writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  ok('package.json 已写回')
} else {
  warn('（预演）未写入 package.json')
}

// ─────────────────────────────────────────────────────────────
// ④ 结果 + 下一步
// ─────────────────────────────────────────────────────────────

out('')
out('[4/4] 结果')
out('')
out('  packages.json 里的最终形态：')
out(`    dependencies["dsh-fk-rollback"] = ${JSON.stringify(linkSpec)}`)
out(`    dsh.profile.bundles 含 dsh-fk-rollback = true`)
out('')
out('─'.repeat(62))
out('  下一步（必须按顺序）：')
out('')
out('  1. 完全退出 DSH（关窗口 + 确认托盘图标消失）')
out('')
if (configOnly) {
  out('  2. 直接重启 DSH —— 它启动时会自动 pnpm install')
  out('     （因为 DSH 运行时无法装依赖，所以刚才只改了配置）')
} else {
  out('  2. 刷新依赖，二选一：')
  out('     A. 重新打开 DSH，它会自动 pnpm install')
  out('     B. 手动跑：')
out(`        cd "${PROFILE_DIR}"`)
  out('        node install.mjs --pnpm')
}
out('')
out('  3. 启动 DSH，进 设置 → 侧边栏「FK回滚设置」')
out('')
out('─'.repeat(62))
out('')

if (argv.includes('--pnpm')) {
  out('  正在执行 pnpm install …')
  const { spawnSync } = await import('node:child_process')
  const pnpmCands = [
    join(HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'dist', 'pnpm.mjs'),
  ]
  const pnpm = pnpmCands.find((p) => existsSync(p))
  if (!pnpm) {
    bad('找不到 pnpm.mjs，请手动在 DSH 界面里刷新依赖')
    process.exit(7)
  }
  const r = spawnSync(process.execPath, [pnpm, 'install', '--reporter=append-only'], {
    cwd: PROFILE_DIR, stdio: 'inherit', windowsHide: true,
  })
  out('')
  if (r.status === 0) ok('pnpm install 成功')
  else bad(`pnpm install 退出码 ${r.status}`)
  process.exit(r.status ?? 1)
}
