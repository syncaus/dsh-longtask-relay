/**
 * Model-visible text for the relay lifecycle.
 *
 * Every block is a single `<relay_*>` tag so a session can tell relay input
 * apart from human input, and every path is absolute so the model can read it
 * without guessing the working directory.
 */
import { join } from 'node:path'

/**
 * Absolute paths of one chain's truth source.
 * @param {{ truthDir: string }} paths - chain paths.
 * @returns {{ truthDir: string, features: string, plan: string, spec: string, progress: string, handoff: string, history: string, decisions: string, traps: string }} absolute paths.
 */
export function truthPaths(paths) {
  return {
    truthDir: paths.truthDir,
    features: join(paths.truthDir, 'features.json'),
    plan: join(paths.truthDir, 'PLAN.md'),
    spec: join(paths.truthDir, 'SPEC.md'),
    progress: join(paths.truthDir, 'PROGRESS.md'),
    handoff: join(paths.truthDir, 'HANDOFF.md'),
    history: join(paths.truthDir, 'history.md'),
    decisions: join(paths.truthDir, 'decisions.md'),
    traps: join(paths.truthDir, 'traps.md'),
    review: join(paths.truthDir, 'REVIEW.md'),
  }
}

/**
 * The two lines that describe the features.json schema, shared by the initializer and cluster planning prompts.
 * @param {string} featuresPath - absolute path of features.json.
 * @returns {[string, string]} document line and per-feature line.
 */
function featuresSchemaLines(featuresPath) {
  return [
    `Write ${featuresPath} as {"version":1,"objective":"...","statusCheck":"...","verifyFast":"...","verifyFull":"...","features":[...]}.`,
    'Each feature: {"id":"F001","title":"...","priority":1,"passes":false,"evidence":null,"verify":"<command>","coverage":"full","acceptedBy":null,"notes":""}.',
  ]
}

/** Clip one feature field for the compact pending list in the handoff prompt. */
function clipFeatureText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Instruction for the session that starts a chain.
 * @param {{ truthDir: string, objective: string }} input - chain start input.
 * @returns {string} the initializer prompt.
 */
