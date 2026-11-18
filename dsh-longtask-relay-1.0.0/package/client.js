/**
 * Browser half: the relay monitoring panel.
 *
 * Registered as a lazy module factory, so React comes from the harness module
 * table and no build step is involved. Data comes from the Host `relay` Remote
 * namespace through the existing `/api` RPC channel; nothing here reads files
 * or another plugin's DOM.
 *
 * Everything that needs `ctx` is defined inside `apply`, so the components
 * close over the live connection instead of a module-level imitation of it.
 */
window.__ModuleLoader__.load({
  id: '@local/longtask-relay',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const POLL_MS = 5000

    const STRINGS = {
      panel: '长任务接力',
      empty: '还没有接力任务。在会话里让模型调用 relay_start 开始一条链。',
      refresh: '刷新',
      objective: '目标',
      progress: '进度',
      current: '当前会话',
      sessions: '会话',
      features: '功能清单',
      handoff: '交接说明',
      pause: '暂停自动接力',
      resume: '恢复自动接力',
      handoffNow: '立即交接',
      confirmHandoff: '现在创建新会话接管这条链？',
      loading: '加载中…',
      failed: '读取失败',
      none: '无',
      retired: '已退役',
      cold: '未加载',
      pressure: '上下文',
      compactions: '压缩',
      handoffs: '次交接',
    }

    const STRINGS_EN = {
      panel: 'Long-task relay',
      empty: 'No relay chain yet. Ask the model to call relay_start in a session.',
      refresh: 'Refresh',
      objective: 'Objective',
      progress: 'Progress',
      current: 'Current session',
      sessions: 'Sessions',
      features: 'Features',
      handoff: 'Handoff brief',
      pause: 'Pause auto handoff',
      resume: 'Resume auto handoff',
      handoffNow: 'Hand off now',
      confirmHandoff: 'Create a fresh session and hand this chain over now?',
      loading: 'Loading…',
      failed: 'Read failed',
      none: 'none',
      retired: 'retired',
      cold: 'not loaded',
      pressure: 'Context',
      compactions: 'Compactions',
      handoffs: 'handoffs',
    }

    const STATUS_LABELS = {
      active: '进行中',
      paused: '已暂停',
      initializing: '初始化',
      done: '已完成',
      failed: '失败',
    }

    const ROLE_LABELS = {
      initializer: '初始化',
      worker: '执行',
      reviewer: '复核',
      leader: '统筹',
    }

    const styles = {
      page: { height: '100%', overflow: 'auto', padding: '20px 24px', font: 'inherit', color: 'inherit' },
      toolbar: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' },
      title: { fontSize: '16px', fontWeight: 600, margin: 0 },
      spacer: { flex: 1 },
      card: {
        border: '1px solid var(--dsw-alias-menu-group-header-fill, rgba(127,127,127,0.28))',
        borderRadius: '10px',
        padding: '12px 14px',
        marginBottom: '10px',
      },
      row: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      chainTitle: { fontSize: '14px', fontWeight: 600 },
      meta: { fontSize: '12px', opacity: 0.7 },
      badge: {
        fontSize: '11px',
        padding: '1px 7px',
        borderRadius: '999px',
        border: '1px solid currentColor',
        opacity: 0.85,
      },
      bar: {
        height: '5px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-menu-group-header-fill, rgba(127,127,127,0.22))',
        marginTop: '8px',
        overflow: 'hidden',
      },
      barFill: { height: '100%', background: 'var(--dsw-alias-state-done-primary, currentColor)' },
      button: {
        font: 'inherit',
        fontSize: '12px',
        padding: '3px 10px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-menu-group-header-fill, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      error: {
        border: '1px solid var(--dsw-alias-state-error-primary, #c0392b)',
        borderRadius: '8px',
        padding: '8px 12px',
        marginBottom: '12px',
        fontSize: '12px',
      },
      sectionTitle: { fontSize: '12px', fontWeight: 600, opacity: 0.85, marginTop: '14px', marginBottom: '6px' },
      mono: { fontFamily: 'var(--dsh-code-font-family, ui-monospace, monospace)', fontSize: '11px' },
      pre: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: '12px',
        margin: 0,
        maxHeight: '260px',
        overflow: 'auto',
        opacity: 0.85,
      },
      sessionRow: {
        display: 'flex',
        gap: '10px',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        padding: '4px 0',
        fontSize: '12px',
        borderTop: '1px solid var(--dsw-alias-menu-group-header-fill, rgba(127,127,127,0.18))',
      },
      featureRow: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '3px 0', fontSize: '12px' },
    }

    return {
      inject: ['connection', 'slots'],
      apply(ctx) {
        /** Locale lookup when the service accepted the namespace; null otherwise. */
        let lookup = null
        try {
          if (typeof ctx.locale?.register === 'function') {
            ctx.locale.register('relay', { zh: STRINGS, en: STRINGS_EN })
            if (typeof ctx.locale?.bind === 'function') {
              const bound = ctx.locale.bind('relay')
              if (typeof bound === 'function') lookup = bound
            }
          }
        } catch {
          /* keep the built-in strings */
        }

        /** Resolve one UI string. */
        const t = (key) => {
          if (lookup !== null) {
            const value = lookup(key)
            if (typeof value === 'string' && value.length > 0) return value
          }
          return STRINGS[key] ?? key
        }

        /**
         * Invoke one Host Remote method.
         * Transport failures reject; business failures arrive as `{ ok: false }`.
         */
        const call = (endpoint, args) => ctx.connection.rpc.call('/api', endpoint, { args: args ?? {} })
          .then((result) => {
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
            return result.value
          })

        /** Chain summary card with its two actions. */
        function ChainCard({ chain, open, onOpen, onAct, busy }) {
          const total = chain.featuresTotal ?? 0
          const done = chain.featuresDone ?? 0
          const width = total === 0 ? 0 : Math.round((done / total) * 100)
          return h('div', { style: styles.card },
            h('div', { style: styles.row },
              h('span', { style: { ...styles.chainTitle, cursor: 'pointer' }, onClick: onOpen },
                open ? '▾ ' : '▸ ', chain.title || chain.chainId),
              h('span', { style: styles.badge }, STATUS_LABELS[chain.status] ?? chain.status),
              h('span', { style: styles.meta }, `${t('progress')}: ${done}/${total}`),
              h('span', { style: styles.meta },
                `${t('current')}: `,
                h('span', { style: styles.mono }, chain.currentSessionId ?? t('none'))),
              h('span', { style: styles.spacer }),
              h('button', {
                style: styles.button,
                disabled: busy,
                onClick: () => { void onAct('relay/setPaused', { chainId: chain.chainId, paused: chain.status !== 'paused' }) },
              }, chain.status === 'paused' ? t('resume') : t('pause')),
              h('button', {
                style: styles.button,
                disabled: busy,
                onClick: () => {
                  if (window.confirm(t('confirmHandoff'))) void onAct('relay/handoffNow', { chainId: chain.chainId })
                },
              }, t('handoffNow')),
            ),
            h('div', { style: styles.bar }, h('div', { style: { ...styles.barFill, width: `${width}%` } })),
            h('div', { style: { ...styles.meta, marginTop: '6px' } },
              `${chain.handoffCount ?? 0}/${chain.maxHandoffs ?? 0} ${t('handoffs')} · ${t('objective')}: ${chain.objective}`),
            chain.lastError
              ? h('div', { style: { ...styles.meta, marginTop: '4px', opacity: 0.9 } }, `! ${chain.lastError}`)
              : null,
          )
        }

        /** Expanded detail of one chain. */
        function ChainDetail({ detail }) {
          const sessions = Array.isArray(detail.sessions) ? detail.sessions : []
          const features = Array.isArray(detail.features) ? detail.features : []
          return h('div', { style: styles.card },
            h('div', { style: styles.sectionTitle }, t('sessions')),
            sessions.length === 0 ? h('div', { style: styles.meta }, t('none')) : null,
            sessions.map(session => h('div', { key: session.sessionId, style: styles.sessionRow },
              h('span', { style: styles.mono }, session.sessionId),
              h('span', {}, ROLE_LABELS[session.role] ?? session.role),
              h('span', { style: styles.meta },
                session.retiredAt === null || session.retiredAt === undefined
                  ? (session.running ? 'running' : 'idle')
                  : `${t('retired')} · ${session.retireReason ?? ''}`),
              h('span', { style: styles.meta },
                session.loaded ? '' : t('cold')),
              h('span', { style: styles.meta },
                `${t('pressure')}: ${Math.round((session.pressureRatio ?? 0) * 100)}%`),
              h('span', { style: styles.meta }, `${t('compactions')}: ${session.compactions ?? 0}`),
            )),
            h('div', { style: styles.sectionTitle }, t('features')),
            features.length === 0 ? h('div', { style: styles.meta }, t('none')) : null,
            features.map(feature => h('div', { key: feature.id, style: styles.featureRow },
              h('span', { style: styles.mono }, feature.passes ? '✓' : '·', ' ', feature.id),
              h('span', { style: { opacity: feature.passes ? 0.6 : 1 } }, feature.title),
            )),
            h('div', { style: styles.sectionTitle }, t('handoff')),
            h('pre', { style: styles.pre }, detail.handoff || t('none')),
          )
        }

        /** The monitoring page. */
        function RelayPanel() {
          const [chains, setChains] = useState([])
          const [detail, setDetail] = useState(null)
          const [error, setError] = useState(null)
          const [loading, setLoading] = useState(true)
          const [busy, setBusy] = useState(false)
          const openId = useRef(null)

          const refresh = useCallback(async () => {
            try {
              const listed = await call('relay/listChains')
              const next = Array.isArray(listed?.chains) ? listed.chains : []
              const wanted = openId.current
              let nextDetail = null
              if (wanted !== null && next.some(chain => chain.chainId === wanted)) {
                nextDetail = await call('relay/chainDetail', { chainId: wanted })
              }
              setChains(next)
              setDetail(nextDetail)
              setError(null)
              setLoading(false)
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure))
              setLoading(false)
            }
          }, [])

          useEffect(() => {
            void refresh()
            const timer = setInterval(() => { void refresh() }, POLL_MS)
            return () => clearInterval(timer)
          }, [refresh])

          const act = useCallback(async (endpoint, args) => {
            setBusy(true)
            let failure = null
            try {
              await call(endpoint, args)
            } catch (error) {
              failure = error instanceof Error ? error.message : String(error)
            }
            setBusy(false)
            await refresh()
            if (failure !== null) setError(failure)
          }, [refresh])

          const openChain = (chainId) => {
            openId.current = openId.current === chainId ? null : chainId
            void refresh()
          }

          return h('div', { style: styles.page },
            h('div', { style: styles.toolbar },
              h('h2', { style: styles.title }, t('panel')),
              h('span', { style: styles.spacer }),
              h('button', { style: styles.button, onClick: () => { void refresh() } }, t('refresh')),
            ),
            error === null ? null : h('div', { style: styles.error }, `${t('failed')}: ${error}`),
            loading && chains.length === 0 ? h('div', { style: styles.meta }, t('loading')) : null,
            !loading && chains.length === 0 ? h('div', { style: styles.meta }, t('empty')) : null,
            chains.map(chain => h(ChainCard, {
              key: chain.chainId,
              chain,
              open: detail?.chain?.chainId === chain.chainId,
              onOpen: () => openChain(chain.chainId),
              onAct: act,
              busy,
            })),
            detail === null ? null : h(ChainDetail, { detail }),
          )
        }

        /** Sidebar entry icon. */
        function RelayIcon() {
          return h('svg', {
            viewBox: '0 0 24 24',
            width: 18,
            height: 18,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
            h('circle', { cx: 6, cy: 17, r: 2.6 }),
            h('circle', { cx: 18, cy: 7, r: 2.6 }),
            h('path', { d: 'M8.2 15.4c3-2 4.6-4.4 7.6-6.4' }),
            h('path', { d: 'M13.6 8.6l3.2-.2.2 3.2' }),
          )
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'relay',
        }, RelayPanel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'relay',
          order: 10,
          label: () => t('panel'),
        }, RelayIcon))
      },
    }
  },
})
