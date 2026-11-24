/**
 * Host-side seals of each chain's truth source.
 *
 * The truth source lives in the workspace, so a session (or a person) can edit
 * `relay.json`, `features.json`, `PLAN.md`, or `SPEC.md` without going through
 * the plugin. Every plugin write refreshes a copy kept outside the workspace;
 * every read compares the file on disk with that copy. A difference is recorded
 * as tampering: reads return the sealed copy, workspace writes for the chain are
 * refused, and only a human decision in the panel (restore or adopt) clears it.
 *
 * Contents are compared in canonical form (JSON with sorted keys, text with LF
 * line endings and no outer whitespace), so a checkout that rewrites line
 * endings is not tampering.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The profile's DSH home directory. */
function dshHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/** Tail window read from an oversized host audit log. */
const AUDIT_TAIL_BYTES = 512 * 1024

/**
 * JSON text with object keys sorted at every level.
 * @param {unknown} value - JSON value.
 * @returns {string} canonical text.
 */
export function canonicalJson(value) {
  const walk = (input) => {
    if (Array.isArray(input)) return input.map(walk)
    if (input !== null && typeof input === 'object') {
      const out = {}
      for (const key of Object.keys(input).sort()) {
        if (input[key] !== undefined) out[key] = walk(input[key])
      }
      return out
    }
    return input
  }
  return JSON.stringify(walk(value))
}

/**
 * Text with LF line endings and no outer whitespace.
 * @param {unknown} text - file text.
 * @returns {string} canonical text.
 */
export function canonicalText(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').trim()
}

/** Sealed files and how the panel names them. */
export const SEALED_FILES = Object.freeze(['relay.json', 'features.json', 'PLAN.md', 'SPEC.md'])

/** One chain's seal, as persisted. */
function emptyEntry(chainId) {
  return {
    version: 1,
    chainId,
    relay: null,
    features: null,
    plan: null,
    spec: null,
    armedAt: null,
    approvedCommands: [],
    tamper: null,
    trashed: false,
  }
}

/** Seals keyed by chain id, one file per chain under the DSH home. */
export class SealStore {
  /**
   * @param {string} homeDir - the DSH home directory.
   */
  constructor(homeDir) {
    this.dir = join(homeDir, 'longtask-relay', 'seals')
    this.auditDir = join(homeDir, 'longtask-relay', 'audit')
    /** @type {Map<string, object>} */
    this.cache = new Map()
  }

  /** Default store under the running installation's home. */
  static default() {
    return new SealStore(dshHome())
  }

  /** Path of one chain's seal file. */
  file(chainId) {
    return join(this.dir, `${chainId}.json`)
  }

  /**
   * One chain's seal, or undefined when none was written yet.
   * A malformed file reads as missing: the next read re-seals from disk and the
   * audit records it, which is the same path an upgraded installation takes.
   * @param {string} chainId - chain identity.
   * @returns {object|undefined} seal entry.
   */
  get(chainId) {
    const cached = this.cache.get(chainId)
    if (cached !== undefined) return cached
    let entry
    try {
      entry = JSON.parse(readFileSync(this.file(chainId), 'utf8'))
    } catch {
      return undefined
    }
    if (entry === null || typeof entry !== 'object' || entry.chainId !== chainId) return undefined
    const normalized = { ...emptyEntry(chainId), ...entry }
    if (!Array.isArray(normalized.approvedCommands)) normalized.approvedCommands = []
    this.cache.set(chainId, normalized)
    return normalized
  }