export function renderInitializerPrompt(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  return [
    '<relay_start>',
    'You are starting a long-running task that will span several sessions.',
    'The session that follows you will have no memory of this conversation, so everything that matters must live in the truth source below.',
    '',
    `Objective: ${JSON.stringify(input.objective)}`,
    `Truth directory: ${paths.truthDir}`,
    '',
    'Do these steps first, in order:',
    `1. Write ${paths.plan}: if this session has a plan that was approved through plan mode, write it there`,
    '   verbatim and derive features.json from it; otherwise write the plan you intend to follow in 40 lines or fewer.',
    ...featuresSchemaLines(paths.features).map((line, index) => (index === 0 ? `2. ${line}` : `   ${line}`)),
    '   List every independently verifiable outcome needed to satisfy the objective, ordered by priority.',
    '   Be exhaustive: a later session must never need to invent a feature.',
    '   Coverage is how much a check proves: "full" (end to end), "partial" (only some branches,',
    '   platforms, viewports, or paths), or "smoke" (it answers at all). Be honest here — a feature that',
    '   can only be checked through its refusals is partial, not full.',
    '3. Fill the three project commands once, at the document root. They are whatever this project',
    '   already uses — any language, any runner, no shell assumed:',
    `   - "statusCheck": cross-checks the claims in the truth source against the workspace (route or`,
    '     handler list, test-case list, migration list, generated index — whatever can be parsed).',
    '     It is the anti-drift gate: hand-maintained counts always end up disagreeing with the artifacts.',
    '   - "verifyFast": the check a session can afford at every wrap-up (seconds, not minutes).',
    '   - "verifyFull": the whole suite, run before finishing.',
    '   Reference them from each feature\'s "verify" instead of retyping commands.',
    `4. Fill ${paths.progress} with real content under Done / In progress / Next / Errors / Notes.`,
    `5. Start ${paths.decisions} and ${paths.traps}: append-only ledgers. Decisions that change what is`,
    '   delivered (a skip, an accepted difference, a trade-off) go to decisions.md as',
    '   "what — why — what would make it wrong". Each trap that cost real time goes to traps.md with the',
    '   exact command or syntax that bit.',
    '   If the workspace already keeps its own plan or handoff (HANDOFF.md, docs/plan.md, TODO.md),',
    '   import what still holds into the truth source once, then keep the truth source authoritative —',
    '   two half-updated copies are worse than one.',
    `6. Write ${paths.handoff} for the next session inside a state block:`,
    '   <!-- relay:state -->',
    '   - environment: how to reach the machines, which credential variable holds the secret (name only, never the value)',
    '   - done / next action / verification commands / traps',
    '   <!-- /relay:state -->',
    '   Anything after the block is free-form detail the next session may skip.',
    `   Earlier briefs are kept automatically in ${paths.history}; later sessions search them with relay_recall.`,
    input.commitTruth === false
      ? '7. Do not commit; record the truth source\'s sha256 in PROGRESS.md.'
      : '7. Commit the truth source if the workspace is a git repository; otherwise record its sha256 in PROGRESS.md.',
    '',
    'Then begin feature 1 only. Rules for the rest of this session:',
    '- Work on one feature at a time; finish it before starting another.',
    '- Give every feature a "verify" command that proves it: relay_checkpoint passes=true makes the plugin run',
    '  that command itself, and the feature only passes when it exits 0. A human approves each command in the',
    '  panel before its first run; until then keep working and retry later. A pass you write into the file is ignored.',
    '- Never write a count into the truth source by hand. Quote the command that produced it.',
    '- The first time relay_checkpoint accepts the list, features.json, PLAN.md, and SPEC.md are sealed. After',
    '  that, every change goes through relay_checkpoint (passes, notes, coverage, a missing verify, addFeatures',
    '  with a `reason`). A hand edit of a sealed file freezes the chain until a human restores or adopts it.',
    `- Update ${paths.progress} before you stop for any reason.`,
    '- When a blocker needs a human (credentials, machine access, a decision only the owner can make),',
    '  record it with relay_checkpoint `blocker` kind=external and say which action clears it. Do not keep',
    '  spending rounds on it.',
    '- Call relay_finish only when every feature passes and a human has accepted any partial coverage in the',
    '  panel. Finishing re-runs every verify command, then a fresh read-only session reviews the delivery against',
    '  SPEC.md and PLAN.md, then a human confirms it; the chain is done only after that confirmation.',
    '</relay_start>',
  ].join('\n')
}

/**
 * Instruction injected when the session nears its context limit.
 * @param {{ truthDir: string, featuresTotal: number, featuresDone: number }} input - wrap-up input.
 * @returns {string} the wrap-up prompt.
 */
export function renderWrapupPrompt(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  return [
    '<relay_wrapup>',
    'This session is nearing its context limit and will be handed off to a fresh session.',
    `Progress so far: ${input.featuresDone}/${input.featuresTotal} features passing.`,
    '',
    'Before the handoff, do exactly this and do not start new work:',
    '1. Finish the feature you are on, or stop at a clean boundary and record what remains.',
    `2. Run the project's statusCheck and verifyFast commands once and paste the tail of both outputs`,
    `   (the counts and the failure lines, not the whole log) into ${paths.progress}. If a count in the`,
    '   truth source disagrees with statusCheck, fix the truth source — the command wins, the prose is wrong.',
    `3. Rewrite ${paths.progress}: Done / In progress (exactly what remains) / Next (the next feature id) / Errors / Notes.`,
    `4. Append to ${paths.decisions} every decision this session made that the next one must not silently undo`,
    '   (a skipped item, an accepted difference, a trade-off), as "what — why — what would make it wrong".',
    `   ${paths.plan} is sealed: propose a change in decisions.md; only a human changes the plan.`,
    `5. Append to ${paths.traps} every trap that cost real time, with the exact command or syntax.`,
    `6. Rewrite ${paths.handoff} (60 lines or fewer) inside a <!-- relay:state --> block: what you completed,`,
    '   the exact next action, the verification commands, how to reach the environment (credential variable',
    '   names only), and the traps that will bite again.',
    `   The plugin appends this brief to ${paths.history} automatically; earlier briefs stay searchable with relay_recall.`,
    input.commitTruth === false
      ? '7. Do not commit; record the truth-source sha256 in PROGRESS.md.'
      : '7. Commit the workspace state if it is a git repository; otherwise record the truth-source sha256 in PROGRESS.md.',
    '8. Do not begin another feature. Do not change the set of features except by appending discovered work.',
    '9. Then call relay_checkpoint with ready=true and a one-paragraph summary.',
    '</relay_wrapup>',
  ].join('\n')
}

