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

## .bat 固化副本的更新策略（2026-10-23 修订）

> 用户指出的原设计缺陷：
> 「用户肯定希望的是，将23号启动快照固化为.bat，而不是继续保留22号旧的固化脚本」

### 旧行为（错的）

```text
22号：用户手动「设为 .bat」固化 B 快照
      → meta.fixedBy = 'user'

23号：开机，自动建当天 daily
      启动钩子调 autoFixDaily()
      → 看到 fixedBy === 'user'
      → 直接跳过，永不覆盖

结果：.bat 一直还原 22 号那份陈旧配置
      用户早就忘了自己固化过，也不知道为什么 .bat 是旧的
```

**问题本质：把「用户手动操作过一次」当成了「永久意图」，但这个意图会随时间失效。**

### 新行为（对的）

```text
默认：每次启动都跟着当天 daily 走
      .bat 永远还原「今天启动时的那份配置」  ← 这才是用户真实期望

可选：显式钉住（pin=true）
      用户明确说「我就要这一份，别动」时才保留
```

### 字段约定

| 字段 | 值 | 含义 |
|---|---|---|
| `fixedBy` | `'user'` / `'auto-daily'` | 谁写的这份副本（仅记录） |
| `pin` | `true` / `false` | **是否钉住**（决定启动时会不会被替换） |
| `replacedFrom` | 对象 / `null` | 上次被替换掉的副本，供追溯 |

⚠️ **关键：判断是否跳过，只看 `pin`，不再看 `fixedBy`。**

### 命令

```bash
# 固化某份快照（默认不钉住 → 下次启动会换成当天 daily）
fix <id>

# 固化并钉住（启动时不替换）
fix <id> --pin

# 给当前副本补上钉住
fix --pin

# 取消钉住（恢复跟随当天 daily）
fix --unpin

# 查看当前状态（含钉住与否）
fix --show
```

### `fix --show` 输出示例

```text
[bat-default]  ← .bat 默认使用
  来源快照: 每日快照 2026-10-23（20261023-063427-066）
  钉住:     🔄 否 —— 下次启动会被当天 daily 替换
  上次替换: 每日快照 2026-10-22
  快照时间: 2026/10/23 06:34:27
  固化于:   2026/10/23 06:37:14
```

### 面板表现

`.bat` 状态卡片会显示钉住状态：

```text
📌 .bat 使用「B快照」          ← 钉住
   已钉住 · 启动时不会自动替换

🔒 .bat 使用「每日快照 2026-10-23」   ← 未钉住
   下次启动会自动换成当天每日快照
```

卡片上有 **「钉住」/「取消钉住」** 按钮，一键切换。

### 为什么要保留「钉住」

有些场景确实需要固定一份：

- 刚验证过某个配置绝对稳定，不想被日常变更覆盖
- 正在排查问题，需要固定基线做对照
- 临时回退到旧配置，怕启动时又被换回去

**但这是少数情况，所以默认应该是「跟随」，而不是「冻结」。**

---

## 版本策略：模块 1-6 一体发布


> **用户裁定（2026-10-22）：「FK回滚插件模块1-6都是一体的！所以更新都要统一！」**

六个模块不是可以单独升级的组件，而是**一个整体**。
任何一个模块改动，版本号全体同步，不允许出现「模块四 1.5、模块六 1.4」这种错位。

### 模块与文件对照

| 模块 | 职责 | 主要文件 |
|---|---|---|
| **模块一** | UI 面板 | `lib/client.js` |
| **模块二** | 体检 | `lib/check.mjs`、`lib/estate.mjs` |
| **模块三** | 会话溯源 | `lib/trace.mjs` |
| **模块四** | 快照 | `lib/core.mjs` |
| **模块五** | 回滚 | `lib/core.mjs`、`dsh-rollback.mjs` |
| **模块六** | 恢复脚本（后手） | `还原DSH配置.bat`、`dsh-rollback.mjs` |

支撑文件：`entry.js`（宿主接线）、`lib/restart.mjs` + `lib/relaunch-helper.cjs`（重启）、`lib/elog.mjs`（错误日志）

### 版本标记的落地位置

每个文件头部都有 `@version`，`.bat` 用 `REM Version:`，都必须等于 `package.json` 的 `version`：

```text
entry.js                    @version 1.5.3
lib/client.js               @version 1.5.3
lib/check.mjs               @version 1.5.3
lib/estate.mjs              @version 1.5.3
lib/trace.mjs               @version 1.5.3
lib/core.mjs                @version 1.5.3
lib/restart.mjs             @version 1.5.3
lib/elog.mjs                @version 1.5.3
dsh-rollback.mjs            @version 1.5.3
lib/relaunch-helper.cjs     @version 1.5.3
install.mjs                 @version 1.5.3
还原DSH配置.bat              REM Version: 1.5.2
清除旧Cookies.bat            REM Version: 1.5.2
package.json                "version": "1.5.2"
```

### 发版检查清单

改任何模块后，逐项确认：

```text
[ ] package.json 的 version 已改
[ ] 上述 12 个文件的 @version / Version 行全部同步
[ ] dsh-rollback.mjs --version 输出一致
[ ] README 页脚「*版本 x.y.z · 日期*」一致
[ ] README 更新记录有对应章节
```

### 为什么 .bat 也要版本化

`.bat` 是最后手段，用户手里可能同时存在多个副本（U 盘、桌面、备份）。
**没有版本号就无法判断「这份 .bat 能不能配当前插件用」。**
所以它头部必须有 `REM Version: x.y.z`。

⚠️ 但 `.bat` 必须保持 **100% ASCII** —— cmd.exe 用 OEM 代码页解析，
UTF-8 中文和框线字符会被拆成乱码再当命令执行。版本行只能用英文。

---

## 更新记录

### v1.5.3（2026-11-14）

**新增：代理环境变量检测 + 一键修复（体检第三行）**

对应 2026-11-14 的事故 —— 这是**第一个不在配置文件里**的故障成因。

#### 病因：环境变量指向了没启动的代理

```text
用户级环境变量：
  HTTP_PROXY  = http://127.0.0.1:7897
  HTTPS_PROXY = http://127.0.0.1:7897

而 127.0.0.1:7897 没有任何进程监听（代理软件没开）
```

DSH 0.2.2 起新增的全局代理策略模块会在启动时读这两个变量，把进程内的 undici 全局 dispatcher 换成指向该代理的 `ProxyAgent`。代理不可达 → 每一条出站 HTTPS 请求全部失败 → **所有 provider 一起挂**。

#### 为什么原来的报错极具误导性

从 asar 挖出的源码：

```js
} catch (error) {
  if (error instanceof LlmError) throw error;
  throw new LlmError('DeepSeek Messages transport failed', 'TRANSPORT', { cause: error });
}
```

任何 provider 的底层网络异常都被统一包装成这一条。字面上写着 "DeepSeek"，所以第一反应必然是「官方 API 挂了」——

**实际排查时换模型、换 provider、查 `.credentials.yaml`、重装 DSH、回滚快照，全都白试。**

#### 为什么回滚快照救不了

```text
变量存在注册表 HKCU\Environment
   ↓
不在 profile 里，不在 DSH_HOME 里
   ↓
快照只备份 5 个配置文件 → 碰不到它
   ↓
重启也没用 —— 注册表值不会因重启 DSH 而改变
```

**而且本质上是「当下状态」问题，不是「历史快照」问题：**

```text
配置文件坏了  → 还原成三天前的样子 → 好了 ✅
环境变量坏了  → 还原成三天前的样子 → 还是坏的 ❌
（因为三天前那个代理可能是开着的）
```

#### 三条新增能力

**① `proxy-env-dead` 检查（fatal，接在 runCheck 里）**

```text
判据（保守，避免误报）：
  · 只认 127.0.0.1 / localhost / ::1 —— 远程代理探不通可能只是防火墙
  · 端口连不上才报
  · 变量没设置 → 什么都不做
  · 大小写 6 种变体全认（HTTP_PROXY / http_proxy / ...）
```

**探活方式用同步 `netstat`，不是异步 socket：**

```text
runCheck() 是同步函数，有 12 处调用点
（entry.js 7 处 + dsh-rollback.mjs 5 处）
   ↓
为一个端口探测把全部改成 async → 改动面太大
   ↓
netstat -ano -p TCP 一次约 30ms，够用
```

**② `core` 命令改名为 `proxy` 命令（CLI）**

```bash
dsh-rollback proxy                    # 诊断
dsh-rollback proxy --fix --dry-run    # 预演
dsh-rollback proxy --fix              # 真删（先备份）
dsh-rollback proxy --restore          # 从备份反悔
```

**③ 面板第三行【修复代理】—— 整行就是按钮**

```text
【体检】 ✅ 一切正常（另有 8 项正常状态，无需处理）  [测试弹窗] [体检] 16:10:33
【认证 Cookie】 约 1 个 / 约上限 70 个 ⓘ
┌──────────────────────────────────────────────────────────────┐
│ 【修复代理】 代理导致所有模型报 transport failed 时点这里…  › │
└──────────────────────────────────────────────────────────────┘
```

#### 为什么代理检查放【体检】里、修复单独一行

用户 2026-11-14 的原话：

> 「第三行【修复代理】是按钮，就是真的修复代理，
>   然后这个代理检查，放在体检区」

**所以：**

| 关注点 | 归属 | 理由 |
|---|---|---|
| 代理**是否正常** | 【体检】 | 它是「配置是否健康」的一部分 |
| 代理**怎么修** | 第三行按钮 | 它是一个动作，不是状态 |

**刻意不把代理并进【体检】那一行显示，而是分成三行：**

```text
【体检】      = profile 的 5 个配置文件
【认证 Cookie】= Chromium 状态库
【修复代理】  = Windows 注册表
```

```text
如果混成一行：
  配置全对、代理是死的
     ↓
  显示「✅ 一切正常」
     ↓
  但模型照样全挂
     ↓
  ❌ 这句话就不可信了
```

#### 【体检】按钮加了时间戳

用户 2026-11-14 反馈：

> 「这个体检边上也要加个时间，不然以为按了没反应」

**因为体检结果往往是「✅ 一切正常」这种静态文字，点完看不出任何变化。**

```text
未体检过  → [体检] 未体检
检查中    → [检查中…] 进行中…
跑完      → [体检] 16:10:33    ← 时间变了 = 真跑了
悬停      → 上次体检完成于 2026/11/14 16:10:33
```

**关键点：即使结果是「一切正常」也要更新时间戳**，否则用户还是会以为按钮坏了。

#### 安全设计

| 项 | 做法 |
|---|---|
| **只删指定键** | 不做「全删」这种危险默认 |
| **先备份** | 原值写进 `proxy-env-backup.json`；写备份失败就不删 |
| **可预演** | `--dry-run` 只显示不动手 |
| **可反悔** | `--restore` 从备份恢复 |
| **删后复查** | 再读一遍注册表确认真的没了 |
| **只杀死的** | 代理在运行（端口有监听）→ 一个都不删 |

**⚠️ 为什么读注册表而不是 `process.env`：**

```text
process.env 是 DSH 启动时继承的快照
   ↓
用户改完变量后，DSH 进程里还是旧值
   ↓
判断「注册表里有什么」必须直接读 HKCU\Environment
```

#### 实测

**单元测试（21 项）：**

