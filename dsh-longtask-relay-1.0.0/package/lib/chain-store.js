/**
 * Chain metadata and the workspace truth source.
 *
 * Layout under `<cwd>/.relay/`:
 *
 * - `index.json`             — chain ids known in this directory
 * - `<chainId>/relay.json`   — plugin-owned chain metadata (sessions, status, counters)
 * - `<chainId>/features.json`— the task list; only `passes`, `evidence`, and `notes` may change
 * - `<chainId>/PROGRESS.md`  — Done / In progress / Next / Errors / Notes, rewritten every session
 * - `<chainId>/HANDOFF.md`   — the short brief the next session reads first
 *
 * Every write is synchronous and atomic (temp file + rename), which keeps a
 * crashed write from leaving a half-parsed truth source behind.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Stable error codes reported by tools. */
export const RELAY_CODES = Object.freeze({
  notFound: 'chain_not_found',
  invalid: 'truth_invalid',
  io: 'truth_io_failed',
  incomplete: 'features_incomplete',
  limit: 'handoff_limit',
})

/** A failure a tool can report without leaking an implementation error. */
export class RelayError extends Error {
  /**
   * @param {string} code - stable code from {@link RELAY_CODES}.
   * @param {string} message - human-readable explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'RelayError'
    this.code = code
  }
}

/** Chain phases persisted in `relay.json`. */
const CHAIN_STATUSES = new Set(['initializing', 'active', 'paused', 'done', 'failed'])

/** Session roles persisted in `relay.json`. */
const SESSION_ROLES = new Set(['initializer', 'worker', 'reviewer', 'leader'])

/**
 * Write UTF-8 text atomically.
 * @param {string} path - destination file.
 * @param {string} text - complete new content.
 */
function writeAtomic(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    throw new RelayError(RELAY_CODES.io, `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Read a JSON file, returning undefined when it does not exist.
 * @param {string} path - file to read.
 * @returns {unknown} parsed value, or undefined.
 */
function readJson(path) {
  if (!existsSync(path)) return undefined
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new RelayError(RELAY_CODES.io, `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new RelayError(RELAY_CODES.invalid, `${path} is not valid JSON`)
  }
}

/**
 * Read a UTF-8 text file, returning an empty string when it does not exist.
 * @param {string} path - file to read.
 * @returns {string} file content.
 */
function readText(path) {
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new RelayError(RELAY_CODES.io, `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Require a non-empty string field.
 * @param {unknown} value - candidate.
 * @param {string} field - name for the message.
 * @returns {string} the value.
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RelayError(RELAY_CODES.invalid, `${field} must be a non-empty string`)
  }
  return value
}

/**
 * Normalize a feature list document, rejecting shapes the tools cannot trust.
 * Entries are preserved in order; unknown fields are dropped.
 * @param {unknown} document - parsed features.json.
 * @returns {{ version: 1, objective: string, features: Array<object> }} normalized document.
 */
export function normalizeFeatures(document) {
  if (document === null || typeof document !== 'object') {
    throw new RelayError(RELAY_CODES.invalid, 'features.json must be an object')
  }
  const features = document.features
  if (!Array.isArray(features)) throw new RelayError(RELAY_CODES.invalid, 'features.json needs a features array')
  const seen = new Set()
  const normalized = features.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new RelayError(RELAY_CODES.invalid, `features[${index}] must be an object`)
    }
    const id = requireString(entry.id, `features[${index}].id`)
    if (seen.has(id)) throw new RelayError(RELAY_CODES.invalid, `duplicate feature id ${id}`)
    seen.add(id)
    return {
      id,
      title: requireString(entry.title, `features[${index}].title`),
      priority: Number.isInteger(entry.priority) ? entry.priority : index,
      passes: entry.passes === true,
      evidence: typeof entry.evidence === 'string' ? entry.evidence : null,
      verify: typeof entry.verify === 'string' ? entry.verify : '',
      notes: typeof entry.notes === 'string' ? entry.notes : '',
    }
  })
  return {
    version: 1,
    objective: typeof document.objective === 'string' ? document.objective : '',
    features: normalized,
  }
}

/**
 * Count progress over a normalized feature list.
 * @param {{ features: Array<{ passes: boolean }> }} document - normalized features.
 * @returns {{ total: number, done: number, pending: Array<object> }} progress.
 */
export function featureProgress(document) {
  const pending = document.features.filter(feature => !feature.passes)
  return { total: document.features.length, done: document.features.length - pending.length, pending }
}

/** Reject a chain record this version cannot read. */
function validateChain(record) {
  if (record === null || typeof record !== 'object') throw new RelayError(RELAY_CODES.invalid, 'relay.json must be an object')
  if (record.version !== 1) throw new RelayError(RELAY_CODES.invalid, `unsupported relay.json version ${String(record.version)}`)
  requireString(record.chainId, 'relay.json chainId')
  if (!CHAIN_STATUSES.has(record.status)) throw new RelayError(RELAY_CODES.invalid, `unknown chain status ${String(record.status)}`)
  if (!Array.isArray(record.sessions)) throw new RelayError(RELAY_CODES.invalid, 'relay.json needs a sessions array')
  for (const session of record.sessions) {
    if (session === null || typeof session !== 'object') throw new RelayError(RELAY_CODES.invalid, 'session entry must be an object')
    requireString(session.sessionId, 'session.sessionId')
    if (!SESSION_ROLES.has(session.role)) throw new RelayError(RELAY_CODES.invalid, `unknown session role ${String(session.role)}`)
  }
  return record
}

/** Chain store rooted at one workspace's `.relay` directory. */
export class ChainStore {
  /**
   * @param {string} truthDir - absolute path of the `.relay` directory.
   */
  constructor(truthDir) {
    this.truthDir = resolve(truthDir)
  }

  /**
   * Resolve the truth directory of a workspace.
   * @param {string} cwd - workspace directory.
   * @param {string} [root] - relative truth directory name, `.relay` by default.
   * @returns {ChainStore} store rooted there.
   */
  static forCwd(cwd, root = '.relay') {
    return new ChainStore(join(resolve(cwd), root))
  }

  /**
   * Per-chain file paths.
   * @param {string} chainId - chain identity.
   * @returns {{ dir: string, chain: string, features: string, progress: string, handoff: string }} paths.
   */
  paths(chainId) {
    const dir = join(this.truthDir, chainId)
    return {
      dir,
      chain: join(dir, 'relay.json'),
      features: join(dir, 'features.json'),
      progress: join(dir, 'PROGRESS.md'),
      handoff: join(dir, 'HANDOFF.md'),
    }
  }

  /** Ensure the truth root exists. */
  ensureRoot() {
    try {
      mkdirSync(this.truthDir, { recursive: true })
    } catch (error) {
      throw new RelayError(RELAY_CODES.io, `cannot create ${this.truthDir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Chain ids recorded in `index.json`.
   * @returns {string[]} known chain ids.
   */
  listChainIds() {
    const index = readJson(join(this.truthDir, 'index.json'))
    if (index === undefined) return []
    if (index === null || typeof index !== 'object' || !Array.isArray(index.chains)) {
      throw new RelayError(RELAY_CODES.invalid, 'index.json needs a chains array')
    }
    return index.chains.filter(chainId => typeof chainId === 'string')
  }

  /**
   * Read one chain record.
   * @param {string} chainId - chain identity.
   * @returns {object|undefined} validated record, or undefined when absent.
   */
  readChain(chainId) {
    const record = readJson(this.paths(chainId).chain)
    return record === undefined ? undefined : validateChain(record)
  }

  /**
   * Persist one chain record and register it in the index.
   * @param {object} record - complete validated record.
   */
  writeChain(record) {
    const paths = this.paths(record.chainId)
    mkdirSync(paths.dir, { recursive: true })
    writeAtomic(paths.chain, `${JSON.stringify(record, null, 2)}\n`)
    const known = this.listChainIds()
    if (!known.includes(record.chainId)) {
      const index = { version: 1, chains: [...known, record.chainId] }
      writeAtomic(join(this.truthDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
    }
  }

  /**
   * Create a chain with an empty truth source.
   * @param {{ objective: string, title?: string, cwd: string, maxHandoffs?: number }} options - chain inputs.
   * @returns {object} the created record.
   */
  create({ objective, title, cwd, maxHandoffs = 32 }) {
    this.ensureRoot()
    const chainId = `chain-${randomUUID()}`
    const now = new Date().toISOString()
    const record = {
      version: 1,
      chainId,
      objective: requireString(objective, 'objective'),
      title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : objective.trim().slice(0, 40),
      cwd,
      truthDir: this.truthDir,
      status: 'initializing',
      createdAt: now,
      updatedAt: now,
      maxHandoffs,
      handoffCount: 0,
      sessions: [],
      currentSessionId: null,
      pendingHandoff: null,
      lastError: null,
    }
    this.writeChain(record)
    return record
  }

  /**
   * Apply an in-place change to one chain and persist it.
   * @param {string} chainId - chain identity.
   * @param {(record: object) => void} mutate - synchronous mutation.
   * @returns {object} the updated record.
   */
  update(chainId, mutate) {
    const record = this.readChain(chainId)
    if (record === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chainId} does not exist`)
    mutate(record)
    record.updatedAt = new Date().toISOString()
    this.writeChain(record)
    return record
  }

  /**
   * Read the feature list.
   * @param {string} chainId - chain identity.
   * @returns {object|undefined} normalized document, or undefined when absent.
   */
  readFeatures(chainId) {
    const document = readJson(this.paths(chainId).features)
    return document === undefined ? undefined : normalizeFeatures(document)
  }

  /**
   * Write the feature list after validation.
   * @param {string} chainId - chain identity.
   * @param {object} document - candidate document.
   * @returns {object} the normalized document written.
   */
  writeFeatures(chainId, document) {
    const normalized = normalizeFeatures(document)
    writeAtomic(this.paths(chainId).features, `${JSON.stringify(normalized, null, 2)}\n`)
    return normalized
  }

  /**
   * Change only the mutable fields of existing features.
   * Adding, removing, or renaming an entry is refused, so a session cannot
   * shrink the definition of done.
   * @param {string} chainId - chain identity.
   * @param {Array<{ id: string, passes?: boolean, evidence?: string|null, notes?: string }>} updates - field patches.
   * @returns {{ total: number, done: number, pending: Array<object> }} progress after the change.
   */
  patchFeatures(chainId, updates) {
    const document = this.readFeatures(chainId)
    if (document === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chainId} has no features.json`)
    const byId = new Map(document.features.map(feature => [feature.id, feature]))
    for (const update of updates) {
      const feature = byId.get(update.id)
      if (feature === undefined) {
        throw new RelayError(RELAY_CODES.invalid, `feature ${update.id} does not exist; entries cannot be added by a session`)
      }
      if (update.passes !== undefined) feature.passes = update.passes === true
      if (update.evidence !== undefined) feature.evidence = update.evidence === null ? null : String(update.evidence)
      if (update.notes !== undefined) feature.notes = String(update.notes)
    }
    return featureProgress(this.writeFeatures(chainId, document))
  }

  /**
   * Read the progress note.
   * @param {string} chainId - chain identity.
   * @returns {string} current text, possibly empty.
   */
  readProgress(chainId) {
    return readText(this.paths(chainId).progress)
  }

  /**
   * Replace the progress note.
   * @param {string} chainId - chain identity.
   * @param {string} text - complete new content.
   */
  writeProgress(chainId, text) {
    writeAtomic(this.paths(chainId).progress, String(text ?? ''))
  }

  /**
   * Read the handoff brief.
   * @param {string} chainId - chain identity.
   * @returns {string} current text, possibly empty.
   */
  readHandoff(chainId) {
    return readText(this.paths(chainId).handoff)
  }

  /**
   * Replace the handoff brief.
   * @param {string} chainId - chain identity.
   * @param {string} text - complete new content.
   */
  writeHandoff(chainId, text) {
    writeAtomic(this.paths(chainId).handoff, String(text ?? ''))
  }

  /**
   * Snapshot everything a handoff prompt or the panel needs.
   * @param {string} chainId - chain identity.
   * @returns {{ chain: object, features: object|undefined, progress: string, handoff: string }} truth snapshot.
   */
  readTruth(chainId) {
    const chain = this.readChain(chainId)
    if (chain === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chainId} does not exist`)
    return {
      chain,
      features: this.readFeatures(chainId),
      progress: this.readProgress(chainId),
      handoff: this.readHandoff(chainId),
    }
  }
}

/**
 * Host-level index of every chain this installation has created.
 *
 * The in-memory map only survives one plugin lifetime, and a chain's workspace
 * can differ from the session's workspace, so neither the session working
 * directory nor a per-workspace `.relay/index.json` can rediscover every chain
 * after a reload. This file closes that gap and is what the panel lists.
 */
export class ChainIndex {
  /**
   * @param {string} homeDir - the DSH home directory.
   */
  constructor(homeDir) {
    this.file = join(homeDir, 'longtask-relay', 'index.json')
  }

  /** Default index under the running installation's home. */
  static default() {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
    return new ChainIndex(home)
  }

  /** Read the stored entries. */
  entries() {
    const document = readJson(this.file)
    if (document === undefined) return []
    if (document === null || typeof document !== 'object' || !Array.isArray(document.chains)) {
      throw new RelayError(RELAY_CODES.invalid, `${this.file} needs a chains array`)
    }
    return document.chains.filter(entry => entry !== null && typeof entry === 'object'
      && typeof entry.chainId === 'string' && typeof entry.truthDir === 'string')
  }

  /**
   * Remember one chain, replacing an earlier entry with the same id.
   * @param {{ chainId: string, truthDir: string, cwd: string, title?: string, updatedAt?: string }} chain - chain facts.
   */
  remember(chain) {
    const known = this.entries().filter(entry => entry.chainId !== chain.chainId)
    known.push({
      chainId: chain.chainId,
      truthDir: chain.truthDir,
      cwd: chain.cwd,
      title: chain.title ?? '',
      updatedAt: chain.updatedAt ?? new Date().toISOString(),
    })
    try {
      mkdirSync(dirname(this.file), { recursive: true })
    } catch (error) {
      throw new RelayError(RELAY_CODES.io, `cannot create ${dirname(this.file)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    writeAtomic(this.file, `${JSON.stringify({ version: 1, chains: known }, null, 2)}\n`)
  }

  /**
   * Truth directory of one chain.
   * @param {string} chainId - chain identity.
   * @returns {string|undefined} recorded truth directory.
   */
  locate(chainId) {
    return this.entries().find(entry => entry.chainId === chainId)?.truthDir
  }
}

/**
 * Render the skeleton truth source for a new chain.
 * The initializer session replaces the placeholders; the files exist so every
 * later session can read them unconditionally.
 * @param {string} objective - task objective.
 * @returns {{ features: object, progress: string, handoff: string }} skeleton contents.
 */
export function skeletonTruth(objective) {
  return {
    features: { version: 1, objective, features: [] },
    progress: [
      '# PROGRESS',
      '',
      '## Done',
      '',
      '## In progress',
      '',
      '## Next',
      '',
      '## Errors',
      '',
      '## Notes',
      '',
    ].join('\n'),
    handoff: [
      '# HANDOFF',
      '',
      'Not written yet. The initializer session fills this in before the first handoff.',
      '',
    ].join('\n'),
  }
}
