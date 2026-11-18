/**
 * Model-facing relay tools.
 *
 * Definitions use raw JSON Schema (the profile cannot resolve `defineTool`),
 * so every parameter is validated in `execute` before the engine sees it.
 * A refused operation returns `{ ok: false, code, message }` instead of
 * throwing, so the model can react without losing the call result.
 */
import { RelayError } from './chain-store.js'

/** Render one JSON value as the tool result text. */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Open object schema accepting any JSON value. */
const ANY_OBJECT = { type: 'object', additionalProperties: true }

/**
 * Turn a thrown failure into a result the model can read.
 * @param {unknown} error - thrown value.
 * @returns {object} refusal result.
 */
function refusal(error) {
  if (error instanceof RelayError) return { ok: false, code: error.code, message: error.message }
  throw error
}

/**
 * Refuse a delegated caller.
 * @param {object|undefined} agent - calling agent.
 * @returns {object|undefined} refusal result, when the caller is a subagent.
 */
function subagentRefusal(agent) {
  const depth = agent?.session?.header?.delegationDepth
  if (typeof depth === 'number' && depth > 0) {
    return { ok: false, code: 'subagent_caller', message: 'A delegated subagent cannot operate a relay chain.' }
  }
  return undefined
}

/**
 * Register the relay tools in the current scope.
 * @param {object} ctx - plugin context (`tools` injected).
 * @param {import('./engine.js').RelayEngine} engine - relay engine.
 * @returns {void}
 */