```text
isPortListeningSync      7897 无监听 ✅ / 58504 有监听 ✅
parseProxyValue          7 种输入全对（含 socks5、无 scheme、空串、坏 URL）
空环境                   不报警 ✅
事故原样（7897 死）       报 1 条 fatal ✅
代理活着                 不报警 ✅
远程代理                 不探不报 ✅
大小写 6 种变体           全部报出 ✅
```

**CLI 端到端（8 步）：**

```text
① 无变量        exit=0  「当前用户没有任何代理环境变量」
② 事故环境      exit=4  准确报出「代理没有运行 ← 这就是故障原因」
③ --fix --dry-run       列出将删 4 个；磁盘未变 ✅
④ --fix 真就干  exit=0  删 4 个 + 写备份
⑤ 注册表验证            HTTP_PROXY / HTTPS_PROXY 都变空 ✅
⑥ 备份内容              {"HTTP_PROXY":"http://127.0.0.1:7897", ...}
⑦ 修复后再诊断  exit=0  「干净状态」✅
⑧ --restore     exit=0  4 个全部恢复 ✅
```

**面板 UI（9 项）：**

```text
整行是 <button>            ✅
内部只有一个 button         ✅
点整行触发 doFixProxyAll    ✅
修复中 disabled            ✅
【测试弹窗】+【体检】两个按钮  ✅
未体检 / 进行中 / 时间戳     ✅ 三种状态
补零格式 09:05:03          ✅
```

#### 过程中修正的两个自身错误

**① 误报 cosmokit / schemastery**

第一版把 `cosmokit` / `schemastery` 的副本报成 warn。用户质疑后查 asar 源码：

```text
dsh-scope          Symbol.for = 0   → 按对象身份判 → 多一份必冲突
dsh-system-prompt  Symbol.for = 0   → 同上
dsh-llm            Symbol.for = 0   → 同上
cordis             Symbol.for = 21  → 跨实例安全
cosmokit           Symbol.for = 1   → 跨实例安全
schemastery        Symbol.for = 2, globalThis = 9 → 跨实例安全
```

**教训：报「重复安装」不等于报「有害」。只有验证过危害的才该报警。**

**② 两步操作**

第一版设计是「点【一键修复】→ 弹 toast → 再点 toast 里的【一键修复】」。用户问：

> 「代理出问题了，这个修复代理按钮呢？我按哪？」

**说明这个两步很蠢。改成：按钮本身就是动作，点一下直接删，弹窗只负责报结果。**

---

### v1.5.2（2026-10-26）

**新增：认证 Cookie 累积检测 + 一键清理**

对应 2026-10-26 的真实事故，这是认证类故障的**第二个独立成因**。

#### 病因：Cookie 名按端口生成，旧的不清理

DSH 每次启动都会：

```text
① Host 监听一个【动态端口】（如 63360）
② 用 sha256("127.0.0.1:63360") 生成 cookie 名 → "dsh-auth-XXXX"
③ Chromium 把 cookie 存进 Network/Cookies（host_key = 127.0.0.1）
④ 下次启动端口变成 64245 → 名字不同 → 又存一个
⑤ 旧 cookie 【永不清理】
```

源码依据（`dsh-client-connection`）：

```js
const COOKIE_PREFIX = "dsh-auth-"

function requestAudience(headers, secure) {
    const host = header(headers, "host");
    const url = new URL(`${secure ? "https:" : "http:"}//${host}`);
    return secure ? url.origin : url.host;   // ← 含端口
}

function cookieName(authority) {
    return COOKIE_PREFIX + encodeBase64Url(sha256(authority));
}
```

#### 为什么偏偏是 71 个崩溃

```text
每个 cookie 在请求头里占：name(52) + '=' + value(173) + '; ' = 228 字节

Node.js maxHeaderSize = 16,384 字节
其他请求头预留        ≈    400 字节
留给 Cookie           = 15,984 字节
                      ÷ 228 = 70.1 个
```

**实测（Node 24.21.0，真实 HTTP 服务端）：**

```text
70 个 | 总头 16,356 B (15.97 KB) -> 200 OK
71 个 | 总头 16,584 B (16.20 KB) -> HPE_HEADER_OVERFLOW + ECONNRESET
```

崩溃链条：

```text
请求头超限 → Node 抛 HPE_HEADER_OVERFLOW → 断连
    ↓
Electron net.fetch 收到 ECONNRESET（不是 4xx）
    ↓
connectDesktopWelcome: if (!authenticated.ok) throw
    ↓
"desktop welcome: Web authentication failed"
```

#### 实测累积速度

读取事故备份 `dsh-cookie-backup-20261026-185933`：

```text
总 cookie:    71
dsh-auth-*:   71
唯一端口:     71 / 71   （一个不重复）
签发跨度:     2026-10-22 08:43:55 → 10-26 18:45:16（4.42 天）
平均频率:     每天 16.1 次启动
最近 24 小时: 31 次
```

**所以：每天重启 16 次 → 4.4 天必然崩。这是必然而非偶然。**

#### 性能优化：不拖慢面板首屏（2026-10-27）

**问题：** 加了 Cookie 检测后，每次打开面板都要等一小会（显示「正在读取…」）。

**实测根因：**

```text
checkAuthCookies() 单次耗时 1715 ms
  其中：
    locateUserData()        0 ms
    isAppRunning()        271 ms   （tasklist 是外部进程）
    import node:sqlite      0 ms
    尝试打开 SQLite       1444 ms   ← 明知被 Chromium 锁住，必然失败，还是等了 1.4 秒
```

**三个优化：**

**① 快路径：知道的答案就不要去试**

```js
// DSH 在运行时 Chromium 必然独占 Cookies 库，尝试打开必然失败。
// 而那次失败的尝试要 1400ms —— 凭空让面板首屏卡 1.4 秒。
if (running && opts.force !== true && opts.appData === undefined) {
  return {
    ok: true, readable: false, running: true,
    reason: 'DSH 正在运行，Cookies 库被 Chromium 独占锁定 —— 请完全退出 DSH 后重跑',
  }
}
```

**② `isAppRunning` 加 3 秒缓存**

```js
// tasklist 每次约 270ms，而面板首屏、估算、清理前置检查
// 会在几秒内反复问同一个问题 —— 答案显然不会变。
let _appRunCache = null
let _appRunCacheAt = 0
const APP_RUN_CACHE_MS = 3000
```

**③ 端点分离：`/info` 不再阻塞**

```text
之前：GET /info  → await checkAuthCookies()  → 首屏等 1.7 秒
现在：GET /info  → 立即返回（authCookies: null）
      GET /auth-cookies → 异步补 Cookie 那一行
```

前端：

```js
async function refresh() {
  const d = await api('/info')          // 首屏数据，立即渲染
  setState({ loading: false, data: d, error: null })
  // Cookie 状态故意不 await —— 附加信息不该拖慢首屏
  api('/auth-cookies')
    .then((r) => setCookieInfo(r && !r.error ? r : null))
    .catch(() => setCookieInfo(null))
}
```

**优化效果（实测）：**

```text
                      优化前        优化后
checkAuthCookies       1715 ms   →   261 ms（首次）
                                    1 ms（缓存命中）
首屏阻塞                 1715 ms   →     0 ms（异步）
```

**同时修正的逻辑瑕疵：**

指定 `appData` 时不走快路径 —— 调用方明确要求读某个目录
（测试、多 userData、排障），不该被「本机 DSH 在跑」挡回去。

**慢路径完好性验证：**

```text
指定 appData 的真读路径:  2 ms,  readable=true
  auth=71  bytes=16188  level=fatal  ratio=101.3%  ports=71
```

---

#### 新增检测

**面板**（设置 → 侧边栏「FK回滚设置」→ 快照管理顶部）会显示一行：

```text
【认证 Cookie】 ⓘ 2 个 dsh-auth-*（估算）· 请求头占上限 3%
               DSH 运行中读不到 Cookie 内容，这是推算值
               （自 2026/10/27 19:06 清理后启动 2 次，每次 +1）
```

**三种展示形态：**

| 情况 | 显示 |
|---|---|
| 能读到（DSH 未运行） | `✅ 2 个 dsh-auth-* · 请求头占上限 3%` —— 精确值 |
| 读不到但有基线 | `ⓘ 2 个 dsh-auth-*（估算）` —— 基线 + 启动次数推算 |
| 读不到且无基线 | `ⓘ 数量未知` + 指引用 `.bat` 检查一次 |

**为什么运行时读不到还要估算：**

```text
DSH 运行时 Cookies 被 Chromium 独占，读不到内容（实测 4 种方式全失败）
   ↓
但面板在跑 = DSH 正在运行 = 恰好是读不到的状态
   ↓
如果只显示「读不到」，用户在面板上永远看不到任何数量概念
   ↓
所以用「基线 + 启动次数」估算
```

**估算精度（实测）：**

```text
某时间段内 boot-log 记录 74 条
对应实际 cookie 71 个
偏差 +3（约 4%）
   ↓
「每次启动 ≈ +1 个」成立，可用于估算
```

**基线是什么：**

```json
// <DSH_HOME>/rollback-snapshots/<profile>/cookie-baseline.json
{
  "at": "2026-10-26T19:06:00",
  "cookieCount": 0,        // 清理后的实际数量
  "bootLogCount": 164      // 当时的 boot-log 总条数
}
```

估算公式：

```text
当前估算 = 基线数量 + (当前 boot 数 - 基线的 boot 数)
```

基线只在 `--clean-cookies` 清理成功后写入。
第一次使用时会显示「数量未知」，跑一次清理后就有基线了。

---

`estate` 命令也会检查（输出更详细）：

```bash
dsh-rollback estate
```

输出（能读到 Cookie 时）：

```text
── 认证 Cookie 累积 ──
  🔴 71 个 dsh-auth-*（请求头 16188 B / 上限 15984 B，占 101.3%）
     已达上限 —— 这就是 DSH 起不来的原因
     涉及 71 个不同端口（每次启动换一个端口 → 多一个 cookie）
     最早 2026/10/22 08:43:55  →  最晚 2026/10/26 18:45:16

     修复：完全退出 DSH，然后运行
       dsh-rollback estate --clean-cookies
     或直接双击插件目录里的「清除旧Cookies.bat」
```

分级阈值（按预算占比）：

| 级别 | 占比 | 约合数量 | 含义 |
|---|---|---|---|
| `normal` | < 85% | < 59 个 | 正常 |
| `warn` | ≥ 85% | ≥ 59 个 | 开始累积，建议清理 |
| `error` | ≥ 95% | ≥ 66 个 | 再重启几次就崩 |
| `fatal` | ≥ 100% | ≥ 70 个 | 已经会崩 |

⚠️ **检查窗口限制（重要）**

```text
DSH 运行时  → Cookies 被 Chromium 独占锁定 → 读不到
DSH 未运行  → 可读（node:sqlite 只读打开）
```

**但这不是问题：唯一有意义的检测时刻（DSH 起不来）正好是可读状态。**

DSH 运行时跑 `estate`，会明确提示：

```text
── 认证 Cookie 累积 ──
  ⓘ DSH 正在运行，Cookies 库被 Chromium 独占锁定 —— 请完全退出 DSH 后重跑