  /**
   * Persist one chain's seal atomically.
   * @param {object} entry - complete entry.
   * @returns {object} the entry.
   */
  put(entry) {
    mkdirSync(this.dir, { recursive: true })
    const file = this.file(entry.chainId)
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`)
    renameSync(temporary, file)
    this.cache.set(entry.chainId, entry)
    return entry
  }

  /**
   * Change one chain's seal, creating it when missing.
   * @param {string} chainId - chain identity.
   * @param {(entry: object) => void} mutate - synchronous change.
   * @returns {object} the stored entry.
   */
  update(chainId, mutate) {
    const entry = { ...(this.get(chainId) ?? emptyEntry(chainId)) }
    entry.approvedCommands = [...(entry.approvedCommands ?? [])]
    mutate(entry)
    return this.put(entry)
  }

  /** Drop one chain's seal and host audit copy. */
  remove(chainId) {
    this.cache.delete(chainId)
    rmSync(this.file(chainId), { force: true })
    rmSync(join(this.auditDir, `${chainId}.jsonl`), { force: true })
  }

  /**
   * Append one audit record to the host copy.
   * @param {string} chainId - chain identity.
   * @param {object} record - complete audit record.
   */
  appendAudit(chainId, record) {
    mkdirSync(this.auditDir, { recursive: true })
    appendFileSync(join(this.auditDir, `${chainId}.jsonl`), `${JSON.stringify(record)}\n`)
  }

  /**
   * Newest host audit records, or undefined when this chain has no host copy.
   * @param {string} chainId - chain identity.
   * @param {number} limit - newest records to return.
   * @returns {Array<object>|undefined} records, oldest first.
   */
  readAudit(chainId, limit) {
    const path = join(this.auditDir, `${chainId}.jsonl`)
    if (!existsSync(path)) return undefined
    const size = statSync(path).size
    let text
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
    const records = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        /* a truncated head line from a tail read */
      }
    }
    return records.slice(-limit)
  }
}

/** Raised by the guard when a write would land on a tampered chain. */
export const TAMPERED_CODE = 'truth_tampered'

/**
 * Read one workspace file as text, or undefined when it does not exist.
 * @param {string} path - absolute path.
 * @returns {string|undefined} text.
 */
function readMaybe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Compares the workspace truth source with its seal on every read.
 * One instance per engine; every store the engine touches carries it.
 */
export class TruthGuard {
  /**
   * @param {SealStore} seals - seal store.
   * @param {{
   *   isFrozen?: (chainId: string) => boolean,
   *   onTamper?: (chainId: string, files: Array<string>, store: object) => void,
   *   onSealed?: (chainId: string, store: object, detail: object) => void,
   *   makeError: (code: string, message: string) => Error,
   * }} hooks - engine callbacks.
   */
  constructor(seals, hooks) {
    this.seals = seals
    this.hooks = hooks
    /** Last stat seen per sealed document, so unchanged files are not hashed again. @type {Map<string, string>} */
    this.docStats = new Map()
  }

  /** The current tamper record of one chain, or null. */
  tamperOf(chainId) {
    return this.seals.get(chainId)?.tamper ?? null
  }

  /**
   * Refuse a workspace write for a chain with unresolved tampering.
   * @param {string} chainId - chain identity.
   */
  assertWritable(chainId) {
    const tamper = this.tamperOf(chainId)
    if (tamper === null) return
    throw this.hooks.makeError(
      TAMPERED_CODE,
      `the truth source of ${chainId} was changed outside the plugin (${tamper.files.join(', ')}); `
      + 'a human must restore or adopt it in the panel before the chain can continue',
    )
  }

  /**
   * Record tampering of the named files once.
   * @param {string} chainId - chain identity.
   * @param {Array<string>} files - file names from {@link SEALED_FILES}.
   * @param {object} store - the store that found it.
   */
  flag(chainId, files, store) {
    const before = this.tamperOf(chainId)
    const known = new Set(before?.files ?? [])
    const added = files.filter(file => !known.has(file))
    if (added.length === 0) return
    const tamper = {
      detectedAt: before?.detectedAt ?? new Date().toISOString(),
      files: [...known, ...added],
    }
    this.seals.update(chainId, (entry) => { entry.tamper = tamper })
    try {
      this.hooks.onTamper?.(chainId, added, store)
    } catch {
      /* the seal already holds the record; the callback only reacts to it */
    }
  }

  /**
   * Seal a chain record the plugin just wrote.
   * @param {string} chainId - chain identity.
   * @param {object} record - the record written.
   */
  sealChain(chainId, record, store) {
    this.seals.update(chainId, (entry) => {
      entry.relay = canonicalJson(record)
      entry.truthDir = store.truthDir
    })
  }

  /**
   * Seal a feature list the plugin just wrote, once the list is armed.
   * @param {string} chainId - chain identity.
   * @param {object} document - the normalized document written.
   */
  sealFeatures(chainId, document) {
    const entry = this.seals.get(chainId)
    if (entry === undefined || entry.features === null) return
    this.seals.update(chainId, (next) => { next.features = canonicalJson(document) })
  }

  /**
   * Start sealing the feature list and the design documents.
   * @param {string} chainId - chain identity.
   * @param {object} store - chain store.
   * @returns {void}
   */
  arm(chainId, store) {
    const paths = store.paths(chainId)
    const features = store.readFeaturesUnguarded(chainId)
    const plan = readMaybe(paths.plan)
    const spec = readMaybe(paths.spec)
    this.seals.update(chainId, (entry) => {
      entry.features = features === undefined ? canonicalJson(null) : canonicalJson(features)
      entry.plan = plan === undefined ? null : canonicalText(plan)
      entry.spec = spec === undefined ? null : canonicalText(spec)
      entry.armedAt = new Date().toISOString()
    })
    this.docStats.delete(paths.plan)
    this.docStats.delete(paths.spec)
  }

  /**
   * Whether a chain's list and documents are sealed.
   * @param {string} chainId - chain identity.
   * @returns {boolean} true once armed.
   */
  armed(chainId) {
    const entry = this.seals.get(chainId)
    return entry !== undefined && entry.features !== null
  }

  /**
   * Compare a chain record read from disk with its seal.
   * A chain with no seal is sealed from disk here (first read after an upgrade).
   * @param {string} chainId - chain identity.
   * @param {object|undefined} disk - validated record from disk, or undefined when the file is missing or unreadable.
   * @param {object} store - chain store.
   * @param {{ unreadable?: boolean }} [state] - whether the file exists but could not be parsed.
   * @returns {object|undefined} the record to trust.
   */
  filterChain(chainId, disk, store, state = {}) {
    const entry = this.seals.get(chainId)
    if (entry === undefined || entry.relay === null) {
      if (disk === undefined) return undefined
      this.sealChain(chainId, disk, store)
      const frozen = this.hooks.isFrozen?.(chainId) === true
      if (frozen) this.arm(chainId, store)
      try {
        this.hooks.onSealed?.(chainId, store, { migrated: true, features: frozen })
      } catch {
        /* advisory */
      }
      return disk
    }
    // A chain moved to the trash is gone from its directory on purpose.
    if (entry.trashed === true) return disk
    // Another store probing for this id, or a workspace that moved: absence there is not tampering.
    if (entry.truthDir !== undefined && entry.truthDir !== store.truthDir) {
      if (disk === undefined) return undefined
      if (canonicalJson(disk) === entry.relay) this.seals.update(chainId, (next) => { next.truthDir = store.truthDir })
      else return disk
    }
    const sealed = JSON.parse(entry.relay)
    if (disk === undefined || state.unreadable === true || canonicalJson(disk) !== entry.relay) {
      this.flag(chainId, ['relay.json'], store)
      this.checkDocuments(chainId, store, entry)
      return sealed
    }
    this.checkDocuments(chainId, store, entry)
    return disk
  }

  /**
   * Compare PLAN.md and SPEC.md with their seals, hashing only after a stat change.
   * @param {string} chainId - chain identity.
   * @param {object} store - chain store.
   * @param {object} entry - seal entry.
   */
  checkDocuments(chainId, store, entry) {
    if (entry.features === null) return
    const paths = store.paths(chainId)
    const changed = []
    for (const [name, path, sealed] of [['PLAN.md', paths.plan, entry.plan], ['SPEC.md', paths.spec, entry.spec]]) {
      if (sealed === null) continue
      let stamp = 'missing'
      try {
        const stat = statSync(path)
        stamp = `${stat.mtimeMs}:${stat.size}`
      } catch {
        /* a deleted document is a change */
      }
      const key = `${path}`
      const previous = this.docStats.get(key)
      if (previous === stamp && !(entry.tamper?.files ?? []).includes(name)) continue
      this.docStats.set(key, stamp)
      const text = readMaybe(path)
      if (text === undefined || canonicalText(text) !== sealed) changed.push(name)
    }
    if (changed.length > 0) this.flag(chainId, changed, store)
  }

  /**
   * Compare a feature list read from disk with its seal.
   * @param {string} chainId - chain identity.
   * @param {object|undefined} disk - normalized document, or undefined when missing or unreadable.
   * @param {object} store - chain store.
   * @returns {object|undefined} the document to trust.
   */
  filterFeatures(chainId, disk, store) {
    const entry = this.seals.get(chainId)
    if (entry === undefined || entry.features === null || entry.trashed === true) return disk
    if (entry.truthDir !== undefined && entry.truthDir !== store.truthDir) return disk
    const sealed = JSON.parse(entry.features)
    if (disk === undefined || canonicalJson(disk) !== entry.features) {
      this.flag(chainId, ['features.json'], store)
      return sealed === null ? undefined : sealed
    }
    return disk
  }

  /**
   * What the panel shows for an unresolved tamper: each file's sealed and disk text.
   * @param {string} chainId - chain identity.
   * @param {object} store - chain store.
   * @returns {{ detectedAt: string, files: Array<{ file: string, sealed: string, disk: string|null }> }|null} detail.
   */
  tamperDetail(chainId, store) {
    const entry = this.seals.get(chainId)
    const tamper = entry?.tamper ?? null
    if (tamper === null) return null
    const paths = store.paths(chainId)
    const pretty = text => (text === null ? '' : JSON.stringify(JSON.parse(text), null, 2))
    const files = tamper.files.map((file) => {
      if (file === 'relay.json') return { file, sealed: pretty(entry.relay), disk: readMaybe(paths.chain) ?? null }
      if (file === 'features.json') return { file, sealed: pretty(entry.features), disk: readMaybe(paths.features) ?? null }
      if (file === 'PLAN.md') return { file, sealed: entry.plan ?? '', disk: readMaybe(paths.plan) ?? null }
      return { file, sealed: entry.spec ?? '', disk: readMaybe(paths.spec) ?? null }
    })
    return { detectedAt: tamper.detectedAt, files }
  }

  /**
   * Put the sealed copies back on disk and clear the tamper record.
   * @param {string} chainId - chain identity.
   * @param {object} store - chain store.
   * @returns {Array<string>} restored files.
   */
  restore(chainId, store) {
    const entry = this.seals.get(chainId)
    const tamper = entry?.tamper ?? null
    if (tamper === null) return []
    const paths = store.paths(chainId)
    for (const file of tamper.files) {
      if (file === 'relay.json') store.writeRaw(paths.chain, `${JSON.stringify(JSON.parse(entry.relay), null, 2)}\n`)
      else if (file === 'features.json') store.writeRaw(paths.features, `${JSON.stringify(JSON.parse(entry.features), null, 2)}\n`)
      else if (file === 'PLAN.md') store.writeRaw(paths.plan, `${entry.plan}\n`)
      else if (file === 'SPEC.md') store.writeRaw(paths.spec, `${entry.spec}\n`)
    }
    this.seals.update(chainId, (next) => { next.tamper = null })
    this.docStats.clear()
    return tamper.files
  }

  /**
   * Accept the files on disk as the new sealed state and clear the tamper record.
   * The caller validates the disk content first; this only re-seals it.
   * @param {string} chainId - chain identity.
   * @param {{ relay?: object, features?: object, plan?: string, spec?: string }} accepted - validated disk content.
   * @returns {Array<string>} adopted files.
   */
  adopt(chainId, accepted) {
    const entry = this.seals.get(chainId)
    const tamper = entry?.tamper ?? null
    if (tamper === null) return []
    this.seals.update(chainId, (next) => {
      if (accepted.relay !== undefined) next.relay = canonicalJson(accepted.relay)
      if (accepted.features !== undefined) next.features = canonicalJson(accepted.features)
      if (accepted.plan !== undefined) next.plan = canonicalText(accepted.plan)
      if (accepted.spec !== undefined) next.spec = canonicalText(accepted.spec)
      next.tamper = null
    })
    this.docStats.clear()
    return tamper.files
  }

  /** Mark a chain as moved to (or back from) the trash. */
  setTrashed(chainId, trashed) {
    if (this.seals.get(chainId) === undefined) return
    this.seals.update(chainId, (entry) => { entry.trashed = trashed === true })
  }

  /** Commands a human approved for one chain. */
  approvedCommands(chainId) {
    return new Set(this.seals.get(chainId)?.approvedCommands ?? [])
  }

  /**
   * Record a human's approval of verification commands.
   * @param {string} chainId - chain identity.
   * @param {Array<string>} commands - exact command lines.
   */
  approveCommands(chainId, commands) {
    this.seals.update(chainId, (entry) => {
      const known = new Set(entry.approvedCommands)
      for (const command of commands) known.add(command)
      entry.approvedCommands = [...known]
    })
  }
}
