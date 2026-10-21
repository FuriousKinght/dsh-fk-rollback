# dsh-fk-rollback — FK 回滚设置

DSH 配置的快照与回滚。**自动留痕、出问题能查、坏了能退回。**

保证 DSH 本体能启动、能输入输出、功能正常。
**不管**会话聊天内容和用户自己装的插件（那些不在快照范围内）。

---

## 它解决什么

DSH 的三次真实事故（2026-10-13 循环依赖、2026-10-17 两次崩溃）都是**配置文件被改坏**：

| 事故 | 形态 | 本插件能救吗 |
|---|---|---|
| 10-13 | `cordis.patch.yml` 抄错，形成循环依赖 | ✅ 能 |
| 10-17 | 插件缺 `exports["./client"]` | ✅ 能 |
| 10-17 | patch 被截断成 828 B | ✅ 能（已实测） |

**实测数据**（2026-10-19）：

```
破坏后：bundles 12 → 3，patch 60712 B → 828 B
        DSH 启动失败：YAMLException，输出 2,247 B

回滚后：5/5 文件 SHA256 全部恢复
        DSH 启动正常，输出 83,254 B，零错误
```

---

## 快照了什么

**只有 5 个配置文件**（共约 119 KB）：

```
pnpm-workspace.yaml
compatibility.json
pnpm-lock.yaml
package.json
cordis.patch.yml        ← 热重载的，回滚时最后写
```

**明确不碰**：`node_modules/`、插件源码、会话记录、`cordis.yml`（每次启动被重写）、`$DSH_HOME/cordis.patch.yml`（home 层，只检测不修）。

---

## 三类快照

| 类型 | 何时建 | 保留 | 计入 50 配额 |
|---|---|---|---|
| **每日** `daily/` | 每天第一次启动 | 3 份 | ❌ 独立 |
| **滚动** `rolling/` | 每轮对话结束 + 距上次 ≥2h + **内容变了** | 3 份 | ❌ 独立 |
| **手动/回滚前/装插件前后** `checkpoints/` | 用户点按钮 / 回滚前 / **装插件前后自动** | 50 份 | ✅ |

**保留 3 份每日的理由**：每天的 daily 是在「启动成功」后才建的。
如果今天启动就崩了，今天的快照根本没建成 —— 只能靠昨天、前天的兜底。

---

## 🎯 装插件会自动留痕（关键能力）

**这是最实用的功能：不管用户装什么插件，装前装后各存一份。**

### 怎么做到的

DSH 的 `dsh-plugin-manager` 有两个事件，时序如下（源码已核实）：

```
用户点「安装插件」
  ↓
this.change(async (result) => {
    const files = await this.readRestoredFiles()   ← DSH 自己也在备份
    announce("installing", {...})                  ← ★ 磁盘还干净！我在这里存「装前」
    run = await this.runPnpm(["add", spec])        ← 真正改磁盘
    announce("applying")
})
emit("plugin-manager/changed")                     ← 全部完成，我在这里存「装后」+ 体检
```

| 事件 | 时机 | 我做什么 |
|---|---|---|
| **`plugin-manager/install-state`**（phase=`installing`） | `pnpm add` **之前** | 存 **「装插件前 HH:mm」** |
| **`plugin-manager/changed`** | 安装完成后 | 存 **「安装插件后 HH:mm」** + 立刻体检 |

### 效果

```
📅 每日快照 2026-10-19
📌 装插件前 2026-10-19 19:55      ← 装之前，磁盘干净的状态
📌 安装插件后 2026-10-19 19:55    ← 装之后，可能已经坏了
```

**装完发现 DSH 起不来 → 一键回滚到「装插件前」→ 精确恢复。**

### 两个细节

- **同一个安装请求只存一次**：多 registry 重试时会重复触发 `installing`，用 `requestId` 去重
- **连装多个插件各存一份**：第二份会自动编号（`装插件前 …19:55②`）

---

## 两种用法

### ① 面板（DSH 正常时）

设置 → 「FK回滚设置」

