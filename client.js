/**
 * Browser half: the relay monitoring panel and the plugin page configuration card.
 *
 * Registered as a lazy module factory, so React comes from the harness module
 * table and no build step is involved. Data comes from the Host `relay` Remote
 * namespace through the existing `/api` RPC channel; nothing here reads files
 * or another plugin's DOM.
 *
 * Visual language follows the installed `dsh-context` "编队" (fleet) page:
 * a 20px page title with a kicker, KPI tiles in the header, layer-1 cards with
 * a 10px radius and 10–12px padding, a card title row with a trailing count,
 * and small task cards with a coloured top edge. Component styles render as one
 * `<style>` element so unmounting removes them.
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
      refresh: '刷新',
      openPluginPage: '插件设置',
      emptyTitle: '还没有接力任务',
      emptyBody: '长任务跑久了上下文会满。开一条链后，接近上限时先让当前会话收尾，再开一个干净的会话接手。',
      step1Title: '让模型开始一条链',
      step1Body: '在任意会话里说一句，或者直接调用工具。',
      step2Title: '模型写真理源',
      step2Body: '功能清单、进度、交接说明写进工作区的 .relay/ 目录。',
      step3Title: '自动收尾与交接',
      step3Body: '到阈值时收尾，下一次空闲创建新会话并交接；这里可以暂停或手动交接。',
      copyExample: '复制示例',
      copied: '已复制',
      example: '用 relay_start 开始这个长任务：把订单导出从 CSV 改成流式 XLSX，覆盖 3 个入口，全部要有测试',
      statActive: '进行中',
      statDone: '已完成',
      statSessions: '会话',
      statHandoffs: '交接',
      statChains: '任务链',
      statPaused: '已暂停',
      statProgress: '功能进度',
      statContext: '最高上下文',
      statContextSub: '当前会话占用',
      statBlocked: '被阻塞',
      chains: '任务链',
      loading: '加载中…',
      failed: '读取失败',
      retry: '重试',
      selectChain: '从左侧选择一条链',
      selectChainBody: '这里显示它的会话时间线、功能清单和交接说明。',
      overview: '概览',
      objective: '目标',
      progress: '进度',
      sessions: '会话',
      features: '功能清单',
      handoff: '交接说明',
      pause: '暂停',
      resume: '恢复',
      handoffNow: '立即交接',
      confirmHandoff: '现在创建新会话接管这条链？',
      none: '无',
      retired: '已退役',
      pressure: '上下文',
      compactions: '压缩',
      noFeatures: '还没有功能清单',
      noHandoff: '还没有交接说明',
      partialCoverage: '部分验证',
      acceptedByHuman: '人工接受',
      configTitle: '长任务接力设置',
      configNote: '修改会写进当前 profile 的 cordis.patch.yml，保存后插件按新配置重载。',
      save: '保存',
      reset: '还原',
      saved: '已保存，插件正在用新配置重载',
      readonlyHost: '当前 Host 不能编辑 profile 配置',
      tabChildren: '下游',
      tabTasks: '我的任务',
      noChainTitle: '当前会话不属于任何接力链',
      noChainBody: '从会话里调用 relay_start 开始一条链。',
      noChildrenTitle: '还没有派发过子会话',
      noChildrenBody: '用 relay_spawn 把一部分功能交给新的子会话并行执行，这里会显示它们的执行情况。',
      parentTitle: '上级会话',
      assignedTitle: '我负责的功能',
      noParentTitle: '当前会话是链的根会话',
      noParentBody: '没有上级会话给它下发任务。',
      childFeatures: '负责功能',
      open: '打开',
      childCount: '子会话',
      audit: '审计',
      noAudit: '还没有审计记录',
      roleLabel: '角色',
      statusLabel: '状态',
      featuresLabel: '功能',
      decisions: '待决策',
      decisionApproval: '等待审批',
      decisionQuestion: '等待回答',
      decisionNone: '没有待处理的人工决策',
      questions: '个问题',
      decisionShort: '待决策',
      goalTitle: '当前目标',
      noGoal: '这个会话没有目标',
      goalArmed: '自动继续',
      goalDisarmed: '不自动继续',
    }

    const STRINGS_EN = {
      panel: 'Long-task relay',
      refresh: 'Refresh',
      openPluginPage: 'Plugin settings',
      emptyTitle: 'No relay chain yet',
      emptyBody: 'Long tasks fill their context window. Start a chain and the plugin closes the current session at the limit, then opens a clean one.',
      step1Title: 'Start a chain from a session',
      step1Body: 'Ask the model in any session, or have it call the tool directly.',
      step2Title: 'The model writes the truth source',
      step2Body: 'Features, progress, and the handoff brief land in the workspace .relay/ directory.',
      step3Title: 'Wrap up and hand off automatically',
      step3Body: 'The session wraps up at the threshold; the next idle opens a fresh session and hands over.',
      copyExample: 'Copy example',
      copied: 'Copied',
      example: 'Use relay_start for this long task: convert the order export from CSV to streaming XLSX across three entry points, with tests',
      statActive: 'Active',
      statDone: 'Done',
      statSessions: 'Sessions',
      statHandoffs: 'Handoffs',
      statChains: 'Chains',
      statPaused: 'Paused',
      statProgress: 'Feature progress',
      statContext: 'Peak context',
      statContextSub: 'current session usage',
      statBlocked: 'Blocked',
      chains: 'Chains',
      loading: 'Loading…',
      failed: 'Read failed',
      retry: 'Retry',
      selectChain: 'Select a chain on the left',
      selectChainBody: 'Its session timeline, feature list, and handoff brief appear here.',
      overview: 'Overview',
      objective: 'Objective',
      progress: 'Progress',
      sessions: 'Sessions',
      features: 'Features',
      handoff: 'Handoff brief',
      pause: 'Pause',
      resume: 'Resume',
      handoffNow: 'Hand off now',
      confirmHandoff: 'Create a fresh session and hand this chain over now?',
      none: 'none',
      retired: 'retired',
      pressure: 'context',
      compactions: 'compactions',
      noFeatures: 'No features recorded yet',
      noHandoff: 'No handoff brief yet',
      partialCoverage: 'Partial proof',
      acceptedByHuman: 'Accepted by human',
      configTitle: 'Long-task relay settings',
      configNote: 'Saving writes the active profile cordis.patch.yml and reloads the plugin with the new values.',
      save: 'Save',
      reset: 'Reset',
      saved: 'Saved; the plugin is reloading with the new configuration',
      readonlyHost: 'This Host cannot edit profile configuration',
      tabChildren: 'Downstream',
      tabTasks: 'My tasks',
      noChainTitle: 'This session is not in a relay chain',
      noChainBody: 'Call relay_start from a session to open one.',
      noChildrenTitle: 'Nothing delegated yet',
      noChildrenBody: 'Use relay_spawn to hand part of the work to a fresh child session; its progress appears here.',
      parentTitle: 'Parent session',
      assignedTitle: 'Features you own',
      noParentTitle: 'This session is the root of its chain',
      noParentBody: 'No parent session delegated work to it.',
      childFeatures: 'features',
      open: 'Open',
      childCount: 'children',
      audit: 'Audit',
      noAudit: 'No audit records yet',
      roleLabel: 'role',
      statusLabel: 'status',
      featuresLabel: 'features',
      decisions: 'Awaiting decision',
      decisionApproval: 'Approval',
      decisionQuestion: 'Question',
      decisionNone: 'No pending human decisions',
      questions: 'questions',
      decisionShort: 'decide',
      goalTitle: 'Goal',
      noGoal: 'This session has no goal',
      goalArmed: 'armed',
      goalDisarmed: 'not continuing',
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

    const COVERAGE_LABELS = {
      full: '完整验证',
      partial: '部分验证',
      'error-path-only': '仅错误路径',
      smoke: '冒烟',
    }

    const BLOCKER_LABELS = {
      external: '等待人工',
      code: '代码阻塞',
      decision: '待决策',
    }

    const GOAL_PHASE_LABELS = {
      active: '进行中',
      paused: '已暂停',
      blocked: '被阻塞',
      complete: '已完成',
    }

    /** Status classes reused by the goal pill. */
    const GOAL_TONES = {
      active: 'active',
      paused: 'paused',
      blocked: 'failed',
      complete: 'done',
    }

    /** Editable settings, grouped for the plugin page card. */
    const CONFIG_GROUPS = [
      {
        title: '交接触发',
        fields: [
          { key: 'handoffRatio', kind: 'number', min: 0.1, max: 0.95, step: 0.01, hint: '收尾后仍到这个比例就强制交接，必须低于 DSH 自动压缩的阈值（默认 0.8）' },
          { key: 'wrapupRatio', kind: 'number', min: 0.1, max: 0.9, step: 0.01, hint: '进入收尾阶段的比例，必须低于交接比例' },
          { key: 'handoffAfterCompactions', kind: 'int', min: 1, hint: '压缩过几次后，达到下面的比例也触发收尾' },
          { key: 'compactedRatioFloor', kind: 'number', min: 0.1, max: 0.9, step: 0.01, hint: '已压缩过的会话触发收尾的最低比例' },
          { key: 'hardCompactions', kind: 'int', min: 1, hint: '压缩达到几次后不等边界，直接交接' },
          { key: 'wrapupTimeoutMinutes', kind: 'int', min: 1, hint: '收尾后空闲多少分钟仍然强制交接' },
          { key: 'cooldownMs', kind: 'int', min: 0, hint: '同一会话两次判定的最小间隔（毫秒）' },
        ],
      },
      {
        title: '行为',
        fields: [
          { key: 'autoHandoff', kind: 'boolean', hint: '允许自动收尾与交接；关掉后只能手动操作' },
          { key: 'maxHandoffs', kind: 'int', min: 1, hint: '单条链的交接次数上限' },
          { key: 'pauseGoalOnRetire', kind: 'boolean', hint: '交接后暂停旧会话的 goal' },
          { key: 'seedGoalOnHandoff', kind: 'boolean', hint: '交接后给新会话建一个 goal，让它按目标轮次自动继续；需要目标功能可用' },
          { key: 'goalRoundsPerHandoff', kind: 'int', min: 1, hint: '给新会话 goal 分配的续轮上限' },
          { key: 'notifyOldSession', kind: 'boolean', hint: '交接后给旧会话留一条退役说明' },
          { key: 'truthDir', kind: 'text', hint: '真理源目录，相对工作区' },
          { key: 'agentPreset', kind: 'text', hint: '新会话使用的 preset；留空继承当前会话' },
        ],
      },
    ]

    /** Card dashboard styles, modelled on the dsh-context fleet page. */
    const CSS = `
.relay-page { box-sizing: border-box; display: flex; flex-direction: column; width: 100%; min-width: 0; height: 100%; min-height: 0; overflow: hidden; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.relay-scroll { flex: auto; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
.relay-content { padding: 0 10px 12px; }
.relay-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding-top: 16px; margin-bottom: 10px; }
.relay-head-main { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.relay-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; white-space: nowrap; }
.relay-head-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.relay-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.relay-kpi { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 9px 12px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
body:not([data-ds-dark-theme]) .relay-kpi { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
.relay-kpi-label { color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-weight: 600; line-height: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.relay-kpi-value { color: var(--dsw-alias-label-primary); font-size: 22px; font-weight: 600; line-height: 28px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.relay-kpi-sub { color: var(--dsw-alias-label-tertiary); font-size: 10.5px; line-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.relay-kpi.is-success .relay-kpi-value { color: var(--dsw-alias-state-success-primary); }
.relay-kpi.is-business .relay-kpi-value { color: var(--dsw-alias-state-business-primary); }
.relay-kpi.is-brand .relay-kpi-value { color: var(--dsw-alias-brand-primary); }
.relay-kpi.is-warn .relay-kpi-value { color: var(--dsw-alias-state-warn-primary); }
.relay-body { display: flex; flex-direction: column; gap: 12px; }
.relay-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; gap: 12px; }
.relay-detail-grid > .relay-card { margin-bottom: 0; }
.relay-detail-grid > .is-wide { grid-column: 1 / -1; }
.relay-card { box-sizing: border-box; margin-bottom: 12px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
body:not([data-ds-dark-theme]) .relay-card { border-radius: 12px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
.relay-card-title { display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; margin-bottom: 10px; font-weight: 600; }
body:not([data-ds-dark-theme]) .relay-card-title { border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 7px; }
.relay-card-title-text { display: inline-flex; align-items: center; gap: 6px; flex: none; white-space: nowrap; }
.relay-card-title-text svg { flex: none; color: var(--dsw-alias-label-secondary); }
.relay-card-sub { min-width: 0; margin-left: auto; overflow: hidden; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.relay-btn { box-sizing: border-box; height: 22px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px; line-height: 20px; white-space: nowrap; cursor: pointer; transition: border-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out), background-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.relay-btn:hover { border-color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
.relay-btn:disabled { opacity: 0.45; cursor: default; }
.relay-btn.is-primary { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.relay-error { display: flex; align-items: flex-start; gap: 7px; margin-bottom: 12px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.relay-chains { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); align-items: stretch; gap: 10px; margin: 0; padding: 0; list-style: none; }
.relay-chain-card { --relay-hue: var(--dsw-alias-border-l3); box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-top: 2px solid var(--relay-hue); border-radius: 10px; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: border-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out), background-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out), box-shadow var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
body:not([data-ds-dark-theme]) .relay-chain-card { border-radius: 12px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
.relay-chain-card:hover { border-color: var(--dsw-alias-border-l4); background: var(--dsw-alias-interactive-bg-hover); }
.relay-chain-card.is-selected { border-color: var(--relay-hue); background: color-mix(in srgb, var(--relay-hue) 8%, var(--dsw-alias-bg-layer-1)); }
.relay-chain-card.is-active { --relay-hue: var(--dsw-alias-state-success-primary); }
.relay-chain-card.is-paused, .relay-chain-card.is-initializing { --relay-hue: var(--dsw-alias-state-warn-primary); }
.relay-chain-card.is-failed { --relay-hue: var(--dsw-alias-state-error-primary); }
.relay-chain-card.is-done { --relay-hue: var(--dsw-alias-state-business-primary); }
.relay-chain-head { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.relay-chain-title { flex: 1 1 0; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-size: 12.5px; font-weight: 600; line-height: 1.4; }
.relay-chain-badge { flex: none; margin-top: 1px; padding: 0 5px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 15px; white-space: nowrap; }
.relay-chain-crumb { display: flex; align-items: center; gap: 5px; min-width: 0; overflow: hidden; color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }
.relay-chain-body { display: flex; align-items: center; gap: 14px; min-width: 0; }
.relay-chain-stats { display: flex; flex-direction: column; gap: 3px; flex: 1 1 auto; max-width: 190px; min-width: 0; }
.relay-mini-stat { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; font-size: 11px; }
.relay-mini-label { flex: none; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.relay-mini-value { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.relay-chain-preview { display: flex; align-items: baseline; gap: 6px; min-width: 0; margin-top: auto; padding-top: 6px; border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 60%, transparent); }
.relay-chain-preview-label { flex: none; color: var(--dsw-alias-label-secondary); font-size: 10px; }
.relay-chain-preview-text { flex: 0 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.relay-donut { position: relative; flex: none; }
.relay-donut svg { display: block; }
.relay-donut-track { stroke: color-mix(in srgb, var(--color-neutral-500, var(--dsw-alias-border-l2)) 22%, transparent); }
.relay-donut-fill { stroke: var(--relay-hue, var(--dsw-alias-state-success-primary)); transition: stroke-dasharray var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.relay-donut-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; text-align: center; pointer-events: none; }
.relay-donut-center b { font-size: 12px; line-height: 1.15; font-variant-numeric: tabular-nums; }
.relay-donut-center span { color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 1.2; white-space: nowrap; }
.relay-chip { display: inline-flex; align-items: center; height: 16px; padding: 0 5px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 9.5px; font-weight: 600; white-space: nowrap; }
.relay-chip.is-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-warn-primary); }
.relay-chip.is-human { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-business-primary); }
.relay-status { display: inline-flex; align-items: center; height: 18px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 16px; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.relay-status.is-active { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.relay-status.is-paused, .relay-status.is-initializing { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.relay-status.is-failed { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.relay-status.is-done { color: var(--dsw-alias-state-business-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.relay-detail-head { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
.relay-detail-title { flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 600; line-height: 18px; overflow-wrap: anywhere; }
.relay-actions { display: flex; flex: none; gap: 6px; }
.relay-text { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
.relay-metas { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.relay-meta { display: flex; flex-direction: column; flex: 0 1 118px; min-width: 78px; gap: 1px; padding: 5px 7px; border: 1px solid var(--dsw-alias-border-l2); border-left-width: 2px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.relay-meta.is-brand { border-left-color: var(--dsw-alias-brand-primary); }
.relay-meta.is-success { border-left-color: var(--dsw-alias-state-success-primary); }
.relay-meta.is-warn { border-left-color: var(--dsw-alias-state-warn-primary); }
.relay-meta.is-error { border-left-color: var(--dsw-alias-state-error-primary); }
.relay-meta.is-business { border-left-color: var(--dsw-alias-state-business-primary); }
.relay-meta-value { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; line-height: 17px; font-variant-numeric: tabular-nums; }
.relay-meta.is-success .relay-meta-value { color: var(--dsw-alias-state-success-primary); }
.relay-meta.is-warn .relay-meta-value { color: var(--dsw-alias-state-warn-primary); }
.relay-meta.is-error .relay-meta-value { color: var(--dsw-alias-state-error-primary); }
.relay-meta.is-business .relay-meta-value { color: var(--dsw-alias-state-business-primary); }
.relay-meta-label { color: var(--dsw-alias-label-secondary); font-size: 10.5px; line-height: 14px; white-space: nowrap; }
.relay-bar { height: 4px; margin-top: 10px; border-radius: 999px; background: var(--dsw-alias-border-l2); overflow: hidden; }
.relay-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--dsw-alias-state-success-primary), var(--dsw-alias-brand-primary)); }
.relay-blocker { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2); border-left: 2px solid var(--dsw-alias-state-warn-primary); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 17px; overflow-wrap: anywhere; }
.relay-blocker.is-external { border-left-color: var(--dsw-alias-state-error-primary); }
.relay-blocker-kind { flex: none; color: var(--dsw-alias-state-warn-primary); font-weight: 600; }
.relay-blocker.is-external .relay-blocker-kind { color: var(--dsw-alias-state-error-primary); }
.relay-rows { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.relay-session { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; padding: 5px 0; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; line-height: 17px; }
.relay-session:first-child { border-top: none; padding-top: 0; }
.relay-mono { overflow: hidden; color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.relay-tag { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.relay-feature { display: grid; grid-template-columns: 14px 42px minmax(0, 1fr); align-items: baseline; column-gap: 7px; padding: 4px 0; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; line-height: 17px; }
.relay-feature:first-child { border-top: none; padding-top: 0; }
.relay-check { color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px; }
.relay-feature.is-done .relay-check { color: var(--dsw-alias-state-success-primary); }
.relay-feature-title { overflow-wrap: anywhere; }
.relay-feature.is-done .relay-feature-title { color: var(--dsw-alias-label-secondary); }
.relay-feature-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.relay-feature-evidence { grid-column: 3; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.relay-empty { display: flex; flex-direction: column; gap: 8px; padding: 8px 2px 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.relay-empty-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; line-height: 18px; }
.relay-steps { display: flex; flex-direction: column; gap: 8px; }
.relay-step { display: flex; gap: 8px; align-items: flex-start; }
.relay-step-index { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 10.5px; font-weight: 600; }
.relay-step-title { color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; }
.relay-example { margin-top: 2px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11.5px; line-height: 17px; white-space: pre-wrap; word-break: break-word; }
.relay-config { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-primary); font-size: 13px; }
.relay-config-head { display: flex; align-items: baseline; gap: 8px; }
.relay-config-title { font-size: 13px; font-weight: 600; line-height: 18px; }
.relay-config-note { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.relay-group { display: flex; flex-direction: column; margin-top: 8px; }
.relay-group-title { margin: 0 0 2px; color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; line-height: 16px; letter-spacing: 0.04em; text-transform: uppercase; }
.relay-field { display: grid; grid-template-columns: minmax(0, 1fr) 140px; align-items: center; gap: 12px; padding: 6px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.relay-field-label { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.relay-field-name { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11.5px; line-height: 17px; }
.relay-field-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.relay-input { box-sizing: border-box; width: 100%; height: 24px; padding: 0 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 11.5px; }
.relay-input:focus { outline: none; border-color: var(--dsw-alias-label-secondary); }
.relay-check-field { display: flex; justify-content: flex-end; }
.relay-config-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.relay-config-status { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px; }
.relay-config-status.is-error { color: var(--dsw-alias-state-error-primary); }
.relay-config-status.is-ok { color: var(--dsw-alias-state-success-primary); }
.relay-tab { box-sizing: border-box; height: 100%; overflow-y: auto; padding: 16px 10px 12px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.relay-tab-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.relay-children { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); align-items: stretch; gap: 10px; }
.relay-task-grid { display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr); align-items: start; gap: 12px; }
.relay-task-grid > .relay-card { margin-bottom: 0; }
.relay-children > .relay-child { margin-bottom: 0; }
.relay-child { --relay-hue: var(--dsw-alias-border-l3); box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-left: 2px solid var(--relay-hue); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.relay-child.is-active { --relay-hue: var(--dsw-alias-state-success-primary); }
.relay-child.is-paused { --relay-hue: var(--dsw-alias-state-warn-primary); }
.relay-child.is-done { --relay-hue: var(--dsw-alias-state-business-primary); }
.relay-child.is-failed { --relay-hue: var(--dsw-alias-state-error-primary); }
body:not([data-ds-dark-theme]) .relay-child { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
.relay-child-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.relay-child .relay-metas { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-top: 0; }
.relay-child .relay-meta { flex: none; min-width: 0; }
.relay-audit { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.relay-audit-row { display: grid; grid-template-columns: 52px 104px minmax(0, 1fr); align-items: baseline; column-gap: 8px; padding: 4px 0; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 11.5px; line-height: 16px; }
.relay-audit-row:first-child { border-top: none; padding-top: 0; }
.relay-audit-time { color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 10.5px; white-space: nowrap; }
.relay-audit-kind { overflow: hidden; color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.relay-audit-detail { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.relay-audit-row.is-key .relay-audit-kind { color: var(--dsw-alias-state-success-primary); }
.relay-audit-row.is-warn .relay-audit-kind { color: var(--dsw-alias-state-warn-primary); }
.relay-decisions { display: flex; flex-direction: column; gap: 6px; }
.relay-decision { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, var(--dsw-alias-border-l2)); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, var(--dsw-alias-bg-layer-1)); }
.relay-decision-main { display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 2px; }
.relay-decision-kicker { color: var(--dsw-alias-state-warn-primary); font-size: 10px; font-weight: 600; letter-spacing: 0.06em; line-height: 14px; text-transform: uppercase; }
.relay-decision-text { font-size: 11.5px; line-height: 16px; overflow-wrap: anywhere; }
.relay-decision-session { overflow: hidden; color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 10px; line-height: 14px; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 900px) {
  .relay-task-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 1000px) {
  .relay-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .relay-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .relay-tab-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .relay-chains { grid-template-columns: minmax(0, 1fr); }
  .relay-children { grid-template-columns: minmax(0, 1fr); }
  .relay-detail-grid { grid-template-columns: minmax(0, 1fr); }
}
`

    return {
      inject: ['connection', 'slots', 'layout', 'uiWorkspace'],
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

        /**
         * Open this bundle's page in the Plugins panel.
         * `pluginNavigation` needs the Plugins page mounted, so the fallback
         * only switches to the panel itself.
         */
        const openPluginPage = () => {
          const navigation = ctx.get('pluginNavigation')
          if (navigation !== undefined && typeof navigation.openBundle === 'function') {
            try {
              navigation.openBundle('@local/longtask-relay')
              return
            } catch {
              /* fall through to the panel switch */
            }
          }
          try {
            ctx.layout.selectPanel('plugins')
          } catch {
            /* the Plugins panel is unavailable in this shell */
          }
        }

        /** Focus another session, when the shell can navigate. */
        const openSession = (sessionId) => {
          if (typeof sessionId !== 'string' || sessionId.length === 0) return
          try {
            ctx.uiWorkspace.openSession(sessionId)
          } catch {
            /* navigation unavailable */
          }
        }

        /**
         * Pending human decisions, keyed by request.
         * The built-in composer card stays the answering surface; these
         * handlers only observe so the panel can list and link to them.
         */
        const pendingDecisions = new Map()
        const decisionListeners = new Set()

        /** Push the current decision list to every mounted listener. */
        function publishDecisions() {
          const snapshot = [...pendingDecisions.values()]
          for (const listener of decisionListeners) {
            try {
              listener(snapshot)
            } catch {
              /* one listener must not break the stream */
            }
          }
        }

        /** The session id a remote-event handler runs for, when resolvable. */
        function scopeSessionId(scope) {
          try {
            return ctx.get('sessions')?.scopeOf?.(scope) ?? null
          } catch {
            return null
          }
        }

        /**
         * Track approval and question requests for every session.
         * `next()` delegates to the built-in answerer, so this never takes
         * the decision away from the composer; the entry drops when it settles.
         */
        function watchDecisions() {
          let remote
          try {
            remote = ctx.get('remote')
          } catch {
            return
          }
          if (remote === undefined || typeof remote.$on !== 'function') return

          const track = (key, entry, next) => {
            pendingDecisions.set(key, entry)
            publishDecisions()
            const settled = typeof next === 'function' ? next() : undefined
            const drop = () => {
              if (pendingDecisions.delete(key)) publishDecisions()
            }
            if (settled !== undefined && typeof settled.finally === 'function') settled.finally(drop)
            else drop()
            return settled
          }

          remote.$on('approval/request', function (request, next) {
            const sessionId = scopeSessionId(this)
            const key = `approval:${sessionId ?? 'unknown'}:${request?.callId ?? Math.random().toString(36).slice(2)}`
            return track(key, {
              key,
              kind: 'approval',
              sessionId,
              title: request?.displayReason ?? request?.reason ?? request?.toolName ?? '',
              detail: request?.toolName ?? '',
            }, next)
          })

          remote.$on('user-questions/request', function (request, next) {
            const sessionId = scopeSessionId(this)
            const questions = Array.isArray(request?.questions) ? request.questions : []
            const key = `question:${sessionId ?? 'unknown'}:${Date.now().toString(36)}`
            const first = questions[0]
            return track(key, {
              key,
              kind: 'question',
              sessionId,
              title: first === undefined ? t('decisionQuestion') : String(first.question ?? first.title ?? ''),
              detail: questions.length > 1 ? `${questions.length} ${t('questions')}` : '',
            }, next)
          })
        }

        /** Subscribe a component to the pending decision list. */
        function usePendingDecisions() {
          const [list, setList] = useState([])
          useEffect(() => {
            const listener = snapshot => setList(snapshot)
            decisionListeners.add(listener)
            listener([...pendingDecisions.values()])
            return () => { decisionListeners.delete(listener) }
          }, [])
          return list
        }

        /** Sidebar and card-title icon. */
        function RelayIcon({ size = 14 }) {
          return h('svg', {
            viewBox: '0 0 24 24',
            width: size,
            height: size,
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

        /** Card title with an icon, a label, and a trailing count. */
        function CardTitle({ children, sub, icon = true }) {
          return h('div', { className: 'relay-card-title' },
            icon ? h('span', { className: 'relay-card-title-text' }, h(RelayIcon, { size: 14 }), children) : children,
            sub === undefined || sub === null ? null : h('span', { className: 'relay-card-sub' }, sub),
          )
        }

        /** Ring showing a 0–1 ratio, centred on a short label. */
        function Donut({ ratio, label, size = 52 }) {
          const stroke = 5
          const radius = (size - stroke) / 2
          const circumference = 2 * Math.PI * radius
          const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
          const filled = clamped * circumference
          return h('div', { className: 'relay-donut', style: { width: `${size}px`, height: `${size}px` } },
            h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true },
              h('circle', {
                className: 'relay-donut-track',
                cx: size / 2, cy: size / 2, r: radius, fill: 'none', strokeWidth: stroke,
              }),
              h('circle', {
                className: 'relay-donut-fill',
                cx: size / 2, cy: size / 2, r: radius, fill: 'none', strokeWidth: stroke,
                strokeDasharray: `${filled} ${circumference}`,
                strokeLinecap: 'round',
                transform: `rotate(-90 ${size / 2} ${size / 2})`,
              }),
            ),
            h('div', { className: 'relay-donut-center' },
              h('b', {}, label),
              h('span', {}, `${Math.round(clamped * 100)}%`),
            ),
          )
        }

        /** First-run guidance shown when no chain exists yet. */
        function EmptyState() {
          const [copied, setCopied] = useState(false)
          const copy = () => {
            try {
              void Promise.resolve(navigator.clipboard?.writeText(t('example')))
                .then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                })
                .catch(() => undefined)
            } catch {
              /* clipboard unavailable */
            }
          }
          const steps = [
            { title: t('step1Title'), body: t('step1Body') },
            { title: t('step2Title'), body: t('step2Body') },
            { title: t('step3Title'), body: t('step3Body') },
          ]
          return h('div', { className: 'relay-empty' },
            h('div', { className: 'relay-empty-title' }, t('emptyTitle')),
            h('div', {}, t('emptyBody')),
            h('div', { className: 'relay-steps' },
              steps.map((step, index) => h('div', { key: step.title, className: 'relay-step' },
                h('span', { className: 'relay-step-index' }, String(index + 1)),
                h('div', {},
                  h('div', { className: 'relay-step-title' }, step.title),
                  h('div', {}, step.body),
                ),
              )),
            ),
            h('div', { className: 'relay-example' }, t('example')),
            h('div', {},
              h('button', { className: 'relay-btn', onClick: copy }, copied ? t('copied') : t('copyExample')),
            ),
          )
        }

        /** One chain card in the left column. */
        function ChainCard({ chain, selected, onSelect }) {
          const total = chain.featuresTotal ?? 0
          const done = chain.featuresDone ?? 0
          const ratio = total === 0 ? 0 : done / total
          const sessions = Array.isArray(chain.sessionsDetail) ? chain.sessionsDetail : []
          const peak = sessions.reduce((max, session) => Math.max(max, session.pressureRatio ?? 0), 0)
          const folder = typeof chain.cwd === 'string'
            ? chain.cwd.split(/[\\/]/).filter(Boolean).pop() ?? chain.cwd
            : ''
          return h('li', {},
            h('button', {
              type: 'button',
              className: `relay-chain-card is-${chain.status}${selected ? ' is-selected' : ''}`,
              onClick: () => onSelect(chain.chainId),
            },
              h('span', { className: 'relay-chain-head' },
                h('span', { className: 'relay-chain-title' }, chain.title || chain.chainId),
                h('span', { className: 'relay-chain-badge' }, STATUS_LABELS[chain.status] ?? chain.status),
              ),
              h('span', { className: 'relay-chain-crumb' }, folder),
              h('span', { className: 'relay-chain-body' },
                h(Donut, { ratio, label: `${done}/${total}` }),
                h('span', { className: 'relay-chain-stats' },
                  h('span', { className: 'relay-mini-stat' },
                    h('span', { className: 'relay-mini-label' }, t('statHandoffs')),
                    h('span', { className: 'relay-mini-value' }, `${chain.handoffCount ?? 0}/${chain.maxHandoffs ?? 0}`),
                  ),
                  h('span', { className: 'relay-mini-stat' },
                    h('span', { className: 'relay-mini-label' }, t('sessions')),
                    h('span', { className: 'relay-mini-value' }, String(chain.sessions ?? sessions.length)),
                  ),
                  h('span', { className: 'relay-mini-stat' },
                    h('span', { className: 'relay-mini-label' }, t('statContext')),
                    h('span', { className: 'relay-mini-value' }, `${Math.round(peak * 100)}%`),
                  ),
                ),
              ),
              h('span', { className: 'relay-chain-preview' },
                h('span', { className: 'relay-chain-preview-label' }, t('objective')),
                h('span', { className: 'relay-chain-preview-text' }, chain.objective ?? ''),
              ),
            ),
          )
        }

        /** One row of the session timeline. */
        function SessionRow({ session }) {
          const retired = session.retiredAt !== null && session.retiredAt !== undefined
          return h('li', { className: 'relay-session' },
            h('span', { className: 'relay-mono' }, session.sessionId),
            h('span', { className: 'relay-tag' }, ROLE_LABELS[session.role] ?? session.role),
            h('span', { className: 'relay-tag' },
              retired
                ? `${t('retired')} · ${session.retireReason ?? ''}`
                : `${session.running ? 'running' : 'idle'} · ${session.compactions ?? 0} ${t('compactions')} · ${Math.round((session.pressureRatio ?? 0) * 100)}%`),
          )
        }

        /** One row of the feature list. */
        function FeatureRow({ feature }) {
          const coverage = typeof feature.coverage === 'string' ? feature.coverage : null
          const showsCoverage = coverage !== null && coverage !== 'full'
          const accepted = feature.acceptedBy === 'human'
          return h('li', { className: `relay-feature${feature.passes ? ' is-done' : ''}` },
            h('span', { className: 'relay-check' }, feature.passes ? '✓' : '·'),
            h('span', { className: 'relay-mono' }, feature.id),
            h('div', {},
              h('span', { className: 'relay-feature-title' }, feature.title),
              showsCoverage || accepted
                ? h('div', { className: 'relay-feature-tags' },
                  showsCoverage
                    ? h('span', { className: 'relay-chip is-warn' }, COVERAGE_LABELS[coverage] ?? coverage)
                    : null,
                  accepted ? h('span', { className: 'relay-chip is-human' }, t('acceptedByHuman')) : null,
                )
                : null,
            ),
            feature.passes && feature.evidence
              ? h('span', { className: 'relay-feature-evidence' }, feature.evidence)
              : null,
          )
        }

        /** Local wall-clock text for an audit timestamp. */
        function auditTime(at) {
          if (typeof at !== 'string') return ''
          const date = new Date(at)
          return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour12: false })
        }

        /** One readable line for an audit record. */
        function auditDetail(record) {
          const detail = record.detail ?? {}
          switch (record.kind) {
            case 'chain.started': return `maxHandoffs ${detail.maxHandoffs ?? '?'}`
            case 'chain.paused': return 'paused'
            case 'chain.resumed': return 'resumed'
            case 'chain.finished': return detail.evidence ?? ''
            case 'feature.passed': return `${detail.id} · ${COVERAGE_LABELS[detail.coverage] ?? detail.coverage ?? ''}`
            case 'feature.reopened': return `${detail.id} reopened`
            case 'feature.assigned': return `${detail.id} → ${detail.to ?? 'unassigned'}`
            case 'feature.added': return `${detail.id} · ${detail.reason ?? ''}`
            case 'delegation.created': return `${detail.childSessionId} · ${(detail.features ?? []).join(', ')}`
            case 'delegation.failed': return detail.error ?? ''
            case 'blocker.set': return `${BLOCKER_LABELS[detail.kind] ?? detail.kind ?? ''} · ${detail.action ?? ''}`
            case 'blocker.cleared': return 'cleared'
            case 'session.ready': return 'wrapped up'
            case 'goal.seeded': return `${detail.rounds ?? '?'} rounds`
            case 'supervisor.decision': return `${detail.action} · ${detail.reason ?? detail.by ?? ''} · ${Math.round((detail.ratio ?? 0) * 100)}%`
            case 'handoff.started': return `${detail.from} → …`
            case 'handoff.completed': return `${detail.from} → ${detail.to}`
            case 'handoff.failed': return detail.error ?? ''
            default: return ''
          }
        }

        /** Colour class for one audit kind. */
        function auditTone(kind) {
          if (typeof kind !== 'string') return ''
          if (kind.endsWith('.failed') || kind === 'blocker.set') return 'is-error'
          if (kind === 'feature.passed' || kind === 'chain.finished' || kind === 'handoff.completed' || kind === 'delegation.created') return 'is-key'
          if (kind.startsWith('supervisor.') || kind === 'chain.paused' || kind === 'session.ready') return 'is-warn'
          return ''
        }

        /** Last audit page seen per chain, so a revisit renders before the poll. */
        const auditCache = new Map()

        /** Newest audit records for one chain, newest first. */
        function AuditCard({ chainId }) {
          const [records, setRecords] = useState(() => auditCache.get(chainId) ?? null)
          const [error, setError] = useState(null)
          useEffect(() => {
            let live = true
            setRecords(auditCache.get(chainId) ?? null)
            const load = () => {
              call('relay/chainAudit', { chainId, limit: 60 })
                .then((value) => {
                  if (!live) return
                  const next = Array.isArray(value) ? value : []
                  auditCache.set(chainId, next)
                  setRecords(next)
                  setError(null)
                })
                .catch(failure => { if (live) setError(failure instanceof Error ? failure.message : String(failure)) })
            }
            load()
            const timer = setInterval(load, 10_000)
            return () => { live = false; clearInterval(timer) }
          }, [chainId])
          const rows = records === null ? [] : records.slice().reverse()
          const body = (() => {
            if (error !== null) return h('div', { className: 'relay-text' }, `${t('failed')}: ${error}`)
            if (records === null) return h('div', { className: 'relay-text' }, t('loading'))
            if (rows.length === 0) return h('div', { className: 'relay-text' }, t('noAudit'))
            return h('ul', { className: 'relay-audit' }, rows.map((record, index) => h('li', {
              key: `${record.at ?? ''}-${index}`,
              className: `relay-audit-row ${auditTone(record.kind)}`,
            },
              h('span', { className: 'relay-audit-time' }, auditTime(record.at)),
              h('span', { className: 'relay-audit-kind' }, record.kind),
              h('span', { className: 'relay-audit-detail' }, auditDetail(record)),
            )))
          })()
          return h('section', { className: 'relay-card is-wide' },
            h(CardTitle, { sub: rows.length === 0 ? null : String(rows.length) }, t('audit')),
            body,
          )
        }

        /** Right-hand cards for the selected chain. */
        function ChainDetail({ detail, onAct, busy }) {
          const chain = detail.chain ?? {}
          const sessions = Array.isArray(detail.sessions) ? detail.sessions : []
          const features = Array.isArray(detail.features) ? detail.features : []
          const total = chain.featuresTotal ?? features.length
          const done = chain.featuresDone ?? features.filter(feature => feature.passes).length
          const width = total === 0 ? 0 : Math.round((done / total) * 100)
          const lastSession = sessions.length === 0 ? null : sessions[sessions.length - 1]
          const pressure = lastSession === null ? 0 : Math.round((lastSession.pressureRatio ?? 0) * 100)
          const isPaused = chain.status === 'paused'
          const blocker = chain.blocker ?? null
          const progressTone = total > 0 && done === total ? 'success' : 'brand'
          const handoffCap = chain.maxHandoffs ?? 32
          const handoffTone = (chain.handoffCount ?? 0) > Math.max(1, Math.floor(handoffCap * 0.7)) ? 'warn' : 'brand'
          const pressureTone = pressure >= 70 ? 'error' : pressure >= 50 ? 'warn' : 'success'
          const metas = [
            { label: t('progress'), value: `${done}/${total}`, tone: progressTone },
            { label: t('statHandoffs'), value: `${chain.handoffCount ?? 0}`, tone: handoffTone },
            { label: t('sessions'), value: `${sessions.length}`, tone: 'brand' },
            { label: t('pressure'), value: `${pressure}%`, tone: pressureTone },
          ]
          if ((chain.coveragePartial ?? 0) > 0) {
            metas.push({ label: t('partialCoverage'), value: `${chain.coveragePartial}`, tone: 'warn' })
          }
          return h('div', { className: 'relay-detail-grid' },
            h('section', { className: 'relay-card is-wide' },
              h(CardTitle, { sub: `${done}/${total}` }, t('overview')),
              h('div', { className: 'relay-detail-head' },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('h3', { className: 'relay-detail-title' }, chain.title || chain.chainId),
                  h('div', { style: { marginTop: '4px' } },
                    h('span', { className: `relay-status is-${chain.status}` },
                      STATUS_LABELS[chain.status] ?? chain.status),
                    blocker === null
                      ? null
                      : h('span', { className: `relay-status is-${blocker.kind === 'external' ? 'failed' : 'paused'}`, style: { marginLeft: '6px' } },
                        BLOCKER_LABELS[blocker.kind] ?? blocker.kind),
                  ),
                ),
                h('div', { className: 'relay-actions' },
                  h('button', {
                    className: 'relay-btn',
                    disabled: busy,
                    onClick: () => { void onAct('relay/setPaused', { chainId: chain.chainId, paused: !isPaused }) },
                  }, isPaused ? t('resume') : t('pause')),
                  h('button', {
                    className: 'relay-btn is-primary',
                    disabled: busy,
                    onClick: () => {
                      if (window.confirm(t('confirmHandoff'))) {
                        void onAct('relay/handoffNow', { chainId: chain.chainId })
                      }
                    },
                  }, t('handoffNow')),
                ),
              ),
              h('p', { className: 'relay-text' }, chain.objective),
              blocker === null
                ? null
                : h('div', { className: `relay-blocker is-${blocker.kind}` },
                  h('span', { className: 'relay-blocker-kind' }, BLOCKER_LABELS[blocker.kind] ?? blocker.kind),
                  h('span', {}, blocker.action ?? ''),
                  blocker.who ? h('span', { className: 'relay-tag' }, blocker.who) : null,
                ),
              h('div', { className: 'relay-metas' },
                metas.map(meta => h('div', { key: meta.label, className: `relay-meta is-${meta.tone}` },
                  h('span', { className: 'relay-meta-value' }, meta.value),
                  h('span', { className: 'relay-meta-label' }, meta.label),
                )),
              ),
              h('div', { className: 'relay-bar' },
                h('div', { className: 'relay-bar-fill', style: { width: `${width}%` } })),
            ),
            h('section', { className: 'relay-card' },
              h(CardTitle, { sub: String(sessions.length) }, t('sessions')),
              sessions.length === 0
                ? h('div', { className: 'relay-text' }, t('none'))
                : h('ul', { className: 'relay-rows' }, sessions.map(session => h(SessionRow, { key: session.sessionId, session }))),
            ),
            h('section', { className: 'relay-card' },
              h(CardTitle, { sub: `${done}/${total}` }, t('features')),
              features.length === 0
                ? h('div', { className: 'relay-text' }, t('noFeatures'))
                : h('ul', { className: 'relay-rows' }, features.map(feature => h(FeatureRow, { key: feature.id, feature }))),
            ),
            h('section', { className: 'relay-card is-wide' },
              h(CardTitle, {}, t('handoff')),
              detail.handoff
                ? h('pre', { className: 'relay-text' }, detail.handoff)
                : h('div', { className: 'relay-text' }, t('noHandoff')),
            ),
            h(AuditCard, { chainId: chain.chainId }),
          )
        }

        /**
         * Last view seen per session.
         * The tab body unmounts when the user switches tabs, so without this
         * every revisit would flash the loading state before the same data
         * came back. Cached data renders first, then the poll confirms it.
         */
        const sessionViewCache = new Map()

        /**
         * Load one session's place in its chain.
         * `undefined` until the first answer arrives, `null` when the session
         * is in no chain.
         */
        function useSessionView(sessionId) {
          const [view, setView] = useState(() => sessionViewCache.get(sessionId))
          const [error, setError] = useState(null)
          useEffect(() => {
            let live = true
            // A different session reuses this component; show that session's
            // own cache instead of the previous session's data.
            setView(sessionViewCache.get(sessionId))
            const load = () => {
              call('relay/sessionView', { sessionId })
                .then((value) => {
                  if (!live) return
                  const next = value ?? null
                  sessionViewCache.set(sessionId, next)
                  setView(next)
                  setError(null)
                })
                .catch(failure => { if (live) setError(failure instanceof Error ? failure.message : String(failure)) })
            }
            load()
            const timer = setInterval(load, POLL_MS)
            return () => { live = false; clearInterval(timer) }
          }, [sessionId])
          return { view, error }
        }

        /** Shared frame for the two session-scoped tabs: an optional KPI row and the body. */
        function TabShell({ kpis, children }) {
          return h('div', { className: 'relay-tab' },
            h('style', { 'data-plugin': 'longtask-relay' }, CSS),
            kpis === undefined || kpis === null
              ? null
              : h('div', { className: 'relay-tab-kpis' },
                kpis.map(kpi => h('div', { key: kpi.label, className: `relay-kpi is-${kpi.tone ?? 'brand'}` },
                  h('span', { className: 'relay-kpi-label' }, kpi.label),
                  h('span', { className: 'relay-kpi-value' }, String(kpi.value)),
                  kpi.sub === '' || kpi.sub === undefined ? null : h('span', { className: 'relay-kpi-sub' }, kpi.sub),
                ))),
            children,
          )
        }

        /** Empty state inside a session tab. */
        function TabEmpty({ title, body }) {
          return h('section', { className: 'relay-card' },
            h('div', { className: 'relay-empty' },
              h('div', { className: 'relay-empty-title' }, title),
              h('div', {}, body),
            ),
          )
        }

        /** One delegated child session card. */
        function ChildCard({ child, onOpen, waiting }) {
          const retired = child.retiredAt !== null && child.retiredAt !== undefined
          const tone = retired ? 'done' : (child.running ? 'active' : 'paused')
          const pressure = Math.round((child.pressureRatio ?? 0) * 100)
          const pressureTone = pressure >= 70 ? 'error' : pressure >= 50 ? 'warn' : 'success'
          const owned = Array.isArray(child.features) ? child.features : []
          const passed = child.featuresPassed ?? 0
          return h('section', { className: `relay-child is-${waiting ? 'paused' : tone}` },
            h('div', { className: 'relay-child-top' },
              h('span', { className: 'relay-mono', style: { flex: 1 } }, child.sessionId),
              waiting ? h('span', { className: 'relay-status is-paused' }, t('decisionShort')) : null,
              h('span', { className: `relay-status is-${tone}` },
                retired ? t('retired') : (child.running ? 'running' : 'idle')),
              h('button', { className: 'relay-btn', onClick: () => onOpen(child.sessionId) }, t('open')),
            ),
            h('div', { className: 'relay-metas' },
              h('div', { className: 'relay-meta is-brand' },
                h('span', { className: 'relay-meta-value' }, ROLE_LABELS[child.role] ?? child.role),
                h('span', { className: 'relay-meta-label' }, t('roleLabel'))),
              h('div', { className: 'relay-meta is-success' },
                h('span', { className: 'relay-meta-value' }, `${passed}/${owned.length}`),
                h('span', { className: 'relay-meta-label' }, t('featuresLabel'))),
              h('div', { className: `relay-meta is-${pressureTone}` },
                h('span', { className: 'relay-meta-value' }, `${pressure}%`),
                h('span', { className: 'relay-meta-label' }, t('pressure'))),
              h('div', { className: `relay-meta${(child.compactions ?? 0) > 0 ? ' is-warn' : ''}` },
                h('span', { className: 'relay-meta-value' }, String(child.compactions ?? 0)),
                h('span', { className: 'relay-meta-label' }, t('compactions'))),
            ),
            owned.length === 0
              ? null
              : h('div', { className: 'relay-feature-tags' },
                owned.map(id => h('span', { key: id, className: 'relay-chip' }, id))),
          )
        }

        /** Session tab: the children this session delegated work to. */
        function ChildrenTab({ sessionId }) {
          const { view, error } = useSessionView(sessionId)
          // Every hook runs before the early returns below: a render that
          // gains a hook after the data arrives throws in React.
          const decisions = usePendingDecisions()
          const open = id => { try { ctx.uiWorkspace.openSession(id) } catch { /* navigation unavailable */ } }
          const frame = (kpis, body) => h(TabShell, { kpis }, body)
          if (error !== null) return frame(null, h(TabEmpty, { title: t('failed'), body: error }))
          if (view === undefined) return frame(null, h('div', { className: 'relay-text' }, t('loading')))
          if (view === null || view.chain === null) return frame(null, h(TabEmpty, { title: t('noChainTitle'), body: t('noChainBody') }))
          const children = Array.isArray(view.children) ? view.children : []
          const running = children.filter(child => child.running).length
          const owned = children.reduce((sum, child) => sum + (Array.isArray(child.features) ? child.features.length : 0), 0)
          const passed = children.reduce((sum, child) => sum + (child.featuresPassed ?? 0), 0)
          const kpis = [
            { label: t('childCount'), value: children.length, tone: 'brand' },
            { label: 'running', value: running, tone: 'success' },
            { label: t('featuresLabel'), value: owned, tone: 'business' },
            { label: t('statDone'), value: passed, tone: 'success' },
          ]
          const waiting = new Set(decisions.map(decision => decision.sessionId).filter(id => typeof id === 'string'))
          return frame(kpis,
            children.length === 0
              ? h(TabEmpty, { title: t('noChildrenTitle'), body: t('noChildrenBody') })
              : h('div', { className: 'relay-children' },
                children.map(child => h(ChildCard, {
                  key: child.sessionId,
                  child,
                  onOpen: open,
                  waiting: waiting.has(child.sessionId),
                }))),
          )
        }

        /** Session tab: the work this session received and how far it got. */
        function TasksTab({ sessionId }) {
          const { view, error } = useSessionView(sessionId)
          const open = id => { try { ctx.uiWorkspace.openSession(id) } catch { /* navigation unavailable */ } }
          const frame = (kpis, body) => h(TabShell, { kpis }, body)
          if (error !== null) return frame(null, h(TabEmpty, { title: t('failed'), body: error }))
          if (view === undefined) return frame(null, h('div', { className: 'relay-text' }, t('loading')))
          if (view === null || view.chain === null) return frame(null, h(TabEmpty, { title: t('noChainTitle'), body: t('noChainBody') }))
          const features = Array.isArray(view.assignedFeatures) ? view.assignedFeatures : []
          const done = features.filter(feature => feature.passes).length
          const self = view.self ?? {}
          const pressure = Math.round((self.pressureRatio ?? 0) * 100)
          const width = features.length === 0 ? 0 : Math.round((done / features.length) * 100)
          const kpis = [
            { label: t('featuresLabel'), value: features.length, tone: 'brand' },
            { label: t('statDone'), value: done, tone: 'success' },
            { label: t('pressure'), value: `${pressure}%`, tone: pressure >= 70 ? 'error' : pressure >= 50 ? 'warn' : 'success' },
            { label: t('compactions'), value: self.compactions ?? 0, tone: 'warn' },
          ]
          const parent = view.parent
          const goal = self.goal ?? null
          const goalCard = h('section', { className: 'relay-card', style: { gridColumn: '1 / -1' } },
            h(CardTitle, { sub: goal === null ? null : `${goal.roundsStarted ?? 0}/${goal.maxGoalRounds ?? 0}` }, t('goalTitle')),
            goal === null
              ? h('div', { className: 'relay-text' }, t('noGoal'))
              : h('div', {},
                h('span', { className: `relay-status is-${GOAL_TONES[goal.phase] ?? 'paused'}` },
                  GOAL_PHASE_LABELS[goal.phase] ?? goal.phase),
                h('span', { className: `relay-chip${goal.activation === 'armed' ? '' : ' is-warn'}`, style: { marginLeft: '6px' } },
                  goal.activation === 'armed' ? t('goalArmed') : t('goalDisarmed')),
                goal.blockedMessage === null || goal.blockedMessage === undefined
                  ? null
                  : h('div', { className: 'relay-text', style: { marginTop: '6px' } }, goal.blockedMessage),
              ),
          )
          if (parent === null) {
            return frame(kpis, h('div', { className: 'relay-task-grid' },
              h(TabEmpty, { title: t('noParentTitle'), body: t('noParentBody') }),
              goalCard,
            ))
          }
          return frame(kpis, h('div', { className: 'relay-task-grid' },
            h('section', { className: 'relay-card' },
              h(CardTitle, {}, t('parentTitle')),
              h('div', { className: 'relay-child-top' },
                h('span', { className: 'relay-mono', style: { flex: 1 } }, parent.sessionId),
                parent.running === undefined
                  ? null
                  : h('span', { className: `relay-status is-${parent.running ? 'active' : 'paused'}` },
                    parent.running ? 'running' : 'idle'),
                h('button', { className: 'relay-btn', onClick: () => open(parent.sessionId) }, t('open')),
              ),
            ),
            h('section', { className: 'relay-card' },
              h(CardTitle, { sub: `${done}/${features.length}` }, t('assignedTitle')),
              h('div', { className: 'relay-bar' },
                h('div', { className: 'relay-bar-fill', style: { width: `${width}%` } })),
              features.length === 0
                ? h('div', { className: 'relay-text' }, t('none'))
                : h('ul', { className: 'relay-rows' }, features.map(feature => h(FeatureRow, { key: feature.id, feature }))),
            ),
            goalCard,
          ))
        }

        /** Last config payload, so the plugin page does not flash its form. */
        const configCache = { value: null, editable: false }

        /** The plugin page's configuration card, registered in `plugins.bundle.config`. */
        function PluginConfigCard({ view }) {
          const [config, setConfig] = useState(() => configCache.value)
          const [editable, setEditable] = useState(() => configCache.editable)
          const [error, setError] = useState(null)
          const [status, setStatus] = useState(null)
          const [loading, setLoading] = useState(() => configCache.value === null)
          const [busy, setBusy] = useState(false)

          const load = useCallback(async () => {
            try {
              const value = await call('relay/getConfig')
              const next = value?.config ?? {}
              configCache.value = next
              configCache.editable = value?.editable === true
              setConfig(next)
              setEditable(configCache.editable)
              setError(null)
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure))
            } finally {
              setLoading(false)
            }
          }, [])

          useEffect(() => { void load() }, [load])

          if (view !== 'page') return null

          const setField = (key, value) => {
            setStatus(null)
            setConfig(previous => ({ ...(previous ?? {}), [key]: value }))
          }

          const save = async () => {
            if (config === null) return
            setBusy(true)
            setStatus(null)
            const cleaned = { ...config }
            for (const group of CONFIG_GROUPS) {
              for (const field of group.fields) {
                const value = cleaned[field.key]
                if (field.kind === 'number' || field.kind === 'int') {
                  if (typeof value !== 'number' || Number.isNaN(value)) delete cleaned[field.key]
                }
                if (field.kind === 'text' && typeof value !== 'string') delete cleaned[field.key]
                if (field.kind === 'boolean' && typeof value !== 'boolean') delete cleaned[field.key]
              }
            }
            try {
              await call('relay/saveConfig', { config: cleaned })
              setStatus({ kind: 'ok', text: t('saved') })
              await load()
            } catch (failure) {
              setStatus({ kind: 'error', text: failure instanceof Error ? failure.message : String(failure) })
            } finally {
              setBusy(false)
            }
          }

          const body = (() => {
            if (loading && config === null) return h('div', { className: 'relay-config-note' }, t('loading'))
            if (error !== null) return h('div', { className: 'relay-config-note' }, `${t('failed')}: ${error}`)
            if (config === null) return null
            return h('div', {},
              CONFIG_GROUPS.map(group => h('div', { key: group.title, className: 'relay-group' },
                h('div', { className: 'relay-group-title' }, group.title),
                group.fields.map(field => h('div', { key: field.key, className: 'relay-field' },
                  h('label', { className: 'relay-field-label' },
                    h('span', { className: 'relay-field-name' }, field.key),
                    field.hint ? h('span', { className: 'relay-field-hint' }, field.hint) : null,
                  ),
                  field.kind === 'boolean'
                    ? h('div', { className: 'relay-check-field' },
                      h('input', {
                        type: 'checkbox',
                        checked: config[field.key] === true,
                        disabled: !editable || busy,
                        onChange: event => setField(field.key, event.target.checked),
                      }))
                    : h('input', {
                      className: 'relay-input',
                      type: field.kind === 'text' ? 'text' : 'number',
                      value: config[field.key] ?? '',
                      step: field.step,
                      min: field.min,
                      max: field.max,
                      disabled: !editable || busy,
                      onChange: event => setField(
                        field.key,
                        field.kind === 'text' ? event.target.value : (event.target.value === '' ? '' : Number(event.target.value)),
                      ),
                    }),
                )),
              )),
              h('div', { className: 'relay-config-actions' },
                h('button', { className: 'relay-btn is-primary', disabled: !editable || busy, onClick: () => { void save() } }, t('save')),
                h('button', { className: 'relay-btn', disabled: busy, onClick: () => { void load() } }, t('reset')),
                status === null
                  ? null
                  : h('span', { className: `relay-config-status${status.kind === 'ok' ? ' is-ok' : ' is-error'}` }, status.text),
                status === null && !editable
                  ? h('span', { className: 'relay-config-status' }, t('readonlyHost'))
                  : null,
              ),
            )
          })()

          return h('div', { className: 'relay-config' },
            h('style', { 'data-plugin': 'longtask-relay' }, CSS),
            h('div', { className: 'relay-config-head' },
              h('span', { className: 'relay-config-title' }, t('configTitle')),
            ),
            h('div', { className: 'relay-config-note' }, t('configNote')),
            body,
          )
        }

        /** The dashboard page. */
        /**
         * Last panel payload, so reopening the panel renders before the poll.
         * `chains === null` means nothing has loaded yet.
         */
        const panelCache = { chains: null, detail: null }

        function RelayPage() {
          const [chains, setChains] = useState(() => panelCache.chains ?? [])
          const [detail, setDetail] = useState(() => panelCache.detail ?? null)
          const [selectedId, setSelectedId] = useState(null)
          const [error, setError] = useState(null)
          const [loading, setLoading] = useState(() => panelCache.chains === null)
          const [busy, setBusy] = useState(false)
          const selectedRef = useRef(null)
          const decisions = usePendingDecisions()

          const refresh = useCallback(async () => {
            try {
              const listed = await call('relay/listChains')
              const next = Array.isArray(listed?.chains) ? listed.chains : []
              const wanted = selectedRef.current
              let nextDetail = null
              if (wanted !== null && next.some(chain => chain.chainId === wanted)) {
                nextDetail = await call('relay/chainDetail', { chainId: wanted })
              } else if (wanted !== null) {
                selectedRef.current = null
                setSelectedId(null)
              }
              panelCache.chains = next
              panelCache.detail = nextDetail
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

          const select = useCallback((chainId) => {
            selectedRef.current = chainId
            setSelectedId(chainId)
            void refresh()
          }, [refresh])

          const act = useCallback(async (endpoint, args) => {
            setBusy(true)
            let failure = null
            try {
              await call(endpoint, args)
            } catch (caught) {
              failure = caught instanceof Error ? caught.message : String(caught)
            }
            setBusy(false)
            await refresh()
            if (failure !== null) setError(failure)
          }, [refresh])

          const active = chains.filter(chain => chain.status === 'active' || chain.status === 'initializing').length
          const paused = chains.filter(chain => chain.status === 'paused').length
          const doneChains = chains.filter(chain => chain.status === 'done').length
          const blocked = chains.filter(chain => chain.blocker !== null && chain.blocker !== undefined).length
          const sessionCount = chains.reduce((sum, chain) => sum + (chain.sessions ?? 0), 0)
          const runningSessions = chains.reduce((sum, chain) => sum
            + (Array.isArray(chain.sessionsDetail) ? chain.sessionsDetail.filter(session => session.running).length : 0), 0)
          const handoffCount = chains.reduce((sum, chain) => sum + (chain.handoffCount ?? 0), 0)
          const featureTotal = chains.reduce((sum, chain) => sum + (chain.featuresTotal ?? 0), 0)
          const featureDone = chains.reduce((sum, chain) => sum + (chain.featuresDone ?? 0), 0)
          const partial = chains.reduce((sum, chain) => sum + (chain.coveragePartial ?? 0), 0)
          const peak = chains.reduce((max, chain) => {
            const sessions = Array.isArray(chain.sessionsDetail) ? chain.sessionsDetail : []
            return Math.max(max, ...sessions.map(session => session.pressureRatio ?? 0))
          }, 0)
          const peakPercent = Math.round(peak * 100)
          const kpis = [
            { label: t('statChains'), value: chains.length, sub: `${active} ${t('statActive')}`, tone: 'brand' },
            { label: t('statDone'), value: doneChains, sub: `${paused} ${t('statPaused')}`, tone: 'success' },
            { label: t('statProgress'), value: `${featureDone}/${featureTotal}`, sub: partial > 0 ? `${partial} ${t('partialCoverage')}` : '', tone: 'business' },
            { label: t('statSessions'), value: sessionCount, sub: `${runningSessions} running`, tone: 'brand' },
            { label: t('statHandoffs'), value: handoffCount, sub: `${blocked} ${t('statBlocked')}`, tone: 'warn' },
            { label: t('statContext'), value: `${peakPercent}%`, sub: t('statContextSub'), tone: peakPercent >= 70 ? 'error' : 'success' },
          ]

          return h('div', { className: 'relay-page' },
            h('style', { 'data-plugin': 'longtask-relay' }, CSS),
            h('div', { className: 'relay-scroll' },
              h('div', { className: 'relay-content' },
                h('div', { className: 'relay-head' },
                  h('div', { className: 'relay-head-main' },
                    h('h2', { className: 'relay-title' }, t('panel')),
                    h('button', { className: 'relay-btn', onClick: openPluginPage }, t('openPluginPage')),
                  ),
                  h('div', { className: 'relay-head-actions' },
                    h('button', { className: 'relay-btn', onClick: () => { void refresh() } }, t('refresh')),
                  ),
                ),
                h('div', { className: 'relay-kpis' },
                  kpis.map(kpi => h('div', { key: kpi.label, className: `relay-kpi is-${kpi.tone}` },
                    h('span', { className: 'relay-kpi-label' }, kpi.label),
                    h('span', { className: 'relay-kpi-value' }, String(kpi.value)),
                    kpi.sub === '' ? null : h('span', { className: 'relay-kpi-sub' }, kpi.sub),
                  )),
                ),
                error === null ? null : h('div', { className: 'relay-error' }, `${t('failed')}: ${error}`),
                decisions.length === 0 ? null : h('section', { className: 'relay-card is-wide' },
                  h(CardTitle, { sub: String(decisions.length) }, t('decisions')),
                  h('div', { className: 'relay-decisions' }, decisions.map(decision => h('div', {
                    key: decision.key,
                    className: 'relay-decision',
                  },
                    h('div', { className: 'relay-decision-main' },
                      h('span', { className: 'relay-decision-kicker' },
                        decision.kind === 'approval' ? t('decisionApproval') : t('decisionQuestion')),
                      h('span', { className: 'relay-decision-text' }, decision.title),
                      h('span', { className: 'relay-decision-session' }, decision.sessionId ?? '—'),
                    ),
                    decision.sessionId === null || decision.sessionId === undefined
                      ? null
                      : h('button', {
                        className: 'relay-btn',
                        onClick: () => openSession(decision.sessionId),
                      }, t('open')),
                  ))),
                ),
                loading && chains.length === 0 ? h('div', { className: 'relay-text' }, t('loading')) : null,
                !loading && chains.length === 0
                  ? h('section', { className: 'relay-card' },
                    h(CardTitle, { sub: '0' }, t('chains')),
                    h(EmptyState),
                  )
                  : null,
                chains.length === 0 ? null : h('div', { className: 'relay-body' },
                  h('ul', { className: 'relay-chains' }, chains.map(chain => h(ChainCard, {
                    key: chain.chainId,
                    chain,
                    selected: chain.chainId === selectedId,
                    onSelect: select,
                  }))),
                  detail === null
                    ? h('section', { className: 'relay-card' },
                      h(CardTitle, {}, t('selectChain')),
                      h('div', { className: 'relay-text' }, t('selectChainBody')),
                    )
                    : h(ChainDetail, { detail, onAct: act, busy }),
                ),
              ),
            ),
          )
        }

        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@local/longtask-relay',
        }, PluginConfigCard))

        // Session tabs: what this session delegated, and what it was given.
        // Registration order is the tab order, so children come before tasks.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'relay-children',
          locale: 'relay',
          label: () => t('tabChildren'),
        }, ChildrenTab))

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'relay-tasks',
          locale: 'relay',
          label: () => t('tabTasks'),
        }, TasksTab))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'relay',
        }, RelayPage))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'relay',
          order: 10,
          label: () => t('panel'),
        }, RelayIcon))

        // Observe (never intercept) the approval and question streams so the
        // panel can list pending decisions for sessions nobody is looking at.
        // Optional: a failure here must not take the panel down with it.
        try {
          watchDecisions()
        } catch {
          /* decision tracking stays unavailable */
        }
      },
    }
  },
})