/**
 * Extract the state block a handoff keeps at the top of HANDOFF.md.
 * The block is the contract; headings and prose around it are for humans and
 * are skipped, so a tidy-but-empty heading cannot become the "last note".
 * @param {string} handoff - HANDOFF.md contents.
 * @returns {Array<string>} up to three non-empty lines from the block.
 */
export function stateBlockLines(handoff) {
  const match = /<!--\s*relay:state\s*-->([\s\S]*?)<!--\s*\/relay:state\s*-->/.exec(handoff)
  const source = match === null ? handoff : match[1]
  return source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .filter(line => !line.startsWith('<!--'))
    .slice(0, 3)
}

/**
 * First message a new session receives.
 * @param {{
 *   chain: object,
 *   features: { features: Array<object>, statusCheck?: string, verifyFast?: string } | undefined,
 *   handoff: string,
 *   historyEntries?: number,
 *   handoffNo: number,
 *   previousSessionId: string | null,
 *   truthDir: string,
 * }} input - handoff input.
 * @returns {string} the handoff prompt.
 */
export function renderHandoffPrompt(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  const features = input.features?.features ?? []
  const pending = features.filter(feature => !feature.passes && (feature.assignedSessionId === null || feature.assignedSessionId === undefined))
  const done = features.filter(feature => feature.passes).length
  const orderedPending = pending
    .slice()
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
  const next = orderedPending[0]
  // Unfinished work a spawned child owns still matters to the new head: it has to
  // verify those reports and must not duplicate the work. The id and owner are
  // enough; the child runs its own verify command.
  const delegatedOpen = features.filter(feature => !feature.passes
    && typeof feature.assignedSessionId === 'string' && feature.assignedSessionId.length > 0)
  const delegatedLine = delegatedOpen.length === 0
    ? null
    : `Delegated unfinished: ${delegatedOpen.slice(0, 12).map(feature => `${feature.id} (${feature.assignedSessionId})`).join(', ')}${delegatedOpen.length > 12 ? `; ${delegatedOpen.length - 12} more` : ''}`
  // A compact list of what is left: the successor can start from it instead of
  // reading a features.json that grows with every evidence block.
  const pendingLines = orderedPending.slice(0, 12).map((feature) => {
    const parts = [`- ${feature.id} — ${clipFeatureText(feature.title, 80)}`]
    if (typeof feature.verify === 'string' && feature.verify.trim().length > 0) {
      // The feature this session starts with keeps its command whole; the rest
      // are clipped, and features.json remains the full record.
      parts.push(`verify: ${clipFeatureText(feature.verify, feature === next ? 400 : 160)}`)
    }
    if (Array.isArray(feature.files) && feature.files.length > 0) {
      parts.push(`files: ${feature.files.slice(0, 2).map(file => clipFeatureText(file, 80)).join(', ')}`)
    }
    if (Array.isArray(feature.dependsOn) && feature.dependsOn.length > 0) {
      parts.push(`deps: ${feature.dependsOn.join(', ')}`)
    }
    return parts.join(' · ')
  })
  if (orderedPending.length > 12) {
    pendingLines.push(`- ... ${orderedPending.length - 12} more; see ${paths.features}.`)
  }
  const verify = next?.verify?.trim() || features[0]?.verify?.trim() || '(run the project test command)'
  const statusCheck = input.features?.statusCheck?.trim() || ''
  const verifyFast = input.features?.verifyFast?.trim() || ''
  const summary = stateBlockLines(input.handoff)
  const blocker = input.chain.blocker
  const cluster = input.chain.mode === 'cluster'
  const workers = cluster
    ? (input.chain.sessions ?? []).filter(session => typeof session.parentSessionId === 'string'
      && session.sessionId !== input.previousSessionId)
    : []
  const workerLines = workers.map((worker) => {
    const mine = features.filter(feature => feature.assignedSessionId === worker.sessionId)
    const open = mine.filter(feature => !feature.passes)
    const passed = mine.length - open.length
    return `- ${worker.sessionId}: ${passed}/${mine.length} passed${open.length === 0 ? '' : `; unfinished: ${open.map(feature => feature.id).join(', ')}`}`
  })
  if (workers.length > 8) workerLines.push(`- ... and ${workers.length - 8} more worker sessions; see relay_status or the panel.`)

  const steps = [
    `Confirm the working directory is ${input.chain.cwd}.`,
    `Read ${paths.handoff}'s relay:state block (the contract), then the last ~80 lines of ${paths.progress}. Use relay_recall for ${paths.decisions}/${paths.traps}/${paths.history}; do not read them in full. Read ${paths.plan} or ${paths.features} only if needed.`,
    ...(statusCheck === ''
      ? []
      : [
        `Run the project's statusCheck (${statusCheck}) and compare it with the truth source: the previous\n`
        + '   session wrote those numbers as claims, so where they disagree the command is right and the file\n'
        + '   is stale. Fix the file before starting.',
      ]),
    `Run the verification command once (${verifyFast || verify || 'as recorded in features.json'}).\n`
    + '   If it fails, fix that first and record why in PROGRESS.md.',
    cluster
      ? 'Work on the single highest-priority feature whose "passes" is false and that has no assignedSessionId; the workers own theirs.'
      : 'Work on the single highest-priority feature whose "passes" is false.',
  ]

  return [
    '<relay_handoff>',
    'You are taking over a long-running task from a previous session.',
    "That session's conversation is NOT yours. Rebuild context from the files below instead of guessing.",
    ...(input.stale === true
      ? ['WARNING: the previous HANDOFF.md is stale or missing; treat PROGRESS.md, features.json, and git state as authoritative.']
      : []),
    '',
    `Objective: ${JSON.stringify(input.chain.objective)}`,
    `Chain: ${input.chain.chainId}   Handoff: #${input.handoffNo}   Previous session: ${input.previousSessionId ?? '(none)'}`,
    `Truth directory: ${paths.truthDir}`,
    `Progress: ${done}/${features.length} features passing.`,
    ...(summary.length === 0 ? [] : [`Last handoff state: ${summary.join(' | ')}`]),
    ...(typeof input.historyEntries === 'number' && input.historyEntries > 0
      ? [`Earlier handoffs: ${input.historyEntries} record(s) in ${paths.history}; search it with relay_recall before reading it in full.`]
      : []),
    ...(next === undefined ? [] : [`Next feature: ${next.id} — ${next.title}`]),
    ...(cluster && next === undefined
      ? ['No unassigned feature is left: the remaining work belongs to the workers. Verify their reports and finish when they are done.']
      : []),
    ...(pendingLines.length === 0
      ? []
      : [
        '',
        `Pending features (${orderedPending.length}; ${paths.features} is the full record):`,
        ...pendingLines,
      ]),
    ...(cluster || delegatedLine === null ? [] : ['', delegatedLine]),
    ...(blocker === undefined || blocker === null
      ? []
      : [`Known blocker (${blocker.kind}, waits on ${blocker.who}): ${blocker.action || '(no action recorded)'}`]),
    ...(cluster
      ? [
        '',
        'Cluster chain: this head planned a parallel launch; the workers below keep running on their own.',
        ...(workerLines.length === 0
          ? ['No worker session is recorded yet; check the panel before delegating again.']
          : ['Worker sessions:', ...workerLines]),
        '',
        'Cluster rules:',
        '- Your own work is the features with no assignedSessionId; never duplicate a feature a worker owns.',
        '- A worker\'s pass was verified by the plugin running its verify command; you still own whether the change',
        '  fits the plan. A passing report wakes you, a progress-only checkpoint does not; check relay_status,',
        '  features.json, or the panel\'s downstream tab before stopping.',
        '- A stuck worker can be reclaimed with relay_control (reclaim); its unfinished features come back to you.',
      ]
      : []),
    '',
    'Do this first, in order, before any other work:',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    'Rules for this session:',
    '- One feature at a time. passes=true makes the plugin run its verify command; exit 0 passes.',
    '- features.json, PLAN.md, SPEC.md are sealed; never hand-edit them.',
    '- Set `coverage` honestly (full / partial / smoke); only a human can accept partial coverage, from the panel.',
    '- Append discovered work with relay_checkpoint `addFeatures` plus a `reason`; never rewrite the list.',
    `- Update ${paths.progress} before you stop. Earlier narration is not evidence; the files are.`,
    '- relay_finish once all pass (re-verify, review, human sign-off follow); on a blocker pass blocker={kind:external|code|decision, who, action}',
    '  (kind=external pauses the chain until a human unblocks it).',
    '</relay_handoff>',
  ].join('\n')
}

