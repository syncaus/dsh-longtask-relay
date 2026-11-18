/**
 * Chain metadata and the workspace truth source.
 *
 * Layout under `<cwd>/.relay/`:
 *
 * - `index.json`             — chain ids known in this directory
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
import { dirname, join, resolve } from 'node:path'

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
      // Session this feature is delegated to; null means the chain's own session.
      assignedSessionId: typeof entry.assignedSessionId === 'string' ? entry.assignedSessionId : null,
      notes: typeof entry.notes === 'string' ? entry.notes : '',
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
    const store = new ChainStore(join(resolve(cwd), root))
    // Keep the workspace root: a custom truthDir may be a subdirectory, so the
    // parent of truthDir is not necessarily the workspace.
    store.cwd = resolve(cwd)
    return store
  }

  /**
   * Per-chain file paths.
   * @param {string} chainId - chain identity.
   * @returns {{ dir: string, chain: string, features: string, progress: string, handoff: string }} paths.
   */
  paths(chainId) {
    requireChainId(chainId)
    const dir = join(this.truthDir, chainId)
    return {
      dir,
      chain: join(dir, 'relay.json'),
      features: join(dir, 'features.json'),
      progress: join(dir, 'PROGRESS.md'),
      handoff: join(dir, 'HANDOFF.md'),
      history: join(dir, 'history.md'),
      decisions: join(dir, 'decisions.md'),
      traps: join(dir, 'traps.md'),
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
   * Delete one chain's truth source and drop it from this directory's index.
   * @param {string} chainId - chain identity.
   * @returns {string} the removed directory.
   */
  remove(chainId) {
    const paths = this.paths(chainId)
    rmSync(paths.dir, { recursive: true, force: true })
    const known = this.listChainIds().filter(id => id !== chainId)
    writeAtomic(join(this.truthDir, 'index.json'), `${JSON.stringify({ version: 1, chains: known }, null, 2)}\n`)
    return paths.dir
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
      if (update.assignedSessionId !== undefined) {
        feature.assignedSessionId = update.assignedSessionId === null ? null : String(update.assignedSessionId)
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
    try {
      appendFileSync(this.paths(chainId).audit, `${JSON.stringify(record)}\n`)
    } catch (error) {
      throw new RelayError(RELAY_CODES.io, `cannot append audit for ${chainId}: ${error instanceof Error ? error.message : String(error)}`)
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
    if (!existsSync(path)) return []
    const take = Number.isInteger(limit) && limit > 0 ? limit : 100
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
 * Render the skeleton truth source for a new chain.
 * The initializer session replaces the placeholders; the files exist so every
 * later session can read them unconditionally.
 * @param {string} objective - task objective.
 * @returns {{ features: object, progress: string, handoff: string }} skeleton contents.
 */
export function skeletonTruth(objective) {
  return {
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