- 快照列表（星级 = 健康等级）
- 创建快照 / 一键回滚
- 体检问题（三层分级：真问题 / 提示 / 正常状态）
- 改动溯源（谁在什么时候改过哪个配置文件）
- 设置（保留策略 / 体检历史 / **报错日志 + 诊断报告**）

### ② 脚本（DSH 崩了时）

双击 `还原DSH配置.bat` —— **不依赖 DSH，只依赖 node.exe**。

脚本内置 **5 级 node 探测链**（本机 PATH 里没有 node）：

```
1. $DSH_HOME/dsh-runtimes/*/dependencies/node/bin/node.exe
2. 盘符根目录扫描（找 resources/runtime/primary-runtime/...）
3. 注册表反查安装路径
4. PATH 里的 node
5. 询问用户输入
```

找不到就退出，**绝不修改任何文件**。

---

## ⚠️ 怎么让改动生效（DSH 桌面端没有 F5）

**DSH 是 Electron 桌面应用，`F5` / `Ctrl+R` 不会重新加载页面。**
（那是浏览器行为；Electron 在这里没注册 reload 快捷键。）

| 你想做的事 | 正确做法 |
|---|---|
| 让**回滚后的配置**生效 | 点面板里的「立即重启 DSH」按钮，或关掉窗口重开 |
| 让**插件面板的代码改动**生效 | 同样是**重启 DSH** |
| 只是想**刷新面板数据** | 点面板里的「刷新」按钮（不需要重启） |

**本插件的面板里，所有需要「重启才生效」的操作都会明确告诉你，并提供「立即重启」按钮。**

> **v1.3.0 起：重启能力已内置**，不需要额外安装任何重启插件。
> 实现见 `lib/restart.mjs`（WMI 创建助手 → `taskkill /T` 杀进程树 → 自动重开）。
>
> 自动重启只在 **Windows 桌面版 DSH** 下可用（需要 Electron 的 IPC 通道）。
> 命令行启动的 `dsh web`、或其他平台，按钮会明确提示「请手动重启」并说明原因。

---

## 命令行

```bash
node dsh-rollback.mjs <命令> [选项]
```

⚠️ 如果你的 `PATH` 里没有 node，可以用 DSH 自带的运行时（路径随安装位置不同）：

```
<DSH安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
```

不确定的话，直接双击同目录下的 `还原DSH配置.bat` —— 它会自动探测 node 和 DSH 目录。

| 命令 | 作用 |
|---|---|
| `list` | 列出快照（按类型分组） |
| `show <id>` | 快照详情 |
| `status` | 当前状态摘要 |
| `check` | 静态体检（`--json` / `--home-layer`） |
| `diagnose` | 诊断（含 home 层排查顺序） |
| `snapshot` | 手动创建（`--name` / `--note` / `--daily`） |
| `restore <id>` | 还原到指定快照 |
| `restore --last-good` | 自动选最佳 |
| `restore --dry-run` | 只显示会改什么 |
| `trace [文件]` | 改动溯源（`--days N`） |
| `sessions` | 列出最近会话 |
| `prune` | 清理过期快照 |
| `oplog` | 查看操作日志 |

**退出码**：0 成功 · 4 无可用快照 · 5 权限/占用 · 7 需人工 · 8 部分成功

---

## 健康分级

快照的可靠性分 5 级。**按「配置指纹」记录启动历史**（不是按快照对象，这样内容相同的快照共享验证）：

| 等级 | 判据 |
|---|---|
| `verified-strong` | 同指纹启动成功 ≥3 次且 0 失败 |
| `verified` | 同指纹启动成功 ≥1 次 |
| `static-ok` | 静态体检通过，但从未被启动验证 |
| `failed` | 曾启动失败 |
| `broken` | 静态体检有 fatal |

`--last-good` 按这个顺序降级选点：`verified-strong → verified → static-ok → failed`。

---

## 一个必须知道的死角

