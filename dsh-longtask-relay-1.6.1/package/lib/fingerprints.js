/**
 * Host-level fingerprint of each chain's feature list.
 *
 * The truth source lives in the workspace, so a session can edit `features.json`
 * directly. The fingerprint is kept outside the workspace (next to the chain
 * index) and records every frozen `id + title`; any later deletion, rename, or
 * unannounced addition is caught on the next checkpoint, handoff, or finish.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The profile's DSH home directory. */
function dshHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/** Feature fingerprints keyed by chain id. */
export class ChainFingerprints {
  /**
   * @param {string} homeDir - the DSH home directory.
   */
  constructor(homeDir) {
    this.file = join(homeDir, 'longtask-relay', 'fingerprints.json')
  }

  /** Default store under the running installation's home. */
  static default() {
    return new ChainFingerprints(dshHome())
  }

  /** Read the whole document, tolerating a missing or malformed file. */
  read() {
    let text
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return { version: 1, chains: {} }
    }
    let document
    try {
      document = JSON.parse(text)
    } catch {
      return { version: 1, chains: {} }
    }
    if (document === null || typeof document !== 'object'
      || document.chains === null || typeof document.chains !== 'object') {
      return { version: 1, chains: {} }
    }
    return document
  }

  /**
   * One chain's frozen list.
   * @param {string} chainId - chain identity.
   * @returns {{ features: Array<{ id: string, title: string }>, frozenAt: string }|undefined} fingerprint.
   */
  get(chainId) {
    const entry = this.read().chains[chainId]
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.features)) return undefined
    return entry
  }

  /**
   * Freeze or refresh one chain's list.
   * @param {string} chainId - chain identity.
   * @param {Array<{ id: string, title: string }>} features - frozen entries.
   * @returns {void}
   */
  set(chainId, features) {
    const document = this.read()
    document.version = 1
    document.chains[chainId] = {
      features: features.map(feature => ({ id: String(feature.id), title: String(feature.title) })),
      frozenAt: new Date().toISOString(),
    }
    this.write(document)
  }

  /**
   * Drop one chain's fingerprint.
   * @param {string} chainId - chain identity.
   * @returns {void}
   */
  remove(chainId) {
    const document = this.read()
    if (document.chains[chainId] === undefined) return
    delete document.chains[chainId]
    this.write(document)
  }

  /** Persist the document atomically. */
  write(document) {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
    renameSync(temporary, this.file)
  }
}
