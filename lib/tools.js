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
 * Check that recorded evidence can actually prove a pass.
 * "all green" is a claim: a usable record carries the command and a result — an exit
 * code, a pass/fail count, or a ratio — and enough text that a later session can tell
 * what ran. The marker list spans common toolchains and both languages the prompts use,
 * so the rule does not assume one test runner.
 * @param {unknown} evidence - recorded evidence text.
 * @param {{ requireStrong?: boolean }} [options] - set requireStrong false to only check length and a number.
 * @returns {string|undefined} an issue message, or undefined when the record is usable.
 */
function evidenceIssue(evidence, options = {}) {
  const requireStrong = options.requireStrong !== false
  if (typeof evidence !== 'string') return 'a passing feature needs evidence text'
  const text = evidence.trim()
  if (text.length < 8) return 'evidence is too short to prove anything'
  // Only the strong policy demands machine-shaped output, so a project whose checks
  // produce prose (a design review, a manual sign-off) can turn that off entirely.
  if (!requireStrong) return undefined
  if (!/[0-9]/.test(text)) return 'evidence must contain at least one number (a count, a case total, or an exit code)'
  if (/\d+\s*\/\s*\d+/.test(text)) return undefined
  const lower = text.toLowerCase()
  const markers = [
    'exit', 'pass', 'fail', 'ok', 'success', 'error', 'skip', 'test', 'check',
    'diff', 'identical', 'match', 'result', 'build',
    '通过', '失败', '错误', '成功', '跳过', '测试', '覆盖', '差异',
  ]
  if (markers.some(marker => lower.includes(marker))) return undefined
  return 'evidence must include the result, such as "exit 0", "12/12 passed", or "BUILD SUCCESS"'
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
    description: 'Record progress on a relay chain. Existing entries keep their id and title; only passes, '
      + 'evidence, coverage, acceptedBy, and notes change. Work discovered after initialization is appended with '
      + 'addFeatures plus a reason, never by rewriting the list. Call with ready=true once the session is wrapped '
      + 'up and a handoff may proceed.',
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
              evidence: { type: 'string', description: 'Command output proving the pass: the command, its exit code, and at least one count.' },
              notes: { type: 'string' },
              coverage: {
                type: 'string',
                enum: ['full', 'partial', 'smoke'],
                description: 'How much of the behaviour was actually verified: full = end to end, '
                  + 'partial = only some branches/platforms/paths, smoke = it answers at all.',
              },
              acceptedBy: {
                type: 'string',
                description: 'Set to "human" when a person accepted partial coverage for this feature.',
              },
            },
            required: ['id'],
          },
        },
        addFeatures: {
          type: 'array',
          description: 'Work discovered after initialization. Appended only; ids may not repeat.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              priority: { type: 'integer' },
              verify: { type: 'string' },
              coverage: { type: 'string', enum: ['full', 'partial', 'smoke'] },
              notes: { type: 'string' },
            },
            required: ['id', 'title'],
          },
        },
        reason: {
          type: 'string',
          description: 'Why these features were missing at initialization; required with addFeatures and appended to PROGRESS.md.',
        },
        blocker: {
          type: 'object',
          description: 'Current blocker, or null to clear it. kind=external pauses the chain until a human unblocks it.',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['external', 'code', 'decision'] },
            who: { type: 'string', description: 'Who must act: human or model.' },
            action: { type: 'string', description: 'The concrete action that clears the blocker.' },
          },
          required: ['kind'],
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
        if (update.passes === true) {
          const issue = evidenceIssue(update.evidence, {
            requireStrong: engine.config?.requireStrongEvidence !== false,
          })
          if (issue !== undefined) {
            return { ok: false, code: 'evidence_too_weak', message: `${update.id}: ${issue}` }
          }
        }
      }
      if (args?.addFeatures !== undefined) {
        if (!Array.isArray(args.addFeatures) || args.addFeatures.length === 0) {
          return { ok: false, code: 'invalid_arguments', message: 'addFeatures must be a non-empty array.' }
        }
        if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
          return { ok: false, code: 'missing_reason', message: 'addFeatures needs a reason explaining why the initializer missed this work.' }
        }
        for (const entry of args.addFeatures) {
          if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.title !== 'string') {
            return { ok: false, code: 'invalid_arguments', message: 'every new feature needs a string id and title.' }
          }
        }
      }
      const blocker = args?.blocker === null || args?.blocker === undefined ? args?.blocker : args.blocker
      if (blocker !== undefined && blocker !== null) {
        if (typeof blocker !== 'object' || typeof blocker.kind !== 'string') {
          return { ok: false, code: 'invalid_arguments', message: 'blocker needs a kind.' }
        }
        if (!['external', 'code', 'decision'].includes(blocker.kind)) {
          return { ok: false, code: 'invalid_arguments', message: 'blocker.kind must be external, code, or decision.' }
        }
        if (blocker.kind === 'external' && (typeof blocker.action !== 'string' || blocker.action.trim().length === 0)) {
          return { ok: false, code: 'invalid_arguments', message: 'an external blocker must name the action that clears it.' }
        }
      }
      try {
        return { ok: true, ...engine.checkpoint({
          agent: exec.agent,
          chainId: args?.chainId,
          features: args?.features,
          addFeatures: args?.addFeatures,
          reason: args?.reason,
          blocker,
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
    name: 'relay_spawn',
    description: 'Delegate part of this chain to a fresh child session. The child gets one message naming the truth '
      + 'source and the features it owns, works them one at a time, and reports back through relay_checkpoint. '
      + 'Only the chain\'s current session may delegate, and a feature can be delegated once.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        features: {
          type: 'array',
          items: { type: 'string' },
          description: 'Feature ids this child owns. They must exist, not pass yet, and not already be delegated.',
        },
        note: { type: 'string', description: 'Context the child needs but the truth source does not carry.' },
        agentPreset: { type: 'string', description: 'Preset for the child session; omit to inherit this session\'s.' },
      },
      required: ['features'],
    },
    output: { schema: ANY_OBJECT, render: renderJson },
    async execute(args, exec) {
      const refused = call(exec.agent)
      if (refused !== undefined) return refused
      if (exec.agent === undefined) return { ok: false, code: 'no_agent', message: 'relay_spawn needs a calling agent.' }
      if (!Array.isArray(args?.features) || args.features.length === 0) {
        return { ok: false, code: 'invalid_arguments', message: 'features must name at least one feature.' }
      }
      for (const id of args.features) {
        if (typeof id !== 'string' || id.length === 0) {
          return { ok: false, code: 'invalid_arguments', message: 'every feature id must be a non-empty string.' }
        }
      }
      if (args.note !== undefined && typeof args.note !== 'string') {
        return { ok: false, code: 'invalid_arguments', message: 'note must be a string.' }
      }
      if (args.agentPreset !== undefined && typeof args.agentPreset !== 'string') {
        return { ok: false, code: 'invalid_arguments', message: 'agentPreset must be a string.' }
      }
      try {
        return { ok: true, ...await engine.spawn({
          agent: exec.agent,
          features: args.features,
          note: args.note,
          agentPreset: args.agentPreset,
        }) }
      } catch (error) {
        return refusal(error)
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Delegate features to a child session',
      kind: 'other',
      rawInput: Array.isArray(args?.features) ? args.features.join(', ') : undefined,
    }),
  })

  ctx.tools.register({
    name: 'relay_audit',
    description: 'Read the append-only audit log of a relay chain: who started it, which features passed or were '
      + 'reassigned, delegations, blockers, wrap-up decisions, and handoffs, newest last. Use it to explain how the '
      + 'chain reached its current state.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chainId: { type: 'string', description: 'Chain id; defaults to the chain this session belongs to.' },
        limit: { type: 'integer', description: 'Newest records to return, from 1 to 200; defaults to 50.' },
      },
    },
    output: { schema: ANY_OBJECT, render: renderJson },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const refused = call(exec.agent)
      if (refused !== undefined) return refused
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 50
      try {
        const resolved = engine.resolveChain(exec.agent, args?.chainId)
        const records = engine.audit(resolved.chain.chainId, limit)
        return { ok: true, chainId: resolved.chain.chainId, count: records.length, records }
      } catch (error) {
        return refusal(error)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Read relay audit log', kind: 'read' }),
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