```

实测四种运行时读取方式全部失败：

| 方式 | 结果 |
|---|---|
| `copyFileSync` | ❌ `EBUSY` |
| `sqlite3 mode=ro&immutable=1` | ❌ `unable to open database file` |
| Win32 共享读 | ❌ `Win32Error=32` |
| **看文件大小** | ❌ **不可靠**（见下） |

**文件大小不是可靠信号：**

```text
事故前（71 个 cookie）:  53,248 B
清理后（0 个 cookie）:   53,248 B   ← 完全一样
```

原因：SQLite 的 `DELETE` 不自动 `VACUUM`，删除后保留空闲页。

#### 新增清理

```bash
# 预演（只报数字）
dsh-rollback estate --clean-cookies --dry-run

# 真清理（必须先完全退出 DSH）
dsh-rollback estate --clean-cookies
```

清理做的事：

```text
① 检查 DSH 是否已退出（未退出直接拒绝）
② 备份 Cookies 到 <DSH_HOME>/rollback-snapshots/<profile>/cookie-backups/<时间戳>/
③ DELETE FROM cookies
     WHERE host_key IN ('127.0.0.1','localhost')
       AND name LIKE 'dsh-auth-%'
   ⚠️ 只删认证 cookie：
      · host 限定本机（不碰其他站点）
      · name 限定 dsh-auth-（不碰同域其他 cookie）
④ 清理 0 字节的 Cookies-journal
⑤ 复核剩余数量
```

#### 两个插件的重启都会记录实测数据

**`dsh-fk-restart-button`（侧边栏按钮）和本插件的「重启 DSH」都走同一条数据流。**

```text
你点哪个重启按钮
   ├─ 侧边栏底部按钮 → dsh-fk-restart-button/lib/relaunch-helper.cjs
   └─ 面板「重启 DSH」→ dsh-fk-rollback/lib/relaunch-helper.cjs
              │
              │ 两个 helper 写【同一个文件】
              ▼
   <DSH_HOME>/restart-helper/cookie-cleanup.json
       实测快照：observed / headerBytes / ports / oldest / newest / triggeredBy
              │
              │ 只有本插件的 entry.js 消费它
              ▼
   <DSH_HOME>/rollback-snapshots/<profile>/cookie-observed.json
              │
              ▼
   设置 → FK回滚设置 → hover【认证 Cookie】→ 看到实测详情
```

**为什么两个插件共用 `restart-helper/` 目录：**

```text
两个插件早已约定这个公共位置（helperDir 都是 <DSH_HOME>/restart-helper）。
放在一起 = 不管谁触发重启，数据都落到同一个地方，
不会出现「点 A 存 A 目录、点 B 存 B 目录」的分裂。
```

**`triggeredBy` 字段用来区分来源：**

```json
{
  "observed": 4,
  "headerBytes": 912,
  "ports": [53975, 64245, 56306, 63890],
  "oldest": 1792629835700,
  "newest": 1793055716000,
  "triggeredBy": "dsh-fk-rollback (面板「重启 DSH」)",
  ...
}
```

取值有两种：

```text
"dsh-fk-rollback (面板「重启 DSH」)"       ← 面板按钮
"dsh-fk-restart-button (侧边栏按钮)"       ← 侧边栏按钮
```

面板 hover 里显示为「触发来源：…」。

**要求：**

| 组合 | 数据产生 | 数据可见 |
|---|---|---|
| 两个都装 | ✅ 点哪个都行 | ✅ 面板 hover 看 |
| 只装 `dsh-fk-rollback` | ✅ | ✅ |
| 只装 `dsh-fk-restart-button` | ✅（写 marker） | ❌ 没有消费者 |

**所以推荐两个一起装** —— 侧边栏按钮用于日常，本插件负责状态管理与数据展示。

---

#### ⭐ 重启时自动清理（推荐用法）

**这是最省事的方式：不用手动退出，不用双击 `.bat`。**

```text
面板点「重启 DSH」
   ↓
重启助手（WMI 独立进程，活在 DSH 之外）
   ↓
① 优雅关闭 DSH
② 等进程退出 + 等端口释放
   ↓
   ┌─────────────────────────────────────┐
   │ ⭐ 空窗期：Chromium 对 Cookies 的锁  │
   │    已经释放 → 安全清理 dsh-auth-*    │
   │    （失败绝不阻断重启）              │
   └─────────────────────────────────────┘
   ↓
③ 启动新 DSH
   ↓
用户感知：DSH 重启了一次，Cookie 已清干净
```

**为什么这个时机是唯一的：**

```text
DSH 活着  → Chromium 独占 Cookies 库 → 改不了
DSH 已死  → 锁释放 → 可以改
   ↓
重启恰好包含「已死未启」的窗口
   ↓
所以「重启」和「清理」天然可以合并
```

**实现位置：**

```js
// lib/relaunch-helper.cjs
// 端口确认释放之后、launch() 之前
if (config.cookies !== undefined && config.cookies !== null) {
  const r = cleanAuthCookies(config.cookies)   // 备份 → 删除 → 留标记
  log(r.removed > 0
    ? `cookie cleanup removed ${r.removed} dsh-auth-*`
    : 'cookie cleanup: nothing to remove')
}
```

**清理动作（和 CLI 完全一致）：**

```text
① 备份 Cookies → <DSH_HOME>/restart-helper/cookie-backups/<时间戳>/
② DELETE ... WHERE host_key IN ('127.0.0.1','localhost')
                AND name LIKE 'dsh-auth-%'
③ 清 0 字节 Cookies-journal
④ 写 cookie-cleanup.json 标记
   → 下次 Host 启动时据此建立「Cookie 基线」，供面板估算
```

**安全性：**

| 风险 | 处理 |
|---|---|
| 清理逻辑出错 | 失败只写日志，**不阻断重启** |
| 删错数据 | 先 `copyFileSync` 备份，备份失败就中止 |
| 删其他站点 cookie | `host_key` 限定本机 + `name` 限定 `dsh-auth-` |
| 找不到路径 | `buildCookiesCleanup()` 返回 null，跳过清理 |
| dryRun 模式 | 助手在 dryRun 分支就退出，不会清理 |

**实测（提取 helper 的真实函数跑）：**

```text
清理前 dsh-auth-*:  71
调用 cleanAuthCookies
  → {"removed":71,"leftover":0,"backupPath":"...\\backup\\Cookies"}
清理后 dsh-auth-*:  0
备份存在: true（内含 71 个可回读）
标记文件: {"at":"...","removed":71,"source":"relaunch-helper"}
journal 已删: true
幂等第二次: removed: 0
边界 dbPath 不存在: {"skipped":"cookies db not found"}
边界 cfg=null: {"skipped":"no config"}
```

---

#### 新增「清除旧Cookies.bat」

模块六现在有两个脚本：

| 脚本 | 用途 |
|---|---|
| `还原DSH配置.bat` | 还原配置 + 运行时状态 |
| **`清除旧Cookies.bat`** | **清理累积的认证 Cookie** |

**为什么单独一个 `.bat`，而不是塞进现有的？**

```text
两个动作的语义完全不同：
  · 还原配置  → 会改动 5 个文件 + 状态库
  · 清 Cookie → 只删 cookie，不动配置
混在一起，用户没法「只清 cookie 不还原配置」
```

`.bat` 的特性：

- 纯 ASCII（cmd.exe 用 OEM 代码页解析）
- 5 级 node.exe 探测（和还原脚本一致）
- 自动找 DSH_HOME（不硬编码盘符）
- **运行前检测 DSH 是否在跑**，在跑就明确提示先退出
- 清理前自动备份
- 输出里明确说明「账号不受影响」

#### 安全性说明

这三件事必须说清楚：

**① Cookie 里没有账号信息**

解码真实 payload：

```json
{"version":1,"authority":"127.0.0.1:53975","issuedAt":1792629835700,"expiresAt":1795221835700}
```

**只有地址和时间戳。没有 user id、没有 token、没有邮箱。**

**② 账号在 `.credentials.yaml`，不受影响**

```yaml
records:
  deepseek-account-platform/default:
    payload: { token, issuer }      ← 真正的登录态
  client-connection/browser-session:
    payload: { secret }             ← cookie 签名密钥
```

**③ 旧 cookie 技术上永远不会再被使用**

```text
旧 cookie 的 authority = 127.0.0.1:53975
下次启动端口        = 例如 61023
cookie 名 = sha256("127.0.0.1:61023") ≠ 旧名字
   ↓
即使保留也匹配不上，只会继续撑大请求头
```

而且启动握手不依赖旧 cookie：

```js
start: async () => {
    const ready = await host.start();
    hostCookie = await authenticateWebHost(ready.url);  // 用 URL 里的 token 换新 cookie
```

`authenticateWebHost` 用的是 Node 原生 `fetch`（不读 cookie jar），
只依赖 URL 查询串里的 `token`。

**实测闭环（2026-10-26 事故现场）：**

```text
before: 71 个
clean:  0 个
启动:   一次成功，9 个进程，无新增崩溃日志
账号:   未要求重新登录
```

---

#### ⭐ 体检出问题 → 右下角弹窗提示（2026-10-29 新增）

**用户需求：**

> 「Our Free Model 插件有一个功能很值得学习，就是有新版本推送后，它会在 DSH 界面右下角发送消息提示有新版本可更新，这个弹窗功能很好，我们的 FK 回滚插件也要学习，当体检出问题时，需要提示用户体检出问题」

##### 从 OFM 学到的关键点

**OFM 的 toast 为什么能「在 DSH 任意页面」都看到？**

```text
它的面板 UI 是挂在【设置页】的 —— 那个组件只在用户打开设置时才存在
   ↓
但「有新版本」这件事需要在任何页面都能提示
   ↓
所以它没用 React，而是【原生 DOM + document.body】
   ↓
document.body 永远存在，跟 slots 的挂载树无关
```

**FK 照抄了这个思路。**

##### 实现要点

**① 原生 DOM，不用 React**

```js
function toastHost() {
  let host = document.querySelector('.fkr-toasts')
  if (host === null) {
    host = document.createElement('div')
    host.className = 'fkr-toasts'
    document.body.appendChild(host)     // ← 挂 body，不是挂设置页
  }
  return host
}
```

**② 右下角定位（和 OFM 同款坐标）**

```css
.fkr-toasts{position:fixed;right:18px;bottom:18px;z-index:1200;...}
.fkr-toast::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;...}
.fkr-toast.warn::before{background:...warning...}
.fkr-toast.urgent::before{background:...error...}
```

**左侧 3px 色条区分等级，右上角 ✕ 手动关闭，最多同时 4 条。**

**③ 三个接入点**

| 时机 | 行为 |
|---|---|
| **DSH 启动后 1.5 秒** | 主动查 `/info` → 有问题就弹（**不用打开设置页**） |
| 打开设置页刷新 | 同步检查，同一会话已提示过就不再弹 |
| 手动点「刷新」 | 同上 |

**为什么启动时延迟 1.5 秒：**

```text
apply() 发生在树挂载期间
   ↓
此刻 Host 的 http 端点可能还没注册完
   ↓
太早请求会 404 / 连接失败
   ↓
等 1.5 秒（OFM 用的也是 1.2 秒这个量级）
```

**④ 去重：同一组问题只弹一次**

```js
const NOTIFY_DEDUP_KEY = 'fkr.lastHealthNotify'