/**
 * First message a delegated child session receives.
 * @param {{
 *   chain: object,
 *   truthDir: string,
 *   parentSessionId: string,
 *   features: Array<object>,
 *   note: string,
 *   cluster?: boolean,
 * }} input - delegation input; `cluster` lets the worker use the host's subagent tools.
 * @returns {string} the delegation prompt.
 */
export function renderDelegationPrompt(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  return [
    '<relay_delegation>',
    'You are a delegated worker in a long-running relay chain. A parent session handed you part of the work.',
    '',
    `Objective: ${JSON.stringify(input.chain.objective)}`,
    `Chain: ${input.chain.chainId}   Parent session: ${input.parentSessionId}`,
    `Truth directory: ${paths.truthDir}`,
    '',
    'You own these features:',
    ...input.features.map(feature => `- ${feature.id} — ${feature.title}${feature.verify ? `  (verify: ${feature.verify})` : ''}`),
    ...(input.note.trim().length === 0 ? [] : ['', `Parent note: ${input.note.trim()}`]),
    '',
    'Do this first, in order:',
    `1. Read ${paths.handoff}, ${paths.progress}, and ${paths.features}.`,
    '2. Run the project verification command once so you start from a known state.',
    '3. Work on one of YOUR features at a time.',
    '',
    'Rules for this session:',
    '- Only work on the features listed above. Never take another session\'s feature.',
    '- Never add, remove, rename, or reassign features; that belongs to the parent.',
    '- relay_checkpoint passes=true makes the plugin run the feature\'s verify command; it passes only on exit 0.',
    '  Never edit features.json, PLAN.md, or SPEC.md by hand: they are sealed.',
    `- Update ${paths.progress} before you stop for any reason.`,
    '- When all your features pass, call relay_checkpoint with a one-line note saying so.',
    `- Record every trap that cost you real time in ${paths.traps} and any judgement the whole chain must keep in ${paths.decisions}; the parent and the next session only see the files.`,
    '- If you are blocked, call relay_checkpoint with blocked=true and a concrete blocker.',
    input.cluster === true
      ? '- Do not start a chain, call relay_spawn, or hand off. You MAY split your own features across the host\'s subagent tools; you stay responsible for verifying and reporting their results.'
      : '- Do not start a chain, spawn sessions, or hand off; the parent owns that.',
    '</relay_delegation>',
  ].join('\n')
}

