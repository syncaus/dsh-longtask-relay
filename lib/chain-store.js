/**
 * Chain metadata and the workspace truth source.
 *
 * Layout under `<cwd>/.relay/`:
 *
 * - `index.json`             — chain ids known in this directory
 * - `.trash/<chainId>/`      — deleted chains kept for restore; never scanned as live
 * - `<chainId>/relay.json`   — plugin-owned chain metadata (sessions, status, counters)
 * - `<chainId>/features.json` — the task list; existing ids and titles are fixed, while
 *   `passes`, `evidence`, `coverage`, `acceptedBy`, and `notes` may change; discovered work is
 *   appended through `appendFeatures` with a reason
 * - `<chainId>/PROGRESS.md`  — Done / In progress / Next / Errors / Notes, rewritten every session
 * - `<chainId>/HANDOFF.md`   — the short brief the next session reads first
 *
 * Every write is synchronous and atomic (temp file + rename), which keeps a
 * crashed write from leaving a half-parsed truth source behind.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Stable error codes reported by tools. */
export const RELAY_CODES = Object.freeze({
  notFound: 'chain_not_found',
  invalid: 'truth_invalid',
  io: 'truth_io_failed',
  incomplete: 'features_incomplete',
  limit: 'handoff_limit',
  /** The calling session is not a member of the chain it tried to write. */
  notMember: 'not_chain_member',
  /** The calling session has been retired and may only read. */
  retired: 'session_retired',
  /** A delegated worker tried to do something only its chain head may do. */
  workerReadOnly: 'worker_read_only',
  /** features.json no longer matches the frozen list. */
  drift: 'features_drift',
  /** The session is mid-turn; the action needs it idle. */
  busy: 'session_busy',
  /** A sealed truth file was changed outside the plugin; a human must restore or adopt it. */
  tampered: 'truth_tampered',
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
const CHAIN_STATUSES = new Set(['planning', 'initializing', 'active', 'paused', 'reviewing', 'awaiting_acceptance', 'done', 'failed'])

/** Session roles persisted in `relay.json`. */
const SESSION_ROLES = new Set(['initializer', 'worker', 'reviewer', 'leader'])

/** Tail window read from an oversized audit log; older lines stay on disk. */
const AUDIT_TAIL_BYTES = 512 * 1024

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
 * Accepted coverage values for one feature.
 * `full` verifies the behaviour end to end; `partial` exercises only part of it
 * (one branch, one platform, one viewport, one subcommand); `smoke` only proves it
 * answers at all. Named for the depth of the check, so the values fit any project type.
 */
export const COVERAGES = new Set(['full', 'partial', 'smoke'])

/**
 * Coverage values written by earlier versions, mapped to the current names.
 * Chains created before the rename must keep their honesty: a feature recorded as
 * "error paths only" is partial coverage, never full.
 */
const LEGACY_COVERAGES = new Map([['error-path-only', 'partial']])

/**
 * Keep an optional list of non-empty strings (a cluster feature's `files` or `dependsOn`).
 * Lenient on purpose, because a model writes these by hand: a single string is a one-item list, and in an
 * array the non-empty strings are kept (trimmed) while anything else is dropped. When nothing usable remains
 * no field is emitted, so a plain relay feature stays byte-identical.
 * @param {unknown} value - candidate list.
 * @param {string} key - field name to emit.
 * @returns {object} `{ [key]: list }` when something usable remains, otherwise an empty object.
 */
function optionalStringList(value, key) {
  const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const list = items.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
  return list.length > 0 ? { [key]: list } : {}
}

/**
 * Normalize one coverage value, accepting the current names and the legacy ones.
 * @param {unknown} value - candidate value.
 * @returns {string} a current coverage name.
 */
function normalizeCoverage(value) {
  if (COVERAGES.has(value)) return value
  const legacy = LEGACY_COVERAGES.get(value)
  return legacy === undefined ? 'full' : legacy
}

/**
 * Keep one verification record written by the plugin, or null.
 * @param {unknown} value - candidate record.
 * @returns {object|null} normalized record.
 */
function normalizeVerification(value) {
  if (value === null || typeof value !== 'object' || typeof value.command !== 'string') return null
  return {
    command: value.command,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    timedOut: value.timedOut === true,
    durationMs: Number.isFinite(value.durationMs) ? value.durationMs : 0,
    outputTail: typeof value.outputTail === 'string' ? value.outputTail : '',
    head: typeof value.head === 'string' ? value.head : null,
    at: typeof value.at === 'string' ? value.at : null,
    by: 'plugin',
  }
}

/**
 * Normalize a feature list document, rejecting shapes the tools cannot trust.
 * Entries are preserved in order; unknown fields are dropped.
 * @param {unknown} document - parsed features.json.
 * @returns {{ version: 1, objective: string, statusCheck: string, verifyFast: string, verifyFull: string, features: Array<object> }} normalized document.
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
      coverage: normalizeCoverage(entry.coverage),
      acceptedBy: typeof entry.acceptedBy === 'string' ? entry.acceptedBy : null,
      // Stamped only by the panel acceptance path; finish requires it so a
      // hand-edited `human` does not release the coverage gate.
      acceptedAt: typeof entry.acceptedAt === 'string' ? entry.acceptedAt : null,
      // Session this feature is delegated to; null means the chain's own session.
      assignedSessionId: typeof entry.assignedSessionId === 'string' ? entry.assignedSessionId : null,
      notes: typeof entry.notes === 'string' ? entry.notes : '',
      // The plugin's own run of the verify command; a model cannot write it through the tools.
      verification: normalizeVerification(entry.verification),
      // Cluster planning scope: path prefixes the feature changes, and the feature ids it needs first.
      ...optionalStringList(entry.files, 'files'),
      ...optionalStringList(entry.dependsOn, 'dependsOn'),
    }
  })
  return {
    version: 1,
    objective: typeof document.objective === 'string' ? document.objective : '',
    // The three project commands live at the document root so every feature can reuse them.
    statusCheck: typeof document.statusCheck === 'string' ? document.statusCheck : '',
    verifyFast: typeof document.verifyFast === 'string' ? document.verifyFast : '',
    verifyFull: typeof document.verifyFull === 'string' ? document.verifyFull : '',
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
  // Partial coverage is work that passed but was not proven end to end.
  const partial = document.features.filter(feature => feature.passes && feature.coverage !== 'full' && feature.acceptedBy !== 'human')
  return {
    total: document.features.length,
    done: document.features.length - pending.length,
    pending,
    partial: partial.length,
  }
}

/** A chain id is `chain-` plus a UUID; the shape also guards recursive deletes. */
const CHAIN_ID_PATTERN = /^chain-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Whether a value is a well-formed chain id.
 * @param {unknown} value - candidate.
 * @returns {boolean} true for `chain-<uuid>`.
 */
export function isChainId(value) {
  return typeof value === 'string' && CHAIN_ID_PATTERN.test(value)
}

/**
 * Reject a malformed chain id before it reaches the filesystem.
 * @param {unknown} value - candidate.
 * @returns {string} the id.
 */
function requireChainId(value) {
  if (!isChainId(value)) throw new RelayError(RELAY_CODES.invalid, 'chainId must look like chain-<uuid>')
  return value
}

/** Reject a chain record this version cannot read. */
export function validateChain(record) {
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
    /**
     * Host-side seal check (see `seals.js`); the engine attaches it to every store it uses.
     * @type {import('./seals.js').TruthGuard|undefined}
     */
    this.guard = undefined
  }

  /**
   * Refuse a workspace write while the chain's sealed truth source is tampered.
   * @param {string} chainId - chain identity.
   */
  assertWritable(chainId) {
    this.guard?.assertWritable(chainId)
  }

  /**
   * Write one file without the seal check; only the tamper resolution uses it.
   * @param {string} path - destination file.
   * @param {string} text - complete new content.
   */
  writeRaw(path, text) {
    writeAtomic(path, text)
  }

  /**
   * Resolve the truth directory of a workspace.
   * @param {string} cwd - workspace directory.
   * @param {string} [root] - relative truth directory name, `.relay` by default.
   * @returns {ChainStore} store rooted there.
   */
  static forCwd(cwd, root = '.relay') {
    const store = new ChainStore(join(resolve(cwd), root))
    // Keep the workspace root: a custom truthDir may be a subdirectory, so the
    // parent of truthDir is not necessarily the workspace.
    store.cwd = resolve(cwd)
    return store
  }

  /**
   * Per-chain file paths.
   * @param {string} chainId - chain identity.
   * @returns {{ dir: string, chain: string, features: string, plan: string, progress: string, handoff: string, history: string, decisions: string, traps: string, audit: string }} paths.
   */
  paths(chainId) {
    requireChainId(chainId)
    const dir = join(this.truthDir, chainId)
    return {
      dir,
      chain: join(dir, 'relay.json'),
      features: join(dir, 'features.json'),
      plan: join(dir, 'PLAN.md'),
      spec: join(dir, 'SPEC.md'),
      progress: join(dir, 'PROGRESS.md'),
      handoff: join(dir, 'HANDOFF.md'),
      history: join(dir, 'history.md'),
      decisions: join(dir, 'decisions.md'),
      traps: join(dir, 'traps.md'),
      review: join(dir, 'REVIEW.md'),
      audit: join(dir, 'audit.jsonl'),
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
   * Where one deleted chain is kept.
   * @param {string} chainId - chain identity.
   * @returns {{ dir: string }} paths.
   */
  trashPaths(chainId) {
    requireChainId(chainId)
    return { dir: join(this.truthDir, '.trash', chainId) }
  }

  /**
   * Move a chain out of the live index and into `.trash`.
   * The truth source survives unchanged, so restoring it does not need a
   * snapshot. A failed index write leaves the moved directory in place and
   * lets the caller restore it and report the failure.
   * @param {string} chainId - chain identity.
   * @returns {string} the directory now holding the chain.
   */
  trash(chainId) {
    const paths = this.paths(chainId)
    const target = this.trashPaths(chainId).dir
    if (!existsSync(paths.dir)) {
      throw new RelayError(RELAY_CODES.notFound, `chain ${chainId} has no truth directory`)
    }
    if (existsSync(target)) {
      throw new RelayError(RELAY_CODES.io, `chain ${chainId} is already in the trash`)
    }
    try {
      mkdirSync(join(this.truthDir, '.trash'), { recursive: true })
      renameSync(paths.dir, target)
    } catch (error) {
      throw new RelayError(RELAY_CODES.io, `cannot move chain ${chainId} to the trash: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.ensureTrashIgnored()
    try {
      this.dropFromIndex(chainId)
    } catch (error) {
      // A moved directory with no index entry is invisible to the panel;
      // put it back so the caller can report a clean failure.
      try {
        renameSync(target, paths.dir)
      } catch {
        /* the caller still reports the index error */
      }
      throw error
    }
    return target
  }

  /**
   * Move a trashed chain back under its original id and re-register it.
   * @param {string} chainId - chain identity.
   * @returns {string} the restored directory.
   */
  restore(chainId) {
    const paths = this.paths(chainId)
    const source = this.trashPaths(chainId).dir
    if (!existsSync(source)) {
      throw new RelayError(RELAY_CODES.notFound, `chain ${chainId} is not in the trash`)
    }
    if (existsSync(paths.dir)) {
      throw new RelayError(RELAY_CODES.io, `chain ${chainId} already has a live truth directory`)
    }
    try {
      renameSync(source, paths.dir)
    } catch (error) {
      throw new RelayError(RELAY_CODES.io, `cannot restore chain ${chainId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      this.addToIndex(chainId)
    } catch (error) {
      try {
        renameSync(paths.dir, source)
      } catch {
        /* the caller still reports the index error */
      }
      throw error
    }
    return paths.dir
  }

  /**
   * Permanently remove one chain from the trash.
   * @param {string} chainId - chain identity.
   * @returns {string} the removed directory.
   */
  purgeTrash(chainId) {
    const target = this.trashPaths(chainId).dir
    if (!existsSync(target)) {
      throw new RelayError(RELAY_CODES.notFound, `chain ${chainId} is not in the trash`)
    }
    rmSync(target, { recursive: true, force: true })
    return target
  }

  /**
   * Whether a chain still has its trashed directory.
   * @param {string} chainId - chain identity.
   * @returns {boolean} true when the trash directory exists.
   */
  trashExists(chainId) {
    return existsSync(this.trashPaths(chainId).dir)
  }

  /** Add one chain id back to this directory's index. */
  addToIndex(chainId) {
    requireChainId(chainId)
    const known = this.listChainIds()
    if (known.includes(chainId)) return
    writeAtomic(join(this.truthDir, 'index.json'), `${JSON.stringify({ version: 1, chains: [...known, chainId] }, null, 2)}\n`)
  }

  /** Drop one chain id from this directory's index. */
  dropFromIndex(chainId) {
    const known = this.listChainIds().filter(id => id !== chainId)
    writeAtomic(join(this.truthDir, 'index.json'), `${JSON.stringify({ version: 1, chains: known }, null, 2)}\n`)
  }

  /**
   * Keep the trash out of a workspace that commits its truth source.
   * Advisory: a workspace without `.relay/.gitignore` gets one, but a failure
   * here must not undo a successful move.
   * @returns {void}
   */
  ensureTrashIgnored() {
    const file = join(this.truthDir, '.gitignore')
    try {
      const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const lines = text.split(/\r?\n/)
      if (lines.includes('.trash/')) return
      const next = text.length === 0 ? '.trash/\n' : `${text.replace(/\s*$/, '\n')}.trash/\n`
      writeAtomic(file, next)
    } catch {
      /* the ignore file is advisory */
    }
  }

  /**
   * Make sure the chain directory ignores the host-owned files.
   * `relay.json` and `audit.jsonl` change on every evaluation, so a workspace
   * that commits the truth source should not commit those.
   * @param {string} chainId - chain identity.
   * @returns {void}
   */
  ensureGitignore(chainId) {
    writeAtomic(join(this.paths(chainId).dir, '.gitignore'), 'relay.json\naudit.jsonl\n')
  }

  /**
   * Read one chain record.
   * @param {string} chainId - chain identity.
   * @returns {object|undefined} validated record, or undefined when absent.
   */
  readChain(chainId) {
    if (!isChainId(chainId)) return undefined
    if (this.guard === undefined) {
      const record = readJson(this.paths(chainId).chain)
      return record === undefined ? undefined : validateChain(record)
    }
    let record
    let unreadable = false
    try {
      const raw = readJson(this.paths(chainId).chain)
      record = raw === undefined ? undefined : validateChain(raw)
    } catch (error) {
      if (!(error instanceof RelayError) || error.code !== RELAY_CODES.invalid) throw error
      // An unreadable record with no seal behind it is reported as before.
      const sealed = this.guard.seals.get(chainId)
      if (sealed === undefined || sealed.relay === null || sealed.truthDir !== this.truthDir) throw error
      unreadable = true
    }
    return this.guard.filterChain(chainId, record, this, { unreadable })
  }
  /**
   * Persist one chain record and register it in the index.
   * @param {object} record - complete validated record.
   */
  writeChain(record) {
    const paths = this.paths(record.chainId)
    this.assertWritable(record.chainId)
    mkdirSync(paths.dir, { recursive: true })
    writeAtomic(paths.chain, `${JSON.stringify(record, null, 2)}\n`)
    this.guard?.sealChain(record.chainId, record, this)
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
      pausedBy: null,
      wrapupAt: null,
      readyAt: null,
      readySessionId: null,
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
    if (this.guard === undefined || !this.guard.armed(chainId)) return this.readFeaturesUnguarded(chainId)
    let document
    try {
      document = this.readFeaturesUnguarded(chainId)
    } catch (error) {
      if (!(error instanceof RelayError) || error.code !== RELAY_CODES.invalid) throw error
      document = undefined
    }
    return this.guard.filterFeatures(chainId, document, this)
  }

  /**
   * Read the feature list as it is on disk, without the seal check.
   * @param {string} chainId - chain identity.
   * @returns {object|undefined} normalized document, or undefined when absent.
   */
  readFeaturesUnguarded(chainId) {
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
    this.assertWritable(chainId)
    writeAtomic(this.paths(chainId).features, `${JSON.stringify(normalized, null, 2)}\n`)
    this.guard?.sealFeatures(chainId, normalized)
    return normalized
  }

  /**
   * Change only the mutable fields of existing features.
   * Adding, removing, or renaming an entry is refused here, so a session cannot
   * quietly shrink the definition of done; genuinely new work goes through
   * `appendFeatures`, which records why the initializer missed it.
   * @param {string} chainId - chain identity.
   * @param {Array<{ id: string, passes?: boolean, evidence?: string|null, notes?: string, coverage?: string, acceptedBy?: string|null }>} updates - field patches.
   * @returns {{ total: number, done: number, pending: Array<object> }} progress after the change.
   */
  patchFeatures(chainId, updates) {
    const document = this.readFeatures(chainId)
    if (document === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chainId} has no features.json`)
    const byId = new Map(document.features.map(feature => [feature.id, feature]))
    for (const update of updates) {
      const feature = byId.get(update.id)
      if (feature === undefined) {
        throw new RelayError(RELAY_CODES.invalid, `feature ${update.id} does not exist; use addFeatures to append new work`)
      }
      if (update.passes !== undefined) feature.passes = update.passes === true
      if (update.evidence !== undefined) feature.evidence = update.evidence === null ? null : String(update.evidence)
      if (update.notes !== undefined) feature.notes = String(update.notes)
      if (update.coverage !== undefined) {
        if (!COVERAGES.has(update.coverage)) {
          throw new RelayError(RELAY_CODES.invalid, `coverage must be one of ${[...COVERAGES].join(', ')}`)
        }
        feature.coverage = update.coverage
      }
      if (update.acceptedBy !== undefined) {
        feature.acceptedBy = update.acceptedBy === null ? null : String(update.acceptedBy)
      }
      if (update.acceptedAt !== undefined) {
        feature.acceptedAt = update.acceptedAt === null ? null : String(update.acceptedAt)
      }
      if (update.assignedSessionId !== undefined) {
        feature.assignedSessionId = update.assignedSessionId === null ? null : String(update.assignedSessionId)
      }
      if (update.verification !== undefined) feature.verification = normalizeVerification(update.verification)
      if (update.verify !== undefined) {
        // A verify command may be filled in once; changing an existing one is a human decision.
        if (feature.verify.trim().length > 0 && feature.verify !== update.verify) {
          throw new RelayError(RELAY_CODES.invalid, `feature ${update.id} already has a verify command; a human changes it in the panel`)
        }
        feature.verify = String(update.verify)
      }
    }
    return featureProgress(this.writeFeatures(chainId, document))
  }

  /**
   * Append features the initializer did not know about.
   * Appending is the only structural change a session may make: ids may never repeat,
   * existing entries are never renamed or reordered, and the caller must say why the
   * feature was missed, so the miss stays visible in the truth source.
   * @param {string} chainId - chain identity.
   * @param {Array<{ id: string, title: string, priority?: number, verify?: string, notes?: string }>} entries - new features.
   * @param {string} reason - why these features were not in the initial list.
   * @returns {{ appended: Array<string>, total: number, done: number, pending: Array<object> }} progress after the change.
   */
  appendFeatures(chainId, entries, reason) {
    const document = this.readFeatures(chainId)
    if (document === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chainId} has no features.json`)
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'appending features needs a non-empty reason')
    }
    const known = new Set(document.features.map(feature => feature.id))
    const appended = []
    for (const entry of entries) {
      const id = requireString(entry?.id, 'addFeatures[].id')
      if (known.has(id)) throw new RelayError(RELAY_CODES.invalid, `feature ${id} already exists`)
      known.add(id)
      appended.push(id)
      document.features.push({
        id,
        title: requireString(entry?.title, `addFeatures[${id}].title`),
        priority: Number.isInteger(entry?.priority) ? entry.priority : document.features.length,
        passes: false,
        evidence: null,
        verify: typeof entry?.verify === 'string' ? entry.verify : '',
        coverage: normalizeCoverage(entry?.coverage),
        acceptedBy: null,
        assignedSessionId: null,
        notes: typeof entry?.notes === 'string' ? entry.notes : '',
        ...optionalStringList(entry?.files, 'files'),
        ...optionalStringList(entry?.dependsOn, 'dependsOn'),
      })
    }
    const progress = featureProgress(this.writeFeatures(chainId, document))
    const stamp = new Date().toISOString()
    this.writeProgress(chainId, `${this.readProgress(chainId).replace(/\s*$/, '\n')}- [${stamp}] added ${appended.join(', ')} — ${reason.trim()}\n`)
    return { appended, ...progress }
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
    this.assertWritable(chainId)
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
    this.assertWritable(chainId)
    writeAtomic(this.paths(chainId).handoff, String(text ?? ''))
  }

  /**
   * Read the handoff history this plugin appends on every handoff.
   * @param {string} chainId - chain identity.
   * @returns {string} current text, possibly empty.
   */
  readHistory(chainId) {
    return readText(this.paths(chainId).history)
  }

  /**
   * Append one block to the handoff history, creating it when missing.
   * @param {string} chainId - chain identity.
   * @param {string} text - block text without the trailing newline.
   * @returns {void}
   */
  appendHistory(chainId, text) {
    const body = String(text ?? '').trim()
    if (body.length === 0) return
    this.assertWritable(chainId)
    const file = this.paths(chainId).history
    let current = ''
    try {
      current = readFileSync(file, 'utf8')
    } catch {
      current = '# Handoff history\n'
    }
    writeAtomic(file, `${current.replace(/\s*$/, '\n\n')}${body}\n`)
  }

  /**
   * Write one truth-source text file that the session owns (decisions, traps).
   * @param {string} file - absolute path from `paths()`.
   * @param {string} text - complete new content.
   */
  writeText(file, text) {
    const chainId = basename(dirname(resolve(file)))
    if (isChainId(chainId)) this.assertWritable(chainId)
    writeAtomic(file, String(text ?? ''))
  }

  /**
   * Append one block to an append-only truth file, creating it when missing.
   * @param {string} chainId - chain identity.
   * @param {'decisions'|'traps'} kind - which ledger.
   * @param {string} text - block text without the trailing newline.
   * @returns {void}
   */
  appendLedger(chainId, kind, text) {
    const file = this.paths(chainId)[kind]
    if (typeof file !== 'string') throw new RelayError(RELAY_CODES.invalid, `unknown ledger ${String(kind)}`)
    const body = text === undefined ? '' : String(text).trim()
    if (body.length === 0) return
    this.assertWritable(chainId)
    let current = ''
    try {
      current = readFileSync(file, 'utf8')
    } catch {
      current = `# ${kind === 'decisions' ? 'Decisions' : 'Traps'}\n`
    }
    writeAtomic(file, `${current.replace(/\s*$/, '\n\n')}${body}\n`)
  }

  /**
   * Append one audit record.
   * The log is append-only JSON Lines: one self-contained event per line, so a
   * truncated tail cannot corrupt earlier history.
   * @param {string} chainId - chain identity.
   * @param {{ kind: string, actor?: string, detail?: object }} event - what happened.
   * @returns {object} the written record, including its timestamp.
   */
  appendAudit(chainId, event) {
    const record = {
      at: new Date().toISOString(),
      kind: requireString(event?.kind, 'audit.kind'),
      ...(typeof event.actor === 'string' && event.actor.length > 0 ? { actor: event.actor } : {}),
      ...(event.detail === undefined ? {} : { detail: event.detail }),
    }
    // The host copy is the one a session cannot edit; it is written first so a
    // workspace failure does not lose the record.
    let hostError
    if (this.guard !== undefined) {
      try {
        this.guard.seals.appendAudit(chainId, record)
      } catch (error) {
        hostError = error
      }
    }
    try {
      appendFileSync(this.paths(chainId).audit, `${JSON.stringify(record)}\n`)
    } catch (error) {
      throw new RelayError(RELAY_CODES.io, `cannot append audit for ${chainId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (hostError !== undefined) {
      throw new RelayError(RELAY_CODES.io, `cannot append the host audit copy for ${chainId}: ${hostError instanceof Error ? hostError.message : String(hostError)}`)
    }
    return record
  }

  /**
   * Read the newest audit records.
   * A very large log is read from the tail only; an incomplete first line from
   * that read is skipped rather than failing the whole call.
   * @param {string} chainId - chain identity.
   * @param {number} [limit] - newest records to return.
   * @returns {Array<object>} records, oldest first within the returned window.
   */
  readAudit(chainId, limit = 100) {
    const path = this.paths(chainId).audit
    const take = Number.isInteger(limit) && limit > 0 ? limit : 100
    // The host copy wins: the workspace log can be edited or deleted by a session.
    if (this.guard !== undefined) {
      let hosted
      try {
        hosted = this.guard.seals.readAudit(chainId, take)
      } catch (error) {
        throw new RelayError(RELAY_CODES.io, `cannot read the host audit for ${chainId}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (hosted !== undefined) return hosted
    }
    if (!existsSync(path)) return []
    let text
    try {
      const size = statSync(path).size
      if (size <= AUDIT_TAIL_BYTES) {
        text = readFileSync(path, 'utf8')
      } else {
        const fd = openSync(path, 'r')
        try {
          const buffer = Buffer.alloc(AUDIT_TAIL_BYTES)
          readSync(fd, buffer, 0, AUDIT_TAIL_BYTES, size - AUDIT_TAIL_BYTES)
          text = buffer.toString('utf8')
        } finally {
          closeSync(fd)
        }
      }
    } catch (error) {
      throw new RelayError(RELAY_CODES.io, `cannot read audit for ${chainId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const records = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        /* a truncated head line from a tail read */
      }
    }
    return records.slice(-take)
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
   * Drop one chain from the index, keeping every other entry.
   * @param {string} chainId - chain identity.
   * @returns {void}
   */
  forget(chainId) {
    const known = this.entries().filter(entry => entry.chainId !== chainId)
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
 * Host-level index of deleted chains kept in their workspace's `.trash`.
 *
 * The live `ChainIndex` forgets a deleted chain, so this file is how the panel
 * and a session tab find it afterwards. It is a tombstone, not a second truth
 * source: the chain's files stay under `<truthDir>/.trash/<chainId>`.
 */
export class ChainTrashIndex {
  /**
   * @param {string} homeDir - the DSH home directory.
   */
  constructor(homeDir) {
    this.file = join(homeDir, 'longtask-relay', 'trash.json')
  }

  /** Default index under the running installation's home. */
  static default() {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
    return new ChainTrashIndex(home)
  }

  /** Read the stored entries, tolerating fields this version does not know. */
  entries() {
    const document = readJson(this.file)
    if (document === undefined) return []
    if (document === null || typeof document !== 'object' || !Array.isArray(document.chains)) {
      throw new RelayError(RELAY_CODES.invalid, `${this.file} needs a chains array`)
    }
    return document.chains
      .filter(entry => entry !== null && typeof entry === 'object'
        && isChainId(entry.chainId) && typeof entry.truthDir === 'string')
      .map(entry => ({
        ...entry,
        sessions: Array.isArray(entry.sessions)
          ? entry.sessions.filter(sessionId => typeof sessionId === 'string')
          : [],
      }))
  }

  /**
   * One deleted chain.
   * @param {string} chainId - chain identity.
   * @returns {object|undefined} entry.
   */
  find(chainId) {
    return this.entries().find(entry => entry.chainId === chainId)
  }

  /**
   * The deleted chain one session belonged to.
   * @param {string} sessionId - session identity.
   * @returns {object|undefined} entry.
   */
  findSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    return this.entries().find(entry => entry.sessions.includes(sessionId))
  }

  /**
   * Record one deleted chain, replacing an earlier entry with the same id.
   * @param {object} entry - chain facts captured before the move.
   * @returns {void}
   */
  remember(entry) {
    requireChainId(entry?.chainId)
    if (typeof entry.truthDir !== 'string' || entry.truthDir.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'trash entry needs a truthDir')
    }
    const known = this.entries().filter(candidate => candidate.chainId !== entry.chainId)
    known.push({
      chainId: entry.chainId,
      truthDir: entry.truthDir,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      title: typeof entry.title === 'string' ? entry.title : '',
      objective: typeof entry.objective === 'string' ? entry.objective : '',
      status: typeof entry.status === 'string' ? entry.status : 'paused',
      deletedAt: typeof entry.deletedAt === 'string' ? entry.deletedAt : new Date().toISOString(),
      sessions: Array.isArray(entry.sessions)
        ? entry.sessions.filter(sessionId => typeof sessionId === 'string')
        : [],
      featuresDone: Number.isInteger(entry.featuresDone) ? entry.featuresDone : 0,
      featuresTotal: Number.isInteger(entry.featuresTotal) ? entry.featuresTotal : 0,
    })
    try {
      mkdirSync(dirname(this.file), { recursive: true })
    } catch (error) {
      throw new RelayError(RELAY_CODES.io, `cannot create ${dirname(this.file)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    writeAtomic(this.file, `${JSON.stringify({ version: 1, chains: known }, null, 2)}\n`)
  }

  /**
   * Drop one deleted chain from the index.
   * @param {string} chainId - chain identity.
   * @returns {void}
   */
  forget(chainId) {
    const known = this.entries().filter(entry => entry.chainId !== chainId)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
    } catch (error) {
      throw new RelayError(RELAY_CODES.io, `cannot create ${dirname(this.file)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    writeAtomic(this.file, `${JSON.stringify({ version: 1, chains: known }, null, 2)}\n`)
  }
}

/**
 * Render the skeleton truth source for a new chain.
 * The initializer session replaces the placeholders; the files exist so every
 * later session can read them unconditionally.
 * @param {string} objective - task objective.
 * @returns {{ features: object, plan: string, decisions: string, traps: string, history: string, progress: string, handoff: string }} skeleton contents.
 */
export function skeletonTruth(objective) {
  return {
    plan: '# PLAN\n\nThe initializer writes the plan this chain follows here. A plan approved in plan mode goes in verbatim.\n',
    spec: `# SPEC\n\nObjective: ${objective}\n\nThe planning session of a cluster fills this in with the requirements and acceptance criteria.\n`,
    features: {
      version: 1,
      objective,
      statusCheck: '',
      verifyFast: '',
      verifyFull: '',
      features: [],
    },
    decisions: '# Decisions\n\nAppend-only. One block per decision: what was decided, why, and what would make it wrong.\n',
    traps: '# Traps\n\nAppend-only. One line per trap that cost real time; include the exact command or syntax that bit.\n',
    history: '# Handoff history\n\nAppend-only. The plugin writes the previous handoff brief here on every handoff, so earlier sessions stay searchable.\n',
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