`$DSH_HOME\cordis.patch.yml`（home 层，实测 132 B，由第三方插件 `dsh-skin` 自动生成）
**叠加在 profile 层之后，优先级更高**。它坏了 DSH 起不来，而：

- ❌ 本插件救不了（已排除在快照外）
- ❌ DSH 弹窗也救不了（只备份 profile patch）

**本插件能检测**（`home-layer-unparsable` fatal），但**不修**。

所以：**profile 层体检全绿但 DSH 起不来时，第一件事查这个文件。**

```bash
node dsh-rollback.mjs check --home-layer
```

---

## 安全设计

| 红线 | 原因 |
|---|---|
| 绝不自动回滚 | 会掩盖真问题 |
| 不改 DSH 本体 | 更新即失效 |
| 不碰 `node_modules` | pnpm 的领地 |
| 会话日志绝对只读 | 那是用户的核心数据 |
| 回滚前必须先快照 | 防点错 |
| 两阶段写入 + 固定顺序 | patch 最后写，避免中间态触发热重载 |
| `apply()` 全包 try/catch | 本插件出问题不能拖垮 DSH |
| `session/event` 带 `{ global: true }` | 否则收不到别的会话的事件 |
| 异常绝不冒泡 | 不能因为体检打断用户对话 |

**验收标准**：故意破坏 `lib/client.js`、`entry.js`，或直接删掉本插件 → DSH 仍能正常启动。

---

## 目录结构

```
dsh-data/plugin-src/dsh-fk-rollback/
├── package.json          插件清单（exports 含 ./client）
├── cordis.patch.yml      bundle patch（name 必须等于包名）
├── entry.js              Host 半边（钩子 + HTTP 端点）
├── lib/
│   ├── core.mjs          快照/还原/指纹/保留
│   ├── check.mjs         体检（自实现 YAML 子集）
│   ├── trace.mjs         会话溯源（只读）
│   └── client.js         Client 半边（设置面板）
├── dsh-rollback.mjs      命令行脚本（零第三方依赖）
├── 还原DSH配置.bat       一键还原（5 级 node 探测）
└── README.md
```

**快照存放**：`$DSH_HOME/rollback-snapshots/<profile>/`
（**在 profile 外面** —— profile 内会跟着一起坏）

---

## 技术要点

- **零第三方依赖**：只用 `node:fs/path/crypto/zlib`
- **YAML 自实现子集**：不引入 js-yaml（`cordis.patch.yml` 里有 `!!js` 自定义标签，完整解析器反而要额外注册 tag）
- **多帧 zstd 必须逐帧解**：直接解压 13 MB 文件只能拿到第一帧 244 B；逐帧解压得 13,510 条事件
- **导入路径解析**：`@deepseek-ai/*` 这类 install-scope 包在 `profiles/node_modules`（共享层），不在 profile 层；那层里可能有指向 DSH 安装目录的悬空符号链接 —— DSH 自身能从 asar 解析，所以不是错误
- **幽灵检测按 `dsh` 字段过滤**：hoisted 树下 `node_modules` 有 150 个顶层包，而带 `dsh` 字段的只有 14 个

---

## 更新记录

### v1.4.0（2026-10-21）

**体检新增：client.js 的模块 loader id 一致性检查**

对应 2026-10-21 的真实事故（OFM 插件改名不彻底）：

- `package.json` 的 `name` 改成了 `dsh-fk-our-free-model`
- 但 `client.js:22` 的 `__ModuleLoader__.load({ id: 'dsh-our-free-model' })` 漏改
- DSH 判定为「两个模块注册同一个 factory」
- 抛 `client-modules: duplicate factory registration`
- `dsh-client-modules` 启动失败 → **全量启动中止，DSH 完全起不来**

这类错误的特征是「静态看不出、启动才知道崩」，所以体检必须提前拦。

新增两个检查码：

| 码 | 级别 | 说明 |
|---|---|---|
| `client-loader-id-mismatch` | **fatal** | `client.js` 的 `id` 与包名不一致 —— DSH 会启动失败 |
| `client-exports-name-mismatch` | warn | `client.js` 的 `exports.name` 与包名风格不一致 |