/**
 * First message of a cluster chain: plan with the human, then propose a parallel launch.
 * @param {{ truthDir: string, objective: string, maxSessions: number }} input - planning input.
 * @returns {string} the planning prompt.
 */
export function renderClusterPlanningPrompt(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  return [
    '<relay_cluster_planning>',
    'This is the planning half of a cluster: several sessions will later work the plan in parallel, once a human confirms the launch.',
    `Objective: ${JSON.stringify(input.objective)}`,
    `Truth directory: ${paths.truthDir}`,
    '',
    'In order:',
    '1. Talk the requirements through with the human first. Do not edit project code in this phase.',
    '2. When the plan is ready, present it through exit_plan_mode and wait for approval (if plan mode is not active, ask the human to confirm the plan in chat).',
    `3. After approval write ${paths.spec} (requirements and acceptance criteria), ${paths.plan} (the approved plan verbatim) and features.json.`,
    ...featuresSchemaLines(paths.features).map(line => `   ${line}`),
    '   Add per feature "files": ["path/or/dir", ...] (what it will change, as path prefixes) and "dependsOn": ["F001"].',
    `4. Fill ${paths.progress} (Done / Next) and the state block of ${paths.handoff} with one line each.`,
    `5. Call relay_propose with at most ${input.maxSessions} groups, each {title, features, isolation, reason}:`,
    '   - features whose "files" do not overlap may go to different "shared" groups;',
    '   - overlapping files, or features that each need the full test suite, get "worktree";',
    '   - dependent features go in the same group, in order; a dependency between two different groups is refused;',
    '   - a feature other groups depend on sits in the same group as its dependents, or in no group: then this session does it',
    '     first after the launch and the groups waiting for it open automatically once it passes;',
    '   - features left out of every group stay with this session;',
    '   - every group needs a one-sentence reason.',
    '6. Then stop and wait: a human confirms the launch in the launch bar above the composer, in the panel, or with /relay launch. Do not call relay_spawn.',
    '</relay_cluster_planning>',
  ].join('\n')
}

