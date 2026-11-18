/**
 * Relay engine: chain membership, the supervisor, and the handoff.
 *
 * One engine instance lives for the plugin's lifetime. It owns the in-memory
 * view (which session belongs to which chain, per-session pressure counters)
 * and re-reads the truth source for anything durable, so a restarted Host
 * rebuilds the same picture from the files on disk.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ChainIndex, ChainStore, RELAY_CODES, RelayError, featureProgress, skeletonTruth } from './chain-store.js'
import {
  renderDelegationPrompt, renderHandoffPrompt, renderInitializerPrompt, renderRetireNotice, renderWrapupPrompt,
} from './prompts.js'

/** Freeze one value and everything below it. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

/**
 * Build one relay user message.
 * The LLM package's `createUserMessage` is unavailable here (the profile cannot
 * resolve it), so this reproduces the same committed shape.
 * @param {string} text - message body.
 * @returns {object} frozen user message.
 */
export function relayMessage(text) {
  return deepFreeze({
    id: `relay-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'relay' },
  })
}

/**
 * Render a chain summary for tools and the panel.
 * @param {object} chain - chain record.
 * @param {{ total: number, done: number }|undefined} progress - feature progress.
 * @returns {object} summary.
 */
function chainSummary(chain, progress) {
  const current = chain.sessions.find(session => session.sessionId === chain.currentSessionId)
  return {
    chainId: chain.chainId,
    title: chain.title,
    objective: chain.objective,
    cwd: chain.cwd,
    status: chain.status,
    handoffCount: chain.handoffCount,
    maxHandoffs: chain.maxHandoffs,
    featuresTotal: progress?.total ?? 0,
    featuresDone: progress?.done ?? 0,
    currentSessionId: chain.currentSessionId,
    currentRole: current?.role ?? null,
    sessions: chain.sessions.length,
    updatedAt: chain.updatedAt,
    lastError: chain.lastError,
    blocker: chain.blocker ?? null,
    // How much of the finished work is actually proven: a feature that only reached its
    // error paths still counts as done, but the panel and status must show the gap.
    coveragePartial: progress?.partial ?? 0,
  }
}

/** Prefix that marks a blocker as owned by a blocked goal, not by the model. */
const GOAL_BLOCKER_PREFIX = 'goal blocked:'

/** Process-local per-session supervisor state. */
function newStats() {
  return {
    compactions: 0,
    wrapupSentAt: 0,
    lastEvaluatedAt: 0,
    peakRatio: 0,
    ready: false,
    blocked: false,
  }
}

/** The relay engine. */
export class RelayEngine {
  /**
   * @param {object} ctx - plugin context.
   * @param {object} config - resolved config.
   * @param {{ chainIndex?: ChainIndex }} [options] - test seams.
   */
  constructor(ctx, config, options = {}) {
    this.ctx = ctx
    this.config = config
    /** @type {Map<string, ChainStore>} */
    this.stores = new Map()
    /** @type {Map<string, { chainId: string, truthDir: string }>} */
    this.members = new Map()
    /** @type {Map<string, ReturnType<typeof newStats>>} */
    this.stats = new Map()
    /** Sessions currently inside `evaluate`. @type {Set<string>} */
    this.busyAgents = new Set()
    /** Chains currently handing off. @type {Set<string>} */
    this.busyChains = new Set()
    /** Cross-lifetime chain index. */
    this.chainIndex = options.chainIndex ?? ChainIndex.default()
    this.unloaded = false
  }

  /** Store for one truth directory, created on demand. */
  storeFor(truthDir) {
    let store = this.stores.get(truthDir)
    if (store === undefined) {
      store = new ChainStore(truthDir)
      this.stores.set(truthDir, store)
    }
    return store
  }

  /** The truth directory a workspace uses. */
  truthDirFor(cwd) {
    return ChainStore.forCwd(cwd, this.config.truthDir).truthDir
  }

  /** Log through the host logger without throwing. */
  warn(message) {
    try {
      this.ctx.logger?.warn(`longtask-relay: ${message}`)
    } catch {
      /* the logger itself is optional during teardown */
    }
  }

  /**
   * Append one audit record; a logging failure never breaks the action itself.
   * @param {import('./chain-store.js').ChainStore} store - chain store.
   * @param {string} chainId - chain identity.
   * @param {{ kind: string, actor?: string, detail?: object }} event - what happened.
   */
  record(store, chainId, event) {
    try {
      store.appendAudit(chainId, event)
    } catch (error) {
      this.warn(`audit append failed for ${chainId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Apply this plugin's approval policy to a session it created.
   * A delegated worker or a handoff successor runs unattended: the default
   * `ask` policy has no timeout, so its approval request can park the chain
   * forever. `never` fails closed instead, which surfaces as a blocker.
   * @param {object|undefined} agent - the created live agent.
   */
  applyWorkerPolicy(agent) {
    if (agent === undefined || this.config.workerApproval === 'inherit') return
    const approval = this.ctx.get('approval')
    if (approval === undefined || typeof approval.setPolicy !== 'function') {
      this.warn('the approval service is unavailable; the created session keeps the default policy')
      return
    }
    try {
      approval.setPolicy(agent, this.config.workerApproval)
    } catch (error) {
      this.warn(`could not set the approval policy for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Resolve a session's chain membership.
   * The in-memory map answers first; otherwise the workspace `.relay` index is
   * scanned once, which is how a restarted Host finds chains again.
   * @param {object} session - session to locate.
   * @returns {{ chain: object, store: ChainStore }|undefined} membership.
   */
  locate(session) {
    const known = this.members.get(session.id)
    if (known !== undefined) {
      const store = this.storeFor(known.truthDir)
      const chain = store.readChain(known.chainId)
      if (chain !== undefined) return { chain, store }
      this.members.delete(session.id)
    }
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    let store
    try {
      store = ChainStore.forCwd(cwd, this.config.truthDir)
    } catch {
      return undefined
    }
    let chainIds
    try {
      chainIds = store.listChainIds()
    } catch (error) {
      this.warn(`cannot read ${store.truthDir}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    for (const chainId of chainIds) {
      let chain
      try {
        chain = store.readChain(chainId)
      } catch {
        continue
      }
      if (chain === undefined) continue
      if (chain.sessions.some(entry => entry.sessionId === session.id)) {
        this.remember(chain, store)
        return { chain, store }
      }
    }
    // A chain may live in a different directory than the session that works on
    // it (relay_start accepts an explicit cwd), so the workspace scan above
    // cannot be the only discovery path.
    try {
      for (const entry of this.chainIndex.entries()) {
        if (entry.truthDir === store.truthDir) continue
        const indexed = this.storeFor(entry.truthDir)
        const chain = indexed.readChain(entry.chainId)
        if (chain !== undefined && chain.sessions.some(joined => joined.sessionId === session.id)) {
          this.members.set(session.id, { chainId: chain.chainId, truthDir: indexed.truthDir })
          return { chain, store: indexed }
        }
      }
    } catch (error) {
      this.warn(`cannot scan the chain index for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return undefined
  }

  /** Cache one chain's location for this lifetime and for the next one. */
  remember(chain, store) {
    this.stores.set(store.truthDir, store)
    try {
      this.chainIndex.remember(chain)
    } catch (error) {
      this.warn(`cannot record chain ${chain.chainId} in the index: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Per-session supervisor state. */
  statsFor(sessionId) {
    let stats = this.stats.get(sessionId)
    if (stats === undefined) {
      stats = newStats()
      this.stats.set(sessionId, stats)
    }
    return stats
  }

  /**
   * Current context pressure of one session.
   * @param {object} session - session to measure.
   * @returns {{ tokens: number, window: number, ratio: number }} pressure.
   */
  pressure(session) {
    const meter = this.ctx.get('tokenMeter')
    if (meter === undefined) return { tokens: 0, window: 0, ratio: 0 }
    let tokens = 0
    let window = 0
    try {
      const pressure = meter.contextPressure(session)
      tokens = typeof pressure?.pressureTokens === 'number' ? pressure.pressureTokens : 0
      window = typeof pressure?.contextWindow === 'number' ? pressure.contextWindow : 0
      if (tokens === 0) {
        const measured = meter.measure(session)
        if (typeof measured?.totalTokens === 'number') tokens = measured.totalTokens
      }
    } catch (error) {
      this.warn(`pressure read failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { tokens, window, ratio: window > 0 ? tokens / window : 0 }
  }

  /**
   * Start a chain and adopt the calling session as its initializer.
   * @param {{ agent: object, objective: string, cwd?: string, maxHandoffs?: number }} input - start input.
   * @returns {object} start result.
   */
  start({ agent, objective, cwd, maxHandoffs }) {
    const workspace = cwd ?? agent.session.header?.cwd
    if (typeof workspace !== 'string' || workspace.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'the session has no working directory; pass cwd explicitly')
    }
    const active = this.locate(agent.session)
    if (active !== undefined && active.chain.status !== 'done' && active.chain.status !== 'failed') {
      throw new RelayError(RELAY_CODES.invalid, `this session already belongs to chain ${active.chain.chainId}`)
    }
    const store = ChainStore.forCwd(workspace, this.config.truthDir)
    const chain = store.create({
      objective,
      cwd: workspace,
      maxHandoffs: maxHandoffs ?? this.config.maxHandoffs,
    })
    const skeleton = skeletonTruth(objective)
    store.writeFeatures(chain.chainId, skeleton.features)
    store.writeProgress(chain.chainId, skeleton.progress)
    store.writeHandoff(chain.chainId, skeleton.handoff)
    store.writeText(store.paths(chain.chainId).decisions, skeleton.decisions)
    store.writeText(store.paths(chain.chainId).traps, skeleton.traps)
    const joinedAt = new Date().toISOString()
    const updated = store.update(chain.chainId, record => {
      record.sessions.push({
        sessionId: agent.session.id,
        role: 'initializer',
        index: 0,
        joinedAt,
        compactions: 0,
        parentSessionId: null,
      })
      record.currentSessionId = agent.session.id
      record.status = 'active'
    })
    this.remember(updated, store)
    this.members.set(agent.session.id, { chainId: chain.chainId, truthDir: store.truthDir })
    this.statsFor(agent.session.id)
    this.record(store, chain.chainId, {
      kind: 'chain.started',
      actor: agent.session.id,
      detail: { objective, maxHandoffs: chain.maxHandoffs },
    })
    try {
      // A follow-up wakes the session: the initializer instructions must run in
      // the next turn, not wait for the human to speak again.
      agent.followup(relayMessage(renderInitializerPrompt({
        truthDir: join(store.truthDir, chain.chainId),
        objective,
      })))
    } catch (error) {
      this.warn(`could not queue the initializer prompt: ${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      chainId: chain.chainId,
      title: chain.title,
      truthDir: join(store.truthDir, chain.chainId),
      maxHandoffs: chain.maxHandoffs,
    }
  }

  /**
   * Record progress for one chain.
   * @param {{
   *   agent?: object, chainId?: string, features?: Array<object>, ready?: boolean,
   *   blocked?: boolean, note?: string, addFeatures?: Array<object>, reason?: string,
   *   blocker?: { kind: 'external'|'code'|'decision', who?: string, action?: string }|null,
   * }} input - checkpoint input.
   * @returns {object} checkpoint result.
   */
  checkpoint({ agent, chainId, features, ready, blocked, note, addFeatures, reason, blocker }) {
    const resolved = this.resolveChain(agent, chainId)
    const { chain, store } = resolved
    // Snapshot before the write so the audit can name exactly what changed.
    const before = store.readFeatures(chain.chainId)?.features ?? []
    const beforePasses = new Map(before.map(feature => [feature.id, feature.passes]))
    const beforeAssignments = new Map(before.map(feature => [feature.id, feature.assignedSessionId ?? null]))
    let progress
    if (Array.isArray(features) && features.length > 0) {
      progress = store.patchFeatures(chain.chainId, features)
    } else {
      const document = store.readFeatures(chain.chainId)
      progress = document === undefined ? { total: 0, done: 0, pending: [] } : featureProgress(document)
    }
    const appended = Array.isArray(addFeatures) && addFeatures.length > 0
      ? store.appendFeatures(chain.chainId, addFeatures, reason ?? '').appended
      : []
    if (appended.length > 0) {
      const document = store.readFeatures(chain.chainId)
      progress = document === undefined ? progress : featureProgress(document)
    }
    if (typeof note === 'string' && note.trim().length > 0) {
      const stamp = new Date().toISOString()
      store.writeProgress(chain.chainId, `${store.readProgress(chain.chainId).replace(/\s*$/, '\n')}- [${stamp}] ${note.trim()}\n`)
    }
    if (ready === true && agent !== undefined) this.statsFor(agent.session.id).ready = true
    if (blocker !== undefined) this.recordBlocker(store, chain.chainId, blocker)
    if (blocked === true) {
      store.update(chain.chainId, record => {
        record.status = 'paused'
        record.lastError = typeof note === 'string' && note.trim().length > 0 ? note.trim() : 'blocked by a session'
      })
    }
    const updated = store.readChain(chain.chainId)
    const actor = agent?.session?.id ?? 'host'
    const after = store.readFeatures(chain.chainId)?.features ?? []
    for (const feature of after) {
      const wasPassing = beforePasses.get(feature.id)
      const wasAssigned = beforeAssignments.get(feature.id) ?? null
      const nowAssigned = feature.assignedSessionId ?? null
      if (wasPassing === false && feature.passes) {
        this.record(store, chain.chainId, {
          kind: 'feature.passed',
          actor,
          detail: { id: feature.id, coverage: feature.coverage, evidence: feature.evidence },
        })
      } else if (wasPassing === true && !feature.passes) {
        this.record(store, chain.chainId, { kind: 'feature.reopened', actor, detail: { id: feature.id } })
      }
      if (wasAssigned !== nowAssigned) {
        this.record(store, chain.chainId, {
          kind: 'feature.assigned',
          actor,
          detail: { id: feature.id, from: wasAssigned, to: nowAssigned },
        })
      }
    }
    for (const id of appended) {
      this.record(store, chain.chainId, { kind: 'feature.added', actor, detail: { id, reason } })
    }
    if (ready === true) this.record(store, chain.chainId, { kind: 'session.ready', actor })
    if (blocked === true || blocker !== undefined) {
      this.record(store, chain.chainId, {
        kind: blocker === null ? 'blocker.cleared' : 'blocker.set',
        actor,
        detail: blocker === null || blocker === undefined ? {} : { kind: blocker.kind, action: blocker.action ?? null },
      })
    }
    return {
      chainId: chain.chainId,
      status: updated?.status ?? chain.status,
      paused: updated?.status === 'paused',
      blocker: updated?.blocker ?? null,
      appended,
      featuresTotal: progress.total,
      featuresDone: progress.done,
      pending: progress.pending.map(feature => feature.id).slice(0, 20),
    }
  }

  /**
   * Store the current blocker on the chain record and pause external ones.
   * A blocker only a human can clear must stop the handoff chain: fresh sessions
   * cannot make progress and would burn the handoff budget.
   * @param {import('./chain-store.js').ChainStore} store - chain store.
   * @param {string} chainId - chain identity.
   * @param {{ kind?: string, who?: string, action?: string }|null} blocker - blocker description, or null to clear.
   * @returns {void}
   */
  recordBlocker(store, chainId, blocker) {
    if (blocker === null) {
      store.update(chainId, record => {
        record.blocker = null
        // A chain paused only because of this blocker resumes when it is cleared;
        // an unrelated pause (a failed handoff, a manual pause) must survive.
        if (record.status === 'paused' && typeof record.lastError === 'string' && record.lastError.startsWith('external blocker:')) {
          record.status = 'active'
          record.lastError = null
        }
      })
      return
    }
    const kind = blocker?.kind
    if (kind !== 'external' && kind !== 'code' && kind !== 'decision') {
      throw new RelayError(RELAY_CODES.invalid, 'blocker.kind must be external, code, or decision')
    }
    const description = {
      kind,
      who: typeof blocker.who === 'string' ? blocker.who : kind === 'external' ? 'human' : 'model',
      action: typeof blocker.action === 'string' ? blocker.action : '',
      since: new Date().toISOString(),
    }
    store.update(chainId, record => {
      record.blocker = description
      if (kind === 'external' && this.config.pauseOnExternalBlocker) {
        record.status = 'paused'
        record.lastError = `external blocker: ${description.action || 'waiting for a human'}`
      }
    })
    store.writeProgress(chainId, `${store.readProgress(chainId).replace(/\s*$/, '\n')}- [${description.since}] blocked (${kind}, waits on ${description.who}): ${description.action || '(no action recorded)'}\n`)
    store.appendLedger(chainId, 'decisions', `- [${description.since}] blocked (${kind}, waits on ${description.who}): ${description.action || '(no action recorded)'}`)
  }

  /**
   * Finish a chain after checking that every feature passes.
   * @param {{ agent?: object, chainId?: string, evidence: string }} input - finish input.
   * @returns {object} finish result or a refusal.
   */
  finish({ agent, chainId, evidence }) {
    const { chain, store } = this.resolveChain(agent, chainId)
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chain.chainId} has no features.json`)
    const progress = featureProgress(document)
    if (progress.total === 0) {
      throw new RelayError(RELAY_CODES.incomplete, 'the chain has no features; list them before finishing')
    }
    if (progress.pending.length > 0) {
      return {
        ok: false,
        code: RELAY_CODES.incomplete,
        message: `${progress.pending.length} of ${progress.total} features do not pass yet.`,
        pending: progress.pending.slice(0, 20).map(feature => ({ id: feature.id, title: feature.title })),
      }
    }
    // A passing feature with no recorded output is a claim, not evidence.
    const unsupported = document.features.filter(feature => typeof feature.evidence !== 'string' || feature.evidence.trim().length < 8)
    if (unsupported.length > 0) {
      return {
        ok: false,
        code: RELAY_CODES.incomplete,
        message: `${unsupported.length} features pass without usable evidence; record the command output first.`,
        features: unsupported.slice(0, 20).map(feature => feature.id),
      }
    }
    // Partial coverage is allowed only when a human accepted it (policy configurable).
    const partial = this.config.requireHumanAcceptedCoverage
      ? document.features.filter(feature => feature.coverage !== 'full' && feature.acceptedBy !== 'human')
      : []
    if (partial.length > 0) {
      return {
        ok: false,
        code: RELAY_CODES.incomplete,
        message: `${partial.length} features only reach partial coverage and are not accepted by a human yet.`,
        features: partial.slice(0, 20).map(feature => ({ id: feature.id, coverage: feature.coverage })),
      }
    }
    store.update(chain.chainId, record => {
      record.status = 'done'
      record.lastError = null
    })
    store.writeProgress(chain.chainId, `${store.readProgress(chain.chainId).replace(/\s*$/, '\n')}- [${new Date().toISOString()}] completed: ${evidence}\n`)
    this.record(store, chain.chainId, {
      kind: 'chain.finished',
      actor: agent?.session?.id ?? 'host',
      detail: { evidence, featuresTotal: progress.total },
    })
    return { ok: true, chainId: chain.chainId, featuresTotal: progress.total }
  }

  /**
   * Pause or resume automatic handoff for one chain.
   * @param {{ agent?: object, chainId?: string, paused: boolean }} input - toggle input.
   * @returns {object} new status.
   */
  setPaused({ agent, chainId, paused }) {
    const { chain, store } = this.resolveChain(agent, chainId)
    store.update(chain.chainId, record => {
      if (paused) {
        record.status = 'paused'
      } else if (record.status === 'paused' || record.status === 'initializing') {
        record.status = 'active'
        record.lastError = null
      }
    })
    this.record(store, chain.chainId, {
      kind: paused ? 'chain.paused' : 'chain.resumed',
      actor: agent?.session?.id ?? 'host',
    })
    return { chainId: chain.chainId, status: store.readChain(chain.chainId)?.status ?? chain.status }
  }

  /**
   * Hand off immediately, bypassing the pressure decision.
   * @param {{ agent?: object, chainId?: string }} input - handoff input.
   * @returns {Promise<object>} handoff result.
   */
  async handoffNow({ agent, chainId }) {
    const { chain, store } = this.resolveChain(agent, chainId)
    const current = chain.currentSessionId === null ? undefined : this.ctx.get('agents')?.get(chain.currentSessionId)
    if (current === undefined) {
      throw new RelayError(RELAY_CODES.notFound, `the current session of ${chain.chainId} is not loaded; open it first`)
    }
    return this.handoff(chain, current, 'manual')
  }

  /**
   * Resolve the chain a call acts on.
   * @param {object|undefined} agent - calling agent, when any.
   * @param {string|undefined} chainId - explicit chain id, when given.
   * @returns {{ chain: object, store: ChainStore }} chain and store.
   */
  resolveChain(agent, chainId) {
    if (typeof chainId === 'string' && chainId.length > 0) {
      try {
        return this.findChain(chainId)
      } catch (error) {
        // A caller inside the chain can still act on it when the index has not
        // seen that workspace yet.
        const membership = agent === undefined ? undefined : this.locate(agent.session)
        if (membership !== undefined && membership.chain.chainId === chainId) return membership
        throw error
      }
    }
    const membership = agent === undefined ? undefined : this.locate(agent.session)
    if (membership === undefined) throw new RelayError(RELAY_CODES.notFound, 'this session does not belong to a chain')
    return membership
  }

  /** Snapshot every chain this Host knows about. */
  status() {
    // The index is the authority for which chains exist; the stores are only
    // the ones this lifetime has touched.
    let indexed = []
    try {
      indexed = this.chainIndex.entries()
    } catch (error) {
      this.warn(`cannot read the chain index: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const entry of indexed) {
      if (!this.stores.has(entry.truthDir)) this.stores.set(entry.truthDir, this.storeFor(entry.truthDir))
    }
    const seen = new Set()
    const items = []
    for (const [truthDir, store] of this.stores) {
      let chainIds = []
      try {
        chainIds = store.listChainIds()
      } catch (error) {
        this.warn(`cannot list chains in ${truthDir}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      for (const chainId of chainIds) {
        if (seen.has(chainId)) continue
        seen.add(chainId)
        try {
          const chain = store.readChain(chainId)
          if (chain === undefined) continue
          const document = store.readFeatures(chainId)
          const progress = document === undefined ? undefined : featureProgress(document)
          items.push({
            ...chainSummary(chain, progress),
            sessionsDetail: chain.sessions.map(session => {
              const live = this.ctx.get('agents')?.get(session.sessionId)
              const stats = this.stats.get(session.sessionId)
              return {
                sessionId: session.sessionId,
                role: session.role,
                index: session.index,
                running: live?.status === 'running',
                loaded: live !== undefined,
                retiredAt: session.retiredAt ?? null,
                retireReason: session.retireReason ?? null,
                compactions: stats?.compactions ?? 0,
                peakRatio: Number((stats?.peakRatio ?? 0).toFixed(3)),
              }
            }),
          })
        } catch (error) {
          this.warn(`cannot read chain ${chainId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    return items
  }

  /** Find one chain among the stores this Host has touched, then the index. */
  findChain(chainId) {
    for (const [, store] of this.stores) {
      let chain
      try {
        chain = store.readChain(chainId)
      } catch {
        continue
      }
      if (chain !== undefined) return { chain, store }
    }
    const truthDir = this.chainIndex.locate(chainId)
    if (truthDir !== undefined) {
      const store = this.storeFor(truthDir)
      const chain = store.readChain(chainId)
      if (chain !== undefined) {
        this.stores.set(truthDir, store)
        return { chain, store }
      }
    }
    throw new RelayError(RELAY_CODES.notFound, `chain ${chainId} is not known to this Host`)
  }

  /**
   * Full view of one chain for the panel and the status tool.
   * @param {string} chainId - chain identity.
   * @returns {object} detail.
   */
  detail(chainId) {
    const { chain, store } = this.findChain(chainId)
    const document = store.readFeatures(chainId)
    return {
      chain: chainSummary(chain, document === undefined ? undefined : featureProgress(document)),
      features: (document?.features ?? []).map(feature => ({
        id: feature.id,
        title: feature.title,
        priority: feature.priority,
        passes: feature.passes,
        evidence: feature.evidence,
        verify: feature.verify,
        notes: feature.notes,
        // Exposed for the panel only; both fields already live on the record.
        coverage: feature.coverage ?? null,
        acceptedBy: feature.acceptedBy ?? null,
        assignedSessionId: feature.assignedSessionId ?? null,
      })),
      progress: store.readProgress(chainId).slice(0, 8000),
      handoff: store.readHandoff(chainId).slice(0, 8000),
      truthDir: join(store.truthDir, chainId),
      sessions: chain.sessions.map(session => {
        const live = this.ctx.get('agents')?.get(session.sessionId)
        const stats = this.stats.get(session.sessionId)
        const pressure = live === undefined ? { tokens: 0, window: 0, ratio: 0 } : this.pressure(live.session)
        return {
          sessionId: session.sessionId,
          role: session.role,
          index: session.index,
          joinedAt: session.joinedAt ?? null,
          retiredAt: session.retiredAt ?? null,
          retireReason: session.retireReason ?? null,
          loaded: live !== undefined,
          running: live?.status === 'running',
          compactions: stats?.compactions ?? session.compactions ?? 0,
          peakRatio: Number((stats?.peakRatio ?? session.peakPressureRatio ?? 0).toFixed(3)),
          pressureRatio: Number(pressure.ratio.toFixed(3)),
          pressureTokens: pressure.tokens,
          contextWindow: pressure.window,
          parentSessionId: session.parentSessionId ?? null,
        }
      }),
    }
  }

  /**
   * Create a child session and hand it a slice of the chain's features.
   * Only the chain's current session may delegate, so a delegated session
   * cannot fan out further and a stale session cannot take over.
   * @param {{ agent: object, features: string[], note?: string, agentPreset?: string }} input - spawn input.
   * @returns {Promise<object>} the created child session.
   */
  async spawn({ agent, features, note, agentPreset }) {
    const membership = this.locate(agent.session)
    if (membership === undefined) throw new RelayError(RELAY_CODES.notFound, 'this session does not belong to a chain')
    const { chain, store } = membership
    if (chain.currentSessionId !== agent.session.id) {
      throw new RelayError(RELAY_CODES.invalid, 'only the chain\'s current session can delegate work')
    }
    if (chain.status !== 'active' && chain.status !== 'initializing') {
      throw new RelayError(RELAY_CODES.invalid, `chain ${chain.chainId} is ${chain.status}; resume it before delegating`)
    }
    if (!Array.isArray(features) || features.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'features must name at least one feature to delegate')
    }
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chain.chainId} has no features.json`)
    const byId = new Map(document.features.map(feature => [feature.id, feature]))
    const selected = []
    for (const id of features) {
      const feature = byId.get(id)
      if (feature === undefined) throw new RelayError(RELAY_CODES.invalid, `feature ${id} does not exist`)
      if (feature.passes) throw new RelayError(RELAY_CODES.invalid, `feature ${id} already passes`)
      if (typeof feature.assignedSessionId === 'string' && feature.assignedSessionId.length > 0) {
        throw new RelayError(RELAY_CODES.invalid, `feature ${id} is already delegated to ${feature.assignedSessionId}`)
      }
      selected.push(feature)
    }

    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new RelayError(RELAY_CODES.invalid, 'this Host cannot create sessions')

    this.busyChains.add(chain.chainId)
    let createdSessionId
    try {
      const preset = agentPreset ?? this.presetFor(agent)
      const created = await controller.create({
        cwd: chain.cwd,
        ...(preset === undefined ? {} : { agentPreset: preset }),
      })
      createdSessionId = created.sessionId
      const joinedAt = new Date().toISOString()

      store.patchFeatures(chain.chainId, selected.map(feature => ({
        id: feature.id,
        assignedSessionId: createdSessionId,
      })))
      for (const feature of selected) {
        this.record(store, chain.chainId, {
          kind: 'feature.assigned',
          actor: agent.session.id,
          detail: { id: feature.id, from: null, to: createdSessionId },
        })
      }
      store.update(chain.chainId, record => {
        record.sessions.push({
          sessionId: createdSessionId,
          role: 'worker',
          index: record.sessions.length,
          joinedAt,
          compactions: 0,
          parentSessionId: agent.session.id,
        })
        record.lastError = null
      })
      const settled = store.readChain(chain.chainId)
      if (settled !== undefined) this.remember(settled, store)
      this.members.set(createdSessionId, { chainId: chain.chainId, truthDir: store.truthDir })
      this.statsFor(createdSessionId)

      const child = this.ctx.get('agents')?.get(createdSessionId)
      if (child !== undefined) {
        this.applyWorkerPolicy(child)
        try {
          this.ctx.get('sessionTitle')?.rename(child.session, `${chain.title} · 子任务`)
        } catch {
          /* naming is advisory */
        }
      }

      const prompt = renderDelegationPrompt({
        chain,
        truthDir: join(store.truthDir, chain.chainId),
        parentSessionId: agent.session.id,
        features: selected,
        note: typeof note === 'string' ? note : '',
      })
      await controller.prompt({
        requestId: `relay-spawn-${chain.chainId}-${createdSessionId}-${randomUUID().slice(0, 8)}`,
        sessionId: createdSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, AbortSignal.timeout(60_000))

      this.record(store, chain.chainId, {
        kind: 'delegation.created',
        actor: agent.session.id,
        detail: { childSessionId: createdSessionId, features: selected.map(feature => feature.id), note: note ?? '' },
      })
      return {
        chainId: chain.chainId,
        sessionId: createdSessionId,
        features: selected.map(feature => feature.id),
        parentSessionId: agent.session.id,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Release the delegation so the parent can retry with the same features.
      if (createdSessionId !== undefined) {
        try {
          store.patchFeatures(chain.chainId, selected.map(feature => ({ id: feature.id, assignedSessionId: null })))
          store.update(chain.chainId, record => {
            record.sessions = record.sessions.filter(session => session.sessionId !== createdSessionId)
          })
        } catch (cleanupError) {
          this.warn(`could not release delegation ${createdSessionId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
        }
      }
      this.record(store, chain.chainId, {
        kind: 'delegation.failed',
        actor: agent.session.id,
        detail: { features: selected.map(feature => feature.id), error: message },
      })
      throw error instanceof RelayError ? error : new RelayError(RELAY_CODES.io, `spawn failed: ${message}`)
    } finally {
      this.busyChains.delete(chain.chainId)
    }
  }

  /**
   * One session's goal, trimmed for the session tabs.
   * @param {object|undefined} agent - live agent, or undefined when unloaded.
   * @returns {object|null} goal summary, or null when the session has none.
   */
  goalViewOf(agent) {
    if (agent === undefined) return null
    try {
      const view = this.ctx.get('goals')?.get?.(agent)
      if (view === undefined) return null
      return {
        phase: view.phase,
        activation: view.activation,
        roundsStarted: view.roundsStarted,
        maxGoalRounds: view.maxGoalRounds,
        blockedCode: view.blockedReason?.code ?? null,
        blockedMessage: view.blockedReason?.message ?? null,
      }
    } catch {
      return null
    }
  }

  /**
   * One session's place in its chain, for the session-scoped tabs.
   * @param {string} sessionId - session to describe.
   * @returns {object|undefined} view, or undefined when the session is not in a chain.
   */
  sessionView(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'sessionId is required')
    }
    let membership
    // A loaded session rediscovers its chain from its own working directory.
    // Right after a plugin reload or Host restart the in-memory stores are
    // empty, and the panel that fills them may never have been opened.
    const agent = this.ctx.get('agents')?.get(sessionId)
    if (agent !== undefined) {
      const located = this.locate(agent.session)
      const self = located?.chain.sessions.find(session => session.sessionId === sessionId)
      if (located !== undefined && self !== undefined) membership = { chain: located.chain, store: located.store, self }
    }
    if (membership === undefined) {
      for (const [, store] of this.stores) {
        for (const chainId of store.listChainIds()) {
          let chain
          try {
            chain = store.readChain(chainId)
          } catch {
            continue
          }
          if (chain === undefined) continue
          const self = chain.sessions.find(session => session.sessionId === sessionId)
          if (self === undefined) continue
          membership = { chain, store, self }
          break
        }
        if (membership !== undefined) break
      }
    }
    if (membership === undefined) return undefined
    const { chain, store, self } = membership
    const document = store.readFeatures(chain.chainId)
    const features = document?.features ?? []
    const describe = (session) => {
      const live = this.ctx.get('agents')?.get(session.sessionId)
      const stats = this.stats.get(session.sessionId)
      return {
        sessionId: session.sessionId,
        role: session.role,
        running: live?.status === 'running',
        loaded: live !== undefined,
        retiredAt: session.retiredAt ?? null,
        retireReason: session.retireReason ?? null,
        compactions: stats?.compactions ?? session.compactions ?? 0,
        pressureRatio: live === undefined ? 0 : Number(this.pressure(live.session).ratio.toFixed(3)),
        goal: this.goalViewOf(live),
      }
    }
    const children = chain.sessions
      .filter(session => session.parentSessionId === sessionId)
      .map(session => {
        const owned = features.filter(feature => feature.assignedSessionId === session.sessionId)
        return {
          ...describe(session),
          features: owned.map(feature => feature.id),
          featuresPassed: owned.filter(feature => feature.passes).length,
        }
      })
    return {
      chain: chainSummary(chain, document === undefined ? undefined : featureProgress(document)),
      self: describe(self),
      parent: self.parentSessionId === null || self.parentSessionId === undefined
        ? null
        : chain.sessions.find(session => session.sessionId === self.parentSessionId) === undefined
          ? { sessionId: self.parentSessionId }
          : describe(chain.sessions.find(session => session.sessionId === self.parentSessionId)),
      children,
      assignedFeatures: features
        .filter(feature => feature.assignedSessionId === sessionId)
        .map(feature => ({
          id: feature.id,
          title: feature.title,
          passes: feature.passes,
          evidence: feature.evidence,
          verify: feature.verify,
          coverage: feature.coverage ?? null,
          acceptedBy: feature.acceptedBy ?? null,
        })),
    }
  }

  /**
   * Newest audit records for one chain.
   * @param {string} chainId - chain identity.
   * @param {number} [limit] - newest records to return.
   * @returns {Array<object>} records, oldest first within the returned window.
   */
  audit(chainId, limit) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'chainId is required')
    }
    const { store } = this.findChain(chainId)
    return store.readAudit(chainId, limit)
  }

  /** Record one successful compaction for a session. */
  noteCompaction(sessionId) {
    this.statsFor(sessionId).compactions += 1
  }

  /**
   * Evaluate one idle session and act when it is time to wrap up or hand off.
   * @param {object} agent - live agent.
   * @returns {Promise<void>} settles after any action.
   */
  async evaluate(agent) {
    if (this.unloaded) return
    if (agent.status !== 'idle') return
    if (this.busyAgents.has(agent.id)) return
    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) return
    const membership = this.locate(agent.session)
    if (membership === undefined) return
    const { store } = membership
    let { chain } = membership
    if (chain.currentSessionId !== agent.id) return

    // Goal state is synced before the handoff policy: a blocked goal means the
    // session will not continue on its own, and that must reach the chain even
    // when automatic handoff is off. The record may have just been rewritten.
    if (this.syncGoalBlocker(chain, store, agent)) return
    const refreshed = store.readChain(chain.chainId)
    if (refreshed === undefined) return
    chain = refreshed
    if (chain.status !== 'active' && chain.status !== 'initializing') return
    if (!this.config.autoHandoff) return

    const stats = this.statsFor(agent.id)
    const now = Date.now()
    if (now - stats.lastEvaluatedAt < this.config.cooldownMs) return
    stats.lastEvaluatedAt = now

    const pressure = this.pressure(agent.session)
    if (pressure.ratio > stats.peakRatio) stats.peakRatio = pressure.ratio

    this.busyAgents.add(agent.id)
    try {
      if (stats.compactions >= this.config.hardCompactions) {
        this.record(store, chain.chainId, {
          kind: 'supervisor.decision',
          actor: 'system',
          detail: { action: 'handoff', reason: 'compactions', compactions: stats.compactions, ratio: Number(pressure.ratio.toFixed(3)) },
        })
        await this.handoff(chain, agent, 'compactions')
        return
      }
      if (stats.wrapupSentAt === 0) {
        const byPressure = pressure.ratio >= this.config.handoffRatio
        const byCompaction = stats.compactions >= this.config.handoffAfterCompactions
          && pressure.ratio >= this.config.compactedRatioFloor
        if (byPressure || byCompaction) {
          this.record(store, chain.chainId, {
            kind: 'supervisor.decision',
            actor: 'system',
            detail: { action: 'wrapup', by: byPressure ? 'pressure' : 'compaction', ratio: Number(pressure.ratio.toFixed(3)) },
          })
          await this.wrapup(chain, store, agent)
        }
        return
      }
      const timedOut = now - stats.wrapupSentAt >= this.config.wrapupTimeoutMinutes * 60_000
      if (stats.ready || pressure.ratio >= this.config.handoffRatio || timedOut) {
        this.record(store, chain.chainId, {
          kind: 'supervisor.decision',
          actor: 'system',
          detail: {
            action: 'handoff',
            reason: stats.ready ? 'checkpoint' : timedOut ? 'timeout' : 'pressure',
            ratio: Number(pressure.ratio.toFixed(3)),
          },
        })
        await this.handoff(chain, agent, stats.ready ? 'checkpoint' : 'pressure')
      }
    } catch (error) {
      this.warn(`evaluate failed for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busyAgents.delete(agent.id)
    }
  }

  /**
   * Ask the current session to close its phase.
   * @param {object} chain - chain record.
   * @param {ChainStore} store - its store.
   * @param {object} agent - live agent.
   * @returns {Promise<void>} settles after the prompt is queued.
   */
  async wrapup(chain, store, agent) {
    const document = store.readFeatures(chain.chainId)
    const progress = document === undefined ? { total: 0, done: 0 } : featureProgress(document)
    const prompt = renderWrapupPrompt({
      truthDir: join(store.truthDir, chain.chainId),
      featuresTotal: progress.total,
      featuresDone: progress.done,
    })
    try {
      agent.followup(relayMessage(prompt))
    } catch (error) {
      this.warn(`could not queue the wrap-up prompt for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.statsFor(agent.id).wrapupSentAt = Date.now()
    try {
      await this.ctx.get('sessions')?.flush(agent.session)
    } catch {
      /* persistence acknowledgement is advisory here */
    }
  }

  /**
   * Create the next session warm and hand the chain to it.
   * @param {object} chain - current chain record.
   * @param {object} oldAgent - agent being retired.
   * @param {string} reason - why the handoff happens.
   * @returns {Promise<object>} handoff result.
   */
  async handoff(chain, oldAgent, reason) {
    if (this.busyChains.has(chain.chainId)) {
      throw new RelayError(RELAY_CODES.limit, `chain ${chain.chainId} is already handing off`)
    }
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) {
      throw new RelayError(RELAY_CODES.invalid, 'this Host cannot create sessions; handoff is unavailable')
    }
    const store = this.storeFor(chain.truthDir)
    const handoffNo = chain.handoffCount + 1
    if (handoffNo > chain.maxHandoffs) {
      store.update(chain.chainId, record => {
        record.status = 'failed'
        record.lastError = `handoff limit of ${record.maxHandoffs} reached`
      })
      throw new RelayError(RELAY_CODES.limit, `chain ${chain.chainId} reached its handoff limit`)
    }

    this.busyChains.add(chain.chainId)
    this.record(store, chain.chainId, {
      kind: 'handoff.started',
      actor: 'system',
      detail: { from: oldAgent.session.id, reason, handoffNo },
    })
    let createdSessionId
    try {
      const preset = this.presetFor(oldAgent)
      const created = await controller.create({
        cwd: chain.cwd,
        ...(preset === undefined ? {} : { agentPreset: preset }),
      })
      createdSessionId = created.sessionId
      const newAgent = this.ctx.get('agents')?.get(createdSessionId)
      const session = newAgent?.session
      if (newAgent !== undefined) this.applyWorkerPolicy(newAgent)

      store.update(chain.chainId, record => {
        record.pendingHandoff = { sessionId: createdSessionId, createdAt: new Date().toISOString(), reason }
      })

      if (session !== undefined) this.decorateSession(chain, newAgent, handoffNo)

      const document = store.readFeatures(chain.chainId)
      const prompt = renderHandoffPrompt({
        chain,
        features: document,
        handoff: store.readHandoff(chain.chainId),
        handoffNo,
        previousSessionId: oldAgent.session.id,
        truthDir: join(store.truthDir, chain.chainId),
      })
      await controller.prompt({
        requestId: `relay-${chain.chainId}-${handoffNo}-${randomUUID().slice(0, 8)}`,
        sessionId: createdSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, AbortSignal.timeout(60_000))

      // Only after the handoff brief is queued: a failed prompt must retry
      // cleanly, and a pre-created goal would then be an orphan on that session.
      this.seedGoal(chain, store, newAgent)

      const retiredAt = new Date().toISOString()
      store.update(chain.chainId, record => {
        const previous = record.sessions.find(entry => entry.sessionId === oldAgent.session.id)
        if (previous !== undefined) {
          previous.retiredAt = retiredAt
          previous.retireReason = reason
          const stats = this.stats.get(oldAgent.session.id)
          if (stats !== undefined) previous.peakPressureRatio = Number(stats.peakRatio.toFixed(3))
          previous.compactions = this.stats.get(oldAgent.session.id)?.compactions ?? 0
        }
        record.sessions.push({
          sessionId: createdSessionId,
          role: 'worker',
          index: handoffNo,
          joinedAt: retiredAt,
          compactions: 0,
          // A handoff continues the same delegation, so the next session keeps
          // the previous session's parent rather than becoming a child of it.
          parentSessionId: previous?.parentSessionId ?? null,
        })
        record.currentSessionId = createdSessionId
        record.handoffCount = handoffNo
        record.status = 'active'
        record.pendingHandoff = null
        record.lastError = null
      })

      this.members.set(createdSessionId, { chainId: chain.chainId, truthDir: store.truthDir })
      this.statsFor(createdSessionId)
      const settled = store.readChain(chain.chainId)
      if (settled !== undefined) this.remember(settled, store)
      this.retire(oldAgent, chain, createdSessionId, handoffNo)
      this.record(store, chain.chainId, {
        kind: 'handoff.completed',
        actor: 'system',
        detail: { from: oldAgent.session.id, to: createdSessionId, reason, handoffNo },
      })
      return { chainId: chain.chainId, newSessionId: createdSessionId, handoffNo, reason }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        store.update(chain.chainId, record => {
          if (createdSessionId !== undefined) {
            record.pendingHandoff = {
              sessionId: createdSessionId,
              createdAt: new Date().toISOString(),
              reason: `failed: ${message}`,
            }
          }
          record.status = 'paused'
          record.lastError = message
        })
      } catch (updateError) {
        this.warn(`could not record the failed handoff: ${updateError instanceof Error ? updateError.message : String(updateError)}`)
      }
      this.record(store, chain.chainId, {
        kind: 'handoff.failed',
        actor: 'system',
        detail: { from: oldAgent.session.id, reason, error: message },
      })
      throw error instanceof RelayError ? error : new RelayError(RELAY_CODES.io, `handoff failed: ${message}`)
    } finally {
      this.busyChains.delete(chain.chainId)
    }
  }

  /** Name and place a freshly created session; failures are advisory. */
  decorateSession(chain, newAgent, handoffNo) {
    try {
      this.ctx.get('sessionTitle')?.rename(newAgent.session, `${chain.title} · 接力 ${handoffNo}`)
    } catch (error) {
      this.warn(`could not name session ${newAgent.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return
    Promise.resolve()
      .then(async () => {
        const workspace = await registry.resolveByPath(chain.cwd)
        await workspace?.attachSession(newAgent.session.id)
      })
      .catch(error => this.warn(`session ${newAgent.id} did not join the workspace: ${error instanceof Error ? error.message : String(error)}`))
  }

  /** The preset a new session inherits from the session being retired. */
  presetFor(agent) {
    if (this.config.agentPreset.length > 0) return this.config.agentPreset
    try {
      return agent.ctx?.get?.('agentPresets')?.composedPreset?.(agent.ctx) ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * Give the handoff successor a goal so the goal-round driver keeps it moving.
   * The goal is per-session, so the objective carries the progress the successor
   * would otherwise have to rediscover.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object|undefined} agent - the created successor session.
   * @returns {void}
   */
  seedGoal(chain, store, agent) {
    if (!this.config.seedGoalOnHandoff || agent === undefined) return
    const goals = this.ctx.get('goals')
    if (goals === undefined || typeof goals.create !== 'function') {
      this.warn('seedGoalOnHandoff is on but the goals service is unavailable; the successor has no goal')
      return
    }
    const document = store.readFeatures(chain.chainId)
    const progress = document === undefined ? { total: 0, done: 0 } : featureProgress(document)
    const objective = `${chain.objective} — relay chain ${chain.chainId}, ${progress.done}/${progress.total} features pass. Truth source: ${join(store.truthDir, chain.chainId)}.`
    let view
    try {
      view = goals.create(agent, { objective, maxGoalRounds: this.config.goalRoundsPerHandoff })
    } catch (error) {
      this.warn(`could not seed a goal on ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.record(store, chain.chainId, {
      kind: 'goal.seeded',
      actor: 'system',
      detail: { goalId: view?.id ?? null, rounds: view?.maxGoalRounds ?? this.config.goalRoundsPerHandoff },
    })
  }

  /**
   * Keep the chain honest about a blocked goal.
   * A blocked goal stops automatic continuation, so an active chain would sit
   * still while the panel claims it is running. The blocker is tagged so that
   * resuming or clearing the goal releases the chain again.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object} agent - the chain's current session.
   * @returns {boolean} true when a blocked goal stops this evaluation.
   */
  syncGoalBlocker(chain, store, agent) {
    const goals = this.ctx.get('goals')
    if (goals === undefined || typeof goals.get !== 'function') return false
    let view
    try {
      view = goals.get(agent)
    } catch (error) {
      this.warn(`could not read the goal of ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    const existing = chain.blocker
    const goalOwned = existing !== null && existing !== undefined
      && existing.kind === 'external'
      && typeof existing.action === 'string'
      && existing.action.startsWith(GOAL_BLOCKER_PREFIX)
    if (view === undefined || view.phase !== 'blocked') {
      if (goalOwned) this.recordBlocker(store, chain.chainId, null)
      return false
    }
    const reason = view.blockedReason?.message ?? 'no explanation recorded'
    const action = `${GOAL_BLOCKER_PREFIX} ${reason} Resume or clear the goal in the composer, then resume this chain.`
    if (goalOwned && existing.action === action) return this.config.pauseOnExternalBlocker
    this.record(store, chain.chainId, {
      kind: 'supervisor.decision',
      actor: 'system',
      detail: { action: 'pause', reason: 'goal-blocked', goalId: view.id, code: view.blockedReason?.code ?? null },
    })
    this.recordBlocker(store, chain.chainId, { kind: 'external', who: 'human', action })
    // With pauses disabled for external blockers the chain keeps handing off,
    // which is how a successor gets a fresh goal-round budget.
    return this.config.pauseOnExternalBlocker
  }

  /** Stop the retired session from continuing on its own. */
  retire(oldAgent, chain, newSessionId, handoffNo) {
    if (this.config.notifyOldSession) {
      try {
        oldAgent.inject(relayMessage(renderRetireNotice({ chainId: chain.chainId, newSessionId, handoffNo })))
      } catch (error) {
        this.warn(`could not notify the retired session: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!this.config.pauseGoalOnRetire) return
    try {
      const goals = this.ctx.get('goals')
      const view = goals?.get?.(oldAgent)
      if (view !== undefined && view.activation === 'armed') {
        goals.pause(oldAgent, { id: view.id, revision: view.revision })
      }
    } catch (error) {
      this.warn(`could not pause the retired session's goal: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Stop every pending action on unload. */
  dispose() {
    this.unloaded = true
    this.busyAgents.clear()
    this.busyChains.clear()
    this.stats.clear()
    this.members.clear()
    this.stores.clear()
  }
}