**修复：`cordis.patch.yml` 为 `[]` 时误报 YAML 语法错误**

全新 profile 的 patch 可能就是一个空数组 `[]`（或只有注释）。
之前会被判成 `bad-yaml`，让用户以为配置坏了。已修复。

**UI：快照列表所有分组都能折叠**

原来只有「更早」和「回滚记录」能折叠，今天/昨天是固定展开的。
现在四组都可以点标题折叠/展开，箭头 `▾` / `▸` 指示状态，
折叠时右侧显示「已折叠」。

---

**修复：分组显示「N 项」但列表为空**

用户反馈：「昨天显示有两项，但是不显示」

根因是 v1.4.0 加折叠时暴露的旧设计缺陷 —— **跨组翻页和分组互相冲突**：

```js
const primary = [...buckets.today, ...buckets.yesterday]   // 15 项
const pageItems = primary.slice(0, 10)                      // 第1页只取 10 项
```

今天有 13 项，第 1 页的 10 条全是今天的 → 「昨天」筛出 0 条，
但分组头的数字用的是**全量** `g.items.length` = 2。
于是头显示「昨天 2 项」，下面一条都没有。

翻到第 2 页时反过来：「今天」只剩 3 项，看起来像今天只有 3 个快照。

**修复方式：去掉跨组翻页，每组独立「显示更多」**

分组本身就是天然的分页（今天 / 昨天 / 更早），不需要再跨组翻。

- 每组默认显示 10 条，超出时给「显示更多（还有 N 项）」
- 点一次加 10 条，只影响本组
- 切换搜索词 / 筛选条件时，所有组的显示条数重置

---

### v1.3.0（2026-10-20）

**重启能力已内置 —— 不再需要额外安装任何插件**

发布前的最后一个外部依赖被消除了。

之前的做法是让用户再装一个 `dsh-fk-restart-button`，否则「立即重启」按钮用不了。
这对发布场景不可接受：**装一个插件就该完整可用**。

现在把重启逻辑搬进了 `lib/restart.mjs` + `lib/relaunch-helper.cjs`：

- 零第三方依赖（只用 `node:child_process` / `fs` / `os` / `path` / `url` / `crypto`）
- 不需要额外的 ctx 服务（和本插件一样只要 `webServer`）
- Windows 桌面版可真正自动重启；其他环境明确提示手动重启

**实现要点（都是实测踩出来的）**

- 用 **WMI `Win32_Process.Create`** 创建助手进程 —— 普通 spawn 会被
  `taskkill /T` 一起杀掉，WMI 创建的进程父级是 `WmiPrvSE.exe`，不在被杀的那棵树里
- 必须传 `ProcessStartupInformation { ShowWindow: 0 }`，否则会弹出可见终端窗口
- 系统程序一律走**绝对路径**（有的机器 PATH 里没有 System32）
- 端口从请求头动态发现，**不能写死 19387**（某些构建绑动态端口）

**端点变化**

- `GET /restart-helper` → 改为探测**内置**能力，返回 `builtin: true` 与不可用原因
- `POST /restart` → 直接执行内置重启，不再转发到外部插件

**顺带清理**

- 去掉了转发逻辑里的超时/重试复杂度（内置实现本身是毫秒级返回）
- 按钮 tooltip 现在显示真实的不可用原因

**回滚前快照改为独立存放，并说明是哪次回滚**

用户要求：「回滚后会生成一个回滚前的快照，我建议把这一栏单独存放，
并且说明是某某时间段的回滚」

- 新增 `restore-points/` 目录 —— 回滚前快照从 `checkpoints/` 独立出来
- 独立配额：保留最近 **10 份**，不占用手动快照的 50 个名额
- 快照名明确写出时间：`回滚前 2026-10-20 15:29`
- `meta` / 索引新增 `restoreInfo` 字段：
  ```json
  { "at": 1792491043994, "targetId": "...", "targetName": "装插件前", "reason": "用户指定" }
  ```
