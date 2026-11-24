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
  id: 'dsh-longtask-relay',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const POLL_MS = 5000

    const STRINGS = {
      panel: '长任务接力',
      refresh: '刷新',
      updateNow: '更新到 v{version}',
      updating: '更新中…',
      updateDone: '已更新，正在重载…',
      updateManual: '已更新，请到插件页重载一次',
      updateDirty: '工作区有未提交改动，先提交再更新',
      updateFailed: '更新失败',
      updateHint: '从 git 上游拉取最新提交',
      updateBanner: '插件有新版本 v{latest}（当前 v{current}），更新后会自动重载',
      checkingUpdate: '检查更新…',
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
      rowRunning: '运行中',
      rowIdle: '空闲',
      rowParallel: '并行',
      rowBusy: '后台运行',
      jobChip: '后台作业 {n}',
      jobNote: '链头这一轮已经结束，但它起的后台作业还在跑：{labels}。这不是空闲，作业结束或你去看它的输出都行。',
      stallChip: '{n} 分钟无进展',
      stallNote: '链头在运行，但这条链的真理源已经 {n} 分钟没有更新：可能卡在一条长命令或后台作业里。打开会话看它当前在等什么，必要时暂停这条链。',
      conflictChip: '跨链冲突',
      conflictNote: '这条链和「{title}」都在改这些路径：{paths}。先暂停其中一条链，别让两个会话同时改同一批文件。',
      chains: '任务链',
      filterAll: '全部',
      acceptAllPartial: '接受全部 {count} 条部分验证',
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
      handoffReviewing: '评审中或待验收的链不能交接',
      pauseDone: '已完成的链不能暂停',
      pauseAwaiting: '待验收的链只能确认完成或驳回',
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
      docSpec: '需求',
      launchTitle: '启动方案',
      launchPlanning: '主会话正在规划：谈需求、交计划、写 SPEC.md 和 PLAN.md。计划批准后它会提交启动方案，由你在这里确认。',
      launchSessions: '个并行会话',
      launchShared: '共用目录',
      launchWorktree: 'worktree',
      launchWorktreeNote: '本期不开会话，由主会话顺序执行',
      launchKept: '留给主会话',
      launchNewGroup: '新建一组',
      launchByHuman: '人工调整',
      launchGo: '启动',
      launchConfirm: '确认启动',
      launchNote: '会按这些分组开出会话并开始执行',
      launchConfirmAsk: '确认按这份分组启动？',
      launchGroupsUnit: '组',
      launchFeaturesUnit: '个功能',
      launchDockTitle: '启动方案已就绪',
      launchDockNote: '按主会话提交的分组启动。要改分组，请在面板里改完直接在那里启动；也可以在本会话输入 /relay launch。',
      launchDockAdjust: '调整分组',
      launchDockConfirm: '按这份方案开出 {n} 个会话？',
      launchStarting: '正在启动…',
      launchDone: '已启动 {n} 个会话',
      launchFailedGroups: '未启动的组',
      launchLocalNote: '这里的调整只在面板点启动时生效；对话里的启动条用的是已提交的方案',
      launchGroupPicker: '分组',
      launchOverlap: '可能互相覆盖',
      launchUnknown: '没写文件范围',
      launchRefused: '现在不能启动',
      launchCheckFailed: '没能向引擎核对这份分组，稍后自动重试',
      issueCrossGroup: '依赖在另一组，放进同一组才能启动',
      issueMissingDep: '依赖的功能不存在',
      issueBlocker: '有未解除的阻塞，先解除',
      issueNotLoaded: '主会话没有加载，先打开它',
      issuePlanPending: '计划还没批准，先在主会话里批准',
      issueBusy: '这条链正在处理别的操作，稍后再试',
      issueNoPlan: '主会话还没提交启动方案',
      issueDelegated: '功能已经派给别的会话',
      issuePasses: '功能已经通过',
      issueDuplicate: '功能出现在两个组里',
      issueUnknownFeature: '功能不在清单里',
      attnLaunch: '等你确认启动',
      attnLaunchGo: '去启动',
      launchWaitingTitle: '待启动的组',
      launchWaitingSub: '前置功能通过后自动开会话',
      launchWaitsFor: '等',
      launchWaitsNote: '通过后才开会话',
      pausePlanning: '规划中的链不能暂停；要取消就删除这条链',
      handoffPlanning: '规划中的链还没有可交接的工作',
      paused_manual: '手动暂停',
      paused_blocker: '因阻塞暂停',
      paused_handoff_failed: '交接失败后暂停',
      paused_handoff_limit: '交接次数到顶',
      paused_blocked: '会话报告受阻',
      clearBlocker: '已处理，解除阻塞',
      goalBlockerHint: '这个阻塞来自被阻塞的目标：在对应会话里恢复目标后会自动解除。',
      reclaim: '收回',
      confirmReclaim: '确认收回',
      reclaimNote: '未完成的功能交还主线，子会话会收到停止通知。',
      finishChain: '结束这条链',
      finishReady: '功能已全部通过，可以结束这条链。',
      finishEvidence: '整体是怎么验证的（一段话）',
      search: '搜索',
      searchPlaceholder: '在交接、进度、决策、踩坑、审计里搜索',
      searchNone: '没有匹配的内容',
      searchCount: '{n} 处匹配',
      searchClear: '清除',
      handoffStale: '交接说明还是上一棒写的，当前会话没有更新过。',
      handoffMissing: '交接说明里没有状态块，交接前会先让会话收尾补写。',
      filterChains: '筛选任务链',
      actionFailed: '操作没有成功',
      dismiss: '知道了',
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
      deletedChainTitle: '原任务链已删除',
      deletedChainBody: '「{title}」已于 {when} 移入最近删除。会话和目标保留；在面板里恢复后，链仍处于暂停状态。',
      openPanel: '打开长任务接力',
      noLiveChainsTitle: '没有进行中的任务链',
      noLiveChainsBody: '最近删除里还有 {count} 条；恢复后会以暂停状态回来。',
      noChildrenTitle: '还没有派发过子会话',
      noChildrenBody: '用 relay_spawn 把一部分功能交给新的子会话并行执行，这里会显示它们的执行情况。',
      noChildrenNotCurrent: '只有链的当前会话可以派发子会话，本会话已不是当前会话。',
      childrenClusterNote: '这些是集群链上的并行会话，包含前任链头派出的；链头交接后仍由你验收。',
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
      confirm: '确认',
      status_reviewing: '评审中',
      status_awaiting_acceptance: '待验收',
      paused_review_failed: '评审会话未能启动',
      tamperTitle: '真理源在插件之外被改动',
      tamperNote: '下列封存文件被直接改过（模型的文件工具或手工编辑）。这条链已停住，你裁决之前任何写入都会被拒绝。恢复：把封存版本写回磁盘；采纳：把磁盘上的内容当作新的封存版本，需要写明理由。',
      tamperSealed: '封存版本',
      tamperDisk: '磁盘上的版本',
      tamperMissing: '（文件已被删除）',
      tamperRestore: '恢复封存版本',
      tamperAdopt: '采纳磁盘改动',
      tamperReason: '为什么采纳这些改动（必填，写进审计）',
      tamperChip: '真理源被改动',
      attnTamper: '真理源被改动',
      commandsTitle: '验证命令',
      commandsNote: '插件会在会话沙箱之外直接执行这些命令，用退出码判定功能是否通过。批准前逐条看清命令内容。',
      commandsApprove: '批准 {count} 条待批命令',
      commandsMissing: '没有验证命令的功能',
      commandApproved: '已批准',
      commandPending: '待批准',
      attnCommands: '验证命令待批准',
      reviewTitle: '独立评审',
      reviewRunning: '评审会话正在对照 SPEC.md / PLAN.md 核验交付，结论出来前链不会推进。',
      reviewRestart: '重新评审',
      reviewRound: '第 {n} 轮',
      reviewPassed: '独立评审认为交付与设计一致。',
      reviewFailedNote: '上一轮评审没有通过，不一致的功能已重开，链头会话会继续修。',
      reviewSkippedUnavailable: '未经独立评审：这个 Host 不能新建会话。',
      reviewSkippedDisabled: '独立评审已在配置里关闭，没有做设计核验。',
      reviewLimit: '评审已连续 {n} 轮未通过，需要你决定确认还是驳回。',
      acceptTitle: '待你验收',
      acceptChain: '确认完成',
      rejectChain: '驳回',
      rejectReason: '驳回理由（会发给链头会话）',
      attnAccept: '待你验收',
      attnReview: '评审会话未能启动',
      verdict_match: '一致',
      verdict_mismatch: '不一致',
      verdict_missing: '缺失',
      verdict_uncovered: '未覆盖需求',
      verifiedByPlugin: '插件验证',
      verifyFailed: '验证未通过',
      questions: '个问题',
      decisionShort: '待决策',
      goalTitle: '当前目标',
      noGoal: '这个会话没有目标',
      goalArmed: '自动继续',
      goalDisarmed: '不自动继续',
      goalRounds: '轮次',
      goalRow: '目标',
      goalHeld: '续行已暂缓，等待交接',
      goalPausedWithChain: '随链暂停',
      goalBudget: '本会话的轮次额度',
      planModeChip: '计划模式',
      planModeNote: '当前会话在计划模式：先规划、不执行。计划批准后才会拆出功能清单。',
      emptyPlanNote: '在计划模式下，先让计划获得批准，再启动链；批准的计划会写进 PLAN.md。',
      dangerZone: '危险操作',
      dangerZoneNote: '删除会把链移入最近删除；进行中的链和正在运行的会话不能删除。',
      delete: '删除',
      confirmDelete: '移入最近删除',
      deleteBlocked: '先暂停这条链才能删除',
      deleteRunning: '有会话正在运行，等它这一轮结束再删除',
      deleteConfirmTitle: '删除这条任务链？',
      deleteKeepsSessions: '保留 {count} 个会话：{ids}。会话和目标不会被删除；目标会先暂停。',
      deleteGoalNote: '删除后这些会话不再受接力监管；恢复链后目标仍是暂停的。',
      deleteGitNote: '已提交的真理源会在工作区显示为删除；恢复后回来。',
      deleteTrashNote: '移入最近删除后可以恢复；永久删除不能从面板恢复。',
      deleteDoneNote: '这条链已完成；删除会同时移走它的验收证据。',
      deletedNotice: '已移入最近删除：「{title}」 · 保留 {count} 个会话',
      restoredNotice: '已恢复「{title}」；链仍是暂停状态',
      purgedNotice: '已永久删除「{title}」',
      undo: '撤销',
      recentlyDeleted: '最近删除',
      viewTrash: '查看最近删除',
      emptyTrashTitle: '最近删除是空的',
      emptyTrashBody: '删除任务链后，它会出现在这里；恢复后保持暂停，永久删除不能从面板恢复。',
      restore: '恢复',
      purge: '永久删除',
      confirmPurge: '确认永久删除',
      purgeNote: '链目录和审计会一起删除；不能从面板恢复。',
      deletedChainTag: '原链已删除',
      deletedAt: '删除于',
      trashLiveHint: '恢复后保持暂停，不会自动继续',
      track: '接力轨道',
      leg: '第 {n} 棒',
      legs: '棒',
      thresholds: '收尾 {w}%，强制交接 {h}%',
      unloadedNote: '未加载，没有实时数值',
      current: '当前',
      docs: '真理源',
      docPlan: '计划',
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
      status_planning: '规划中',
      modeRelay: '单任务',
      modeCluster: '集群',
      modeRelayNote: '单任务：同一时刻由一个会话接力推进',
      modeClusterNote: '集群：先规划，再由你确认并行开多个会话',
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
      audit_session_permission: '继承权限预设',
      audit_goal_seeded: '建立目标',
      audit_goal_held: '暂缓目标续行',
      audit_goal_inherited: '继承目标',
      audit_goal_inherit_skipped: '未继承目标',
      audit_goal_rearmed: '恢复目标续行',
      audit_goal_completed: '目标完成',
      audit_goal_paused: '暂停目标',
      audit_goal_resumed: '恢复目标',
      audit_plan_inherited: '继承计划模式',
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
      updateNow: 'Update to v{version}',
      updating: 'Updating…',
      updateDone: 'Updated; reloading…',
      updateManual: 'Updated; reload the plugin from its page once',
      updateDirty: 'The working tree has uncommitted changes; commit them first',
      updateFailed: 'Update failed',
      updateHint: 'Pull the newest commits from the git upstream',
      updateBanner: 'A newer plugin build is available: v{latest} (current v{current}); updating reloads it',
      checkingUpdate: 'Checking for updates…',
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
      rowRunning: 'running',
      rowIdle: 'idle',
      rowParallel: 'parallel',
      rowBusy: 'background',
      jobChip: '{n} background job(s)',
      jobNote: 'The head finished its turn but the background job it started still runs: {labels}. This is not idle; wait for the job or read its output.',
      stallChip: 'no progress {n} min',
      stallNote: 'The chain head is running but has written nothing to the truth source for {n} minutes: it may be stuck in one long command or background job. Open the conversation to see what it waits on, and pause the chain if it is stuck.',
      conflictChip: 'cross-chain conflict',
      conflictNote: 'This chain and "{title}" both work on {paths}. Pause one of them so two sessions do not edit the same files at once.',
      chains: 'Chains',
      filterAll: 'All',
      acceptAllPartial: 'Accept all {count} partial',
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
      handoffReviewing: 'A chain under review or waiting for acceptance cannot be handed off',
      pauseDone: 'A finished chain cannot be paused',
      pauseAwaiting: 'A delivered chain can only be confirmed or rejected',
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
      docSpec: 'Spec',
      launchTitle: 'Launch plan',
      launchPlanning: 'The main session is planning: requirements, the plan, SPEC.md and PLAN.md. Once the plan is approved it proposes a launch for you to confirm here.',
      launchSessions: 'parallel sessions',
      launchShared: 'Shared directory',
      launchWorktree: 'worktree',
      launchWorktreeNote: 'Not launched yet; the main session works these in order',
      launchKept: 'Kept by the main session',
      launchNewGroup: 'New group',
      launchByHuman: 'Adjusted by a human',
      launchGo: 'Launch',
      launchConfirm: 'Confirm launch',
      launchNote: 'Sessions are created for these groups and start working',
      launchConfirmAsk: 'Start with these groups?',
      launchGroupsUnit: 'groups',
      launchFeaturesUnit: 'features',
      launchDockTitle: 'Launch plan ready',
      launchDockNote: 'Starts the groups the main session proposed. To change them, edit in the panel and launch there; you can also run /relay launch here.',
      launchDockAdjust: 'Adjust groups',
      launchDockConfirm: 'Open {n} sessions with this plan?',
      launchStarting: 'Starting…',
      launchDone: 'Launched {n} sessions',
      launchFailedGroups: 'Groups not launched',
      launchLocalNote: 'These changes apply only when you launch from the panel; the launch bar runs the plan on record',
      launchGroupPicker: 'group',
      launchOverlap: 'May overwrite each other',
      launchUnknown: 'No file scope given',
      launchRefused: 'Cannot launch yet',
      launchCheckFailed: 'Could not check this grouping with the engine; retrying shortly',
      issueCrossGroup: 'depends on another group; put both in one group',
      issueMissingDep: 'depends on a feature that does not exist',
      issueBlocker: 'An open blocker must be cleared first',
      issueNotLoaded: 'The main session is not loaded; open it first',
      issuePlanPending: 'The plan is not approved yet; approve it in the main session',
      issueBusy: 'The chain is busy with another operation; try again shortly',
      issueNoPlan: 'The main session has not proposed a launch yet',
      issueDelegated: 'is already delegated to another session',
      issuePasses: 'already passes',
      issueDuplicate: 'appears in two groups',
      issueUnknownFeature: 'is not in the feature list',
      attnLaunch: 'Waiting for you to launch',
      attnLaunchGo: 'Go start',
      launchWaitingTitle: 'Groups not opened yet',
      launchWaitingSub: 'Opened automatically once their dependencies pass',
      launchWaitsFor: 'waits for',
      launchWaitsNote: 'to pass before its session opens',
      pausePlanning: 'A planning chain cannot be paused; delete it to cancel',
      handoffPlanning: 'A planning chain has no work to hand off yet',
      paused_manual: 'Paused by hand',
      paused_blocker: 'Paused by a blocker',
      paused_handoff_failed: 'Paused after a failed handoff',
      paused_handoff_limit: 'Handoff limit reached',
      paused_blocked: 'Reported blocked by a session',
      clearBlocker: 'Done; clear the blocker',
      goalBlockerHint: 'This blocker follows a blocked goal: it clears once the goal is resumed in its session.',
      reclaim: 'Reclaim',
      confirmReclaim: 'Confirm reclaim',
      reclaimNote: 'Unfinished features return to the main line and the child is told to stop.',
      finishChain: 'Finish this chain',
      finishReady: 'Every feature passes; the chain can be finished.',
      finishEvidence: 'How the whole objective was verified (one paragraph)',
      search: 'Search',
      searchPlaceholder: 'Search handoffs, progress, decisions, traps, and the audit log',
      searchNone: 'Nothing matches',
      searchCount: '{n} matches',
      searchClear: 'Clear',
      handoffStale: 'The handoff brief was written by the previous leg; the current session has not updated it.',
      handoffMissing: 'The handoff brief has no state block; the session is asked to wrap up before a handoff.',
      filterChains: 'Filter chains',
      actionFailed: 'The action did not go through',
      dismiss: 'Dismiss',
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
      deletedChainTitle: 'Its relay chain was deleted',
      deletedChainBody: '"{title}" was moved to deleted on {when}. The session and its goal stay; restoring it in the panel brings the chain back paused.',
      openPanel: 'Open long-task relay',
      noLiveChainsTitle: 'No live relay chain',
      noLiveChainsBody: 'There are {count} deleted chains to restore; a restored chain comes back paused.',
      noChildrenTitle: 'Nothing delegated yet',
      noChildrenBody: 'Use relay_spawn to hand part of the work to a fresh child session; its progress appears here.',
      noChildrenNotCurrent: 'Only the chain\'s current session can delegate, and this session is no longer current.',
      childrenClusterNote: 'These are the cluster\'s parallel sessions, including the ones a previous head launched; after a head handoff they are still yours to verify.',
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
      confirm: 'Confirm',
      status_reviewing: 'In review',
      status_awaiting_acceptance: 'Awaiting acceptance',
      paused_review_failed: 'Review session failed to start',
      tamperTitle: 'Truth source changed outside the plugin',
      tamperNote: 'These sealed files were edited directly (a model file tool or a hand edit). The chain stands still and every write is refused until you decide. Restore writes the sealed copy back; adopt makes the file on disk the new sealed copy and needs a reason.',
      tamperSealed: 'Sealed copy',
      tamperDisk: 'On disk',
      tamperMissing: '(file deleted)',
      tamperRestore: 'Restore sealed copy',
      tamperAdopt: 'Adopt the change',
      tamperReason: 'Why the change is accepted (required, audited)',
      tamperChip: 'Truth source changed',
      attnTamper: 'Truth source changed',
      commandsTitle: 'Verify commands',
      commandsNote: 'The plugin runs these commands outside the session sandbox and decides a pass by the exit code. Read each one before approving.',
      commandsApprove: 'Approve {count} pending',
      commandsMissing: 'Features without a verify command',
      commandApproved: 'Approved',
      commandPending: 'Pending',
      attnCommands: 'Verify commands to approve',
      reviewTitle: 'Independent review',
      reviewRunning: 'A review session is checking the delivery against SPEC.md / PLAN.md; the chain waits for its verdict.',
      reviewRestart: 'Restart review',
      reviewRound: 'Round {n}',
      reviewPassed: 'The independent review found the delivery matches the design.',
      reviewFailedNote: 'The last review did not pass; mismatched features were reopened and the head keeps working.',
      reviewSkippedUnavailable: 'Not independently reviewed: this Host cannot open sessions.',
      reviewSkippedDisabled: 'Independent review is turned off in the settings; the design was not checked.',
      reviewLimit: 'The review failed {n} rounds in a row; confirm or reject it.',
      acceptTitle: 'Waiting for your acceptance',
      acceptChain: 'Confirm done',
      rejectChain: 'Reject',
      rejectReason: 'Why (sent to the chain head)',
      attnAccept: 'Waiting for your acceptance',
      attnReview: 'Review session failed to start',
      verdict_match: 'Match',
      verdict_mismatch: 'Mismatch',
      verdict_missing: 'Missing',
      verdict_uncovered: 'Uncovered',
      verifiedByPlugin: 'Verified by plugin',
      verifyFailed: 'Verify failed',
      questions: 'questions',
      decisionShort: 'Decide',
      goalTitle: 'Goal',
      noGoal: 'This session has no goal',
      goalArmed: 'armed',
      goalDisarmed: 'not continuing',
      goalRounds: 'Rounds',
      goalRow: 'Goal',
      goalHeld: 'Continuation on hold until handoff',
      goalPausedWithChain: 'Paused with the chain',
      goalBudget: "This session's round budget",
      planModeChip: 'Plan mode',
      planModeNote: 'This session is in plan mode: it plans and does not execute. The feature list is created once the plan is approved.',
      emptyPlanNote: 'In plan mode, get the plan approved before starting a chain; the approved plan is written to PLAN.md.',
      dangerZone: 'Danger zone',
      dangerZoneNote: 'Deleting moves the chain to deleted; an active chain or a running session cannot be deleted.',
      delete: 'Delete',
      confirmDelete: 'Move to deleted',
      deleteBlocked: 'Pause the chain before deleting it',
      deleteRunning: 'A session is running; wait for its turn to end before deleting',
      deleteConfirmTitle: 'Delete this relay chain?',
      deleteKeepsSessions: 'Keep {count} sessions: {ids}. The sessions and their goals stay; the goals are paused first.',
      deleteGoalNote: 'After this, those sessions are no longer supervised; a restored chain still has its goals paused.',
      deleteGitNote: 'A committed truth source shows as a working-tree delete; restoring brings it back.',
      deleteTrashNote: 'It can be restored from deleted; a permanent delete cannot be undone from the panel.',
      deleteDoneNote: 'This chain is finished; deleting it also moves its acceptance evidence away.',
      deletedNotice: 'Moved to deleted: "{title}" · kept {count} sessions',
      restoredNotice: 'Restored "{title}"; the chain is still paused',
      purgedNotice: 'Permanently deleted "{title}"',
      undo: 'Undo',
      recentlyDeleted: 'Deleted',
      viewTrash: 'View deleted',
      emptyTrashTitle: 'Nothing deleted',
      emptyTrashBody: 'Deleted relay chains appear here; a restore brings the chain back paused, while a permanent delete cannot be undone from the panel.',
      restore: 'Restore',
      purge: 'Delete forever',
      confirmPurge: 'Confirm permanent delete',
      purgeNote: 'The chain directory and audit go with it; the panel cannot restore them.',
      deletedChainTag: 'chain deleted',
      deletedAt: 'Deleted',
      trashLiveHint: 'Restores paused and does not resume on its own',
      track: 'Relay track',
      leg: 'Leg {n}',
      legs: 'legs',
      thresholds: 'wrap-up {w}%, forced handoff {h}%',
      unloadedNote: 'Not loaded; no live reading',
      current: 'current',
      docs: 'Truth source',
      docPlan: 'Plan',
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
      status_planning: 'Planning',
      modeRelay: 'Single',
      modeCluster: 'Cluster',
      modeRelayNote: 'Single: one session carries the chain at a time',
      modeClusterNote: 'Cluster: plan first, then open several sessions in parallel',
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
      audit_session_permission: 'Permission preset carried over',
      audit_goal_seeded: 'Goal seeded',
      audit_goal_held: 'Goal rounds held',
      audit_goal_inherited: 'Goal inherited',
      audit_goal_inherit_skipped: 'Goal not inherited',
      audit_goal_rearmed: 'Goal re-armed',
      audit_goal_completed: 'Goal completed',
      audit_goal_paused: 'Goal paused',
      audit_goal_resumed: 'Goal resumed',
      audit_plan_inherited: 'Plan mode carried over',
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

    /**
     * Documents the reader offers. Only the handoff brief arrives with the chain
     * detail: it is rewritten whole and stays short. The others are append-only
     * and are fetched on demand so the reader gets their newest part.
     */
    const DOCS = [
      { id: 'handoff', label: 'handoff', inline: true },
      { id: 'spec', label: 'docSpec', inline: false, cluster: true },
      { id: 'plan', label: 'docPlan', inline: false },
      { id: 'progress', label: 'docProgress', inline: false },
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
          { key: 'stallMinutes', label: '无进展提示（分钟）', kind: 'int', min: 1, hint: '链头一直在跑却这么久没写真理源时，面板标出「N 分钟无进展」；只提示，不暂停也不交接' },
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
          { key: 'notifyOldSession', label: '给旧会话留言', kind: 'boolean', hint: '交接后给旧会话留一条退役说明' },
        ],
      },
      {
        title: '目标与计划',
        fields: [
          { key: 'inheritGoal', label: '新会话继承目标', kind: 'boolean', hint: '交接时新会话沿用旧会话的 goal 目标，轮次只给剩余部分，轮次上限成为整条链的预算；关掉后新会话不继承（仍可由「给新会话建目标」新建）' },
          { key: 'seedGoalOnHandoff', label: '给新会话建目标', kind: 'boolean', hint: '交接后给新会话建一个 goal，让它按目标轮次自动继续；需要目标功能可用。集群链的链头不受此项控制：clusterGoals 开着时始终给新链头建 goal' },
          { key: 'goalRoundsPerHandoff', label: '新目标的轮次上限', kind: 'int', min: 1, hint: '给新会话 goal 分配的续轮上限' },
          { key: 'rearmGoalOnReload', label: '重启后恢复目标续行', kind: 'boolean', hint: 'DSH 重启或插件重载后，恢复本插件建的 goal 的自动续行；关掉后需要人在输入框里手动恢复（用户自己建的 goal 不受影响）' },
          { key: 'pauseGoalOnRetire', label: '退役时暂停旧目标', kind: 'boolean', hint: '交接后暂停旧会话的 goal' },
          { key: 'inheritPlanMode', label: '新会话继承计划模式', kind: 'boolean', hint: '旧会话处于计划模式时，接力会话和子会话也以计划模式启动；关掉后新会话退出计划模式' },
          { key: 'maxClusterSessions', label: '集群最多分几组', kind: 'int', min: 1, max: 12, hint: '集群模式一次启动最多开几个并行会话' },
          { key: 'clusterGoals', label: '集群启动时建目标', kind: 'boolean', hint: '启动时给主会话和每个子会话各建一个 goal；集群链交接时也给新链头建一个，子会话不会跑一轮就停' },
        ],
      },
      {
        title: '验收与阻塞',
        fields: [
          { key: 'requireStrongEvidence', label: '要求命令输出作证据', kind: 'boolean', hint: '功能通过必须附带像命令结果的证据；验证输出是自由文本的项目可以关掉' },
          { key: 'requireHumanAcceptedCoverage', label: '部分验证需人工接受', kind: 'boolean', hint: '只做到部分验证的功能，要人工接受后链才能完成' },
          { key: 'pauseOnExternalBlocker', label: '等待人工时暂停', kind: 'boolean', hint: '遇到只有人能解决的阻塞时暂停这条链，不再消耗交接次数' },
          { key: 'inheritPermission', label: '新会话继承权限预设', kind: 'boolean', hint: '接力会话和子会话沿用上一个会话的权限预设（沙箱模式 + 审批策略）；关掉后新会话用 DSH 设置里的默认预设' },
          { key: 'workerApproval', label: '自建会话的审批', kind: 'select', options: ['inherit', 'ask', 'never'], hint: '在继承预设之后再覆盖审批策略：inherit 不覆盖；ask 每次询问，无人值守时会一直等；never 不询问，需要升级权限的操作直接失败并记为阻塞' },
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
.relay-panel-tabs { display: flex; align-items: center; margin: -2px 0 12px; }
.relay-panel-tabs .relay-seg-btn { padding: 4px 12px; font-size: 12px; }
.relay-version { color: var(--dsw-alias-label-tertiary); font-size: 12px; white-space: nowrap; }
.relay-card.is-update { border-color: var(--relay-tone); }
.relay-update { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.relay-update-text { flex: 1; min-width: 0; }

.relay-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
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
.relay-btn.is-cta { height: 32px; padding: 0 16px; border-color: transparent; border-radius: 8px; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); font-size: 13px; font-weight: 600; line-height: 30px; }
.relay-btn.is-cta:hover:not(:disabled) { border-color: transparent; background: var(--dsw-alias-button-primary-hover); }
.relay-btn.is-danger { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.relay-btn.is-small { height: 20px; padding: 0 7px; font-size: 11px; line-height: 18px; }
.relay-page button:focus-visible, .relay-tab button:focus-visible, .relay-launch-dock button:focus-visible, .relay-config button:focus-visible, .relay-config input:focus-visible, .relay-config select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

.relay-seg { display: inline-flex; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.relay-seg-btn { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; font-weight: 400; white-space: nowrap; cursor: pointer; }
.relay-seg-btn:hover { color: var(--dsw-alias-label-primary); }
.relay-seg-btn.is-on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: 0 0 0 1px var(--dsw-alias-border-l2); }
.relay-seg-count { color: var(--dsw-alias-label-tertiary); font-weight: 400; font-variant-numeric: tabular-nums; }

.relay-status { display: inline-flex; align-items: center; flex: none; height: 18px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 16px; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.relay-status.is-active, .relay-status.is-running { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.relay-status.is-paused, .relay-status.is-initializing, .relay-status.is-planning, .relay-status.is-warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.relay-status.is-failed { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.relay-status.is-done { color: var(--dsw-alias-state-business-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.relay-status.is-unloaded { border-style: dashed; color: var(--dsw-alias-label-tertiary); }
.relay-chip { display: inline-flex; align-items: center; flex: none; height: 17px; padding: 0 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; white-space: nowrap; }
.relay-chip.is-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-warn-primary); }
.relay-chip.is-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-error-primary); }
.relay-chip.is-success { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-success-primary); }
.relay-gate.is-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l2)); }
.relay-gate.is-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l2)); }
.relay-gate.is-success { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-border-l2)); }
.relay-gate .relay-text.is-warn { color: var(--dsw-alias-state-warn-primary); }
.relay-gate-file { margin-top: 6px; }
.relay-gate-file > summary { cursor: pointer; font-size: 12px; }
.relay-gate-diff { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; margin-top: 6px; }
.relay-gate-label { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 2px; }
.relay-gate-pre { margin: 0; max-height: 260px; overflow: auto; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); font-size: 11px; line-height: 15px; white-space: pre-wrap; overflow-wrap: anywhere; }
.relay-gate-command { font-size: 11px; overflow-wrap: anywhere; }
.relay-chip.is-human { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-business-primary); }
.relay-chip.is-mode { border-style: dashed; color: var(--dsw-alias-label-tertiary); font-weight: 500; }
.relay-chip.is-cluster { border-style: solid; border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.relay-pills { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.relay-goal { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.relay-goal-bar { --relay-hue: var(--dsw-alias-brand-primary); max-width: 220px; }
.relay-facts .relay-facts-note { grid-column: 2; }

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
:is(.relay-row, .relay-detail, .relay-card).is-paused, :is(.relay-row, .relay-detail, .relay-card).is-initializing, :is(.relay-row, .relay-detail, .relay-card).is-planning { --relay-hue: var(--dsw-alias-state-warn-primary); }
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
.relay-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
/* A chain whose sessions are generating: the dot separates it from an idle
   active chain, which otherwise reads the same as any other running chain. */
.relay-row-status.is-live::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: currentColor; animation: relay-pulse 1.8s ease-out infinite; }
@media (prefers-reduced-motion: reduce) { .relay-row-status.is-live::before { animation: none; } }
.relay-row-open { flex: none; box-sizing: border-box; display: inline-flex; align-items: center; height: 16px; padding: 0 5px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 10.5px; line-height: 14px; cursor: pointer; transition: color var(--relay-ease), border-color var(--relay-ease); }
.relay-row-open:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-tertiary); }

