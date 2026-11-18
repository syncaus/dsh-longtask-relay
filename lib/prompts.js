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
 * @returns {{ truthDir: string, features: string, progress: string, handoff: string, decisions: string, traps: string }} absolute paths.
 */
export function truthPaths(paths) {
  return {
    truthDir: paths.truthDir,
    features: join(paths.truthDir, 'features.json'),
    progress: join(paths.truthDir, 'PROGRESS.md'),
    handoff: join(paths.truthDir, 'HANDOFF.md'),
    decisions: join(paths.truthDir, 'decisions.md'),
    traps: join(paths.truthDir, 'traps.md'),
  }
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
    `1. Write ${paths.features} as {"version":1,"objective":"...","statusCheck":"...","verifyFast":"...","verifyFull":"...","features":[...]}.`,
    '   Each feature: {"id":"F001","title":"...","priority":1,"passes":false,"evidence":null,"verify":"<command>","coverage":"full","acceptedBy":null,"notes":""}.',
    '   List every independently verifiable outcome needed to satisfy the objective, ordered by priority.',
    '   Be exhaustive: a later session must never need to invent a feature.',
    '   Coverage is how much a check proves: "full" (end to end), "partial" (only some branches,',
    '   platforms, viewports, or paths), or "smoke" (it answers at all). Be honest here — a feature that',
    '   can only be checked through its refusals is partial, not full.',
    '2. Fill the three project commands once, at the document root. They are whatever this project',
    '   already uses — any language, any runner, no shell assumed:',
    `   - "statusCheck": cross-checks the claims in the truth source against the workspace (route or`,
    '     handler list, test-case list, migration list, generated index — whatever can be parsed).',
    '     It is the anti-drift gate: hand-maintained counts always end up disagreeing with the artifacts.',
    '   - "verifyFast": the check a session can afford at every wrap-up (seconds, not minutes).',
    '   - "verifyFull": the whole suite, run before finishing.',
    '   Reference them from each feature\'s "verify" instead of retyping commands.',
    `3. Fill ${paths.progress} with real content under Done / In progress / Next / Errors / Notes.`,
    `4. Start ${paths.decisions} and ${paths.traps}: append-only ledgers. Decisions that change what is`,
    '   delivered (a skip, an accepted difference, a trade-off) go to decisions.md as',
    '   "what — why — what would make it wrong". Each trap that cost real time goes to traps.md with the',
    '   exact command or syntax that bit.',
    '   If the workspace already keeps its own plan or handoff (HANDOFF.md, docs/plan.md, TODO.md),',
    '   import what still holds into the truth source once, then keep the truth source authoritative —',
    '   two half-updated copies are worse than one.',
    `5. Write ${paths.handoff} for the next session inside a state block:`,
    '   <!-- relay:state -->',
    '   - environment: how to reach the machines, which credential variable holds the secret (name only, never the value)',
    '   - done / next action / verification commands / traps',
    '   <!-- /relay:state -->',
    '   Anything after the block is free-form detail the next session may skip.',
    '6. Commit the truth source if the workspace is a git repository; otherwise record its sha256 in PROGRESS.md.',
    '',
    'Then begin feature 1 only. Rules for the rest of this session:',
    '- Work on one feature at a time; finish it before starting another.',
    '- Mark a feature passing only after its verify command actually passed. Evidence must contain the',
    '  command, its exit code or a count, and enough text to show what ran — "all green" proves nothing.',
    '- Never write a count into the truth source by hand. Quote the command that produced it.',
    '- Never add, remove, or rename an entry in features.json directly; only change',
    '  `passes`, `evidence`, `coverage`, `acceptedBy`, and `notes`. Work you discover later is appended with',
    '  relay_checkpoint `addFeatures` plus a `reason`, so the miss stays visible.',
    `- Update ${paths.progress} before you stop for any reason.`,
    '- When a blocker needs a human (credentials, machine access, a decision only the owner can make),',
    '  record it with relay_checkpoint `blocker` kind=external and say which action clears it. Do not keep',
    '  spending rounds on it.',
    '- Call relay_finish only when every feature passes, each pass carries usable evidence, and any',
    '  partial coverage has been accepted by the human.',
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
    `5. Append to ${paths.traps} every trap that cost real time, with the exact command or syntax.`,
    `6. Rewrite ${paths.handoff} (60 lines or fewer) inside a <!-- relay:state --> block: what you completed,`,
    '   the exact next action, the verification commands, how to reach the environment (credential variable',
    '   names only), and the traps that will bite again.',
    '7. Commit the workspace state if it is a git repository; otherwise record the truth-source sha256 in PROGRESS.md.',
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
 *   handoffNo: number,
 *   previousSessionId: string | null,
 *   truthDir: string,
 * }} input - handoff input.
 * @returns {string} the handoff prompt.
 */
