/**
 * Browser half: the relay monitoring panel, the two session tabs, and the
 * plugin page configuration card.
 *
 * Registered as a lazy module factory, so React comes from the harness module
 * table and no build step is involved. Data comes from the Host `relay` Remote
 * namespace through the existing `/api` RPC channel; nothing here reads files
 * or another plugin's DOM.
 *
 * The three surfaces are three scopes of the same data:
 * - the panel (`main` slot) lists every chain and shows one chain in full;
 * - the "下游" tab shows what one session delegated to child sessions;
 * - the "我的任务" tab shows what one session was given and where it stands.
 * Each tab links back to its chain in the panel, and the panel opens any
 * session, so a reader can move between the scopes without losing the chain.
 *
 * Colours, radii, and type sizes come from the host's `--dsw-alias-*` tokens,
 * so the pages follow the host theme. Component styles render as one `<style>`
 * element so unmounting removes them.
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
      copy: '复制',
      copyPath: '复制路径',
      copied: '已复制',
      example: '用 relay_start 开始这个长任务：把订单导出从 CSV 改成流式 XLSX，覆盖 3 个入口，全部要有测试',
      statActive: '进行中',
      statDone: '已完成',
      statPassed: '已通过',
      statSessions: '会话',
      statHandoffs: '交接',
      statChains: '任务链',
      statPaused: '已暂停',
      statProgress: '功能进度',
      statContext: '最高上下文',
      statContextSub: '各会话的峰值',
      statBlocked: '被阻塞',
      statAttention: '待处理',
      statRunning: '运行中',
      chains: '任务链',
      filterAll: '全部',
      filterPending: '未完成',
      filterEmpty: '这个筛选下没有内容',
      loading: '加载中…',
      failed: '读取失败',
      selectChain: '从列表选择一条链',
      selectChainBody: '这里显示它的接力轨道、功能清单、真理源文档和审计记录。',
      objective: '目标',
      progress: '进度',
      sessions: '会话',
      features: '功能清单',
      handoff: '交接说明',
      pause: '暂停',
      resume: '恢复',
      handoffNow: '立即交接',
      confirmHandoff: '确认交接',
      handoffDone: '已完成的链不需要交接',
      handoffUnloaded: '当前会话未加载，先打开它再交接',
      pauseDone: '已完成的链不能暂停',
      cancel: '取消',
      none: '无',
      pressure: '上下文',
      peak: '峰值',
      compactions: '压缩',
      noFeatures: '还没有功能清单',
      partialCoverage: '部分验证',
      acceptedByHuman: '人工接受',
      acceptCoverage: '接受',
      revokeCoverage: '撤销接受',
      raiseHandoffLimit: '调高交接上限',
      configTitle: '长任务接力设置',
      configNote: '修改会写进当前 profile 的 cordis.patch.yml，保存后插件按新配置重载。',
      save: '保存',
      reset: '还原',
      saved: '已保存，插件正在用新配置重载',
      readonlyHost: '当前 Host 不能编辑 profile 配置',
      ratioOrder: '收尾比例必须低于强制交接比例',
      zoneWork: '正常工作',
      zoneWrapup: '收尾',
      zoneHandoff: '强制交接',
      tabChildren: '下游',
      tabTasks: '我的任务',
      noChainTitle: '当前会话不属于任何接力链',
      noChainBody: '从会话里调用 relay_start 开始一条链。',
      noChildrenTitle: '还没有派发过子会话',
      noChildrenBody: '用 relay_spawn 把一部分功能交给新的子会话并行执行，这里会显示它们的执行情况。',
      noChildrenNotCurrent: '只有链的当前会话可以派发子会话，本会话已不是当前会话。',
      parentTitle: '上级会话',
      assignedTitle: '我负责的功能',
      mainlineTitle: '主线功能',
      mainlineNote: '没有派发给子会话的功能，由主线会话负责。',
      positionTitle: '我的位置',
      posMainline: '主线会话',
      posChild: '子会话',
      posCurrent: '当前接力会话',
      posSuccessor: '已交接给',
      open: '打开',
      openSession: '打开会话',
      viewInPanel: '在面板中查看',
      viewChain: '查看这条链',
      childCount: '子会话',
      childrenShort: '子',
      audit: '审计',
      auditKey: '关键',
      auditIssues: '异常',
      noAudit: '还没有审计记录',
      auditMaxHandoffs: '交接上限',
      unassigned: '未分派',
      rounds: '轮',
      roleLabel: '角色',
      statusLabel: '状态',
      featuresLabel: '功能',
      attention: '需要你处理',
      attnApproval: '等待审批',
      attnQuestion: '等待回答',
      attnError: '出错',
      questions: '个问题',
      decisionShort: '待决策',
      goalTitle: '当前目标',
      noGoal: '这个会话没有目标',
      goalArmed: '自动继续',
      goalDisarmed: '不自动继续',
      goalRounds: '轮次',
      delete: '删除',
      confirmDelete: '确认删除',
      deleteNote: '功能清单、进度、交接说明和审计记录会一起删除，不能恢复。',
      deleteBlocked: '先暂停这条链才能删除',
      track: '接力轨道',
      leg: '第 {n} 棒',
      legs: '棒',
      thresholds: '收尾 {w}%，强制交接 {h}%',
      unloadedNote: '未加载，没有实时数值',
      current: '当前',
      docs: '真理源',
      docProgress: '进度',
      docHistory: '交接历史',
      docDecisions: '决策',
      docTraps: '踩坑',
      docEmpty: '这份文档还没有内容',
      docTruncated: '内容较长，只显示最新的部分',
      docLocation: '文件位置',
      workspace: '工作区',
      createdAt: '创建',
      updatedAt: '更新',
      currentSession: '当前会话',
      verify: '验证',
      evidence: '证据',
      owner: '负责',
      phaseWrapup: '收尾中',
      phaseReady: '已收尾，等待交接',
      phaseHandoff: '交接中',
      timeNow: '刚刚',
      timeMin: '分钟前',
      timeHour: '小时前',
      timeDay: '天前',
      durMin: '分',
      durHour: '小时',
      sep: '，',
      status_active: '进行中',
      status_paused: '已暂停',
      status_initializing: '初始化',
      status_done: '已完成',
      status_failed: '失败',
      role_initializer: '初始化',
      role_worker: '执行',
      role_reviewer: '复核',
      role_leader: '统筹',
      coverage_full: '完整验证',
      coverage_partial: '部分验证',
      coverage_error_path_only: '仅错误路径',
      coverage_smoke: '冒烟',
      blocker_external: '等待人工',
      blocker_code: '代码阻塞',
      blocker_decision: '待决策',
      goal_active: '进行中',
      goal_paused: '已暂停',
      goal_blocked: '被阻塞',
      goal_complete: '已完成',
      state_running: '运行中',
      state_idle: '空闲',
      state_unloaded: '未加载',
      state_retired: '已退役',
      reason_manual: '手动交接',
      reason_pressure: '上下文压力',
      reason_compaction: '压缩后占用',
      reason_compactions: '压缩次数',
      reason_checkpoint: '收尾完成',
      reason_timeout: '收尾超时',
      reason_goal_blocked: '目标被阻塞',
      reason_stale: '交接说明陈旧',
      reason_missing: '缺少交接说明',
      reason_recovered: '恢复未完成的交接',
      act_wrapup: '开始收尾',
      act_handoff: '交接',
      act_pause: '暂停',
      audit_chain_started: '链开始',
      audit_chain_paused: '链暂停',
      audit_chain_resumed: '链恢复',
      audit_chain_finished: '链完成',
      audit_feature_passed: '功能通过',
      audit_feature_reopened: '功能重开',
      audit_feature_assigned: '功能分派',
      audit_feature_added: '新增功能',
      audit_delegation_created: '派发子会话',
      audit_delegation_failed: '派发失败',
      audit_blocker_set: '记录阻塞',
      audit_blocker_cleared: '阻塞解除',
      audit_session_ready: '会话收尾完成',
      audit_goal_seeded: '建立目标',
      audit_supervisor_decision: '监督判定',
      audit_handoff_started: '交接开始',
      audit_handoff_completed: '交接完成',
      audit_handoff_failed: '交接失败',
      audit_handoff_abandoned: '交接放弃',
      audit_handoff_recovered: '交接恢复',
      audit_handoff_limit_raised: '调高交接上限',
      audit_delegation_reclaimed: '收回子会话功能',
      audit_delegation_returned: '子会话交还功能',
      audit_features_drift: '功能清单被改动',
      audit_features_frozen: '功能清单冻结',
      audit_session_continued: '自动续跑',
      audit_session_continue_limit: '续跑次数到顶',
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
      copy: 'Copy',
      copyPath: 'Copy path',
      copied: 'Copied',
      example: 'Use relay_start for this long task: convert the order export from CSV to streaming XLSX across three entry points, with tests',
      statActive: 'active',
      statDone: 'done',
      statPassed: 'Passed',
      statSessions: 'Sessions',
      statHandoffs: 'Handoffs',
      statChains: 'Chains',
      statPaused: 'paused',
      statProgress: 'Feature progress',
      statContext: 'Peak context',
      statContextSub: 'highest session peak',
      statBlocked: 'blocked',
      statAttention: 'Needs you',
      statRunning: 'running',
      chains: 'Chains',
      filterAll: 'All',
      filterPending: 'Pending',
      filterEmpty: 'Nothing matches this filter',
      loading: 'Loading…',
      failed: 'Read failed',
      selectChain: 'Select a chain from the list',
      selectChainBody: 'Its relay track, feature list, truth-source documents, and audit log appear here.',
      objective: 'Objective',
      progress: 'Progress',
      sessions: 'Sessions',
      features: 'Features',
      handoff: 'Handoff brief',
      pause: 'Pause',
      resume: 'Resume',
      handoffNow: 'Hand off now',
      confirmHandoff: 'Confirm handoff',
      handoffDone: 'A finished chain needs no handoff',
      handoffUnloaded: 'The current session is not loaded; open it first',
      pauseDone: 'A finished chain cannot be paused',
      cancel: 'Cancel',
      none: 'none',
      pressure: 'Context',
      peak: 'peak',
      compactions: 'Compactions',
      noFeatures: 'No features recorded yet',
      partialCoverage: 'Partial proof',
      acceptedByHuman: 'Accepted by human',
      acceptCoverage: 'Accept',
      revokeCoverage: 'Revoke',
      raiseHandoffLimit: 'Raise handoff limit',
      configTitle: 'Long-task relay settings',
      configNote: 'Saving writes the active profile cordis.patch.yml and reloads the plugin with the new values.',
      save: 'Save',
      reset: 'Reset',
      saved: 'Saved; the plugin is reloading with the new configuration',
      readonlyHost: 'This Host cannot edit profile configuration',
      ratioOrder: 'The wrap-up ratio must be lower than the forced handoff ratio',
      zoneWork: 'Working',
      zoneWrapup: 'Wrap-up',
      zoneHandoff: 'Forced handoff',
      tabChildren: 'Downstream',
      tabTasks: 'My tasks',
      noChainTitle: 'This session is not in a relay chain',
      noChainBody: 'Call relay_start from a session to open one.',
      noChildrenTitle: 'Nothing delegated yet',
      noChildrenBody: 'Use relay_spawn to hand part of the work to a fresh child session; its progress appears here.',
      noChildrenNotCurrent: 'Only the chain\'s current session can delegate, and this session is no longer current.',
      parentTitle: 'Parent session',
      assignedTitle: 'Features you own',
      mainlineTitle: 'Main-line features',
      mainlineNote: 'Features that were not delegated to a child stay with the main-line session.',
      positionTitle: 'Where this session stands',
      posMainline: 'Main-line session',
      posChild: 'Child session',
      posCurrent: 'Current relay session',
      posSuccessor: 'Handed over to',
      open: 'Open',
      openSession: 'Open session',
      viewInPanel: 'View in panel',
      viewChain: 'View chain',
      childCount: 'Children',
      childrenShort: 'child',
      audit: 'Audit',
      auditKey: 'Key',
      auditIssues: 'Issues',
      noAudit: 'No audit records yet',
      auditMaxHandoffs: 'handoff cap',
      unassigned: 'unassigned',
      rounds: 'rounds',
      roleLabel: 'Role',
      statusLabel: 'Status',
      featuresLabel: 'Features',
      attention: 'Needs your attention',
      attnApproval: 'Approval',
      attnQuestion: 'Question',
      attnError: 'Error',
      questions: 'questions',
      decisionShort: 'Decide',
      goalTitle: 'Goal',
      noGoal: 'This session has no goal',
      goalArmed: 'armed',
      goalDisarmed: 'not continuing',
      goalRounds: 'Rounds',
      delete: 'Delete',
      confirmDelete: 'Confirm delete',
      deleteNote: 'Its features, progress, handoff brief, and audit log are removed too; this cannot be undone.',
      deleteBlocked: 'Pause the chain before deleting it',
      track: 'Relay track',
      leg: 'Leg {n}',
      legs: 'legs',
      thresholds: 'wrap-up {w}%, forced handoff {h}%',
      unloadedNote: 'Not loaded; no live reading',
      current: 'current',
      docs: 'Truth source',
      docProgress: 'Progress',
      docHistory: 'Handoff history',
      docDecisions: 'Decisions',
      docTraps: 'Traps',
      docEmpty: 'This document is still empty',
      docTruncated: 'Long document; only the newest part is shown',
      docLocation: 'Location',
      workspace: 'Workspace',
      createdAt: 'Created',
      updatedAt: 'Updated',
      currentSession: 'Current session',
      verify: 'Verify',
      evidence: 'Evidence',
      owner: 'Owner',
      phaseWrapup: 'Wrapping up',
      phaseReady: 'Wrapped up; waiting to hand off',
      phaseHandoff: 'Handing off',
      timeNow: 'just now',
      timeMin: 'min ago',
      timeHour: 'h ago',
      timeDay: 'd ago',
      durMin: 'min',
      durHour: 'h',
      sep: ', ',
      status_active: 'Active',
      status_paused: 'Paused',
      status_initializing: 'Initializing',
      status_done: 'Done',
      status_failed: 'Failed',
      role_initializer: 'Initializer',
      role_worker: 'Worker',
      role_reviewer: 'Reviewer',
      role_leader: 'Leader',
      coverage_full: 'Full proof',
      coverage_partial: 'Partial proof',
      coverage_error_path_only: 'Error paths only',
      coverage_smoke: 'Smoke',
      blocker_external: 'Waiting on a human',
      blocker_code: 'Blocked by code',
      blocker_decision: 'Needs a decision',
      goal_active: 'Active',
      goal_paused: 'Paused',
      goal_blocked: 'Blocked',
      goal_complete: 'Complete',
      state_running: 'Running',
      state_idle: 'Idle',
      state_unloaded: 'Not loaded',
      state_retired: 'Retired',
      reason_manual: 'manual handoff',
      reason_pressure: 'context pressure',
      reason_compaction: 'usage after compaction',
      reason_compactions: 'compaction count',
      reason_checkpoint: 'wrap-up finished',
      reason_timeout: 'wrap-up timed out',
      reason_goal_blocked: 'goal blocked',
      reason_stale: 'stale handoff brief',
      reason_missing: 'no handoff brief',
      reason_recovered: 'recovered an unfinished handoff',
      act_wrapup: 'start wrap-up',
      act_handoff: 'hand off',
      act_pause: 'pause',
      audit_chain_started: 'Chain started',
      audit_chain_paused: 'Chain paused',
      audit_chain_resumed: 'Chain resumed',
      audit_chain_finished: 'Chain finished',
      audit_feature_passed: 'Feature passed',
      audit_feature_reopened: 'Feature reopened',
      audit_feature_assigned: 'Feature assigned',
      audit_feature_added: 'Feature added',
      audit_delegation_created: 'Child spawned',
      audit_delegation_failed: 'Spawn failed',
      audit_blocker_set: 'Blocker set',
      audit_blocker_cleared: 'Blocker cleared',
      audit_session_ready: 'Session wrapped up',
      audit_goal_seeded: 'Goal seeded',
      audit_supervisor_decision: 'Supervisor decision',
      audit_handoff_started: 'Handoff started',
      audit_handoff_completed: 'Handoff completed',
      audit_handoff_failed: 'Handoff failed',
      audit_handoff_abandoned: 'Handoff abandoned',
      audit_handoff_recovered: 'Handoff recovered',
      audit_handoff_limit_raised: 'Handoff limit raised',
      audit_delegation_reclaimed: 'Features reclaimed',
      audit_delegation_returned: 'Features returned',
      audit_features_drift: 'Feature list drifted',
      audit_features_frozen: 'Feature list frozen',
      audit_session_continued: 'Auto-continued',
      audit_session_continue_limit: 'Continue limit reached',
    }

    /** Status classes reused by the goal pill. */
    const GOAL_TONES = {
      active: 'active',
      paused: 'paused',
      blocked: 'failed',
      complete: 'done',
    }

    /** Documents the reader offers; the first two arrive with the chain detail. */
    const DOCS = [
      { id: 'handoff', label: 'handoff', inline: true },
      { id: 'progress', label: 'docProgress', inline: true },
      { id: 'history', label: 'docHistory', inline: false },
      { id: 'decisions', label: 'docDecisions', inline: false },
      { id: 'traps', label: 'docTraps', inline: false },
    ]

    /** Editable settings, grouped for the plugin page card. */
    const CONFIG_GROUPS = [
      {
        title: '交接触发',
        fields: [
          { key: 'wrapupRatio', label: '收尾比例', kind: 'number', min: 0.1, max: 0.9, step: 0.01, hint: '上下文占用到这个比例时让会话开始收尾，必须低于强制交接比例' },
          { key: 'handoffRatio', label: '强制交接比例', kind: 'number', min: 0.1, max: 0.95, step: 0.01, hint: '收尾后仍到这个比例就强制交接，必须低于 DSH 自动压缩的阈值（默认 0.8）' },
          { key: 'handoffAfterCompactions', label: '压缩后收尾的次数', kind: 'int', min: 1, hint: '压缩过几次后，达到下面的比例也触发收尾' },
          { key: 'compactedRatioFloor', label: '压缩后收尾的比例', kind: 'number', min: 0.1, max: 0.9, step: 0.01, hint: '已压缩过的会话触发收尾的最低比例' },
          { key: 'hardCompactions', label: '直接交接的压缩次数', kind: 'int', min: 1, hint: '压缩达到几次后不等边界，直接交接' },
          { key: 'wrapupTimeoutMinutes', label: '收尾超时（分钟）', kind: 'int', min: 1, hint: '收尾后空闲多少分钟仍然强制交接' },
          { key: 'staleHandoffMinutes', label: '交接说明陈旧宽限（分钟）', kind: 'int', min: 1, hint: '收尾后 HANDOFF 仍然陈旧时给多少分钟宽限' },
          { key: 'cooldownMs', label: '判定间隔（毫秒）', kind: 'int', min: 0, hint: '同一会话两次判定的最小间隔' },
        ],
      },
      {
        title: '交接行为',
        fields: [
          { key: 'autoHandoff', label: '自动交接', kind: 'boolean', hint: '允许自动收尾与交接；关掉后只能手动操作（自动续跑也停）' },
          { key: 'autoContinue', label: '自动续跑', kind: 'boolean', hint: '链头空闲且没有 goal 驱动时自动续跑下一个功能' },
          { key: 'maxAutoContinues', label: '续跑次数上限', kind: 'int', min: 1, hint: '每个会话自动续跑的次数上限，到顶记阻塞' },
          { key: 'maxHandoffs', label: '交接次数上限', kind: 'int', min: 1, max: 1000, hint: '单条链的交接次数上限' },
          { key: 'pauseGoalOnRetire', label: '退役时暂停旧目标', kind: 'boolean', hint: '交接后暂停旧会话的 goal' },
          { key: 'seedGoalOnHandoff', label: '给新会话建目标', kind: 'boolean', hint: '交接后给新会话建一个 goal，让它按目标轮次自动继续；需要目标功能可用' },
          { key: 'goalRoundsPerHandoff', label: '新目标的轮次上限', kind: 'int', min: 1, hint: '给新会话 goal 分配的续轮上限' },
          { key: 'notifyOldSession', label: '给旧会话留言', kind: 'boolean', hint: '交接后给旧会话留一条退役说明' },
        ],
      },
      {
        title: '验收与阻塞',
        fields: [
          { key: 'requireStrongEvidence', label: '要求命令输出作证据', kind: 'boolean', hint: '功能通过必须附带像命令结果的证据；验证输出是自由文本的项目可以关掉' },
          { key: 'requireHumanAcceptedCoverage', label: '部分验证需人工接受', kind: 'boolean', hint: '只做到部分验证的功能，要人工接受后链才能完成' },
          { key: 'pauseOnExternalBlocker', label: '等待人工时暂停', kind: 'boolean', hint: '遇到只有人能解决的阻塞时暂停这条链，不再消耗交接次数' },
          { key: 'workerApproval', label: '自建会话的审批', kind: 'select', options: ['inherit', 'ask', 'never'], hint: '插件自己创建的会话（子会话、接力会话）的审批策略；无人值守时 ask 会一直等，never 直接失败并记为阻塞' },
        ],
      },
      {
        title: '环境',
        fields: [
          { key: 'truthDir', label: '真理源目录', kind: 'text', hint: '相对工作区的目录' },
          { key: 'commitTruth', label: '要求提交真理源', kind: 'boolean', hint: '收尾 / 初始化提示里是否要求提交真理源' },
          { key: 'agentPreset', label: '新会话的 preset', kind: 'text', hint: '留空继承当前会话' },
        ],
      },
    ]

    const CSS = `
.relay-page, .relay-tab, .relay-config { --relay-hue: var(--dsw-alias-border-l3); --relay-tone: var(--dsw-alias-state-success-primary); --relay-ease: var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.relay-page { box-sizing: border-box; display: flex; flex-direction: column; width: 100%; min-width: 0; height: 100%; min-height: 0; overflow: hidden; container: relay / inline-size; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.relay-scroll { flex: auto; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
.relay-content { padding: 0 12px 16px; }
.relay-tab { box-sizing: border-box; height: 100%; overflow-y: auto; padding: 12px 12px 16px; container: relay / inline-size; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.relay-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding-top: 16px; margin-bottom: 12px; }
.relay-title { flex: 1; min-width: 0; margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; white-space: nowrap; }
.relay-head-actions { display: flex; align-items: center; gap: 6px; flex: none; }

.relay-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.relay-tab .relay-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.relay-kpi { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 9px 12px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
body:not([data-ds-dark-theme]) .relay-kpi { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
.relay-kpi-label { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.relay-kpi-value { color: var(--dsw-alias-label-primary); font-size: 22px; font-weight: 600; line-height: 28px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.relay-kpi-sub { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.relay-kpi.is-success .relay-kpi-value { color: var(--dsw-alias-state-success-primary); }
.relay-kpi.is-business .relay-kpi-value { color: var(--dsw-alias-state-business-primary); }
.relay-kpi.is-brand .relay-kpi-value { color: var(--dsw-alias-brand-primary); }
.relay-kpi.is-warn .relay-kpi-value { color: var(--dsw-alias-state-warn-primary); }
.relay-kpi.is-error .relay-kpi-value { color: var(--dsw-alias-state-error-primary); }

.relay-card { box-sizing: border-box; min-width: 0; margin-bottom: 12px; padding: 10px 12px 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
body:not([data-ds-dark-theme]) .relay-card { border-radius: 12px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
.relay-card-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-height: 24px; margin-bottom: 10px; font-weight: 600; }
.relay-card-title-text { display: inline-flex; align-items: center; gap: 6px; flex: none; white-space: nowrap; }
.relay-card-title-text svg { flex: none; color: var(--dsw-alias-label-secondary); }
.relay-card-sub { min-width: 0; margin-left: auto; overflow: hidden; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.relay-card-tools { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.relay-card-tools + .relay-card-sub { margin-left: 0; }

.relay-btn { box-sizing: border-box; display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 22px; white-space: nowrap; cursor: pointer; transition: border-color var(--relay-ease), background-color var(--relay-ease); }
.relay-btn:hover:not(:disabled) { border-color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
.relay-btn:disabled { opacity: 0.45; cursor: default; }
.relay-btn.is-primary { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); font-weight: 600; }
.relay-btn.is-danger { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.relay-btn.is-small { height: 20px; padding: 0 7px; font-size: 11px; line-height: 18px; }
.relay-page button:focus-visible, .relay-tab button:focus-visible, .relay-config button:focus-visible, .relay-config input:focus-visible, .relay-config select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

.relay-seg { display: inline-flex; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.relay-seg-btn { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; font-weight: 400; white-space: nowrap; cursor: pointer; }
.relay-seg-btn:hover { color: var(--dsw-alias-label-primary); }
.relay-seg-btn.is-on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: 0 0 0 1px var(--dsw-alias-border-l2); }
.relay-seg-count { color: var(--dsw-alias-label-tertiary); font-weight: 400; font-variant-numeric: tabular-nums; }

.relay-status { display: inline-flex; align-items: center; flex: none; height: 18px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 16px; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.relay-status.is-active, .relay-status.is-running { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.relay-status.is-paused, .relay-status.is-initializing, .relay-status.is-warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.relay-status.is-failed { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.relay-status.is-done { color: var(--dsw-alias-state-business-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.relay-status.is-unloaded { border-style: dashed; color: var(--dsw-alias-label-tertiary); }
.relay-chip { display: inline-flex; align-items: center; flex: none; height: 17px; padding: 0 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; white-space: nowrap; }
.relay-chip.is-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-warn-primary); }
.relay-chip.is-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-error-primary); }
.relay-chip.is-human { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-business-primary); }
.relay-pills { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }

.relay-text { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
.relay-mono { overflow: hidden; color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.relay-tag { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.relay-error { display: flex; align-items: flex-start; gap: 7px; margin-bottom: 12px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, var(--dsw-alias-border-l2)); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.relay-card .relay-error { margin: 8px 0 0; }

.relay-bar { height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 22%, transparent); overflow: hidden; }
.relay-bar-fill { height: 100%; border-radius: 999px; background: var(--relay-hue); transition: width var(--relay-ease); }
.relay-gauge.is-tone-success { --relay-tone: var(--dsw-alias-state-success-primary); }
.relay-gauge.is-tone-warn { --relay-tone: var(--dsw-alias-state-warn-primary); }
.relay-gauge.is-tone-error { --relay-tone: var(--dsw-alias-state-error-primary); }
.relay-gauge.is-tone-muted { --relay-tone: var(--dsw-alias-label-tertiary); }
.relay-gauge { position: relative; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 22%, transparent); }
.relay-gauge-fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; background: var(--relay-tone); transition: width var(--relay-ease); }
.relay-gauge-tick { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--dsw-alias-bg-layer-1); }
.relay-gauge-peak { position: absolute; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--dsw-alias-label-primary); opacity: 0.6; }

.relay-attn { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.relay-attn-item { display: grid; grid-template-columns: 84px minmax(0, 1fr) auto; align-items: center; column-gap: 10px; padding: 7px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.relay-attn-item:first-child { border-top: none; padding-top: 0; }
.relay-attn-item:last-child { padding-bottom: 0; }
.relay-attn-kind { color: var(--dsw-alias-state-warn-primary); font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.relay-attn-item.is-error .relay-attn-kind { color: var(--dsw-alias-state-error-primary); }
.relay-attn-main { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.relay-attn-text { font-size: 12.5px; line-height: 18px; overflow-wrap: anywhere; }
.relay-attn-meta { overflow: hidden; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; text-overflow: ellipsis; white-space: nowrap; }
.relay-card.is-attn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l2)); }

.relay-split { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); align-items: start; gap: 12px; }
.relay-rail { position: sticky; top: 0; max-height: calc(100vh - 32px); margin-bottom: 0; padding: 10px 8px 8px; overflow-y: auto; }
.relay-rail .relay-card-title { padding: 0 4px; }
.relay-rows { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.relay-row { position: relative; box-sizing: border-box; display: flex; flex-direction: column; gap: 5px; width: 100%; min-width: 0; padding: 8px 8px 9px 14px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background-color var(--relay-ease), border-color var(--relay-ease); }
.relay-row::before { content: ''; position: absolute; top: 9px; bottom: 9px; left: 5px; width: 3px; border-radius: 2px; background: var(--relay-hue); }
.relay-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.relay-row.is-selected { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
:is(.relay-row, .relay-detail, .relay-card).is-active { --relay-hue: var(--dsw-alias-state-success-primary); }
:is(.relay-row, .relay-detail, .relay-card).is-paused, :is(.relay-row, .relay-detail, .relay-card).is-initializing { --relay-hue: var(--dsw-alias-state-warn-primary); }
:is(.relay-row, .relay-detail, .relay-card).is-failed { --relay-hue: var(--dsw-alias-state-error-primary); }
:is(.relay-row, .relay-detail, .relay-card).is-done { --relay-hue: var(--dsw-alias-state-business-primary); }
.relay-row-head { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.relay-row-title { flex: 1 1 0; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-size: 13px; font-weight: 600; line-height: 18px; }
.relay-row-status { flex: none; color: var(--relay-hue); font-size: 11px; font-weight: 600; line-height: 18px; white-space: nowrap; }
.relay-row-where { display: flex; gap: 8px; min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; white-space: nowrap; }
.relay-row-where > :first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.relay-row-progress { display: flex; align-items: center; gap: 8px; }
.relay-row-progress .relay-bar { flex: 1; }
.relay-row-progress b { flex: none; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.relay-row-facts { display: flex; flex-wrap: wrap; gap: 2px 12px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.relay-row-facts b { margin-left: 4px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }

.relay-detail { min-width: 0; }
.relay-detail-head { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.relay-detail-main { flex: 1 1 260px; min-width: 0; }
.relay-detail-title { margin: 0 0 6px; font-size: 15px; font-weight: 600; line-height: 22px; overflow-wrap: anywhere; }
.relay-actions { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 6px; }
.relay-confirm-note { flex-basis: 100%; color: var(--dsw-alias-state-error-primary); font-size: 11.5px; line-height: 16px; text-align: right; }
.relay-blocker { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2); border-left: 2px solid var(--dsw-alias-state-warn-primary); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 17px; overflow-wrap: anywhere; }
.relay-blocker.is-external { border-left-color: var(--dsw-alias-state-error-primary); }
.relay-blocker-kind { flex: none; color: var(--dsw-alias-state-warn-primary); font-weight: 600; }
.relay-blocker.is-external .relay-blocker-kind { color: var(--dsw-alias-state-error-primary); }
.relay-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 4px 12px; margin: 10px 0 0; font-size: 12px; line-height: 18px; }
.relay-facts dt { color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.relay-facts dd { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; }
.relay-metas { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 6px; margin-top: 10px; }
.relay-meta { display: flex; flex-direction: column; min-width: 0; gap: 1px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2); border-left-width: 2px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.relay-meta.is-brand { border-left-color: var(--dsw-alias-brand-primary); }
.relay-meta.is-success { border-left-color: var(--dsw-alias-state-success-primary); }
.relay-meta.is-warn { border-left-color: var(--dsw-alias-state-warn-primary); }
.relay-meta.is-error { border-left-color: var(--dsw-alias-state-error-primary); }
.relay-meta.is-business { border-left-color: var(--dsw-alias-state-business-primary); }
.relay-meta-value { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; line-height: 19px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.relay-meta.is-success .relay-meta-value { color: var(--dsw-alias-state-success-primary); }
.relay-meta.is-warn .relay-meta-value { color: var(--dsw-alias-state-warn-primary); }
.relay-meta.is-error .relay-meta-value { color: var(--dsw-alias-state-error-primary); }
.relay-meta.is-business .relay-meta-value { color: var(--dsw-alias-state-business-primary); }
.relay-meta-label { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 15px; white-space: nowrap; }
.relay-progress-line { margin-top: 10px; }

.relay-track { display: grid; grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 14px 10px; margin: 0; padding: 0; list-style: none; }
.relay-leg { --relay-hue: var(--dsw-alias-border-l3); position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; padding-top: 18px; }
.relay-leg::before { content: ''; position: absolute; top: 5px; left: 6px; right: -10px; height: 2px; background: var(--dsw-alias-border-l2); }
.relay-leg.is-retired::before { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, var(--dsw-alias-border-l2)); }
.relay-leg:last-child::before { display: none; }
.relay-leg-dot { position: absolute; top: 0; left: 0; box-sizing: border-box; width: 12px; height: 12px; border: 2px solid var(--relay-hue); border-radius: 50%; background: var(--dsw-alias-bg-layer-1); }
.relay-leg.is-retired { --relay-hue: var(--dsw-alias-state-business-primary); }
.relay-leg.is-retired .relay-leg-dot { background: var(--relay-hue); }
.relay-leg.is-running { --relay-hue: var(--dsw-alias-state-success-primary); }
.relay-leg.is-idle { --relay-hue: var(--dsw-alias-state-warn-primary); }
.relay-leg.is-running .relay-leg-dot { background: var(--relay-hue); animation: relay-pulse 1.8s ease-out infinite; }
@keyframes relay-pulse { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); } to { box-shadow: 0 0 0 6px transparent; } }
@media (prefers-reduced-motion: reduce) { .relay-leg.is-running .relay-leg-dot { animation: none; } }
.relay-leg-card { box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0; padding: 8px 10px 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: inherit; font: inherit; text-align: left; cursor: pointer; transition: border-color var(--relay-ease), background-color var(--relay-ease); }
.relay-leg-card:hover { border-color: var(--dsw-alias-border-l4, var(--dsw-alias-label-tertiary)); background: var(--dsw-alias-interactive-bg-hover); }
.relay-leg.is-current .relay-leg-card { border-color: var(--relay-hue); }
.relay-leg-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.relay-leg-no { flex: 1; min-width: 0; overflow: hidden; font-size: 12.5px; font-weight: 600; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.relay-leg-line { display: block; overflow: hidden; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 15px; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.relay-kids { display: flex; flex-direction: column; gap: 3px; margin: 0 0 0 10px; padding: 0 0 0 8px; border-left: 1px dashed var(--dsw-alias-border-l3); list-style: none; }
.relay-kid { box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; padding: 3px 6px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 16px; text-align: left; cursor: pointer; }
.relay-kid:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-interactive-bg-hover); }
.relay-kid .relay-mono { flex: 1; min-width: 0; font-size: 11px; }
.relay-kid b { flex: none; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.relay-track-note { margin-top: 10px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; }

.relay-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.relay-feature { display: grid; grid-template-columns: 16px 46px minmax(0, 1fr); align-items: baseline; column-gap: 8px; padding: 6px 0; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12.5px; line-height: 18px; }
.relay-feature:first-child { border-top: none; padding-top: 0; }
.relay-check { color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 12px; }
.relay-feature.is-done .relay-check { color: var(--dsw-alias-state-success-primary); }
.relay-feature-title { overflow-wrap: anywhere; }
.relay-feature.is-done .relay-feature-title { color: var(--dsw-alias-label-secondary); }
.relay-feature-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.relay-feature-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.relay-feature-line { display: flex; gap: 6px; min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 16px; }
.relay-feature-line > * { min-width: 0; overflow-wrap: anywhere; }
.relay-feature-line > :first-child:not(:only-child) { flex: none; }
.relay-feature-line code { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px; }

.relay-doc { box-sizing: border-box; max-height: 420px; margin: 0; padding: 10px 12px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 12px; line-height: 19px; white-space: pre-wrap; overflow-wrap: anywhere; }
.relay-doc-foot { display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: 8px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 16px; }
.relay-doc-foot .relay-mono { flex: 0 1 auto; min-width: 0; }

.relay-audit-row { display: grid; grid-template-columns: 96px 108px minmax(0, 1fr) auto; align-items: baseline; column-gap: 10px; padding: 5px 0; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; line-height: 17px; }
.relay-audit-row:first-child { border-top: none; padding-top: 0; }
.relay-audit-time { color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px; white-space: nowrap; }
.relay-audit-kind { overflow: hidden; color: var(--dsw-alias-label-primary); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.relay-audit-detail { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.relay-audit-row.is-key .relay-audit-kind { color: var(--dsw-alias-state-success-primary); }
.relay-audit-row.is-warn .relay-audit-kind { color: var(--dsw-alias-state-warn-primary); }
.relay-audit-row.is-error .relay-audit-kind { color: var(--dsw-alias-state-error-primary); }

.relay-empty { display: flex; flex-direction: column; gap: 8px; max-width: 620px; padding: 4px 2px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 19px; }
.relay-empty-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; line-height: 20px; }
.relay-steps { display: flex; flex-direction: column; gap: 8px; margin: 4px 0; padding: 0; list-style: none; }
.relay-step { display: flex; gap: 8px; align-items: flex-start; }
.relay-step-index { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 18px; height: 18px; margin-top: 1px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 50%; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; }
.relay-step-title { color: var(--dsw-alias-label-primary); font-weight: 600; }
.relay-example { padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-word; }

.relay-banner { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; border-left: 3px solid var(--relay-hue); }
.relay-banner-main { display: flex; flex-direction: column; flex: 1 1 260px; min-width: 0; gap: 4px; }
.relay-banner-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.relay-banner-title b { min-width: 0; font-size: 13.5px; line-height: 19px; overflow-wrap: anywhere; }
.relay-banner-objective { overflow: hidden; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 17px; text-overflow: ellipsis; white-space: nowrap; }
.relay-banner-side { display: flex; align-items: center; flex: 0 1 300px; gap: 10px; min-width: 200px; }
.relay-banner-progress { display: flex; flex-direction: column; flex: 1; gap: 4px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 16px; }
.relay-banner-progress b { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.relay-children { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); align-items: start; gap: 10px; }
.relay-child { display: flex; flex-direction: column; gap: 8px; margin-bottom: 0; border-left: 3px solid var(--relay-hue); }
.relay-child.is-running { --relay-hue: var(--dsw-alias-state-success-primary); }
.relay-child.is-idle, .relay-child.is-waiting { --relay-hue: var(--dsw-alias-state-warn-primary); }
.relay-child.is-retired { --relay-hue: var(--dsw-alias-state-business-primary); }
.relay-child-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.relay-child-top .relay-mono { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); font-size: 12px; }
.relay-child .relay-metas { margin-top: 0; }
.relay-child-list { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; }
.relay-child-feature { display: grid; grid-template-columns: 14px 46px minmax(0, 1fr); align-items: baseline; column-gap: 6px; font-size: 12px; line-height: 17px; }
.relay-child-feature.is-done .relay-check { color: var(--dsw-alias-state-success-primary); }
.relay-child-feature.is-done > :last-child { color: var(--dsw-alias-label-secondary); }
.relay-gauge-row { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 16px; font-variant-numeric: tabular-nums; }
.relay-gauge-row .relay-gauge { flex: 1; }
.relay-task-grid { display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr); align-items: start; gap: 12px; }
.relay-task-grid > .relay-card, .relay-task-side > .relay-card:last-child { margin-bottom: 0; }
.relay-task-side { display: flex; flex-direction: column; min-width: 0; }

.relay-config { display: flex; flex-direction: column; gap: 4px; container: relay / inline-size; color: var(--dsw-alias-label-primary); font-size: 13px; }
.relay-config-title { font-size: 14px; font-weight: 600; line-height: 20px; }
.relay-config-note { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.relay-zones { display: flex; height: 22px; margin: 10px 0 2px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; font-size: 11px; line-height: 20px; }
.relay-zone { box-sizing: border-box; min-width: 0; padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.relay-zone.is-work { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); }
.relay-zone.is-wrapup { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 24%, transparent); }
.relay-zone.is-handoff { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, transparent); }
.relay-zone-scale { display: flex; justify-content: space-between; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; font-variant-numeric: tabular-nums; }
.relay-group { display: flex; flex-direction: column; margin-top: 14px; }
.relay-group-title { margin: 0 0 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; line-height: 17px; }
.relay-field { display: grid; grid-template-columns: minmax(0, 1fr) 150px; align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.relay-field-label { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.relay-field-name { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; font-size: 13px; line-height: 18px; }
.relay-field-key { color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px; }
.relay-field-hint { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 16px; }
.relay-input { box-sizing: border-box; width: 100%; height: 26px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; }
.relay-input:focus { border-color: var(--dsw-alias-label-secondary); }
.relay-input.is-invalid { border-color: var(--dsw-alias-state-error-primary); }
.relay-check-field { display: flex; justify-content: flex-end; }
.relay-switch { position: relative; flex: none; width: 32px; height: 18px; margin: 0; border: 0; border-radius: 9px; background: var(--dsw-alias-border-l3); appearance: none; -webkit-appearance: none; cursor: pointer; transition: background-color var(--relay-ease); }
.relay-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-bg-layer-1); transition: transform var(--relay-ease); }
.relay-switch:checked { background: var(--dsw-alias-brand-primary); }
.relay-switch:checked::after { transform: translateX(14px); }
.relay-switch:disabled { opacity: 0.45; cursor: default; }
.relay-config-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.relay-config-status { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 17px; }
.relay-config-status.is-error { color: var(--dsw-alias-state-error-primary); }
.relay-config-status.is-ok { color: var(--dsw-alias-state-success-primary); }

@container relay (max-width: 900px) {
  .relay-audit-row { grid-template-columns: 96px 100px minmax(0, 1fr); }
  .relay-audit-row > :nth-child(4) { display: none; }
}
@container relay (max-width: 760px) {
  .relay-split { grid-template-columns: minmax(0, 1fr); }
  .relay-rail { position: static; max-height: 300px; margin-bottom: 0; }
  .relay-task-grid { grid-template-columns: minmax(0, 1fr); }
}
@container relay (max-width: 620px) {
  .relay-kpis, .relay-tab .relay-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .relay-page .relay-kpi:first-child { grid-column: 1 / -1; }
}
@container relay (max-width: 520px) {
  .relay-children { grid-template-columns: minmax(0, 1fr); }
  .relay-attn-item { grid-template-columns: minmax(0, 1fr) auto; }
  .relay-attn-kind { grid-column: 1 / -1; }
  .relay-audit-row { grid-template-columns: minmax(0, 1fr); row-gap: 1px; }
  .relay-field { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .relay-check-field { justify-content: flex-start; }
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
         * Label for a value the Host sends as an identifier (a status, a role,
         * an audit kind). Unknown values show as they are instead of a key.
         */
        const label = (prefix, value) => {
          if (typeof value !== 'string' || value.length === 0) return ''
          const key = `${prefix}_${value.replace(/[^A-Za-z0-9]/g, '_')}`
          return STRINGS[key] === undefined ? value : t(key)
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

        /** Message of a caught failure. */
        const messageOf = failure => (failure instanceof Error ? failure.message : String(failure))

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
         * Which chain the panel should show next.
         * A session tab sets it before switching to the panel; a mounted panel
         * hears it through the listener, an unmounted one reads it on mount.
         */
        const focus = { chainId: null, listeners: new Set() }

        /** Switch to the relay panel with one chain selected. */
        const showChainInPanel = (chainId) => {
          if (typeof chainId !== 'string' || chainId.length === 0) return
          focus.chainId = chainId
          for (const listener of focus.listeners) {
            try {
              listener(chainId)
            } catch {
              /* one listener must not block the switch */
            }
          }
          try {
            ctx.layout.selectPanel('relay')
          } catch {
            /* the shell cannot switch panels */
          }
        }

        /**
         * The supervisor's two pressure lines, as ratios.
         * The defaults match `lib/config.js`; the running values replace them
         * once `relay/getConfig` answers.
         */
        const thresholds = { wrapup: 0.5, handoff: 0.7, loaded: false }

        /** Read the running thresholds once per page load. */
        const loadThresholds = () => {
          if (thresholds.loaded) return
          thresholds.loaded = true
          call('relay/getConfig')
            .then((value) => {
              const config = value?.config ?? {}
              if (typeof config.wrapupRatio === 'number') thresholds.wrapup = config.wrapupRatio
              if (typeof config.handoffRatio === 'number') thresholds.handoff = config.handoffRatio
            })
            .catch(() => { thresholds.loaded = false })
        }

        /** Whole percent of a 0–1 ratio. */
        const pct = ratio => Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)

        /** Colour tone for a context ratio, against the supervisor's lines. */
        const toneOf = ratio => (ratio >= thresholds.handoff ? 'error' : ratio >= thresholds.wrapup ? 'warn' : 'success')

        /** A session id short enough for a row; the full id stays in `title`. */
        const shortId = (id) => {
          if (typeof id !== 'string') return ''
          const bare = id.replace(/^session-/, '')
          return bare.length > 10 ? bare.slice(0, 8) : bare
        }

        /** Token count in thousands. */
        const kilo = value => (typeof value === 'number' && value > 0 ? `${Math.round(value / 1000)}k` : '')

        /** How long ago an ISO timestamp was. */
        const ago = (iso) => {
          const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
          if (!Number.isFinite(at)) return ''
          const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
          if (seconds < 60) return t('timeNow')
          if (seconds < 3600) return `${Math.floor(seconds / 60)} ${t('timeMin')}`
          if (seconds < 86400) return `${Math.floor(seconds / 3600)} ${t('timeHour')}`
          return `${Math.floor(seconds / 86400)} ${t('timeDay')}`
        }

        /** Time between two ISO timestamps, in hours and minutes. */
        const span = (from, to) => {
          const start = typeof from === 'string' ? Date.parse(from) : Number.NaN
          const end = typeof to === 'string' ? Date.parse(to) : Date.now()
          if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
          const minutes = Math.round((end - start) / 60000)
          if (minutes < 60) return `${minutes} ${t('durMin')}`
          return `${Math.floor(minutes / 60)} ${t('durHour')} ${minutes % 60} ${t('durMin')}`
        }

        /** Local date and time for a timestamp. */
        const clock = (iso) => {
          const date = typeof iso === 'string' ? new Date(iso) : null
          if (date === null || Number.isNaN(date.getTime())) return ''
          const time = date.toLocaleTimeString([], { hour12: false })
          if (date.toDateString() === new Date().toDateString()) return time
          const two = value => String(value).padStart(2, '0')
          return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${time.slice(0, 5)}`
        }

        /** Last folder of a path. */
        const folderOf = path => (typeof path === 'string' ? path.split(/[\\/]/).filter(Boolean).pop() ?? path : '')

        /** One of retired, unloaded, running, idle; null when the Host sent no liveness. */
        const stateOf = (session) => {
          if (session === null || session === undefined) return null
          if (session.retiredAt !== null && session.retiredAt !== undefined) return 'retired'
          if (session.loaded === false) return 'unloaded'
          if (session.running === undefined) return null
          return session.running ? 'running' : 'idle'
        }

        /** The step between working and handed off that an active chain is in. */
        const phaseOf = (chain) => {
          if (chain.status !== 'active') return null
          if (chain.handoffPending === true) return 'phaseHandoff'
          if (typeof chain.readyAt === 'string') return 'phaseReady'
          if (typeof chain.wrapupAt === 'string') return 'phaseWrapup'
          return null
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
              title: first === undefined ? t('attnQuestion') : String(first.question ?? first.title ?? ''),
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

        /** Card title: a label, optional controls, and a trailing count. */
        function CardTitle({ children, sub, tools, icon = false }) {
          return h('div', { className: 'relay-card-title' },
            h('span', { className: 'relay-card-title-text' }, icon ? h(RelayIcon, { size: 14 }) : null, children),
            tools === undefined || tools === null ? null : h('span', { className: 'relay-card-tools' }, tools),
            sub === undefined || sub === null ? null : h('span', { className: 'relay-card-sub' }, sub),
          )
        }

        /** Row of KPI tiles. */
        function Kpis({ items }) {
          return h('div', { className: 'relay-kpis' },
            items.map(kpi => h('div', { key: kpi.label, className: `relay-kpi is-${kpi.tone ?? 'brand'}` },
              h('span', { className: 'relay-kpi-label' }, kpi.label),
              h('span', { className: 'relay-kpi-value' }, String(kpi.value)),
              kpi.sub === '' || kpi.sub === undefined ? null : h('span', { className: 'relay-kpi-sub' }, kpi.sub),
            )))
        }

        /** Segmented choice; each option may carry a count. */
        function Seg({ options, value, onChange }) {
          return h('div', { className: 'relay-seg', role: 'group' },
            options.map(option => h('button', {
              key: option.id,
              type: 'button',
              className: `relay-seg-btn${option.id === value ? ' is-on' : ''}`,
              'aria-pressed': option.id === value,
              onClick: () => onChange(option.id),
            },
              option.label,
              option.count === undefined ? null : h('span', { className: 'relay-seg-count' }, String(option.count)),
            )))
        }

        /**
         * Context meter: the fill is the reading, the marker is the session's
         * peak, and the two cuts are the wrap-up and forced-handoff lines.
         */
        function Gauge({ ratio, peak, muted = false }) {
          const value = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
          const top = Math.max(0, Math.min(1, Number.isFinite(peak) ? peak : 0))
          return h('div', { className: `relay-gauge is-tone-${muted ? 'muted' : toneOf(value)}`, 'aria-hidden': true },
            h('div', { className: 'relay-gauge-fill', style: { width: `${value * 100}%` } }),
            h('div', { className: 'relay-gauge-tick', style: { left: `${thresholds.wrapup * 100}%` } }),
            h('div', { className: 'relay-gauge-tick', style: { left: `${thresholds.handoff * 100}%` } }),
            top > value ? h('div', { className: 'relay-gauge-peak', style: { left: `${top * 100}%` } }) : null,
          )
        }

        /** Thin progress bar in the hue of its surrounding status. */
        function Bar({ done, total }) {
          const width = total > 0 ? Math.round((done / total) * 100) : 0
          return h('div', { className: 'relay-bar', 'aria-hidden': true },
            h('div', { className: 'relay-bar-fill', style: { width: `${width}%` } }))
        }

        /** Button that copies a text and confirms it for a moment. */
        function CopyButton({ text, children, small = true }) {
          const [copied, setCopied] = useState(false)
          const copy = () => {
            try {
              void Promise.resolve(navigator.clipboard?.writeText(text))
                .then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                })
                .catch(() => undefined)
            } catch {
              /* clipboard unavailable */
            }
          }
          return h('button', { type: 'button', className: `relay-btn${small ? ' is-small' : ''}`, onClick: copy },
            copied ? t('copied') : children)
        }

        /**
         * Button that asks once more before a consequential action.
         * The second step replaces the first in place and steps back on its own.
         */
        function ConfirmButton({ children, confirmLabel, note, onConfirm, disabled, title, primary = false }) {
          const [armed, setArmed] = useState(false)
          useEffect(() => {
            if (!armed) return undefined
            const timer = setTimeout(() => setArmed(false), 6000)
            return () => clearTimeout(timer)
          }, [armed])
          if (!armed || disabled) {
            return h('button', {
              type: 'button',
              className: `relay-btn${primary ? ' is-primary' : ''}`,
              disabled,
              title,
              onClick: () => setArmed(true),
            }, children)
          }
          return h(React.Fragment, {},
            h('button', {
              type: 'button',
              className: 'relay-btn is-danger',
              onClick: () => { setArmed(false); onConfirm() },
            }, confirmLabel),
            h('button', { type: 'button', className: 'relay-btn', onClick: () => setArmed(false) }, t('cancel')),
            note === undefined ? null : h('span', { className: 'relay-confirm-note' }, note),
          )
        }

        /** Pill for a session's liveness; nothing when the Host sent none. */
        function StatePill({ session }) {
          const state = stateOf(session)
          if (state === null) return null
          return h('span', { className: `relay-status is-${state === 'retired' ? 'done' : state}` }, label('state', state))
        }

        /** First-run guidance shown when no chain exists yet. */
        function EmptyState() {
          const steps = [
            { title: t('step1Title'), body: t('step1Body') },
            { title: t('step2Title'), body: t('step2Body') },
            { title: t('step3Title'), body: t('step3Body') },
          ]
          return h('div', { className: 'relay-empty' },
            h('div', { className: 'relay-empty-title' }, t('emptyTitle')),
            h('div', {}, t('emptyBody')),
            h('ol', { className: 'relay-steps' },
              steps.map((step, index) => h('li', { key: step.title, className: 'relay-step' },
                h('span', { className: 'relay-step-index' }, String(index + 1)),
                h('div', {},
                  h('div', { className: 'relay-step-title' }, step.title),
                  h('div', {}, step.body),
                ),
              )),
            ),
            h('div', { className: 'relay-example' }, t('example')),
            h('div', {}, h(CopyButton, { text: t('example'), small: false }, t('copyExample'))),
          )
        }

        /** One chain in the list. */
        function ChainRow({ chain, selected, onSelect, waiting }) {
          const total = chain.featuresTotal ?? 0
          const done = chain.featuresDone ?? 0
          const sessions = Array.isArray(chain.sessionsDetail) ? chain.sessionsDetail : []
          const peak = sessions.reduce((max, session) => Math.max(max, session.peakRatio ?? 0), 0)
          const phase = phaseOf(chain)
          const hasBlocker = chain.blocker !== null && chain.blocker !== undefined
          const hasError = typeof chain.lastError === 'string' && chain.lastError.length > 0
          return h('li', {},
            h('button', {
              type: 'button',
              className: `relay-row is-${chain.status}${selected ? ' is-selected' : ''}`,
              'aria-current': selected ? 'true' : undefined,
              onClick: () => onSelect(chain.chainId),
            },
              h('span', { className: 'relay-row-head' },
                h('span', { className: 'relay-row-title' }, chain.title || chain.chainId),
                h('span', { className: 'relay-row-status' }, phase === null ? label('status', chain.status) : t(phase)),
              ),
              h('span', { className: 'relay-row-where' },
                h('span', { title: chain.cwd }, folderOf(chain.cwd)),
                h('span', {}, ago(chain.updatedAt)),
              ),
              h('span', { className: 'relay-row-progress' },
                h(Bar, { done, total }),
                h('b', {}, `${done}/${total}`),
              ),
              h('span', { className: 'relay-row-facts' },
                h('span', {}, t('statHandoffs'), h('b', {}, `${chain.handoffCount ?? 0}/${chain.maxHandoffs ?? 0}`)),
                h('span', {}, t('sessions'), h('b', {}, String(chain.sessions ?? sessions.length))),
                h('span', {}, t('peak'), h('b', {}, `${pct(peak)}%`)),
              ),
              hasBlocker || hasError || waiting
                ? h('span', { className: 'relay-pills' },
                  waiting ? h('span', { className: 'relay-chip is-warn' }, t('decisionShort')) : null,
                  hasBlocker
                    ? h('span', { className: `relay-chip is-${chain.blocker.kind === 'external' ? 'error' : 'warn'}` }, label('blocker', chain.blocker.kind))
                    : null,
                  hasError ? h('span', { className: 'relay-chip is-error' }, t('attnError')) : null,
                )
                : null,
            ),
          )
        }

        /**
         * The chain as a relay: main-line sessions in handoff order, each with
         * the child sessions it delegated to hanging below it.
         */
        function RelayTrack({ sessions, features, currentSessionId, waiting }) {
          const known = new Set(sessions.map(session => session.sessionId))
          const isChild = session => typeof session.parentSessionId === 'string' && known.has(session.parentSessionId)
          const mainline = sessions.filter(session => !isChild(session))
          const kidsOf = parentId => sessions.filter(session => session.parentSessionId === parentId && isChild(session))
          const owned = sessionId => features.filter(feature => feature.assignedSessionId === sessionId)
          return h('div', {},
            h('ol', { className: 'relay-track' }, mainline.map((session, position) => {
              const state = stateOf(session) ?? 'idle'
              const retired = state === 'retired'
              const peak = session.peakRatio ?? 0
              const reading = retired || state === 'unloaded' ? peak : (session.pressureRatio ?? 0)
              const tokens = kilo(session.pressureTokens)
              const windowSize = kilo(session.contextWindow)
              const usage = tokens !== '' && windowSize !== '' ? ` (${tokens}/${windowSize})` : ''
              const first = retired
                ? `${label('reason', session.retireReason) || label('state', 'retired')}${t('sep')}${t('peak')} ${pct(peak)}%`
                : state === 'unloaded'
                  ? t('unloadedNote')
                  : `${t('pressure')} ${pct(reading)}%${usage}`
              const lasted = span(session.joinedAt, retired ? session.retiredAt : undefined)
              const second = `${t('compactions')} ${session.compactions ?? 0}${lasted === '' ? '' : `${t('sep')}${lasted}`}`
              const kids = kidsOf(session.sessionId)
              return h('li', {
                key: session.sessionId,
                className: `relay-leg is-${state}${session.sessionId === currentSessionId ? ' is-current' : ''}`,
              },
                h('span', { className: 'relay-leg-dot', 'aria-hidden': true }),
                h('button', {
                  type: 'button',
                  className: 'relay-leg-card',
                  title: `${t('openSession')} ${session.sessionId}${t('sep')}${t('peak')} ${pct(Math.max(peak, reading))}%`,
                  onClick: () => openSession(session.sessionId),
                },
                  h('span', { className: 'relay-leg-top' },
                    h('span', { className: 'relay-leg-no' },
                      `${t('leg').replace('{n}', String(position + 1))} ${label('role', session.role)}`),
                    waiting.has(session.sessionId) ? h('span', { className: 'relay-chip is-warn' }, t('decisionShort')) : null,
                    h(StatePill, { session }),
                  ),
                  h('span', { className: 'relay-mono' }, shortId(session.sessionId)),
                  h(Gauge, { ratio: reading, peak, muted: retired || state === 'unloaded' }),
                  h('span', { className: 'relay-leg-line' }, first),
                  h('span', { className: 'relay-leg-line' }, second),
                ),
                kids.length === 0 ? null : h('ul', { className: 'relay-kids' }, kids.map((kid) => {
                  const mine = owned(kid.sessionId)
                  return h('li', { key: kid.sessionId },
                    h('button', {
                      type: 'button',
                      className: 'relay-kid',
                      title: `${t('openSession')} ${kid.sessionId}`,
                      onClick: () => openSession(kid.sessionId),
                    },
                      h('span', {}, t('childrenShort')),
                      h('span', { className: 'relay-mono' }, shortId(kid.sessionId)),
                      mine.length === 0 ? null : h('b', {}, `${mine.filter(feature => feature.passes).length}/${mine.length}`),
                      h('span', {}, label('state', stateOf(kid) ?? 'idle')),
                    ))
                })),
              )
            })),
            h('div', { className: 'relay-track-note' },
              t('thresholds').replace('{w}', String(pct(thresholds.wrapup))).replace('{h}', String(pct(thresholds.handoff)))),
          )
        }

        /** One feature: what it is, how far it is proven, and who holds it. */
        function FeatureRow({ feature, onAccept }) {
          const coverage = typeof feature.coverage === 'string' ? feature.coverage : null
          const showsCoverage = feature.passes && coverage !== null && coverage !== 'full'
          const accepted = feature.acceptedBy === 'human'
          const owner = typeof feature.assignedSessionId === 'string' && feature.assignedSessionId.length > 0
            ? feature.assignedSessionId
            : null
          const proof = feature.passes ? feature.evidence : feature.verify
          const acceptable = onAccept !== undefined && showsCoverage
          return h('li', { className: `relay-feature${feature.passes ? ' is-done' : ''}` },
            h('span', { className: 'relay-check', 'aria-hidden': true }, feature.passes ? '✓' : '○'),
            h('span', { className: 'relay-mono' }, feature.id),
            h('div', { className: 'relay-feature-body' },
              h('span', { className: 'relay-feature-title' }, feature.title),
              showsCoverage || accepted || owner !== null || acceptable
                ? h('div', { className: 'relay-feature-tags' },
                  showsCoverage ? h('span', { className: 'relay-chip is-warn' }, label('coverage', coverage)) : null,
                  accepted ? h('span', { className: 'relay-chip is-human' }, t('acceptedByHuman')) : null,
                  owner === null ? null : h('span', { className: 'relay-chip', title: owner }, `${t('owner')} ${shortId(owner)}`),
                  acceptable
                    ? h('button', { type: 'button', className: 'relay-btn is-small', onClick: () => onAccept(feature, !accepted) },
                      accepted ? t('revokeCoverage') : t('acceptCoverage'))
                    : null,
                )
                : null,
              typeof proof === 'string' && proof.trim().length > 0
                ? h('div', { className: 'relay-feature-line' },
                  h('span', {}, feature.passes ? t('evidence') : t('verify')),
                  h('code', {}, proof),
                )
                : null,
              typeof feature.notes === 'string' && feature.notes.trim().length > 0
                ? h('div', { className: 'relay-feature-line' }, h('span', {}, feature.notes))
                : null,
            ),
          )
        }

        /** The chain's feature list with a pass-state filter. */
        function FeatureCard({ features, onAccept }) {
          const [filter, setFilter] = useState('all')
          const done = features.filter(feature => feature.passes).length
          const shown = features.filter(feature => (filter === 'all' ? true : filter === 'done' ? feature.passes : !feature.passes))
          const options = [
            { id: 'all', label: t('filterAll'), count: features.length },
            { id: 'pending', label: t('filterPending'), count: features.length - done },
            { id: 'done', label: t('statPassed'), count: done },
          ]
          return h('section', { className: 'relay-card' },
            h(CardTitle, { tools: features.length === 0 ? null : h(Seg, { options, value: filter, onChange: setFilter }) }, t('features')),
            features.length === 0
              ? h('div', { className: 'relay-text' }, t('noFeatures'))
              : shown.length === 0
                ? h('div', { className: 'relay-text' }, t('filterEmpty'))
                : h('ul', { className: 'relay-list' }, shown.map(feature => h(FeatureRow, { key: feature.id, feature, onAccept }))),
          )
        }

        /** Last fetched text per chain and document, so a revisit renders at once. */
        const docCache = new Map()

        /**
         * Reader for the chain's truth-source documents.
         * The handoff brief and progress arrive with the chain detail; the
         * ledgers are fetched when their tab is opened.
         */
        function DocsCard({ chainId, detail }) {
          const [name, setName] = useState('handoff')
          const [fetched, setFetched] = useState(() => docCache.get(`${chainId}:handoff`) ?? null)
          const [error, setError] = useState(null)
          const stamp = detail.chain?.updatedAt ?? ''
          const inline = DOCS.find(doc => doc.id === name)?.inline === true
          useEffect(() => {
            let live = true
            setError(null)
            setFetched(docCache.get(`${chainId}:${name}`) ?? null)
            if (inline) return () => { live = false }
            call('relay/chainDoc', { chainId, name })
              .then((value) => {
                if (!live) return
                const next = { text: typeof value?.text === 'string' ? value.text : '', truncated: value?.truncated === true }
                docCache.set(`${chainId}:${name}`, next)
                setFetched(next)
              })
              .catch((failure) => { if (live) setError(messageOf(failure)) })
            return () => { live = false }
          }, [chainId, name, inline, stamp])
          const text = inline ? (typeof detail[name] === 'string' ? detail[name] : '') : fetched?.text
          const body = (() => {
            if (error !== null) return h('div', { className: 'relay-error' }, `${t('failed')}: ${error}`)
            if (text === undefined) return h('div', { className: 'relay-text' }, t('loading'))
            if (text.trim().length === 0) return h('div', { className: 'relay-text' }, t('docEmpty'))
            return h('pre', { className: 'relay-doc', tabIndex: 0 }, text)
          })()
          return h('section', { className: 'relay-card' },
            h(CardTitle, {
              tools: h(Seg, { options: DOCS.map(doc => ({ id: doc.id, label: t(doc.label) })), value: name, onChange: setName }),
            }, t('docs')),
            !inline && fetched?.truncated === true ? h('div', { className: 'relay-text', style: { marginBottom: '6px' } }, t('docTruncated')) : null,
            body,
            typeof detail.truthDir === 'string'
              ? h('div', { className: 'relay-doc-foot' },
                h('span', {}, t('docLocation')),
                h('span', { className: 'relay-mono', title: detail.truthDir }, detail.truthDir),
                h(CopyButton, { text: detail.truthDir }, t('copyPath')),
              )
              : null,
          )
        }

        /** One readable line for an audit record. */
        function auditDetail(record) {
          const detail = record.detail ?? {}
          const joined = parts => parts.filter(part => typeof part === 'string' && part.length > 0).join(' ')
          switch (record.kind) {
            case 'chain.started': return `${t('auditMaxHandoffs')} ${detail.maxHandoffs ?? '?'}`
            case 'chain.finished': return detail.evidence ?? ''
            case 'feature.passed': return joined([detail.id, label('coverage', detail.coverage)])
            case 'feature.reopened': return detail.id ?? ''
            case 'feature.assigned': return `${detail.id} → ${typeof detail.to === 'string' ? shortId(detail.to) : t('unassigned')}`
            case 'feature.added': return joined([detail.id, detail.reason])
            case 'delegation.created': return `${shortId(detail.childSessionId)}: ${(detail.features ?? []).join(', ')}`
            case 'delegation.failed': return detail.error ?? ''
            case 'blocker.set': return joined([label('blocker', detail.kind), detail.action])
            case 'goal.seeded': return `${detail.rounds ?? '?'} ${t('rounds')}`
            case 'supervisor.decision': return joined([
              label('act', detail.action),
              label('reason', detail.reason ?? detail.by),
              typeof detail.ratio === 'number' ? `${pct(detail.ratio)}%` : '',
            ])
            case 'handoff.started': return joined([`${shortId(detail.from)} →`, label('reason', detail.reason)])
            case 'handoff.completed': return `${shortId(detail.from)} → ${shortId(detail.to)}`
            case 'handoff.failed': return detail.error ?? ''
            default: return ''
          }
        }

        /** Colour class for one audit kind. */
        function auditTone(kind) {
          if (typeof kind !== 'string') return ''
          if (kind.endsWith('.failed') || kind === 'blocker.set') return 'is-error'
          if (kind === 'feature.passed' || kind === 'chain.finished' || kind === 'handoff.completed' || kind === 'delegation.created') return 'is-key'
          if (kind.startsWith('supervisor.') || kind === 'chain.paused' || kind === 'session.ready' || kind === 'feature.reopened') return 'is-warn'
          return ''
        }

        /** Last audit page seen per chain, so a revisit renders before the poll. */
        const auditCache = new Map()

        /** Newest audit records for one chain, newest first. */
        function AuditCard({ chainId }) {
          const [records, setRecords] = useState(() => auditCache.get(chainId) ?? null)
          const [error, setError] = useState(null)
          const [filter, setFilter] = useState('all')
          useEffect(() => {
            let live = true
            setRecords(auditCache.get(chainId) ?? null)
            const load = () => {
              call('relay/chainAudit', { chainId, limit: 100 })
                .then((value) => {
                  if (!live) return
                  const next = Array.isArray(value) ? value : []
                  auditCache.set(chainId, next)
                  setRecords(next)
                  setError(null)
                })
                .catch((failure) => { if (live) setError(messageOf(failure)) })
            }
            load()
            const timer = setInterval(load, 10_000)
            return () => { live = false; clearInterval(timer) }
          }, [chainId])
          const all = records === null ? [] : records.slice().reverse()
          const isKey = record => auditTone(record.kind) === 'is-key'
          const isIssue = record => auditTone(record.kind) === 'is-error' || auditTone(record.kind) === 'is-warn'
          const rows = all.filter(record => (filter === 'all' ? true : filter === 'key' ? isKey(record) : isIssue(record)))
          const options = [
            { id: 'all', label: t('filterAll'), count: all.length },
            { id: 'key', label: t('auditKey'), count: all.filter(isKey).length },
            { id: 'issues', label: t('auditIssues'), count: all.filter(isIssue).length },
          ]
          const body = (() => {
            if (error !== null) return h('div', { className: 'relay-error' }, `${t('failed')}: ${error}`)
            if (records === null) return h('div', { className: 'relay-text' }, t('loading'))
            if (all.length === 0) return h('div', { className: 'relay-text' }, t('noAudit'))
            if (rows.length === 0) return h('div', { className: 'relay-text' }, t('filterEmpty'))
            return h('ul', { className: 'relay-list' }, rows.map((record, index) => h('li', {
              key: `${record.at ?? ''}-${index}`,
              className: `relay-audit-row ${auditTone(record.kind)}`,
            },
              h('span', { className: 'relay-audit-time' }, clock(record.at)),
              h('span', { className: 'relay-audit-kind', title: record.kind }, label('audit', record.kind)),
              h('span', { className: 'relay-audit-detail' }, auditDetail(record)),
              h('span', { className: 'relay-tag', title: record.actor }, /^session-/.test(record.actor ?? '') ? shortId(record.actor) : (record.actor ?? '')),
            )))
          })()
          return h('section', { className: 'relay-card' },
            h(CardTitle, { tools: all.length === 0 ? null : h(Seg, { options, value: filter, onChange: setFilter }) }, t('audit')),
            body,
          )
        }

        /** Everything about the selected chain. */
        function ChainDetail({ detail, onAct, busy, waiting }) {
          const [section, setSection] = useState('features')
          const chain = detail.chain ?? {}
          const sessions = Array.isArray(detail.sessions) ? detail.sessions : []
          const features = Array.isArray(detail.features) ? detail.features : []
          const total = chain.featuresTotal ?? features.length
          const done = chain.featuresDone ?? features.filter(feature => feature.passes).length
          const current = sessions.find(session => session.sessionId === chain.currentSessionId) ?? null
          const currentState = stateOf(current)
          const live = currentState === 'running' || currentState === 'idle'
          const pressure = live ? (current.pressureRatio ?? 0) : null
          const isPaused = chain.status === 'paused'
          const isDone = chain.status === 'done'
          const deletable = chain.status !== 'active' && chain.status !== 'initializing'
          const blocker = chain.blocker ?? null
          const phase = phaseOf(chain)
          const handoffCap = chain.maxHandoffs ?? 0
          const handoffTone = handoffCap > 0 && (chain.handoffCount ?? 0) >= Math.max(1, Math.floor(handoffCap * 0.7)) ? 'warn' : 'brand'
          const metas = [
            { label: t('progress'), value: `${done}/${total}`, tone: total > 0 && done === total ? 'success' : 'brand' },
            { label: t('statHandoffs'), value: `${chain.handoffCount ?? 0}/${handoffCap}`, tone: handoffTone },
            { label: t('sessions'), value: `${sessions.length}`, tone: 'brand' },
            { label: t('pressure'), value: pressure === null ? '–' : `${pct(pressure)}%`, tone: pressure === null ? 'brand' : toneOf(pressure) },
          ]
          if ((chain.coveragePartial ?? 0) > 0) {
            metas.push({ label: t('partialCoverage'), value: `${chain.coveragePartial}`, tone: 'warn' })
          }
          const handoffBlocked = isDone ? t('handoffDone') : (current === null || !live ? t('handoffUnloaded') : undefined)
          const sections = [
            { id: 'features', label: t('features'), count: `${done}/${total}` },
            { id: 'docs', label: t('docs') },
            { id: 'audit', label: t('audit') },
          ]
          return h('div', { className: `relay-detail is-${chain.status}` },
            h('section', { className: 'relay-card' },
              h('div', { className: 'relay-detail-head' },
                h('div', { className: 'relay-detail-main' },
                  h('h3', { className: 'relay-detail-title' }, chain.title || chain.chainId),
                  h('div', { className: 'relay-pills' },
                    h('span', { className: `relay-status is-${chain.status}` }, label('status', chain.status)),
                    phase === null ? null : h('span', { className: 'relay-status is-warn' }, t(phase)),
                    blocker === null
                      ? null
                      : h('span', { className: `relay-status is-${blocker.kind === 'external' ? 'failed' : 'paused'}` }, label('blocker', blocker.kind)),
                  ),
                ),
                h('div', { className: 'relay-actions' },
                  h('button', {
                    type: 'button',
                    className: 'relay-btn',
                    disabled: busy || isDone,
                    title: isDone ? t('pauseDone') : undefined,
                    onClick: () => { void onAct('relay/setPaused', { chainId: chain.chainId, paused: !isPaused }) },
                  }, isPaused ? t('resume') : t('pause')),
                  h(ConfirmButton, {
                    primary: true,
                    disabled: busy || handoffBlocked !== undefined,
                    title: handoffBlocked,
                    confirmLabel: t('confirmHandoff'),
                    onConfirm: () => { void onAct('relay/handoffNow', { chainId: chain.chainId }) },
                  }, t('handoffNow')),
                  chain.pausedBy === 'handoff-limit'
                    ? h('button', {
                      type: 'button',
                      className: 'relay-btn',
                      disabled: busy,
                      onClick: () => {
                        void onAct('relay/raiseHandoffLimit', {
                          chainId: chain.chainId,
                          maxHandoffs: Math.min(1000, (chain.maxHandoffs ?? 32) + 8),
                        })
                      },
                    }, t('raiseHandoffLimit'))
                    : null,
                  h(ConfirmButton, {
                    disabled: busy || !deletable,
                    title: deletable ? undefined : t('deleteBlocked'),
                    confirmLabel: t('confirmDelete'),
                    note: t('deleteNote'),
                    onConfirm: () => { void onAct('relay/deleteChain', { chainId: chain.chainId }) },
                  }, t('delete')),
                ),
              ),
              h('p', { className: 'relay-text' }, chain.objective),
              typeof chain.lastError === 'string' && chain.lastError.length > 0
                ? h('div', { className: 'relay-error' }, chain.lastError)
                : null,
              blocker === null
                ? null
                : h('div', { className: `relay-blocker is-${blocker.kind}` },
                  h('span', { className: 'relay-blocker-kind' }, label('blocker', blocker.kind)),
                  h('span', {}, blocker.action ?? ''),
                  blocker.who ? h('span', { className: 'relay-tag' }, blocker.who) : null,
                ),
              h('div', { className: 'relay-metas' },
                metas.map(meta => h('div', { key: meta.label, className: `relay-meta is-${meta.tone}` },
                  h('span', { className: 'relay-meta-value' }, meta.value),
                  h('span', { className: 'relay-meta-label' }, meta.label),
                )),
              ),
              h('div', { className: 'relay-progress-line' }, h(Bar, { done, total })),
              h('dl', { className: 'relay-facts' },
                h('dt', {}, t('workspace')),
                h('dd', {},
                  h('span', { className: 'relay-mono', title: chain.cwd }, chain.cwd ?? ''),
                  typeof chain.cwd === 'string' ? h(CopyButton, { text: chain.cwd }, t('copy')) : null,
                ),
                h('dt', {}, t('currentSession')),
                h('dd', {},
                  current === null
                    ? h('span', { className: 'relay-tag' }, t('none'))
                    : h(React.Fragment, {},
                      h('span', { className: 'relay-mono', title: current.sessionId }, shortId(current.sessionId)),
                      h(StatePill, { session: current }),
                      h('button', { type: 'button', className: 'relay-btn is-small', onClick: () => openSession(current.sessionId) }, t('open')),
                    ),
                ),
                h('dt', {}, t('updatedAt')),
                h('dd', {},
                  h('span', { title: chain.updatedAt }, ago(chain.updatedAt)),
                  typeof chain.createdAt === 'string'
                    ? h('span', { className: 'relay-tag', title: chain.createdAt }, `${t('createdAt')} ${ago(chain.createdAt)}`)
                    : null,
                ),
              ),
            ),
            h('section', { className: 'relay-card' },
              h(CardTitle, { icon: true, sub: `${chain.handoffCount ?? 0}/${handoffCap} ${t('statHandoffs')}` }, t('track')),
              sessions.length === 0
                ? h('div', { className: 'relay-text' }, t('none'))
                : h(RelayTrack, { sessions, features, currentSessionId: chain.currentSessionId, waiting }),
            ),
            h('div', { style: { marginBottom: '8px' } }, h(Seg, { options: sections, value: section, onChange: setSection })),
            section === 'features'
              ? h(FeatureCard, {
                features,
                onAccept: (target, accepted) => {
                  void onAct('relay/acceptCoverage', { chainId: chain.chainId, featureId: target.id, accepted })
                },
              })
              : null,
            section === 'docs' ? h(DocsCard, { chainId: chain.chainId, detail }) : null,
            section === 'audit' ? h(AuditCard, { chainId: chain.chainId }) : null,
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
            loadThresholds()
            const load = () => {
              call('relay/sessionView', { sessionId })
                .then((value) => {
                  if (!live) return
                  const next = value ?? null
                  sessionViewCache.set(sessionId, next)
                  setView(next)
                  setError(null)
                })
                .catch((failure) => { if (live) setError(messageOf(failure)) })
            }
            load()
            const timer = setInterval(load, POLL_MS)
            return () => { live = false; clearInterval(timer) }
          }, [sessionId])
          return { view, error }
        }

        /** Shared frame for the two session-scoped tabs. */
        function TabShell({ children }) {
          return h('div', { className: 'relay-tab' },
            h('style', { 'data-plugin': 'longtask-relay' }, CSS),
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

        /** The chain a session tab belongs to, with the way back to the panel. */
        function ChainBanner({ chain }) {
          const total = chain.featuresTotal ?? 0
          const done = chain.featuresDone ?? 0
          const blocker = chain.blocker ?? null
          const phase = phaseOf(chain)
          return h('section', { className: `relay-card relay-banner is-${chain.status}` },
            h('div', { className: 'relay-banner-main' },
              h('div', { className: 'relay-banner-title' },
                h('b', {}, chain.title || chain.chainId),
                h('span', { className: `relay-status is-${chain.status}` }, label('status', chain.status)),
                phase === null ? null : h('span', { className: 'relay-status is-warn' }, t(phase)),
                blocker === null
                  ? null
                  : h('span', { className: `relay-status is-${blocker.kind === 'external' ? 'failed' : 'paused'}`, title: blocker.action }, label('blocker', blocker.kind)),
              ),
              h('div', { className: 'relay-banner-objective', title: chain.objective }, chain.objective ?? ''),
            ),
            h('div', { className: 'relay-banner-side' },
              h('div', { className: 'relay-banner-progress' },
                h('span', {},
                  `${t('statProgress')} `, h('b', {}, `${done}/${total}`),
                  `${t('sep')}${t('statHandoffs')} `, h('b', {}, `${chain.handoffCount ?? 0}/${chain.maxHandoffs ?? 0}`)),
                h(Bar, { done, total }),
              ),
              h('button', { type: 'button', className: 'relay-btn', onClick: () => showChainInPanel(chain.chainId) }, t('viewInPanel')),
            ),
          )
        }

        /** Context reading of one live session, as a labelled meter. */
        function GaugeRow({ session }) {
          const state = stateOf(session)
          if (state === 'unloaded') return h('div', { className: 'relay-gauge-row' }, t('unloadedNote'))
          const retired = state === 'retired'
          const reading = retired ? (session.peakRatio ?? 0) : (session.pressureRatio ?? 0)
          return h('div', { className: 'relay-gauge-row' },
            h('span', {}, retired ? t('peak') : t('pressure')),
            h(Gauge, { ratio: reading, peak: session.peakRatio ?? 0, muted: retired }),
            h('span', {}, `${pct(reading)}%`),
          )
        }

        /** Pill and chip for a session's goal; nothing when it has none. */
        function GoalPills({ goal }) {
          if (goal === null || goal === undefined) return null
          return h('div', { className: 'relay-pills' },
            h('span', { className: `relay-status is-${GOAL_TONES[goal.phase] ?? 'paused'}` }, label('goal', goal.phase)),
            h('span', { className: `relay-chip${goal.activation === 'armed' ? '' : ' is-warn'}` },
              goal.activation === 'armed' ? t('goalArmed') : t('goalDisarmed')),
            h('span', { className: 'relay-tag' }, `${t('goalRounds')} ${goal.roundsStarted ?? 0}/${goal.maxGoalRounds ?? 0}`),
          )
        }

        /** One delegated child session card. */
        function ChildCard({ child, waiting }) {
          const state = stateOf(child) ?? 'idle'
          const owned = Array.isArray(child.featureList)
            ? child.featureList
            : (Array.isArray(child.features) ? child.features.map(id => ({ id, title: '', passes: false })) : [])
          const passed = child.featuresPassed ?? owned.filter(feature => feature.passes).length
          return h('section', { className: `relay-card relay-child is-${waiting ? 'waiting' : state}` },
            h('div', { className: 'relay-child-top' },
              h('span', { className: 'relay-mono', title: child.sessionId }, shortId(child.sessionId)),
              waiting ? h('span', { className: 'relay-status is-warn' }, t('decisionShort')) : null,
              h(StatePill, { session: child }),
              h('button', { type: 'button', className: 'relay-btn is-small', onClick: () => openSession(child.sessionId) }, t('open')),
            ),
            h(GaugeRow, { session: child }),
            h('div', { className: 'relay-metas' },
              h('div', { className: 'relay-meta is-brand' },
                h('span', { className: 'relay-meta-value' }, label('role', child.role)),
                h('span', { className: 'relay-meta-label' }, t('roleLabel'))),
              h('div', { className: `relay-meta is-${owned.length > 0 && passed === owned.length ? 'success' : 'brand'}` },
                h('span', { className: 'relay-meta-value' }, `${passed}/${owned.length}`),
                h('span', { className: 'relay-meta-label' }, t('featuresLabel'))),
              h('div', { className: `relay-meta${(child.compactions ?? 0) > 0 ? ' is-warn' : ''}` },
                h('span', { className: 'relay-meta-value' }, String(child.compactions ?? 0)),
                h('span', { className: 'relay-meta-label' }, t('compactions'))),
            ),
            state === 'retired' && typeof child.retireReason === 'string'
              ? h('div', { className: 'relay-tag' }, label('reason', child.retireReason))
              : null,
            h(GoalPills, { goal: child.goal }),
            owned.length === 0
              ? null
              : h('ul', { className: 'relay-child-list' }, owned.map(feature => h('li', {
                key: feature.id,
                className: `relay-child-feature${feature.passes ? ' is-done' : ''}`,
              },
                h('span', { className: 'relay-check', 'aria-hidden': true }, feature.passes ? '✓' : '○'),
                h('span', { className: 'relay-mono' }, feature.id),
                h('span', {}, feature.title),
              ))),
          )
        }

        /** Session tab: the children this session delegated work to. */
        function ChildrenTab({ sessionId }) {
          const { view, error } = useSessionView(sessionId)
          // Every hook runs before the early returns below: a render that
          // gains a hook after the data arrives throws in React.
          const decisions = usePendingDecisions()
          if (error !== null) return h(TabShell, {}, h(TabEmpty, { title: t('failed'), body: error }))
          if (view === undefined) return h(TabShell, {}, h('div', { className: 'relay-text' }, t('loading')))
          if (view === null || view.chain === null) return h(TabShell, {}, h(TabEmpty, { title: t('noChainTitle'), body: t('noChainBody') }))
          const children = Array.isArray(view.children) ? view.children : []
          const running = children.filter(child => stateOf(child) === 'running').length
          const owned = children.reduce((sum, child) => sum + (Array.isArray(child.features) ? child.features.length : 0), 0)
          const passed = children.reduce((sum, child) => sum + (child.featuresPassed ?? 0), 0)
          const kpis = [
            { label: t('childCount'), value: children.length, tone: 'brand' },
            { label: t('statRunning'), value: running, tone: 'success' },
            { label: t('featuresLabel'), value: owned, tone: 'business' },
            { label: t('statPassed'), value: passed, tone: 'success' },
          ]
          const waiting = new Set(decisions.map(decision => decision.sessionId).filter(id => typeof id === 'string'))
          const isCurrent = view.chain.currentSessionId === sessionId
          return h(TabShell, {},
            h(ChainBanner, { chain: view.chain }),
            children.length === 0
              ? h(TabEmpty, { title: t('noChildrenTitle'), body: isCurrent ? t('noChildrenBody') : t('noChildrenNotCurrent') })
              : h(React.Fragment, {},
                h(Kpis, { items: kpis }),
                h('div', { className: 'relay-children' },
                  children.map(child => h(ChildCard, {
                    key: child.sessionId,
                    child,
                    waiting: waiting.has(child.sessionId),
                  }))),
              ),
          )
        }

        /** Session tab: the work this session received and how far it got. */
        function TasksTab({ sessionId }) {
          const { view, error } = useSessionView(sessionId)
          if (error !== null) return h(TabShell, {}, h(TabEmpty, { title: t('failed'), body: error }))
          if (view === undefined) return h(TabShell, {}, h('div', { className: 'relay-text' }, t('loading')))
          if (view === null || view.chain === null) return h(TabShell, {}, h(TabEmpty, { title: t('noChainTitle'), body: t('noChainBody') }))
          const self = view.self ?? {}
          const parent = view.parent ?? null
          const delegated = parent !== null
          // A delegated session owns what it was assigned; a main-line session
          // owns whatever was not delegated to anyone.
          const features = delegated
            ? (Array.isArray(view.assignedFeatures) ? view.assignedFeatures : [])
            : (Array.isArray(view.openFeatures) ? view.openFeatures : [])
          const done = features.filter(feature => feature.passes).length
          const state = stateOf(self)
          const reading = state === 'retired' ? (self.peakRatio ?? 0) : (self.pressureRatio ?? 0)
          const kpis = [
            { label: t('featuresLabel'), value: features.length, tone: 'brand' },
            { label: t('statPassed'), value: done, tone: 'success' },
            { label: state === 'retired' ? t('statContext') : t('pressure'), value: `${pct(reading)}%`, tone: toneOf(reading) },
            { label: t('compactions'), value: self.compactions ?? 0, tone: (self.compactions ?? 0) > 0 ? 'warn' : 'brand' },
          ]
          const currentId = view.chain.currentSessionId
          const isCurrent = currentId === sessionId
          const handedOver = !delegated && state === 'retired' && typeof currentId === 'string' && !isCurrent
          const goal = self.goal ?? null
          return h(TabShell, {},
            h(ChainBanner, { chain: view.chain }),
            h(Kpis, { items: kpis }),
            h('div', { className: 'relay-task-grid' },
              h('div', { className: 'relay-task-side' },
                h('section', { className: 'relay-card' },
                  h(CardTitle, {}, t('positionTitle')),
                  h('div', { className: 'relay-pills' },
                    h('span', { className: 'relay-chip' }, delegated ? t('posChild') : t('posMainline')),
                    typeof self.role === 'string' ? h('span', { className: 'relay-chip' }, label('role', self.role)) : null,
                    isCurrent ? h('span', { className: 'relay-chip is-human' }, t('posCurrent')) : null,
                    h(StatePill, { session: self }),
                  ),
                  delegated
                    ? h('dl', { className: 'relay-facts' },
                      h('dt', {}, t('parentTitle')),
                      h('dd', {},
                        h('span', { className: 'relay-mono', title: parent.sessionId }, shortId(parent.sessionId)),
                        h(StatePill, { session: parent }),
                        h('button', { type: 'button', className: 'relay-btn is-small', onClick: () => openSession(parent.sessionId) }, t('open')),
                      ),
                    )
                    : null,
                  handedOver
                    ? h('dl', { className: 'relay-facts' },
                      h('dt', {}, t('posSuccessor')),
                      h('dd', {},
                        h('span', { className: 'relay-mono', title: currentId }, shortId(currentId)),
                        h('button', { type: 'button', className: 'relay-btn is-small', onClick: () => openSession(currentId) }, t('open')),
                      ),
                    )
                    : null,
                  state === 'retired' && typeof self.retireReason === 'string'
                    ? h('div', { className: 'relay-tag', style: { marginTop: '6px' } }, label('reason', self.retireReason))
                    : null,
                ),
                h('section', { className: 'relay-card' },
                  h(CardTitle, {}, t('goalTitle')),
                  goal === null
                    ? h('div', { className: 'relay-text' }, t('noGoal'))
                    : h('div', {},
                      h(GoalPills, { goal }),
                      goal.blockedMessage === null || goal.blockedMessage === undefined
                        ? null
                        : h('div', { className: 'relay-text', style: { marginTop: '6px' } }, goal.blockedMessage),
                    ),
                ),
              ),
              h('section', { className: `relay-card is-${view.chain.status}` },
                h(CardTitle, { sub: `${done}/${features.length}` }, delegated ? t('assignedTitle') : t('mainlineTitle')),
                delegated ? null : h('div', { className: 'relay-text', style: { marginBottom: '8px' } }, t('mainlineNote')),
                h('div', { style: { marginBottom: '10px' } }, h(Bar, { done, total: features.length })),
                features.length === 0
                  ? h('div', { className: 'relay-text' }, t('none'))
                  : h('ul', { className: 'relay-list' }, features.map(feature => h(FeatureRow, { key: feature.id, feature }))),
              ),
            ),
          )
        }

        /** Last config payload, so the plugin page does not flash its form. */
        const configCache = { value: null, editable: false }

        /** The context window split by the two ratios being edited. */
        function ZoneBar({ wrapup, handoff }) {
          const low = Math.max(0, Math.min(1, wrapup))
          const high = Math.max(low, Math.min(1, handoff))
          return h('div', {},
            h('div', { className: 'relay-zones', 'aria-hidden': true },
              h('div', { className: 'relay-zone is-work', style: { width: `${low * 100}%` } }, t('zoneWork')),
              h('div', { className: 'relay-zone is-wrapup', style: { width: `${(high - low) * 100}%` } }, t('zoneWrapup')),
              h('div', { className: 'relay-zone is-handoff', style: { width: `${(1 - high) * 100}%` } }, t('zoneHandoff')),
            ),
            h('div', { className: 'relay-zone-scale' },
              h('span', {}, '0%'),
              h('span', {}, `${t('zoneWrapup')} ${pct(low)}%${t('sep')}${t('zoneHandoff')} ${pct(high)}%`),
              h('span', {}, '100%'),
            ),
          )
        }

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
              if (typeof next.wrapupRatio === 'number') thresholds.wrapup = next.wrapupRatio
              if (typeof next.handoffRatio === 'number') thresholds.handoff = next.handoffRatio
              setConfig(next)
              setEditable(configCache.editable)
              setError(null)
            } catch (failure) {
              setError(messageOf(failure))
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
                if ((field.kind === 'text' || field.kind === 'select') && typeof value !== 'string') delete cleaned[field.key]
                if (field.kind === 'boolean' && typeof value !== 'boolean') delete cleaned[field.key]
              }
            }
            try {
              await call('relay/saveConfig', { config: cleaned })
              setStatus({ kind: 'ok', text: t('saved') })
              await load()
            } catch (failure) {
              setStatus({ kind: 'error', text: messageOf(failure) })
            } finally {
              setBusy(false)
            }
          }

          const body = (() => {
            if (loading && config === null) return h('div', { className: 'relay-config-note' }, t('loading'))
            if (error !== null) return h('div', { className: 'relay-error' }, `${t('failed')}: ${error}`)
            if (config === null) return null
            const wrapup = typeof config.wrapupRatio === 'number' ? config.wrapupRatio : 0
            const handoff = typeof config.handoffRatio === 'number' ? config.handoffRatio : 0
            const disordered = wrapup >= handoff
            const dirty = JSON.stringify(config) !== JSON.stringify(configCache.value)
            const control = (field) => {
              const locked = !editable || busy
              if (field.kind === 'boolean') {
                return h('div', { className: 'relay-check-field' },
                  h('input', {
                    id: `relay-field-${field.key}`,
                    className: 'relay-switch',
                    type: 'checkbox',
                    role: 'switch',
                    checked: config[field.key] === true,
                    disabled: locked,
                    onChange: event => setField(field.key, event.target.checked),
                  }))
              }
              if (field.kind === 'select') {
                return h('select', {
                  id: `relay-field-${field.key}`,
                  className: 'relay-input',
                  value: config[field.key] ?? '',
                  disabled: locked,
                  onChange: event => setField(field.key, event.target.value),
                }, field.options.map(option => h('option', { key: option, value: option }, option)))
              }
              const ratioField = field.key === 'wrapupRatio' || field.key === 'handoffRatio'
              return h('input', {
                id: `relay-field-${field.key}`,
                className: `relay-input${ratioField && disordered ? ' is-invalid' : ''}`,
                type: field.kind === 'text' ? 'text' : 'number',
                value: config[field.key] ?? '',
                step: field.step,
                min: field.min,
                max: field.max,
                disabled: locked,
                onChange: event => setField(
                  field.key,
                  field.kind === 'text' ? event.target.value : (event.target.value === '' ? '' : Number(event.target.value)),
                ),
              })
            }
            return h('div', {},
              h(ZoneBar, { wrapup, handoff }),
              CONFIG_GROUPS.map(group => h('div', { key: group.title, className: 'relay-group' },
                h('div', { className: 'relay-group-title' }, group.title),
                group.fields.map(field => h('div', { key: field.key, className: 'relay-field' },
                  h('label', { className: 'relay-field-label', htmlFor: `relay-field-${field.key}` },
                    h('span', { className: 'relay-field-name' },
                      field.label,
                      h('span', { className: 'relay-field-key' }, field.key),
                    ),
                    field.hint ? h('span', { className: 'relay-field-hint' }, field.hint) : null,
                  ),
                  control(field),
                )),
              )),
              h('div', { className: 'relay-config-actions' },
                h('button', { type: 'button', className: 'relay-btn is-primary', disabled: !editable || busy || disordered || !dirty, onClick: () => { void save() } }, t('save')),
                h('button', { type: 'button', className: 'relay-btn', disabled: busy || !dirty, onClick: () => { setStatus(null); void load() } }, t('reset')),
                disordered ? h('span', { className: 'relay-config-status is-error' }, t('ratioOrder')) : null,
                status === null || disordered
                  ? null
                  : h('span', { className: `relay-config-status${status.kind === 'ok' ? ' is-ok' : ' is-error'}` }, status.text),
                status === null && !disordered && !editable
                  ? h('span', { className: 'relay-config-status' }, t('readonlyHost'))
                  : null,
              ),
            )
          })()

          return h('div', { className: 'relay-config' },
            h('style', { 'data-plugin': 'longtask-relay' }, CSS),
            h('div', { className: 'relay-config-title' }, t('configTitle')),
            h('div', { className: 'relay-config-note' }, t('configNote')),
            body,
          )
        }

        /**
         * Last panel payload, so reopening the panel renders before the poll.
         * `chains === null` means nothing has loaded yet.
         */
        const panelCache = { chains: null, detail: null, selectedId: null }

        /** The panel: every chain on the left, one chain in full on the right. */
        function RelayPage() {
          const [chains, setChains] = useState(() => panelCache.chains ?? [])
          const [detail, setDetail] = useState(() => panelCache.detail ?? null)
          const [selectedId, setSelectedId] = useState(() => focus.chainId ?? panelCache.selectedId)
          const [error, setError] = useState(null)
          const [loading, setLoading] = useState(() => panelCache.chains === null)
          const [busy, setBusy] = useState(false)
          const [filter, setFilter] = useState('all')
          const selectedRef = useRef(focus.chainId ?? panelCache.selectedId)
          const decisions = usePendingDecisions()

          const refresh = useCallback(async () => {
            try {
              const listed = await call('relay/listChains')
              const next = Array.isArray(listed?.chains) ? listed.chains : []
              // Keep the reader's chain while it exists; otherwise show the
              // most recently updated one so the detail side is never blank.
              let wanted = selectedRef.current
              if (wanted === null || !next.some(chain => chain.chainId === wanted)) {
                wanted = next.length === 0 ? null : next[0].chainId
                selectedRef.current = wanted
                panelCache.selectedId = wanted
                setSelectedId(wanted)
              }
              const nextDetail = wanted === null ? null : await call('relay/chainDetail', { chainId: wanted })
              panelCache.chains = next
              setChains(next)
              // The reader may have picked another chain while this one loaded.
              if (selectedRef.current === wanted) {
                panelCache.detail = nextDetail
                setDetail(nextDetail)
              }
              setError(null)
              setLoading(false)
            } catch (failure) {
              setError(messageOf(failure))
              setLoading(false)
            }
          }, [])

          const select = useCallback((chainId) => {
            selectedRef.current = chainId
            panelCache.selectedId = chainId
            setSelectedId(chainId)
            void refresh()
          }, [refresh])

          useEffect(() => {
            focus.chainId = null
            focus.listeners.add(select)
            loadThresholds()
            void refresh()
            const timer = setInterval(() => { void refresh() }, POLL_MS)
            return () => {
              focus.listeners.delete(select)
              clearInterval(timer)
            }
          }, [refresh, select])

          const act = useCallback(async (endpoint, args) => {
            setBusy(true)
            let failure = null
            try {
              await call(endpoint, args)
            } catch (caught) {
              failure = messageOf(caught)
            }
            setBusy(false)
            await refresh()
            if (failure !== null) setError(failure)
          }, [refresh])

          const sessionsOf = chain => (Array.isArray(chain.sessionsDetail) ? chain.sessionsDetail : [])
          const isActive = chain => chain.status === 'active' || chain.status === 'initializing'
          const active = chains.filter(isActive).length
          const paused = chains.filter(chain => chain.status === 'paused' || chain.status === 'failed').length
          const doneChains = chains.filter(chain => chain.status === 'done').length
          const sessionCount = chains.reduce((sum, chain) => sum + (chain.sessions ?? 0), 0)
          const runningSessions = chains.reduce((sum, chain) => sum + sessionsOf(chain).filter(session => session.running).length, 0)
          const featureTotal = chains.reduce((sum, chain) => sum + (chain.featuresTotal ?? 0), 0)
          const featureDone = chains.reduce((sum, chain) => sum + (chain.featuresDone ?? 0), 0)
          const partial = chains.reduce((sum, chain) => sum + (chain.coveragePartial ?? 0), 0)
          const peak = chains.reduce((max, chain) => Math.max(max, ...sessionsOf(chain).map(session => session.peakRatio ?? 0)), 0)

          /** The chain a session belongs to, among the listed chains. */
          const chainOfSession = sessionId => chains.find(chain => sessionsOf(chain).some(session => session.sessionId === sessionId))
          const waiting = new Set(decisions.map(decision => decision.sessionId).filter(id => typeof id === 'string'))

          // Everything that is waiting on a human, most actionable first.
          const attention = []
          for (const decision of decisions) {
            const owner = typeof decision.sessionId === 'string' ? chainOfSession(decision.sessionId) : undefined
            attention.push({
              key: decision.key,
              tone: 'warn',
              kind: decision.kind === 'approval' ? t('attnApproval') : t('attnQuestion'),
              text: decision.title || decision.detail || '',
              meta: [owner?.title, shortId(decision.sessionId), decision.detail].filter(part => typeof part === 'string' && part.length > 0).join(' / '),
              action: typeof decision.sessionId === 'string' ? { label: t('openSession'), run: () => openSession(decision.sessionId) } : null,
            })
          }
          for (const chain of chains) {
            if (chain.blocker !== null && chain.blocker !== undefined) {
              attention.push({
                key: `blocker:${chain.chainId}`,
                tone: chain.blocker.kind === 'external' ? 'error' : 'warn',
                kind: label('blocker', chain.blocker.kind),
                text: chain.blocker.action ?? '',
                meta: [chain.title, chain.blocker.who].filter(part => typeof part === 'string' && part.length > 0).join(' / '),
                action: { label: t('viewChain'), run: () => select(chain.chainId) },
              })
            }
            if (typeof chain.lastError === 'string' && chain.lastError.length > 0) {
              attention.push({
                key: `error:${chain.chainId}`,
                tone: 'error',
                kind: t('attnError'),
                text: chain.lastError,
                meta: chain.title ?? '',
                action: { label: t('viewChain'), run: () => select(chain.chainId) },
              })
            }
          }

          const kpis = [
            { label: t('statChains'), value: chains.length, sub: `${active} ${t('statActive')} / ${doneChains} ${t('statDone')}`, tone: 'brand' },
            { label: t('statAttention'), value: attention.length, sub: `${paused} ${t('statPaused')}`, tone: attention.length > 0 ? 'warn' : 'success' },
            { label: t('statProgress'), value: `${featureDone}/${featureTotal}`, sub: partial > 0 ? `${partial} ${t('partialCoverage')}` : '', tone: 'business' },
            { label: t('statSessions'), value: sessionCount, sub: `${runningSessions} ${t('statRunning')}`, tone: 'brand' },
            { label: t('statContext'), value: `${pct(peak)}%`, sub: t('statContextSub'), tone: toneOf(peak) },
          ]

          const filters = [
            { id: 'all', label: t('filterAll'), count: chains.length },
            { id: 'active', label: t('statActive'), count: active },
            { id: 'stopped', label: t('statPaused'), count: paused },
            { id: 'done', label: t('statDone'), count: doneChains },
          ]
          const shown = chains.filter((chain) => {
            if (filter === 'active') return isActive(chain)
            if (filter === 'stopped') return chain.status === 'paused' || chain.status === 'failed'
            if (filter === 'done') return chain.status === 'done'
            return true
          })
          const chainWaits = chain => sessionsOf(chain).some(session => waiting.has(session.sessionId))

          return h('div', { className: 'relay-page' },
            h('style', { 'data-plugin': 'longtask-relay' }, CSS),
            h('div', { className: 'relay-scroll' },
              h('div', { className: 'relay-content' },
                h('div', { className: 'relay-head' },
                  h('h2', { className: 'relay-title' }, t('panel')),
                  h('div', { className: 'relay-head-actions' },
                    h('button', { type: 'button', className: 'relay-btn', onClick: openPluginPage }, t('openPluginPage')),
                    h('button', { type: 'button', className: 'relay-btn', onClick: () => { void refresh() } }, t('refresh')),
                  ),
                ),
                chains.length === 0 ? null : h(Kpis, { items: kpis }),
                error === null ? null : h('div', { className: 'relay-error' }, `${t('failed')}: ${error}`),
                attention.length === 0 ? null : h('section', { className: 'relay-card is-attn' },
                  h(CardTitle, { sub: String(attention.length) }, t('attention')),
                  h('ul', { className: 'relay-attn' }, attention.map(item => h('li', {
                    key: item.key,
                    className: `relay-attn-item is-${item.tone}`,
                  },
                    h('span', { className: 'relay-attn-kind' }, item.kind),
                    h('span', { className: 'relay-attn-main' },
                      h('span', { className: 'relay-attn-text' }, item.text),
                      item.meta === '' ? null : h('span', { className: 'relay-attn-meta' }, item.meta),
                    ),
                    item.action === null
                      ? null
                      : h('button', { type: 'button', className: 'relay-btn', onClick: item.action.run }, item.action.label),
                  ))),
                ),
                loading && chains.length === 0 ? h('div', { className: 'relay-text' }, t('loading')) : null,
                !loading && chains.length === 0
                  ? h('section', { className: 'relay-card' }, h(EmptyState))
                  : null,
                chains.length === 0 ? null : h('div', { className: 'relay-split' },
                  h('section', { className: 'relay-card relay-rail' },
                    h(CardTitle, { sub: String(chains.length) }, t('chains')),
                    h('div', { style: { margin: '0 4px 8px' } }, h(Seg, { options: filters, value: filter, onChange: setFilter })),
                    shown.length === 0
                      ? h('div', { className: 'relay-text', style: { padding: '0 4px 4px' } }, t('filterEmpty'))
                      : h('ul', { className: 'relay-rows' }, shown.map(chain => h(ChainRow, {
                        key: chain.chainId,
                        chain,
                        selected: chain.chainId === selectedId,
                        onSelect: select,
                        waiting: chainWaits(chain),
                      }))),
                  ),
                  detail === null || detail.chain?.chainId !== selectedId
                    ? h('section', { className: 'relay-card' },
                      h(CardTitle, {}, selectedId === null ? t('selectChain') : t('loading')),
                      selectedId === null ? h('div', { className: 'relay-text' }, t('selectChainBody')) : null,
                    )
                    : h(ChainDetail, { key: selectedId, detail, onAct: act, busy, waiting }),
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