.relay-detail { min-width: 0; }
.relay-detail-head { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.relay-detail-main { flex: 1 1 260px; min-width: 0; }
.relay-detail-title { margin: 0 0 6px; font-size: 15px; font-weight: 600; line-height: 22px; overflow-wrap: anywhere; }
.relay-actions { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 6px; }
.relay-confirm-note { flex-basis: 100%; color: var(--dsw-alias-state-error-primary); font-size: 11.5px; line-height: 16px; text-align: right; }
.relay-delete-confirm { flex: 1 1 100%; box-sizing: border-box; margin-top: 2px; padding: 9px 10px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2)); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, var(--dsw-alias-bg-layer-2)); }
.relay-delete-title { margin-bottom: 4px; color: var(--dsw-alias-state-error-primary); font-size: 12.5px; font-weight: 600; line-height: 18px; }
.relay-delete-path { margin-bottom: 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.relay-delete-list { margin: 0 0 8px; padding-left: 18px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px; }
.relay-delete-list li { margin: 2px 0; overflow-wrap: anywhere; }
.relay-delete-list li.is-warn { color: var(--dsw-alias-state-warn-primary); }
.relay-danger-zone { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 25%, var(--dsw-alias-border-l2)); }
.relay-danger-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; margin-bottom: 7px; }
.relay-danger-head b { color: var(--dsw-alias-state-error-primary); font-size: 12.5px; line-height: 18px; }
.relay-danger-head .relay-text { flex: 1 1 260px; margin: 0; font-size: 11.5px; line-height: 17px; }
.relay-notice { border-left: 3px solid var(--dsw-alias-brand-primary); }
.relay-notice.is-deleted { border-left-color: var(--dsw-alias-state-warn-primary); }
.relay-notice-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.relay-notice-text { flex: 1 1 240px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.relay-notice-sessions { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 6px; }
.relay-trash { padding-bottom: 8px; }
.relay-trash-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
.relay-trash-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.relay-trash-heading b { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 19px; }
.relay-trash-hint { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 16px; }
.relay-trash-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 6px; padding: 7px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.relay-trash-main { flex: 1 1 260px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.relay-trash-title { min-width: 0; max-width: 100%; color: var(--dsw-alias-label-primary); font-size: 12.5px; font-weight: 600; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.relay-trash-when { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
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
.relay-kid-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
.relay-kid-row > .relay-kid { flex: 1; }
.relay-search { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.relay-search .relay-input { flex: 1 1 220px; width: auto; }
.relay-hit { display: grid; grid-template-columns: 132px minmax(0, 1fr); align-items: baseline; column-gap: 10px; padding: 5px 0; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; line-height: 17px; }
.relay-hit:first-child { border-top: none; padding-top: 0; }
.relay-hit-where { overflow: hidden; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.relay-hit-text { color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.relay-finish { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-border-l2)); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 7%, var(--dsw-alias-bg-layer-1)); }
.relay-finish-note { flex: none; color: var(--dsw-alias-state-success-primary); font-size: 12px; font-weight: 600; }
.relay-finish .relay-input { flex: 1 1 220px; width: auto; }
.relay-blocker-text { flex: 1 1 200px; min-width: 0; }
.relay-blocker-hint { flex-basis: 100%; color: var(--dsw-alias-label-tertiary); }
.relay-rail-tools { display: flex; flex-direction: column; gap: 6px; margin: 0 4px 8px; }
.relay-rail-tools .relay-seg { align-self: flex-start; }
.relay-section-line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 14px; margin: 0 2px 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
.relay-section-line b { color: var(--dsw-alias-label-primary); font-size: 13px; }
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
.relay-launch-group { padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.relay-launch-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.relay-launch-name { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.relay-launch-feature { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; font-size: 12.5px; line-height: 18px; }
.relay-launch-feature > span:nth-child(2) { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.relay-launch-feature .relay-input { flex: none; width: auto; max-width: 45%; height: 22px; padding: 0 4px; }
.relay-launch-card { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, var(--dsw-alias-border-l2)); }
.relay-launch-top { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px 12px; margin-bottom: 8px; }
.relay-launch-top-main { flex: 1 1 220px; min-width: 0; }
.relay-launch-top-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; line-height: 18px; }
.relay-launch-top-sub { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 16px; }
.relay-launch-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.relay-launch-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.relay-launch-ask { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 16px; }
.relay-launch-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.relay-launch-dock { box-sizing: border-box; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, var(--dsw-alias-border-l2)); border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 5%, var(--dsw-alias-bg-layer-1)); }
.relay-launch-dock-row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px 12px; }
.relay-launch-dock-main { flex: 1 1 240px; min-width: 0; }
.relay-launch-dock-title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--dsw-alias-label-primary); font-size: 12.5px; font-weight: 600; line-height: 18px; }
.relay-launch-dock-groups { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.relay-launch-dock-groups .relay-chip { max-width: 100%; overflow: hidden; }
.relay-launch-dock-note { margin-top: 4px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.relay-launch-dock-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.relay-launch-dock .relay-error { margin: 8px 0 0; }
.relay-launch-dock .relay-blocker { margin-top: 6px; }
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
  .relay-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
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
         * One refused launch in the reader's language; codes this build does not
         * know keep the Host's sentence. Shared by the panel card and the launch
         * bar above the composer, so both explain a refusal the same way.
         */
        const launchIssueText = (issue, groupNameAt) => {
          const nameAt = index => (typeof index === 'number' && typeof groupNameAt === 'function' ? groupNameAt(index) : '')
          const pair = `${issue.feature} -> ${issue.dependency}`
          if (issue.code === 'cross-group-dependency') return `${pair} (${nameAt(issue.index)} / ${nameAt(issue.dependencyIndex)}): ${t('issueCrossGroup')}`
          if (issue.code === 'missing-dependency') return `${pair}: ${t('issueMissingDep')}`
          if (issue.code === 'blocker') return `${t('issueBlocker')}: ${issue.action ?? ''}`
          if (issue.code === 'not-loaded') return t('issueNotLoaded')
          if (issue.code === 'plan-pending') return t('issuePlanPending')
          if (issue.code === 'busy') return t('issueBusy')
          if (issue.code === 'no-plan') return t('issueNoPlan')
          if (issue.code === 'feature-delegated') return `${issue.feature}: ${t('issueDelegated')}`
          if (issue.code === 'feature-passes') return `${issue.feature}: ${t('issuePasses')}`
          if (issue.code === 'duplicate-feature') return `${issue.feature}: ${t('issueDuplicate')}`
          if (issue.code === 'unknown-feature') return `${issue.feature}: ${t('issueUnknownFeature')}`
          return issue.message ?? issue.code
        }

        /** Conflicts of the grouping the Host last checked, as rows both launch surfaces show. */
        const launchConflictRows = judged => (Array.isArray(judged?.conflicts) ? judged.conflicts : []).map((conflict, index) => (conflict.kind === 'overlap'
          ? { key: `overlap:${index}`, kind: 'launchOverlap', text: `${(conflict.features ?? []).join(' / ')}: ${conflict.path === '' ? '.' : conflict.path}` }
          : { key: `unknown:${index}`, kind: 'launchUnknown', text: (conflict.features ?? []).join(', ') }))

        /**
         * Invoke one Host Remote method.
         * Transport failures reject; business failures arrive as `{ ok: false }`.
         */
        const call = (endpoint, args) => ctx.connection.rpc.call('/api', endpoint, { args: args ?? {} })
          .then((result) => {
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
            return result.value
          })

        /** The npm package name this bundle is installed under, for detail slots. */
        const PACKAGE_NAME = 'dsh-longtask-relay'

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
              navigation.openBundle('dsh-longtask-relay')
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

        /** Switch to the relay panel without selecting a chain. */
        const openRelayPanel = () => {
          try {
            ctx.layout.selectPanel('relay')
          } catch {
            /* the shell cannot switch panels */
          }
        }

        /** Switch to the relay panel with one chain selected. */
        const showChainInPanel = (chainId) => {
          if (typeof chainId !== 'string' || chainId.length === 0) return
          // A mounted panel takes the request through its listener; only an
          // unmounted one has to find it waiting when it mounts.
          focus.chainId = focus.listeners.size === 0 ? chainId : null
          for (const listener of focus.listeners) {
            try {
              listener(chainId)
            } catch {
              /* one listener must not block the switch */
            }
          }
          openRelayPanel()
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

        /** One ISO timestamp in the reader's local format. */
        const stamp = (iso) => {
          const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
          return Number.isFinite(at) ? new Date(at).toLocaleString() : (typeof iso === 'string' ? iso : '')
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

        /**
         * The chain error worth showing next to its blocker.
         * A pause the blocker caused writes the same sentence into `lastError`;
         * a failed handoff or a session's own blocked note is a separate problem.
         */
        const errorOf = (chain) => {
          if (typeof chain.lastError !== 'string' || chain.lastError.length === 0) return null
          const hasBlocker = chain.blocker !== null && chain.blocker !== undefined
          const echoes = chain.pausedBy === 'blocker' || chain.pausedBy === 'handoff-limit' || chain.lastError.startsWith('external blocker:')
          if (hasBlocker && echoes) return null
          return chain.lastError
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
         * The chip for a head that is running but has written nothing: without it
         * an active chain and a chain stuck in one long command look the same.
         */
        const stallChip = (chain) => {
          const stall = chain.stall
          if (stall === null || stall === undefined) return null
          return h('span', {
            className: 'relay-chip is-warn',
            title: t('stallNote').replace('{n}', String(stall.minutes)),
          }, t('stallChip').replace('{n}', String(stall.minutes)))
        }

        /**
         * The chip for paths another chain in the same workspace is also building.
         * The plugin only reports it: the human decides which chain to pause.
         */
        const conflictChip = (chain) => {
          const conflicts = Array.isArray(chain.conflicts) ? chain.conflicts : []
          if (conflicts.length === 0) return null
          const [first] = conflicts
          return h('span', {
            className: 'relay-chip is-error',
            title: t('conflictNote')
              .replace('{title}', String(first.title ?? first.chainId))
              .replace('{paths}', (first.paths ?? []).join(', ')),
          }, conflicts.length === 1 ? t('conflictChip') : `${t('conflictChip')} +${conflicts.length - 1}`)
        }

        /**
         * The chip for a head that ended its turn while its own background job
         * still runs: reporting that as idle made the chain look abandoned.
         */
        const jobChip = (chain) => {
          const jobs = chain.jobs
          if (jobs === null || jobs === undefined || jobs.running === 0) return null
          return h('span', {
            className: 'relay-chip',
            title: t('jobNote').replace('{labels}', (jobs.labels ?? []).join('\n')),
          }, t('jobChip').replace('{n}', String(jobs.running)))
        }

        /**
         * Which shape the chain has: a single-session relay, or the parallel
         * cluster. Without it the list cards look identical until you open one.
         */
        const modeChip = (chain) => {
          const cluster = chain.mode === 'cluster'
          return h('span', {
            className: `relay-chip is-mode${cluster ? ' is-cluster' : ''}`,
            title: t(cluster ? 'modeClusterNote' : 'modeRelayNote'),
          }, t(cluster ? 'modeCluster' : 'modeRelay'))
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
        function ConfirmButton({ children, confirmLabel, note, onConfirm, disabled, title, primary = false, small = false }) {
          const [armed, setArmed] = useState(false)
          useEffect(() => {
            if (!armed) return undefined
            const timer = setTimeout(() => setArmed(false), 6000)
            return () => clearTimeout(timer)
          }, [armed])
          if (!armed || disabled) {
            return h('button', {
              type: 'button',
              className: `relay-btn${primary ? ' is-primary' : ''}${small ? ' is-small' : ''}`,
              disabled,
              title,
              onClick: () => setArmed(true),
            }, children)
          }
          return h(React.Fragment, {},
            h('button', {
              type: 'button',
              className: `relay-btn is-danger${small ? ' is-small' : ''}`,
              onClick: () => { setArmed(false); onConfirm() },
            }, confirmLabel),
            h('button', { type: 'button', className: `relay-btn${small ? ' is-small' : ''}`, onClick: () => setArmed(false) }, t('cancel')),
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
            // A note, not a step: plan mode changes when the chain should be started.
            h('div', { className: 'relay-text' }, t('emptyPlanNote')),
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
          // Two active chains carry the same status. What tells them apart is
          // whether their sessions are generating right now, and how many are.
          const live = sessions.filter(session => session.running === true).length
          const jobs = chain.jobs ?? null
          const jobCount = jobs?.running ?? 0
          const headSession = sessions.find(session => session.sessionId === chain.currentSessionId)
            ?? sessions[sessions.length - 1]
          const phase = phaseOf(chain)
          const hasBlocker = chain.blocker !== null && chain.blocker !== undefined
          const hasError = errorOf(chain) !== null
          return h('li', {},
            h('div', {
              role: 'button',
              tabIndex: 0,
              className: `relay-row is-${chain.status}${selected ? ' is-selected' : ''}`,
              'aria-current': selected ? 'true' : undefined,
              onClick: () => onSelect(chain.chainId),
              onKeyDown: (event) => {
                // A key press on the open button belongs to that button, not to
                // the row: it would otherwise select the chain as a side effect.
                if (event.target !== event.currentTarget) return
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onSelect(chain.chainId)
              },
            },
              h('span', { className: 'relay-row-head' },
                h('span', { className: 'relay-row-title' }, chain.title || chain.chainId),
                modeChip(chain),
                h('span', { className: `relay-row-status${live > 0 || jobCount > 0 ? ' is-live' : ''}` },
                  phase !== null
                    ? t(phase)
                    : chain.status === 'active'
                      ? t(live > 0 ? 'rowRunning' : jobCount > 0 ? 'rowBusy' : 'rowIdle')
                      : (chain.status === 'paused' && typeof chain.pausedBy === 'string' ? label('paused', chain.pausedBy) : label('status', chain.status))),
              ),
              h('span', { className: 'relay-row-where' },
                h('span', { title: chain.cwd }, folderOf(chain.cwd)),
                h('span', {}, ago(chain.updatedAt)),
                // The chain lives in a conversation; the row opens it, so a card
                // is never just a title when several chains are active at once.
                headSession === undefined
                  ? null
                  : h('button', {
                    type: 'button',
                    className: 'relay-row-open',
                    title: `${t('openSession')} ${headSession.sessionId}`,
                    onClick: (event) => {
                      event.stopPropagation()
                      openSession(headSession.sessionId)
                    },
                  }, shortId(headSession.sessionId)),
              ),
              h('span', { className: 'relay-row-progress' },
                h(Bar, { done, total }),
                h('b', {}, `${done}/${total}`),
              ),
              h('span', { className: 'relay-row-facts' },
                h('span', {}, t('statHandoffs'), h('b', {}, `${chain.handoffCount ?? 0}/${chain.maxHandoffs ?? 0}`)),
                h('span', {}, t('sessions'), h('b', {}, String(chain.sessions ?? sessions.length))),
                // Cluster chains run several sessions at once under one card.
                live > 1 ? h('span', {}, t('rowParallel'), h('b', {}, String(live))) : null,
                h('span', {}, t('peak'), h('b', {}, `${pct(peak)}%`)),
                // The round cap is a budget for the whole chain, so the list shows it too.
                chain.head?.goal
                  ? h('span', {}, t('goalRow'), h('b', {}, `${chain.head.goal.roundsStarted ?? 0}/${chain.head.goal.maxGoalRounds ?? 0}`))
                  : null,
              ),
              hasBlocker || hasError || waiting || chain.head?.planMode === true || (chain.stall ?? null) !== null
                || (Array.isArray(chain.conflicts) && chain.conflicts.length > 0) || jobCount > 0 || chain.launchPending === true
                ? h('span', { className: 'relay-pills' },
                  waiting ? h('span', { className: 'relay-chip is-warn' }, t('decisionShort')) : null,
                  chain.launchPending === true ? h('span', { className: 'relay-chip is-warn' }, t('attnLaunch')) : null,
                  chain.head?.planMode === true ? h('span', { className: 'relay-chip is-human' }, t('planModeChip')) : null,
                  stallChip(chain),
                  conflictChip(chain),
                  jobChip(chain),
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
        function RelayTrack({ sessions, features, currentSessionId, waiting, onReclaim, busy }) {
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
                  const pending = mine.some(feature => !feature.passes)
                  return h('li', { key: kid.sessionId, className: 'relay-kid-row' },
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
                    ),
                    pending && onReclaim !== undefined
                      ? h(ConfirmButton, {
                        small: true,
                        disabled: busy,
                        title: t('reclaimNote'),
                        confirmLabel: t('confirmReclaim'),
                        onConfirm: () => onReclaim(kid.sessionId),
                      }, t('reclaim'))
                      : null,
                  )
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
          // The plugin's own run outranks whatever the session wrote as evidence.
          const run = feature.verification ?? null
          const acceptable = onAccept !== undefined && showsCoverage
          return h('li', { className: `relay-feature${feature.passes ? ' is-done' : ''}` },
            h('span', { className: 'relay-check', 'aria-hidden': true }, feature.passes ? '✓' : '○'),
            h('span', { className: 'relay-mono' }, feature.id),
            h('div', { className: 'relay-feature-body' },
              h('span', { className: 'relay-feature-title' }, feature.title),
              showsCoverage || accepted || owner !== null || acceptable || run !== null
                ? h('div', { className: 'relay-feature-tags' },
                  showsCoverage ? h('span', { className: 'relay-chip is-warn' }, label('coverage', coverage)) : null,
                  run === null
                    ? null
                    : h('span', {
                      className: `relay-chip ${run.exitCode === 0 ? 'is-success' : 'is-error'}`,
                      title: `${run.command}\n${run.at ?? ''}${run.head ? ` @ ${run.head.slice(0, 8)}` : ''}`,
                    }, `${run.exitCode === 0 ? t('verifiedByPlugin') : t('verifyFailed')} · exit ${run.exitCode ?? '-'}`),
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
        function FeatureCard({ chainId, features, onAccept, onAcceptAll, planMode = false }) {
          const [filter, setFilter] = useState('all')
          const done = features.filter(feature => feature.passes).length
          const partial = features.filter(feature => feature.passes
            && typeof feature.coverage === 'string' && feature.coverage !== 'full'
            && feature.acceptedBy !== 'human')
          const shown = features.filter(feature => {
            if (filter === 'pending') return !feature.passes
            if (filter === 'done') return feature.passes
            if (filter === 'partial') return partial.includes(feature)
            return true
          })
          const options = [
            { id: 'all', label: t('filterAll'), count: features.length },
            { id: 'pending', label: t('filterPending'), count: features.length - done },
            { id: 'partial', label: t('partialCoverage'), count: partial.length },
            { id: 'done', label: t('statPassed'), count: done },
          ]
          const acceptAll = onAcceptAll !== undefined && partial.length > 0
            ? h('button', {
              type: 'button',
              className: 'relay-btn is-small',
              onClick: () => onAcceptAll(partial.map(feature => feature.id)),
            }, t('acceptAllPartial').replace('{count}', String(partial.length)))
            : null
          return h('section', { className: 'relay-card' },
            h(CardTitle, {
              tools: features.length === 0
                ? null
                : h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                  acceptAll,
                  h(Seg, { options, value: filter, onChange: setFilter })),
            }, t('features')),
            features.length === 0
              ? h('div', { className: 'relay-text' }, planMode ? t('planModeNote') : t('noFeatures'))
              : shown.length === 0
                ? h('div', { className: 'relay-text' }, t('filterEmpty'))
                : h('ul', { className: 'relay-list' }, shown.map(feature => h(FeatureRow, { key: feature.id, feature, onAccept }))),
          )
        }

        /** Last fetched text per chain and document, so a revisit renders at once. */
        const docCache = new Map()

        /**
         * Reader for the chain's truth-source documents.
         * The handoff brief arrives with the chain detail; progress and the
         * ledgers are fetched when their tab is opened.
         */
        function DocsCard({ chainId, detail, onSection }) {
          const [name, setName] = useState('handoff')
          const [fetched, setFetched] = useState(() => docCache.get(`${chainId}:handoff`) ?? null)
          const [error, setError] = useState(null)
          const [query, setQuery] = useState('')
          const [hits, setHits] = useState(null)
          const [searchError, setSearchError] = useState(null)
          const stamp = detail.chain?.updatedAt ?? ''
          const inline = DOCS.find(doc => doc.id === name)?.inline === true
          const search = () => {
            const words = query.trim()
            setSearchError(null)
            if (words.length === 0) {
              setHits(null)
              return
            }
            call('relay/recall', { chainId, query: words })
              .then((value) => {
                setHits({ total: value?.total ?? 0, matches: Array.isArray(value?.matches) ? value.matches : [] })
              })
              .catch((failure) => { setSearchError(messageOf(failure)) })
          }
          /** Open the document a search hit came from. */
          const openHit = (file) => {
            const lower = String(file).toLowerCase()
            if (lower === 'features.json') {
              onSection('features')
              return
            }
            if (lower === 'audit.jsonl') {
              onSection('audit')
              return
            }
            const target = DOCS.find(doc => `${doc.id}.md` === lower)
            if (target === undefined) return
            setHits(null)
            setName(target.id)
          }
          const freshness = detail.handoffFreshness ?? null
          const openChain = detail.chain?.status !== 'done'
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
          const results = hits === null ? null : (hits.matches.length === 0
            ? h('div', { className: 'relay-text' }, t('searchNone'))
            : h('ul', { className: 'relay-list' }, hits.matches.map((hit, index) => h('li', { key: `${hit.file}:${hit.line}:${index}`, className: 'relay-hit' },
              h('button', { type: 'button', className: 'relay-hit-where', onClick: () => openHit(hit.file) },
                typeof hit.line === 'number' ? `${hit.file}:${hit.line}` : hit.file),
              h('span', { className: 'relay-hit-text' }, hit.text),
            ))))
          return h('section', { className: 'relay-card' },
            h(CardTitle, {
              tools: h(Seg, {
                options: DOCS.filter(doc => doc.cluster !== true || detail.mode === 'cluster').map(doc => ({ id: doc.id, label: t(doc.label) })),
                value: hits === null ? name : null,
                onChange: (next) => { setHits(null); setName(next) },
              }),
            }, t('docs')),
            h('form', {
              className: 'relay-search',
              onSubmit: (event) => { event.preventDefault(); search() },
            },
              h('input', {
                className: 'relay-input',
                type: 'search',
                value: query,
                placeholder: t('searchPlaceholder'),
                'aria-label': t('searchPlaceholder'),
                onChange: event => setQuery(event.target.value),
              }),
              h('button', { type: 'submit', className: 'relay-btn', disabled: query.trim().length === 0 }, t('search')),
              hits === null
                ? null
                : h('button', { type: 'button', className: 'relay-btn', onClick: () => { setHits(null); setQuery(''); setSearchError(null) } }, t('searchClear')),
              hits === null ? null : h('span', { className: 'relay-tag' }, t('searchCount').replace('{n}', String(hits.total))),
            ),
            searchError === null ? null : h('div', { className: 'relay-error', style: { margin: '0 0 8px' } }, `${t('search')}: ${searchError}`),
            hits === null && name === 'handoff' && openChain && freshness !== null && freshness.fresh === false
              ? h('div', { className: 'relay-blocker', style: { margin: '0 0 8px' } }, freshness.reason === 'missing' ? t('handoffMissing') : t('handoffStale'))
              : null,
            hits === null && !inline && fetched?.truncated === true ? h('div', { className: 'relay-text', style: { marginBottom: '6px' } }, t('docTruncated')) : null,
            hits === null ? body : results,
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
            case 'goal.inherited': return `${detail.rounds ?? '?'} ${t('rounds')}`
            case 'goal.held':
            case 'plan.inherited': return shortId(detail.sessionId)
            case 'session.permission': return `${shortId(detail.sessionId)}: ${detail.preset ?? ''}`
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

        /** Closes a chain whose features all pass; the Host re-checks the evidence. */
        function FinishForm({ onFinish, busy }) {
          const [evidence, setEvidence] = useState('')
          return h('form', {
            className: 'relay-finish',
            onSubmit: (event) => { event.preventDefault(); if (evidence.trim().length > 0) onFinish(evidence.trim()) },
          },
            h('span', { className: 'relay-finish-note' }, t('finishReady')),
            h('input', {
              className: 'relay-input',
              value: evidence,
              placeholder: t('finishEvidence'),
              'aria-label': t('finishEvidence'),
              onChange: event => setEvidence(event.target.value),
            }),
            h('button', { type: 'submit', className: 'relay-btn is-primary', disabled: busy || evidence.trim().length === 0 }, t('finishChain')),
          )
        }

        /**
         * A sealed truth file changed outside the plugin. The chain stands still
         * until the human restores the sealed copy or adopts the change with a reason.
         */
        function TamperCard({ chain, detail, onAct, busy }) {
          const [reason, setReason] = useState('')
          const files = Array.isArray(detail.tamperDetail?.files) ? detail.tamperDetail.files : []
          return h('section', { className: 'relay-card relay-gate is-error' },
            h(CardTitle, { sub: detail.tamperDetail?.detectedAt ? ago(detail.tamperDetail.detectedAt) : '' }, t('tamperTitle')),
            h('div', { className: 'relay-text' }, t('tamperNote')),
            files.map(file => h('details', { key: file.file, className: 'relay-gate-file' },
              h('summary', {}, h('span', { className: 'relay-mono' }, file.file)),
              h('div', { className: 'relay-gate-diff' },
                h('div', {},
                  h('div', { className: 'relay-gate-label' }, t('tamperSealed')),
                  h('pre', { className: 'relay-gate-pre' }, file.sealed ?? ''),
                ),
                h('div', {},
                  h('div', { className: 'relay-gate-label' }, t('tamperDisk')),
                  h('pre', { className: 'relay-gate-pre' }, file.disk === null ? t('tamperMissing') : file.disk),
                ),
              ),
            )),
            h('div', { className: 'relay-actions' },
              h(ConfirmButton, {
                primary: true,
                disabled: busy,
                confirmLabel: t('confirm'),
                onConfirm: () => { void onAct('relay/resolveTamper', { chainId: chain.chainId, action: 'restore' }) },
              }, t('tamperRestore')),
            ),
            h('form', {
              className: 'relay-finish',
              onSubmit: (event) => {
                event.preventDefault()
                if (reason.trim().length > 0) void onAct('relay/resolveTamper', { chainId: chain.chainId, action: 'adopt', reason: reason.trim() })
              },
            },
              h('input', {
                className: 'relay-input',
                value: reason,
                placeholder: t('tamperReason'),
                'aria-label': t('tamperReason'),
                onChange: event => setReason(event.target.value),
              }),
              h('button', { type: 'submit', className: 'relay-btn', disabled: busy || reason.trim().length === 0 }, t('tamperAdopt')),
            ),
          )
        }

        /**
         * The verify commands the plugin runs outside the session sandbox.
         * Each needs a human's approval before its first run.
         */
        function CommandsCard({ chain, detail, onAct, busy }) {
          const commands = Array.isArray(detail.commands) ? detail.commands : []
          const missing = Array.isArray(detail.missingVerify) ? detail.missingVerify : []
          if (commands.length === 0 && missing.length === 0) return null
          const pending = commands.filter(entry => entry.approved !== true)
          return h('section', { className: `relay-card relay-gate${pending.length > 0 ? ' is-warn' : ''}` },
            h(CardTitle, { sub: `${commands.length - pending.length}/${commands.length}` }, t('commandsTitle')),
            pending.length > 0 ? h('div', { className: 'relay-text' }, t('commandsNote')) : null,
            h('ul', { className: 'relay-list' }, commands.map(entry => h('li', { key: entry.command, className: 'relay-feature' },
              h('span', { className: `relay-chip ${entry.approved ? 'is-success' : 'is-warn'}` }, entry.approved ? t('commandApproved') : t('commandPending')),
              h('div', { className: 'relay-feature-body' },
                h('code', { className: 'relay-gate-command' }, entry.command),
                h('div', { className: 'relay-feature-line' },
                  h('span', {}, [...(entry.features ?? []), ...(entry.full ? ['verifyFull'] : [])].join(', ')),
                ),
              ),
            ))),
            missing.length > 0
              ? h('div', { className: 'relay-text is-warn' }, `${t('commandsMissing')}: ${missing.join(', ')}`)
              : null,
            pending.length > 0
              ? h('div', { className: 'relay-actions' },
                h(ConfirmButton, {
                  primary: true,
                  disabled: busy,
                  confirmLabel: t('confirm'),
                  onConfirm: () => { void onAct('relay/approveCommands', { chainId: chain.chainId, commands: pending.map(entry => entry.command) }) },
                }, t('commandsApprove').replace('{count}', String(pending.length))),
              )
              : null,
          )
        }

        /**
         * The independent review of a finished chain and the human's final word on it.
         */
        function ReviewCard({ chain, detail, onAct, busy }) {
          const [reason, setReason] = useState('')
          const review = chain.review ?? null
          const reviewing = chain.status === 'reviewing'
          const awaiting = chain.status === 'awaiting_acceptance'
          const failedStart = chain.status === 'paused' && chain.pausedBy === 'review-failed'
          if (!reviewing && !awaiting && !failedStart && (review === null || review.outcome !== 'failed')) return null
          const sessions = Array.isArray(detail.sessions) ? detail.sessions : []
          const reviewer = sessions.find(session => session.sessionId === review?.sessionId) ?? null
          const counts = review?.counts ?? null
          const round = String(review?.round ?? 0)
          const notes = []
          if (review?.skipped === 'unavailable') notes.push(t('reviewSkippedUnavailable'))
          if (review?.skipped === 'disabled') notes.push(t('reviewSkippedDisabled'))
          if (review?.limitReached === true) notes.push(t('reviewLimit').replace('{n}', round))
          return h('section', { className: `relay-card relay-gate${awaiting ? ' is-success' : reviewing ? '' : ' is-warn'}` },
            h(CardTitle, { sub: t('reviewRound').replace('{n}', round) }, awaiting ? t('acceptTitle') : t('reviewTitle')),
            reviewing ? h('div', { className: 'relay-text' }, t('reviewRunning')) : null,
            awaiting && review?.outcome === 'passed' ? h('div', { className: 'relay-text' }, t('reviewPassed')) : null,
            !reviewing && !awaiting && review?.outcome === 'failed' ? h('div', { className: 'relay-text' }, t('reviewFailedNote')) : null,
            notes.map(note => h('div', { key: note, className: 'relay-text is-warn' }, note)),
            typeof review?.summary === 'string' && review.summary.length > 0
              ? h('div', { className: 'relay-feature-line' }, h('span', {}, review.summary))
              : null,
            counts === null
              ? null
              : h('div', { className: 'relay-pills' },
                h('span', { className: 'relay-chip is-success' }, `${t('verdict_match')} ${counts.match ?? 0}`),
                (counts.mismatch ?? 0) > 0 ? h('span', { className: 'relay-chip is-warn' }, `${t('verdict_mismatch')} ${counts.mismatch}`) : null,
                (counts.missing ?? 0) > 0 ? h('span', { className: 'relay-chip is-warn' }, `${t('verdict_missing')} ${counts.missing}`) : null,
                (counts.uncovered ?? 0) > 0 ? h('span', { className: 'relay-chip is-warn' }, `${t('verdict_uncovered')} ${counts.uncovered}`) : null,
              ),
            h('div', { className: 'relay-actions' },
              reviewer === null
                ? null
                : h('button', { type: 'button', className: 'relay-btn is-small', onClick: () => openSession(reviewer.sessionId) }, `${t('open')} ${shortId(reviewer.sessionId)}`),
              reviewing || failedStart
                ? h(ConfirmButton, {
                  disabled: busy,
                  confirmLabel: t('confirm'),
                  onConfirm: () => { void onAct('relay/restartReview', { chainId: chain.chainId }) },
                }, t('reviewRestart'))
                : null,
              awaiting
                ? h(ConfirmButton, {
                  primary: true,
                  disabled: busy,
                  confirmLabel: t('confirm'),
                  onConfirm: () => { void onAct('relay/acceptChain', { chainId: chain.chainId }) },
                }, t('acceptChain'))
                : null,
            ),
            awaiting
              ? h('form', {
                className: 'relay-finish',
                onSubmit: (event) => {
                  event.preventDefault()
                  if (reason.trim().length > 0) void onAct('relay/rejectChain', { chainId: chain.chainId, reason: reason.trim() })
                },
              },
                h('input', {
                  className: 'relay-input',
                  value: reason,
                  placeholder: t('rejectReason'),
                  'aria-label': t('rejectReason'),
                  onChange: event => setReason(event.target.value),
                }),
                h('button', { type: 'submit', className: 'relay-btn', disabled: busy || reason.trim().length === 0 }, t('rejectChain')),
              )
              : null,
          )
        }

        /** Everything about the selected chain. */
        /**
         * The launch proposal of a planning cluster chain.
         * The model only proposes; this card is where a human regroups the
         * features, picks the isolation, and starts the sessions.
         */
        function LaunchCard({ chain, detail, onAct, busy }) {
          const plan = detail.launchPlan ?? null
          const features = Array.isArray(detail.features) ? detail.features : []
          const proposed = Array.isArray(plan?.groups) ? plan.groups : []
          const [groups, setGroups] = useState(proposed)
          // A new proposal replaces whatever was regrouped locally, and any
          // half-armed confirmation belongs to the old plan.
          useEffect(() => {
            setGroups(proposed)
            setArmed(false)
          }, [plan?.proposedAt])
          // The Host judges every regrouping: refusals, overlaps, and which groups
          // will wait. One rule set, so the card cannot disagree with the launch.
          const payload = groups.map(group => ({ title: group.title, features: group.features, isolation: group.isolation, reason: group.reason }))
          // Everything the judgement depends on: the grouping, and the chain state the
          // Host checks (blocker, plan approval, the main session being loaded, the list).
          const [attempt, setAttempt] = useState(0)
          const payloadKey = JSON.stringify([
            payload,
            chain.blocker?.action ?? null,
            detail.head?.planMode === true,
            (Array.isArray(detail.sessions) ? detail.sessions : []).find(session => session.sessionId === chain.currentSessionId)?.loaded === true,
            features.map(feature => [feature.id, feature.passes === true, feature.assignedSessionId ?? null, feature.files ?? [], feature.dependsOn ?? []]),
            attempt,
          ])
          const [preview, setPreview] = useState(null)
          useEffect(() => {
            if (payload.length === 0) return undefined
            let live = true
            let retry
            call('relay/previewCluster', { chainId: chain.chainId, groups: payload })
              .then((value) => { if (live) setPreview({ key: payloadKey, value: value ?? {} }) })
              .catch(() => {
                // A failed check is not a refusal: say so and ask again.
                if (!live) return
                setPreview({ key: payloadKey, failed: true })
                retry = setTimeout(() => setAttempt(current => current + 1), 3000)
              })
            return () => { live = false; clearTimeout(retry) }
          }, [chain.chainId, payloadKey])
          const [armed, setArmed] = useState(false)
          // The panel's `busy` covers every action; this one keeps the label
          // honest while this card's own launch is in flight.
          const [launching, setLaunching] = useState(false)
          // The second step steps back on its own, like the other confirmations.
          useEffect(() => {
            if (!armed) return undefined
            const timer = setTimeout(() => setArmed(false), 8000)
            return () => clearTimeout(timer)
          }, [armed])
          if (proposed.length === 0) {
            return h('section', { className: 'relay-card' },
              h(CardTitle, { icon: true }, t('launchTitle')),
              h('div', { className: 'relay-text' }, t('launchPlanning')),
            )
          }
          const limit = detail.maxClusterSessions ?? 4
          const titleOf = id => features.find(feature => feature.id === id)?.title ?? ''
          const grouped = new Set(groups.flatMap(group => group.features))
          const kept = features.filter(feature => !feature.passes && !grouped.has(feature.id)
            && (feature.assignedSessionId === null || feature.assignedSessionId === undefined))
          const move = (featureId, target) => setGroups((current) => {
            const next = current.map(group => ({ ...group, features: group.features.filter(id => id !== featureId) }))
            if (target === 'new') {
              next.push({ id: `new-${featureId}-${Date.now()}`, title: titleOf(featureId) || featureId, features: [featureId], isolation: 'shared', reason: t('launchByHuman') })
            } else if (target !== 'keep') {
              const group = next.find(candidate => candidate.id === target)
              if (group !== undefined) group.features = [...group.features, featureId]
            }
            return next.filter(group => group.features.length > 0)
          })
          const isolate = (groupId, isolation) => setGroups(current => current.map(group => (group.id === groupId ? { ...group, isolation } : group)))
          const sharedCount = groups.filter(group => group.isolation === 'shared').length
          // Until the Host has judged this exact grouping, nothing can be launched.
          const current = preview !== null && preview.key === payloadKey ? preview : null
          const judged = current !== null && current.failed !== true ? current.value : null
          const groupName = index => groups[index]?.title ?? ''
          const issues = Array.isArray(judged?.issues) ? judged.issues : []
          const conflicts = launchConflictRows(judged)
          const waiting = new Map((Array.isArray(judged?.waiting) ? judged.waiting : []).map(item => [item.index, item.waitsFor ?? []]))
          const picker = (featureId, value) => h('select', {
            className: 'relay-input',
            value,
            disabled: busy,
            'aria-label': `${featureId} ${t('launchGroupPicker')}`,
            onChange: event => move(featureId, event.target.value),
          },
            groups.map(group => h('option', { key: group.id, value: group.id }, group.title)),
            h('option', { value: 'keep' }, t('launchKept')),
            groups.length < limit ? h('option', { value: 'new' }, t('launchNewGroup')) : null,
          )
          const featureLine = (featureId, value) => h('div', { key: featureId, className: 'relay-launch-feature' },
            h('span', { className: 'relay-mono' }, featureId),
            h('span', {}, titleOf(featureId)),
            picker(featureId, value),
          )
          const startLabel = sharedCount > 0 ? `${t('launchGo')} ${sharedCount} ${t('launchSessions')}` : t('launchGo')
          const canLaunch = !busy && !launching && groups.length > 0 && judged !== null && issues.length === 0
          // Regrouping only lives in this card: the launch bar runs the stored plan.
          const edited = JSON.stringify(payload) !== JSON.stringify(proposed.map(group => ({
            title: group.title,
            features: group.features,
            isolation: group.isolation,
            reason: group.reason,
          })))
          const askText = sharedCount > 0 ? t('launchDockConfirm').replace('{n}', String(sharedCount)) : t('launchConfirmAsk')
          return h('section', {
            className: 'relay-card relay-launch-card',
            onKeyDown: (event) => {
              if (event.key === 'Escape' && armed) {
                event.stopPropagation()
                setArmed(false)
              }
            },
          },
            h('div', { className: 'relay-launch-top' },
              h('div', { className: 'relay-launch-top-main' },
                h('div', { className: 'relay-launch-top-title' }, t('launchTitle')),
                h('div', { className: 'relay-launch-top-sub' }, `${groups.length} ${t('launchGroupsUnit')} · ${grouped.size} ${t('launchFeaturesUnit')} · ${sharedCount} ${t('launchSessions')}`),
              ),
              armed
                ? h('div', { className: 'relay-launch-confirm' },
                  h('span', { className: 'relay-launch-ask', 'aria-live': 'polite' }, askText),
                  h('button', {
                    type: 'button',
                    className: 'relay-btn is-cta',
                    autoFocus: true,
                    disabled: busy || !canLaunch,
                    onClick: () => {
                      setArmed(false)
                      setLaunching(true)
                      void Promise.resolve(onAct('relay/launchCluster', { chainId: chain.chainId, groups: payload }))
                        .finally(() => setLaunching(false))
                    },
                  }, launching ? t('launchStarting') : t('launchConfirm')),
                  h('button', { type: 'button', className: 'relay-btn', disabled: busy, onClick: () => setArmed(false) }, t('cancel')))
                : h('div', { className: 'relay-launch-actions' },
                  h('button', {
                    type: 'button',
                    className: 'relay-btn is-cta',
                    disabled: !canLaunch,
                    title: issues.length > 0 ? launchIssueText(issues[0], groupName) : undefined,
                    onClick: () => setArmed(true),
                  }, launching ? t('launchStarting') : startLabel),
                  h('span', { className: 'relay-launch-note' }, edited ? t('launchLocalNote') : t('launchNote'))),
            ),
            typeof plan.note === 'string' && plan.note.length > 0 ? h('p', { className: 'relay-text' }, plan.note) : null,
            current !== null && current.failed === true
              ? h('div', { className: 'relay-blocker is-code' }, h('span', { className: 'relay-blocker-text' }, t('launchCheckFailed')))
              : null,
            issues.map((issue, index) => h('div', { key: `issue:${index}`, className: 'relay-blocker is-external' },
              h('span', { className: 'relay-blocker-kind' }, t('launchRefused')),
              h('span', { className: 'relay-blocker-text' }, launchIssueText(issue, groupName)),
            )),
            conflicts.map(conflict => h('div', { key: conflict.key, className: 'relay-blocker is-code' },
              h('span', { className: 'relay-blocker-kind' }, t(conflict.kind)),
              h('span', { className: 'relay-blocker-text' }, conflict.text),
            )),
            groups.map((group, index) => h('div', { key: group.id, className: 'relay-launch-group' },
              h('div', { className: 'relay-launch-head' },
                h('span', { className: 'relay-launch-name' }, group.title),
                h(Seg, {
                  options: [{ id: 'shared', label: t('launchShared') }, { id: 'worktree', label: t('launchWorktree') }],
                  value: group.isolation,
                  onChange: next => isolate(group.id, next),
                }),
                group.isolation === 'worktree' ? h('span', { className: 'relay-tag' }, t('launchWorktreeNote')) : null,
                waiting.has(index)
                  ? h('span', { className: 'relay-chip' }, `${t('launchWaitsFor')} ${waiting.get(index).join(', ')} ${t('launchWaitsNote')}`)
                  : null,
              ),
              typeof group.reason === 'string' && group.reason.length > 0 ? h('div', { className: 'relay-text' }, group.reason) : null,
              group.features.map(featureId => featureLine(featureId, group.id)),
            )),
            kept.length === 0
              ? null
              : h('div', { className: 'relay-launch-group' },
                h('div', { className: 'relay-launch-head' }, h('span', { className: 'relay-launch-name' }, t('launchKept'))),
                kept.map(feature => featureLine(feature.id, 'keep')),
              ),
          )
        }

        /**
         * Groups of a launched cluster that still wait for a dependency.
         * Without this they would vanish from the panel between the launch
         * and the moment the Host opens their session.
         */
        function WaitingGroupsCard({ detail }) {
          const plan = detail.launchPlan ?? null
          const results = Array.isArray(plan?.results) ? plan.results.filter(result => result.waiting === true) : []
          if (results.length === 0) return null
          const groups = Array.isArray(plan.groups) ? plan.groups : []
          return h('section', { className: 'relay-card' },
            h(CardTitle, { icon: true, sub: t('launchWaitingSub') }, t('launchWaitingTitle')),
            results.map((result) => {
              const group = groups.find(candidate => candidate.id === result.id)
              return h('div', { key: result.id, className: 'relay-launch-group' },
                h('div', { className: 'relay-launch-head' },
                  h('span', { className: 'relay-launch-name' }, group?.title ?? result.id),
                  h('span', { className: 'relay-chip' }, `${t('launchWaitsFor')} ${(result.waitsFor ?? []).join(', ')}`),
                  h('span', { className: 'relay-tag' }, (group?.features ?? []).join(', ')),
                ),
              )
            }),
          )
        }

        /**
         * Delete is a destructive action, so it opens a consequence list before
         * it moves anything. The engine refuses a running session; the button
         * says so before the click as well.
         */
        function DeleteChainControl({ detail, busy, onAct, armed, onArm, onCancel }) {
          const chain = detail.chain ?? {}
          const sessions = Array.isArray(detail.sessions) ? detail.sessions : []
          const running = sessions.filter(session => session.running === true).length
          // A chain under review has to be paused (which cancels the review) before it can be deleted.
          const blocked = chain.status === 'active' || chain.status === 'initializing' || chain.status === 'reviewing'
            ? t('deleteBlocked')
            : running > 0 ? t('deleteRunning') : undefined
          if (blocked !== undefined || !armed) {
            return h('button', {
              type: 'button',
              className: 'relay-btn is-danger',
              disabled: busy || blocked !== undefined,
              title: blocked,
              onClick: onArm,
            }, t('delete'))
          }
          const ids = sessions.map(session => shortId(session.sessionId)).filter(Boolean).join(' · ')
          return h('div', { className: 'relay-delete-confirm' },
            h('div', { className: 'relay-delete-title' }, t('deleteConfirmTitle')),
            typeof detail.truthDir === 'string' && detail.truthDir.length > 0
              ? h('div', { className: 'relay-delete-path relay-mono', title: detail.truthDir }, detail.truthDir)
              : null,
            h('ul', { className: 'relay-delete-list' },
              h('li', {}, t('deleteKeepsSessions')
                .replace('{count}', String(sessions.length))
                .replace('{ids}', ids.length > 0 ? ids : t('none'))),
              h('li', {}, t('deleteGoalNote')),
              running > 0 ? h('li', { className: 'is-warn' }, t('deleteRunning')) : null,
              chain.status === 'done' ? h('li', {}, t('deleteDoneNote')) : null,
              h('li', {}, t('deleteGitNote')),
              h('li', {}, t('deleteTrashNote')),
            ),
            h('div', { className: 'relay-actions' },
              h('button', {
                type: 'button',
                className: 'relay-btn is-danger',
                disabled: busy,
                onClick: () => { onCancel(); void onAct('relay/deleteChain', { chainId: chain.chainId }) },
              }, t('confirmDelete')),
              h('button', { type: 'button', className: 'relay-btn', disabled: busy, onClick: onCancel }, t('cancel')),
            ),
          )
        }

        function ChainDetail({ detail, onAct, busy, waiting, section, setSection, deleteArmed, setDeleteArmed }) {
          const chain = detail.chain ?? {}
          const sessions = Array.isArray(detail.sessions) ? detail.sessions : []
          const features = Array.isArray(detail.features) ? detail.features : []
          const total = chain.featuresTotal ?? features.length
          const done = chain.featuresDone ?? features.filter(feature => feature.passes).length
          const current = sessions.find(session => session.sessionId === chain.currentSessionId) ?? null
          // An older Host sends no head: treat that as no goal and no plan mode.
          const head = detail.head ?? {}
          const headGoal = head.goal ?? null
          const currentState = stateOf(current)
          const live = currentState === 'running' || currentState === 'idle'
          const pressure = live ? (current.pressureRatio ?? 0) : null
          const isPaused = chain.status === 'paused'
          const isDone = chain.status === 'done'
          const isPlanning = chain.status === 'planning'
          const blocker = chain.blocker ?? null
          const phase = phaseOf(chain)
          const goalOwned = blocker !== null && typeof blocker.action === 'string' && blocker.action.startsWith('goal blocked:')
          const finishable = total > 0 && done === total && !isDone
            && chain.status !== 'reviewing' && chain.status !== 'awaiting_acceptance'
            && (chain.tamper === null || chain.tamper === undefined)
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
          const underReview = chain.status === 'reviewing' || chain.status === 'awaiting_acceptance'
          const handoffBlocked = isDone
            ? t('handoffDone')
            : isPlanning ? t('handoffPlanning') : underReview ? t('handoffReviewing') : (current === null || !live ? t('handoffUnloaded') : undefined)
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
                    modeChip(chain),
                    h('span', { className: `relay-status is-${chain.status}` },
                      isPaused && typeof chain.pausedBy === 'string' ? label('paused', chain.pausedBy) : label('status', chain.status)),
                    phase === null ? null : h('span', { className: 'relay-status is-warn' }, t(phase)),
                    stallChip(chain),
                    conflictChip(chain),
                    jobChip(chain),
                    blocker === null
                      ? null
                      : h('span', { className: `relay-status is-${blocker.kind === 'external' ? 'failed' : 'paused'}` }, label('blocker', blocker.kind)),
                    head.planMode === true ? h('span', { className: 'relay-chip is-human' }, t('planModeChip')) : null,
                  ),
                ),
                h('div', { className: 'relay-actions' },
                  h('button', {
                    type: 'button',
                    className: 'relay-btn',
                    disabled: busy || isDone || isPlanning || chain.status === 'awaiting_acceptance',
                    title: isDone
                      ? t('pauseDone')
                      : isPlanning ? t('pausePlanning') : chain.status === 'awaiting_acceptance' ? t('pauseAwaiting') : undefined,
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
                ),
              ),
              h('p', { className: 'relay-text' }, chain.objective),
              errorOf(chain) !== null
                ? h('div', { className: 'relay-error' }, errorOf(chain))
                : null,
              blocker === null
                ? null
                : h('div', { className: `relay-blocker is-${blocker.kind}` },
                  h('span', { className: 'relay-blocker-kind' }, label('blocker', blocker.kind)),
                  h('span', { className: 'relay-blocker-text' }, blocker.action ?? ''),
                  blocker.who ? h('span', { className: 'relay-tag' }, blocker.who) : null,
                  goalOwned
                    ? h('span', { className: 'relay-blocker-hint' }, t('goalBlockerHint'))
                    : h('button', {
                      type: 'button',
                      className: 'relay-btn is-small',
                      disabled: busy,
                      onClick: () => { void onAct('relay/clearBlocker', { chainId: chain.chainId }) },
                    }, t('clearBlocker')),
                ),
              finishable
                ? h(FinishForm, { busy, onFinish: (evidence) => { void onAct('relay/finishChain', { chainId: chain.chainId, evidence }) } })
                : null,
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
                headGoal === null ? null : h('dt', {}, t('goalRow')),
                headGoal === null
                  ? null
                  : h('dd', {},
                    h(GoalPills, { goal: headGoal, held: head.goalHeld === true, pausedByRelay: head.goalPausedByRelay === true }),
                    h('span', { className: 'relay-tag' }, t('goalBudget')),
                  ),
                headGoal === null || typeof headGoal.blockedMessage !== 'string' || headGoal.blockedMessage.length === 0
                  ? null
                  : h('dd', { className: 'relay-facts-note' }, h('div', { className: 'relay-text' }, headGoal.blockedMessage)),
                h('dt', {}, t('updatedAt')),
                h('dd', {},
                  h('span', { title: chain.updatedAt }, ago(chain.updatedAt)),
                  typeof chain.createdAt === 'string'
                    ? h('span', { className: 'relay-tag', title: chain.createdAt }, `${t('createdAt')} ${ago(chain.createdAt)}`)
                    : null,
                ),
              ),
            ),
            detail.tamperDetail === null || detail.tamperDetail === undefined
              ? null
              : h(TamperCard, { chain, detail, onAct, busy }),
            h(ReviewCard, { chain, detail, onAct, busy }),
            h(CommandsCard, { chain, detail, onAct, busy }),
            isPlanning ? h(LaunchCard, { chain, detail, onAct, busy }) : h(WaitingGroupsCard, { detail }),
            h('section', { className: 'relay-card' },
              h(CardTitle, { icon: true, sub: `${chain.handoffCount ?? 0}/${handoffCap} ${t('statHandoffs')}` }, t('track')),
              sessions.length === 0
                ? h('div', { className: 'relay-text' }, t('none'))
                : h(RelayTrack, {
                  sessions,
                  features,
                  currentSessionId: chain.currentSessionId,
                  waiting,
                  busy,
                  onReclaim: (sessionId) => { void onAct('relay/reclaimWorker', { chainId: chain.chainId, sessionId }) },
                }),
            ),
            h('div', { style: { marginBottom: '8px' } }, h(Seg, { options: sections, value: section, onChange: setSection })),
            section === 'features'
              ? h(FeatureCard, {
                chainId: chain.chainId,
                features,
                planMode: head.planMode === true,
                onAccept: (target, accepted) => {
                  void onAct('relay/acceptCoverage', { chainId: chain.chainId, featureId: target.id, accepted })
                },
                onAcceptAll: (featureIds) => {
                  void onAct('relay/acceptCoverageMany', { chainId: chain.chainId, featureIds })
                },
              })
              : null,
            section === 'docs' ? h(DocsCard, { chainId: chain.chainId, detail, onSection: setSection }) : null,
            section === 'audit' ? h(AuditCard, { chainId: chain.chainId }) : null,
            h('section', { className: 'relay-card relay-danger-zone' },
              h('div', { className: 'relay-danger-head' },
                h('b', {}, t('dangerZone')),
                h('span', { className: 'relay-text' }, t('dangerZoneNote')),
              ),
              h(DeleteChainControl, {
                detail,
                busy,
                onAct,
                armed: deleteArmed,
                onArm: () => setDeleteArmed(true),
                onCancel: () => setDeleteArmed(false),
              }),
            ),
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
        function TabEmpty({ title, body, action = null }) {
          return h('section', { className: 'relay-card' },
            h('div', { className: 'relay-empty' },
              h('div', { className: 'relay-empty-title' }, title),
              h('div', {}, body),
              action,
            ),
          )
        }

        /** The tab state for a session whose chain is only in the trash. */
        function DeletedChainTab({ deleted }) {
          const title = typeof deleted.title === 'string' && deleted.title.length > 0 ? deleted.title : deleted.chainId
          const body = t('deletedChainBody')
            .replace('{title}', title)
            .replace('{when}', stamp(deleted.deletedAt))
          return h(TabShell, {}, h(TabEmpty, {
            title: t('deletedChainTitle'),
            body,
            action: h('button', { type: 'button', className: 'relay-btn', onClick: openRelayPanel }, t('openPanel')),
          }))
        }

        /** The chain a session tab belongs to, with the way back to the panel. */
        function ChainBanner({ chain, head }) {
          const total = chain.featuresTotal ?? 0
          const done = chain.featuresDone ?? 0
          const blocker = chain.blocker ?? null
          const phase = phaseOf(chain)
          return h('section', { className: `relay-card relay-banner is-${chain.status}` },
            h('div', { className: 'relay-banner-main' },
              h('div', { className: 'relay-banner-title' },
                h('b', {}, chain.title || chain.chainId),
                modeChip(chain),
                h('span', { className: `relay-status is-${chain.status}` }, label('status', chain.status)),
                phase === null ? null : h('span', { className: 'relay-status is-warn' }, t(phase)),
                stallChip(chain),
                conflictChip(chain),
                jobChip(chain),
                blocker === null
                  ? null
                  : h('span', { className: `relay-status is-${blocker.kind === 'external' ? 'failed' : 'paused'}`, title: blocker.action }, label('blocker', blocker.kind)),
                head?.planMode === true ? h('span', { className: 'relay-chip is-human' }, t('planModeChip')) : null,
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

        /**
         * Pill and chip for a session's goal, with the round budget as a bar;
         * nothing when it has none. `held` and `pausedByRelay` explain why a
         * disarmed goal is not continuing: the plugin did it on purpose.
         */
        function GoalPills({ goal, held = false, pausedByRelay = false }) {
          if (goal === null || goal === undefined) return null
          const activation = pausedByRelay && goal.phase === 'paused'
            ? t('goalPausedWithChain')
            : held ? t('goalHeld') : (goal.activation === 'armed' ? t('goalArmed') : t('goalDisarmed'))
          return h('div', { className: 'relay-goal' },
            h('div', { className: 'relay-pills' },
              h('span', { className: `relay-status is-${GOAL_TONES[goal.phase] ?? 'paused'}` }, label('goal', goal.phase)),
              h('span', { className: `relay-chip${goal.activation === 'armed' ? '' : ' is-warn'}` }, activation),
              h('span', { className: 'relay-tag' }, `${t('goalRounds')} ${goal.roundsStarted ?? 0}/${goal.maxGoalRounds ?? 0}`),
            ),
            h('div', { className: 'relay-goal-bar' }, h(Bar, { done: goal.roundsStarted ?? 0, total: goal.maxGoalRounds ?? 0 })),
          )
        }

        /** One delegated child session card. */
        function ChildCard({ child, waiting, onReclaim }) {
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
              child.planMode === true ? h('span', { className: 'relay-chip is-human' }, t('planModeChip')) : null,
              h('button', { type: 'button', className: 'relay-btn is-small', onClick: () => openSession(child.sessionId) }, t('open')),
              onReclaim !== undefined && state !== 'retired' && owned.some(feature => !feature.passes)
                ? h(ConfirmButton, {
                  small: true,
                  title: t('reclaimNote'),
                  confirmLabel: t('confirmReclaim'),
                  onConfirm: () => onReclaim(child.sessionId),
                }, t('reclaim'))
                : null,
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
          const [actionError, setActionError] = useState(null)
          if (error !== null) return h(TabShell, {}, h(TabEmpty, { title: t('failed'), body: error }))
          if (view === undefined) return h(TabShell, {}, h('div', { className: 'relay-text' }, t('loading')))
          if (view !== null && view.deleted !== undefined) return h(DeletedChainTab, { deleted: view.deleted })
          if (view === null || view.chain === null) return h(TabShell, {}, h(TabEmpty, { title: t('noChainTitle'), body: t('noChainBody') }))
          const children = Array.isArray(view.children) ? view.children : []
          const running = children.filter(child => stateOf(child) === 'running').length
          const owned = children.reduce((sum, child) => sum + (Array.isArray(child.features) ? child.features.length : 0), 0)
          const passed = children.reduce((sum, child) => sum + (child.featuresPassed ?? 0), 0)
          const reclaim = (childId) => {
            setActionError(null)
            call('relay/reclaimWorker', { chainId: view.chain.chainId, sessionId: childId })
              .catch((failure) => { setActionError(messageOf(failure)) })
          }
          const waiting = new Set(decisions.map(decision => decision.sessionId).filter(id => typeof id === 'string'))
          const isCurrent = view.chain.currentSessionId === sessionId
          return h(TabShell, {},
            h(ChainBanner, { chain: view.chain, head: view.head }),
            children.length === 0
              ? h(TabEmpty, { title: t('noChildrenTitle'), body: isCurrent ? t('noChildrenBody') : t('noChildrenNotCurrent') })
              : h(React.Fragment, {},
                view.chain.mode === 'cluster' && isCurrent
                  && children.some(child => typeof child.parentSessionId === 'string' && child.parentSessionId !== sessionId)
                  ? h('div', { className: 'relay-text', style: { marginBottom: '8px' } }, t('childrenClusterNote'))
                  : null,
                h('div', { className: 'relay-section-line' },
                  h('b', {}, `${t('childCount')} ${children.length}`),
                  h('span', {}, `${running} ${t('statRunning')}`),
                  h('span', {}, `${t('featuresLabel')} ${passed}/${owned}`),
                ),
                actionError === null ? null : h('div', { className: 'relay-error' }, actionError),
                h('div', { className: 'relay-children' },
                  children.map(child => h(ChildCard, {
                    key: child.sessionId,
                    child,
                    waiting: waiting.has(child.sessionId),
                    onReclaim: reclaim,
                  }))),
              ),
          )
        }

        /** Session tab: the work this session received and how far it got. */
        function TasksTab({ sessionId }) {
          const { view, error } = useSessionView(sessionId)
          if (error !== null) return h(TabShell, {}, h(TabEmpty, { title: t('failed'), body: error }))
          if (view === undefined) return h(TabShell, {}, h('div', { className: 'relay-text' }, t('loading')))
          if (view !== null && view.deleted !== undefined) return h(DeletedChainTab, { deleted: view.deleted })
          if (view === null || view.chain === null) return h(TabShell, {}, h(TabEmpty, { title: t('noChainTitle'), body: t('noChainBody') }))
          const self = view.self ?? {}
          const parent = view.parent ?? null
          const delegated = parent !== null
          // A delegated session owns what it was assigned; a main-line session
          // owns the features no child worker holds, including ones a retired
          // mainline leg still owns.
          const features = delegated
            ? (Array.isArray(view.assignedFeatures) ? view.assignedFeatures : [])
            : (Array.isArray(view.mainlineFeatures)
              ? view.mainlineFeatures
              : (Array.isArray(view.openFeatures) ? view.openFeatures : []))
          const done = features.filter(feature => feature.passes).length
          const state = stateOf(self)
          const currentId = view.chain.currentSessionId
          const isCurrent = currentId === sessionId
          const handedOver = !delegated && state === 'retired' && typeof currentId === 'string' && !isCurrent
          const goal = self.goal ?? null
          return h(TabShell, {},
            h(ChainBanner, { chain: view.chain, head: view.head }),
            h('div', { className: 'relay-task-grid' },
              h('div', { className: 'relay-task-side' },
                h('section', { className: 'relay-card' },
                  h(CardTitle, {}, t('positionTitle')),
                  h('div', { className: 'relay-pills' },
                    h('span', { className: 'relay-chip' }, delegated ? t('posChild') : t('posMainline')),
                    typeof self.role === 'string' ? h('span', { className: 'relay-chip' }, label('role', self.role)) : null,
                    isCurrent ? h('span', { className: 'relay-chip is-human' }, t('posCurrent')) : null,
                    self.planMode === true ? h('span', { className: 'relay-chip is-human' }, t('planModeChip')) : null,
                    h(StatePill, { session: self }),
                  ),
                  state === null
                    ? null
                    : h('div', { style: { marginTop: '10px' } },
                      h(GaugeRow, { session: self }),
                      h('div', { className: 'relay-tag', style: { marginTop: '4px' } }, `${t('compactions')} ${self.compactions ?? 0}`),
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
                      // The head state describes the chain's current session only.
                      h(GoalPills, {
                        goal,
                        held: isCurrent && view.head?.goalHeld === true,
                        pausedByRelay: isCurrent && view.head?.goalPausedByRelay === true,
                      }),
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

        /**
         * Launch bar above the composer of the planning chain's head.
         * The panel stays the place to regroup features; this bar starts the
         * plan on record without leaving the conversation. It is a human
         * action only: no tool reaches `launchCluster`.
         */
        function ClusterLaunchDock({ sessionId, session }) {
          const id = typeof sessionId === 'string' && sessionId.length > 0
            ? sessionId
            : (typeof session?.sessionId === 'string' ? session.sessionId : null)
          const { view } = useSessionView(id)
          const chain = view?.chain ?? null
          const pending = chain !== null && chain.status === 'planning' && chain.launchPending === true
            && chain.currentSessionId === id
          const [detail, setDetail] = useState(null)
          const [checked, setChecked] = useState(null)
          const [armed, setArmed] = useState(false)
          const [busy, setBusy] = useState(false)
          const [actionError, setActionError] = useState(null)
          // What the last launch did. Kept until the session view stops calling
          // the chain planning, so the bar reports the outcome instead of
          // offering the launch again.
          const [outcome, setOutcome] = useState(null)
          const finished = outcome !== null && chain !== null && outcome.chainId === chain.chainId
          useEffect(() => {
            const stale = outcome !== null && chain !== null && outcome.chainId !== chain.chainId
            if (!pending || stale) {
              setDetail(null)
              setChecked(null)
              setArmed(false)
              setActionError(null)
              if (outcome !== null) setOutcome(null)
              return undefined
            }
            // A finished launch stops the reads: the chain is active now, and
            // re-reading it would draw the bar again before the session view
            // catches up.
            if (outcome !== null) return undefined
            let live = true
            setDetail(null)
            setChecked(null)
            setArmed(false)
            setActionError(null)
            // Two independent reads: a failed check must not hide the bar, it only
            // disables the start button until the next poll.
            const load = () => {
              call('relay/chainDetail', { chainId: chain.chainId })
                .then((next) => { if (live) setDetail(next ?? null) })
                .catch(() => { /* the next poll retries */ })
              call('relay/previewCluster', { chainId: chain.chainId })
                .then((preview) => { if (live) setChecked(preview ?? {}) })
                .catch(() => { if (live) setChecked({ failed: true }) })
            }
            load()
            const timer = setInterval(load, POLL_MS)
            return () => { live = false; clearInterval(timer) }
          }, [pending, chain?.chainId, outcome])
          useEffect(() => {
            if (!armed) return undefined
            const timer = setTimeout(() => setArmed(false), 8000)
            return () => clearTimeout(timer)
          }, [armed])
          if (!pending || detail === null) return null
          const groups = Array.isArray(detail.launchPlan?.groups) ? detail.launchPlan.groups : []
          if (groups.length === 0) return null
          const featureCount = groups.reduce((sum, group) => sum + (Array.isArray(group.features) ? group.features.length : 0), 0)
          const shared = groups.filter(group => group.isolation === 'shared').length
          const worktree = groups.length - shared
          const issues = finished ? [] : (Array.isArray(checked?.issues) ? checked.issues : [])
          const conflicts = finished ? [] : launchConflictRows(checked)
          const groupName = index => groups[index]?.title ?? ''
          const checkFailed = !finished && checked?.failed === true
          const launchable = !busy && checked !== null && !checkFailed && issues.length === 0
          const askText = shared > 0 ? t('launchDockConfirm').replace('{n}', String(shared)) : t('launchConfirmAsk')
          const results = finished ? outcome.results : []
          const launched = results.filter(result => result.launched === true)
          const failed = results.filter(result => result.launched !== true && result.waiting !== true)
          const waiting = results.filter(result => result.waiting === true)
          const launchLabel = busy ? t('launchStarting') : (shared > 0 ? `${t('launchGo')} ${shared} ${t('launchSessions')}` : t('launchGo'))
          const start = () => {
            setArmed(false)
            setBusy(true)
            setActionError(null)
            call('relay/launchCluster', { chainId: chain.chainId })
              .then((result) => {
                setOutcome({ chainId: chain.chainId, results: Array.isArray(result?.results) ? result.results : [] })
              })
              .catch((failure) => { setActionError(messageOf(failure)) })
              .finally(() => setBusy(false))
          }
          return h('section', {
            className: 'relay-launch-dock',
            role: 'region',
            'aria-label': t('launchDockTitle'),
            onKeyDown: (event) => {
              if (event.key === 'Escape' && armed) {
                event.stopPropagation()
                setArmed(false)
              }
            },
          },
            h('style', { 'data-plugin': 'longtask-relay' }, CSS),
            h('div', { className: 'relay-launch-dock-row' },
              h('div', { className: 'relay-launch-dock-main' },
                h('div', { className: 'relay-launch-dock-title' },
                  h('span', {}, t('launchDockTitle')),
                  h('span', { className: 'relay-chip is-human' }, `${groups.length} ${t('launchGroupsUnit')}`),
                  h('span', { className: 'relay-tag' }, `${featureCount} ${t('launchFeaturesUnit')} · ${shared} ${t('launchSessions')}`),
                ),
                h('div', { className: 'relay-launch-dock-groups' },
                  groups.map(group => h('span', { key: group.id, className: 'relay-chip' }, `${group.title} · ${group.features.length}`)),
                ),
                worktree > 0
                  ? h('div', { className: 'relay-launch-dock-note' }, `${worktree} ${t('launchGroupsUnit')} · ${t('launchWorktreeNote')}`)
                  : null,
                h('div', { className: 'relay-launch-dock-note' }, t('launchDockNote')),
              ),
              h('div', { className: 'relay-launch-dock-actions' },
                finished
                  ? h('span', { className: 'relay-tag' }, t('launchDone').replace('{n}', String(launched.length)))
                  : armed
                    ? h(React.Fragment, {},
                      h('span', { className: 'relay-launch-ask', 'aria-live': 'polite' }, askText),
                      h('button', {
                        type: 'button',
                        className: 'relay-btn is-cta',
                        autoFocus: true,
                        disabled: busy || !launchable,
                        onClick: start,
                      }, busy ? t('launchStarting') : t('launchConfirm')),
                      h('button', { type: 'button', className: 'relay-btn', disabled: busy, onClick: () => setArmed(false) }, t('cancel')))
                    : h(React.Fragment, {},
                      h('button', {
                        type: 'button',
                        className: 'relay-btn is-cta',
                        disabled: !launchable,
                        title: issues.length > 0 ? launchIssueText(issues[0], groupName) : (checkFailed ? t('launchCheckFailed') : undefined),
                        onClick: () => setArmed(true),
                      }, launchLabel),
                      h('button', { type: 'button', className: 'relay-btn', onClick: () => showChainInPanel(chain.chainId) }, t('launchDockAdjust')))),
            ),
            finished
              ? h(React.Fragment, {},
                failed.length === 0
                  ? null
                  : h('div', { className: 'relay-blocker is-external' },
                    h('span', { className: 'relay-blocker-kind' }, t('launchFailedGroups')),
                    h('span', { className: 'relay-blocker-text' }, `${failed.map(result => result.id).join(', ')}${typeof failed[0].reason === 'string' && failed[0].reason.length > 0 ? ` — ${failed[0].reason}` : ''}`),
                  ),
                waiting.length === 0
                  ? null
                  : h('div', { className: 'relay-blocker is-code' },
                    h('span', { className: 'relay-blocker-kind' }, t('launchWaitingTitle')),
                    h('span', { className: 'relay-blocker-text' }, waiting.map(result => `${result.id} (${(result.waitsFor ?? []).join(', ')})`).join(', ')),
                  ))
              : h(React.Fragment, {},
                checkFailed
                  ? h('div', { className: 'relay-blocker is-code' }, h('span', { className: 'relay-blocker-text' }, t('launchCheckFailed')))
                  : null,
                issues.map((issue, index) => h('div', { key: `issue:${index}`, className: 'relay-blocker is-external' },
                  h('span', { className: 'relay-blocker-kind' }, t('launchRefused')),
                  h('span', { className: 'relay-blocker-text' }, launchIssueText(issue, groupName)),
                )),
                conflicts.map(conflict => h('div', { key: conflict.key, className: 'relay-blocker is-code' },
                  h('span', { className: 'relay-blocker-kind' }, t(conflict.kind)),
                  h('span', { className: 'relay-blocker-text' }, conflict.text),
                )),
                actionError === null ? null : h('div', { className: 'relay-error', role: 'alert' }, `${t('actionFailed')}: ${actionError}`)),
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
          const { update, busy: updateBusy, note: updateNote, run: runUpdate } = usePluginUpdate()

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
            update === null
              ? h('div', { className: 'relay-config-status' }, t('checkingUpdate'))
              : update.available
                ? h('div', { className: 'relay-update' },
                  h('span', { className: 'relay-update-text' },
                    t('updateBanner')
                      .replace('{current}', update.currentVersion ?? '?')
                      .replace('{latest}', update.latestVersion ?? '?')),
                  updateNote === null ? null : h('span', { className: 'relay-version' }, updateNote),
                  h('button', {
                    type: 'button',
                    className: 'relay-btn is-primary',
                    disabled: updateBusy,
                    onClick: () => { void runUpdate() },
                  }, updateBusy ? t('updating') : t('updateNow').replace('{version}', update.latestVersion ?? '')),
                )
                : h('div', { className: 'relay-config-status' }, `v${update.currentVersion ?? '?'}`),
            body,
          )
        }

        /**
         * Last panel payload, so reopening the panel renders before the poll.
         * `chains === null` means nothing has loaded yet.
         */
        const panelCache = { chains: null, deleted: null, detail: null, selectedId: null }

        /**
         * Shared plugin self-update state: checks once per mount, then applies a
         * fast-forward and toggles the profile entry so the Host reloads it.
         * @param {boolean} [enabled] - false skips the git check entirely, so a
         *   detail action mounted on other plugins' pages does not fetch.
         */
        function usePluginUpdate(enabled = true) {
          const [update, setUpdate] = useState(null)
          const [busy, setBusy] = useState(false)
          const [note, setNote] = useState(null)
          useEffect(() => {
            if (!enabled) return undefined
            let live = true
            call('relay/checkUpdate')
              .then((value) => { if (live) setUpdate(value) })
              .catch(() => { /* an update check never breaks the panel */ })
            return () => { live = false }
          }, [enabled])
          const run = useCallback(async () => {
            setBusy(true)
            setNote(null)
            try {
              const result = await call('relay/applyUpdate')
              if (result?.ok !== true) {
                setNote(result?.reason === 'dirty' ? t('updateDirty') : t('updateFailed'))
                return
              }
              setNote(t('updateDone'))
              const entryId = result.entryId
              if (typeof entryId !== 'string') {
                setNote(t('updateManual'))
                return
              }
              // Toggle the profile entry so the Host loads the pulled code.
              try {
                await call('pluginManager/setPluginEnabled', { entryId, enabled: false })
                await new Promise(resolve => setTimeout(resolve, 400))
                await call('pluginManager/setPluginEnabled', { entryId, enabled: true })
                window.location.reload()
              } catch {
                setNote(t('updateManual'))
              }
            } catch {
              setNote(t('updateFailed'))
            } finally {
              setBusy(false)
            }
          }, [])
          return { update, busy, note, run }
        }

        /**
         * `plugins.detail.actions` entry: the update control at the head of this
         * bundle's detail page, beside the page's own switch and uninstall.
         * The page renders this list for every detail page, so a subject that is
         * not this bundle returns null before the git check even starts.
         */
        function UpdateAction({ subject }) {
          const mine = subject?.kind === 'bundle' && subject.pkg?.name === PACKAGE_NAME
          const { update, busy, note, run } = usePluginUpdate(mine)
          if (!mine || update === null || !update.available) return null
          return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            note === null
              ? null
              : h('span', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: '12px' } }, note),
            h('button', {
              type: 'button',
              disabled: busy,
              style: {
                padding: '3px 10px',
                borderRadius: '6px',
                border: '1px solid var(--dsw-alias-border-l2, #555)',
                background: 'var(--dsw-alias-bg-elevated, transparent)',
                color: 'var(--dsw-alias-label-primary, inherit)',
                fontSize: '12px',
                cursor: busy ? 'default' : 'pointer',
              },
              onClick: () => { void run() },
            }, busy ? t('updating') : t('updateNow').replace('{version}', update.latestVersion ?? '')),
          )
        }

        /** What the last delete/restore did, with the way back while it is open. */
        function DeleteNotice({ notice, busy, onUndo, onViewTrash, onDismiss }) {
          if (notice === null || notice === undefined) return null
          const title = typeof notice.title === 'string' && notice.title.length > 0 ? notice.title : notice.chainId
          let text
          if (notice.kind === 'deleted') {
            const sessions = Array.isArray(notice.sessions) ? notice.sessions : []
            text = t('deletedNotice')
              .replace('{title}', title)
              .replace('{count}', String(sessions.length))
          } else if (notice.kind === 'restored') {
            text = t('restoredNotice').replace('{title}', title)
          } else {
            text = t('purgedNotice').replace('{title}', title)
          }
          const sessions = Array.isArray(notice.sessions) ? notice.sessions : []
          return h('section', { className: `relay-card relay-notice is-${notice.kind}` },
            h('div', { className: 'relay-notice-row' },
              h('span', { className: 'relay-notice-text' }, text),
              notice.kind === 'deleted'
                ? h('button', { type: 'button', className: 'relay-btn is-small', disabled: busy, onClick: () => onUndo(notice) }, t('undo'))
                : null,
              notice.kind === 'deleted'
                ? h('button', { type: 'button', className: 'relay-btn is-small', onClick: onViewTrash }, t('viewTrash'))
                : null,
              h('button', { type: 'button', className: 'relay-btn is-small', onClick: onDismiss }, t('dismiss')),
            ),
            notice.kind === 'deleted' && sessions.length > 0
              ? h('div', { className: 'relay-notice-sessions' },
                sessions.slice(0, 6).map(sessionId => h('button', {
                  key: sessionId,
                  type: 'button',
                  className: 'relay-btn is-small',
                  title: sessionId,
                  onClick: () => openSession(sessionId),
                }, shortId(sessionId))),
                sessions.length > 6 ? h('span', { className: 'relay-tag' }, `+${sessions.length - 6}`) : null)
              : null,
          )
        }

        /** The first-run wizard would be wrong when every live chain was deleted. */
        function NoLiveChains({ count }) {
          return h('section', { className: 'relay-card' },
            h('div', { className: 'relay-empty' },
              h('div', { className: 'relay-empty-title' }, t('noLiveChainsTitle')),
              h('div', {}, t('noLiveChainsBody').replace('{count}', String(count))),
            ),
          )
        }

        /** The recycle-bin view: always available, even when empty. */
        function RecentlyDeleted({ items, busy, onRestore, onPurge }) {
          const list = Array.isArray(items) ? items : []
          return h('section', { className: 'relay-card relay-trash' },
            h('div', { className: 'relay-trash-head' },
              h('div', { className: 'relay-trash-heading' },
                h('b', {}, `${t('recentlyDeleted')} (${list.length})`),
                h('span', { className: 'relay-trash-hint' }, t('trashLiveHint')),
              ),
            ),
            list.length === 0
              ? h('div', { className: 'relay-empty' },
                h('div', { className: 'relay-empty-title' }, t('emptyTrashTitle')),
                h('div', {}, t('emptyTrashBody')),
              )
              : list.map(item => h('div', { key: item.chainId, className: 'relay-trash-row' },
                h('div', { className: 'relay-trash-main' },
                  h('span', { className: 'relay-trash-title', title: item.chainId }, item.title || item.chainId),
                  h('span', { className: 'relay-tag' }, `${item.featuresDone ?? 0}/${item.featuresTotal ?? 0}`),
                  h('span', { className: 'relay-tag' }, `${(item.sessions ?? []).length} ${t('sessions')}`),
                  typeof item.deletedAt === 'string' && item.deletedAt.length > 0
                    ? h('span', { className: 'relay-trash-when' }, `${t('deletedAt')} ${stamp(item.deletedAt)}`)
                    : null,
                ),
                h('div', { className: 'relay-actions' },
                  h('button', { type: 'button', className: 'relay-btn is-small', disabled: busy, onClick: () => onRestore(item) }, t('restore')),
                  h(ConfirmButton, {
                    small: true,
                    disabled: busy,
                    confirmLabel: t('confirmPurge'),
                    note: t('purgeNote'),
                    onConfirm: () => onPurge(item),
                  }, t('purge')),
                ),
              )),
          )
        }

        /** The panel: every chain on the left, one chain in full on the right. */
        function RelayPage() {
          const [chains, setChains] = useState(() => panelCache.chains ?? [])
          const [deleted, setDeleted] = useState(() => panelCache.deleted ?? [])
          const [detail, setDetail] = useState(() => panelCache.detail ?? null)
          const [selectedId, setSelectedId] = useState(() => focus.chainId ?? panelCache.selectedId)
          const [error, setError] = useState(null)
          const [loading, setLoading] = useState(() => panelCache.chains === null)
          const [busy, setBusy] = useState(false)
          const [filter, setFilter] = useState('all')
          const [needle, setNeedle] = useState('')
          const [actionError, setActionError] = useState(null)
          const [notice, setNotice] = useState(null)
          // The detail's tab and its armed delete confirmation live here so
          // ChainDetail stays hook-free and can be rendered independently.
          const [section, setSection] = useState('features')
          const [deleteArmed, setDeleteArmed] = useState(false)
          const [panelView, setPanelView] = useState('chains')
          const selectedRef = useRef(focus.chainId ?? panelCache.selectedId)
          const splitRef = useRef(null)
          const decisions = usePendingDecisions()
          const { update, busy: updateBusy, note: updateNote, run: runUpdate } = usePluginUpdate()

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
                setDeleteArmed(false)
                setSection('features')
              }
              // A Host without the trash endpoint (or an unreadable trash) must
              // still render the live chains.
              let nextDeleted = panelCache.deleted ?? []
              try {
                const listedTrash = await call('relay/listDeleted')
                nextDeleted = Array.isArray(listedTrash?.chains) ? listedTrash.chains : []
              } catch {
                /* keep the last known deleted list */
              }
              const nextDetail = wanted === null ? null : await call('relay/chainDetail', { chainId: wanted })
              panelCache.chains = next
              panelCache.deleted = nextDeleted
              setChains(next)
              setDeleted(nextDeleted)
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
            setDeleteArmed(false)
            setSection('features')
            setPanelView('chains')
            void refresh()
          }, [refresh])

          /**
           * Jump to a chain from the attention list.
           * A single-chain panel already auto-selects that chain, so selecting
           * alone would change nothing on screen; scroll the detail side into
           * view and clear any filter hiding the chain.
           */
          const focusChain = useCallback((chainId) => {
            setFilter('all')
            setNeedle('')
            select(chainId)
            requestAnimationFrame(() => {
              try {
                splitRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
              } catch {
                /* this shell may not scroll programmatically */
              }
            })
          }, [select])

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
            let value = null
            try {
              value = await call(endpoint, args)
              if (value !== null && typeof value === 'object' && value.ok === false) {
                failure = value.message ?? value.code ?? endpoint
              }
            } catch (caught) {
              failure = messageOf(caught)
            }
            setBusy(false)
            // Kept apart from the read error: the next poll clears that one,
            // and a refused action has to stay until the reader has seen it.
            setActionError(failure)
            if (failure === null && value !== null && typeof value === 'object') {
              if (endpoint === 'relay/deleteChain') {
                setNotice({ kind: 'deleted', ...value })
              } else if (endpoint === 'relay/restoreChain') {
                setNotice({ kind: 'restored', chainId: value.chainId, title: value.title ?? '' })
              } else if (endpoint === 'relay/purgeChain') {
                setNotice({ kind: 'purged', chainId: value.chainId, title: value.title ?? '' })
              }
            }
            await refresh()
            return { ok: failure === null, value, failure }
          }, [refresh])

          const restoreDeleted = useCallback(async (item) => {
            const outcome = await act('relay/restoreChain', { chainId: item.chainId })
            if (outcome.ok) {
              setPanelView('chains')
              select(item.chainId)
            }
          }, [act, select])

          const purgeDeleted = useCallback((item) => {
            void act('relay/purgeChain', { chainId: item.chainId })
          }, [act])

          const sessionsOf = chain => (Array.isArray(chain.sessionsDetail) ? chain.sessionsDetail : [])
          const isActive = chain => chain.status === 'active' || chain.status === 'initializing' || chain.status === 'planning'
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
          // Sessions of deleted chains still surface approvals; tag them so the
          // attention list never looks like an ownerless pending request.
          const deletedSessions = new Map()
          for (const item of deleted) {
            for (const sessionId of Array.isArray(item.sessions) ? item.sessions : []) {
              if (!deletedSessions.has(sessionId)) deletedSessions.set(sessionId, item)
            }
          }

          // Everything that is waiting on a human, most actionable first.
          const attention = []
          for (const decision of decisions) {
            const owner = typeof decision.sessionId === 'string' ? chainOfSession(decision.sessionId) : undefined
            const gone = typeof decision.sessionId === 'string' ? deletedSessions.get(decision.sessionId) : undefined
            attention.push({
              key: decision.key,
              tone: 'warn',
              kind: decision.kind === 'approval' ? t('attnApproval') : t('attnQuestion'),
              text: decision.title || decision.detail || '',
              meta: [
                gone === undefined ? null : t('deletedChainTag'),
                owner?.title ?? gone?.title,
                shortId(decision.sessionId),
                decision.detail,
              ].filter(part => typeof part === 'string' && part.length > 0).join(' / '),
              action: typeof decision.sessionId === 'string' ? { label: t('openSession'), run: () => openSession(decision.sessionId) } : null,
            })
          }
          for (const chain of chains) {
            if (chain.launchPending === true) {
              attention.push({
                key: `launch:${chain.chainId}`,
                tone: 'warn',
                kind: t('attnLaunch'),
                text: chain.objective ?? '',
                meta: chain.title ?? '',
                action: { label: t('attnLaunchGo'), run: () => focusChain(chain.chainId) },
              })
            }
            if (chain.blocker !== null && chain.blocker !== undefined) {
              attention.push({
                key: `blocker:${chain.chainId}`,
                tone: chain.blocker.kind === 'external' ? 'error' : 'warn',
                kind: label('blocker', chain.blocker.kind),
                text: chain.blocker.action ?? '',
                meta: [chain.title, chain.blocker.who].filter(part => typeof part === 'string' && part.length > 0).join(' / '),
                action: { label: t('viewChain'), run: () => focusChain(chain.chainId) },
              })
            }
            if (chain.tamper !== null && chain.tamper !== undefined) {
              attention.push({
                key: `tamper:${chain.chainId}`,
                tone: 'error',
                kind: t('attnTamper'),
                text: (chain.tamper.files ?? []).join(', '),
                meta: chain.title ?? '',
                action: { label: t('viewChain'), run: () => focusChain(chain.chainId) },
              })
            }
            if (chain.pausedBy === 'review-failed') {
              attention.push({
                key: `review:${chain.chainId}`,
                tone: 'error',
                kind: t('attnReview'),
                text: chain.lastError ?? '',
                meta: chain.title ?? '',
                action: { label: t('viewChain'), run: () => focusChain(chain.chainId) },
              })
            }
            if (chain.status === 'awaiting_acceptance') {
              attention.push({
                key: `accept:${chain.chainId}`,
                tone: 'warn',
                kind: t('attnAccept'),
                text: chain.objective ?? '',
                meta: chain.title ?? '',
                action: { label: t('viewChain'), run: () => focusChain(chain.chainId) },
              })
            }
            if ((chain.commandsPending ?? 0) > 0) {
              attention.push({
                key: `commands:${chain.chainId}`,
                tone: 'warn',
                kind: t('attnCommands'),
                text: String(chain.commandsPending),
                meta: chain.title ?? '',
                action: { label: t('viewChain'), run: () => focusChain(chain.chainId) },
              })
            }
            if (errorOf(chain) !== null) {
              attention.push({
                key: `error:${chain.chainId}`,
                tone: 'error',
                kind: t('attnError'),
                text: errorOf(chain),
                meta: chain.title ?? '',
                action: { label: t('viewChain'), run: () => focusChain(chain.chainId) },
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
          const needleText = needle.trim().toLowerCase()
          const shown = chains.filter((chain) => {
            if (needleText !== '' && ![chain.title, chain.objective, chain.cwd].some(text => typeof text === 'string' && text.toLowerCase().includes(needleText))) return false
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
                    updateNote !== null
                      ? h('span', { className: 'relay-version' }, updateNote)
                      : update === null
                        ? h('span', { className: 'relay-version' }, t('checkingUpdate'))
                        : h('span', { className: 'relay-version' }, `v${update.currentVersion ?? '?'}`),
                    h('button', { type: 'button', className: 'relay-btn', onClick: openPluginPage }, t('openPluginPage')),
                    h('button', { type: 'button', className: 'relay-btn', onClick: () => { void refresh() } }, t('refresh')),
                  ),
                ),
                h('div', { className: 'relay-panel-tabs' },
                  h(Seg, {
                    options: [
                      { id: 'chains', label: t('chains'), count: chains.length },
                      { id: 'deleted', label: t('recentlyDeleted'), count: deleted.length },
                    ],
                    value: panelView,
                    onChange: setPanelView,
                  }),
                ),
                update !== null && update.available
                  ? h('section', { className: 'relay-card is-update' },
                    h('div', { className: 'relay-update' },
                      h('span', { className: 'relay-update-text' },
                        t('updateBanner')
                          .replace('{current}', update.currentVersion ?? '?')
                          .replace('{latest}', update.latestVersion ?? '?')),
                      updateNote === null
                        ? null
                        : h('span', { className: 'relay-version' }, updateNote),
                      h('button', {
                        type: 'button',
                        className: 'relay-btn is-primary',
                        disabled: updateBusy,
                        title: t('updateHint'),
                        onClick: () => { void runUpdate() },
                      }, updateBusy ? t('updating') : t('updateNow').replace('{version}', update.latestVersion ?? '')),
                    ),
                  )
                  : null,
                h(DeleteNotice, {
                  notice,
                  busy,
                  onUndo: restoreDeleted,
                  onViewTrash: () => setPanelView('deleted'),
                  onDismiss: () => setNotice(null),
                }),
                panelView === 'deleted'
                  ? h(RecentlyDeleted, {
                    items: deleted,
                    busy,
                    onRestore: restoreDeleted,
                    onPurge: purgeDeleted,
                  })
                  : h(React.Fragment, null,
                error === null ? null : h('div', { className: 'relay-error' }, `${t('failed')}: ${error}`),
                actionError === null ? null : h('div', { className: 'relay-error', role: 'alert' },
                  h('span', { style: { flex: 1, minWidth: 0 } }, `${t('actionFailed')}: ${actionError}`),
                  h('button', { type: 'button', className: 'relay-btn is-small', onClick: () => setActionError(null) }, t('dismiss')),
                ),
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
                chains.length === 0 ? null : h(Kpis, { items: kpis }),
                loading && chains.length === 0 ? h('div', { className: 'relay-text' }, t('loading')) : null,
                !loading && chains.length === 0
                  ? deleted.length > 0
                    ? h(NoLiveChains, { count: deleted.length })
                    : h('section', { className: 'relay-card' }, h(EmptyState))
                  : null,
                chains.length === 0 ? null : h('div', { className: 'relay-split', ref: splitRef },
                  h('section', { className: 'relay-card relay-rail' },
                    h(CardTitle, { sub: String(chains.length) }, t('chains')),
                    h('div', { className: 'relay-rail-tools' },
                      h(Seg, { options: filters, value: filter, onChange: setFilter }),
                      chains.length > 5
                        ? h('input', {
                          className: 'relay-input',
                          type: 'search',
                          value: needle,
                          placeholder: t('filterChains'),
                          'aria-label': t('filterChains'),
                          onChange: event => setNeedle(event.target.value),
                        })
                        : null,
                    ),
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
                    : h(ChainDetail, {
                      key: selectedId,
                      detail,
                      onAct: act,
                      busy,
                      waiting,
                      section,
                      setSection,
                      deleteArmed,
                      setDeleteArmed,
                    }),
                ),
                  ),
              ),
            ),
          )
        }

        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-longtask-relay',
        }, PluginConfigCard))

        // A `link:` bundle has no registry spec, so the page's own update
        // control never appears for it; this puts the update button at the head
        // of its detail page instead, beside the switch and uninstall.
        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
          name: 'plugins.detail.actions',
          id: 'relay-update',
          locale: 'relay',
        }, UpdateAction))

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

        // The launch bar above the composer: the planning head confirms the
        // parallel launch without opening the panel. Renders nothing outside
        // that state, so the composer stays untouched for every other chain.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'relay-launch',
          order: 10,
          locale: 'relay',
        }, ClusterLaunchDock))

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