function healthFingerprint(report) {
  // 把所有问题的 code + package/entryId 排序拼起来
  const parts = probs.map(x => x.code + '|' + (x.package || x.entryId || '')).sort()
  return 'f' + fatalCount + '::' + parts.join(',')
}
```

**用 `sessionStorage` 存指纹 —— 刷新页面不重复弹，但**问题变了会重新弹**。**

**⑤ 只有 fatal / error 才打扰**

```text
fatal  → 🔴 urgent 色条，留 20 秒
error  → ⚠️ warn 色条，留 12 秒
warn   → 不主动弹（留给用户自己看面板）
```

**⑥ 弹窗内容：取最重要的 3 条**

```text
🔴 package「surfcore」被 2 个不同的 loader 条目指向：…
🔴 bad 声明了 dsh.client，但 exports 里没有 "./client"…
…还有 2 项
```

**⑦ 「查看」按钮**

- 在设置页里 → 切到体检页
- 在其它页面（启动时弹的）→ 再弹一条小提示告诉他去哪看

**⑧ 安全兜底**

```js
function showToast(o) {
  try { ... } catch { /* 弹窗不能拖垮调用方 */ }
  return undefined
}
```

**整个 toast 系统任何异常都不会冒泡 —— 弹窗失败不能影响 DSH 本身。**

##### 「测试弹窗」按钮

**体检那一行右侧有一个【测试弹窗】按钮：**

```text
【体检】 ✅ 一切正常   [测试弹窗]
```

**连续点击会循环演示三种形态，方便一眼确认样式对不对：**

| 第几次点 | 形态 | 色条 | 停留 | 按钮 |
|---|---|---|---|---|
| 第 1 次 | 测试：普通提示 | 蓝色 | 10 秒 | 无 |
| 第 2 次 | 测试：警告（2 个问题） | 橙色 | 12 秒 | 知道了 |
| 第 3 次 | 测试：致命问题（1 个） | 红色 | 20 秒 | 知道了 / 再来一条 |
| 第 4 次 | 回到第 1 态，如此循环 | | | |

**为什么需要这个按钮：**

```text
右下角弹窗只在「真的有问题」时出现
   ↓
用户装了新版本，想确认这个功能能不能用
   ↓
但当前配置是健康的 → 没法主动触发
   ↓
有了测试按钮，随时能看效果
```

**「再来一条」的行为：**

```text
点它会【先关掉当前这条】再弹一条新的
   ↓
所以窗口里始终只有一条（不是越点越多）
```

**实测（9 项断言）：**

```text
连续点击 4 次的三态循环            4 项 ✅（class + title 都对）
info 态无按钮                     1 项 ✅
warn 态有「知道了」                 1 项 ✅
urgent 态两个按钮                  2 项 ✅
连点 10 次仍只有 4 条（上限生效）    1 项 ✅
```

---

##### 实测（22 项断言全通过）

```text
① showToast 渲染          6 项 ✅（元素/class/标题/正文/关闭键/挂载）
② 上限 4 条               1 项 ✅（弹 8 条后只剩 4 条）
③ 无 tone / 无 body       2 项 ✅
④ 指纹去重                2 项 ✅（同内容一致 / 不同内容不同）
⑤ 摘要生成                1 项 ✅
⑥ 弹窗 + 去重             5 项 ✅（首次弹 / 1 条 / urgent 色 / 二次不弹 / 条数不变）
⑦ 不打扰                  2 项 ✅（只有 warn 不弹 / 全正常不弹）
⑧ error 级                2 项 ✅（会弹 / 用 warn 色）
⑨ 异常输入                1 项 ✅（6 种坏输入不崩）
                          ─────
                          22 通过 / 0 失败
```

---

#### ⭐ 检测到问题 → 一键回滚（2026-10-29 新增）

**上面那个检查报 fatal 之后，用户该做什么？**

**2026-10-29 用户的原话：**

> 「改为安装后吧，至少能保证，安装后做一次体检，能检测到问题可以直接回滚」

**所以面板的体检行现在长这样：**

```text
【体检】 ❌ 2 个致命问题   [ 查看 ] [ 回滚 ]
```

**点「回滚」直接打开回滚确认框，目标已经选好了。**

##### 回滚到哪里

**复用 `pickLastGood()`（`restore --last-good` 用的同一套逻辑）：**

```text
① 今天的 daily 快照        ← 当天首次启动的状态 = 装插件之前
② 最近一天的 daily 快照
③ verified-strong / verified / static-ok（健康降级链兜底）
   全部排除 broken
```

**实测（本机）：**

```text
id:      20261029-072921-574
name:    每日快照 2026-10-29
type:    daily
health:  ok
created: 2026/10/29 07:29:21
level:   today-daily
reason:  今天的启动快照（2026-10-29）
```

##### 完整流程

```text
今天启动 DSH
   ↓
自动建 daily 快照 ← 这一刻就是「装插件之前」的状态
   ↓
装第三方插件
   ↓
插件管理事件钩子自动触发（不用重启）：
  存快照（auto-plugin-change）+ 跑一次体检
   ↓
🔴 FATAL duplicate-client-source
   ↓
面板【体检】❌ 2 个致命问题  [查看] [回滚]
                                    ↑ 点这个
   ↓
回滚确认框（目标已选好：每日快照 2026-10-29）
   ↓
确认 → 配置恢复到装之前 → 重启 → 正常
```

**不用自己翻快照列表，不用记哪个是装之前的。**

##### 为什么不做「装之前扫描」

**2026-10-29 曾实现过 `scan-plugin` 命令（扫描待安装插件包），后来又删掉了。**

**原因：不准确。**

| 问题 | 说明 |
|---|---|
| 装前是「模拟解析」 | name 归属哪个 package 全靠推测 |
| 无法覆盖多插件交叉 | 插件 A 和插件 B 的 patch 合并后可能冲突 |
| pnpm install 会改变解析 | 装之前得到的结论可能和装之后不同 |

**而装后体检读的是【真实已装状态】，且检查项已经齐全：**

```text
client-export-missing        声明 dsh.client 但无 exports["./client"]
client-file-missing          exports 指向的文件不存在
client-loader-id-mismatch    client.js 的模块 id 与包名不一致
duplicate-client-source      同包多源（2026-10-28 事故主因）
engines-exact-mismatch       engines.dsh 精确锁定到别的版本
```

**所以：装前扫描既重复又不准 → 删除，只保留装后体检 + 一键回滚。**

**准确率优先。**

---

#### 新增检查：代理环境变量指向失效代理（2026-11-14 事故）

**这是第一个「不在配置文件里」的故障，也是第一个让 FK 的「体检范围」扩到系统环境的检查。**

##### 事故经过

```text
所有模型全部无法调用
  官方 DeepSeek：不可用
  第三方 provider：ModelScope / AMD / SiliconFlow / Qwen / NVIDIA / 中转站 全都不行
  界面统一提示：DeepSeek Messages transport failed

用户已经换了模型、换了 provider —— 全都无效。
```

**根因：**

```text
用户级环境变量：
  HTTP_PROXY  = http://127.0.0.1:7897
  HTTPS_PROXY = http://127.0.0.1:7897
       ↓
127.0.0.1:7897 没有任何进程监听（代理软件没启动）
       ↓
DSH 0.2.2 新增的全局代理策略模块在启动时读这两个变量，
把进程内的 undici 全局 dispatcher 换成指向该代理的 ProxyAgent
       ↓
代理不可达 → 每一条出站 HTTPS 请求全部失败
       ↓
所有 provider 统一报 "DeepSeek Messages transport failed"
```

##### 为什么这个报错极具误导性

报告里从 asar 挖出了源码：

```js
} catch (error) {
  if (error instanceof LlmError) throw error;
  throw new LlmError('DeepSeek Messages transport failed', 'TRANSPORT', { cause: error });
}
```

**结论：**

```text
任何 provider 的底层网络异常都被统一包装成这一条
   ↓
看到它并不代表「官方 DeepSeek 的问题」
   ↓
但用户的第一反应一定是「API 挂了」或「密钥失效」
   ↓
于是换模型、换 provider、查 .credentials.yaml —— 全是白试
```

##### FK 为什么原来查不出

**29 个检查项全部围绕「profile 配置文件 + Electron 运行时状态」，完全没有环境变量这一维度。**

##### 为什么回滚 / 重启都救不了

```text
变量存在注册表 HKCU\Environment
   ↓
不在快照范围内（快照只有 5 个配置文件）
   ↓
也不会随 DSH 重启而改变
   ↓
所以 restore 无效、重启无效
```

##### 新增检查项 `proxy-env-dead`（fatal）

**实现要点：**

```js
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy',      // 大小写都认
]
```

**探活方式：同步 `netstat`（不是异步 socket）**

```text
为什么必须同步：
  runCheck() 是同步函数，有 12 处调用点
  （entry.js 7 处 + dsh-rollback.mjs 5 处）
  为一个端口探测把它全改成 async —— 改动面太大，风险太高

netstat -ano -p TCP 一次约 30ms，完全够用
```

**保守判据（避免误报）：**

```text
① 只探 127.0.0.1 / localhost / ::1
   —— 远程代理探不通可能只是防火墙，不该报
② 端口能连上 → 不报
③ 变量没设置 → 什么都不做
```

##### 报错与指引

```text
❌ HTTP_PROXY / http_proxy / HTTPS_PROXY / https_proxy = 127.0.0.1:7897
   —— 这个代理端口【没有进程在监听】。
   DSH 0.2.2 起会在启动时读取代理环境变量，把全局 HTTP dispatcher
   换成指向该代理的 ProxyAgent，于是每一条出站请求全部失败：
   所有模型（官方 + 全部第三方）统一报
   "DeepSeek Messages transport failed"，
   换模型、换 provider、查密钥全都无效。

   💡 要么启动代理软件，要么删掉变量后【完全重启 DSH】：
      [Environment]::SetEnvironmentVariable("HTTP_PROXY",$null,"User");
      [Environment]::SetEnvironmentVariable("HTTPS_PROXY",$null,"User")
      ⚠️ 重启 / 回滚快照都治不了这个 —— 变量存在注册表里，不在快照范围内。
```

**体检总览那一行也改了（避免误导）：**

```text
改前：⚠️ 有致命问题 —— DSH 很可能起不来，建议尽快回滚到健康快照
改后：⚠️ 有致命问题 —— 其中有的【回滚救不了】，请看下方专项指引
```

**并且专门给一段专项指引：**

```text
👉 代理环境变量指向失效代理 —— 这个问题【回滚/重启都救不了】

   原因：变量存在【注册表】（HKCU\Environment），
         既不在快照范围内，也不会随 DSH 重启而改变。

   它为什么让所有模型都挂：
     DSH 0.2.2 起会在启动时读取 HTTP_PROXY / HTTPS_PROXY，
     把全局 HTTP dispatcher 换成指向该代理的 ProxyAgent。
     代理没开 → 每一条出站请求全部失败 →
     所有 provider 统一报 "DeepSeek Messages transport failed"。
     这个报错完全不指向真因，换模型、换 provider、查密钥都是白试。

   两个选择（任选一个，然后【完全重启 DSH】）：
     A. 启动代理软件（如果确实需要代理）
     B. 删掉这两个用户级变量：
          [Environment]::SetEnvironmentVariable("HTTP_PROXY",$null,"User")
          [Environment]::SetEnvironmentVariable("HTTPS_PROXY",$null,"User")
