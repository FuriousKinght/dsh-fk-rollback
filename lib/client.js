/**
 * FK 回滚插件 · 模块一：UI 面板
 *
 * @version 1.5.1
 */
/* dsh-fk-rollback client bundle
 *
 * 手写在 __ModuleLoader__ 协议里，不依赖构建工具。
 * 只做一件事：在「设置 → 侧边栏」注册一个【FK回滚设置】区块。
 *
 * ⚠️ 为什么包在 try/catch 里：
 *   本插件是 bundle 插件，client 半边若抛异常会拖垮 DSH。
 *   评审 §9.2 要求：client 入口必须是薄壳 + 任何异常都不能冒泡。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fk-rollback',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    try {
      const React = require('react')

      // ───────────────────────────────────────────────────────
      // 基础工具
      // ───────────────────────────────────────────────────────

      /** 调 Host 端点的封装。失败不抛，返回 { error }。 */
      async function api(path, options) {
        try {
          const res = await fetch('/plugins/dsh-fk-rollback' + path, {
            headers: { 'Content-Type': 'application/json' },
            ...options,
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) return { error: data.error || ('HTTP ' + res.status) }
          return data
        } catch (e) {
          return { error: String(e && e.message ? e.message : e) }
        }
      }

      /**
       * 请求重启 DSH。
       *
       * ⚠️ 2026-10-19 修正：必须用 POST。
       *   重启端点的 handler 开头就是 if (req.method !== 'POST') return 405，
       *   而 window.location.href = url 发的是 GET → 永远 405。
       *
       * ⚠️ 2026-10-20 v1.3.0：重启能力已【内置】到本插件，
       *   不再依赖任何外部重启插件。调用链：
       *     前端 → /plugins/dsh-fk-rollback/restart
       *          → lib/restart.mjs → WMI 创建助手 → taskkill /T → 自动重开
       *
       * @returns {Promise<{ok: boolean, error?: string, detail?: object}>}
       */
      async function requestRestart() {
        try {
          // 走本插件自己的端点（Host 端内置重启，零外部依赖）
          const res = await fetch('/plugins/dsh-fk-rollback/restart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
            cache: 'no-store',
          })
          let data = {}
          try { data = await res.json() } catch { /* 可能不是 JSON */ }
          if (!res.ok || data.ok === false) {
            return { ok: false, error: data.error || ('HTTP ' + res.status) }
          }
          return { ok: true, detail: data }
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) }
        }
      }

      /** 相对时间显示。 */
      function relTime(ms) {
        if (!ms) return ''
        const d = Date.now() - ms
        if (d < 60000) return '刚刚'
        if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前'
        if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前'
        return Math.floor(d / 86400000) + ' 天前'
      }

      /** 绝对时间显示。 */
      function absTime(ms) {
        if (!ms) return '?'
        const d = new Date(ms)
        const p = (n) => String(n).padStart(2, '0')
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
          + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      }

      // ── 时间分组工具（2026-10-20 UI 重设计）──
      //
      // 用户要求「按时间分组」：今天 / 昨天 / 更早
      // 而不是按类型（每日/手动/滚动），因为用户是「想回到某个时间点」。

      /** 本地日期键 YYYY-MM-DD（不能用 toISOString，那是 UTC） */
      function dayKey(ms) {
        if (!ms) return ''
        const d = new Date(ms)
        const p = (x) => String(x).padStart(2, '0')
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      }

      /** 拿今天的日期键 */
      function todayKey() { return dayKey(Date.now()) }

      /** 昨天的日期键 */
      function yesterdayKey() {
        const d = new Date()
        d.setDate(d.getDate() - 1)
        return dayKey(d.getTime())
      }

      /**
       * 分组标签：今天 / 昨天 / 更早
       * @returns {{key: string, label: string, order: number}}
       */
      function groupOf(ms) {
        const k = dayKey(ms)
        if (k === todayKey()) return { key: 'today', label: '今天', order: 0 }
        if (k === yesterdayKey()) return { key: 'yesterday', label: '昨天', order: 1 }
        return { key: 'earlier', label: '更早', order: 2 }
      }

      /**
       * 副行时间显示：
       *   今天/昨天 → 只显示时分   「10:17」
       *   更早      → 月日 + 时分  「10-15 09:30」
       */
      function shortTime(ms) {
        if (!ms) return '?'
        const d = new Date(ms)
        const p = (x) => String(x).padStart(2, '0')
        const hm = p(d.getHours()) + ':' + p(d.getMinutes())
        const k = dayKey(ms)
        if (k === todayKey() || k === yesterdayKey()) return hm
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hm
      }

      /** 健康等级 → 星级 + 说明。 */
      const GRADE_INFO = {
        'verified-strong': { stars: '★★★★★', text: '多次启动成功', color: '#2e7d32' },
        verified: { stars: '★★★★☆', text: '启动成功过', color: '#388e3c' },
        'static-ok': { stars: '★★★☆☆', text: '静态体检通过（未验证启动）', color: '#f57c00' },
        failed: { stars: '★☆☆☆☆', text: '曾启动失败', color: '#d32f2f' },
        broken: { stars: '☆☆☆☆☆', text: '体检未通过', color: '#c62828' },
      }

      // 快照的「创建来源」（区分自动钩子 / AI 会话 / 用户手动）
      // ⚠️ 2026-10-19 用户指出：这些快照明明是 AI 建的，标签却写「手动」
      const ORIGIN_INFO = {
        auto: { label: '自动', color: 'var(--dsw-alias-state-business-primary,#2b6cb0)', title: '插件钩子自动创建（每日/滚动/装插件前后/回滚前）' },
        ai: { label: 'AI', color: 'var(--dsw-alias-state-warning-primary,#e65100)', title: 'AI 在会话中创建' },
        user: { label: '手动', color: 'var(--dsw-alias-label-tertiary,inherit)', title: '你在终端或面板手动创建' },
      }

      const TYPE_INFO = {
        daily: { icon: '📅', label: '每日' },
        rolling: { icon: '🔄', label: '滚动' },
        manual: { icon: '📌', label: '手动' },
        'before-restore': { icon: '↩️', label: '回滚前' },
      }

      const SEVERITY_INFO = {
        fatal: { icon: '❌', color: '#c62828', label: '致命' },
        error: { icon: '⚠️', color: '#e65100', label: '错误' },
        warn: { icon: '🟡', color: '#f9a825', label: '警告' },
        info: { icon: 'ⓘ', color: '#1976d2', label: '提示' },
      }

      // ───────────────────────────────────────────────────────
      // 样式（内联，避免依赖外部 CSS 管线）
      // ───────────────────────────────────────────────────────

      const CSS_ID = 'dsh-fk-rollback-style'
      function ensureStyle() {
        try {
          if (document.getElementById(CSS_ID)) return
          const s = document.createElement('style')
          s.id = CSS_ID
          s.textContent = [
            '.fkr-wrap{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
            '.fkr-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:8px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,transparent)}',
            '.fkr-row{display:flex;align-items:center;justify-content:space-between;gap:10px}',
            '.fkr-title{font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary)}',
            '.fkr-muted{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.85));font-size:12px}',
            // 主按钮：官方写法 = button-primary-fill 作背景 + label-primary-foreground 作前景
            '.fkr-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary,inherit);border-radius:6px;padding:5px 11px;cursor:pointer;font-size:12px;font-family:inherit;line-height:1.5}',
            '.fkr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
            '.fkr-btn-primary{background:var(--dsw-alias-button-primary-fill,#2b6cb0);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}',
            '.fkr-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#245a94)}',
            '.fkr-btn-danger{background:var(--dsw-alias-state-error-primary,#c62828);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}',
            '.fkr-btn:disabled{opacity:.45;cursor:not-allowed}',
            '.fkr-list{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto}',
            '.fkr-item{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:6px;border:1px solid transparent}',
            // ⚠️ 2026-10-20 用户反馈：加了「设为 .bat」按钮后，展开的卡片被按钮挤压，
            //    文字变成一字一行（截图可证）。根因是 .fkr-item 是【横向 flex】，
            //    所有子元素（名字/星级/标签/按钮）都挤在同一行。
            //    修法：卡片改纵向，内部再分「顶部信息行」和「按钮行」。
            '.fkr-item-col{display:flex;flex-direction:column;align-items:stretch;gap:7px}',
            '.fkr-top{display:flex;align-items:center;gap:9px;min-width:0}',
            '.fkr-actions{display:flex;gap:5px;flex-wrap:wrap;padding-left:27px}',
            '.fkr-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}',
            '.fkr-icon{width:18px;text-align:center;flex:none}',
            '.fkr-main{flex:1;min-width:0}',
            '.fkr-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}',
            '.fkr-stars{font-size:11px;letter-spacing:-1px}',
            '.fkr-tag{font-size:10px;padding:1px 6px;border-radius:9px;border:1px solid currentColor;opacity:.85}',
            '.fkr-issue{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}',
            '.fkr-issue:last-child{border-bottom:none}',
            '.fkr-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999}',
            '.fkr-modal{background:var(--dsw-alias-bg-layer-1,#1e1e1e);color:var(--dsw-alias-label-primary,inherit);border-radius:10px;padding:18px 20px;width:min(560px,92vw);max-height:86vh;overflow:auto;box-shadow:0 8px 40px rgba(0,0,0,.4);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28))}',
            '.fkr-input{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:13px;line-height:1.5}',
            '.fkr-input::placeholder{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8))}',
            '.fkr-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#2b6cb0);outline-offset:1px}',
            '.fkr-alert{padding:8px 11px;border-radius:6px;font-size:12px;border:1px solid currentColor}',
            '.fkr-bar{height:5px;border-radius:3px;background:var(--dsw-alias-fill-tertiary,rgba(128,128,128,.22));overflow:hidden}',
            '.fkr-bar>i{display:block;height:100%;background:currentColor;transition:width .3s}',
            '.fkr-spin{display:inline-block;animation:fkrspin 1s linear infinite}',
            '@keyframes fkrspin{to{transform:rotate(360deg)}}',
            // ── 搜索 / 筛选 / 分页（决定 11、45、14）──
            '.fkr-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}',
            '.fkr-search{flex:1 1 160px;min-width:120px}',
            '.fkr-select{flex:0 0 auto;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:12px}',
            '.fkr-pager{display:flex;gap:6px;align-items:center;justify-content:center;padding-top:10px}',
            // ── 折叠区（决定 8、17、42）──
            '.fkr-fold{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:8px;margin-top:10px}',
            '.fkr-foldHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));user-select:none}',
            '.fkr-foldHead:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
            '.fkr-foldBody{padding:0 12px 10px}',
            // ── ● 当前状态徽标（决定 5）──
            '.fkr-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#2e7d32);margin-right:5px;flex:none}',
            '.fkr-cur{font-size:10px;padding:1px 6px;border-radius:9px;border:1px solid var(--dsw-alias-state-success-primary,#2e7d32);color:var(--dsw-alias-state-success-primary,#2e7d32);opacity:.9}',
            // ── 常驻顶部条（决定 24）──
            '.fkr-banner{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-warning-primary,#f9a825);background:var(--dsw-alias-interactive-bg-hover-accent,rgba(249,168,37,.1));font-size:12px}',
            // ── 四分区清单（决定 26）──
            '.fkr-part{padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}',
            '.fkr-part:last-child{border-bottom:none}',
            '.fkr-partTitle{font-size:12px;font-weight:600;margin-bottom:5px}',
            '.fkr-partItem{font-size:11px;padding:2px 0;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
            '.fkr-scroll{max-height:260px;overflow:auto}',
            // ══════════════════════════════════════════════════════
            // 2026-10-20 UI 重设计：时间分组 + 双行紧凑条目
            //   用户反馈：「快照列表看着真乱！分类也不明白」
            //   改为按【时间】分组（今天/昨天/更早），条目压成双行
            // ══════════════════════════════════════════════════════
            // ── 分组标题 ──
            '.fkr-group{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 2px 5px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
            '.fkr-group:first-child{padding-top:2px}',
            '.fkr-groupCount{font-weight:400;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8))}',
            // ── 双行条目 ──
            '.fkr-line{display:flex;flex-direction:column;gap:1px;padding:6px 9px;border-radius:6px;border:1px solid transparent;cursor:pointer}',
            '.fkr-line:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}',
            '.fkr-lineSel{border-color:var(--dsw-alias-button-primary-fill,#2b6cb0);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
            // 主行：● 图标 名称 …… 星级 大小 🔒
            '.fkr-lineMain{display:flex;align-items:center;gap:7px;min-width:0}',
            '.fkr-lineName{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;color:var(--dsw-alias-label-primary)}',
            '.fkr-lineSize{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.85));font-variant-numeric:tabular-nums}',
            '.fkr-lock{flex:none;font-size:11px;title:""}',
            // 副行：时间 · 来源
            '.fkr-lineSub{display:flex;align-items:center;gap:5px;padding-left:25px;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.85))}',
            // ── 展开区（选中后出现）──
            '.fkr-expand{margin:3px 0 3px 25px;padding:9px 11px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.04));display:flex;flex-direction:column;gap:6px}',
            '.fkr-kv{display:flex;gap:6px;font-size:11px;line-height:1.55}',
            '.fkr-kvKey{flex:none;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.85));min-width:44px}',
            '.fkr-kvVal{flex:1;min-width:0;word-break:break-all;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.98))}',
            '.fkr-expandBtns{display:flex;gap:5px;flex-wrap:wrap;margin-top:2px}',
            // ── .bat 状态卡（放在快照管理面板里）──
            '.fkr-batCard{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:12px;padding-top:11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}',
            '.fkr-batText{display:flex;flex-direction:column;gap:2px;min-width:0}',
          ].join('\n')
          document.head.appendChild(s)
        } catch { /* 忽略 */ }
      }

      // ───────────────────────────────────────────────────────
      // 主面板组件
      // ───────────────────────────────────────────────────────

      function Panel(props) {
        const [state, setState] = React.useState({ loading: true, data: null, error: null })
        const [busy, setBusy] = React.useState(null)
        const [msg, setMsg] = React.useState(null)
        const [selected, setSelected] = React.useState(null)
        const [showRestore, setShowRestore] = React.useState(false)
        const [showSnap, setShowSnap] = React.useState(false)
        const [snapName, setSnapName] = React.useState('')
        const [snapNote, setSnapNote] = React.useState('')
        const [progress, setProgress] = React.useState(null)
        const [tab, setTab] = React.useState('snapshots')
        const [dryPlan, setDryPlan] = React.useState(null)
        const [dupInfo, setDupInfo] = React.useState(null)
        const [result, setResult] = React.useState(null)   // §2.7b 回滚结果页
        const [ignoreRestart, setIgnoreRestart] = React.useState(false)  // §2.22 忽略按钮
        const [restartAvail, setRestartAvail] = React.useState(false)
        // 内置重启的探测详情（v1.3.0）：含不可用原因，供按钮 tooltip 与提示使用
        const [restartInfo, setRestartInfo] = React.useState(null)
        // ⭐ .bat 固化卡片的忙碌态（2026-10-20 UI 重设计）
        const [batBusy, setBatBusy] = React.useState(false)

        /** 从「快照管理」面板取消 .bat 固化 */
        async function doUnfixFromPanel() {
          setBatBusy(true)
          const r = await api('/fix', { method: 'POST', body: JSON.stringify({ remove: true }) })
          setBatBusy(false)
          if (r.error) { setMsg({ kind: 'err', text: '取消失败：' + r.error }); return }
          setMsg({ kind: 'ok', text: '已取消固化 —— .bat 暂时不可用，下次启动会自动重新固化当天每日快照' })
          await refresh()
        }

        /**
         * 切换 .bat 固化副本的「钉住」状态（2026-10-23 新增）
         *
         * 不钉住 → 下次 DSH 启动时，当天 daily 会自动替换这一份
         * 钉住   → 一直保留，除非再次点这里取消
         */
        async function doTogglePin() {
          const cur = state.data?.fixed?.meta
          if (!cur) { setMsg({ kind: 'err', text: '当前没有固化副本' }); return }
          const next = cur.pin === true ? 'off' : 'on'
          setBatBusy(true)
          const r = await api('/fix', { method: 'POST', body: JSON.stringify({ togglePin: next }) })
          setBatBusy(false)
          if (r.error) { setMsg({ kind: 'err', text: '操作失败：' + r.error }); return }
          setMsg({
            kind: 'ok',
            text: next === 'on'
              ? '已钉住 —— 下次启动不会替换这一份'
              : '已取消钉住 —— 下次启动会自动换成当天每日快照',
          })
          await refresh()
        }

        React.useEffect(() => { ensureStyle(); refresh() }, [])

        async function refresh() {
          setState((s) => ({ ...s, loading: true }))
          const d = await api('/info')
          setState({ loading: false, data: d.error ? null : d, error: d.error || null })
          // 探测【内置】重启能力（v1.3.0：不再依赖外部插件）
          try {
            const rh = await api('/restart-helper')
            setRestartAvail(Boolean(rh && rh.available))
            setRestartInfo(rh || null)
          } catch { setRestartAvail(false); setRestartInfo(null) }
        }

        /** 打开回滚确认框前先算四分区清单（决定 26/27） */
        async function openRestore(id) {
          setSelected(id || null)
          setDryPlan(null)
          setShowRestore(true)
          try {
            const r = await api('/restore', {
              method: 'POST',
              body: JSON.stringify({ id: id || undefined, dryRun: true }),
            })
            if (!r.error) setDryPlan(r.plan || null)
          } catch { /* 忽略 */ }
        }

        async function doSnapshot(force) {
          setBusy('snapshot'); setMsg(null)
          const d = await api('/snapshot', {
            method: 'POST',
            body: JSON.stringify({
              name: snapName || undefined,
              note: snapNote || undefined,
              force: Boolean(force),
            }),
          })
          setBusy(null)
          if (d.error) { setMsg({ kind: 'err', text: '创建失败：' + d.error }); return }
          // 决定 7：内容与最新快照相同 → 先问一句，别默默建一份重复的
          if (d.needConfirm) {
            setDupInfo({ message: d.message, latestName: d.latestName, latestAt: d.latestAt })
            return
          }
          // ⭐ 状态完整度提示（2026-10-22 审计发现：之前完全不提）
          // 2026-10-22 最终版：状态与配置一起存，不再有「完整度」概念
          if (d.estate && d.estate.included === false) {
            setMsg({ kind: 'ok', text: '已创建快照：' + d.name + '（不含运行时状态）' })
          } else if (d.estate && d.estate.included) {
            setMsg({
              kind: 'ok',
              text: '已创建快照：' + d.name + '（含运行时状态 '
                + Math.round((d.estate.bytes || 0) / 1024) + ' KB）',
            })
          } else {
            setMsg({ kind: 'ok', text: '已创建快照：' + d.name })
          }
          setShowSnap(false); setSnapName(''); setSnapNote(''); setDupInfo(null)
          await refresh()
        }

        async function doRestore(id) {
          // 设计方案 §2.22：UI 五阶段（后四步内部步骤合并为第⑤阶段）
          const STEPS = ['校验快照完整性', '创建回滚前快照', '保存 rescue 副本', '写入配置文件', '复检与完整性检查']
          setBusy('restore'); setMsg(null); setProgress({ step: 0, STEPS })
          let cur = 0
          const timer = setInterval(() => {
            cur = Math.min(cur + 1, STEPS.length - 1)
            setProgress({ step: cur, STEPS })
          }, 420)

          const d = await api('/restore', { method: 'POST', body: JSON.stringify({ id }) })
          clearInterval(timer)
          setProgress({ step: STEPS.length, STEPS })
          setBusy(null)
          setShowRestore(false)

          if (d.error) { setMsg({ kind: 'err', text: '还原失败：' + d.error }); return }
          const okCount = (d.restored || []).length
          if (d.ok) {
            // §2.7b：结果页要报「实际发生了什么」，不是一句「完成」
            setResult({
              ok: true,
              targetName: d.targetName || (target ? target.name : ''),
              restored: d.restored || [],
              plan: d.plan || null,
              beforeId: d.beforeId,
            })
            setMsg(null)
          } else {
            setResult({
              ok: false,
              targetName: d.targetName || (target ? target.name : ''),
              restored: d.restored || [],
              failed: d.failed || [],
              plan: d.plan || null,
              beforeId: d.beforeId,
            })
            setMsg(null)
          }
          await refresh()
        }

        if (state.loading && !state.data) {
          return React.createElement('div', { className: 'fkr-wrap' },
            React.createElement('div', { className: 'fkr-muted' },
              React.createElement('span', { className: 'fkr-spin' }, '◐'), ' 正在读取…'))
        }
        if (state.error) {
          return React.createElement('div', { className: 'fkr-wrap' },
            React.createElement('div', { className: 'fkr-card' },
              React.createElement('div', { className: 'fkr-title' }, '⚠️ 无法读取快照数据'),
              React.createElement('div', { className: 'fkr-muted' }, state.error),
              React.createElement('div', { style: { marginTop: 10 } },
                React.createElement('button', { className: 'fkr-btn', onClick: refresh }, '重试'))))
        }

        const d = state.data
        const entries = d.entries || []
        const c = d.check || { counts: {}, issues: [] }
        // ⭐ 固化副本状态（2026-10-20 UI 重设计：.bat 卡片挪到快照管理面板）
        const fixed = d.fixed || null

        // ── 顶部状态区（设计方案 §2.2 · 665-681 行）──
        //
        //   【静态检查】  ✅ 0 错误  3 提示              [ 展开 ]
        //   【启动结果核对】⚠ 1 个 bundle 未启动         [ 展开 ]
        //
        //   ● 当前配置与快照「装FK插件前」一致
        //                                       [ 创建快照 ]
        //
        // ⚠️ 这里【没有】「一键回滚」按钮。
        //    回滚永远是「先选中某个快照，再点它自己的回滚」——
        //    因为「回滚」必须有一个明确的目标，不存在「一键回到某个说不清的状态」。
        //    （2026-10-19 之前误加过一个，它会静默地选「最新的健康快照」，
        //      用户根本不知道要回滚到哪，已移除。）
        // 真问题数 = problems + notices（不含正常状态、不含已确认）
        const realCount = (c.problems || []).length + (c.notices || []).length
        const curSnap = entries.find((e2) => e2.isCurrent)
        const statusRow = React.createElement('div', { className: 'fkr-card' },
          React.createElement('div', { className: 'fkr-row' },
            React.createElement('div', { className: 'fkr-title' }, '快照管理'),
            React.createElement('button', { className: 'fkr-btn', onClick: refresh, disabled: !!busy }, '刷新')),
          React.createElement('div', { className: 'fkr-muted', style: { marginTop: 6 } },
            'profile：' + d.profile + (d.dshVersion ? ' · DSH ' + d.dshVersion : '')),

          // ── 体检状态（2026-10-19 重做：只报真问题）──
          //
          // 旧版把每一条 issue 都列出来（连「符号链接是 DSH 升级遗留」这种
          // 正常状态也报），普通用户根本分不清哪个要管。
          // 新版：真问题才显示，正常状态完全不出现在这里。
          React.createElement('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 } },
            React.createElement('div', null,
              '【体检】 ',
              realCount === 0
                ? React.createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary,#2e7d32)' } },
                  '✅ 一切正常')
                : c.counts.fatal > 0
                  ? React.createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary,#c62828)' } },
                    '❌ ' + c.counts.fatal + ' 个致命问题')
                  : React.createElement('span', { style: { color: 'var(--dsw-alias-state-warning-primary,#e65100)' } },
                    '⚠️ ' + realCount + ' 个问题'),
              // 正常状态只给一个不起眼的括号说明，不参与判断
              (c.normalCount || 0) > 0
                ? React.createElement('span', { className: 'fkr-muted', style: { fontSize: 11 } },
                  '（另有 ' + c.normalCount + ' 项正常状态，无需处理）')
                : null,
              realCount > 0
                ? React.createElement('span', null,
                  '   ',
                  React.createElement('button', {
                    className: 'fkr-btn', style: { padding: '1px 8px', fontSize: 11 },
                    onClick: () => setTab('issues'),
                  }, '查看'))
                : null),
            // ⚠️ 2026-10-20 用户反馈「一切正常 X2」：
            //   这里原本又输出一次 c.verdict，而上一行已经显示过「✅ 一切正常」。
            //   正常时 c.verdict 的值就是「一切正常」，于是出现两遍。
            //   整块删除 —— 上一行已经说清楚了。
            ),

          // ● 当前配置状态（§2.2 第 679 行）
          React.createElement('div', { style: { marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
            React.createElement('div', null,
              curSnap
                ? React.createElement('span', null,
                  React.createElement('span', { className: 'fkr-dot' }),
                  '当前配置与快照「' + (curSnap.name || curSnap.id) + '」一致')
                : React.createElement('span', { className: 'fkr-muted' },
                  '当前配置还没有对应的快照 —— 建议点右侧「创建快照」留一个还原点')),
            React.createElement('button', {
              className: 'fkr-btn fkr-btn-primary',
              onClick: () => setShowSnap(true),
              disabled: !!busy,
            }, '创建快照')),

          // ⭐ .bat 紧急救场状态（2026-10-20 用户要求挪到这个面板里）
          //
          // 用户原话：「这个 .bat 状态条放置在快照管理 UI 面板中，不要占用快照列表」
          //
          // 语义：.bat 只读固化副本，不依赖快照池。
          //   有固化 → 显示来源 + 固化时间 + [更换][取消]
          //   无固化 → 警示（下次启动会自动固化）
          React.createElement('div', { className: 'fkr-batCard' },
            React.createElement('div', { className: 'fkr-batText' },
              fixed
                ? React.createElement('span', {
                  style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary,#2e7d32)' },
                // ⭐ 2026-10-23：显示钉住状态，让用户知道下次启动会不会被换掉
                }, (fixed.meta?.pin === true ? '📌 ' : '🔒 ')
                  + '.bat 使用「' + (fixed.meta?.fromName || '?') + '」')
                : React.createElement('span', {
                  style: { fontSize: 12, color: 'var(--dsw-alias-state-warning-primary,#e65100)' },
                }, '⚠️ 还没有固化副本 —— .bat 暂时无法工作'),
              React.createElement('span', { className: 'fkr-muted', style: { fontSize: 11 } },
                fixed
                  // 说清「下次启动会发生什么」——这是用户最需要知道的
                  ? (fixed.meta?.pin === true
                    ? '已钉住 · 启动时不会自动替换 · 固化于 ' + absTime(Date.parse(fixed.meta?.fixedAt))
                    : '下次启动会自动换成当天每日快照 · 固化于 ' + absTime(Date.parse(fixed.meta?.fixedAt)))
                  : '下次启动 DSH 会自动把当天每日快照固化过去')),
            React.createElement('div', { style: { display: 'flex', gap: 5, flex: 'none' } },
              fixed
                ? React.createElement('button', {
                  className: 'fkr-btn', style: { fontSize: 11 },
                  disabled: !!batBusy,
                  onClick: doTogglePin,
                  title: fixed.meta?.pin === true
                    ? '取消钉住后，下次启动会自动换成当天每日快照'
                    : '钉住后，下次启动不会替换这一份',
                }, batBusy ? '…' : (fixed.meta?.pin === true ? '取消钉住' : '钉住'))
                : null,
              fixed
                ? React.createElement('button', {
                  className: 'fkr-btn', style: { fontSize: 11 },
                  onClick: () => { setTab('snapshots'); setMsg({ kind: 'ok', text: '在列表里点开一份快照，选「设为 .bat」即可更换' }) },
                }, '更换')
                : null,
              fixed
                ? React.createElement('button', {
                  className: 'fkr-btn', style: { fontSize: 11 },
                  disabled: !!batBusy,
                  onClick: doUnfixFromPanel,
                }, batBusy ? '处理中…' : '取消')
                : null)))

        // ── 未重启提醒（决定 24）──
        const bannerEl = (d.pendingRestart && !ignoreRestart) ? React.createElement('div', { className: 'fkr-banner' },
          React.createElement('span', null, '⚠️'),
          React.createElement('span', { style: { flex: 1 } },
            '配置已回滚，但 DSH 还没重启 —— 新配置尚未生效。'
            + (d.rolledBackAt ? '（回滚于 ' + absTime(d.rolledBackAt) + '）' : '')),
          // ⚠️ 2026-10-20：同回滚结果页 —— 按钮永远可点，
          //    由 Host 的 /restart 给出真实结果（不再因探测失败而灰掉）
          React.createElement('button', {
            className: 'fkr-btn fkr-btn-primary',
            disabled: busy === 'restart',
            title: restartAvail
              ? '重启 DSH 让回滚生效（内置重启能力）'
              : '暂时无法自动重启：' + String(restartInfo?.reason || '未知原因'),
            onClick: async () => {
              setBusy('restart')
              const r = await requestRestart()
              if (!r.ok) {
                setBusy(null)
                setMsg({
                  kind: 'err',
                  text: '重启请求失败：' + (r.error || '未知原因')
                    + '。可以手动关闭 DSH 再打开（配置已经写好，下次启动就生效）。',
                })
                return
              }
              // 重启成功后 DSH 会被关掉，这个页面也就没了 —— 不需要收尾
              setMsg({ kind: 'ok', text: '正在重启 DSH…（窗口会短暂关闭后自动重开）' })
            },
          }, busy === 'restart' ? '重启中…' : '立即重启'),
          // §2.22：本次会话内不再显示，重启后重新判断
          React.createElement('button', {
            className: 'fkr-btn',
            title: '本次会话内不再提示（重启后重新判断）',
            onClick: () => setIgnoreRestart(true),
          }, '忽略')) : null

        // ── §2.7b 回滚结果页：报「实际发生了什么」 ──
        const resultEl = result ? React.createElement('div', { className: 'fkr-card' },
          React.createElement('div', { className: 'fkr-row' },
            React.createElement('div', { className: 'fkr-title' },
              result.ok ? '✅ 回滚完成：' + (result.targetName || '目标快照')
                        : '⚠️ 回滚未完全成功：' + (result.targetName || '目标快照')),
            React.createElement('button', { className: 'fkr-btn', onClick: () => setResult(null) }, '关闭')),

          React.createElement('div', { className: 'fkr-muted', style: { marginTop: 6 } },
            result.ok
              ? '已恢复 ' + (result.restored || []).length + ' 个配置文件（SHA256 全部校验通过）'
              : '已恢复 ' + (result.restored || []).length + ' 个，失败 ' + (result.failed || []).length + ' 个：'
                + (result.failed || []).join('、')),

          // 已移除清单（§2.7b）
          result.plan && (result.plan.removed || []).length > 0
            ? React.createElement('div', { className: 'fkr-part' },
              React.createElement('div', { className: 'fkr-partTitle' }, '已移除（配置已不再引用）'),
              result.plan.removed.slice(0, 10).map((x, i) => React.createElement('div', {
                key: i, className: 'fkr-partItem',
              }, '✗ ' + (x.name || x))),
              React.createElement('div', { className: 'fkr-muted', style: { marginTop: 6, fontSize: 11 } },
                'ⓘ 这些插件的文件仍在 node_modules，只是不再加载。可手动清理：'),
              result.plan.removed.slice(0, 3).map((x, i) => React.createElement('div', {
                key: 'c' + i,
                style: { fontSize: 11, fontFamily: 'monospace', opacity: 0.8 },
              }, 'rmdir node_modules\\' + (x.name || x))))
            : null,

          // 未受影响的（§2.7b）
          React.createElement('div', { className: 'fkr-part' },
            React.createElement('div', { className: 'fkr-partTitle' }, '未受影响的'),
            React.createElement('div', { className: 'fkr-partItem' }, '✓ 会话记录（不在快照范围）'),
            React.createElement('div', { className: 'fkr-partItem' }, '✓ 你的插件源码（plugin-src）')),

          React.createElement('div', { className: 'fkr-muted', style: { marginTop: 8 } },
            '回滚前状态已存为：' + (result.beforeId || '?')),

          React.createElement('div', { style: { marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' } },
            React.createElement('button', { className: 'fkr-btn', onClick: () => setResult(null) }, '稍后重启'),
            // ⚠️ 2026-10-20 用户反馈：这个按钮一直是灰的，点不了。
            //   根因是 restartAvail 的探测写错了（见 entry.js /restart-helper）。
            //   除修探测外，这里也改成：即使探测失败也【渲染可点按钮】——
            //   由 Host 端的 /restart 给出真实结果，而不是让用户对着灰按钮发呆。
            React.createElement('button', {
              className: 'fkr-btn fkr-btn-primary',
              disabled: busy === 'restart',
              title: restartAvail
                ? '重启 DSH 让回滚生效（内置重启能力）'
                : '暂时无法自动重启：' + String(restartInfo?.reason || '未知原因'),
              onClick: async () => {
                setBusy('restart')
                const r = await requestRestart()
                if (!r.ok) {
                  setBusy(null)
                  setMsg({
                    kind: 'err',
                    text: '重启请求失败：' + (r.error || '未知原因')
                      + '。可以手动关闭 DSH 再打开（配置已经写好，下次启动就生效）。',
                  })
                  return
                }
                // 重启成功后 DSH 会被关掉，这个页面也就没了 —— 不需要收尾
                setMsg({ kind: 'ok', text: '正在重启 DSH…（窗口会短暂关闭后自动重开）' })
              },
            }, busy === 'restart' ? '重启中…' : '立即重启 DSH'))) : null

        // ── 消息条 ──
        const msgEl = msg ? React.createElement('div', {
          className: 'fkr-alert',
          style: {
            // 2026-10-22：加 warn（橙色）—— 状态不完整属于「成功了但有缺陷」，
            // 用绿色会误导用户以为一切正常
            color: msg.kind === 'err' ? '#c62828'
              : msg.kind === 'warn' ? '#ef6c00'
                : '#2e7d32',
          },
        }, msg.text) : null

        // ── 进度条 ──
        const progEl = progress ? React.createElement('div', { className: 'fkr-card' },
          React.createElement('div', { className: 'fkr-row' },
            React.createElement('span', null, '正在还原…'),
            React.createElement('span', { className: 'fkr-muted' },
              Math.min(progress.step + 1, progress.STEPS.length) + '/' + progress.STEPS.length)),
          React.createElement('div', { className: 'fkr-bar', style: { marginTop: 8 } },
            React.createElement('i', {
              style: { width: Math.round((progress.step / progress.STEPS.length) * 100) + '%' },
            })),
          React.createElement('div', { className: 'fkr-muted', style: { marginTop: 6 } },
            progress.STEPS[Math.min(progress.step, progress.STEPS.length - 1)])) : null

        // ── Tab 切换（决定 45：快照 / 体检问题 / 溯源 / 设置）──
        const tabs = React.createElement('div', { style: { display: 'flex', gap: 6 } },
          ['snapshots', 'issues', 'trace', 'settings'].map((k) => {
            // ⚠️ 只数「真问题 + 提示」，不数正常状态
            //    （否则用户会看到一个吓人的数字，点进去发现全是「无需处理」）
            const realIssueCount = (c.problems || []).length + (c.notices || []).length
            const label = {
              snapshots: '快照 (' + entries.length + ')',
              issues: '体检问题' + (realIssueCount > 0 ? ' (' + realIssueCount + ')' : ''),
              trace: '改动溯源',
              settings: '设置',
            }[k]
            return React.createElement('button', {
              key: k,
              className: 'fkr-btn' + (tab === k ? ' fkr-btn-primary' : ''),
              onClick: () => setTab(k),
            }, label)
          }))

        const listEl = tab === 'snapshots' ? React.createElement(SnapshotsPane, {
          entries, total: d.total, policy: d.policy, busy, selected, setSelected,
          onRestore: openRestore,
          onRefresh: refresh,
          onMsg: setMsg,
          fixed: d.fixed,                       // ⭐ 当前 .bat 固化的那份
          batPath: d.paths?.batPath ?? null,    // ⭐ .bat 脚本路径
        }) : null

        const settingsEl = tab === 'settings' ? React.createElement(SettingsPane, {
          policy: d.policy, onMsg: setMsg, onRefresh: refresh, pendingRestart: d.pendingRestart,
          rolledBackAt: d.rolledBackAt, dir: d.dir,
        }) : null

        // ── 体检问题（§2.16b：每条可「确认可接受」）──
        const ACTIVE = (c.issues || []).filter((x) => !x.acknowledged)
        const ACKED = (c.issues || []).filter((x) => x.acknowledged)
        const issuesEl = tab === 'issues' ? React.createElement(IssuesPane, {
          verdict: c.verdict,
          problems: c.problems || [],
          notices: c.notices || [],
          normal: c.normal || [],
          acknowledged: c.acknowledged || [],
          counts: c.counts || {},
          onMsg: setMsg, onRefresh: refresh, onTrace: (f) => { setTab('trace'); setTraceFile(f) },
        }) : null

        // ── 溯源 ──
        const traceEl = tab === 'trace' ? React.createElement(TracePane, null) : null

        // ── 弹窗：创建快照 ──
        const snapModal = showSnap ? React.createElement('div', {
          className: 'fkr-mask',
          onClick: (ev) => { if (ev.target === ev.currentTarget) setShowSnap(false) },
        }, React.createElement('div', { className: 'fkr-modal' },
          React.createElement('div', { className: 'fkr-title', style: { marginBottom: 12 } }, '创建快照'),
          React.createElement('div', { className: 'fkr-muted' }, '名称（可留空）'),
          React.createElement('input', {
            className: 'fkr-input',
            value: snapName,
            placeholder: '例：装插件前',
            onChange: (ev) => setSnapName(ev.target.value),
          }),
          React.createElement('div', { className: 'fkr-muted', style: { marginTop: 10 } }, '备注（可留空）'),
          React.createElement('textarea', {
            className: 'fkr-input',
            rows: 3,
            value: snapNote,
            placeholder: '例：刚更新了 search-tier',
            onChange: (ev) => setSnapNote(ev.target.value),
          }),
          dupInfo ? React.createElement('div', {
            className: 'fkr-alert',
            style: { color: 'var(--dsw-alias-state-warning-primary,#e65100)', marginTop: 12 },
          },
          '⚠️ ' + dupInfo.message,
          React.createElement('br'),
          '最新快照：' + (dupInfo.latestName || '?') + '（' + absTime(dupInfo.latestAt) + '）')
            : null,
          React.createElement('div', { style: { marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            React.createElement('button', { className: 'fkr-btn', onClick: () => { setShowSnap(false); setDupInfo(null) }, disabled: !!busy }, '取消'),
            React.createElement('button', {
              className: 'fkr-btn fkr-btn-primary',
              onClick: () => doSnapshot(Boolean(dupInfo)),
              disabled: !!busy,
            }, busy === 'snapshot' ? '创建中…' : (dupInfo ? '仍要创建' : '创建'))))) : null

        // ── 弹窗：回滚确认（决定 23/26/27 + 四分区清单）──
        // ⚠️ target 必须在这里定义：下面弹窗要读它的名称与时间。
        // 之前重写弹窗时把这段删了，导致点击「回滚」后整个面板白屏（ReferenceError）。
        const target = selected ? entries.find((x) => x.id === selected) : null
        const plan = dryPlan || null
        const restoreModal = showRestore ? React.createElement('div', {
          className: 'fkr-mask',
          onClick: (ev) => { if (ev.target === ev.currentTarget) setShowRestore(false) },
        }, React.createElement('div', { className: 'fkr-modal' },
          React.createElement('div', { className: 'fkr-title', style: { marginBottom: 6 } }, '⚠️ 确认回滚'),
          React.createElement('div', { className: 'fkr-alert', style: { color: 'var(--dsw-alias-state-warning-primary,#e65100)', marginBottom: 12 } },
            '回滚是「全有或全无」的：无法只退回某一个插件。',
            React.createElement('br'),
            '目标快照之后的其它配置改动也会一并丢失。'),

          React.createElement('div', { className: 'fkr-muted' }, '目标快照'),
          React.createElement('div', { style: { marginBottom: 10 } },
            target ? (target.name || target.id) + '（' + absTime(target.createdAtMs) + '）' : '自动选择最佳快照'),

          plan ? React.createElement('div', { style: { marginTop: 4 } },
            React.createElement('div', { className: 'fkr-part' },
              React.createElement('div', { className: 'fkr-partTitle', style: { color: 'var(--dsw-alias-state-error-primary,#c62828)' } },
                '① 将被移除（' + (plan.removed || []).length + '）'),
              (plan.removed || []).length === 0
                ? React.createElement('div', { className: 'fkr-partItem' }, '（无）')
                : React.createElement('div', { className: 'fkr-scroll' },
                  plan.removed.slice(0, 20).map((x, i) => React.createElement('div', { key: i, className: 'fkr-partItem' },
                    '✗ ' + x.name + (x.inferredAt ? '（' + x.inferredAt + '）' : ''))))),
            (plan.selfRemoved || []).length > 0
              ? React.createElement('div', {
                className: 'fkr-alert',
                style: { color: 'var(--dsw-alias-state-error-primary,#c62828)', margin: '8px 0' },
              },
              '🔴 以下插件是本工具自身的一部分：' + (plan.selfRemoved || []).join('、'),
              React.createElement('br'),
              '回滚并重启后：快照面板会消失、「立即重启」按钮会失效。',
              React.createElement('br'),
              '后续请用「还原DSH配置.bat」或命令行继续操作。')
              : null,
            React.createElement('div', { className: 'fkr-part' },
              React.createElement('div', { className: 'fkr-partTitle', style: { color: 'var(--dsw-alias-state-success-primary,#2e7d32)' } },
                '② 将被恢复（' + (plan.added || []).length + '）'),
              (plan.added || []).length === 0
                ? React.createElement('div', { className: 'fkr-partItem' }, '（无）')
                : React.createElement('div', { className: 'fkr-scroll' },
                  plan.added.slice(0, 20).map((n, i) => React.createElement('div', { key: i, className: 'fkr-partItem' }, '✓ ' + n)))),
            React.createElement('div', { className: 'fkr-part' },
              React.createElement('div', { className: 'fkr-partTitle' }, '③ 保持不变（' + (plan.keptCount || 0) + '）'),
              React.createElement('div', { className: 'fkr-partItem' }, '两边都有的插件不动')),
            React.createElement('div', { className: 'fkr-part' },
              React.createElement('div', { className: 'fkr-partTitle', style: { color: 'var(--dsw-alias-label-tertiary,inherit)' } }, '④ 完全不受影响'),
              (plan.unaffected || []).map((n, i) => React.createElement('div', { key: i, className: 'fkr-partItem' }, '· ' + n))))
            : React.createElement('div', { className: 'fkr-muted' }, '（正在计算影响范围…）'),

          // ⚠️ 说清「怎么重启」—— DSH 是 Electron 桌面端，F5/Ctrl+R 不会重新加载，
          //    必须用重启插件（侧边栏底部）或改完配置后关掉窗口重开。
          React.createElement('div', { className: 'fkr-muted', style: { marginTop: 10 } },
            '回滚后需要重启 DSH 才会生效。'),
          React.createElement('div', { style: { marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            React.createElement('button', { className: 'fkr-btn', onClick: () => setShowRestore(false), disabled: !!busy }, '取消'),
            React.createElement('button', {
              className: 'fkr-btn fkr-btn-danger',
              onClick: () => doRestore(target ? target.id : null),
              disabled: !!busy,
            }, busy === 'restore' ? '还原中…' : '确认回滚')))) : null

        return React.createElement('div', { className: 'fkr-wrap' },
          // ⚠️ 2026-10-20 UI 重设计：statusRow（含体检结论 + .bat 卡片）
          //   只在「快照」tab 显示 —— 否则体检页会同时出现两次「一切正常」
          //   （顶部管理面板一次 + 体检页自己一次）。
          tab === 'snapshots' ? statusRow : null,
          bannerEl, msgEl, progEl, resultEl, tabs,
          listEl, issuesEl, settingsEl, traceEl,
          React.createElement('div', { className: 'fkr-muted', style: { fontSize: 11 } },
            '快照目录：' + (d.dir || '?')),
          d.paths?.pluginDir
            ? React.createElement('div', { className: 'fkr-muted', style: { fontSize: 11 } },
              '脚本目录：' + d.paths.pluginDir)
            : null,
          snapModal, restoreModal)
      }

      // ───────────────────────────────────────────────────────
      // 快照列表（搜索 / 筛选 / 分页 / 折叠 / ● / 重命名 / 删除 / 导出）
      // ───────────────────────────────────────────────────────

      const PAGE_SIZE = 10            // 决定 14：10 条/页

      function SnapshotsPane(props) {
        const { entries, total, busy, selected, setSelected, onRestore, onRefresh, onMsg } = props
        const fixed = props.fixed || null
        const batPath = props.batPath || null
        const [fixing, setFixing] = React.useState(null)

        /** 当前 .bat 固化的是哪个快照 id */
        const fixedFromId = fixed?.meta?.fromId ?? null

        /** 把某个快照设为 .bat 默认（固化） */
        async function doFix(e) {
          setFixing(e.id)
          const r = await api('/fix', { method: 'POST', body: JSON.stringify({ id: e.id }) })
          setFixing(null)
          if (r.error) { onMsg({ kind: 'err', text: '设置失败：' + r.error }); return }
          onMsg({ kind: 'ok', text: `已设为 .bat 默认：${r.fromName}（${r.files}/5 文件，${Math.round(r.bytes/1024)} KB）` })
          await onRefresh()
        }

        /** 取消固化（.bat 将没有数据源，直到下次启动重新自动固化） */
        async function doUnfix() {
          setFixing('__unfix__')
          const r = await api('/fix', { method: 'POST', body: JSON.stringify({ remove: true }) })
          setFixing(null)
          if (r.error) { onMsg({ kind: 'err', text: '取消失败：' + r.error }); return }
          onMsg({ kind: 'ok', text: '已取消固化 —— .bat 暂时不可用，下次启动会自动重新固化当天 daily' })
          await onRefresh()
        }
        const [q, setQ] = React.useState('')
        const [filter, setFilter] = React.useState('all')
        // ⭐ 每组独立的「已显示条数」（2026-10-21 替代跨组翻页）
        //
        // 原来用 page/pageItems 跨组翻页，导致「今天 13 项把第 1 页占满，
        // 昨天显示 2 项但一条都渲染不出来」。
        // 现在每组自己有可见条数，点「显示更多」往上加。
        const [visibleCount, setVisibleCount] = React.useState({})
        // ⭐ 分组折叠状态（2026-10-21 用户要求：今天/昨天等栏也要能折叠）
        //
        // 用一个对象管所有分组，避免每加一个分组就要多一个 useState。
        // 默认值：今天=展开、昨天=展开、更早=折叠、回滚记录=折叠
        const [groupOpen, setGroupOpen] = React.useState({
          today: true,
          yesterday: true,
          earlier: false,
          restore: false,
        })
        const isOpen = (key) => groupOpen[key] !== false
        const toggleGroup = (key) => setGroupOpen((s) => ({ ...s, [key]: !(s[key] !== false) }))
        const [editing, setEditing] = React.useState(null)
        const [editName, setEditName] = React.useState('')
        const [editNote, setEditNote] = React.useState('')
        const [delTarget, setDelTarget] = React.useState(null)

        const matched = entries.filter((e) => {
          // 支持两种筛选：类型（daily/manual/...）与来源（__origin_auto/ai/user）
          if (filter !== 'all') {
            if (filter.startsWith('__origin_')) {
              if ((e.origin || 'user') !== filter.slice(9)) return false
            } else if (e.type !== filter) {
              return false
            }
          }
          if (!q.trim()) return true
          const needle = q.trim().toLowerCase()
          return String(e.name || '').toLowerCase().includes(needle)
            || String(e.note || '').toLowerCase().includes(needle)
        }).sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))

        // ── 时间分组（2026-10-20 UI 重设计）──
        //   原来按类型分（每日/手动/滚动），用户要「回到某个时间点」时
        //   得先想「这是哪种类型」，不符合直觉。
        //   改为：今天 / 昨天 / 更早。
        // ⚠️ 2026-10-20 用户要求：「回滚后会生成一个回滚前的快照，
        //    建议把这一栏单独存放，并且说明是某某时间段的回滚」
        //
        //   所以回滚前快照【不参与时间分组】，单独作为一个「回滚记录」组，
        //   放在列表最前面（它是最特殊的：记录的是「被替换掉的现场」）。
        const restorePoints = matched.filter((e) => e.type === 'before-restore')
        const normal = matched.filter((e) => e.type !== 'before-restore')

        const buckets = { today: [], yesterday: [], earlier: [] }
        for (const e of normal) {
          const g = groupOf(e.createdAtMs)
          if (buckets[g.key]) buckets[g.key].push(e)
        }
        const timeGroups = [
          { key: 'today', label: '今天', items: buckets.today, defaultOpen: true },
          { key: 'yesterday', label: '昨天', items: buckets.yesterday, defaultOpen: true },
          { key: 'earlier', label: '更早', items: buckets.earlier, defaultOpen: false },
        ].filter((g) => g.items.length > 0)

        // 「回滚记录」组：单独渲染，不走时间分组
        const restoreGroup = restorePoints.length > 0
          ? { key: 'restore', label: '回滚记录', items: restorePoints }
          : null

        const groups = restoreGroup ? [restoreGroup, ...timeGroups] : timeGroups

        // 每组默认显示多少条（超出时给「显示更多」）
        const GROUP_PAGE = 10

        // 取某组当前该显示多少条
        const shownOf = (key, total) => {
          const want = visibleCount[key] ?? GROUP_PAGE
          return Math.min(want, total)
        }

        async function doRename() {
          const r = await api('/rename', {
            method: 'POST',
            body: JSON.stringify({ id: editing, name: editName, note: editNote }),
          })
          if (r.error) { onMsg({ kind: 'err', text: r.error }); return }
          onMsg({ kind: 'ok', text: '已保存' })
          setEditing(null)
          await onRefresh()
        }

        async function doDelete(force) {
          const r = await api('/delete', {
            method: 'POST',
            body: JSON.stringify({ id: delTarget.id, confirmed: true, force: !!force }),
          })
          if (r.error) {
            if (r.needsForce) { setDelTarget(Object.assign({}, delTarget, { needsForce: true })); return }
            onMsg({ kind: 'err', text: r.error }); setDelTarget(null); return
          }
          onMsg({ kind: 'ok', text: '已删除' })
          setDelTarget(null)
          await onRefresh()
        }

        async function doExport(e) {
          const r = await api('/export', { method: 'POST', body: JSON.stringify({ id: e.id }) })
          if (r.error) { onMsg({ kind: 'err', text: '导出失败：' + r.error }); return }
          onMsg({ kind: 'ok', text: '已导出到：' + r.dest })
        }

        /** 单个快照条目：双行紧凑，点击展开操作区 */
        function renderRow(e) {
          const gi = GRADE_INFO[e.grade] || GRADE_INFO['static-ok']
          const ti = TYPE_INFO[e.type] || TYPE_INFO.manual
          const oi = ORIGIN_INFO[e.origin] || ORIGIN_INFO.user
          const sel = selected === e.id
          const canRename = e.type !== 'daily'
          const isBat = fixedFromId === e.id

          // ── 主行：● 图标 名称 …… 星级 大小 🔒 ──
          const mainRow = React.createElement('div', { className: 'fkr-lineMain' },
            e.isCurrent
              ? React.createElement('span', { className: 'fkr-dot', title: '当前配置状态' })
              : React.createElement('span', { style: { width: 7, flex: 'none' } }),
            React.createElement('span', { className: 'fkr-icon', style: { width: 16 }, title: ti.label }, ti.icon),
            React.createElement('span', { className: 'fkr-lineName', title: e.name || e.id }, e.name || e.id),
            React.createElement('span', { className: 'fkr-stars', style: { color: gi.color, flex: 'none' }, title: gi.text }, gi.stars),
            React.createElement('span', { className: 'fkr-lineSize' }, Math.round((e.size || 0) / 1024) + ' KB'),
            isBat
              ? React.createElement('span', {
                className: 'fkr-lock',
                title: '.bat 紧急救场使用这一份',
                style: { color: 'var(--dsw-alias-state-success-primary,#2e7d32)' },
              }, '🔒')
              : null)

          // ── 副行：时间 · 来源 （回滚记录额外显示「回滚到哪份」）──
          //    2026-10-20 用户要求：「说明是某某时间段的回滚」
          const isRestorePoint = e.type === 'before-restore'
          const ri = e.restoreInfo || null
          const subRow = React.createElement('div', { className: 'fkr-lineSub' },
            React.createElement('span', null, shortTime(e.createdAtMs)),
            React.createElement('span', null, '·'),
            React.createElement('span', { style: { color: oi.color }, title: oi.title }, oi.label),
            isRestorePoint && ri
              ? React.createElement('span', {
                style: { color: 'var(--dsw-alias-state-warning-primary,#e65100)' },
                title: '这次回滚之前的状态（被替换掉的现场）',
              }, '· 回滚到「' + (ri.targetName || '?') + '」前')
              : (e.note ? React.createElement('span', { style: { opacity: .85 } }, '· ' + e.note) : null))

          // ── 展开区（选中后出现）──
          const expand = sel
            ? React.createElement('div', { className: 'fkr-expand' },
              React.createElement('div', { className: 'fkr-kv' },
                React.createElement('span', { className: 'fkr-kvKey' }, '健康'),
                React.createElement('span', { className: 'fkr-kvVal' },
                  gi.text + '（' + gi.stars + '）')),
              React.createElement('div', { className: 'fkr-kv' },
                React.createElement('span', { className: 'fkr-kvKey' }, '时间'),
                React.createElement('span', { className: 'fkr-kvVal' }, absTime(e.createdAtMs))),
              React.createElement('div', { className: 'fkr-kv' },
                React.createElement('span', { className: 'fkr-kvKey' }, '来源'),
                React.createElement('span', { className: 'fkr-kvVal' },
                  oi.label + (e.sessionId ? '（会话 ' + String(e.sessionId).slice(-8) + '）' : ''))),
              React.createElement('div', { className: 'fkr-kv' },
                React.createElement('span', { className: 'fkr-kvKey' }, 'id'),
                React.createElement('span', { className: 'fkr-kvVal' }, e.id)),
              e.fingerprint
                ? React.createElement('div', { className: 'fkr-kv' },
                  React.createElement('span', { className: 'fkr-kvKey' }, '指纹'),
                  React.createElement('span', { className: 'fkr-kvVal' }, String(e.fingerprint).slice(0, 16) + '…'))
                : null,
              React.createElement('div', { className: 'fkr-expandBtns' },
                React.createElement('button', {
                  className: 'fkr-btn fkr-btn-danger',
                  disabled: !!busy || e.isCurrent,
                  title: e.isCurrent ? '当前已在此状态' : '回滚到此快照',
                  onClick: (ev) => { ev.stopPropagation(); onRestore(e.id) },
                }, '回滚到此'),
                isBat
                  ? React.createElement('button', {
                    className: 'fkr-btn', disabled: true, title: '这份已经是 .bat 数据源',
                  }, '已是 .bat')
                  : React.createElement('button', {
                    className: 'fkr-btn',
                    disabled: !!fixing,
                    title: '把这份快照做成 .bat 的固定数据源（不受快照池清理影响）',
                    onClick: (ev) => { ev.stopPropagation(); doFix(e) },
                  }, fixing === e.id ? '设置中…' : '设为 .bat'),
                canRename
                  ? React.createElement('button', {
                    className: 'fkr-btn',
                    onClick: (ev) => {
                      ev.stopPropagation()
                      setEditing(e.id); setEditName(e.name || ''); setEditNote(e.note || '')
                    },
                  }, '重命名')
                  : React.createElement('button', {
                    className: 'fkr-btn', disabled: true, title: '每日快照不可重命名（名字由日期决定）',
                  }, '重命名'),
                React.createElement('button', {
                  className: 'fkr-btn',
                  onClick: (ev) => { ev.stopPropagation(); doExport(e) },
                }, '导出'),
                React.createElement('button', {
                  className: 'fkr-btn',
                  onClick: (ev) => { ev.stopPropagation(); setDelTarget(e) },
                }, '删除')))
            : null

          return React.createElement('div', { key: e.id },
            React.createElement('div', {
              className: 'fkr-line' + (sel ? ' fkr-lineSel' : ''),
              onClick: () => setSelected(sel ? null : e.id),
              title: sel ? '点击收起' : '点击展开操作',
            }, mainRow, subRow),
            expand)
        }

        /** 渲染一个分组（今天 / 昨天 / 更早 / 回滚记录）—— 全部可折叠 */
        const renderGroup = (g) => {
          const isRestore = g.key === 'restore'
          const open = isOpen(g.key)

          // 数据：直接取本组自己的全部条目，按「已显示条数」切片
          //   （不再从 pageItems 里筛 —— 那正是「显示 2 项却空」的根因）
          const total = g.items.length
          const shown = open ? shownOf(g.key, total) : 0
          const items = open ? g.items.slice(0, shown) : []
          const hasMore = open && total > shown
          const count = total

          return React.createElement('div', { key: g.key, style: { marginBottom: 4 } },
            // 分组头：整行可点，箭头指示状态
            React.createElement('div', {
              className: 'fkr-group',
              style: { cursor: 'pointer', userSelect: 'none' },
              onClick: () => toggleGroup(g.key),
              title: open ? '点击折叠' : '点击展开',
            },
            React.createElement('span', null,
              (open ? '▾ ' : '▸ ') + g.label
              + (isRestore ? '（每次回滚前的现场）' : '')),
            React.createElement('span', { className: 'fkr-groupCount' },
              count + ' 项' + (open ? '' : ' · 已折叠'))),
            items.length > 0
              ? React.createElement('div', { className: 'fkr-list', style: { maxHeight: 'none', overflow: 'visible' } },
                items.map(renderRow))
              : null,
            // 「显示更多」：只影响本组，不再跨组翻页
            hasMore
              ? React.createElement('div', { style: { paddingLeft: 25, paddingTop: 4 } },
                React.createElement('button', {
                  className: 'fkr-btn',
                  style: { fontSize: 11 },
                  onClick: () => setVisibleCount((s) => ({ ...s, [g.key]: shown + GROUP_PAGE })),
                }, '显示更多（还有 ' + (total - shown) + ' 项）'))
              : null)
        }

        // 空状态引导（设计方案 §2.8：必须列出 5 个文件 + 建议 + 按钮）
        const SNAPSHOT_FILES_DOC = [
          'package.json',
          'cordis.patch.yml',
          'pnpm-lock.yaml',
          'pnpm-workspace.yaml',
          'compatibility.json',
        ]
        const emptyEl = entries.length === 0
          ? React.createElement('div', { style: { padding: '20px 8px', textAlign: 'center' } },
            React.createElement('div', { className: 'fkr-title', style: { marginBottom: 6 } }, '还没有任何快照'),
            React.createElement('div', { className: 'fkr-muted', style: { marginBottom: 10 } },
              '快照会保存 DSH 的 5 个配置文件：'),
            React.createElement('div', {
              style: {
                display: 'inline-block', textAlign: 'left', fontSize: 12,
                padding: '8px 14px', borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))',
                marginBottom: 12,
              },
            },
            SNAPSHOT_FILES_DOC.map((f, i) => React.createElement('div', {
              key: i, style: { fontFamily: 'monospace', lineHeight: 1.8 },
            }, f))),
            React.createElement('div', { className: 'fkr-muted', style: { marginBottom: 12 } },
              '建议在「装插件前」「改配置前」各做一次。'),
            React.createElement('button', {
              className: 'fkr-btn fkr-btn-primary',
              onClick: () => setShowSnap(true),
            }, '创建第一个快照'))
          : null

        return React.createElement('div', { className: 'fkr-card' },
          React.createElement('div', { className: 'fkr-row', style: { marginBottom: 10 } },
            React.createElement('div', { className: 'fkr-title' }, '快照列表'),
            React.createElement('span', { className: 'fkr-muted' },
              '共 ' + entries.length + ' 个 · ' + (total / 1024).toFixed(0) + ' KB · 上限 ' + ((props.policy || {}).maxCheckpoints || 50))),

          React.createElement('div', { className: 'fkr-toolbar' },
            React.createElement('input', {
              className: 'fkr-input fkr-search',
              placeholder: '搜索名称或备注…',
              value: q,
              onChange: (ev) => { setQ(ev.target.value); setVisibleCount({}) },
            }),
            React.createElement('select', {
              className: 'fkr-select', value: filter,
              onChange: (ev) => { setFilter(ev.target.value); setVisibleCount({}) },
            },
            React.createElement('option', { value: 'all' }, '全部类型'),
            React.createElement('option', { value: '__origin_auto' }, '只看自动创建'),
            React.createElement('option', { value: '__origin_ai' }, '只看 AI 创建'),
            React.createElement('option', { value: '__origin_user' }, '只看手动创建'),
            React.createElement('option', { value: 'daily' }, '每日'),
            React.createElement('option', { value: 'manual' }, '手动'),
            React.createElement('option', { value: 'rolling' }, '滚动'),
            React.createElement('option', { value: 'before-restore' }, '回滚前'))),

          // ⚠️ .bat 状态条已移到「快照管理」面板（2026-10-20 用户要求：
          //    「这个 .bat 状态条放置在快照管理 UI 面板中，不要占用快照列表」）

          emptyEl,
          (entries.length > 0 && matched.length === 0)
            ? React.createElement('div', { className: 'fkr-muted', style: { padding: '14px 0', textAlign: 'center' } },
              '没有匹配的快照')
            : null,

          // ── 时间分组列表（今天 / 昨天 / 更早）──
          groups.map(renderGroup),

          // （跨组翻页已移除 —— 每组自带「显示更多」）

          editing ? React.createElement('div', {
            className: 'fkr-mask', onClick: (ev) => { if (ev.target === ev.currentTarget) setEditing(null) },
          }, React.createElement('div', { className: 'fkr-modal' },
            React.createElement('div', { className: 'fkr-title', style: { marginBottom: 12 } }, '重命名 / 备注'),
            React.createElement('div', { className: 'fkr-muted' }, '名称（最多 50 字）'),
            React.createElement('input', {
              className: 'fkr-input', value: editName, maxLength: 50,
              onChange: (ev) => setEditName(ev.target.value),
            }),
            React.createElement('div', { className: 'fkr-muted', style: { marginTop: 10 } }, '备注（最多 500 字）'),
            React.createElement('textarea', {
              className: 'fkr-input', rows: 3, value: editNote, maxLength: 500,
              onChange: (ev) => setEditNote(ev.target.value),
            }),
            React.createElement('div', { style: { marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              React.createElement('button', { className: 'fkr-btn', onClick: () => setEditing(null) }, '取消'),
              React.createElement('button', { className: 'fkr-btn fkr-btn-primary', onClick: doRename }, '保存')))) : null,

          delTarget ? React.createElement('div', {
            className: 'fkr-mask', onClick: (ev) => { if (ev.target === ev.currentTarget) setDelTarget(null) },
          }, React.createElement('div', { className: 'fkr-modal' },
            React.createElement('div', { className: 'fkr-title', style: { marginBottom: 8 } }, '删除快照'),
            React.createElement('div', { style: { marginBottom: 10 } }, delTarget.name || delTarget.id),
            (delTarget.needsForce || delTarget.isCurrent)
              ? React.createElement('div', {
                className: 'fkr-alert',
                style: { color: 'var(--dsw-alias-state-error-primary,#c62828)', marginBottom: 12 },
              },
              '⚠️ 这是「当前配置状态」的快照。删除它会失去「回到现在」的还原点。',
              React.createElement('br'), '确定要删吗？')
              : React.createElement('div', { className: 'fkr-muted', style: { marginBottom: 12 } }, '删除后不可恢复。'),
            React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              React.createElement('button', { className: 'fkr-btn', onClick: () => setDelTarget(null) }, '取消'),
              React.createElement('button', {
                className: 'fkr-btn fkr-btn-danger',
                onClick: () => doDelete(delTarget.needsForce || delTarget.isCurrent),
              }, '确认删除')))) : null)
      }


      // ───────────────────────────────────────────────────────
      // 体检问题（2026-10-19 重做：三层分级 + 一句话结论）
      // ───────────────────────────────────────────────────────
      //
      // 用户质问：「一个普通用户怎么分辨出来问题？」
      // 答案：不该由他分辨 —— 插件必须把「正常」和「有问题」分开。
      //
      //   ① 真问题（红/橙）→ 显示，要处理
      //   ② 提示（黄）     → 显示，可稍后
      //   ③ 正常状态       → 默认完全隐藏，并说明「这些不用管」
      //

      function IssuesPane(props) {
        const { verdict, problems, notices, normal, acknowledged, counts,
                onMsg, onRefresh, onTrace } = props
        const [ackTarget, setAckTarget] = React.useState(null)
        const [reason, setReason] = React.useState('')
        const [showNormal, setShowNormal] = React.useState(false)
        const [showAcked, setShowAcked] = React.useState(false)
        const [showLedger, setShowLedger] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        // ⚠️ 2026-10-20 用户反馈「点重新体检没反应」：
        //   按钮确实会重跑体检（约 100 ms），但——
        //     ① 没有 loading 状态
        //     ② 按钮不禁用
        //     ③ 结果没变化时界面毫无变化
        //     ④ 完成没有任何提示
        //   → 用户以为按钮坏了。这里补上完整反馈。
        const [checking, setChecking] = React.useState(false)
        const [lastChecked, setLastChecked] = React.useState(null)

        const totalReal = problems.length + notices.length

        /** 重新体检：显示「体检中…」→ 完成后提示更新时间 */
        async function doRecheck() {
          if (checking) return
          setChecking(true)
          try {
            await onRefresh()
            setLastChecked(Date.now())
          } catch (e) {
            onMsg({ kind: 'err', text: '体检失败：' + String(e && e.message ? e.message : e) })
          } finally {
            setChecking(false)
          }
        }

        async function doAck(remove) {
          setBusy(true)
          const t = ackTarget
          const r = await api('/acknowledge', {
            method: 'POST',
            body: JSON.stringify({
              code: t.code, package: t.package, entryId: t.entryId, file: t.file,
              reason: reason || undefined, remove: Boolean(remove),
            }),
          })
          setBusy(false)
          if (r.error) { onMsg({ kind: 'err', text: r.error }); return }
          onMsg({ kind: 'ok', text: remove ? '已取消确认' : '已确认可接受' })
          setAckTarget(null); setReason('')
          await onRefresh()
        }

        function renderIssue(it, i, opts) {
          const o = opts || {}
          const si = SEVERITY_INFO[it.severity] || SEVERITY_INFO.info
          return React.createElement('div', {
            key: i,
            className: 'fkr-issue',
            style: { flexDirection: 'column', gap: 4, opacity: o.dim ? 0.72 : 1 },
          },
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
            React.createElement('span', { style: { color: si.color, flex: 'none' } }, si.icon),
            React.createElement('div', { className: 'fkr-main' },
              React.createElement('div', { style: { lineHeight: 1.6 } }, it.message),
              React.createElement('div', { className: 'fkr-muted', style: { fontSize: 11, marginTop: 2 } },
                '码：' + it.code + (it.file ? ' · ' + it.file : '')),
              it.hint
                ? React.createElement('div', { style: { fontSize: 11, marginTop: 3, color: 'var(--dsw-alias-state-business-primary,#2b6cb0)' } },
                  '💡 ' + it.hint)
                : null,
              o.acked
                ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-success-primary,#2e7d32)', marginTop: 3 } },
                  '✓ 已确认可接受 · 理由：' + (it.ackReason || '(无)'))
                : null,
              o.expired
                ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warning-primary,#e65100)', marginTop: 3 } },
                  '⚠ 之前确认过，但相关文件已变化，需重新确认')
                : null,
              // 真问题带「查改动」入口（§2.4 / 模块三联动）
              (o.action && it.file)
                ? React.createElement('div', { style: { marginTop: 5 } },
                  React.createElement('button', {
                    className: 'fkr-btn', style: { fontSize: 11, padding: '2px 8px' },
                    onClick: () => onTrace(it.file),
                  }, '查改动'))
                : null),
            o.action
              ? React.createElement('button', {
                className: 'fkr-btn', style: { flex: 'none', fontSize: 11 },
                onClick: () => { setAckTarget(it); setReason('') },
              }, '确认可接受')
              : null))
        }

        return React.createElement('div', { className: 'fkr-wrap' },

          // ── 一句话结论（普通用户只看这块）──
          React.createElement('div', {
            className: 'fkr-card',
            style: {
              borderColor: totalReal > 0
                ? 'var(--dsw-alias-state-warning-primary,#e65100)'
                : 'var(--dsw-alias-state-success-primary,#2e7d32)',
            },
          },
          React.createElement('div', { className: 'fkr-row' },
            React.createElement('div', { className: 'fkr-title' },
              totalReal > 0 ? '⚠️ ' : '✅ ', String(verdict || '一切正常')),
            // ⚠️ 「重新体检」必须永远可见（2026-10-19 用户指出）
            //    2026-10-20 补：点击后要有反馈（禁用 + 「体检中…」）
            //    2026-10-20 UI 重设计：体检时间移到按钮左侧，不再单独占一行
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              lastChecked
                ? React.createElement('span', {
                  className: 'fkr-muted', style: { fontSize: 11 },
                }, '上次 ' + new Date(lastChecked).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
                : null,
              React.createElement('button', {
                className: 'fkr-btn',
                onClick: doRecheck,
                disabled: checking,
                style: { fontSize: 11, minWidth: 76 },
              }, checking ? '体检中…' : '重新体检'))),
          // 统计行：只说数量，不再重复「一切正常」
          React.createElement('div', { className: 'fkr-muted', style: { marginTop: 6, fontSize: 12 } },
            '真问题 ' + problems.length
            + ' · 提示 ' + notices.length
            + ' · 正常状态 ' + normal.length
            + (acknowledged.length > 0 ? ' · 已确认 ' + acknowledged.length : '')),

          // ── 真问题 ──
          problems.length > 0
            ? React.createElement('div', { className: 'fkr-card' },
              React.createElement('div', { className: 'fkr-title', style: { marginBottom: 8, fontSize: 13 } },
                '需要处理（' + problems.length + '）'),
              problems.map((it, i) => renderIssue(it, i, { action: true })))
            : null,

          // ── 提示 ──
          notices.length > 0
            ? React.createElement('div', { className: 'fkr-card' },
              React.createElement('div', { className: 'fkr-title', style: { marginBottom: 8, fontSize: 13 } },
                '提示（' + notices.length + '）· 一般不影响使用'),
              notices.map((it, i) => renderIssue(it, i, { action: true })))
            : null,

          // ── 正常状态：默认完全隐藏 ──
          normal.length > 0
            ? React.createElement('div', { className: 'fkr-fold' },
              React.createElement('div', {
                className: 'fkr-foldHead', onClick: () => setShowNormal(!showNormal),
              },
              React.createElement('span', null,
                (showNormal ? '▾ ' : '▸ ') + '正常状态（' + normal.length + '）· 无需处理'),
              React.createElement('span', { className: 'fkr-muted' }, showNormal ? '收起' : '展开')),
              showNormal
                ? React.createElement('div', { className: 'fkr-foldBody' },
                  React.createElement('div', { className: 'fkr-muted', style: { fontSize: 11, marginBottom: 8 } },
                    '以下都是 DSH 的正常形态（不是问题）。列在这里只是让你知道它们被检查过了：'),
                  normal.map((it, i) => renderIssue(it, i, { dim: true })))
                : null)
            : null,

          // ── 已确认可接受 ──
          acknowledged.length > 0
            ? React.createElement('div', { className: 'fkr-fold' },
              React.createElement('div', {
                className: 'fkr-foldHead', onClick: () => setShowAcked(!showAcked),
              },
              React.createElement('span', null,
                (showAcked ? '▾ ' : '▸ ') + '已确认可接受（' + acknowledged.length + '）'),
              React.createElement('button', {
                className: 'fkr-btn', style: { fontSize: 11, padding: '1px 8px' },
                onClick: (ev) => { ev.stopPropagation(); setShowLedger(true) },
              }, '管理')),
              showAcked
                ? React.createElement('div', { className: 'fkr-foldBody' },
                  acknowledged.map((it, i) => renderIssue(it, i, { acked: true, dim: true })))
                : null)
            : null,

          // ── 确认对话框 ──
          ackTarget
            ? React.createElement('div', {
              className: 'fkr-mask',
              onClick: (ev) => { if (ev.target === ev.currentTarget) setAckTarget(null) },
            },
            React.createElement('div', { className: 'fkr-modal' },
              React.createElement('div', { className: 'fkr-title', style: { marginBottom: 8 } },
                ackTarget.acknowledged ? '取消确认' : '确认可接受'),
              React.createElement('div', { className: 'fkr-muted', style: { marginBottom: 4 } },
                '问题：' + ackTarget.code),
              ackTarget.package
                ? React.createElement('div', { className: 'fkr-muted', style: { marginBottom: 10 } },
                  '包：' + ackTarget.package)
                : null,
              ackTarget.acknowledged
                ? React.createElement('div', { className: 'fkr-muted', style: { marginBottom: 12 } },
                  '取消后，这条会重新计入体检结果。')
                : React.createElement('div', null,
                  React.createElement('div', { className: 'fkr-muted' }, '请填写理由（会保存，便于日后回看）：'),
                  React.createElement('input', {
                    className: 'fkr-input', value: reason, maxLength: 200,
                    placeholder: '例：已用 allow-version 豁免，能正常跑',
                    onChange: (ev) => setReason(ev.target.value),
                  }),
                  React.createElement('div', { className: 'fkr-muted', style: { marginTop: 8, fontSize: 11 } },
                    'ⓘ 若相关文件内容变化，此确认会自动失效'))),
              React.createElement('div', { style: { marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                React.createElement('button', {
                  className: 'fkr-btn', onClick: () => setAckTarget(null), disabled: busy,
                }, '取消'),
                React.createElement('button', {
                  className: 'fkr-btn fkr-btn-primary',
                  onClick: () => doAck(Boolean(ackTarget.acknowledged)),
                  disabled: busy,
                }, busy ? '处理中…' : (ackTarget.acknowledged ? '取消确认' : '确认'))))
            : null,

          // ── 台账 ──
          showLedger
            ? React.createElement('div', {
              className: 'fkr-mask',
              onClick: (ev) => { if (ev.target === ev.currentTarget) setShowLedger(false) },
            },
            React.createElement('div', { className: 'fkr-modal' },
              React.createElement('div', { className: 'fkr-title', style: { marginBottom: 12 } },
                '已确认可接受的问题（' + acknowledged.length + '）'),
              acknowledged.length === 0
                ? React.createElement('div', { className: 'fkr-muted' }, '（暂无）')
                : acknowledged.map((it, i) => React.createElement('div', { key: i, className: 'fkr-part' },
                  React.createElement('div', { className: 'fkr-partTitle' },
                    it.code + (it.package ? ' · ' + it.package : '')),
                  React.createElement('div', { className: 'fkr-partItem' }, '理由：' + (it.ackReason || '(无)')),
                  React.createElement('div', { className: 'fkr-partItem' },
                    '确认于：' + absTime(Date.parse(it.ackedAt))),
                  React.createElement('button', {
                    className: 'fkr-btn', style: { fontSize: 11, marginTop: 4 },
                    onClick: () => { setShowLedger(false); setAckTarget(it); setReason('') },
                  }, '取消确认'))),
              React.createElement('div', { style: { marginTop: 16, textAlign: 'right' } },
                React.createElement('button', { className: 'fkr-btn', onClick: () => setShowLedger(false) }, '关闭'))))
            : null))
      }

      // ───────────────────────────────────────────────────────
      // 设置页（保留策略 / 体检历史）
      // ───────────────────────────────────────────────────────

      function SettingsPane(props) {
        const { policy, onMsg, onRefresh } = props
        const [maxCheckpoints, setMax] = React.useState((policy || {}).maxCheckpoints || 50)
        const [maxDays, setDays] = React.useState((policy || {}).maxDays || 30)
        const [hist, setHist] = React.useState(null)
        const [busy, setBusy] = React.useState(false)

        async function savePolicy() {
          setBusy(true)
          const r = await api('/policy', {
            method: 'POST',
            body: JSON.stringify({ maxCheckpoints: Number(maxCheckpoints), maxDays: Number(maxDays) }),
          })
          setBusy(false)
          if (r.error) { onMsg({ kind: 'err', text: r.error }); return }
          onMsg({ kind: 'ok', text: '保留策略已保存' })
          await onRefresh()
        }

        async function loadHist() {
          const r = await api('/health-history')
          setHist(r.error ? [] : (r.records || []))
        }

        return React.createElement('div', { className: 'fkr-card' },
          React.createElement('div', { className: 'fkr-title', style: { marginBottom: 10 } }, '设置'),

          React.createElement('div', { className: 'fkr-muted', style: { marginBottom: 4 } }, '保留策略'),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            React.createElement('span', { className: 'fkr-muted' }, '最多保留'),
            React.createElement('input', {
              className: 'fkr-input', type: 'number', min: 1, style: { width: 90 },
              value: maxCheckpoints, onChange: (ev) => setMax(ev.target.value),
            }),
            React.createElement('span', { className: 'fkr-muted' }, '个快照，最长'),
            React.createElement('input', {
              className: 'fkr-input', type: 'number', min: 1, style: { width: 90 },
              value: maxDays, onChange: (ev) => setDays(ev.target.value),
            }),
            React.createElement('span', { className: 'fkr-muted' }, '天'),
            React.createElement('button', { className: 'fkr-btn fkr-btn-primary', onClick: savePolicy, disabled: busy }, '保存')),
          React.createElement('div', { className: 'fkr-muted', style: { marginTop: 4, fontSize: 11 } },
            '（每日 / 滚动快照是独立配额，不占这个名额）'),

          React.createElement('div', { className: 'fkr-fold', style: { marginTop: 14 } },
            React.createElement('div', {
              className: 'fkr-foldHead',
              onClick: () => { if (hist === null) loadHist(); else setHist(null) },
            },
            React.createElement('span', null, (hist === null ? '▸ ' : '▾ ') + '体检历史'),
            React.createElement('span', { className: 'fkr-muted' }, hist === null ? '展开' : '收起')),
            hist !== null ? React.createElement('div', { className: 'fkr-foldBody fkr-scroll' },
              hist.length === 0
                ? React.createElement('div', { className: 'fkr-muted' }, '（暂无记录）')
                : hist.map((h, i) => React.createElement('div', { key: i, className: 'fkr-partItem' },
                  absTime(h.at) + ' · ' + (h.overall || '?')
                  + (h.codes ? ' · ' + String(h.codes).slice(0, 60) : '')))) : null),

          // ── 报错日志与诊断报告（2026-10-19 用户要求）──
          React.createElement(LogPane, { onMsg: onMsg }))

          // ⚠️ 2026-10-20：这里原本还有一行「快照目录：…」，
          //    但页面底部统一显示「快照目录 / 脚本目录」，会重复。
          //    已删除，路径信息统一由底部提供。
      }

      // ───────────────────────────────────────────────────────
      // 报错日志与诊断报告
      // ───────────────────────────────────────────────────────
      //
      // 用户要求：「还要有一个报错日志信息，这样方便收集信息」
      //
      // 这里提供三件事：
      //   ① 看最近的错误（人话 + 堆栈）
      //   ② 一键生成诊断报告（可复制/下载，直接发给开发者）
      //   ③ 清空日志
      //

      function LogPane(props) {
        const [data, setData] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [diag, setDiag] = React.useState(null)
        const [showDiag, setShowDiag] = React.useState(false)
        const [expanded, setExpanded] = React.useState(null)
        const onMsg = props.onMsg || function () {}

        async function load() {
          setBusy(true)
          const r = await api('/errors?limit=100')
          setBusy(false)
          setData(r.error ? { entries: [], total: 0, bytes: 0, error: r.error } : r)
        }

        async function makeDiag() {
          setBusy(true)
          const r = await api('/diagnostic')
          setBusy(false)
          if (r && r.error) { onMsg({ kind: 'err', text: r.error }); return }
          // GET /diagnostic 返回纯文本，api() 解析失败会得到 { error }；
          // 所以这里改用 fetch 直接取文本
          try {
            const res = await fetch('/plugins/dsh-fk-rollback/diagnostic')
            const txt = await res.text()
            setDiag(txt)
            setShowDiag(true)
          } catch (e) {
            onMsg({ kind: 'err', text: '生成失败：' + String(e && e.message ? e.message : e) })
          }
        }

        async function copyDiag() {
          try {
            await navigator.clipboard.writeText(diag || '')
            onMsg({ kind: 'ok', text: '诊断报告已复制到剪贴板' })
          } catch {
            onMsg({ kind: 'err', text: '复制失败，请手动全选复制' })
          }
        }

        async function saveDiag() {
          const r = await api('/diagnostic', { method: 'POST', body: '{}' })
          if (r.error) { onMsg({ kind: 'err', text: r.error }); return }
          onMsg({ kind: 'ok', text: '已保存到：' + r.path })
        }

        React.useEffect(() => { load() }, [])

        const LV_COLOR = {
          fatal: 'var(--dsw-alias-state-error-primary,#c62828)',
          error: 'var(--dsw-alias-state-error-primary,#d62828)',
          warn: 'var(--dsw-alias-state-warning-primary,#e65100)',
        }

        return React.createElement('div', { style: { marginTop: 14 } },
          React.createElement('div', { className: 'fkr-row', style: { marginBottom: 8 } },
            React.createElement('div', { className: 'fkr-title', style: { fontSize: 13 } }, '报错日志'),
            React.createElement('div', { style: { display: 'flex', gap: 6 } },
              React.createElement('button', {
                className: 'fkr-btn', onClick: load, disabled: busy, style: { fontSize: 11 },
              }, busy ? '…' : '刷新'),
              React.createElement('button', {
                className: 'fkr-btn fkr-btn-primary', onClick: makeDiag, disabled: busy, style: { fontSize: 11 },
              }, '生成诊断报告'))),

          React.createElement('div', { className: 'fkr-muted', style: { fontSize: 11, marginBottom: 10 } },
            '插件运行中出现的错误会记在这里。遇到问题时点「生成诊断报告」，'
            + '把报告内容发给开发者即可（已自动脱敏 API key 等敏感信息）。'),

          !data ? React.createElement('div', { className: 'fkr-muted' }, '读取中…')
            : data.error ? React.createElement('div', { className: 'fkr-alert', style: { color: 'var(--dsw-alias-state-error-primary,#c62828)' } }, data.error)
            : data.total === 0
              ? React.createElement('div', { className: 'fkr-muted' }, '✅ 没有错误记录')
              : React.createElement('div', null,
                React.createElement('div', { className: 'fkr-muted', style: { fontSize: 11, marginBottom: 6 } },
                  '共 ' + data.total + ' 条 · ' + Math.max(1, Math.round(data.bytes / 1024)) + ' KB（新的在前）'),
                React.createElement('div', { className: 'fkr-scroll' },
                  data.entries.slice(0, 50).map((e, i) => {
                    const open = expanded === i
                    return React.createElement('div', {
                      key: i,
                      style: {
                        padding: '6px 8px', borderRadius: 6, marginBottom: 4, cursor: 'pointer',
                        border: '1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15))',
                      },
                      onClick: () => setExpanded(open ? null : i),
                    },
                    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                      React.createElement('span', {
                        style: { fontSize: 11, opacity: 0.65, minWidth: 130, flex: 'none' },
                      }, e.ts),
                      React.createElement('span', {
                        style: { fontSize: 10, padding: '0 6px', borderRadius: 8, border: '1px solid currentColor',
                          color: LV_COLOR[String(e.level).toLowerCase()] || 'inherit', flex: 'none' },
                      }, e.level),
                      React.createElement('span', { style: { flex: 1, fontSize: 12 } },
                        e.source + ' / ' + e.op)),
                    open
                      ? React.createElement('pre', {
                        style: {
                          fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                          margin: '6px 0 0', opacity: 0.85, maxHeight: 200, overflow: 'auto',
                          fontFamily: 'monospace',
                        },
                      }, e.raw)
                      : null)
                  }))),

          // ── 诊断报告弹窗 ──
          showDiag ? React.createElement('div', {
            className: 'fkr-mask',
            onClick: (ev) => { if (ev.target === ev.currentTarget) setShowDiag(false) },
          },
          React.createElement('div', { className: 'fkr-modal', style: { width: 'min(820px, 94vw)' } },
            React.createElement('div', { className: 'fkr-row', style: { marginBottom: 10 } },
              React.createElement('div', { className: 'fkr-title' }, '诊断报告'),
              React.createElement('button', {
                className: 'fkr-btn', onClick: () => setShowDiag(false), style: { fontSize: 11 },
              }, '关闭')),
            React.createElement('div', { className: 'fkr-muted', style: { fontSize: 11, marginBottom: 8 } },
              '把下面的全部内容复制给开发者。已自动脱敏，不含 API key。'),
            React.createElement('textarea', {
              className: 'fkr-input',
              readOnly: true,
              value: diag || '',
              rows: 18,
              style: { fontFamily: 'monospace', fontSize: 11, lineHeight: 1.45 },
              onFocus: (ev) => { try { ev.target.select() } catch (e) {} },
            }),
            React.createElement('div', { style: { marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              React.createElement('button', { className: 'fkr-btn', onClick: saveDiag }, '保存为文件'),
              React.createElement('button', { className: 'fkr-btn fkr-btn-primary', onClick: copyDiag }, '复制全部'))))
          : null)
      }
      // ───────────────────────────────────────────────────────
      // 改动溯源（2026-10-19 重做：回答用户的问题，不是倾倒日志）
      // ───────────────────────────────────────────────────────
      //
      // 用户批评原话：
      //   「你的溯源完完全全就是把所有会话调出来给用户看，工具用户怎么看得懂？」
      //
      // 旧版：默认查询 = 全部操作 → 列出 8317 条 pwsh/edit/read 命令行原文。
      // 新版只回答一个问题：
      //   「我的配置文件，最近被谁改过？」
      //
      // 三层过滤（在 Host 端做，见 trace.mjs 的 configTimeline）：
      //   ① 只看真的写了文件的（排除 read/grep/glob/web_search）
      //   ② 只看碰过 5 个配置文件的（排除改代码、改文档）
      //   ③ 每条只给「动作 + 文件」，不显示命令行原文
      //

      const CONFIG_FILE_LIST = [
        'package.json',
        'cordis.patch.yml',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'compatibility.json',
      ]

      function TracePane(props) {
        const [days, setDays] = React.useState(7)
        const [fileFilter, setFileFilter] = React.useState('')
        const [res, setRes] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [expanded, setExpanded] = React.useState(null)

        async function run() {
          setBusy(true)
          const qs = '?days=' + days + (fileFilter ? '&file=' + encodeURIComponent(fileFilter) : '')
          const d = await api('/config-changes' + qs)
          setRes(d); setBusy(false)
        }
        React.useEffect(() => { run() }, [days, fileFilter])

        // 当前选中的初始值（从别的页面点「查改动」跳过来时）
        React.useEffect(() => {
          if (props && props.initialFile) setFileFilter(props.initialFile)
        }, [props && props.initialFile])

        const changes = (res && res.changes) || []
        const byFile = (res && res.byFile) || {}

        // 按「天」分组，让时间线可读
        const groups = []
        let lastDay = null
        for (const ch of changes) {
          const d = new Date(ch.t)
          const p = (n) => String(n).padStart(2, '0')
          const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
          if (day !== lastDay) { groups.push({ day, items: [] }); lastDay = day }
          groups[groups.length - 1].items.push(ch)
        }

        const fmtTime = (ms) => {
          const d = new Date(ms)
          const p = (n) => String(n).padStart(2, '0')
          return p(d.getHours()) + ':' + p(d.getMinutes())
        }

        return React.createElement('div', { className: 'fkr-card' },
          React.createElement('div', { className: 'fkr-row', style: { marginBottom: 4 } },
            React.createElement('div', { className: 'fkr-title' }, '配置文件改动记录'),
            React.createElement('button', {
              className: 'fkr-btn', onClick: run, disabled: busy, style: { fontSize: 11 },
            }, busy ? '查询中…' : '刷新')),
          React.createElement('div', { className: 'fkr-muted', style: { marginBottom: 12 } },
            '只显示「改动过 5 个配置文件」的操作。查资料、看文件的操作不会出现在这里。'),

          // ── 筛选 ──
          React.createElement('div', { className: 'fkr-toolbar' },
            React.createElement('select', {
              className: 'fkr-select', value: fileFilter,
              onChange: (ev) => setFileFilter(ev.target.value),
            },
            React.createElement('option', { value: '' }, '全部配置文件'),
            CONFIG_FILE_LIST.map((f, i) => React.createElement('option', { key: i, value: f },
              f + (byFile[f] ? '（' + byFile[f] + ' 次）' : '')))),
            React.createElement('select', {
              className: 'fkr-select', value: days,
              onChange: (ev) => setDays(Number(ev.target.value)),
            },
            React.createElement('option', { value: 1 }, '最近 1 天'),
            React.createElement('option', { value: 3 }, '最近 3 天'),
            React.createElement('option', { value: 7 }, '最近 7 天'),
            React.createElement('option', { value: 30 }, '最近 30 天'),
            React.createElement('option', { value: 90 }, '最近 90 天'))),

          // ── 错误 ──
          res && res.error
            ? React.createElement('div', { className: 'fkr-alert', style: { color: 'var(--dsw-alias-state-error-primary,#c62828)', marginTop: 10 } },
              res.error)
            : null,

          // ── 结果 ──
          !res || res.error ? null
            : changes.length === 0
              ? React.createElement('div', { style: { padding: '20px 0', textAlign: 'center' } },
                React.createElement('div', { style: { fontSize: 22, marginBottom: 8 } }, '✅'),
                React.createElement('div', { className: 'fkr-title' }, '最近 ' + days + ' 天没有配置改动'),
                React.createElement('div', { className: 'fkr-muted', style: { marginTop: 4 } },
                  '说明你的 5 个配置文件一直没被动过。'
                  + (fileFilter ? '（当前只看「' + fileFilter + '」）' : '')))
              : React.createElement('div', { style: { marginTop: 12 } },
                React.createElement('div', { className: 'fkr-muted', style: { marginBottom: 10 } },
                  '最近 ' + days + ' 天共 ' + changes.length + ' 次改动'
                  + (fileFilter ? '（只看「' + fileFilter + '」）' : '')
                  + ' · 涉及 ' + Object.keys(byFile).length + ' 个文件'),

                groups.map((g, gi) => React.createElement('div', { key: gi, style: { marginBottom: 14 } },
                  React.createElement('div', {
                    style: {
                      fontSize: 12, fontWeight: 600, marginBottom: 6,
                      color: 'var(--dsw-alias-label-secondary,inherit)',
                    },
                  }, g.day + '（' + g.items.length + ' 次）'),

                  g.items.slice(0, 30).map((ch, ci) => {
                    const key = gi + '-' + ci
                    const open = expanded === key
                    return React.createElement('div', {
                      key: ci,
                      className: 'fkr-item',
                      style: { flexDirection: 'column', alignItems: 'stretch', gap: 3, cursor: 'pointer' },
                      onClick: () => setExpanded(open ? null : key),
                    },
                    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                      React.createElement('span', {
                        style: { fontSize: 11, opacity: 0.65, minWidth: 42, flex: 'none' },
                      }, fmtTime(ch.t)),
                      React.createElement('span', { style: { flex: 1 } },
                        (ch.source === 'user' ? '你' : 'AI') + ' ' + ch.action
                        + ' ' + (ch.files || []).join('、')),
                      React.createElement('span', {
                        className: 'fkr-tag',
                        style: {
                          flex: 'none',
                          color: ch.source === 'user'
                            ? 'var(--dsw-alias-state-business-primary,#2b6cb0)'
                            : 'var(--dsw-alias-label-tertiary,inherit)',
                        },
                      }, ch.source === 'user' ? '手动' : 'AI')),
                    open
                      ? React.createElement('div', { className: 'fkr-muted', style: { fontSize: 11, paddingLeft: 50 } },
                        '时间：' + absTime(ch.t),
                        React.createElement('br'),
                        '文件：' + (ch.files || []).join('、'),
                        React.createElement('br'),
                        '来源会话：' + (ch.sessionTitle || '(无标题)'))
                      : null)
                  }),
                  g.items.length > 30
                    ? React.createElement('div', { className: 'fkr-muted', style: { fontSize: 11, paddingLeft: 8 } },
                      '…当天还有 ' + (g.items.length - 30) + ' 次，用筛选缩小范围')
                    : null)),

                React.createElement('div', { className: 'fkr-muted', style: { fontSize: 11, marginTop: 6 } },
                  'ⓘ 只列出事实，不判断哪一次「导致了问题」。点任意一条可看详情。')))
      }


      // ───────────────────────────────────────────────────────
      // 注册（与 dsh-approval-gate 的 settings.section 用法完全一致）
      // ───────────────────────────────────────────────────────

      function applyClient(ctx) {
        try {
          // 样式在 apply 时就注入（不留到首次渲染），
          // 这样面板一打开就是正确配色，不会有一帧无样式的闪烁。
          ensureStyle()

          // 客户端半边用 ctx.get('slots') 取插槽服务（官方插件的写法）
          const slots = (ctx && ctx.get && ctx.get('slots')) || (ctx && ctx.slots)
          if (!slots || typeof slots.inject !== 'function') return
          slots.inject('settings.section', function () {
            try {
              return slots.register(
                { name: 'settings.section', id: 'dsh-fk-rollback.settings', order: 90, label: 'FK回滚设置' },
                function (props) { return React.createElement(Panel, { slotsProps: props }) },
              )
            } catch { return () => {} }
          })
        } catch { /* 绝不能冒泡 */ }
      }

      // 插件对象（形状必须是：函数，或带 apply 的对象）
      const plugin = {
        name: 'dsh-fk-rollback',
        // 声明依赖：slots 用于注册 UI；timer/locale 可选，缺失时自动退回静态文案
        inject: ['slots'],
        apply: applyClient,
      }

      // 兼容两种加载路径：
      //   ① bundle 路径（__ModuleLoader__）→ 读 exports.default/apply/inject
      //   ② 求值路径（new Function 函数体）→ 读 return 值
      exports.default = plugin
      exports.apply = plugin.apply
      exports.inject = plugin.inject
      exports.name = plugin.name
    } catch (e) {
      // 连加载都失败 → 导出一个空壳，保证 DSH 不受影响
      try {
        console.error('[dsh-fk-rollback] client 加载失败（已忽略）:', e)
      } catch { /* 忽略 */ }
      module.exports = { apply: () => {} }
    }

    return module.exports
  },
})
