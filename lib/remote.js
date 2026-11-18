/**
 * Host Remote namespace `relay`.
 *
 * The profile cannot import the Typert protocol package, so the binding and
 * the method marker are written by hand. The Gateway's source fallback reads
 * parameter names from the method signature, which is why every method here
 * takes plain identifiers and never a destructured object.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { RelayError } from './chain-store.js'
import { resolveConfig } from './config.js'

/**
 * Append one host-level audit record for an action that belongs to no chain.
 * Failure is advisory: an audit gap must not block the action itself.
 * @param {{ kind: string, actor?: string, detail?: object }} event - what happened.
 */
function appendHostAudit(event) {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const file = join(home, 'longtask-relay', 'audit.jsonl')
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
  'listChains', 'chainDetail', 'chainAudit', 'sessionView', 'setPaused', 'handoffNow', 'finishChain', 'deleteChain', 'acceptCoverage', 'raiseHandoffLimit', 'getConfig', 'saveConfig',
]

/** Relay Remote over the engine. */
export class RelayRemote {
  /**
   * @param {import('./engine.js').RelayEngine} engine - relay engine.
   */
  constructor(engine) {
    this.engine = engine
  }

  /** Every chain this Host knows about. */
  listChains() {
    return { chains: this.engine.status() }
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
   * Finish a chain after checking its features.
   * @param {string} chainId - chain identity.
   * @param {string} evidence - how the objective was verified.
   * @returns {object} finish result.
   */
  finishChain(chainId, evidence) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError('invalid', 'chainId is required')
    }
    if (typeof evidence !== 'string' || evidence.trim().length === 0) {
      throw new RelayError('invalid', 'evidence is required')
    }
    return this.engine.finish({ chainId, evidence })
  }

  /**
   * Delete a stopped chain and its truth source.
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