```

##### 实测（21 项单元断言 + 整链路）

```text
单元测试（21/21）：
  ① isPortListeningSync    7897 无监听 ✅ / 58504 有监听 ✅
  ② parseProxyValue        7 种输入全部正确（含 socks5://、无 scheme、空串、坏 URL）
  ③ 空环境                 不报警 ✅
  ④ 事故原样（7897 死）     报 1 条，code=proxy-env-dead，fatal ✅
  ⑤ 代理活着               不报警 ✅
  ⑥ 远程代理               不探不报 ✅
  ⑦ 大小写 6 种变体         全部报出 ✅

整链路：
  干净环境            exit=0，✅ 一切正常
  事故环境            exit=4，✅ 检出 proxy-env-dead
  verdict 文案        ✅ 不再说「建议回滚」
  专项指引            ✅ 有
  修复命令            ✅ 给出
  不归入「可还原快照」  ✅
```

##### ⭐ 自动修复：`proxy` 命令（2026-11-14 新增）

**用户 2026-11-14 的追问：**

> 「所以现在针对这个事故是否可以修复了？」

**「发现」和「修」是两件事。上面那节只做了发现，这里补上真动手。**

**三个动作：**

```bash
# 诊断（默认）
node dsh-rollback.mjs proxy

# 修复：删掉指向失效代理的变量（先备份）
node dsh-rollback.mjs proxy --fix --dry-run    # 预演
node dsh-rollback.mjs proxy --fix              # 真删

# 反悔：从备份恢复
node dsh-rollback.mjs proxy --restore
```

**诊断输出：**

```text
  代理环境变量诊断
  --------------------------------------------------------------
  用户级（注册表 HKCU\Environment）代理变量：

    HTTP_PROXY / http_proxy / HTTPS_PROXY / https_proxy
      值：http://127.0.0.1:7897
      状态：❌ 代理没有运行 ← 这就是故障原因

  ⚠️ 有代理变量指向没有运行的端口。
     这会让 DSH 0.2.2 的所有模型统一报 "DeepSeek Messages transport failed"。

     两个选择：
       A. 启动代理软件（如果确实需要代理）
       B. 删掉这些变量：dsh-rollback proxy --fix

     ⓘ 加 --dry-run 可以先看会删什么，不动手。
```

**修复输出：**

```text
  已删除：
    ✓ HTTP_PROXY（原值：http://127.0.0.1:7897）
    ✓ HTTPS_PROXY（原值：http://127.0.0.1:7897）

  备份（原值已存，可反悔）：
    <DSH_HOME>\proxy-env-backup.json

  ⚠️ 必须【完全退出 DSH 再启动】才会生效 ——
     环境变量在进程启动时读取，已运行的进程不会重新读。

  反悔：dsh-rollback proxy --restore
```

**安全设计：**

| 项 | 做法 |
|---|---|
| **只删指定键** | 不做「全删」这种危险默认；只删诊断出来是死的那几个 |
| **先备份** | 原值写进 `proxy-env-backup.json`；写备份失败就不删 |
| **可预演** | `--dry-run` 只显示不动手 |
| **可反悔** | `--restore` 从备份恢复 |
| **删后复查** | 再读一遍注册表，确认真的没了 |
| **只杀死的** | 代理在运行（端口有监听）→ 一个都不删 |

**⚠️ 为什么读注册表而不是 process.env：**

```text
process.env 是 DSH 启动时继承的快照
   ↓
用户改完变量后，DSH 进程里还是旧值
   ↓
判断「注册表里有什么」必须直接读 HKCU\Environment
   ↓
实现：powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('X','User')"
```

**实测（8 步端到端，全过）：**

```text
① 无变量        exit=0  ✅「当前用户没有任何代理环境变量」
② 事故环境      exit=4  ✅ 准确报出「代理没有运行 ← 这就是故障原因」
③ --fix --dry-run       ✅ 列出将删 4 个（大小写各 2 个）；磁盘未变
④ --fix 真就干  exit=0  ✅ 删 4 个 + 写备份
⑤ 注册表验证             ✅ HTTP_PROXY / HTTPS_PROXY 都变空
⑥ 备份内容              ✅ {"HTTP_PROXY":"http://127.0.0.1:7897", ...}
⑦ 修复后再诊断  exit=0  ✅「干净状态」
⑧ --restore     exit=0  ✅ 4 个全部恢复，值正确
```

**⚠️ 测试完后已确认你的真实环境未被污染（注册表零 PROXY 变量）。**

**这一条补充了 FK 的能力边界：**

```text
restore                配置文件被改坏        → 快照内
core                   核心包副本            → node_modules 层
estate --clean-cookies Cookie 累积            → Chromium 状态层
estate --reset         运行时状态库损坏      → Chromium 状态层
proxy --fix            代理环境变量           → 注册表层 ← 新增
```

**现在 FK 能自己修的故障，从 4 类扩到 5 类。**

---

##### 这条检查的边界

**它只查「本机代理端口是否在监听」，不查：**

```text
· 远程代理是否可用（防火墙会挡住探测，探不通不代表失效）
· 代理是否需要认证
· NO_PROXY 的排除规则是否正确
· 系统代理开关（ProxyEnable）与这些变量的关系
```

**理由：只报「能确定是故障」的情形，宁可少报也不误报。**

---

#### 新增检查：内核核心包副本（2026-11-04 事故）

**这是第二个「装插件后 DSH 就废了」的问题，而且比 surfcore 那个更隐蔽 ——
FK 原来报「一切正常」，回滚也无用。**

##### 事故经过

装了 `dsh-unrestricted` 之后：

```text
新建会话失败
恢复已有会话失败
所有 Agent 预设（standard / ptc / minimal / cordis / fk）全部 broken
前端弹：resume failed ... prompt section "deployment:persona-prefix" is already registered
```

**根因不是插件业务逻辑，是它的安装过程把 6 个官方核心包装进了 profile：**

```text
@deepseek-ai/cordis              4.0.5
@deepseek-ai/cosmokit            1.8.6
@deepseek-ai/dsh-llm             0.2.1-rc.5
@deepseek-ai/dsh-scope           0.2.1-rc.5
@deepseek-ai/dsh-system-prompt   0.2.1-rc.5
@deepseek-ai/schemastery         3.18.5
```

**为什么两套实例会炸：**

```text
dsh-scope        负责 Agent / 预设的作用域标识（基于【对象身份】，用 === 判）
dsh-system-prompt 负责提示词分层（全局层 + 每个 agent 的 scoped 层）
cordis           负责服务与上下文
       ↓
两套实例 = 两个不同的对象 → === 判不出「同一个 scope」
       ↓
插件注册提示词时不被识别为「当前 agent 作用域」
       ↓
落到【全局层】，而全局层已有同名段落
       ↓
PromptLayer 的 NamedEntries 抛 "prompt section is already registered"
       ↓
激活审计失败 → 预设标记 broken → 会话无法创建/恢复
```

**报告里的隔离实验（决定性证据）：**

| 测试配置 | 结果 |
|---|---|
| 官方两个 bundle，无 node_modules | 所有预设正常 |
| 官方两个 bundle + **仅放入 @deepseek-ai 核心副本** | **所有预设损坏** |
| 官方两个 bundle + 完整第三方 node_modules | 所有预设损坏 |
| 官方两个 bundle + 完整第三方，但**移出核心副本** | 所有预设正常 |

##### FK 为什么原来查不出（三处都漏）

```js
// ① listDshPackages 只扫 node_modules 顶层
for (const name of readdirSync(nm)) {
  if (name.startsWith('.')) continue
  const pkgPath = join(nm, name, 'package.json')   // ← @deepseek-ai 是目录，没有 package.json
  if (pkg?.dsh) out.push(name)                     // ← 且要求有 dsh 字段
}

// ② 那 6 个核心包【都没有】dsh 字段
//    cordis / dsh-llm / dsh-scope / dsh-system-prompt / cosmokit / schemastery
//    → 即使扫到也会被 if (pkg?.dsh) 过滤掉

// ③ bundle-official-from-asar 把「官方包不在 node_modules」当【正常】
//    但反过来的情形 —— 官方核心包【在】node_modules —— 没有对应检查
```

**实测确认：把 4 个核心包副本放进 `node_modules/@deepseek-ai/`，
`runCheck()` 返回 `overall: ok`、`0 个问题`。**

##### 为什么回滚也救不了

```text
快照只含 5 个配置文件 + Electron 状态：
    pnpm-workspace.yaml / compatibility.json / pnpm-lock.yaml /
    package.json / cordis.patch.yml
       ↓
不含 node_modules（设计如此：它本可由 lockfile 重建）
       ↓
回滚 = 把这 5 个文件写回去
       ↓
那 6 个副本【原样留着】
       ↓
必然无效
```

**最恶心的一点：**

```text
核心包副本【不在 lockfile 里】
   ↓
pnpm install / pnpm prune 都提示 "Already up to date"
   ↓
既不重建它，也不清理它
   ↓
只能手动移走
```

##### 新增检查项 `core-package-duplicate`（fatal 级）

**实现 `scanCorePackageCopies()`：**

```js
const DSH_CORE_SCOPED_PACKAGES = {
  // 涉及「对象身份 / 作用域」的包 —— 有副本必然导致预设损坏
  'cordis': 'fatal',
  'dsh-scope': 'fatal',
  'dsh-system-prompt': 'fatal',
  'dsh-llm': 'fatal',
  // 纯工具库 —— 通常无害，但仍是重复安装的信号
  'cosmokit': 'warn',
  'schemastery': 'warn',
}
```

**分级理由（2026-11-04 从 asar 源码实测出来的，不是猜的）：**

```text
判据：这些包有没有用 Symbol.for / globalThis 做【跨实例识别】？

  dsh-scope          Symbol.for = 0   globalThis = 0    → 按对象身份 (===)
  dsh-system-prompt  Symbol.for = 0   globalThis = 0    → 按对象身份 (===)
  dsh-llm            Symbol.for = 0   globalThis = 0    → 按对象身份 (===)
       ↓
   两份实例 = 两个不同对象 → === 判不出同一个 scope → 致命

  cordis             Symbol.for = 21                    → 跨实例安全
  cosmokit           Symbol.for = 1   globalThis = 2    → 跨实例安全
  schemastery        Symbol.for = 2   globalThis = 9    → 跨实例安全
     （Symbol.for("schemastery") + globalThis.__schemastery_index__）
       ↓
   两份实例能认出彼此 → 多一份无害
```

**⚠️ 这里我犯过一个错，记下来：**

第一版实现把 `cosmokit` / `schemastery` 报成 **warn**，理由是「纯工具库，但仍是重复安装的信号」。

用户看到后问：**「？怎么有警告了？」**

去查 asar 源码才发现：这两个包用 `Symbol.for` 做全局注册表，**跨实例是安全的**。而且用户保留了它们，DSH 启动完全正常、5 个预设全 OK —— **实证明无害**。

所以改成：**这 6 个包里只报 3 个（dsh-scope / dsh-system-prompt / dsh-llm），其余不报警。**

**教训：报「重复安装」不等于报「有害」。只有验证过危害的才该报警。**

**报错原文：**

```text
❌ profile 的 node_modules/@deepseek-ai/ 里有 3 个 DSH 内核核心包的副本：
   @deepseek-ai/dsh-llm@0.2.1-rc.5、@deepseek-ai/dsh-scope@0.2.1-rc.5、
   @deepseek-ai/dsh-system-prompt@0.2.1-rc.5
   —— 它们会和内核自带的同名包形成【两套模块实例】，
   导致 dsh-scope / dsh-system-prompt 的作用域判断失效，
   表现为「所有 Agent 预设同时报 prompt section is already registered」、
   新建会话与恢复会话全部失败。
   💡 把 node_modules/@deepseek-ai 下这些目录【移动】到备份处
      （不要删除，便于排查），然后重启 DSH。
      ⚠️ 回滚快照救不了这个问题 —— 快照不包含 node_modules。
