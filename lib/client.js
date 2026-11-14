/**
 * FK 回滚插件 · 模块一：UI 面板
 *
 * @version 1.5.3
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
      // 右下角弹窗（toast）
      // ───────────────────────────────────────────────────────
      //
      // 为什么用原生 DOM 而不是 React：
      //   本插件的 UI 是通过 slots.inject('settings.section') 挂进【设置页】的。
      //   那个组件只在用户打开设置页时才存在 —— 但「体检出问题」这件事
      //   需要在他【随便哪个页面】都能看到。所以弹窗必须挂在 document.body 上，
      //   和 slots 的挂载树无关。
      //
      //   （这个思路来自 OFM 插件：它的 toast 也是 vanilla DOM + document.body。）

      const TOAST_CSS_ID = 'dsh-fk-rollback-toast-style'

      function ensureToastStyle() {
        try {
          if (document.getElementById(TOAST_CSS_ID)) return
          const s = document.createElement('style')
          s.id = TOAST_CSS_ID
          s.textContent = [
            '.fkr-toasts{position:fixed;right:18px;bottom:18px;z-index:1200;display:flex;flex-direction:column;gap:10px;max-width:min(380px,calc(100vw - 36px));font-size:13px;line-height:1.6}',
            '.fkr-toast{position:relative;display:flex;flex-direction:column;gap:6px;padding:12px 14px 12px 16px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-1,#1e1e1e);color:var(--dsw-alias-label-primary,inherit);box-shadow:0 10px 30px rgba(0,0,0,.28);animation:fkr-toast-rise .32s cubic-bezier(.16,1,.3,1);transform-origin:bottom right}',
            '.fkr-toast::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:13px 0 0 13px;background:var(--dsw-alias-state-business-primary,#2b6cb0)}',
            '.fkr-toast.warn::before{background:var(--dsw-alias-state-warning-primary,#f0a441)}',
            '.fkr-toast.urgent::before{background:var(--dsw-alias-state-error-primary,#c62828)}',
            '.fkr-toast.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 42%,var(--dsw-alias-border-l2,rgba(128,128,128,.3)))}',
            '.fkr-toast.urgent{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62828) 42%,var(--dsw-alias-border-l2,rgba(128,128,128,.3)))}',
            '.fkr-toasttitle{font-weight:660;font-size:12.5px;display:flex;align-items:center;gap:7px;padding-right:16px}',
            '.fkr-toastbody{color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));max-height:180px;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap;font-size:12px}',
            '.fkr-toastactions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:2px}',
            '.fkr-toastclose{position:absolute;top:8px;right:8px;background:transparent;border:0;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8));cursor:pointer;font:inherit;font-size:13px;padding:2px 4px;line-height:1}',
            '.fkr-toastclose:hover{color:var(--dsw-alias-label-primary,inherit)}',
            '@keyframes fkr-toast-rise{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}',
          ].join('')
          document.head.appendChild(s)
        } catch { /* 样式失败不影响功能 */ }
      }

      /** 取（或创建）toast 容器。挂在 body 上，与 slots 无关。 */
      function toastHost() {
        let host = document.querySelector('.fkr-toasts')
        if (host === null) {
          host = document.createElement('div')
          host.className = 'fkr-toasts'
          document.body.appendChild(host)
        }
        return host
      }

      /**
       * 弹一条右下角提示。
       *
       * ⚠️ 绝不抛异常 —— 弹窗失败不能影响 DSH 本身。
       *
       * @param {object} o
       * @param {string} o.title
       * @param {string} [o.body]
       * @param {'info'|'warn'|'urgent'} [o.tone]
       * @param {Array<{label:string,onClick:Function}>} [o.actions]
       * @param {number} [o.holdMs]  自动消失毫秒；0 = 不自动消失
       * @returns {HTMLElement|undefined}
       */
      function showToast(o) {
        try {
          ensureToastStyle()
          const opt = o || {}
          const host = toastHost()
          const card = document.createElement('div')
          card.className = 'fkr-toast' + (opt.tone ? ' ' + opt.tone : '')

          const title = document.createElement('div')
          title.className = 'fkr-toasttitle'
          title.appendChild(document.createTextNode(String(opt.title == null ? '' : opt.title)))
          card.appendChild(title)

          const close = document.createElement('button')
          close.type = 'button'
          close.className = 'fkr-toastclose'
          close.setAttribute('aria-label', '关闭')
          close.title = '关闭'
          close.textContent = '✕'
          close.addEventListener('click', function () { card.remove() })
          card.appendChild(close)

          if (opt.body != null && opt.body !== '') {
            const area = document.createElement('div')
            area.className = 'fkr-toastbody'
            area.textContent = String(opt.body)
            card.appendChild(area)
          }

          if (Array.isArray(opt.actions) && opt.actions.length > 0) {
            const row = document.createElement('div')
            row.className = 'fkr-toastactions'
            for (const a of opt.actions) {
              const btn = document.createElement('button')
              btn.type = 'button'
              btn.className = 'fkr-btn'
              btn.style.padding = '3px 10px'
              btn.style.fontSize = '11px'
              btn.textContent = String(a && a.label ? a.label : '确定')
              btn.addEventListener('click', function () {
                try { card.remove() } catch { /* 忽略 */ }
                try { if (a && typeof a.onClick === 'function') a.onClick() } catch { /* 忽略 */ }
              })
              row.appendChild(btn)
            }
            card.appendChild(row)
          }

          host.appendChild(card)
          // 最多同时 4 条，挤掉最旧的
          while (host.children.length > 4) {
            try { host.firstElementChild.remove() } catch { break }
          }

          const hold = opt.holdMs === undefined ? 10000 : Number(opt.holdMs)
          if (hold > 0) {
            const timer = setTimeout(function () {
              try { card.remove() } catch { /* 忽略 */ }
            }, hold)
            if (timer && typeof timer.unref === 'function') timer.unref()
          }
          return card
        } catch { /* 弹窗不能拖垮调用方 */ }
        return undefined
      }

      // ───────────────────────────────────────────────────────
      // 体检结果主动提示（启动时 + 面板刷新时）
      // ───────────────────────────────────────────────────────
      //
      // 用户 2026-10-29 需求：
      //   「当体检出问题时，需要提示用户体检出问题」
      //   （参照 OFM 插件右下角「有新版本可更新」的弹窗）
      //
      // 设计要点：
      //   ① 一进 DSH 就检查 —— 不等用户打开设置页
      //      （体检出问题时，用户往往根本不知道要来看这个面板）
      //   ② 同一组问题只弹一次 —— 用 sessionStorage 记问题指纹
      //      否则每次页面刷新都弹，会变成骚扰
      //   ③ 点击「查看」直接跳到面板的体检页
      //   ④ 只有 fatal / error 才主动弹；warn 不打扰

      const NOTIFY_DEDUP_KEY = 'fkr.lastHealthNotify'

      /** 给问题集合算一个稳定指纹（用于去重）。 */
      function healthFingerprint(report) {
        try {
          const probs = (report && report.problems) || []
          const fatal = (report && report.counts && report.counts.fatal) || 0
          const parts = probs.map(function (x) {
            return String(x.code || '') + '|' + String(x.package || x.entryId || '')
          }).sort()
          return 'f' + fatal + '::' + parts.join(',')
        } catch { return '' }
      }

      /** 从 report 里挑最重要的几条，做成弹窗正文。 */
      function healthSummary(report) {
        try {
          const probs = (report && report.problems) || []
          const fatal = probs.filter(function (x) { return x.severity === 'fatal' })
          const errs = probs.filter(function (x) { return x.severity === 'error' })
          const pick = (fatal.length > 0 ? fatal : errs).slice(0, 3)
          const lines = pick.map(function (x) {
            const tag = x.severity === 'fatal' ? '🔴' : '⚠️'
            return tag + ' ' + String(x.message || '').slice(0, 110)
          })
          const more = probs.length - pick.length
          if (more > 0) lines.push('…还有 ' + more + ' 项')
          return lines.join('\n')
        } catch { return '' }
      }

      /**
       * 检查体检结果并在需要时弹窗。
       *
       * @param {object} report   /info 返回的 check 字段
       * @param {object} [opts]
       * @param {boolean} [opts.force] 忽略去重，强制弹（手动刷新时用）
       * @param {Function} [opts.onOpen] 「查看」按钮的回调
       */
      function notifyHealthIfNeeded(report, opts) {
        try {
          if (!report || !report.counts) return false
          const fatal = report.counts.fatal || 0
          const err = report.counts.error || 0
          // 只有致命/错误才主动打扰；warn 留给用户自己看面板
          if (fatal === 0 && err === 0) return false

          // 去重：同一组问题在同一个标签页只弹一次
          const fp = healthFingerprint(report)
          try {
            if (!opts || opts.force !== true) {
              if (window.sessionStorage.getItem(NOTIFY_DEDUP_KEY) === fp) return false
              window.sessionStorage.setItem(NOTIFY_DEDUP_KEY, fp)
            }
          } catch { /* sessionStorage 不可用就每次都弹 */ }

          const title = fatal > 0
            ? '体检发现 ' + fatal + ' 个致命问题'
            : '体检发现 ' + err + ' 个问题'

          const actions = []
          if (opts && typeof opts.onOpen === 'function') {
            actions.push({ label: '查看', onClick: opts.onOpen })
          }

          showToast({
            title: title,
            body: healthSummary(report),
            tone: fatal > 0 ? 'urgent' : 'warn',
            actions: actions,
            // 有致命问题就多留一会儿（20 秒），普通问题 12 秒
            holdMs: fatal > 0 ? 20000 : 12000,
          })
          return true
        } catch { return false }
      }

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
            // ── 【修复代理】整行按钮（2026-11-14）──
            '.fkr-fixproxy{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;'
              + 'margin-top:6px;padding:9px 12px;border-radius:8px;cursor:pointer;'
              + 'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));'
              + 'background:transparent;color:var(--dsw-alias-label-primary,inherit);'
              + 'font:inherit;text-align:left;transition:background .15s,border-color .15s}',
            '.fkr-fixproxy:hover:not(:disabled){'
              + 'background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));'
              + 'border-color:var(--dsw-alias-state-business-primary,#2b6cb0)}',
            '.fkr-fixproxy:disabled{opacity:.5;cursor:not-allowed}',
            '.fkr-fixproxy-label{font-weight:600;font-size:13px;flex:none}',
            '.fkr-fixproxy-hint{flex:1;min-width:0;font-size:11px;'
              + 'color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9))}',
            '.fkr-fixproxy-arrow{flex:none;font-size:16px;opacity:.5}',
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
        // ⭐ v1.5.2 性能优化（2026-10-27）：Cookie 状态独立异步加载
        //
        //   /info 里原本 await 这个检测，实测让首屏多等 1.7 秒
        //   （1.4 秒花在「尝试打开被 Chromium 锁住的 SQLite」上）。
        //   现在 /info 立即返回，Cookie 那一行等数据到了再填。
        const [cookieInfo, setCookieInfo] = React.useState(null)
        // 上次体检时间（2026-11-14 用户要求）
        //   为什么需要：体检结果往往是「✅ 一切正常」这种静态文字，
        //   点完按钮看不到任何变化 → 用户以为没反应。
        //   显示时间戳，至少能看出「刚刚跑过了」。
        const [lastCheckAt, setLastCheckAt] = React.useState(null)

        // 【修复代理】按钮的处理中状态（2026-11-14）
        //   ⚠️ 不再保留 proxyStatus —— 代理状态归【体检】管，
        //      这一行只是个动作按钮，不需要显示状态。
        const [proxyFixing, setProxyFixing] = React.useState(false)

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
          // 记录这次体检完成的时刻（即使结果是「一切正常」也要更新，
          // 否则用户点完看不到任何变化，会以为按钮坏了）
          if (d && !d.error) setLastCheckAt(new Date())
          // 打开面板时同步检查一次：若有问题且本次会话还没提示过，弹一条
          // （force=false → 靠 sessionStorage 去重，不会重复骚扰）
          if (d && !d.error) {
            notifyHealthIfNeeded(d.check, {
              onOpen: () => setTab('issues'),
            })
          }
          // Cookie 状态：故意不 await —— 它是附加信息，不该拖慢首屏。
          // 数据到了再 setState，React 会只重渲染那一行。
          api('/auth-cookies')
            .then((r) => setCookieInfo(r && !r.error ? r : null))
            .catch(() => setCookieInfo(null))

          // 探测【内置】重启能力（v1.3.0：不再依赖外部插件）
          try {
            const rh = await api('/restart-helper')
            setRestartAvail(Boolean(rh && rh.available))
            setRestartInfo(rh || null)
          } catch { setRestartAvail(false); setRestartInfo(null) }
        }

        /**
         * 测试右下角弹窗（2026-10-29 用户要求）。
         *
         * 连续点击会循环演示三种形态，方便一眼确认样式对不对：
         *   第 1 次 → info   （蓝色条，10 秒）
         *   第 2 次 → warn   （橙色条，12 秒）
         *   第 3 次 → urgent （红色条，20 秒，带「知道了」按钮）
         * 之后回到 info，如此循环。
         */
        const testToastRef = React.useRef(0)
        function doTestToast() {
          try {
            const phase = testToastRef.current % 3
            testToastRef.current += 1
            if (phase === 0) {
              showToast({
                title: '测试：普通提示',
                body: '这是【提示】样式（左侧蓝色条）。\n'
                  + '真正出问题时，标题会写具体有几个问题，正文列出问题摘要。',
                tone: 'info',
                holdMs: 10000,
              })
            } else if (phase === 1) {
              showToast({
                title: '测试：警告（2 个问题）',
                body: '⚠️ dsh-security-center 的 engines.dsh 锁定在 0.2.0-rc.2，当前 0.2.1-rc.3\n'
                  + '⚠️ 示例问题二\n'
                  + '\n这是【警告】样式（左侧橙色条），留 12 秒。',
                tone: 'warn',
                holdMs: 12000,
                actions: [{ label: '知道了', onClick: () => {} }],
              })
            } else {
              showToast({
                title: '测试：致命问题（1 个）',
                body: '🔴 package「surfcore」被 2 个不同的 loader 条目指向 —— '
                  + 'DSH 启动时会抛「resolves from multiple active Loader sources」，整个应用起不来。\n'
                  + '\n这是【严重】样式（左侧红色条），留 20 秒。',
                tone: 'urgent',
                holdMs: 20000,
                actions: [
                  { label: '知道了', onClick: () => {} },
                  { label: '再来一条', onClick: () => doTestToast() },
                ],
              })
            }
          } catch { /* 测试按钮不能拖垮面板 */ }
        }

        // ── 代理环境变量诊断 / 修复（2026-11-14 事故）──
        //
        // 用户诉求：所有模型都报 "transport failed" 时，
        //   第一反应是打开面板，不是开命令行。
        //   所以这里给一个入口，不用记命令。

        /**
         * 检查代理环境变量，用 toast 报告结果（2026-11-14 事故）。
         *
         * 为什么用 toast 而不是 Modal：
         *   这个检查的使用场景是「所有模型都挂了，我该看哪儿」——
         *   一次性的诊断结论，用不着常驻弹窗。
         *   toast 挂在 body 上，在哪个页面都看得见，而且不打断操作。
         */
        async function openProxy() {
          try {
            const r = await api('/proxy-env')
            if (r && r.error) {
              showToast({
                title: '代理检查失败',
                body: String(r.error),
                tone: 'warn',
                holdMs: 12000,
              })
              return
            }
            const vars = (r && r.vars) || []
            const dead = (r && r.dead) || []

            if (vars.length === 0) {
              showToast({
                title: '✅ 代理环境变量正常',
                body: '当前用户没有任何代理环境变量。\n'
                  + '如果你还是遇到 transport failed，那原因不在这里 —— '
                  + '点「查看」跑一次完整体检，或用「诊断」导出报告。',
                tone: 'info',
                holdMs: 12000,
              })
              return
            }

            // 有变量：列出状态
            const lines = []
            for (const v of vars) {
              const keys = (v.keys || []).join(' / ')
              if (v.status === 'dead') {
                lines.push('❌ ' + keys + ' = ' + v.value + '（代理没有运行）')
              } else if (v.status === 'alive') {
                lines.push('✅ ' + keys + ' = ' + v.value + '（在运行）')
              } else if (v.status === 'remote') {
                lines.push('ⓘ ' + keys + ' = ' + v.value + '（远程，不探活）')
              } else {
                lines.push('⚠️ ' + keys + ' = ' + v.value + '（无法解析）')
              }
            }

            if (dead.length === 0) {
              showToast({
                title: '代理环境变量都在正常运行',
                body: lines.join('\n'),
                tone: 'info',
                holdMs: 12000,
              })
              return
            }

            // 有死的 → 给修复按钮
            const deadKeys = []
            for (const d of dead) for (const k of (d.keys || [])) deadKeys.push(k)

            showToast({
              title: '❌ 代理没有运行 —— 这就是故障原因',
              body: lines.join('\n')
                + '\n\nDSH 0.2.2 起会在启动时读这些变量，'
                + '把全局 HTTP dispatcher 换成指向该代理的 ProxyAgent。'
                + '代理没开 → 所有模型统一报 "DeepSeek Messages transport failed"。'
                + '\n\n点「一键修复」删掉它们（会先备份）。',
              tone: 'urgent',
              holdMs: 0,                      // 不自动消失，等用户操作
              actions: [
                {
                  label: '现在修复',
                  onClick: () => fixProxyKeys(deadKeys),
                },
                {
                  label: '启动代理软件',
                  onClick: () => {
                    showToast({
                      title: '那就先把代理开起来',
                      body: '启动代理软件后，确认端口在监听：\n'
                        + '  Test-NetConnection 127.0.0.1 -Port <端口>\n\n'
                        + '然后【完全退出 DSH 再启动】。',
                      tone: 'info',
                      holdMs: 15000,
                    })
                  },
                },
              ],
            })
          } catch (e) {
            showToast({
              title: '代理检查异常',
              body: String(e && e.message ? e.message : e),
              tone: 'warn',
              holdMs: 12000,
            })
          }
        }

        /**
         * 【修复代理】整行按钮的处理函数（2026-11-14 用户最终指定）。
         *
         * 自己先查一遍再动手 —— 不依赖面板缓存的 proxyStatus
         * （那个已经删掉了，代理状态现在统一由体检负责）。
         */
        async function doFixProxyAll() {
          try {
            setProxyFixing(true)
            const r = await api('/proxy-env')
            if (r && r.error) {
              setProxyFixing(false)
              showToast({
                title: '代理检查失败',
                body: String(r.error),
                tone: 'warn',
                holdMs: 12000,
              })
              return
            }
            const dead = (r && r.dead) || []
            if (dead.length === 0) {
              setProxyFixing(false)
              const vars = (r && r.vars) || []
              showToast({
                title: vars.length === 0
                  ? '\u2705 \u4e0d\u7528\u4fee \u2014\u2014 \u6ca1\u6709\u4ee3\u7406\u53d8\u91cf'
                  : '\u2705 \u4e0d\u7528\u4fee \u2014\u2014 \u4ee3\u7406\u90fd\u5728\u6b63\u5e38\u8fd0\u884c',
                body: vars.length === 0
                  ? '当前用户没有任何代理环境变量。\n'
                    + '如果你还是遇到 transport failed，那原因不在这里 —— '
                    + '点【体检】看其它项，或用「诊断」导出报告。'
                  : vars.map(function (v) {
                    return '\u2705 ' + (v.keys || []).join(' / ') + ' = ' + (v.value || '')
                  }).join('\n'),
                tone: 'info',
                holdMs: 12000,
              })
              return
            }
            const keys = []
            for (const d of dead) for (const k of (d.keys || [])) keys.push(k)
            setProxyFixing(false)
            await fixProxyKeys(keys)
          } catch (e) {
            setProxyFixing(false)
            showToast({
              title: '修复异常',
              body: String(e && e.message ? e.message : e),
              tone: 'warn',
              holdMs: 12000,
            })
          }
        }

        /** 执行修复（只删给定的键）。 */
        async function fixProxyKeys(keys) {
          try {
            if (!Array.isArray(keys) || keys.length === 0) {
              showToast({ title: '没有要删的变量', tone: 'warn', holdMs: 8000 })
              return
            }
            // 按钮显示「修复中…」，避免用户以为没反应
            setProxyFixing(true)
            showToast({
              title: '正在删除 ' + keys.length + ' 个代理变量…',
              body: keys.join('\n'),
              tone: 'info',
              holdMs: 6000,
            })
            const r = await api('/proxy-env', {
              method: 'POST',
              body: JSON.stringify({ action: 'fix', keys }),
            })
            if (r && r.error) {
              setProxyFixing(false)
              showToast({
                title: '修复失败',
                body: String(r.error),
                tone: 'urgent',
                holdMs: 15000,
              })
              return
            }
            const cnt = (r && r.removed && r.removed.length) || 0
            showToast({
              title: '✅ 已删除 ' + cnt + ' 个代理变量',
              body: '⚠️ 必须【完全退出 DSH 再启动】才会生效。\n'
                + '环境变量只在进程启动时读取，已运行的进程不会重新读。\n\n'
                + (r && r.backupPath ? '原值已备份，可点「恢复代理设置」反悔。' : ''),
              tone: 'info',
              holdMs: 25000,
              actions: r && r.backupPath
                ? [{ label: '恢复代理设置', onClick: () => restoreProxy() }]
                : [],
            })
            setProxyFixing(false)
            // 体检会重新跑一遍（代理状态是体检的一部分）
            try { await refresh() } catch { /* 忽略 */ }
          } catch (e) {
            setProxyFixing(false)
            showToast({
              title: '修复异常',
              body: String(e && e.message ? e.message : e),
              tone: 'urgent',
              holdMs: 15000,
            })
          }
        }

        /** 从备份恢复。 */
        async function restoreProxy() {
          try {
            const r = await api('/proxy-env', {
              method: 'POST',
              body: JSON.stringify({ action: 'restore' }),
            })
            if (r && r.error) {
              showToast({ title: '恢复失败', body: String(r.error), tone: 'urgent', holdMs: 15000 })
              return
            }
            const cnt = (r && r.restored && r.restored.length) || 0
            showToast({
              title: cnt > 0 ? '已恢复 ' + cnt + ' 个代理变量' : '没有可恢复的备份',
              body: cnt > 0
                ? '⚠️ 同样需要【完全退出 DSH 再启动】才会生效。'
                : String((r && r.reason) || ''),
              tone: cnt > 0 ? 'info' : 'warn',
              holdMs: 15000,
            })
            try { await refresh() } catch { /* 忽略 */ }
          } catch (e) {
            showToast({ title: '恢复异常', body: String(e && e.message ? e.message : e), tone: 'warn' })
          }
        }        /** 打开回滚确认框前先算四分区清单（决定 26/27） */
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
        // ⭐ v1.5.2：认证 Cookie 累积状态（异步加载，见 refresh()）
        //   readable=true  → 精确值（DSH 未运行时才会这样）
        //   readable=false → 面板在跑说明 DSH 正在运行，Chromium 独占锁定读不到；
        //                    此时用「基线 + 启动次数」估算（estimate 字段）
        //   null → 还在加载（不渲染那一行，避免闪一下）
        const ac = cookieInfo
        // ⭐ 最佳回滚点（2026-10-29）：体检发现问题时给一个「一键回到这里」
        const lg = d.lastGood || null
        // 上次重启时重启助手实测到的真实数量（cookie-observed.json）
        // 用来给「推算值」做对照 —— 让用户能自己判断推算准不准
        const acObserved = (ac && ac.lastObserved) || null
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
              // ⭐ 2026-10-29 用户要求：加一个测试弹窗按钮
              //
              //   为什么需要：右下角弹窗只在「真的有问题」时出现，
              //   用户装了新版本想确认这个功能能不能用，却没有办法主动触发。
              //   这个按钮按 3 次循环演示三种形态，方便一眼看出效果。
              React.createElement('span', { className: 'fkr-muted', style: { fontSize: 11, marginLeft: 6 } },
                ' ',
                React.createElement('button', {
                  className: 'fkr-btn',
                  style: { padding: '1px 8px', fontSize: 11 },
                  title: '弹出一条右下角提示（连续点会循环演示 正常/警告/严重 三种样式）',
                  onClick: doTestToast,
                }, '测试弹窗'),
                // ⭐ 2026-11-14 用户要求：体检行加【体检】按钮
                //   点了重跑一次完整检查（含代理），不用关掉面板重开
                React.createElement('button', {
                  className: 'fkr-btn',
                  style: { padding: '1px 8px', fontSize: 11, marginLeft: 5 },
                  title: '重新跑一次完整检查（含代理环境变量）',
                  disabled: !!state.loading || !!busy,
                  onClick: refresh,
                }, state.loading ? '检查中…' : '体检'),
                // 上次体检时间：紧跟在按钮右边
                //   loading 时显示「进行中」，跑完显示 HH:MM:SS
                React.createElement('span', {
                  className: 'fkr-muted',
                  style: { fontSize: 11, marginLeft: 5 },
                  title: lastCheckAt
                    ? '上次体检完成于 ' + lastCheckAt.toLocaleString('zh-CN', { hour12: false })
                    : '还没体检过',
                },
                state.loading
                  ? '进行中…'
                  : lastCheckAt
                    ? (function () {
                      const p2 = (v) => String(v).padStart(2, '0')
                      return p2(lastCheckAt.getHours()) + ':'
                        + p2(lastCheckAt.getMinutes()) + ':'
                        + p2(lastCheckAt.getSeconds())
                    })()
                    : '未体检')),
              realCount > 0
                ? React.createElement('span', null,
                  '   ',
                  React.createElement('button', {
                    className: 'fkr-btn', style: { padding: '1px 8px', fontSize: 11 },
                    onClick: () => setTab('issues'),
                  }, '查看'),
                  // ⭐ 2026-10-29 用户要求：「检测到问题可以直接回滚」
                  //   体检报问题时，直接给一个「回滚到最佳健康快照」的入口，
                  //   不用用户自己去快照列表里翻。
                  //   目标由后端 pickLastGood 选出（今天的 daily 优先 = 装插件之前的状态）。
                  lg
                    ? React.createElement('button', {
                      className: 'fkr-btn fkr-btn-primary',
                      style: { padding: '1px 8px', fontSize: 11, marginLeft: 4 },
                      title: `回滚到「${lg.name}」—— ${lg.reason || ''}`,
                      disabled: !!busy,
                      onClick: () => openRestore(lg.id),
                    }, '回滚')
                    : null)
                : null),
            // ⚠️ 2026-10-20 用户反馈「一切正常 X2」：
            //   这里原本又输出一次 c.verdict，而上一行已经显示过「✅ 一切正常」。
            //   正常时 c.verdict 的值就是「一切正常」，于是出现两遍。
            //   整块删除 —— 上一行已经说清楚了。
            ),

          // ── 认证 Cookie 累积（v1.5.2）──
          //
          // 设计原则（2026-10-27 用户反馈后重做）：
          //   用户看到的是「✅ 4 个」+ 四行技术解释，观感矛盾又啰嗦 ——
          //   绿勾和精确数字像是实测，可正文又说「读不到」。
          //
          //   现在：一行给结论，技术细节收进 title（hover 才看）。
          //   只有接近上限时才多一行行动建议。
          //
          // 关于数据可信度（必须诚实）：
          //   DSH 运行时 Chromium 以独占模式持有 Cookie 文件，
          //   readFileSync / readSync / createReadStream / sqlite / CDP 全部失败，
          //   所以「当前数量」只能按「基线 + 启动次数」推算。
          //   真实值由重启助手在 DSH 退出时取得（cookie-observed.json）。
          (() => {
            if (!ac) return null
            const ck = ac.cookies || null
            const est = ac.estimate || null
            const obs = acObserved || null

            const COK = 'var(--dsw-alias-state-success-primary,#2e7d32)'
            const CWARN = 'var(--dsw-alias-state-warning-primary,#e65100)'
            const CERR = 'var(--dsw-alias-state-error-primary,#c62828)'

            // 数量与级别：精确值优先，其次推算
            let count = null
            let ratio = null
            let level = 'unknown'
            let byEstimate = false

            if (ck) {
              count = ck.auth
              ratio = ck.ratio
              level = ck.level
            } else if (est) {
              count = est.count
              ratio = ac.estimateRatio ?? null
              byEstimate = true
              if (ratio !== null) {
                if (ratio >= 1) level = 'fatal'
                else if (ratio >= 0.95) level = 'error'
                else if (ratio >= 0.85) level = 'warn'
                else level = 'normal'
              }
            }

            const danger = level === 'fatal' || level === 'error' || level === 'warn'
            const color = level === 'fatal' || level === 'error'
              ? CERR : level === 'warn' ? CWARN : COK

            // ── 主行：一句结论 ──
            //   正常态不用 ✅（避免「看起来像实测」），统一用「约 N 个」
            let head
            if (count === null) {
              head = '数量未知'
            } else if (byEstimate) {
              head = '约 ' + count + ' 个'
            } else {
              head = count + ' 个'
            }
            const tail = ' / 上限约 70 个'

            // ── 详情（hover 看）──
            const detail = []
            if (byEstimate) {
              detail.push('「' + head + '」是推算值，不是实测：')
              detail.push('DSH 运行时 Chromium 独占锁定 Cookie 文件，')
              detail.push('readFileSync / readSync / 流式读取 / SQLite / CDP 全部 EBUSY 或不可用。')
              detail.push('')
              detail.push('推算依据：基线（' + absTime(Date.parse(est.baselineAt)) + ' 清理后 = 0 个）')
              detail.push('　　　　　+ 之后启动 ' + est.bootsSince + ' 次 × 每次约 +1')
              detail.push('（样本量仅 1 次对照：74 次启动 ↔ 71 个 cookie，偏差 3）')
            } else if (ck) {
              detail.push('数据来源：直接读取 Cookies 库（DSH 当时未运行），这是实测值。')
              detail.push('请求头占用 ' + ck.headerBytes + ' / ' + ck.budget + ' 字节')
              if (ck.ports && ck.ports.length > 1) {
                detail.push('涉及 ' + ck.ports.length + ' 个不同端口（每次启动换一个 → 多一个 cookie）')
              }
            } else {
              detail.push(ac.reason || 'Cookie 内容读不到')
            }
            detail.push('')
            if (obs) {
              // 重启助手在「DSH 已退出、端口已释放」的空窗期读到的真实数据。
              // 这是面板唯一可信的来源，尽量把细节都摆出来供核对。
              const obsCount = obs.observed ?? obs.removed ?? 0
              const obsAt = obs.at ? absTime(Date.parse(obs.at)) : '?'
              detail.push('📌 上次重启实测（DSH 退出瞬间读到的真实值）')
              if (obs.triggeredBy) {
                detail.push('　　触发来源：' + obs.triggeredBy)
              }
              detail.push('　　时间：' + obsAt)
              detail.push('　　数量：' + obsCount + ' 个 dsh-auth-*')
              if (typeof obs.total === 'number') {
                detail.push('　　库内 cookie 总数：' + obs.total)
              }
              if (typeof obs.headerBytes === 'number') {
                const budget = obs.headerBudget || 15984
                const pct = ((obs.headerBytes / budget) * 100).toFixed(1)
                detail.push('　　请求头占用：' + obs.headerBytes + ' / ' + budget
                  + ' 字节（' + pct + '%）')
              }
              if (Array.isArray(obs.ports) && obs.ports.length > 1) {
                detail.push('　　涉及端口：' + obs.ports.length + ' 个不同端口')
              }
              if (obs.oldest && obs.newest) {
                detail.push('　　签发跨度：' + absTime(obs.oldest) + ' → ' + absTime(obs.newest))
              }
              if (obs.removed !== undefined && obs.removed !== obsCount) {
                detail.push('　　（本次实际清理 ' + obs.removed + ' 个）')
              }
              detail.push('　　→ 这就是为什么重启时清理最可靠：那一刻能读到真实值。')
            } else {
              detail.push('📌 尚无实测记录 —— 下次重启 DSH 时会记下真实数量')
            }
            detail.push('')
            detail.push('💡 面板的「重启 DSH」会在关闭后、启动前自动清理累积的 Cookie。')

            return React.createElement('div',
              { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2 } },
              React.createElement('div', {
                title: detail.join('\n'),
                style: { cursor: 'help' },
              },
                '【认证 Cookie】 ',
                React.createElement('span', { style: { color } },
                  (level === 'fatal' ? '🔴 ' : level === 'error' ? '⚠️ ' : level === 'warn' ? 'ⓘ ' : '')
                    + head),
                React.createElement('span', { className: 'fkr-muted' }, tail),
                React.createElement('span', {
                  className: 'fkr-muted',
                  style: { fontSize: 11, marginLeft: 5 },
                }, 'ⓘ')),
              // 只在危险时补一行行动建议（其余情况 hover 看）
              danger
                ? React.createElement('div', {
                  style: { fontSize: 11, color },
                }, level === 'fatal'
                  ? '🔴 已达上限 —— 这就是 DSH 起不来的原因。请完全退出后运行「清除旧Cookies.bat」'
                  : '⚠️ 接近上限 —— 点一次「重启 DSH」就会自动清掉')
                : null)
          })(),

          // ── 【修复代理】整行按钮（2026-11-14 用户最终指定）──
          //
          // 用户原话：「第三行【修复代理】是按钮，就是真的修复代理，
          //           然后这个代理检查，放在体检区」
          //
          // 所以：
          //   · 这一整行就是一个按钮 —— 点哪儿都能修
          //   · 不在这里显示代理状态（状态归【体检】，
          //     proxy-env-dead 已接进 runCheck）
          //   · 没有失效代理时仍可点，点了明确告诉你「不用修」
          React.createElement('button', {
            type: 'button',
            className: 'fkr-fixproxy',
            disabled: !!proxyFixing,
            title: '删掉指向失效代理的环境变量（会先备份，可回退）',
            onClick: () => { doFixProxyAll() },
          },
          React.createElement('span', { className: 'fkr-fixproxy-label' },
            '【修复代理】'),
          React.createElement('span', { className: 'fkr-fixproxy-hint' },
            proxyFixing
              ? '处理中…'
              : '代理导致所有模型报 transport failed 时点这里 —— 会先备份'),
          React.createElement('span', { className: 'fkr-fixproxy-arrow' }, '›')),

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

          // ⭐ 启动即体检：不等用户打开设置页。
          //
          //   为什么需要：体检出问题时（比如装了个坏插件），用户往往
          //   根本不知道要打开这个面板 —— 他只会发现「DSH 怪怪的」。
          //   所以在客户端加载后主动查一次，有问题就在右下角弹一条。
          //
          //   ⚠️ 必须延迟一点再查：apply() 发生在树挂载期间，
          //      此刻 Host 的 http 端点可能还没注册完。
          //      （同 OFM 的做法：等 1.2 秒再拉）
          try {
            const kickoff = setTimeout(function () {
              try {
                api('/info').then(function (d) {
                  try {
                    if (d && !d.error) {
                      notifyHealthIfNeeded(d.check, {
                        // 启动时没有面板可跳转 —— 点「查看」只提示去设置页
                        onOpen: function () {
                          showToast({
                            title: '去哪看',
                            body: '设置 → 侧边栏「FK回滚设置」→ 点【体检】旁边的「查看」',
                            tone: 'info',
                            holdMs: 8000,
                          })
                        },
                      })
                    }
                  } catch { /* 忽略 */ }
                }).catch(function () { /* 忽略 */ })
              } catch { /* 忽略 */ }
            }, 1500)
            if (kickoff && typeof kickoff.unref === 'function') kickoff.unref()
          } catch { /* 启动检查失败不能影响 DSH */ }

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