/**
 * Supervision notice for the planning session once a human launched the cluster.
 * @param {{
 *   chainId: string,
 *   truthDir: string,
 *   groups: Array<{ id: string, launched: boolean, sessionId?: string, features: Array<string> }>,
 *   kept: Array<{ id: string, why: string }>,
 * }} input - launch result.
 * @returns {string} the notice text.
 */
export function renderClusterLaunchedNotice(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  const launched = input.groups.filter(group => group.launched)
  const waiting = input.groups.filter(group => group.waiting === true)
  return [
    '<relay_cluster_launched>',
    `A human confirmed the launch of chain ${input.chainId}. Truth directory: ${paths.truthDir}`,
    launched.length === 0 ? 'No worker session was launched.' : 'Launched worker sessions:',
    ...launched.map(group => `- ${group.sessionId} (group ${group.id}): ${group.features.join(', ')}`),
    ...(waiting.length === 0
      ? []
      : [
        'Groups waiting for features you keep:',
        ...waiting.map(group => `- group ${group.id} (${group.features.join(', ')}) waits for ${group.waitsFor.join(', ')}; it is opened automatically once they pass, so do those features first.`),
      ]),
    input.kept.length === 0
      ? 'Every feature went to a worker.'
      : 'Features you keep, with the reason:',
    ...input.kept.map(item => `- ${item.id}: ${item.why}`),
    '',
    'Rules:',
    '- Work your own features one at a time.',
    '- A worker\'s pass was verified by the plugin running its verify command; check that the change fits the plan.',
    '- Call relay_finish only when every feature passes; an independent review and a human confirmation follow.',
    '</relay_cluster_launched>',
  ].join('\n')
}

/**
 * First message of the independent review session.
 * @param {{
 *   chain: object,
 *   truthDir: string,
 *   round: number,
 *   baseCommit: string|null,
 *   features: Array<{ id: string, title: string, verify?: string, files?: Array<string> }>,
 * }} input - review input.
 * @returns {string} the review prompt.
 */