```

##### ⭐ 自动修复：`core` 命令（2026-11-04 新增）

**用户 2026-11-04 的追问：**

> 「所以，这个事故报告问题解决不了？」

**不是解决不了 —— 是 FK 当时只会「报告」不会「修」。现在补上了。**

**用法：**

```bash
# 预演：只显示会移走哪些
node dsh-rollback.mjs core --dry-run

# 真修复（必须先完全退出 DSH）
node dsh-rollback.mjs core

# 自定义备份位置
node dsh-rollback.mjs core --backup-to "D:\某个备份目录"
```

**它做什么：**

```text
① 检查 DSH 是否已退出（运行中会拒绝，因为 node_modules 可能被占用）
② 找出 node_modules/@deepseek-ai/ 下这 3 个致命包：
     dsh-scope / dsh-system-prompt / dsh-llm
③ 移动到 <DSH_HOME>/_backup-core-copy-<时间戳>/@deepseek-ai/
     ⚠️ 移动，不删除 —— 便于排查，也便于反悔
④ 若 @deepseek-ai 目录空了，一并移走（不留空壳）
⑤ 输出下一步指引
```

**⚠️ 只移这 3 个，不动 cosmokit / schemastery：**

```text
dsh-scope / dsh-system-prompt / dsh-llm   → Symbol.for = 0，按对象身份判 → 必移
cosmokit / schemastery                    → 有 Symbol.for，跨实例安全 → 保留
cordis                                    → Symbol.for = 21 → 不改
```

**实测（6 步全过）：**

```text
① 修复前 check            命中 core-package-duplicate（fatal）
② core --dry-run          列出将移走 3 个；磁盘未变 ✅
③ core 真实执行           移走 3 个，输出备份位置
④ 修复后磁盘              @deepseek-ai 只剩 cosmokit / schemastery ✅
                          备份目录含 3 个包 ✅
⑤ 修复后 check            core-package-duplicate 消失 ✅
⑥ 幂等再跑                「已经清干净，无需处理」✅
```

**输出示例：**

```text
  内核核心包副本隔离
  --------------------------------------------------------------
  DSH_HOME : <DSH_HOME>
  profile  : desktop
  目标目录 : <DSH_HOME>\profiles\<profile>\node_modules\@deepseek-ai

  已隔离：
    ✓ @deepseek-ai/dsh-scope
    ✓ @deepseek-ai/dsh-system-prompt
    ✓ @deepseek-ai/dsh-llm

  备份位置（移动，不是删除 —— 便于排查和反悔）：
    <DSH_HOME>\_backup-core-copy-<时间戳>

  ✅ 完成。现在启动 DSH，然后跑一次确认：
     dsh-rollback check

  ⓘ 为什么要移走这几个包：
    它们与内核自带的同名包形成两套模块实例，
    导致 dsh-scope 的作用域判断失效（按对象身份 ===，两份实例认不出彼此）
    → 所有 Agent 预设报 prompt section is already registered
    → 新建会话、恢复会话全部失败。

  ⓘ cosmokit / schemastery 不在此列 —— 它们用 Symbol.for 做跨实例识别，
    多一份无害，可以保留。
```

**反悔方法：**

```text
把备份目录里的 @deepseek-ai/<包名> 移回
profiles/desktop/node_modules/@deepseek-ai/
```

**实现位置：**

| 文件 | 内容 |
|---|---|
| `lib/estate.mjs` | `quarantineCoreCopies()` + `CORE_SCOPED_PACKAGES` |
| `dsh-rollback.mjs` | `cmdCore()` + 命令注册 + 帮助文本 |

---

##### 体检输出现在会区分「回滚能救 / 救不了」

**这是本次另一个修复 —— 之前用户看到 fatal 就以为回滚能解决，白试一遍。**

```text
👉 内核核心包副本 —— 这个问题【回滚救不了】

   原因：快照只备份 5 个配置文件 + Electron 状态，不含 node_modules。
        （设计如此：它本可由 lockfile 重建。但核心包副本不在 lockfile 里，
         pnpm 既不重建也不清理它 —— 所以只能手动移走。）

   正确做法（移动，不要删除，便于排查）：
     1. 完全退出 DSH（关窗口 + 确认托盘图标消失）
     2. 新建备份目录：
        mkdir "<DSH_HOME>\_backup-core-copy-<日期>"
     3. 把这些目录移进去：
        <DSH_HOME>\profiles\<profile>\node_modules\@deepseek-ai\cordis
        <DSH_HOME>\profiles\<profile>\node_modules\@deepseek-ai\dsh-llm
        <DSH_HOME>\profiles\<profile>\node_modules\@deepseek-ai\dsh-scope
        <DSH_HOME>\profiles\<profile>\node_modules\@deepseek-ai\dsh-system-prompt
     4. 启动 DSH，再跑一次 dsh-rollback check 确认

   ⓘ cosmokit / schemastery 是纯工具库，有些插件依赖它们，
     可以保留（只报警告，不致命）。

👉 其余问题 —— 可尝试还原快照：
     dsh-rollback list                # 看有哪些快照
     dsh-rollback restore <快照id>    # 配置 + 状态一起还原
```

##### 实测（9 项断言全通过）

```text
① 事故原样（4 个作用域包副本）     ✅ 命中 fatal，overall=fatal
② 只有工具库副本（cosmokit+schemastery） ✅ 命中 warn，无 fatal（不误报）
③ 干净环境                        ✅ 零报警
④ 混合（4 致命 + 2 工具）          ✅ 两个都命中
```

##### 这条检查的边界

**它只查 `@deepseek-ai/` 作用域下的内核核心包，不查：**

```text
· 任意第三方包的重复实例（那是 pnpm 的职责）
· 插件自己的多份副本（没有已知危害）
· lockfile 与实际 node_modules 的偏差（那是 pnpm install 的活）
```

**理由：只报「已知会导致 DSH 失效」的情形，避免误报。**

---

#### 新增检查：同一插件被登记两次（2026-10-28 事故）

**这是一类「装完插件、重启就起不来」的问题，而且报错信息完全不直观。**

##### 事故经过

朋友的 DSH（`0.2.1-rc.3`）装了第三方插件 **surfcore**，重启后应用直接退出：

```text
DesktopHostFatalError: dsh: startup failed: 1 required plugin did not activate

Failed plugins (1):
  modules (required)
    Package: @deepseek-ai/dsh-client-modules
    AggregateError: client-modules: 1 client package failed to compose:
      other failures:
        - client-modules: package surfcore resolves from multiple active Loader sources:
          "surfcore" from file:///D:/DSH_Data/profiles/desktop/,
          "file:///D:/DSH_Data/profiles/desktop/node_modules/surfcore/lib/qq-mode.js"
          from file:///D:/DSH_Data/profiles/desktop/; remove one entry
```

朋友的评价：

> 「直接导致打不开 DSH，幸好可以用你的回滚」

##### 病因

surfcore 自己的 `cordis.patch.yml` 里插入了两行：

```yaml
- id: surfcore
  name: surfcore          # 相对插件目录 → node_modules/surfcore/package.json
- id: qq-mode
  name: ./lib/qq-mode.js  # 相对插件目录 → node_modules/surfcore/lib/qq-mode.js
                          #              → 向上找 → node_modules/surfcore/package.json
```

**看起来是两个不同的东西，但两行的 `name` 最终都解析到同一个 `package.json`。**

而那个 manifest 声明了 `dsh.client`，于是 DSH 认为「同一个 package 出现了两个 client 源」——
它不知道该用哪一个，直接抛错，整个应用起不来。

##### DSH 的精确规则（从源码挖出）

`app.asar` → `@deepseek-ai/dsh-client-modules/lib/index.js`：

```js
resolveMeta(loaderName, baseUrl) {
    const sourceKey = this.sourceKey(loaderName, baseUrl);
    const located = this.locatePkgJson(loaderName, baseUrl);
    if (located === void 0) return null;                    // 解析不到 → 跳过
    const { packageName, path: pkgPath } = located;
    const decl = parseDshClient(packageName, pkg.dsh?.client);
    if (decl === void 0 || decl.platform !== "web") return null;  // 不算 client 源
    return { packageName, meta };
}

reconcilePackage(packageName) {
    const sources = [];
    for (const source of this.sources.values())
        if (source.packageName === packageName) sources.push(source);
    if (sources.length > 1) {                                // ← 这里抛错
        throw new Error(`client-modules: package ${packageName} resolves from
            multiple active Loader sources: ...; remove one entry`);
    }
}
```

所以判定条件是三条同时成立：

```text
① 同一个 packageName（manifest 解析出的 name）
② 出现 ≥2 个【不同】的 loader name（sourceKey = loaderName + baseUrl）
③ 该 manifest 声明了 dsh.client 且 platform === 'web'
   ↓
DSH 启动必失败
```

**注意：同一个 name 重复出现**不算冲突**（`sourceKey` 相同，后者覆盖前者）。

本机实测印证：`cordis.patch.yml` 里 `dsh-boot-animation` 出现 **2 次**，
且它有 `dsh.client`，但 DSH 正常启动 —— 因为两行 `name` 完全相同。

##### 新增检查项 `duplicate-client-source`（fatal 级）

```js
add('fatal', 'duplicate-client-source',
  `package「${packageName}」被 ${uniqueNames.length} 个不同的 loader 条目指向：${detail} —— `
  + 'DSH 启动时会在 dsh-client-modules 里抛「resolves from multiple active Loader sources」，'
  + '整个应用起不来。删掉其中一行即可。', ...)
```

**实现在 `lib/check.mjs`：**

| 函数 | 作用 |
|---|---|
| `parseLoaderRows(text)` | 从 patch 文本提取 `{ id, name, disabled, line }` |
| `locatePkgForLoaderName(name, baseDir, home)` | 把 name 解析成它归属的 `package.json` |
| `scanClientSourceConflicts(...)` | 遍历所有 patch 源，找出同包多源 |

**⚠️ 必须遍历所有 patch 源，不能只看 profile 的：**

```text
profile 的 cordis.patch.yml     → baseUrl = profiles/desktop/
每个 bundle 的 cordis.patch.yml → baseUrl = 插件目录   ← surfcore 就属于这种
```

第一版只查了 profile，测试时 `./lib/qq-mode.js` 解析返回 null 才发现这一点。
修正后遍历 profile + 每个 bundle。

##### 实测：三个场景

**① surfcore 原样（应命中）**

```text
🔴 [FATAL] duplicate-client-source
  package「surfcore」被 2 个不同的 loader 条目指向：
  「surfcore」（id: surfcore，surfcore 的 cordis.patch.yml 第 2 行）、
  「./lib/qq-mode.js」（id: qq-mode，surfcore 的 cordis.patch.yml 第 4 行）
  —— DSH 启动时会在 dsh-client-modules 里抛
  「resolves from multiple active Loader sources」，整个应用起不来。
  删掉其中一行即可。