export function registerTools(ctx, engine) {
  const call = (agent) => {
    const refused = subagentRefusal(agent)
    if (refused !== undefined) return refused
    return undefined
  }

  ctx.tools.register({
    name: 'relay_start',
    description: 'Start a long-running task as a relay chain. The calling session becomes the initializer: it must '
      + 'write the truth source (features.json, PROGRESS.md, HANDOFF.md) and then work one feature at a time. '
      + 'Later sessions are created automatically when this one nears its context limit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        objective: { type: 'string', description: 'The complete task objective, in one paragraph.' },
        cwd: { type: 'string', description: 'Workspace directory; defaults to the session working directory.' },
        maxHandoffs: { type: 'integer', description: 'Handoff cap for this chain; defaults to the plugin setting.' },
      },
      required: ['objective'],
    },
    output: { schema: ANY_OBJECT, render: renderJson },
    execute(args, exec) {
      const refused = call(exec.agent)
      if (refused !== undefined) return refused
      if (exec.agent === undefined) return { ok: false, code: 'no_agent', message: 'relay_start needs a calling agent.' }
      if (typeof args?.objective !== 'string' || args.objective.trim().length === 0) {
        return { ok: false, code: 'invalid_arguments', message: 'objective must be a non-empty string.' }
      }
      if (args.cwd !== undefined && typeof args.cwd !== 'string') {
        return { ok: false, code: 'invalid_arguments', message: 'cwd must be a string.' }
      }
      if (args.maxHandoffs !== undefined && (!Number.isInteger(args.maxHandoffs) || args.maxHandoffs < 1)) {
        return { ok: false, code: 'invalid_arguments', message: 'maxHandoffs must be an integer of at least 1.' }
      }
      try {
        return { ok: true, ...engine.start({
          agent: exec.agent,
          objective: args.objective,
          cwd: args.cwd,
          maxHandoffs: args.maxHandoffs,
        }) }
      } catch (error) {
        return refusal(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Start relay chain', kind: 'other', rawInput: args?.objective }),
  })

  ctx.tools.register({
    name: 'relay_status',
    description: 'Read every relay chain this Host knows about: status, progress, current session, and per-session '
      + 'pressure and compaction counts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chainId: { type: 'string', description: 'Limit the result to one chain.' },
      },
    },
    output: { schema: ANY_OBJECT, render: renderJson },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const refused = call(exec.agent)
      if (refused !== undefined) return refused
      try {
        const chains = engine.status()
        if (typeof args?.chainId === 'string' && args.chainId.length > 0) {
          const found = chains.filter(chain => chain.chainId === args.chainId)
          return { ok: true, chains: found }
        }
        return { ok: true, chains: chains.slice(0, 8), total: chains.length }
      } catch (error) {
        return refusal(error)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Read relay status', kind: 'read' }),
  })

  ctx.tools.register({
    name: 'relay_checkpoint',
    description: 'Record progress on a relay chain. Feature entries cannot be added or renamed; only passes, '
      + 'evidence, and notes change. Call with ready=true once the session is wrapped up and a handoff may proceed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chainId: { type: 'string', description: 'Chain id; defaults to the chain this session belongs to.' },
        features: {
          type: 'array',
          description: 'Field patches for existing features.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              passes: { type: 'boolean' },
              evidence: { type: 'string' },
              notes: { type: 'string' },
            },
            required: ['id'],
          },
        },
        ready: { type: 'boolean', description: 'true when this session finished wrapping up and may be handed off.' },
        blocked: { type: 'boolean', description: 'true when the work cannot continue without a human.' },
        note: { type: 'string', description: 'One line appended to PROGRESS.md; required to explain a blocker.' },
      },
    },
    output: { schema: ANY_OBJECT, render: renderJson },
    execute(args, exec) {
      const refused = call(exec.agent)
      if (refused !== undefined) return refused
      if (args?.features !== undefined && !Array.isArray(args.features)) {
        return { ok: false, code: 'invalid_arguments', message: 'features must be an array.' }
      }
      for (const update of args?.features ?? []) {
        if (update === null || typeof update !== 'object' || typeof update.id !== 'string') {
          return { ok: false, code: 'invalid_arguments', message: 'every feature update needs a string id.' }
        }
      }
      try {
        return { ok: true, ...engine.checkpoint({
          agent: exec.agent,
          chainId: args?.chainId,
          features: args?.features,
          ready: args?.ready,
          blocked: args?.blocked,
          note: args?.note,
        }) }
      } catch (error) {
        return refusal(error)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Record relay progress', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'relay_finish',
    description: 'Mark a relay chain complete. Refused unless every feature in features.json passes; the refusal '
      + 'lists what is still pending.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chainId: { type: 'string', description: 'Chain id; defaults to the chain this session belongs to.' },
        evidence: { type: 'string', description: 'How the whole objective was verified, in one paragraph.' },
      },
      required: ['evidence'],
    },
    output: { schema: ANY_OBJECT, render: renderJson },
    execute(args, exec) {
      const refused = call(exec.agent)
      if (refused !== undefined) return refused
      if (typeof args?.evidence !== 'string' || args.evidence.trim().length === 0) {
        return { ok: false, code: 'invalid_arguments', message: 'evidence must be a non-empty string.' }
      }
      try {
        return engine.finish({ agent: exec.agent, chainId: args.chainId, evidence: args.evidence })
      } catch (error) {
        return refusal(error)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Finish relay chain', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'relay_control',
    description: 'Pause or resume automatic handoff for a relay chain, or hand it off immediately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chainId: { type: 'string', description: 'Chain id; defaults to the chain this session belongs to.' },
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'handoff'],
          description: 'pause stops automatic handoff; resume restarts it; handoff runs one now.',
        },
      },
      required: ['action'],
    },
    output: { schema: ANY_OBJECT, render: renderJson },
    async execute(args, exec) {
      const refused = call(exec.agent)
      if (refused !== undefined) return refused
      const action = args?.action
      try {
        if (action === 'pause') return { ok: true, ...engine.setPaused({ agent: exec.agent, chainId: args.chainId, paused: true }) }
        if (action === 'resume') return { ok: true, ...engine.setPaused({ agent: exec.agent, chainId: args.chainId, paused: false }) }
        if (action === 'handoff') return { ok: true, ...await engine.handoffNow({ agent: exec.agent, chainId: args.chainId }) }
        return { ok: false, code: 'invalid_arguments', message: 'action must be pause, resume, or handoff.' }
      } catch (error) {
        return refusal(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: `Relay ${String(args?.action ?? 'control')}`, kind: 'other' }),
  })
}
