/**
 * `/relay` slash command.
 *
 * The panel and the model tools cover most workflows; this gives the human a
 * one-line entry point from the composer: start a chain, inspect it, pause,
 * resume, or hand off without sending the line to the model.
 */
import { RelayError } from './chain-store.js'

const USAGE = 'Usage: /relay [start <objective> | cluster <objective> | launch | status | pause | resume | handoff]'

/**
 * Execute one `/relay` invocation.
 * @param {object} engine - relay engine.
 * @param {object} invocation - command invocation (agent + raw input).
 * @returns {Promise<{kind: 'success'|'error', text: string}>} command result.
 */
export async function handleRelayCommand(engine, invocation) {
  const raw = invocation.rawInput.trim()
  const words = raw.split(/\s+/).filter(Boolean)
  const sub = words.length === 0 ? 'status' : words[0]
  const argument = words.slice(1).join(' ')
  try {
    if (sub === 'status') {
      const chains = engine.status()
      const view = engine.sessionView(invocation.agent.session.id)
      const lines = chains.map(chain => `- ${chain.chainId} ${chain.title} — ${chain.status}, `
        + `${chain.featuresDone}/${chain.featuresTotal} features, handoff ${chain.handoffCount}/${chain.maxHandoffs}`
        // A head inside one long command stays `active` and writes nothing;
        // saying so is the difference between "working" and "stuck".
        + (chain.stall === null || chain.stall === undefined ? '' : `, running ${chain.stall.minutes} min without progress`)
        // Another chain in the same workspace building the same paths: the
        // session cannot pause it, so the status line names it for the human.
        + (Array.isArray(chain.conflicts) && chain.conflicts.length > 0
          ? `, conflicts with ${chain.conflicts.map(entry => `${entry.chainId} on ${entry.paths.length} paths`).join('; ')}`
          : '')
        // An idle head with a live background job is not an idle chain.
        + (chain.jobs === null || chain.jobs === undefined
          ? ''
          : `, ${chain.jobs.running} background job(s) running: ${chain.jobs.labels.join(' | ')}`))
      const mine = view === undefined || view.chain === null
        ? 'This session is not in a chain.'
        : `This session belongs to ${view.chain.chainId} (${view.chain.status}).`
      return {
        kind: 'success',
        text: [
          chains.length === 0 ? 'No relay chains yet.' : `Relay chains (${chains.length}):`,
          ...lines,
          '',
          mine,
          USAGE,
        ].join('\n'),
      }
    }
    if (sub === 'start') {
      if (argument.length === 0) return { kind: 'error', text: `An objective is required.\n${USAGE}` }
      const chain = engine.start({ agent: invocation.agent, objective: argument })
      return {
        kind: 'success',
        text: `Started ${chain.chainId}.\nThe initialization prompt was sent to this session: write the truth source, then checkpoint.`,
      }
    }
    if (sub === 'cluster') {
      if (argument.length === 0) return { kind: 'error', text: `An objective is required.\n${USAGE}` }
      const chain = engine.startCluster({ agent: invocation.agent, objective: argument })
      return {
        kind: 'success',
        text: `Started cluster ${chain.chainId}.\nThe planning prompt was sent to this session: plan with it, then confirm the launch in the panel or with /relay launch.`,
      }
    }
    const membership = engine.locate(invocation.agent.session)
    if (membership === undefined) return { kind: 'error', text: 'This session is not in a chain. Use /relay start <objective> first.' }
    const chainId = membership.chain.chainId
    // These act as the human, like the panel buttons: no agent is passed, so the goal
    // pauses with the chain, the audit actor is the host, and a worker session is not refused.
    if (sub === 'pause') {
      engine.setPaused({ chainId, paused: true })
      return { kind: 'success', text: `Paused ${chainId}.` }
    }
    if (sub === 'resume') {
      const { status } = engine.setPaused({ chainId, paused: false })
      if (status !== 'active') return { kind: 'error', text: `${chainId} is still ${status}.` }
      return { kind: 'success', text: `Resumed ${chainId}.` }
    }
    if (sub === 'launch') {
      const { results } = await engine.launchCluster({ chainId })
      const lines = results.map(result => (result.launched
        ? `- ${result.id}: session ${result.sessionId}`
        : `- ${result.id}: not launched — ${result.reason}`))
      return { kind: 'success', text: `Launched ${chainId}:\n${lines.join('\n')}` }
    }
    if (sub === 'handoff') {
      const result = await engine.handoffNow({ chainId })
      if (result.ok === false) {
        return { kind: 'error', text: `${result.code ?? 'handoff refused'}: ${result.message ?? 'try again when the session is idle'}` }
      }
      return { kind: 'success', text: `Handed off ${chainId} to ${result.newSessionId} (handoff #${result.handoffNo}).` }
    }
    return { kind: 'error', text: `Unknown sub-command "${sub}".\n${USAGE}` }
  } catch (error) {
    if (error instanceof RelayError) return { kind: 'error', text: `${error.message}\n${USAGE}` }
    throw error
  }
}