```

**② 正常插件（只有一行）→ 0 个 issue** ✅ 不误报

**③ 两行但 package 无 `dsh.client` → 0 个 issue** ✅ 正确（DSH 也会跳过）

**④ 本机真实配置 → 0 个 issue** ✅ 不误报

##### 为什么这个检查有用

```text
装第三方插件
   ↓（不用重启！）
本插件的「插件管理事件」钩子自动触发：
  存快照（标记 auto-plugin-change）+ 体检一次
   ↓
🔴 FATAL：duplicate-client-source
   ↓
用户看到 → 删掉一行 → 再重启
   ↓
根本不会经历「起不来 + 崩溃弹窗 + 配置被清空」
```

##### 边界说明（这个检查不做什么）

| 问题 | 归不归本插件 |
|---|---|
| 同一插件被登记两次 | ✅ **归** —— 是 DSH 配置层问题，会导致起不来 |
| 插件绕过 `DSH_HOME`，在 C 盘建影子目录 | ❌ 不归 —— 插件运行行为，不威胁启动 |
| 插件源码硬编码 `~/.dsh` | ❌ 不归 —— 插件内部实现，不是配置 |
| 插件自动开会话污染工作区 | ❌ 不归 —— 插件业务行为 |
| 插件体积异常 | ❌ 不归 —— 不是判断标准 |

**本插件的职责严格限定为：「让 DSH 起不来」的配置问题 + 出事后的配置恢复。**
**插件质量审计不属于这里。**

---

#### 实测快照：面板唯一可信的数据来源

**问题：** DSH 运行时 Chromium 以独占模式持有 Cookie 文件，插件读不到内容。

实测七种方式全部失败：

| 方式 | 结果 |
|---|---|
| `fs.readFileSync` | ❌ `EBUSY` |
| `fs.openSync('r') + readSync` | ❌ `EBUSY` |
| `fs.createReadStream` | ❌ `EBUSY` |
| `new DatabaseSync(path, {readOnly:true})` | ❌ `unable to open database file` |
| `mode=ro&immutable=1` | ❌ 同上 |
| CDP `Network.getCookies` | ❌ `unsupported Network method` |
| CDP `Storage.getCookies` | ❌ `Method not found` |

**所以面板上的「约 N 个」只能是推算值。**

**真正能拿到真实值的只有一处：重启窗口。**

```text
DSH 运行中 → Chromium 独占 → 读不到
DSH 已退出 → 锁释放     → 能读
   ↓
「重启」= 关闭 + 空窗期 + 启动
   ↓
空窗期就是唯一的读取时机
```

**重启助手（WMI 独立进程，活在 DSH 之外）就在那个窗口里，所以它不只清理，还记录实测快照。**

#### 实测快照记录了什么

```json
{
  "at": "2026-10-27T09:50:00.000Z",
  "observed": 4,                 // 真实 dsh-auth-* 数量
  "total": 4,                    // 库内 cookie 总数
  "removed": 4,                  // 这次清掉几个
  "headerBytes": 912,            // 请求头占用字节
  "headerBudget": 15984,         // Node maxHeaderSize 16384 - 其他头 400
  "ratio": 0.057,
  "ports": [53975, 64245, 56306, 63890],
  "oldest": 1792629835700,       // 最早签发时间
  "newest": 1793055716000,       // 最晚签发时间
  "backupPath": "...",
  "source": "relaunch-helper",
  "triggeredBy": "dsh-fk-rollback (面板「重启 DSH」)"
}
```

#### 无条件写入（2026-10-27 修复）

**原实现有个缺陷：**

```js
// 只有清掉了东西，才写记录
if (removed > 0 && typeof cfg.markerPath === 'string') {
  fs.writeFileSync(markerPath, JSON.stringify({ ... }))
}
```

**后果：**

```text
如果这次重启时 cookie 是 0 个（干净状态）
   ↓
removed = 0
   ↓
不写记录
   ↓
面板永远显示「还没有实测记录」
   ↓
用户永远无法核对推算值
```

**已改为无条件写：**

```js
// ⚠️ 不能以 removed > 0 为条件（原实现的缺陷）：
//    那样「这次没有 cookie 需要清」就什么也不记，
//    面板永远显示「还没有实测记录」。
const snapshot = { ... }
if (typeof cfg.markerPath === 'string' && cfg.markerPath !== '') {
  fs.writeFileSync(cfg.markerPath, JSON.stringify(snapshot, null, 2), 'utf8')
}
```

**这样每次重启都会留下一条实测记录，哪怕这次是 0 个。**

#### 推算值的可信度（必须诚实说明）

**面板的「约 N 个」= 基线后启动次数，不是实测。**

**支持这个模型的数据：**

```text
证据 1（唯一可对照的样本）:
  10-22 08:43 ~ 10-26 18:45 期间
    boot-log 记录:  74 次启动
    cookie 备份:    71 个（从真实文件读出）
    偏差:          +3（4.2%）

证据 2（Cookies mtime）:
  Cookies mtime:   10-27 08:16:38
  最后一次启动:     10-27 08:16:02
  相差:            35.8 秒
  → 证明「每次启动都会写 Cookies 文件」

证据 3（端口唯一性）:
  71 个 cookie → 71 个唯一端口（零重复）
  → 证明「每次启动换端口 → 换 cookie 名」
```

**⚠️ 但必须说清楚：**

```text
· 样本量 = 1。一个样本不能叫「准确率」。
· 「各次启动 +1」不是定律：端口理论上会重复（约 0.006%/次），
  重复那次就不新增。
· 基线里的 cookieCount=0 来自用户口述（「我清空了」），
  不是插件独立测得的。
```

**所以面板现在这样标注：**

```text
「约 4 个」是推算值，不是实测：…
推算依据：基线（2026-10-26 19:06 清理后 = 0 个）
　　　　　+ 之后启动 4 次 × 每次约 +1
（样本量仅 1 次对照：74 次启动 ↔ 71 个 cookie，偏差 3）
```

**真实精度需要多次「推算 vs 实测」配对才能确认 —— 每次重启都在积累这个数据。**

#### 两个插件的重启都会记录

**`dsh-fk-restart-button`（侧边栏按钮）和本插件的「重启 DSH」走同一条数据流：**

```text
点哪个重启按钮
   ├─ 侧边栏按钮 → dsh-fk-restart-button/lib/relaunch-helper.cjs
   └─ 面板「重启 DSH」→ dsh-fk-rollback/lib/relaunch-helper.cjs
              │
              │ 两个 helper 写同一个文件（helperDir 相同）
              ▼
   <DSH_HOME>/restart-helper/cookie-cleanup.json
              │
              │ 只有本插件的 entry.js 消费
              ▼
   <DSH_HOME>/rollback-snapshots/<profile>/cookie-observed.json
              │
              ▼
   设置 → FK回滚设置 → hover【认证 Cookie】→ 实测详情
```

**`triggeredBy` 字段用来区分来源：**

| 触发方式 | `triggeredBy` |
|---|---|
| 面板「重启 DSH」 | `dsh-fk-rollback (面板「重启 DSH」)` |
| 侧边栏按钮 | `dsh-fk-restart-button (侧边栏按钮)` |

**面板 hover 里显示为「触发来源：…」。**

---

### v1.5.1（2026-10-23）

**修复：.bat 固化副本不再「一次固化，永久冻结」**

用户指出现象：

> 「22号将 .bat 固化成 B 快照，23号开机自动建了当天启动快照，
>  这时 .bat 还会用 23号的吗？」

**旧行为：不会。** 因为只要手动固化过一次（`fixedBy='user'`），
启动钩子就永久跳过，`.bat` 一直还原 22 号那份陈旧配置 —— 而用户早忘了。

**根因：把「操作过一次」当成「永久意图」，但该意图会随时间失效。**

**新行为：默认跟着当天 daily 走**，只有显式 `pin=true` 才冻结。

- 新增 `pin` 字段（默认 false）
- 新增 `replacedFrom` 记录（可追溯「换掉了哪一份」）
- `fix <id>` 默认不钉住；`fix <id> --pin` 才钉住
- 新增 `fix --pin` / `fix --unpin` / `fix --show`
- 面板 `.bat` 卡片显示钉住状态 + 「钉住/取消钉住」按钮

**实测 5 个场景全部通过（10 项断言）：**

```text
① 22号固化B（不pin）→ 23号启动 → ✅ 换成23号daily，并记录 replacedFrom
② 显式 pin B          → 23号启动 → ✅ 保持B，返回 pinned=true
③ --unpin             → 启动      → ✅ 恢复跟随，换成最新daily
④ 同一份daily二次调用             → ✅ 跳过，不重写磁盘
⑤ fix --show                      → ✅ 显示钉住状态
```

---

#### v1.5.1 补记（2026-10-26）：打包与安装工具修复

> ⚠️ **插件本体无任何改动。** 以下改动只涉及打包方式与安装工具，
> 15 个插件文件的运行逻辑与 v1.5.1 完全一致。

**修复安装阻断问题（插件本体无改动）**

> ⚠️ 说明：本次改动只涉及「打包方式」与「安装工具」，
> **插件本体的 15 个文件逻辑与 v1.5.1 完全一致，未做任何功能修改。**

#### ① 包内缺 `package.json`（致命，导致朋友装不上）

```
根因：npm 的 files 数组按惯例不列 package.json 自己，
      而自研打包脚本只遍历 files 数组 → 漏掉它。
后果：pnpm 不认为这是一个包，装不上。
修复：package.json 无条件打包。
```

#### ② `node_modules` 里有残留目录 → `Symlink path is the same as the target path`

```
pnpm 源码 symlinkDir():
    if (target === path) throw new Error('Symlink path is the same as the target path')

成因：插件被解压/复制到 node_modules 里（错误位置），
      pnpm 判定为孤儿 → 挪到 .ignored → 重建链接时路径撞自己。
修复：install.mjs 自动识别并清理。
```

#### ③ 在错误目录运行 → `Cannot find module 'C:\install.mjs'`

```
朋友在 C:\ 或 node_modules 里运行 node install.mjs，
当前目录没有那个文件。
修复：新增 安装.bat，双击即用（内部 cd /d "%~dp0" 先切到自身目录）。
```

#### ④ 脚本在「要被删除的目录」里运行 → EPERM

```
Windows 不允许删除进程当前工作目录及其祖先。
修复：install.mjs 启动即 chdir 到用户主目录。
```

#### ⑤ install.mjs 在 DSH 运行时留下半成品状态

```
DSH 运行时文件被占用，pnpm 装不上依赖，
留下「有声明、无链接」的半成品 → 下次启动报 cannot resolve profile bundle。
修复：先检测 DSH 进程，运行中则阻止（或要求 --config-only）。
```

#### 新增两个安装工具（不参与插件运行）

```text
install.mjs    命令行安装/修复器（幂等，可反复运行）
安装.bat        双击即用的包装（自动定位 node.exe 与本脚本）
```

---

### v1.5.0（2026-10-22）


**新增：Electron 运行时状态体检与重置 —— 补上一个致命盲区**

对应 2026-10-22 的真实事故，**这是目前为止最严重的一次**：

> DSH 完全无法启动，弹「Web authentication failed」，共崩 9 次。
> `.bat` 还原配置无效，「禁用第三方插件并重启」按钮也无效。

**根因：认证状态库被强杀写坏**

崩溃日志（9 个文件，全部同一错误）：

```
Error: desktop welcome: Web authentication failed
    at connectDesktopWelcome (lib/main.js:8886:31)