export function renderReviewPrompt(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  const diff = input.baseCommit === null
    ? 'The chain start commit is unknown: compare the workspace against SPEC.md and PLAN.md directly.'
    : `The chain started at commit ${input.baseCommit}: read \`git diff ${input.baseCommit}\` (and \`git log ${input.baseCommit}..\`) for what was delivered.`
  return [
    '<relay_review>',
    `You are the independent reviewer of relay chain ${input.chain.chainId} (review round ${input.round}).`,
    'You did not write this code. Check that what was delivered matches the design, not that the tests are green:',
    'the plugin already ran every verify command and they exit 0.',
    '',
    `Objective: ${JSON.stringify(input.chain.objective)}`,
    `Design: ${paths.spec} (requirements and acceptance criteria, when present) and ${paths.plan}; both were sealed when the`,
    '  feature list was frozen, so they are the design as approved, not as rewritten later.',
    `Decisions the implementers recorded: ${paths.decisions}.`,
    diff,
    '',
    'Features to judge:',
    ...input.features.map(feature => `- ${feature.id} — ${feature.title}${feature.files?.length ? ` (files: ${feature.files.slice(0, 3).join(', ')})` : ''}`),
    '',
    'For every feature decide:',
    '- match: the delivered code does what the design asks for this feature;',
    '- mismatch: it was built differently from the design (name what differs and where);',
    '- missing: the code for it is absent or only stubbed.',
    'Also list every requirement in the design that no feature covers.',
    '',
    'Rules:',
    '- Read only. Do not edit files, commit, or run commands that change the workspace.',
    '- Judge from the code and the design, not from PROGRESS.md or HANDOFF.md: those are the implementers\' claims.',
    '- decisions.md is the implementers\' own record, not the design. A deviation written there is still a mismatch:',
    '  name it, quote the decision, and let the human weigh it. Only SPEC.md and PLAN.md define what was asked.',
    '- Every mismatch or missing verdict needs concrete findings with file paths.',
    '- Finish by calling relay_review once with a verdict for every feature, the uncovered requirements, and a summary.',
    '</relay_review>',
  ].join('\n')
}

/**
 * Notice to the chain head when the review or the human sent the chain back.
 * @param {{
 *   chainId: string,
 *   truthDir: string,
 *   by: 'review'|'human',
 *   round?: number,
 *   reopened: Array<{ id: string, verdict?: string, findings?: string }>,
 *   uncovered: Array<string>,
 *   reason?: string,
 * }} input - outcome.
 * @returns {string} the notice text.
 */
export function renderReviewOutcomeNotice(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  return [
    '<relay_review_outcome>',
    input.by === 'review'
      ? `The independent review (round ${input.round}) of chain ${input.chainId} did not accept the delivery.`
      : `A human rejected the delivery of chain ${input.chainId}.`,
    ...(typeof input.reason === 'string' && input.reason.length > 0 ? [`Reason: ${input.reason}`] : []),
    ...(input.reopened.length === 0
      ? []
      : ['Reopened features:', ...input.reopened.map(item => `- ${item.id}${item.verdict ? ` (${item.verdict})` : ''}${item.findings ? `: ${item.findings}` : ''}`)]),
    ...(input.uncovered.length === 0
      ? []
      : ['Requirements no feature covers (append them with relay_checkpoint addFeatures and a reason):', ...input.uncovered.map(item => `- ${item}`)]),
    '',
    `The findings are in ${paths.review} and in each feature's notes. Fix them one feature at a time, mark them`,
    'passing again through relay_checkpoint, then call relay_finish.',
    '</relay_review_outcome>',
  ].join('\n')
}

/**
 * Notice left in the session that handed off.
 * @param {{ chainId: string, newSessionId: string, handoffNo: number }} input - retirement input.
 * @returns {string} the notice text.
 */
export function renderRetireNotice(input) {
  return [
    '<relay_retired>',
    `This session handed chain ${input.chainId} to session ${input.newSessionId} (handoff #${input.handoffNo}).`,
    'Do not continue the objective here: automatic continuation has stopped and the chain now follows the new session.',
    'Answer the human if they talk to you, but do not resume the task on your own.',
    '</relay_retired>',
  ].join('\n')
}

