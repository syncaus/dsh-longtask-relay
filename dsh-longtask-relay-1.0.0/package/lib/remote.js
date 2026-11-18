/**
 * Host Remote namespace `relay`.
 *
 * The profile cannot import the Typert protocol package, so the binding and
 * the method marker are written by hand. The Gateway's source fallback reads
 * parameter names from the method signature, which is why every method here
 * takes plain identifiers and never a destructured object.
 */
import { RelayError } from './chain-store.js'

/** Descriptor key the Gateway reads from the service prototype. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Methods exposed to the browser. */
const METHODS = ['listChains', 'chainDetail', 'setPaused', 'handoffNow', 'finishChain']

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
    return this.engine.handoffNow({ chainId })
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