- 面板新增「回滚记录（每次回滚前的现场）」分组，默认折叠，排在列表最前
- 每行副标题显示 `· 回滚到「装插件前」前`
- CLI 列表同步显示 `↳ 回滚到「xxx」之前的现场`

旧数据（v1.3.0 之前产生的回滚前快照）仍在 `checkpoints/` 且没有 `restoreInfo`，
但 `type` 仍是 `before-restore`，所以照样归入「回滚记录」分组 —— 不迁移也能正常显示。

---

### v1.2.0（2026-10-20）

**修复：「立即重启 DSH」按钮永远是灰的，点不了**

用户反馈：回滚完成后的结果页有「稍后重启 / 现在重启」，但「现在重启」是灰色的。

根因（两处）：

1. **探测写错了** —— `/restart-helper` 只在 `cordis.patch.yml` 文本里 grep 插件名，
   但 `dsh-fk-restart-button` 是通过 profile 的 **`bundles`** 注册的，patch 里
   根本没有它的名字 → 探测永远返回 `false` → 按钮永远渲染成禁用态。
   改为以 `bundles` / `dependencies` 为准，patch 只作兜底。

2. **没有转发端点** —— 原来的前端直接调重启插件的地址，插件没装时静默失败。
   新增 `POST /restart`：由 Host 端转发到重启插件（新旧两条路由都试），
   统一给出可读错误。前端改调自己的端点。

**顺带修掉一个会卡死界面的问题**

转发请求原本没有超时。对端不响应时 `fetch` 会一直挂着，
按钮永远显示「重启中…」，用户只能强杀 DSH。
现在整个重启流程共享 **8 秒总预算**（不是每步各算），超时立刻中断并给出提示。

实测：最坏耗时从 20.6 秒降到 8.0 秒。

**UI 改进**

- 按钮不再因探测失败而变灰 —— 永远可点，由 Host 端返回真实结果
- 点击后显示「重启中…」，失败时明确告知「可手动关闭 DSH 再打开」
- `/restart-helper` 返回 `evidence` 字段，说明探测依据（bundle / dependency / patch）

---

### v1.1.0（2026-10-20）

**新增：固化副本（`.bat` 的独立数据源）**

`.bat` 是「DSH 完全起不来」时的最后手段，不能依赖会被自动清理的快照池。

- 新增 `fixed/bat-default/` 固化区 —— **不参与快照池的任何自动清理**
- **每次 DSH 启动自动**把当天 daily 快照固化过去（`fixedBy: auto-daily`）
- `.bat` 只读固化副本；找不到就明确报错，**绝不偷偷回退到快照池**
- 面板可在任意快照上点「设为 .bat」，手动指定固化对象（`fixedBy: user`，不会被自动覆盖）
- 新增命令：`fix <ID>` / `fix --show` / `fix --clear` / `paths`
- 面板底部显示：`快照目录` 与 `脚本目录`

**新增：快照来源标记**

- 区分 `自动`（钩子）/ `AI`（会话） / `手动`（用户）
- 判据：`DSH_SESSION_ID` 环境变量存在 → AI；否则 → 用户；钩子显式传 `auto`
- 面板标签 + 筛选器 + CLI 列均支持

**修复**

- **`apply()` 被 Fiber 重复调用**导致路由重复注册（每次启动写 15 条 `duplicate route` 错误）→ 用 `WeakSet` 幂等保护
- 事件被重复订阅 3 次 → 同上
- `pickLastGood` 选点偏差：原按「健康等级+最新」，会选中 `before-restore` 而非当天 daily → 改为 **当天 daily 优先**，health 为 broken 的排除
- 时区：`toISOString()` 在东八区 0–8 点会误判「今天」→ 改用本地 `localDateKey()`
- 自动固化被 health 过滤挡住（体检 fatal 时 daily 也不固化）→ 固化不按 health 过滤
- 卡片展开后文字被按钮挤压成一字一行 → 卡片改纵向，按钮独立成行

---

*版本 1.4.0 · 2026-10-21*