```

我扒 `app.asar` 挖到的完整链路：

```
① Electron 启动 Host 子进程
② Host 用随机 token 生成 authenticatedUrl（token 存在内存）
③ Electron fetch 该 URL，期望 303 + Set-Cookie
④ cookie 的签名密钥来自 credentials 里的 browser-session 记录
⑤ 密钥或 cookie 库损坏 → 永远 401 → "Web authentication failed"
```

**为什么原有手段全都无效 —— 我从源码验证过：**

| 手段 | 只做了什么 | 能否救本次 |
|---|---|---|
| 快照还原 | 覆盖 5 个配置文件 | ❌ 状态库不在范围内 |
| 「禁用插件」按钮 | `sanitizeProfile()`：备份 patch + 重置 bundles | ❌ 完全不碰状态库 |
| `.bat` | 同快照还原 | ❌ 同上 |

**新增能力：状态备份 + 恢复（不只是重置）**

用户一句话点破了关键：

> 「那就不能像快照一样备份吗？」

对 —— 实测整个认证状态只有 **115 KB**，比一份配置快照（156 KB）还小。
既然是这么小的数据，那就不该「只能删掉重来」，而应该和配置一样**备份 + 恢复**。

- `lib/estate.mjs` —— Electron 状态体检 / 备份 / 恢复 / 重置（零依赖）
- 体检（`check`）现在**自动包含**状态库检查
- **创建配置快照时，自动附带一份状态备份**（失败不影响主流程）

**新增命令：**

| 命令 | 作用 |
|---|---|
| `estate` | 体检（只读） | ← 仍存在 |
| ~~`estate --snapshot`~~ | ~~备份状态~~ | ← **本版删除，改用 `snapshot`** |
| ~~`estate --list`~~ | ~~列出状态备份~~ | ← **本版删除** |
| ~~`estate --restore [<id>]~~ | ~~从备份恢复~~ | ← **本版删除，改用 `restore`** |
| `estate --reset` | 重置（会清浏览器会话凭据；最后手段） | ← 仍存在 |

（`estate --reset` / `--dry-run` 仍支持预演）

**存储（旧设计，已被否决）：**

```
<快照根>/estate/<时间戳>/      ← 本版已删除这个目录
├── meta.json
├── Network/
└── ...
```

本版起改为随快照存放：`<快照>/estate/`

**恢复 vs 重置的区别：**

| | 恢复（--restore） | 重置（--reset） |
|---|---|---|
| 浏览器会话凭据 | ✅ 保留 | ❌ 清空 |
| 前提 | 有备份 | 无需备份 |
| 适用 | 状态库写坏 | 备份也没有了 |

**实测闭环：**

```
① 建备份（115 KB）
② 把 shared_proto_db/CURRENT 改成 0 字节
③ 体检报 2 个 fatal
④ （原命令 estate --restore，已删除；本版用 restore <id>）
⑤ 体检 0 problems，shared_proto_db 恢复 ✅
```

**`.bat` 失败分支同步更新**（仍是纯 ASCII）

**检测的条目：**

| 条目 | 级别 | 判定 |
|---|---|---|
| `Network/Cookies` | **致命** | 0 字节 / 全 0 = 库被写坏（**注意：只检查不备份**） |
| `Network/Cookies-journal` | 提示 | 非 0 残留 = 上次非正常退出 |
| `shared_proto_db` | 致命 | 全 0 字节 / CURRENT 为 0 = LevelDB 坏 |
| `lockfile` | 致命 | 残留导致「另一个实例在运行」 |
| `Local Storage` 等 | 提示 | 可疑时提醒 |

**安全设计：**

- 体检**只读**，绝不动文件
- 重置前**必须备份**（备份到 `rollback-estate-backup-<时间>/`）
- 重置前**强制检查 DSH 是否已退出**（文件被占用时删除会留下半删状态，比现在更糟）
- 明确告知会丢什么（浏览器会话凭据；账号不受影响）

**实测：**

```
造一个全 0 字节的 shared_proto_db
→ 体检抓到 2 个 fatal：
      · shared_proto_db 5 个文件全是 0 字节
```

---


**架构变更：状态备份并入快照，统一管理**

用户裁定：

> 「当拍摄快照时，profiles/desktop/ + AppData/Roaming/ 都写进去！
>  统一用快照做管理！不要在意占用存储大小！这些是用户自己来设置的！」

**前一版的做法（已被否决）：**

```
配置快照（156 KB）  ← 一条命令
状态备份（104 KB）  ← 另一条命令（现已被 本版删除）
两个存储、两套配额、两套命令
```

问题：用户在面板里只看到「快照」，以为备份齐了，
出事时才发现没有认证状态 —— 这正是 2026-10-22 事故的处境。

**最终做法：**

```
一次 snapshot = 配置文件 + 运行时状态
一次 restore  = 配置文件 + 运行时状态
```

快照目录结构：

```
<root>/<type>/<id>/
├── package.json          配置（平铺）
├── cordis.patch.yml
├── ...
└── estate/               ⭐ 状态
    ├── estate-meta.json
    ├── Network/          网络状态（Cookies 不含，见下节）
    ├── shared_proto_db/
    ├── Local Storage/
    └── ...
```

**体积代价（用户明确表示可接受）：**

| 部分 | 大小 |
|---|---|
| 配置 | ~156 KB |
| 状态 | ~104 KB |
| 合计 | **~260 KB / 份** |

**命令简化：**

| 旧设计 | 本版 |
|---|---|
| `snapshot` | `snapshot`（同时存状态） |
| `estate --snapshot` | ~~已删除~~ |
| `estate --list` | ~~已删除~~ |
| `estate --restore` | ~~已删除~~ |
| `restore <id>` | `restore <id>`（同时还原状态） |
| `estate`（体检） | `estate`（保留） |
| `estate --reset` | `estate --reset`（保留，最后手段） |

**`.bat` 也统一了：**

固化副本（`.bat` 的唯一数据源）现在同时包含配置和状态：

```
fixed/bat-default/
├── package.json
├── cordis.patch.yml
├── ...
└── estate/          ← 新增，30 个文件 / 121 KB
```

`.bat` 本身不变（还是那个入口），但它背后的数据完整了：
**一次还原，配置和状态都回来，浏览器会话凭据也保住。**

**实测：**

```
固化显示：
  配置:     5/5 个文件
  状态:     已包含（LevelDB 等，121 KB）
  合计:     277 KB

快照还原测试（造坏状态 → 还原）：
  shared_proto_db 的 CURRENT 从空恢复成 "MANIFEST-000001" ✅
  CURRENT 从空恢复成 "MANIFEST-000001" ✅
```

---

---

### v1.5.0 补记：为什么 Cookies 不进快照

> 这一节写给后来维护这个插件的人。
> 如果你也在想「认证 cookie 这么重要，为什么不备份它？」——
> 答案在这里，别重新踩一遍。

**结论先行：`Network/Cookies` 不进快照，是正确设计，不是遗漏。**

#### 一开始我把它当成关键文件（错的）

最初 `ESTATE_CRITICAL_FILES = ['Network/Cookies']`，
缺了就判「备份不完整」并向用户告警「还原后需要重新登录」。

**这个判断被用户当场否掉了：**

> 「Cookies 缺失 → 还原后需要重新登录一次。
>  但是这次事故中，我并没有重新登录！有我的个人信息，只是插件全禁用了」

**用户是对的。** 下面是源码级证据。

#### 证据一：cookie 每次启动都重新生成

`app.asar` → `lib/main.js` 的 `start()`：

```js
start: async () => {
    const ready = await host.start();
    hostCookie = await authenticateWebHost(ready.url);   // ← 每次换新
    ...
}
```

`authenticateWebHost` 用当前进程的 `launchToken` 去换 cookie：

```js
async function authenticateWebHost(url) {
    const response = await fetch(url, { redirect: "manual" });
    const cookie = response.headers.get("set-cookie");
    if (response.status !== 303 || cookie === null) {
        throw new Error("Desktop Host authentication failed");
    }
    ...
}
```

而 `launchToken` 是**内存态、每个进程随机生成**：

```js
function processLaunchToken(owner) {
    const created = encodeBase64Url(randomBytes(SECRET_BYTES));
    PROCESS_LAUNCH_TOKENS.set(owner, created);
    return created;
}
```

**所以磁盘上那份旧 cookie 到下次启动时已经完全作废，备份它毫无意义。**

#### 证据二：cookie 的 payload 里没有账号信息

```js
const value = encodeCookie({
    version: COOKIE_PAYLOAD_VERSION,
    authority,        // "127.0.0.1:端口"
    issuedAt,         // 签发时间
    expiresAt,        // 过期时间
}, this.secret);
```

**只有三样，全是本机进程间握手所需。没有 user id、没有 token、没有邮箱。**

#### 证据三：坏掉的库 Chromium 自己会重建

实测（2026-10-22）：

```
DSH 启动成功:      08:43:49
Network/Cookies:  mtime = 11:26:08    ← 比启动晚 2.7 小时
```

**那是 DSH 自己写出的全新空库，不是从任何备份恢复的。**

**所以这次事故后用户能正常启动、且没有重新登录 —— 完全符合预期。**

#### 真正的账号登录态在哪

在 `$DSH_HOME/.credentials.yaml`（**不在 Electron userData 里**）：

```yaml
records:
  client-connection/browser-session:       # 签名密钥（供上面那个 cookie 用）
    kind: grant
    payload: { secret: ... }

  deepseek-account-platform/default:       # ⭐ 真正的账号身份
    payload: { token: ..., issuer: ... }

refs:                                      # 各种 API key / 第三方账号
  DEEPSEEK_API_KEY: ...
  TRAE_ACCOUNT_C23EB306: ...
```

**它和 cookie 库是两个完全独立的存储，坏一个不影响另一个。**

#### 那 Cookies 到底还需要做什么

| 能力 | 需要吗 | 谁负责 |
|---|---|---|
| 备份 cookie **内容** | ❌ 不需要 | —— |
| 体检 cookie 库**是否损坏** | ✅ **必须** | `estate` 命令 |
| 重置损坏的库 | ✅ **必须** | `estate --reset` |

**这次事故的病根就是「库损坏导致写不进新 cookie」。**
**所以「发现损坏」和「重置损坏」必须保留，但「备份内容」没有意义。**

#### 给后来者的提醒

```text
① 不要再把 Cookies 加进 ESTATE_CRITICAL_FILES
   —— 会让每份快照都被误判为「不完整」

② 不要建议用户「退出 DSH 才能建完整快照」
   —— 退出也拿不到有用的东西，cookie 本来就是一次性的

③ estate 体检里的 Cookies 检查不能删
   —— 它是这次事故唯一的早期预警手段

④ 如果将来要备份 .credentials.yaml
   —— 那是另一个议题：它含 API key / 手机号 / 邮箱，
      是安全敏感文件，且用原子写保护、不易损坏。
      而且它不在 Electron userData 里，需要单独的备份策略。
```

**相关代码位置：**

| 文件 | 内容 |
|---|---|
| `lib/core.mjs` | `ESTATE_CRITICAL_FILES`（现为空数组，注释里写了完整推理） |
| `lib/estate.mjs` | `ESTATE_ITEMS` 里 Cookies 的检查规则（保留） |
| `lib/core.mjs` | `cpDir()` 的 `locked` 返回 —— 记录但不视为失败 |

---

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

*版本 1.5.2 · 2026-10-26*