/**
 * Nudge for an idle chain head: continue with the next unassigned feature.
 * @param {{ truthDir: string, feature: object, done: number, total: number }} input - continue input.
 * @returns {string} the continue prompt.
 */
export function renderContinuePrompt(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  return [
    '<relay_continue>',
    `The chain is still active (${input.done}/${input.total} features passing) and you are the current session.`,
    `Continue with ${input.feature.id} — ${input.feature.title}.`,
    `Read ${paths.progress} and ${paths.handoff} first, work only this feature, and record its evidence before stopping.`,
    '</relay_continue>',
  ].join('\n')
}

/**
 * Ask a delegated worker to close its phase and hand its unfinished features back.
 * @param {{ truthDir: string, features: Array<object> }} input - worker wrap-up input.
 * @returns {string} the worker wrap-up prompt.
 */
export function renderWorkerWrapupPrompt(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  return [
    '<relay_worker_wrapup>',
    'Your context is nearly full, so this worker session is closing.',
    `Unfinished features were returned to the chain: ${input.features.map(feature => feature.id).join(', ')}.`,
    'Do not start anything new. Do exactly this:',
    `1. Write what you learned into ${paths.progress} (what is done, what remains, and the exact next command).`,
    `2. Append traps that cost you time to ${paths.traps}, with the command or syntax that bit.`,
    '3. Stop. The parent session will pick the features up again.',
    '</relay_worker_wrapup>',
  ].join('\n')
}

/**
 * Short notice for the planning session when waiting groups were opened later.
 * @param {{ chainId: string, groups: Array<{ id: string, sessionId: string, features: Array<string> }> }} input - opened groups.
 * @returns {string} the notice text.
 */
export function renderClusterGroupOpenedNotice(input) {
  return [
    '<relay_cluster_group_opened>',
    `Chain ${input.chainId}: their dependencies now pass, so waiting groups were opened:`,
    ...input.groups.map(group => `- ${group.sessionId} (group ${group.id}): ${group.features.join(', ')}`),
    'Treat their reports like the other workers\': the plugin verified each pass; check that the change fits the plan.',
    '</relay_cluster_group_opened>',
  ].join('\n')
}

/**
 * Notice to a cluster head when a worker got features passing.
 * It only points at the report: the head still re-runs the verify commands.
 * @param {{
 *   chainId: string,
 *   truthDir: string,
 *   workerSessionId: string,
 *   passed: Array<{ id: string, title?: string, coverage?: string|null }>,
 *   remaining: Array<string>,
 *   total: number,
 * }} input - worker report.
 * @returns {string} the notice text.
 */
export function renderWorkerReportNotice(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  const passed = input.passed ?? []
  const remaining = input.remaining ?? []
  return [
    '<relay_worker_report>',
    `Worker ${input.workerSessionId} reports features passing in chain ${input.chainId}:`,
    ...passed.map(feature => `- ${feature.id}${feature.title ? ` — ${feature.title}` : ''}${feature.coverage ? ` (coverage ${feature.coverage})` : ''}`),
    remaining.length === 0
      ? 'That worker has no unfinished features left.'
      : `Its unfinished features: ${remaining.join(', ')} (${input.total - remaining.length}/${input.total} passed).`,
    '',
    'The plugin ran each feature\'s verify command before accepting the pass; check that the change fits the plan.',
    `Check the other workers with relay_status, ${paths.features}, or the panel's downstream tab.`,
    '</relay_worker_report>',
  ].join('\n')
}

/**
 * Notice for a worker whose delegated features were taken back by the parent.
 * @param {{ chainId: string, features: Array<string> }} input - reclaim input.
 * @returns {string} the reclaim notice.
 */
export function renderReclaimNotice(input) {
  return [
    '<relay_reclaimed>',
    `The chain ${input.chainId} took back these features: ${input.features.join(', ')}.`,
    'Stop working on them; write anything the next session needs into PROGRESS.md and traps.md, then stop.',
    '</relay_reclaimed>',
  ].join('\n')
}