export function renderHandoffPrompt(input) {
  const paths = truthPaths({ truthDir: input.truthDir })
  const features = input.features?.features ?? []
  const pending = features.filter(feature => !feature.passes)
  const done = features.length - pending.length
  const next = pending[0]
  const verify = next?.verify?.trim() || features[0]?.verify?.trim() || '(run the project test command)'
  const statusCheck = input.features?.statusCheck?.trim() || ''
  const verifyFast = input.features?.verifyFast?.trim() || ''
  const summary = stateBlockLines(input.handoff)
  const blocker = input.chain.blocker

  return [
    '<relay_handoff>',
    'You are taking over a long-running task from a previous session.',
    "That session's conversation is NOT yours. Rebuild context from the files below instead of guessing.",
    '',
    `Objective: ${JSON.stringify(input.chain.objective)}`,
    `Chain: ${input.chain.chainId}   Handoff: #${input.handoffNo}   Previous session: ${input.previousSessionId ?? '(none)'}`,
    `Truth directory: ${paths.truthDir}`,
    `Progress: ${done}/${features.length} features passing.`,
    ...(summary.length === 0 ? [] : [`Last handoff state: ${summary.join(' | ')}`]),
    ...(next === undefined ? [] : [`Next feature: ${next.id} — ${next.title}`]),
    ...(blocker === undefined || blocker === null
      ? []
      : [`Known blocker (${blocker.kind}, waits on ${blocker.who}): ${blocker.action || '(no action recorded)'}`]),
    '',
    'Do this first, in order, before any other work:',
    `1. Confirm the working directory is ${input.chain.cwd}.`,
    `2. Read ${paths.handoff} (the relay:state block is the contract), then ${paths.progress}, ${paths.decisions}, ${paths.traps}, then ${paths.features}.`,
    ...(statusCheck === ''
      ? []
      : [
        `3. Run the project's statusCheck (${statusCheck}) and compare it with the truth source: the previous`,
        '   session wrote those numbers as claims, so where they disagree the command is right and the file',
        '   is stale. Fix the file before starting.',
      ]),
    `4. Run the verification command once (${verifyFast || verify || 'as recorded in features.json'}).`,
    '   If it fails, fix that first and record why in PROGRESS.md.',
    '5. Work on the single highest-priority feature whose "passes" is false.',
    '',
    'Rules for this session:',
    '- One feature at a time; mark it passing only after its verify command passed, putting the command and',
    '  its exit code or a count in `evidence`. "All green" is a claim, not evidence.',
    '- Set `coverage` honestly (full / partial / smoke); only the human may accept partial coverage.',
    '- Append discovered work with relay_checkpoint `addFeatures` plus a `reason`; never rewrite the list.',
    `- Update ${paths.progress} before you stop. Earlier narration is not evidence; the files are.`,
    '- Finish with relay_finish once all pass; on a blocker pass blocker={kind:external|code|decision, who, action}',
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
 * }} input - delegation input.
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
    '- Mark a feature passing only after its verify command actually passed, and record the evidence.',
    `- Update ${paths.progress} before you stop for any reason.`,
    '- When all your features pass, call relay_checkpoint with a one-line note saying so.',
    '- If you are blocked, call relay_checkpoint with blocked=true and a concrete blocker.',
    '- Do not start a chain, spawn sessions, or hand off; the parent owns that.',
    '</relay_delegation>',
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
