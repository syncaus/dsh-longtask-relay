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
 * @returns {{ truthDir: string, features: string, progress: string, handoff: string }} absolute paths.
 */
export function truthPaths(paths) {
  return {
    truthDir: paths.truthDir,
    features: join(paths.truthDir, 'features.json'),
    progress: join(paths.truthDir, 'PROGRESS.md'),
    handoff: join(paths.truthDir, 'HANDOFF.md'),
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
    `1. Write ${paths.features} as {"version":1,"objective":"...","features":[...]}.`,
    '   Each feature: {"id":"F001","title":"...","priority":1,"passes":false,"evidence":null,"verify":"<command>","notes":""}.',
    '   List every independently verifiable outcome needed to satisfy the objective, ordered by priority.',
    '   Be exhaustive: a later session must never need to invent a feature.',
    '2. Write the verification command for the project once, and reference it from each feature\'s `verify`.',
    `3. Fill ${paths.progress} with real content under Done / In progress / Next / Errors / Notes.`,
    `4. Write ${paths.handoff} for the next session: what this session intends to complete, and how.`,
    '5. Commit the truth source if the workspace is a git repository.',
    '',
    'Then begin feature 1 only. Rules for the rest of this session:',
    '- Work on one feature at a time; finish it before starting another.',
    '- Mark a feature passing only after its `verify` command actually passed; put the command output in `evidence`.',
    '- Never add, remove, or rename entries in features.json; only change `passes`, `evidence`, and `notes`.',
    `- Update ${paths.progress} before you stop for any reason.`,
    '- Call relay_finish only when every feature passes.',
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
    `2. Rewrite ${paths.progress}: Done / In progress (exactly what remains) / Next (the next feature id) / Errors / Notes.`,
    "3. Run the project's verification command once and record the result in PROGRESS.md.",
    `4. Rewrite ${paths.handoff} (60 lines or fewer) for the next session: what you completed, the exact next action, the verification command, and any trap you hit.`,
    '5. Commit the workspace state if it is a git repository, so the next session starts from a known tree.',
    '6. Do not begin another feature. Do not change the set of features.',
    '7. Then call relay_checkpoint with ready=true and a one-paragraph summary.',
    '</relay_wrapup>',
  ].join('\n')
}

/**
 * First message a new session receives.
 * @param {{
 *   chain: object,
 *   features: { features: Array<object> } | undefined,
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
  const summary = input.handoff
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .slice(0, 3)

  return [
    '<relay_handoff>',
    'You are taking over a long-running task from a previous session.',
    "That session's conversation is NOT yours. Rebuild context from the files below instead of guessing.",
    '',
    `Objective: ${JSON.stringify(input.chain.objective)}`,
    `Chain: ${input.chain.chainId}   Handoff: #${input.handoffNo}   Previous session: ${input.previousSessionId ?? '(none)'}`,
    `Truth directory: ${paths.truthDir}`,
    `Progress: ${done}/${features.length} features passing.`,
    ...(summary.length === 0 ? [] : [`Last handoff note: ${summary.join(' | ')}`]),
    ...(next === undefined ? [] : [`Next feature: ${next.id} — ${next.title}`]),
    '',
    'Do this first, in order, before any other work:',
    `1. Confirm the working directory is ${input.chain.cwd}.`,
    `2. Read ${paths.handoff}, then ${paths.progress}, then ${paths.features}.`,
    `3. Run the project's verification command once (${verify || 'as recorded in features.json'}).`,
    '   If it fails, fix that first and record why in PROGRESS.md.',
    '4. Work on the single highest-priority feature whose "passes" is false.',
    '',
    'Rules for this session:',
    '- One feature at a time. Do not start a second one.',
    '- Mark a feature passing only after its verify command actually passed; record the evidence.',
    '- Never add, remove, or rename entries in features.json; only change `passes`, `evidence`, and `notes`.',
    `- Update ${paths.progress} before you stop for any reason.`,
    '- Treat the workspace and these files as authoritative; earlier narration is not evidence.',
    '- When every feature passes, call relay_finish with evidence.',
    '- If you hit a blocker, call relay_checkpoint with blocked=true and the concrete blocker.',
    '</relay_handoff>',
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
