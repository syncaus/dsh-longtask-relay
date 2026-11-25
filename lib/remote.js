/**
 * Host Remote namespace `relay`.
 *
 * The profile cannot import the Typert protocol package, so the binding and
 * the method marker are written by hand. The Gateway's source fallback reads
 * parameter names from the method signature, which is why every method here
 * takes plain identifiers and never a destructured object.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RelayError } from './chain-store.js'
import { dshHome } from './home.js'
import { applyPluginUpdate, checkPluginUpdate } from './update.js'
import { resolveConfig } from './config.js'

/**
 * Append one host-level audit record for an action that belongs to no chain.
 * Failure is advisory: an audit gap must not block the action itself.
 * @param {{ kind: string, actor?: string, detail?: object }} event - what happened.
 */
function appendHostAudit(event) {
  const file = join(dshHome(), 'longtask-relay', 'audit.jsonl')
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  } catch {
    /* the caller already succeeded; the log is best-effort */
  }
}

/** Descriptor key the Gateway reads from the service prototype. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Methods exposed to the browser. */
const METHODS = [
  'listChains', 'listDeleted', 'chainDetail', 'chainAudit', 'chainDoc', 'sessionView', 'setPaused', 'handoffNow', 'launchCluster', 'previewCluster', 'finishChain', 'deleteChain', 'restoreChain', 'purgeChain', 'acceptCoverage', 'acceptCoverageMany', 'raiseHandoffLimit', 'clearBlocker', 'reclaimWorker', 'recall', 'getConfig', 'saveConfig', 'checkUpdate', 'applyUpdate',
  'resolveTamper', 'approveCommands', 'acceptChain', 'rejectChain', 'restartReview',
]

/** Relay Remote over the engine. */
export class RelayRemote {
  /**
   * @param {import('./engine.js').RelayEngine} engine - relay engine.
   */
  constructor(engine) {
    this.engine = engine
  }

  /** Every live chain this Host knows about. */
  listChains() {
    return { chains: this.engine.status() }
  }

  /** Chains moved to their workspace's trash that can still be restored. */
  listDeleted() {
    return { chains: this.engine.listDeleted() }
  }

  /**
   * Full detail of one chain.
   * @param {string} chainId - chain identity.
   * @returns {object} detail.
   */
  chainDetail(chainId) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.detail(chainId)
  }

  /**
   * One session's place in its chain: parent, children, and owned features.
   * @param {string} sessionId - session to describe.
   * @returns {object} view; `{ chain: null }` when the session is not in a chain.
   */
  sessionView(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RelayError('invalid', 'sessionId is required')
    }
    return this.engine.sessionView(sessionId) ?? { chain: null }
  }

  /**
   * Newest audit records for one chain.
   * @param {string} chainId - chain identity.
   * @param {number} limit - newest records to return.
   * @returns {Array<object>} records.
   */
  chainAudit(chainId, limit) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100
    return this.engine.audit(chainId, take)
  }

  /**
   * One truth-source document of a chain.
   * @param {string} chainId - chain identity.
   * @param {string} name - handoff, progress, history, decisions, or traps.
   * @returns {object} document text.
   */
  chainDoc(chainId, name) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.doc(chainId, name)
  }

  /**
   * Pause or resume automatic handoff.
   * @param {string} chainId - chain identity.
   * @param {boolean} paused - true pauses the chain.
   * @returns {object} new status.
   */
  setPaused(chainId, paused) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    if (typeof paused !== 'boolean') throw new RelayError('invalid', 'paused must be a boolean')
    return this.engine.setPaused({ chainId, paused })
  }

  /**
   * Hand the chain to a fresh session now.
   * @param {string} chainId - chain identity.
   * @returns {Promise<object>} handoff result.
   */
  async handoffNow(chainId) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    const result = await this.engine.handoffNow({ chainId })
    if (result?.ok === false) throw new RelayError('invalid', result.message ?? 'the handoff is not ready')
    return result
  }

  /**
   * Open the sessions of a planning chain's launch plan, as the human confirmed or edited it.
   * @param {string} chainId - chain identity.
   * @param {Array<object>} groups - the plan as edited in the panel; the stored plan is used when absent.
   * @returns {Promise<object>} what happened to each group.
   */
  async launchCluster(chainId, groups) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.launchCluster({ chainId, ...(Array.isArray(groups) ? { groups } : {}) })
  }

  /**
   * What a launch plan would run into, checked with the rules a launch applies; writes nothing.
   * @param {string} chainId - chain identity.
   * @param {Array<object>} groups - the plan as edited in the panel; the stored plan is used when absent.
   * @returns {object} `{ refusal, conflicts, waiting, blocker }`.
   */
  previewCluster(chainId, groups) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.previewCluster({ chainId, ...(Array.isArray(groups) ? { groups } : {}) })
  }

  /**
   * Finish a chain after checking its features: re-run every verify command, then review.
   * @param {string} chainId - chain identity.
   * @param {string} evidence - how the objective was verified.
   * @returns {Promise<object>} finish result.
   */
  finishChain(chainId, evidence) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    if (typeof evidence !== 'string' || evidence.trim().length === 0) {
      throw new RelayError('invalid', 'evidence is required')
    }
    return this.engine.finishVerified({ chainId, evidence })
  }

  /**
   * A human's decision on a tampered truth source.
   * @param {string} chainId - chain identity.
   * @param {string} action - `restore` puts the sealed files back; `adopt` accepts the files on disk.
   * @param {string} [reason] - why the changed files are accepted; required for adopt.
   * @returns {object} the decision.
   */
  resolveTamper(chainId, action, reason) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    if (action !== 'restore' && action !== 'adopt') {
      throw new RelayError('invalid', 'action must be restore or adopt')
    }
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      throw new RelayError('invalid', 'reason must be a string')
    }
    return this.engine.resolveTamper({ chainId, action, reason: reason ?? undefined })
  }

  /**
   * Approve verify commands so the plugin may run them.
   * @param {string} chainId - chain identity.
   * @param {string[]} commands - exact command lines.
   * @returns {object} the approved commands.
   */
  approveCommands(chainId, commands) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.approveCommands({ chainId, commands })
  }

  /**
   * Confirm a delivered chain done.
   * @param {string} chainId - chain identity.
   * @returns {object} the new status.
   */
  acceptChain(chainId) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.acceptChain({ chainId })
  }

  /**
   * Send a delivered chain back to work.
   * @param {string} chainId - chain identity.
   * @param {string} reason - what is wrong with the delivery.
   * @returns {object} the new status.
   */
  rejectChain(chainId, reason) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.rejectChain({ chainId, reason })
  }

  /**
   * Open a new review session after the last one failed or got stuck.
   * @param {string} chainId - chain identity.
   * @returns {Promise<object>} the review start outcome.
   */
  restartReview(chainId) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.restartReview({ chainId })
  }

  /**
   * Move a stopped chain to its workspace's trash.
   * @param {string} chainId - chain identity.
   * @returns {object} deletion result.
   */
  deleteChain(chainId) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.deleteChain(chainId)
  }

  /**
   * Restore one deleted chain; it comes back stopped.
   * @param {string} chainId - chain identity.
   * @returns {object} restored facts.
   */
  restoreChain(chainId) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.restoreChain(chainId)
  }

  /**
   * Permanently remove one deleted chain.
   * @param {string} chainId - chain identity.
   * @returns {object} purge result.
   */
  purgeChain(chainId) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.purgeChain(chainId)
  }

  /**
   * Accept or revoke a human's acceptance of reduced coverage for one feature.
   * @param {string} chainId - chain identity.
   * @param {string} featureId - feature identity.
   * @param {boolean} accepted - true accepts, false revokes.
   * @returns {object} the updated progress.
   */
  acceptCoverage(chainId, featureId, accepted) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    if (typeof featureId !== 'string' || featureId.length === 0) {
      throw new RelayError('invalid', 'featureId is required')
    }
    if (typeof accepted !== 'boolean') {
      throw new RelayError('invalid', 'accepted must be a boolean')
    }
    return this.engine.acceptCoverage({ chainId, featureId, accepted })
  }

  /**
   * Accept reduced coverage for every passing feature that still lacks a
   * human signature, or only the named subset.
   * @param {string} chainId - chain identity.
   * @param {string[]} [featureIds] - optional subset; omit for every pending feature.
   * @returns {object} accepted count and progress.
   */
  acceptCoverageMany(chainId, featureIds) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.acceptCoverageMany({ chainId, featureIds })
  }

  /**
   * Raise a chain's handoff cap after it ran out.
   * @param {string} chainId - chain identity.
   * @param {number} maxHandoffs - the new cap.
   * @returns {object} the new status.
   */
  raiseHandoffLimit(chainId, maxHandoffs) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    if (!Number.isInteger(maxHandoffs) || maxHandoffs < 1 || maxHandoffs > 1000) {
      throw new RelayError('invalid', 'maxHandoffs must be an integer from 1 to 1000')
    }
    return this.engine.raiseHandoffLimit({ chainId, maxHandoffs })
  }

  /**
   * Clear a chain's blocker after a human did what it asked for.
   * @param {string} chainId - chain identity.
   * @returns {object} the new status.
   */
  clearBlocker(chainId) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.clearBlocker({ chainId })
  }

  /**
   * Take a delegated worker's unfinished features back to the chain.
   * @param {string} chainId - chain identity.
   * @param {string} sessionId - worker session.
   * @returns {object} the reclaimed features.
   */
  reclaimWorker(chainId, sessionId) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RelayError('invalid', 'sessionId is required')
    }
    return this.engine.reclaimDelegation({ chainId, sessionId })
  }

  /**
   * Search one chain's memory for lines containing every word of the query.
   * @param {string} chainId - chain identity.
   * @param {string} query - words to look for.
   * @returns {object} matches.
   */
  recall(chainId, query) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    return this.engine.recall({ chainId, query, limit: 50 })
  }

  /** The running configuration plus whether this Host can persist a change. */
  getConfig() {
    return {
      config: { ...this.engine.config },
      editable: this.engine.ctx.get('configEditor') !== undefined,
    }
  }

  /**
   * Validate a full config object and persist it to the profile patch.
   * The Loader reconciles the row, so the plugin reloads with the new values.
   * @param {object} config - complete configuration.
   * @returns {Promise<object>} the accepted configuration.
   */
  async saveConfig(config) {
    const editor = this.engine.ctx.get('configEditor')
    if (editor === undefined) {
      throw new RelayError('invalid', 'this Host cannot edit profile configuration')
    }
    const entry = editor.entries().find(candidate => candidate.options.id === 'longtask-relay')
    if (entry === undefined) {
      throw new RelayError('notFound', 'the longtask-relay row is not a uniquely addressed profile entry')
    }
    const resolved = resolveConfig(config)
    await editor.edit(entry, () => ({ ...resolved }))
    appendHostAudit({ kind: 'config.saved', actor: 'host', detail: { config: resolved } })
    return { config: resolved }
  }

  /**
   * Whether this package's git working tree is behind its upstream branch.
   * `entryId` is the profile entry a reload would toggle; null when the Host
   * cannot name it, in which case the user reloads from the plugin page.
   * @returns {Promise<object>} update facts.
   */
  async checkUpdate() {
    const check = await checkPluginUpdate()
    return { ...check, entryId: this.engine.ctx.fiber?.entry?.id ?? null }
  }

  /**
   * Fast-forward the working tree to its upstream branch.
   * @returns {Promise<object>} whether the tree changed and whether a reload is needed.
   */
  async applyUpdate() {
    const result = await applyPluginUpdate()
    return { ...result, entryId: this.engine.ctx.fiber?.entry?.id ?? null }
  }
}

Object.defineProperty(RelayRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: {
    version: 1,
    methods: METHODS.map(method => ({ method, invocation: { kind: 'direct' } })),
  },
})

/**
 * Publish the namespace on a Cordis context.
 * @param {object} ctx - plugin context.
 * @param {RelayRemote} service - the remote instance.
 */
export function provideRelay(ctx, service) {
  Object.defineProperty(service, 'typertRemote', {
    configurable: true,
    value: Object.freeze({ service, serviceKey: 'relay', namespace: 'relay' }),
  })
  ctx.provide('relay', service)
}
