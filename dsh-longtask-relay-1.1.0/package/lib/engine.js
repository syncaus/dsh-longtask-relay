/**
 * Relay engine: chain membership, the supervisor, and the handoff.
 *
 * One engine instance lives for the plugin's lifetime. It owns the in-memory
 * view (which session belongs to which chain, per-session pressure counters)
 * and re-reads the truth source for anything durable, so a restarted Host
 * rebuilds the same picture from the files on disk.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { ChainIndex, ChainStore, RELAY_CODES, RelayError, featureProgress, isChainId, skeletonTruth } from './chain-store.js'
import { ChainFingerprints } from './fingerprints.js'
import { evidenceIssue } from './evidence.js'
import { sessionTitle } from './labels.js'
import {
  renderClusterGroupOpenedNotice, renderClusterLaunchedNotice, renderClusterPlanningPrompt,
  renderContinuePrompt, renderDelegationPrompt, renderHandoffPrompt, renderInitializerPrompt,
  renderReclaimNotice, renderRetireNotice, renderWorkerWrapupPrompt, renderWrapupPrompt,
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
 * @param {{ progress?: { total: number, done: number }, stall?: { minutes: number }|null, conflicts?: Array<object> }} [state] - readings the panel shows beside the record.
 * @returns {object} summary.
 */
function chainSummary(chain, { progress, stall = null, conflicts = [] } = {}) {
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
    createdAt: chain.createdAt ?? null,
    updatedAt: chain.updatedAt,
    // Where the current session stands between "working" and "handed off".
    wrapupAt: chain.wrapupAt ?? null,
    readyAt: chain.readyAt ?? null,
    handoffPending: chain.pendingHandoff !== null && chain.pendingHandoff !== undefined,
    lastError: chain.lastError,
    blocker: chain.blocker ?? null,
    pausedBy: chain.pausedBy ?? null,
    // How much of the finished work is actually proven: a feature that only reached its
    // error paths still counts as done, but the panel and status must show the gap.
    coveragePartial: progress?.partial ?? 0,
    // `cluster` chains plan first and wait for a human to confirm the parallel launch.
    mode: chain.mode ?? 'relay',
    launchPending: chain.status === 'planning' && Array.isArray(chain.launchPlan?.groups) && chain.launchPlan.launchedAt === undefined,
    // A head that is running but has not touched the truth source for a while is
    // either inside one long command or stuck; status alone cannot tell them apart.
    stall,
    // Paths another chain in the same workspace is also working on.
    conflicts,
  }
}

/**
 * Canonical form of a feature scope path, so the spellings a model mixes compare equal:
 * forward slashes, no empty or `.` segments, `..` resolved against the previous segment, lower case.
 * A relative path is resolved against the working directory first; the result is relative to that directory
 * when it ends up inside it, and `/`-rooted otherwise, so a location outside never equals a relative one.
 * @param {string} path - path or directory prefix from a feature's `files`.
 * @param {string} [cwd] - the chain's working directory.
 * @returns {string} comparable path; empty for the working directory itself.
 */
function scopePath(path, cwd) {
  const resolve = (value, base) => {
    const text = String(value).replace(/\\/g, '/')
    const absolute = text.startsWith('/') || /^[a-zA-Z]:/.test(text)
    const segments = []
    for (const segment of [...(absolute ? [] : base), ...text.split('/')]) {
      if (segment === '' || segment === '.') continue
      if (segment === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
      else segments.push(segment)
    }
    return segments
  }
  const hasCwd = typeof cwd === 'string' && cwd.length > 0
  const base = hasCwd ? resolve(cwd, []).map(segment => segment.toLowerCase()) : []
  const list = resolve(path, base)
  // The boundary matters: `proj2/x` is not under `proj`.
  if (hasCwd && base.length <= list.length && base.every((segment, index) => list[index].toLowerCase() === segment)) {
    return list.slice(base.length).join('/').toLowerCase()
  }
  const absolute = /^[/\\]/.test(String(path)) || /^[a-zA-Z]:/.test(String(path))
  if (hasCwd || absolute) return `/${list.join('/')}`.toLowerCase()
  return list.join('/').toLowerCase()
}

/**
 * The covering path when two scope lists meet: a path equal on both sides, or a directory that holds one from the other.
 * @param {Array<string>} left - canonical paths of one feature.
 * @param {Array<string>} right - canonical paths of the other.
 * @returns {string|undefined} the covering path, or undefined when the scopes are apart.
 */
function overlapPath(left, right) {
  for (const a of left) {
    for (const b of right) {
      // An empty path is the working directory, which holds everything.
      if (a === b || a === '' || b.startsWith(`${a}/`)) return a
      if (b === '' || a.startsWith(`${b}/`)) return b
    }
  }
  return undefined
}

/**
 * Comparable form of a workspace path, so two chains count as sharing one
 * workspace across slash direction and trailing separators.
 * @param {string} cwd - the chain's working directory.
 * @returns {string|null} the key, or null when the directory is unknown.
 */
function workspaceKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  return cwd.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

/**
 * The paths one chain's unfinished features claim.
 * A feature that already passes is done work, and a feature without `files`
 * claims nothing, so neither can collide with another chain.
 * @param {{ features?: Array<object> }|undefined} document - features document.
 * @param {string} cwd - the chain's working directory, to resolve relative scopes.
 * @returns {Array<{ id: string, paths: Array<string> }>} claims.
 */
function claimsOf(document, cwd) {
  const claims = []
  for (const feature of document?.features ?? []) {
    if (feature.passes === true) continue
    const files = Array.isArray(feature.files) ? feature.files : []
    if (files.length === 0) continue
    claims.push({ id: feature.id, paths: files.map(file => scopePath(file, cwd)) })
  }
  return claims
}

/**
 * Where a proposed cluster launch would put two sessions on the same files.
 * Different `shared` groups collide: they work in one directory at the same time. A shared group also
 * collides with the work the planning session keeps, compared as one pseudo group `main`: the features of
 * `worktree` groups (not opened in this version) and the ungrouped features that are neither passing nor
 * delegated. Features inside one group run in order and cannot collide. A feature without `files` could touch
 * anything, so a scopeless feature in a shared group is reported as an unknown scope (`main` is not).
 * @param {{ features: Array<{ id: string, files?: Array<string>, passes?: boolean, assignedSessionId?: string|null }> }} document - normalized features.
 * @param {Array<{ id: string, isolation: string, features: Array<string> }>} groups - validated groups.
 * @param {string} [cwd] - the chain's working directory, to read absolute scope paths against.
 * @returns {Array<object>} conflicts: `overlap` (path equal or one a directory prefix of the other; `path` is the
 *   covering one) once per feature pair, and `unknown-scope` per scopeless feature in a shared group.
 */
export function clusterConflicts(document, groups, cwd) {
  const byId = new Map(document.features.map(feature => [feature.id, feature]))
  const scopes = new Map(document.features.map(feature => [feature.id, (feature.files ?? []).map(file => scopePath(file, cwd))]))
  const scopeOf = id => scopes.get(id) ?? []
  const shared = groups.filter(group => group.isolation === 'shared')
  const grouped = new Set(groups.flatMap(group => group.features))
  const kept = [
    ...groups.filter(group => group.isolation === 'worktree').flatMap(group => group.features),
    ...document.features
      .filter(feature => !grouped.has(feature.id) && !feature.passes
        && (typeof feature.assignedSessionId !== 'string' || feature.assignedSessionId.length === 0))
      .map(feature => feature.id),
  ]
  const conflicts = []
  const others = [...shared.map(group => ({ id: group.id, features: group.features })), { id: 'main', features: kept }]
  for (let a = 0; a < shared.length; a += 1) {
    for (let b = a + 1; b < others.length; b += 1) {
      for (const idA of shared[a].features) {
        for (const idB of others[b].features) {
          const path = overlapPath(scopeOf(idA), scopeOf(idB))
          if (path !== undefined) conflicts.push({ kind: 'overlap', groups: [shared[a].id, others[b].id], features: [idA, idB], path })
        }
      }
    }
  }
  for (const group of shared) {
    for (const id of group.features) {
      const files = byId.get(id)?.files
      if (!Array.isArray(files) || files.length === 0) conflicts.push({ kind: 'unknown-scope', groups: [group.id], features: [id] })
    }
  }
  return conflicts
}

/** Why a worktree group is not opened yet; the planning session works its features in order. */
const WORKTREE_UNAVAILABLE = 'worktree isolation is not available yet; the planning session works these features in order'

/**
 * Clock slack for the legacy freshness check, in milliseconds.
 * A file's mtime comes from the filesystem clock and can read a few
 * milliseconds earlier than a `Date` taken before the write.
 */
const HANDOFF_MTIME_SLACK_MS = 1000

/**
 * Fingerprint of a handoff brief's content.
 * Line endings and outer whitespace are ignored, so a checkout that rewrites
 * line endings does not look like a session rewriting the brief.
 * @param {unknown} text - brief text.
 * @returns {string} sha256 hex digest.
 */
function handoffHash(text) {
  return createHash('sha256').update(String(text ?? '').replace(/\r\n/g, '\n').trim()).digest('hex')
}

/**
 * Fingerprint of a small file's content, for change detection.
 * A file time is not enough: two writes inside one tick of the filesystem
 * clock carry the same mtime, so a changed file can look untouched.
 * @param {string} file - absolute path.
 * @returns {string} sha256 hex digest, or `0` when the file cannot be read.
 */
function contentStamp(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return '0'
  }
}

/** Prefix that marks a blocker as owned by a blocked goal, not by the model. */
const GOAL_BLOCKER_PREFIX = 'goal blocked:'

/** Prefix of the blocker recorded when a session used up its automatic continuations. */
const CONTINUE_LIMIT_BLOCKER_PREFIX = 'auto-continue limit'

/** Process-local per-session supervisor state. */
function newStats() {
  return {
    compactions: 0,
    wrapupSentAt: 0,
    lastEvaluatedAt: 0,
    peakRatio: 0,
    ready: false,
    blocked: false,
    /** Automatic continuations sent to this session. */
    autoContinues: 0,
    /** When the last automatic continuation was sent. */
    lastContinueAt: 0,
    /** Whether the durable compaction count was read into this counter. */
    hydrated: false,
    /** Whether the goal re-arm was already attempted for this session load. */
    rearmChecked: false,
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
    /** Pending re-evaluations keyed by session id. @type {Map<string, { handle: object, due: number }>} */
    this.timers = new Map()
    /** Sessions already known not to belong to any chain, so locate skips the scan. @type {Set<string>} */
    this.misses = new Set()
    /** Last `status()` payload and the file signature it was built from. */
    this.statusCache = null
    /** Chains currently handing off. @type {Set<string>} */
    this.busyChains = new Set()
    /** Cross-lifetime chain index. */
    this.chainIndex = options.chainIndex ?? ChainIndex.default()
    /** Host-level frozen feature lists. */
    this.fingerprints = options.fingerprints ?? ChainFingerprints.default()
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
   * Give a created session the permission preset of the session it continues.
   * A DSH preset bundles the sandbox mode with the approval policy; a new
   * session is pinned to the user's default preset at creation, so without this
   * a chain started under full access loses it at the first handoff.
   * A `custom` combination has no name to switch to and is left alone.
   * @param {object} chain - chain record, for the audit.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object|undefined} source - the live session being continued.
   * @param {object|undefined} created - the created live session.
   * @returns {string|undefined} the preset that was carried over, when any.
   */
  inheritPermission(chain, store, source, created) {
    if (!this.config.inheritPermission || source === undefined || created === undefined) return undefined
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined || typeof presets.current !== 'function' || typeof presets.set !== 'function') return undefined
    try {
      let preset = presets.current(source.session)
      if (preset === 'custom') {
        // The plugin's approval override is the only way the plugin itself
        // produces `custom`: it changes the approval side right after a preset
        // is carried over. When the override would not have changed the recorded
        // preset, the user changed the session and that choice is not undone.
        // A user tightening the sandbox on a session where the override did
        // apply cannot be told apart through this service.
        const recorded = chain.sessions.find(session => session.sessionId === source.id)?.permissionPreset
        const overridden = typeof recorded === 'string' && recorded.length > 0
          && this.config.workerApproval !== 'inherit'
          && (typeof presets.resolve !== 'function' || presets.resolve(recorded)?.approval !== this.config.workerApproval)
        if (!overridden) {
          this.warn(`session ${source.id} uses a custom sandbox and approval combination; ${created.id} keeps the default preset`)
          return undefined
        }
        preset = recorded
      }
      if (presets.current(created.session) === preset) return preset
      presets.set(created.session, preset)
      this.record(store, chain.chainId, {
        kind: 'session.permission',
        actor: 'system',
        detail: { sessionId: created.id, from: source.id, preset },
      })
      return preset
    } catch (error) {
      this.warn(`could not carry the permission preset to ${created.id}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
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
    if (this.misses.has(session.id)) return undefined
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
        const normalized = this.normalizeLocation(chain, store)
        this.remember(normalized, store)
        this.misses.delete(session.id)
        return { chain: normalized, store }
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
          const normalized = this.normalizeLocation(chain, indexed)
          this.members.set(session.id, { chainId: normalized.chainId, truthDir: indexed.truthDir })
          this.misses.delete(session.id)
          return { chain: normalized, store: indexed }
        }
      }
    } catch (error) {
      this.warn(`cannot scan the chain index for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.misses.add(session.id)
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

  /**
   * Freeze the feature list the first time it is accepted.
   * Before this point the chain stays `initializing` and the initializer may
   * still edit freely; afterwards ids and titles are fixed.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {string} [actor] - session that triggered the freeze.
   * @returns {boolean} whether this call froze the list.
   */
  freezeFeatures(chain, store, actor) {
    // A cluster chain keeps editing its list while it plans; `launchCluster` freezes it.
    if (chain.status === 'planning') return false
    const document = store.readFeatures(chain.chainId)
    if (document === undefined || document.features.length === 0) return false
    const snapshot = document.features.map(feature => ({ id: feature.id, title: feature.title }))
    if (this.fingerprints.get(chain.chainId) !== undefined) return false
    this.fingerprints.set(chain.chainId, snapshot)
    if (chain.status === 'initializing') {
      store.update(chain.chainId, record => { record.status = 'active' })
    }
    this.record(store, chain.chainId, {
      kind: 'features.frozen',
      actor: actor ?? 'system',
      detail: { features: snapshot.length },
    })
    return true
  }

  /**
   * Refresh the fingerprint after an announced append.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @returns {void}
   */
  updateFingerprint(chain, store) {
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) return
    this.fingerprints.set(chain.chainId, document.features.map(feature => ({ id: feature.id, title: feature.title })))
  }

  /**
   * Refuse an operation when features.json no longer matches the frozen list.
   * Deletions, renames, and unannounced additions are the three ways a session
   * can quietly change what "done" means, so all three are reported.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @returns {void}
   */
  verifyFrozen(chain, store) {
    // Nothing is frozen while a cluster chain plans, even when a failed launch left a fingerprint behind.
    if (chain.status === 'planning') return
    const stored = this.fingerprints.get(chain.chainId)
    if (stored === undefined) return
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) return
    const current = new Map(document.features.map(feature => [feature.id, feature.title]))
    const expected = new Map(stored.features.map(feature => [feature.id, feature.title]))
    const missing = [...expected.keys()].filter(id => !current.has(id))
    const renamed = [...expected.entries()]
      .filter(([id, title]) => current.has(id) && current.get(id) !== title)
      .map(([id]) => id)
    const added = [...current.keys()].filter(id => !expected.has(id))
    if (missing.length === 0 && renamed.length === 0 && added.length === 0) return
    const detail = { missing, renamed, added }
    try {
      this.record(store, chain.chainId, { kind: 'features.drift', actor: 'system', detail })
    } catch {
      /* the audit is advisory; the refusal below is the contract */
    }
    throw new RelayError(
      RELAY_CODES.drift,
      `features.json no longer matches the frozen list (missing: ${missing.join(', ') || '-'}; `
      + `renamed: ${renamed.join(', ') || '-'}; added: ${added.join(', ') || '-'}); `
      + 'new work must be appended with relay_checkpoint addFeatures',
    )
  }

  /**
   * Schedule one later evaluation for a session, keeping only the earliest.
   * The timer is unref'd so a pending re-check never keeps the process alive.
   * @param {string} sessionId - session to re-check.
   * @param {number} delayMs - milliseconds until the check.
   * @returns {void}
   */
  scheduleEvaluate(sessionId, delayMs) {
    const delay = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0)
    const existing = this.timers.get(sessionId)
    if (existing !== undefined) {
      if (existing.due <= Date.now() + delay) return
      clearTimeout(existing.handle)
      this.timers.delete(sessionId)
    }
    const handle = setTimeout(() => {
      this.timers.delete(sessionId)
      if (this.unloaded) return
      const agent = this.ctx.get('agents')?.get(sessionId)
      if (agent === undefined) return
      void this.evaluate(agent).catch(error => this.warn(`scheduled evaluation failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`))
    }, delay)
    handle.unref?.()
    this.timers.set(sessionId, { handle, due: Date.now() + delay })
  }

  /**
   * Drop one session's pending re-check.
   * @param {string} sessionId - session identity.
   * @returns {void}
   */
  clearTimer(sessionId) {
    const existing = this.timers.get(sessionId)
    if (existing === undefined) return
    clearTimeout(existing.handle)
    this.timers.delete(sessionId)
  }

  /**
   * Re-check every live chain head once after a plugin reload.
   * An idle session emits no idle event again, so without this a chain that was
   * already ready (or wrapped up) would sit still until the next turn.
   * @returns {void}
   */
  resumeEvaluations() {
    // The host index is the authority after a reload; the stores this lifetime
    // touched are empty until something reads it.
    try {
      for (const entry of this.chainIndex.entries()) {
        if (!this.stores.has(entry.truthDir)) this.stores.set(entry.truthDir, this.storeFor(entry.truthDir))
      }
    } catch {
      /* an unreadable index still leaves the touched stores */
    }
    for (const [, store] of this.stores) {
      let chainIds = []
      try {
        chainIds = store.listChainIds()
      } catch {
        continue
      }
      for (const chainId of chainIds) {
        try {
          const chain = store.readChain(chainId)
          if (chain === undefined) continue
          if (chain.status !== 'active' && chain.status !== 'initializing') continue
          if (chain.currentSessionId === null || chain.currentSessionId === undefined) continue
          const agent = this.ctx.get('agents')?.get(chain.currentSessionId)
          if (agent === undefined) continue
          this.scheduleEvaluate(agent.id, 2000)
        } catch {
          /* one unreadable chain must not stop the others */
        }
      }
    }
  }

  /**
   * Drop every pending re-check of one chain.
   * @param {object} chain - chain record.
   * @returns {void}
   */
  clearChainTimers(chain) {
    for (const session of chain.sessions) this.clearTimer(session.sessionId)
  }

  /**
   * Re-attach the wrap-up deadline after a plugin reload.
   * Without this the persisted `wrapupAt` would only be noticed by the next idle
   * event, which never comes for a session that is already idle.
   * @param {object} agent - live agent.
   * @returns {void}
   */
  scheduleWrapupDeadline(agent) {
    if (agent === undefined) return
    const membership = this.locate(agent.session)
    if (membership === undefined) return
    const { chain } = membership
    if (chain.currentSessionId !== agent.session.id) return
    if (typeof chain.wrapupAt !== 'string') return
    const at = Date.parse(chain.wrapupAt)
    if (!Number.isFinite(at)) return
    // Re-check at whichever deadline comes first: the wrap-up timeout or the
    // shorter stale-brief grace.
    const minutes = Math.min(this.config.wrapupTimeoutMinutes, this.config.staleHandoffMinutes)
    this.scheduleEvaluate(agent.session.id, at + minutes * 60_000 - Date.now())
  }

  /**
   * Note that a session was loaded (again) by the host.
   * The host disarms goals each time a session is loaded, so each load gets one re-arm attempt.
   * @param {string} sessionId - the loaded session.
   * @returns {void}
   */
  sessionLoaded(sessionId) {
    const stats = this.stats.get(sessionId)
    if (stats !== undefined) stats.rearmChecked = false
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
  start(input) {
    return this.beginChain(input, { cluster: false })
  }

  /**
   * Start a cluster chain: the calling session becomes the planning session.
   * Differs from `start` in that plan mode is wanted rather than refused (the session is switched into
   * it when the Host offers the service), the chain waits in `planning` until a human confirms a launch,
   * and the session receives the planning prompt instead of the initializer prompt.
   * @param {{ agent: object, objective: string, cwd?: string, maxHandoffs?: number }} input - start input.
   * @returns {object} start result, with `mode: 'cluster'`.
   */
  startCluster(input) {
    return this.beginChain(input, { cluster: true })
  }

  /**
   * Create a chain and adopt the calling session as its first session.
   * @param {{ agent: object, objective: string, cwd?: string, maxHandoffs?: number }} input - start input.
   * @param {{ cluster: boolean }} options - whether this is the cluster variant.
   * @returns {object} start result.
   */
  beginChain({ agent, objective, cwd, maxHandoffs }, { cluster }) {
    const workspace = cwd ?? agent.session.header?.cwd
    if (typeof workspace !== 'string' || workspace.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'the session has no working directory; pass cwd explicitly')
    }
    // Nothing is written yet: a chain started from an unapproved plan would lock
    // the objective in before the plan exists. A cluster chain is the opposite: it starts
    // so that the plan can be made.
    if (!cluster && this.planActive(agent)) {
      throw new RelayError(RELAY_CODES.invalid, 'plan mode is active: finish the plan and have it approved first, then call relay_start and write the approved plan into PLAN.md and features.json')
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
    store.writeText(store.paths(chain.chainId).plan, skeleton.plan)
    if (cluster) store.writeText(store.paths(chain.chainId).spec, skeleton.spec)
    store.writeProgress(chain.chainId, skeleton.progress)
    store.writeHandoff(chain.chainId, skeleton.handoff)
    store.writeText(store.paths(chain.chainId).decisions, skeleton.decisions)
    store.writeText(store.paths(chain.chainId).traps, skeleton.traps)
    store.writeText(store.paths(chain.chainId).history, skeleton.history)
    store.ensureGitignore(chain.chainId)
    const joinedAt = new Date().toISOString()
    const updated = store.update(chain.chainId, record => {
      record.sessions.push({
        sessionId: agent.session.id,
        role: 'initializer',
        index: 0,
        joinedAt,
        compactions: 0,
        parentSessionId: null,
        handoffHashAtJoin: handoffHash(skeleton.handoff),
      })
      record.currentSessionId = agent.session.id
      // The list is not frozen yet; the first accepted checkpoint flips this. A cluster chain
      // stays `planning` until a human launches it.
      record.status = cluster ? 'planning' : 'initializing'
      if (cluster) record.mode = 'cluster'
    })
    this.remember(updated, store)
    this.members.set(agent.session.id, { chainId: chain.chainId, truthDir: store.truthDir })
    this.misses.delete(agent.session.id)
    this.statsFor(agent.session.id)
    this.record(store, chain.chainId, {
      kind: 'chain.started',
      actor: agent.session.id,
      detail: { objective, maxHandoffs: chain.maxHandoffs, ...(cluster ? { mode: 'cluster' } : {}) },
    })
    if (cluster) {
      // Without the service the planning prompt alone has to keep the session from editing code.
      const planMode = this.ctx.get('planMode')
      if (typeof planMode?.set === 'function' && !this.planActive(agent)) {
        try {
          planMode.set(agent, true)
        } catch (error) {
          this.warn(`could not switch ${agent.id} into plan mode: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    try {
      // A follow-up wakes the session: the instructions must run in
      // the next turn, not wait for the human to speak again.
      const truthDir = join(store.truthDir, chain.chainId)
      agent.followup(relayMessage(cluster
        ? renderClusterPlanningPrompt({ truthDir, objective, maxSessions: this.config.maxClusterSessions })
        : renderInitializerPrompt({ truthDir, objective, commitTruth: this.config.commitTruth })))
    } catch (error) {
      this.warn(`could not queue the ${cluster ? 'planning' : 'initializer'} prompt: ${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      chainId: chain.chainId,
      title: chain.title,
      truthDir: join(store.truthDir, chain.chainId),
      maxHandoffs: chain.maxHandoffs,
      ...(cluster ? { mode: 'cluster' } : {}),
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
    const self = this.memberSession(chain, agent)
    const worker = this.isWorker(self)
    if (worker) {
      if (ready === true) throw new RelayError(RELAY_CODES.workerReadOnly, 'a delegated worker cannot mark the session ready')
      if (Array.isArray(addFeatures) && addFeatures.length > 0) {
        throw new RelayError(RELAY_CODES.workerReadOnly, 'a delegated worker cannot add features')
      }
    }
    // acceptedBy is the human's signature, never the model's.
    if (Array.isArray(features) && features.some(update => update !== null && typeof update === 'object' && 'acceptedBy' in update)) {
      throw new RelayError(RELAY_CODES.invalid, 'acceptedBy is human-only; accept partial coverage in the panel')
    }
    if (worker && Array.isArray(features) && features.length > 0) {
      const document = store.readFeatures(chain.chainId)
      for (const update of features) {
        if (update !== null && typeof update === 'object' && 'assignedSessionId' in update) {
          throw new RelayError(RELAY_CODES.workerReadOnly, 'a delegated worker cannot reassign features')
        }
        const feature = document?.features.find(entry => entry.id === update?.id)
        if (feature !== undefined && feature.assignedSessionId !== self.sessionId) {
          throw new RelayError(RELAY_CODES.workerReadOnly, `feature ${update.id} is not assigned to this worker`)
        }
      }
    }
    // Structural edits are checked before any write, so a drifted file never
    // gets a partial patch applied on top of it.
    this.verifyFrozen(chain, store)
    // Ready is the gate the next session depends on: without a structured
    // brief it starts blind, so refuse before writing anything.
    if (ready === true) {
      const freshness = this.handoffFreshness(chain, store, self)
      if (!freshness.fresh && freshness.reason === 'missing') {
        return {
          ok: false,
          code: 'handoff_missing',
          message: 'write HANDOFF.md with a <!-- relay:state --> block before ready=true',
        }
      }
      // The session is still awake here, so asking it to rewrite the brief
      // costs one more step; handing a stale brief over costs the next session.
      if (!freshness.fresh) {
        return {
          ok: false,
          code: 'handoff_stale',
          message: 'HANDOFF.md is still the brief this session was handed; rewrite its <!-- relay:state --> block with what this session did and the next action before ready=true',
        }
      }
    }
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
    // The initializer's first accepted list freezes it; an announced append
    // refreshes the fingerprint so it stays the frozen contract.
    this.freezeFeatures(chain, store, agent?.session?.id)
    if (appended.length > 0) this.updateFingerprint(chain, store)
    if (typeof note === 'string' && note.trim().length > 0) {
      const stamp = new Date().toISOString()
      store.writeProgress(chain.chainId, `${store.readProgress(chain.chainId).replace(/\s*$/, '\n')}- [${stamp}] ${note.trim()}\n`)
    }
    if (ready === true && agent !== undefined) {
      this.statsFor(agent.session.id).ready = true
      // Persisted so a plugin reload between the wrap-up and the handoff does
      // not lose the checkpoint and wait for the timeout instead.
      store.update(chain.chainId, record => {
        record.readyAt = new Date().toISOString()
        record.readySessionId = agent.session.id
      })
    }
    if (blocker !== undefined) this.recordBlocker(store, chain.chainId, blocker)
    if (blocked === true) {
      store.update(chain.chainId, record => {
        if (record.status === 'planning') {
          // Planning ends only by launch or delete; the note stays visible without pausing.
          record.lastError = typeof note === 'string' && note.trim().length > 0 ? note.trim() : 'blocked by a session'
          return
        }
        record.status = 'paused'
        // A blocker and blocked=true usually arrive together; the blocker owns
        // the pause so clearing it can release the chain.
        record.pausedBy = record.blocker?.kind === 'external' ? 'blocker' : 'blocked'
        record.lastError = typeof note === 'string' && note.trim().length > 0 ? note.trim() : 'blocked by a session'
      })
    } else if (chain.status === 'planning') {
      // A blocked note must not stay on the chain for the whole planning phase.
      store.update(chain.chainId, record => { if (record.status === 'planning') record.lastError = null })
    }
    // Touch the chain record: the panel's "last activity" and the document
    // reader (which keys its cache on updatedAt) both read this field, and it
    // would otherwise only move on structural changes like handoff or ready.
    store.update(chain.chainId, () => {})
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
    this.releaseWaitingGroups(updated)
    if (ready === true) this.record(store, chain.chainId, { kind: 'session.ready', actor })
    if (blocked === true || blocker !== undefined) {
      this.record(store, chain.chainId, {
        kind: blocker === null ? 'blocker.cleared' : 'blocker.set',
        actor,
        detail: blocker === null || blocker === undefined ? {} : { kind: blocker.kind, action: blocker.action ?? null },
      })
    }
    // A pause, or features that passed or changed hands, change what the workers' goals should be doing.
    this.syncWorkerGoals(chain, store)
    return {
      chainId: chain.chainId,
      status: updated?.status ?? chain.status,
      paused: updated?.status === 'paused',
      blocker: updated?.blocker ?? null,
      appended,
      featuresTotal: progress.total,
      featuresDone: progress.done,
      pending: progress.pending.map(feature => feature.id).slice(0, 20),
      // Another chain in this workspace is building the same paths right now:
      // the session cannot pause it, so this is for the model to report upward.
      conflicts: this.crossChainConflicts(updated ?? chain, store.readFeatures(chain.chainId)),
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
        // Only a pause this blocker caused may be released here; a manual pause
        // or a failed handoff keeps its own reason. Records written before
        // `pausedBy` existed fall back to the old lastError prefix.
        const legacyBlocked = (record.pausedBy === undefined || record.pausedBy === null)
          && typeof record.lastError === 'string' && record.lastError.startsWith('external blocker:')
        if (record.status === 'paused' && (record.pausedBy === 'blocker' || legacyBlocked)) {
          record.status = 'active'
          record.pausedBy = null
          record.lastError = null
        }
      })
      // A blocker pauses and releases the chain from several places; the workers' goals follow here.
      this.syncWorkerGoals({ chainId }, store)
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
      // A planning chain leaves `planning` only through launch or delete, so its blocker is recorded without a pause.
      if (kind === 'external' && this.config.pauseOnExternalBlocker && record.status !== 'planning') {
        record.status = 'paused'
        record.pausedBy = 'blocker'
        record.lastError = `external blocker: ${description.action || 'waiting for a human'}`
      }
    })
    store.writeProgress(chainId, `${store.readProgress(chainId).replace(/\s*$/, '\n')}- [${description.since}] blocked (${kind}, waits on ${description.who}): ${description.action || '(no action recorded)'}\n`)
    store.appendLedger(chainId, 'decisions', `- [${description.since}] blocked (${kind}, waits on ${description.who}): ${description.action || '(no action recorded)'}`)
    this.syncWorkerGoals({ chainId }, store)
  }

  /**
   * Clear a chain's blocker on a human's word that the blocking action is done.
   * A blocker mirrored from a blocked goal is owned by that goal: clearing it here
   * would only be undone by the next evaluation, so it is refused with the way out.
   * @param {{ chainId: string }} input - chain identity.
   * @returns {{ chainId: string, status: string, cleared: boolean }} the new status.
   */
  clearBlocker({ chainId }) {
    const { chain, store } = this.findChain(chainId)
    const blocker = chain.blocker ?? null
    if (blocker === null) return { chainId: chain.chainId, status: chain.status, cleared: false }
    if (typeof blocker.action === 'string' && blocker.action.startsWith(GOAL_BLOCKER_PREFIX)) {
      throw new RelayError(RELAY_CODES.invalid, 'this blocker follows a blocked goal; resume the goal in its session to clear it')
    }
    this.recordBlocker(store, chain.chainId, null)
    // A session that reported `blocked: true` with a code or decision blocker
    // paused the chain under its own reason; the human clearing the blocker
    // answers that report too.
    store.update(chain.chainId, record => {
      if (record.status === 'paused' && record.pausedBy === 'blocked') {
        record.status = 'active'
        record.pausedBy = null
        record.lastError = null
      }
    })
    // The continuation budget is what this blocker was about: without a new
    // one the next idle evaluation would record the same blocker again.
    if (typeof blocker.action === 'string' && blocker.action.startsWith(CONTINUE_LIMIT_BLOCKER_PREFIX)
      && typeof chain.currentSessionId === 'string') {
      this.statsFor(chain.currentSessionId).autoContinues = 0
    }
    this.record(store, chain.chainId, { kind: 'blocker.cleared', actor: 'host', detail: { kind: blocker.kind, action: blocker.action } })
    const current = this.restartSupervision(chain.chainId, store)
    return { chainId: chain.chainId, status: current?.status ?? chain.status, cleared: true }
  }

  /**
   * Put a chain that just left a pause back under supervision.
   * Nothing else wakes an idle session: evaluation only follows an idle event
   * or a timer, and the timers were dropped when the chain paused. A chain
   * that is still stopped is left alone.
   * @param {string} chainId - chain identity.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @returns {object|undefined} the chain record as it is now.
   */
  restartSupervision(chainId, store) {
    const current = store.readChain(chainId)
    // The workers' goals follow the chain, including a chain that is still stopped.
    if (current !== undefined) this.syncWorkerGoals(current, store)
    if (current === undefined || (current.status !== 'active' && current.status !== 'initializing')) return current
    // A resumed chain may still carry a half-finished handoff or a wrap-up deadline.
    this.reconcilePendingHandoff(current, store)
    const live = typeof current.currentSessionId === 'string' ? this.ctx.get('agents')?.get(current.currentSessionId) : undefined
    if (live !== undefined) {
      this.scheduleWrapupDeadline(live)
      this.scheduleEvaluate(live.id, 0)
    }
    return current
  }

  /**
   * Delete a stopped chain and forget it.
   * An active chain's supervisor is still running, so it must be paused first;
   * this keeps a delete from racing a wrap-up or handoff.
   * @param {string} chainId - chain identity.
   * @returns {{ chainId: string, status: string, sessions: number }} deletion result.
   */
  deleteChain(chainId) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'chainId is required')
    }
    const { chain, store } = this.findChain(chainId)
    if (chain.status === 'active' || chain.status === 'initializing') {
      throw new RelayError(RELAY_CODES.invalid, 'pause the chain before deleting it')
    }
    const sessionIds = chain.sessions.map(session => session.sessionId)
    store.remove(chain.chainId)
    try {
      this.chainIndex.forget(chain.chainId)
    } catch (error) {
      this.warn(`chain ${chain.chainId} was deleted but its index entry remains: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      this.fingerprints.remove(chain.chainId)
    } catch (error) {
      this.warn(`chain ${chain.chainId} was deleted but its fingerprint remains: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const sessionId of sessionIds) {
      this.members.delete(sessionId)
      this.stats.delete(sessionId)
    }
    this.clearChainTimers(chain)
    return { chainId: chain.chainId, status: chain.status, sessions: sessionIds.length }
  }

  /**
   * Finish a chain after checking that every feature passes.
   * @param {{ agent?: object, chainId?: string, evidence: string }} input - finish input.
   * @returns {object} finish result or a refusal.
   */
  finish({ agent, chainId, evidence }) {
    const { chain, store } = this.resolveChain(agent, chainId)
    this.assertChainHeadWriter(chain, agent)
    // Planning ends only by launch or delete; finishing would skip the human's launch confirmation.
    if (chain.status === 'planning') {
      throw new RelayError(RELAY_CODES.invalid, `chain ${chain.chainId} is planning; launch it or delete it`)
    }
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chain.chainId} has no features.json`)
    this.verifyFrozen(chain, store)
    const progress = featureProgress(document)
    if (progress.total === 0) {
      throw new RelayError(RELAY_CODES.incomplete, 'the chain has no features; list them before finishing')
    }
    // Every blocker is reported together: fixing one and retrying would
    // otherwise discover the next one only after another round.
    const blockers = []
    if (progress.pending.length > 0) {
      blockers.push({
        kind: 'pending',
        message: `${progress.pending.length} of ${progress.total} features do not pass yet.`,
        items: progress.pending.slice(0, 20).map(feature => ({ id: feature.id, title: feature.title })),
      })
    }
    // A passing feature with no usable output is a claim, not evidence. The
    // same rule the tool layer applies is re-checked here for the whole list.
    const unsupported = []
    for (const feature of document.features) {
      const issue = evidenceIssue(feature.evidence, { requireStrong: this.config.requireStrongEvidence })
      if (issue !== undefined) unsupported.push({ id: feature.id, issue })
    }
    if (unsupported.length > 0) {
      blockers.push({
        kind: 'evidence',
        message: `${unsupported.length} features pass without usable evidence; record the command output first.`,
        items: unsupported.slice(0, 20),
      })
    }
    // Partial coverage counts only when the panel wrote `human` and stamped
    // `acceptedAt`. Free text typed into features.json, or a hand-written
    // `human` without the stamp, does not release the gate.
    const partial = this.config.requireHumanAcceptedCoverage
      ? document.features.filter(feature => feature.coverage !== 'full'
        && (feature.acceptedBy !== 'human' || typeof feature.acceptedAt !== 'string'))
      : []
    if (partial.length > 0) {
      blockers.push({
        kind: 'coverage',
        message: `${partial.length} features only reach partial coverage and are not accepted by a human yet; accept them in the panel (a hand-edited acceptedBy does not count).`,
        items: partial.slice(0, 20).map(feature => ({
          id: feature.id,
          coverage: feature.coverage,
          acceptedBy: typeof feature.acceptedBy === 'string' ? feature.acceptedBy.slice(0, 60) : null,
        })),
      })
    }
    if (blockers.length > 0) {
      return {
        ok: false,
        code: RELAY_CODES.incomplete,
        message: blockers.map(blocker => blocker.message).join(' '),
        blockers,
        features: blockers.flatMap(blocker => blocker.items).slice(0, 20),
      }
    }
    store.update(chain.chainId, record => {
      record.status = 'done'
      record.pausedBy = null
      record.lastError = null
    })
    store.writeProgress(chain.chainId, `${store.readProgress(chain.chainId).replace(/\s*$/, '\n')}- [${new Date().toISOString()}] completed: ${evidence}\n`)
    this.record(store, chain.chainId, {
      kind: 'chain.finished',
      actor: agent?.session?.id ?? 'host',
      detail: { evidence, featuresTotal: progress.total },
    })
    // A finished chain must not keep a goal that sends further rounds. The chain
    // is already done; a failure here only costs a warning.
    try {
      const head = this.headGoal(chain)
      if (head !== undefined && typeof head.entry?.goalId === 'string' && head.entry.goalId === head.view.id
        && ['active', 'paused', 'blocked'].includes(head.view.phase)) {
        head.goals.complete(head.agent, { id: head.view.id, revision: head.view.revision })
        this.record(store, chain.chainId, {
          kind: 'goal.completed',
          actor: 'system',
          detail: { sessionId: head.agent.id, goalId: head.view.id },
        })
      }
    } catch (error) {
      this.warn(`could not complete the goal of chain ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    // The workers' own goals end with the chain too; a worker that is not loaded now is reconciled by its first evaluation.
    this.syncWorkerGoals(chain, store)
    return { ok: true, chainId: chain.chainId, featuresTotal: progress.total }
  }

  /**
   * Accept or revoke a human's acceptance of reduced coverage.
   * This is the only path that writes `acceptedBy`; model-facing tools refuse it.
   * @param {{ chainId: string, featureId: string, accepted: boolean }} input - acceptance input.
   * @returns {{ chainId: string, featureId: string, acceptedBy: string|null, total: number, done: number, partial: number }} result.
   */
  acceptCoverage({ chainId, featureId, accepted }) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'chainId is required')
    }
    if (typeof featureId !== 'string' || featureId.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'featureId is required')
    }
    const { chain, store } = this.findChain(chainId)
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chain.chainId} has no features.json`)
    const feature = document.features.find(entry => entry.id === featureId)
    if (feature === undefined) throw new RelayError(RELAY_CODES.invalid, `feature ${featureId} does not exist`)
    if (feature.passes !== true) {
      throw new RelayError(RELAY_CODES.invalid, 'only a passing feature can have its coverage accepted')
    }
    const value = accepted === true ? 'human' : null
    const acceptedAt = value === 'human' ? new Date().toISOString() : null
    store.patchFeatures(chain.chainId, [{ id: featureId, acceptedBy: value, acceptedAt }])
    this.record(store, chain.chainId, {
      kind: value === 'human' ? 'coverage.accepted' : 'coverage.revoked',
      actor: 'human',
      detail: { id: featureId, coverage: feature.coverage },
    })
    const progress = featureProgress(store.readFeatures(chain.chainId))
    return {
      chainId: chain.chainId,
      featureId,
      acceptedBy: value,
      acceptedAt,
      total: progress.total,
      done: progress.done,
      partial: progress.partial,
    }
  }

  /**
   * Accept reduced coverage for every passing feature that still lacks it.
   * A chain can end with partial features only after a human signs them off;
   * this is the panel's one-click path to that signature.
   * @param {{ chainId: string, featureIds?: string[] }} input - chain and optional subset.
   * @returns {{ chainId: string, accepted: number, total: number, done: number, partial: number }} result.
   */
  acceptCoverageMany({ chainId, featureIds }) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'chainId is required')
    }
    const { chain, store } = this.findChain(chainId)
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chain.chainId} has no features.json`)
    const wanted = new Set(Array.isArray(featureIds) ? featureIds.filter(id => typeof id === 'string') : [])
    const targets = document.features.filter(feature => feature.passes === true
      && feature.coverage !== undefined && feature.coverage !== 'full'
      // A hand-written `human` without the panel's stamp is re-accepted here.
      && (feature.acceptedBy !== 'human' || typeof feature.acceptedAt !== 'string')
      && (wanted.size === 0 || wanted.has(feature.id)))
    const acceptedAt = new Date().toISOString()
    if (targets.length > 0) {
      store.patchFeatures(chain.chainId, targets.map(feature => ({ id: feature.id, acceptedBy: 'human', acceptedAt })))
      this.record(store, chain.chainId, {
        kind: 'coverage.accepted',
        actor: 'human',
        detail: { ids: targets.map(feature => feature.id) },
      })
    }
    const progress = featureProgress(store.readFeatures(chain.chainId))
    return {
      chainId: chain.chainId,
      accepted: targets.length,
      acceptedAt: targets.length === 0 ? null : acceptedAt,
      total: progress.total,
      done: progress.done,
      partial: progress.partial,
    }
  }

  /**
   * Pause or resume automatic handoff for one chain.
   * @param {{ agent?: object, chainId?: string, paused: boolean }} input - toggle input.
   * @returns {object} new status.
   */
  setPaused({ agent, chainId, paused }) {
    const { chain, store } = this.resolveChain(agent, chainId)
    this.assertWriter(chain, agent)
    if (chain.status === 'done' || chain.status === 'failed') {
      throw new RelayError(RELAY_CODES.invalid, `chain ${chain.chainId} is ${chain.status}; it cannot be paused or resumed`)
    }
    // Resuming would write `active` and skip the human's launch confirmation.
    if (chain.status === 'planning') {
      throw new RelayError(RELAY_CODES.invalid, `chain ${chain.chainId} is planning; launch it or delete it`)
    }
    store.update(chain.chainId, record => {
      if (paused) {
        record.status = 'paused'
        record.pausedBy = 'manual'
      } else if (record.status === 'paused' || record.status === 'initializing') {
        record.status = 'active'
        record.pausedBy = null
        record.lastError = null
      }
    })
    this.record(store, chain.chainId, {
      kind: paused ? 'chain.paused' : 'chain.resumed',
      actor: agent?.session?.id ?? 'host',
    })
    if (paused) this.clearChainTimers(chain)
    try {
      if (paused && agent === undefined) {
        // Only the panel pauses the goal: a session pausing its own chain is
        // deciding about the chain, not about its goal.
        const head = this.headGoal(chain)
        if (head !== undefined && head.view.phase === 'active') {
          head.goals.pause(head.agent, { id: head.view.id, revision: head.view.revision })
          store.update(chain.chainId, record => { record.goalPausedByRelay = { sessionId: head.agent.id, goalId: head.view.id } })
          this.record(store, chain.chainId, { kind: 'goal.paused', actor: 'host', detail: { sessionId: head.agent.id, goalId: head.view.id } })
        }
      } else if (!paused) {
        const current = store.readChain(chain.chainId)
        if (current?.status === 'active') this.releasePausedGoal(current, store, agent?.session?.id ?? 'host')
      }
    } catch (error) {
      this.warn(`could not sync the goal of chain ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    // The workers' goals follow the chain whoever paused or resumed it; a resume reaches them through restartSupervision.
    if (paused) this.syncWorkerGoals(chain, store)
    else this.restartSupervision(chain.chainId, store)
    return { chainId: chain.chainId, status: store.readChain(chain.chainId)?.status ?? chain.status }
  }

  /**
   * Resume the goal the panel paused together with the chain.
   * The marker belongs to one pause: it is spent once the goal could be looked at, but it
   * waits while the session that owns the goal is not loaded, so a later evaluation of that
   * session still restores the goal.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {string} actor - who resumed the chain, for the audit.
   * @returns {void}
   */
  releasePausedGoal(chain, store, actor) {
    const marker = chain.goalPausedByRelay
    if (marker === null || marker === undefined) return
    try {
      const clear = () => store.update(chain.chainId, record => { record.goalPausedByRelay = null })
      if (chain.currentSessionId !== marker.sessionId) {
        clear()
        return
      }
      const agent = this.ctx.get('agents')?.get(marker.sessionId)
      // Not loaded: the marker waits for the session.
      if (agent === undefined) return
      clear()
      const view = this.goalOf(agent)
      const goals = this.ctx.get('goals')
      if (view === undefined || view.id !== marker.goalId || view.phase !== 'paused'
        || view.roundsStarted >= view.maxGoalRounds || typeof goals?.resume !== 'function') return
      goals.resume(agent, { id: view.id, revision: view.revision })
      this.record(store, chain.chainId, {
        kind: 'goal.resumed',
        actor,
        detail: { sessionId: agent.id, goalId: view.id },
      })
      // A resume arms the goal. A session that was already wrapping up
      // when the chain paused is still waiting for its handoff.
      if (this.isWrapping(chain)) this.holdGoal(chain, store, agent, 'wrapup')
    } catch (error) {
      this.warn(`could not sync the goal of chain ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Hand off immediately, bypassing the pressure decision.
   * @param {{ agent?: object, chainId?: string }} input - handoff input.
   * @returns {Promise<object>} handoff result.
   */
  async handoffNow({ agent, chainId }) {
    const { chain, store } = this.resolveChain(agent, chainId)
    this.assertWriter(chain, agent)
    if (chain.status === 'planning') {
      throw new RelayError(RELAY_CODES.invalid, `chain ${chain.chainId} is planning; there is no work to hand off yet`)
    }
    const current = chain.currentSessionId === null ? undefined : this.ctx.get('agents')?.get(chain.currentSessionId)
    if (current === undefined) {
      throw new RelayError(RELAY_CODES.notFound, `the current session of ${chain.chainId} is not loaded; open it first`)
    }
    if (current.status === 'running') {
      throw new RelayError(RELAY_CODES.busy, 'the current session is running; wait until it is idle before handing off')
    }
    const entry = chain.sessions.find(session => session.sessionId === current.session.id)
    const freshness = this.handoffFreshness(chain, store, entry)
    if (!freshness.fresh) {
      const stats = this.statsFor(current.session.id)
      if (stats.wrapupSentAt === 0) {
        await this.wrapup(chain, store, current)
        return {
          ok: false,
          code: 'handoff_not_ready',
          message: chain.status === 'paused'
            ? 'HANDOFF.md is stale or missing; the session was asked to wrap up. The chain is paused, so hand off again once the session is idle'
            : 'HANDOFF.md is stale or missing; the session was asked to wrap up and the handoff follows when it reports ready',
        }
      }
      const remaining = this.config.staleHandoffMinutes * 60_000 - (Date.now() - stats.wrapupSentAt)
      if (remaining > 0) {
        this.scheduleEvaluate(current.session.id, remaining)
        return {
          ok: false,
          code: 'handoff_not_ready',
          message: `HANDOFF.md is stale; the handoff retries in about ${Math.ceil(remaining / 1000)}s`,
        }
      }
    }
    return this.handoff(chain, current, 'manual', store, { stale: !freshness.fresh })
  }

  /**
   * The chain session entry for one calling agent.
   * @param {object} chain - chain record.
   * @param {object|undefined} agent - calling agent, when any.
   * @returns {object|undefined} session entry; undefined when no agent was given.
   */
  memberSession(chain, agent) {
    if (agent === undefined || agent === null) return undefined
    const sessionId = agent.session?.id
    const session = chain.sessions.find(entry => entry.sessionId === sessionId)
    if (session === undefined) {
      throw new RelayError(RELAY_CODES.notMember, `session ${sessionId ?? '(unknown)'} does not belong to chain ${chain.chainId}`)
    }
    if (session.retiredAt !== null && session.retiredAt !== undefined) {
      throw new RelayError(RELAY_CODES.retired, `session ${sessionId} is retired; this chain is read-only for it`)
    }
    return session
  }

  /** Whether a session entry is a delegated worker. */
  isWorker(session) {
    return session !== undefined && session.parentSessionId !== null && session.parentSessionId !== undefined
  }

  /**
   * Refuse a write from a delegated worker.
   * @param {object} chain - chain record.
   * @param {object|undefined} agent - calling agent.
   * @returns {object|undefined} the calling session entry.
   */
  assertWriter(chain, agent) {
    const session = this.memberSession(chain, agent)
    if (this.isWorker(session)) {
      throw new RelayError(RELAY_CODES.workerReadOnly, 'a delegated worker cannot hand off, pause, finish, or delete a chain')
    }
    return session
  }

  /**
   * Refuse a write from a session that is not a member, or is retired or a worker.
   * @param {object} chain - chain record.
   * @param {object|undefined} agent - calling agent.
   * @returns {object|undefined} the calling session entry.
   */
  assertChainHeadWriter(chain, agent) {
    const session = this.assertWriter(chain, agent)
    if (session !== undefined && chain.currentSessionId !== session.sessionId) {
      throw new RelayError(RELAY_CODES.notMember, 'only the chain\'s current session may do this')
    }
    return session
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

  /**
   * File signature the panel payload was built from.
   * Chain records and the host index change on every write, so their content is
   * enough to detect a stale cache without reading features.json again. The
   * records are small; their mtimes cannot be used, see `contentStamp`.
   * @returns {string} signature.
   */
  statusSignature() {
    const parts = [contentStamp(this.chainIndex.file)]
    for (const [truthDir, store] of this.stores) {
      parts.push(truthDir)
      let ids = []
      try {
        ids = store.listChainIds()
        parts.push(contentStamp(join(truthDir, 'index.json')))
      } catch {
        parts.push('0')
      }
      for (const chainId of ids) {
        let chainFile
        try {
          chainFile = store.paths(chainId).chain
        } catch {
          parts.push(`${chainId}:0`)
          continue
        }
        parts.push(`${chainId}:${contentStamp(chainFile)}`)
      }
    }
    return parts.join('|')
  }

  /**
   * What the panel shows about one chain session.
   * The list, the chain detail, and the session tabs all read this, so a
   * session cannot show three different peaks. The peak counts the live
   * reading as well: the in-memory peak is lost on a plugin reload.
   * @param {object} session - session entry from the chain record.
   * @returns {object} snapshot.
   */
  sessionSnapshot(session) {
    const live = this.ctx.get('agents')?.get(session.sessionId)
    const stats = this.stats.get(session.sessionId)
    const pressure = live === undefined ? { tokens: 0, window: 0, ratio: 0 } : this.pressure(live.session)
    return {
      sessionId: session.sessionId,
      role: session.role,
      index: session.index,
      parentSessionId: session.parentSessionId ?? null,
      joinedAt: session.joinedAt ?? null,
      retiredAt: session.retiredAt ?? null,
      retireReason: session.retireReason ?? null,
      loaded: live !== undefined,
      running: live?.status === 'running',
      compactions: stats?.compactions ?? session.compactions ?? 0,
      peakRatio: Number(Math.max(stats?.peakRatio ?? 0, session.peakPressureRatio ?? 0, pressure.ratio).toFixed(3)),
      pressureRatio: Number(pressure.ratio.toFixed(3)),
      pressureTokens: pressure.tokens,
      contextWindow: pressure.window,
    }
  }

  /**
   * What the panel needs to know about the chain's current session beyond its
   * snapshot: its goal, whether it is in plan mode, and whether the plugin is
   * holding or pausing the goal. The panel reads this to explain a chain that
   * looks stuck (plan mode, held goal) and to show the shared round budget.
   * @param {object} chain - chain record.
   * @returns {{ goal: object|null, planMode: boolean, goalHeld: boolean, goalPausedByRelay: boolean }} head state.
   */
  headState(chain) {
    const goalPausedByRelay = chain.goalPausedByRelay !== null && chain.goalPausedByRelay !== undefined
    const agent = this.ctx.get('agents')?.get(chain.currentSessionId)
    if (agent === undefined) return { goal: null, planMode: false, goalHeld: false, goalPausedByRelay }
    const goal = this.goalViewOf(agent)
    return {
      goal,
      planMode: this.planActive(agent),
      goalHeld: goal !== null && goal.phase === 'active' && goal.activation === 'disarmed' && this.isWrapping(chain),
      goalPausedByRelay,
    }
  }

  /**
   * How long the chain head has been running without writing to its truth source.
   * A session blocked inside one long command or background job keeps the `running`
   * status and appends no checkpoints, so the chain looks live while nothing moves.
   * @param {object} chain - chain record.
   * @returns {{ minutes: number }|null} the stall, or null when the head is not running or has progress.
   */
  stallOf(chain) {
    if (chain.status !== 'active') return null
    const agent = this.ctx.get('agents')?.get(chain.currentSessionId)
    if (agent === undefined || agent.status !== 'running') return null
    const last = Date.parse(chain.updatedAt)
    if (!Number.isFinite(last)) return null
    const minutes = Math.floor((Date.now() - last) / 60000)
    return minutes >= this.config.stallMinutes ? { minutes } : null
  }

  /**
   * Paths this chain shares with another chain in the same workspace.
   * Scopes are file-level, so two chains touching one file conflict even when
   * they edit different functions; a feature that passes stops claiming, and a
   * chain that is done or failed is no longer building anything.
   * @param {object} chain - chain record.
   * @param {{ features?: Array<object> }|undefined} document - this chain's features.
   * @returns {Array<{ chainId: string, title: string, paths: Array<string>, features: { mine: Array<string>, other: Array<string> } }>} conflicts.
   */
  crossChainConflicts(chain, document) {
    const key = workspaceKey(chain.cwd)
    const mine = claimsOf(document, chain.cwd)
    if (key === null || mine.length === 0) return []
    this.ensureStores()
    const found = []
    for (const [, store] of this.stores) {
      let ids = []
      try {
        ids = store.listChainIds()
      } catch {
        continue
      }
      for (const otherId of ids) {
        if (otherId === chain.chainId) continue
        const other = store.readChain(otherId)
        if (other === undefined || other.status === 'done' || other.status === 'failed') continue
        if (workspaceKey(other.cwd) !== key) continue
        const theirs = claimsOf(store.readFeatures(otherId), other.cwd)
        if (theirs.length === 0) continue
        const paths = []
        const mineIds = []
        const theirIds = []
        for (const a of mine) {
          for (const b of theirs) {
            const path = overlapPath(a.paths, b.paths)
            if (path === undefined) continue
            if (!paths.includes(path)) paths.push(path)
            if (!mineIds.includes(a.id)) mineIds.push(a.id)
            if (!theirIds.includes(b.id)) theirIds.push(b.id)
          }
        }
        // One entry per other chain: the panel names the chain once, with the
        // paths and features that collide.
        if (paths.length > 0) found.push({ chainId: otherId, title: other.title, paths, features: { mine: mineIds, other: theirIds } })
      }
    }
    return found
  }

  /** Make every truth directory the index knows about readable, as `status()` needs. */
  ensureStores() {
    let indexed = []
    try {
      indexed = this.chainIndex.entries()
    } catch (error) {
      this.warn(`cannot read the chain index: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const entry of indexed) {
      if (!this.stores.has(entry.truthDir)) this.stores.set(entry.truthDir, this.storeFor(entry.truthDir))
    }
  }

  /** Snapshot every chain this Host knows about. */
  status() {
    const signature = this.statusSignature()
    if (this.statusCache !== null && this.statusCache.signature === signature
      && Date.now() - this.statusCache.at < 1000) {
      return this.statusCache.items
    }
    // The index is the authority for which chains exist; the stores are only
    // the ones this lifetime has touched.
    this.ensureStores()
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
          const raw = store.readChain(chainId)
          if (raw === undefined) continue
          const chain = this.normalizeLocation(raw, store)
          const document = store.readFeatures(chainId)
          const progress = document === undefined ? undefined : featureProgress(document)
          items.push({
            ...chainSummary(chain, {
              progress,
              stall: this.stallOf(chain),
              conflicts: this.crossChainConflicts(chain, document),
            }),
            sessionsDetail: chain.sessions.map(session => this.sessionSnapshot(session)),
            head: this.headState(chain),
          })
        } catch (error) {
          this.warn(`cannot read chain ${chainId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    this.statusCache = { signature, at: Date.now(), items }
    return items
  }

  /**
   * Keep a chain record consistent with where it was actually found.
   * A moved or renamed workspace leaves stale absolute paths in relay.json;
   * the store that found the chain wins.
   * @param {object} chain - chain record as read from its own file.
   * @param {import('./chain-store.js').ChainStore} store - the store holding it.
   * @returns {object} the normalized record.
   */
  normalizeLocation(chain, store) {
    const actualTruthDir = store.truthDir
    const actualCwd = typeof store.cwd === 'string' ? store.cwd : dirname(actualTruthDir)
    if (chain.truthDir === actualTruthDir && chain.cwd === actualCwd) return chain
    let updated
    try {
      updated = store.update(chain.chainId, record => {
        record.truthDir = actualTruthDir
        record.cwd = actualCwd
      })
    } catch (error) {
      this.warn(`cannot normalize the location of ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
      return chain
    }
    try {
      this.chainIndex.remember(updated)
    } catch (error) {
      this.warn(`cannot refresh the index entry of ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return updated
  }

  /**
   * Raise a chain's handoff cap after it ran out.
   * @param {{ chainId: string, maxHandoffs: number }} input - the new cap.
   * @returns {object} the new status.
   */
  raiseHandoffLimit({ chainId, maxHandoffs }) {
    if (typeof chainId !== 'string' || chainId.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'chainId is required')
    }
    if (!Number.isInteger(maxHandoffs) || maxHandoffs < 1 || maxHandoffs > 1000) {
      throw new RelayError(RELAY_CODES.invalid, 'maxHandoffs must be an integer from 1 to 1000')
    }
    const { chain, store } = this.findChain(chainId)
    if (maxHandoffs <= chain.handoffCount) {
      throw new RelayError(RELAY_CODES.invalid, `maxHandoffs must exceed the ${chain.handoffCount} handoffs already used`)
    }
    store.update(chain.chainId, record => {
      record.maxHandoffs = maxHandoffs
      if (record.pausedBy === 'handoff-limit') {
        record.status = 'active'
        record.pausedBy = null
        record.lastError = null
      }
    })
    if (chain.blocker?.kind === 'external') this.recordBlocker(store, chain.chainId, null)
    this.record(store, chain.chainId, { kind: 'handoff.limit-raised', actor: 'host', detail: { maxHandoffs } })
    this.syncWorkerGoals(chain, store)
    return { chainId: chain.chainId, maxHandoffs, status: store.readChain(chain.chainId)?.status ?? chain.status }
  }

  /** Find one chain among the stores this Host has touched, then the index. */
  findChain(chainId) {
    if (!isChainId(chainId)) {
      throw new RelayError(RELAY_CODES.invalid, 'chainId must look like chain-<uuid>')
    }
    for (const [, store] of this.stores) {
      let chain
      try {
        chain = store.readChain(chainId)
      } catch {
        continue
      }
      if (chain !== undefined) return { chain: this.normalizeLocation(chain, store), store }
    }
    const truthDir = this.chainIndex.locate(chainId)
    if (truthDir !== undefined) {
      const store = this.storeFor(truthDir)
      const chain = store.readChain(chainId)
      if (chain !== undefined) {
        this.stores.set(truthDir, store)
        return { chain: this.normalizeLocation(chain, store), store }
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
      chain: chainSummary(chain, {
        progress: document === undefined ? undefined : featureProgress(document),
        stall: this.stallOf(chain),
        conflicts: this.crossChainConflicts(chain, document),
      }),
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
        // Cluster planning scope; empty when the planning session wrote none.
        files: feature.files ?? [],
        dependsOn: feature.dependsOn ?? [],
      })),
      mode: chain.mode ?? 'relay',
      launchPlan: chain.launchPlan ?? null,
      maxClusterSessions: this.config.maxClusterSessions,
      handoff: store.readHandoff(chainId).slice(0, 8000),
      truthDir: join(store.truthDir, chainId),
      // Whether the current session wrote the brief a successor would receive.
      handoffFreshness: this.handoffFreshness(chain, store, chain.sessions.find(session => session.sessionId === chain.currentSessionId)),
      sessions: chain.sessions.map(session => this.sessionSnapshot(session)),
      head: this.headState(chain),
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
    try {
      return await this.spawnWorker(chain, store, agent, selected, { note, agentPreset, actor: agent.session.id })
    } finally {
      this.busyChains.delete(chain.chainId)
    }
  }

  /**
   * Create one worker session, hand it the selected features, and deliver its delegation prompt.
   * Shared by `spawn` (a model delegating) and `launchCluster` (a human confirming a plan), so
   * the two cannot drift apart. The caller validated the features and owns `busyChains`.
   * On failure the delegation is released again and `delegation.failed` is recorded.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object} parentAgent - live session the worker continues; it supplies the preset and is the parent.
   * @param {Array<object>} selected - feature objects the worker owns.
   * @param {{ note?: string, agentPreset?: string, actor: string, cluster?: boolean }} options - audit actor; `cluster` lets the worker use subagents and skips plan mode inheritance.
   * @returns {Promise<object>} the created worker session.
   */
  async spawnWorker(chain, store, parentAgent, selected, { note, agentPreset, actor, cluster }) {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new RelayError(RELAY_CODES.invalid, 'this Host cannot create sessions')
    let createdSessionId
    try {
      const preset = agentPreset ?? this.presetFor(parentAgent)
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
          actor,
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
          parentSessionId: parentAgent.session.id,
        })
        record.lastError = null
      })
      const settled = store.readChain(chain.chainId)
      if (settled !== undefined) this.remember(settled, store)
      this.members.set(createdSessionId, { chainId: chain.chainId, truthDir: store.truthDir })
      this.misses.delete(createdSessionId)
      this.statsFor(createdSessionId)

      const child = this.ctx.get('agents')?.get(createdSessionId)
      if (child !== undefined) {
        const inheritedPreset = this.inheritPermission(chain, store, parentAgent, child)
        // A cluster launch happens after the plan was approved, so the worker must not start in plan mode.
        if (cluster !== true) this.inheritPlanMode(chain, store, parentAgent, child)
        if (inheritedPreset !== undefined) {
          store.update(chain.chainId, record => {
            const entry = record.sessions.find(session => session.sessionId === createdSessionId)
            if (entry !== undefined) entry.permissionPreset = inheritedPreset
          })
        }
        this.applyWorkerPolicy(child)
        try {
          this.ctx.get('sessionTitle')?.rename(child.session, sessionTitle('subtask', { title: chain.title }))
        } catch {
          /* naming is advisory */
        }
      }

      const prompt = renderDelegationPrompt({
        chain,
        truthDir: join(store.truthDir, chain.chainId),
        parentSessionId: parentAgent.session.id,
        features: selected,
        note: typeof note === 'string' ? note : '',
        cluster: cluster === true,
      })
      await controller.prompt({
        requestId: `relay-spawn-${chain.chainId}-${createdSessionId}-${randomUUID().slice(0, 8)}`,
        sessionId: createdSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, AbortSignal.timeout(60_000))

      this.record(store, chain.chainId, {
        kind: 'delegation.created',
        actor,
        detail: { childSessionId: createdSessionId, features: selected.map(feature => feature.id), note: note ?? '' },
      })
      return {
        chainId: chain.chainId,
        sessionId: createdSessionId,
        features: selected.map(feature => feature.id),
        parentSessionId: parentAgent.session.id,
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
        actor,
        detail: { features: selected.map(feature => feature.id), error: message },
      })
      throw error instanceof RelayError ? error : new RelayError(RELAY_CODES.io, `spawn failed: ${message}`)
    }
  }

  /**
   * Check a cluster launch plan against the feature list and name its groups.
   * The model's proposal and a human's edit in the panel go through the same rules.
   * @param {{ features: Array<object> }} document - normalized features.
   * @param {unknown} groups - candidate groups `{ title, features, isolation, reason }`.
   * @returns {Array<{ id: string, title: string, features: Array<string>, isolation: string, reason: string }>} groups with ids `G1`... by position.
   */
  validateClusterGroups(document, groups) {
    const [first] = this.clusterGroupIssues(document, groups)
    if (first !== undefined) throw new RelayError(RELAY_CODES.invalid, first.message)
    return groups.map((group, index) => (
      { id: `G${index + 1}`, title: group.title.trim(), features: group.features.slice(), isolation: group.isolation, reason: group.reason.trim() }
    ))
  }

  /**
   * Every rule a launch plan breaks, not only the first. The one implementation behind `validateClusterGroups`
   * (which throws the first) and `launchIssues` (which lists them all). `index` is the position in `groups`.
   * @param {{ features: Array<object> }} document - normalized features.
   * @param {unknown} groups - candidate groups `{ title, features, isolation, reason }`.
   * @returns {Array<{ code: string, message: string }>} issues in rule order; empty when the plan is valid.
   */
  clusterGroupIssues(document, groups) {
    const max = this.config.maxClusterSessions
    if (!Array.isArray(groups) || groups.length === 0) {
      return [{ code: 'invalid-groups', message: 'groups must be a non-empty array' }]
    }
    const issues = []
    if (groups.length > max) {
      issues.push({ code: 'invalid-groups', message: `a cluster launch may open at most ${max} groups, got ${groups.length}` })
    }
    const byId = new Map(document.features.map(feature => [feature.id, feature]))
    /** Feature id to the position of the group that owns it. @type {Map<string, number>} */
    const owner = new Map()
    /** Positions of the groups that are shaped well enough to look inside. @type {Array<number>} */
    const readable = []
    groups.forEach((group, index) => {
      const label = `groups[${index}]`
      const malformed = message => issues.push({ code: 'invalid-groups', message, index })
      if (group === null || typeof group !== 'object') return malformed(`${label} must be an object`)
      if (typeof group.title !== 'string' || group.title.trim().length === 0) malformed(`${label}.title must be a non-empty string`)
      const featuresOk = Array.isArray(group.features) && group.features.length > 0 && group.features.every(item => typeof item === 'string')
      if (!featuresOk) malformed(`${label}.features must be a non-empty array of feature ids`)
      if (group.isolation !== 'shared' && group.isolation !== 'worktree') malformed(`${label}.isolation must be shared or worktree`)
      if (typeof group.reason !== 'string' || group.reason.trim().length === 0) malformed(`${label}.reason must be a non-empty string`)
      if (!featuresOk) return undefined
      readable.push(index)
      for (const featureId of group.features) {
        const feature = byId.get(featureId)
        if (feature === undefined) {
          issues.push({ code: 'unknown-feature', message: `feature ${featureId} does not exist`, feature: featureId, index })
          continue
        }
        if (feature.passes) {
          issues.push({ code: 'feature-passes', message: `feature ${featureId} already passes`, feature: featureId, index })
        } else if (typeof feature.assignedSessionId === 'string' && feature.assignedSessionId.length > 0) {
          issues.push({
            code: 'feature-delegated',
            message: `feature ${featureId} is already delegated to ${feature.assignedSessionId}`,
            feature: featureId,
            index,
          })
        }
        if (owner.has(featureId)) {
          issues.push({
            code: 'duplicate-feature',
            message: `feature ${featureId} appears in more than one group (G${owner.get(featureId) + 1} and G${index + 1})`,
            feature: featureId,
            index,
          })
        } else {
          owner.set(featureId, index)
        }
      }
      return undefined
    })
    const checked = new Set()
    for (const index of readable) {
      for (const featureId of groups[index].features) {
        if (!byId.has(featureId) || checked.has(featureId)) continue
        checked.add(featureId)
        for (const dependency of byId.get(featureId).dependsOn ?? []) {
          if (!byId.has(dependency)) {
            issues.push({
              code: 'missing-dependency',
              message: `feature ${featureId} depends on ${dependency}, which is not in features.json`,
              feature: featureId,
              dependency,
              index,
            })
            continue
          }
          const dependencyIndex = owner.get(dependency)
          if (dependencyIndex !== undefined && dependencyIndex !== index) {
            issues.push({
              code: 'cross-group-dependency',
              message: `feature ${featureId} (group G${index + 1}) depends on ${dependency} (group G${dependencyIndex + 1}); put both in the same group`,
              feature: featureId,
              dependency,
              index,
              dependencyIndex,
            })
          }
        }
      }
    }
    return issues
  }

  /**
   * Record the launch plan the planning session proposes; a human confirms it later.
   * Opens nothing: the only way to start the sessions is `launchCluster`, which no tool reaches.
   * @param {{ agent: object, groups: Array<object>, note?: string }} input - proposal.
   * @returns {object} the stored plan and its conflicts.
   */
  proposeCluster({ agent, groups, note }) {
    const membership = this.locate(agent.session)
    if (membership === undefined) throw new RelayError(RELAY_CODES.invalid, 'this session does not belong to a chain')
    const { chain, store } = membership
    if (chain.currentSessionId !== agent.session.id) {
      throw new RelayError(RELAY_CODES.invalid, 'only the chain\'s current session can propose a launch')
    }
    if (chain.status !== 'planning') {
      throw new RelayError(RELAY_CODES.invalid, `chain ${chain.chainId} is ${chain.status}; only a planning chain can take a launch proposal`)
    }
    if (this.planActive(agent)) {
      throw new RelayError(RELAY_CODES.invalid, 'the plan is not approved yet; present it through exit_plan_mode first')
    }
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chain.chainId} has no features.json`)
    const validated = this.validateClusterGroups(document, groups)
    const conflicts = clusterConflicts(document, validated, chain.cwd)
    store.update(chain.chainId, record => {
      record.launchPlan = {
        proposedAt: new Date().toISOString(),
        proposedBy: agent.session.id,
        groups: validated,
        note: typeof note === 'string' ? note : '',
        conflicts,
      }
      record.lastError = null
    })
    this.record(store, chain.chainId, {
      kind: 'cluster.proposed',
      actor: agent.session.id,
      detail: { groups: validated.length, conflicts: conflicts.length },
    })
    return { chainId: chain.chainId, groups: validated, conflicts, waitingFor: 'human' }
  }

  /**
   * The blocker a launch has to respect. A blocker mirrored from a blocked goal only holds while that goal is
   * blocked: when the planning head is loaded and its goal let go (or is gone), the mirror is stale and does not count,
   * even though no evaluation has cleared it yet.
   * @param {object} chain - chain record.
   * @returns {{ action?: string }|null} the effective blocker, or null.
   */
  effectiveLaunchBlocker(chain) {
    const blocker = chain.blocker ?? null
    if (blocker === null) return null
    if (typeof blocker.action === 'string' && blocker.action.startsWith(GOAL_BLOCKER_PREFIX)) {
      const head = this.ctx.get('agents')?.get(chain.currentSessionId)
      if (head !== undefined && this.goalOf(head)?.phase !== 'blocked') return null
    }
    return blocker
  }

  /**
   * Everything that stands between a planning chain and its launch: the preconditions of the chain first, and
   * only when none is broken, every rule the plan itself breaks. `launchCluster` throws the first, the panel
   * shows them all through `previewCluster`. Writes nothing.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {Array<object>} [groups] - the plan as a human edited it; the stored plan when absent.
   * @returns {Array<{ code: string, message: string }>} issues with `code` one of `no-plan`, `busy`, `not-loaded`,
   *   `plan-pending`, `blocker` (`action`), `invalid-groups` (`index`), `unknown-feature`, `feature-passes`,
   *   `feature-delegated`, `duplicate-feature` (`feature`, `index`), `missing-dependency` (`feature`, `dependency`, `index`),
   *   `cross-group-dependency` (`feature`, `dependency`, `index`, `dependencyIndex`).
   */
  launchIssues(chain, store, groups) {
    const issues = []
    if (!Array.isArray(chain.launchPlan?.groups) || chain.launchPlan.groups.length === 0) {
      issues.push({ code: 'no-plan', message: `chain ${chain.chainId} has no launch plan yet; the planning session must call relay_propose first` })
    }
    if (this.busyChains.has(chain.chainId)) {
      issues.push({ code: 'busy', message: `chain ${chain.chainId} is busy with another operation; try again in a moment` })
    }
    const head = this.ctx.get('agents')?.get(chain.currentSessionId)
    if (head === undefined) {
      issues.push({ code: 'not-loaded', message: 'the planning session is not loaded; open the planning session first' })
    } else if (this.planActive(head)) {
      issues.push({ code: 'plan-pending', message: 'the plan is not approved yet; approve it in the planning session first' })
    }
    const blocker = this.effectiveLaunchBlocker(chain)
    if (blocker !== null) {
      issues.push({
        code: 'blocker',
        message: `chain ${chain.chainId} has an open blocker ("${blocker.action ?? ''}"); clear it before launching`,
        action: blocker.action ?? '',
      })
    }
    if (issues.length > 0) return issues
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) throw new RelayError(RELAY_CODES.notFound, `chain ${chain.chainId} has no features.json`)
    // The stored plan is checked again too: features may have passed or moved since it was proposed.
    return this.clusterGroupIssues(document, groups ?? chain.launchPlan.groups)
  }

  /**
   * What a launch plan would run into, with the same rules `launchCluster` applies, and without writing anything.
   * The panel asks this while a human edits the plan, so it never has to carry a second copy of the rules.
   * @param {{ chainId: string, groups?: Array<object> }} input - chain, and the plan as the human edited it; the stored plan when absent.
   * @returns {{ issues: Array<object>, conflicts: Array<object>, waiting: Array<{ index: number, waitsFor: Array<string> }> }}
   *   `issues` is the full `launchIssues` list (a launch would be refused with the first); `conflicts` are
   *   `clusterConflicts` entries; `waiting` names the shared groups (by position) that would wait for features outside them.
   *   `conflicts` and `waiting` stay empty while there are issues.
   */
  previewCluster({ chainId, groups }) {
    const { chain, store } = this.findChain(chainId)
    if (chain.status !== 'planning') {
      throw new RelayError(RELAY_CODES.invalid, `chain ${chain.chainId} is ${chain.status}; only a planning chain can be launched`)
    }
    const input = Array.isArray(groups) ? groups : undefined
    const issues = this.launchIssues(chain, store, input)
    if (issues.length > 0) return { issues, conflicts: [], waiting: [] }
    const document = store.readFeatures(chain.chainId)
    const plan = this.validateClusterGroups(document, input ?? chain.launchPlan.groups)
    const waiting = []
    plan.forEach((group, index) => {
      if (group.isolation !== 'shared') return
      const waitsFor = this.unmetDependencies(document, group)
      if (waitsFor.length > 0) waiting.push({ index, waitsFor })
    })
    return { issues, conflicts: clusterConflicts(document, plan, chain.cwd), waiting }
  }

  /**
   * Open the sessions of a proposed launch plan. Human only: the panel and `/relay launch` call this,
   * and there is deliberately no tool for it.
   * `shared` groups each get a worker; `worktree` groups are not opened in this version and their
   * features stay with the planning session. One group failing does not stop the others.
   * @param {{ chainId: string, groups?: Array<object> }} input - chain, and the plan as the human edited it.
   * @returns {Promise<{ chainId: string, status: string, results: Array<object> }>} what happened to each group.
   */
  async launchCluster({ chainId, groups }) {
    const { chain, store } = this.findChain(chainId)
    if (chain.status !== 'planning') {
      throw new RelayError(RELAY_CODES.invalid, `chain ${chain.chainId} is ${chain.status}; only a planning chain can be launched`)
    }
    const input = Array.isArray(groups) ? groups : undefined
    const [issue] = this.launchIssues(chain, store, input)
    if (issue !== undefined) throw new RelayError(issue.code === 'not-loaded' ? RELAY_CODES.notFound : RELAY_CODES.invalid, issue.message)
    // A blocker mirrored from a goal that no longer blocks is stale; clear it before going on.
    if (chain.blocker !== null && chain.blocker !== undefined && this.effectiveLaunchBlocker(chain) === null) {
      this.recordBlocker(store, chain.chainId, null)
    }
    const head = this.ctx.get('agents').get(chain.currentSessionId)
    const document = store.readFeatures(chain.chainId)
    const plan = this.validateClusterGroups(document, input ?? chain.launchPlan.groups)
    const conflicts = clusterConflicts(document, plan, chain.cwd)
    const snapshot = document.features.map(({ id, title }) => ({ id, title }))

    this.busyChains.add(chain.chainId)
    try {
      const results = []
      for (const group of plan) {
        if (group.isolation === 'worktree') {
          results.push({ id: group.id, launched: false, reason: WORKTREE_UNAVAILABLE })
          continue
        }
        // A worker must not start on work whose foundation does not exist yet.
        const waitsFor = this.unmetDependencies(store.readFeatures(chain.chainId), group)
        if (waitsFor.length > 0) {
          results.push({ id: group.id, launched: false, waiting: true, waitsFor, reason: `waits for ${waitsFor.join(', ')} to pass` })
          continue
        }
        try {
          results.push(await this.openClusterGroup(chain, store, head, group))
        } catch (error) {
          results.push({ id: group.id, launched: false, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      const sharedIds = new Set(plan.filter(group => group.isolation === 'shared').map(group => group.id))
      const failed = results.filter(result => !result.launched && !result.waiting && sharedIds.has(result.id))
      const openable = results.filter(result => !result.waiting && sharedIds.has(result.id))
      if (openable.length > 0 && failed.length === openable.length) {
        throw new RelayError(RELAY_CODES.io, `no cluster group could be launched: ${failed[0].reason}`)
      }
      const launchedAt = new Date().toISOString()
      const headGoalId = this.config.clusterGoals && this.goalOf(head) === undefined
        ? this.createChainGoal(chain, store, head)
        : undefined
      // The list that was validated is frozen with the state flip, not while planning and not before the groups opened:
      // a launch that opened nothing must leave the list editable. The sessions exist by now, so a fingerprint
      // that cannot be written only warns.
      try {
        this.fingerprints.set(chain.chainId, snapshot)
      } catch (error) {
        this.warn(`could not freeze the feature list of ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.record(store, chain.chainId, { kind: 'features.frozen', actor: 'host', detail: { features: snapshot.length } })
      store.update(chain.chainId, record => {
        record.status = 'active'
        record.launchedAt = launchedAt
        record.launchPlan = { ...record.launchPlan, groups: plan, conflicts, results, launchedAt }
        record.lastError = failed.length === 0 ? null : `cluster groups not launched: ${failed.map(result => result.id).join(', ')}`
        const entry = record.sessions.find(session => session.sessionId === head.id)
        if (entry !== undefined && typeof headGoalId === 'string') {
          entry.goalId = headGoalId
          entry.goalSeeded = true
        }
      })
      const settled = store.readChain(chain.chainId)
      if (settled !== undefined) this.remember(settled, store)
      this.record(store, chain.chainId, { kind: 'cluster.launched', actor: 'host', detail: { results } })

      // What the planning session still owns, and why, so it does not wait for workers that were never opened.
      const after = store.readFeatures(chain.chainId)
      const kept = (after?.features ?? [])
        .filter(feature => !feature.passes && (typeof feature.assignedSessionId !== 'string' || feature.assignedSessionId.length === 0))
        .filter(feature => {
          // A waiting group's features are not the planning session's: the group opens by itself later.
          const group = plan.find(candidate => candidate.features.includes(feature.id))
          return results.find(item => item.id === group?.id)?.waiting !== true
        })
        .map(feature => {
          const group = plan.find(candidate => candidate.features.includes(feature.id))
          const result = group === undefined ? undefined : results.find(item => item.id === group.id)
          return { id: feature.id, why: result === undefined ? 'it is in no group' : `group ${result.id} was not launched: ${result.reason}` }
        })
      try {
        head.followup(relayMessage(renderClusterLaunchedNotice({
          chainId: chain.chainId,
          truthDir: join(store.truthDir, chain.chainId),
          groups: plan.map(group => ({ ...group, ...results.find(result => result.id === group.id) })),
          kept,
        })))
      } catch (error) {
        this.warn(`could not queue the cluster launch notice: ${error instanceof Error ? error.message : String(error)}`)
      }
      return { chainId: chain.chainId, status: 'active', results }
    } finally {
      this.busyChains.delete(chain.chainId)
    }
  }

  /**
   * Start `launchWaitingGroups` in the background when a cluster chain has waiting groups.
   * The cheap check comes first so other chains pay nothing; the caller never waits for the result.
   * @param {object|undefined} chain - chain record.
   * @returns {void}
   */
  releaseWaitingGroups(chain) {
    if (chain?.mode !== 'cluster' || !Array.isArray(chain.launchPlan?.results)
      || !chain.launchPlan.results.some(result => result.waiting === true)) return
    void this.launchWaitingGroups(chain.chainId).catch(error => {
      this.warn(`could not release the waiting groups of ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Feature ids a launch group is still waiting for.
   * A dependency in the same group runs in order and does not count; any other dependency must pass first.
   * A dependency that is not in features.json counts as unmet.
   * @param {{ features: Array<object> }|undefined} document - normalized features.
   * @param {{ features: Array<string> }} group - the launch group.
   * @returns {Array<string>} unmet dependency ids, without repeats.
   */
  unmetDependencies(document, group) {
    const byId = new Map((document?.features ?? []).map(feature => [feature.id, feature]))
    const own = new Set(group.features)
    const unmet = []
    for (const id of group.features) {
      for (const dependency of byId.get(id)?.dependsOn ?? []) {
        if (own.has(dependency) || unmet.includes(dependency)) continue
        if (byId.get(dependency)?.passes !== true) unmet.push(dependency)
      }
    }
    return unmet
  }

  /**
   * Open one shared group: select its features, create the worker, and give it a goal.
   * Used by the launch and by the later release of a waiting group. Throws when the worker cannot be opened.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object} head - the live planning session, the worker's parent.
   * @param {{ id: string, title: string, reason: string, features: Array<string> }} group - the group.
   * @returns {Promise<{ id: string, launched: true, sessionId: string }>} the result entry.
   */
  async openClusterGroup(chain, store, head, group) {
    const current = store.readFeatures(chain.chainId)
    const selected = group.features.map(id => current?.features.find(feature => feature.id === id))
    if (selected.some(feature => feature === undefined)) {
      throw new RelayError(RELAY_CODES.invalid, `group ${group.id} names a feature that is no longer in features.json`)
    }
    const taken = selected.find(feature => feature.passes || (typeof feature.assignedSessionId === 'string' && feature.assignedSessionId.length > 0))
    if (taken !== undefined) {
      throw new RelayError(RELAY_CODES.invalid, `feature ${taken.id} of group ${group.id} already passes or is already delegated`)
    }
    const worker = await this.spawnWorker(chain, store, head, selected, {
      note: `Cluster group ${group.id}: ${group.title}. ${group.reason}`,
      actor: 'host',
      cluster: true,
    })
    this.seedClusterWorkerGoal(chain, store, worker.sessionId, group)
    return { id: group.id, launched: true, sessionId: worker.sessionId }
  }

  /**
   * Open the launch groups that were waiting for features to pass, once those pass.
   * Called after checkpoints and evaluations; it never throws for a chain that has nothing to do.
   * A group that fails to open becomes a plain failure, so it is not retried forever.
   * @param {string} chainId - chain identity.
   * @returns {Promise<void>} settles when every releasable group was handled.
   */
  async launchWaitingGroups(chainId) {
    let found
    try {
      found = this.findChain(chainId)
    } catch {
      return
    }
    const { chain, store } = found
    const stored = chain.launchPlan?.results
    if (chain.mode !== 'cluster' || chain.status !== 'active' || !Array.isArray(stored) || !stored.some(result => result.waiting === true)) return
    if (this.busyChains.has(chain.chainId)) return
    const head = this.ctx.get('agents')?.get(chain.currentSessionId)
    if (head === undefined) return
    this.busyChains.add(chain.chainId)
    try {
      const document = store.readFeatures(chain.chainId)
      const results = stored.slice()
      const opened = []
      const failed = []
      for (let index = 0; index < results.length; index += 1) {
        if (results[index].waiting !== true) continue
        const group = chain.launchPlan.groups?.find(candidate => candidate.id === results[index].id)
        if (group === undefined || this.unmetDependencies(document, group).length > 0) continue
        try {
          results[index] = await this.openClusterGroup(chain, store, head, group)
          opened.push({ ...group, sessionId: results[index].sessionId })
          this.record(store, chain.chainId, { kind: 'cluster.group-launched', actor: 'host', detail: { id: group.id, sessionId: results[index].sessionId } })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          results[index] = { id: group.id, launched: false, reason: message }
          failed.push(group.id)
          this.record(store, chain.chainId, { kind: 'cluster.group-failed', actor: 'host', detail: { id: group.id, error: message } })
        }
      }
      if (opened.length === 0 && failed.length === 0) return
      store.update(chain.chainId, record => {
        record.launchPlan = { ...record.launchPlan, results }
        if (failed.length > 0) record.lastError = `cluster groups not launched: ${failed.join(', ')}`
      })
      const settled = store.readChain(chain.chainId)
      if (settled !== undefined) this.remember(settled, store)
      if (opened.length > 0) {
        try {
          head.followup(relayMessage(renderClusterGroupOpenedNotice({ chainId: chain.chainId, groups: opened })))
        } catch (error) {
          this.warn(`could not queue the group-opened notice: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      this.busyChains.delete(chain.chainId)
    }
  }

  /**
   * Give a launched cluster worker a goal for its own features, so it does not stop after one turn.
   * Never throws: a missing goals service or a failed create only costs the worker its goal.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {string} sessionId - the worker session.
   * @param {{ title: string, features: Array<string> }} group - the group the worker owns.
   * @returns {void}
   */
  seedClusterWorkerGoal(chain, store, sessionId, group) {
    if (!this.config.clusterGoals) return
    const goals = this.ctx.get('goals')
    const child = this.ctx.get('agents')?.get(sessionId)
    if (goals === undefined || typeof goals.create !== 'function' || child === undefined) {
      this.warn(`worker ${sessionId} has no goal: the goals service or the session is unavailable`)
      return
    }
    try {
      const view = goals.create(child, {
        objective: `${chain.objective} — cluster group ${group.title}: features ${group.features.join(', ')}`,
        maxGoalRounds: this.config.goalRoundsPerHandoff,
      })
      if (typeof view?.id !== 'string') return
      store.update(chain.chainId, record => {
        const entry = record.sessions.find(session => session.sessionId === sessionId)
        if (entry !== undefined) {
          entry.goalId = view.id
          entry.goalSeeded = true
        }
      })
      // The goal was just created armed in this process; a later disarm is somebody's decision (same as a handoff successor).
      this.statsFor(sessionId).rearmChecked = true
    } catch (error) {
      this.warn(`could not create a goal for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * A worker's plugin-created goal with the live session that has it.
   * Only a goal the plugin recorded on the entry (`goalSeeded`, and the id still matches the live goal)
   * qualifies: a goal the user set on a worker is the user's.
   * @param {object|undefined} entry - the worker's session entry.
   * @returns {{ goals: object, agent: object, view: object }|undefined} undefined when the worker has no such goal or is not loaded.
   */
  workerGoalOf(entry) {
    if (entry?.goalSeeded !== true || typeof entry.goalId !== 'string') return undefined
    const goals = this.ctx.get('goals')
    const agent = this.ctx.get('agents')?.get(entry.sessionId)
    if (goals === undefined || agent === undefined) return undefined
    const view = this.goalOf(agent)
    if (view === undefined || view.id !== entry.goalId) return undefined
    return { goals, agent, view }
  }

  /**
   * Bring a worker's plugin-created goal in line with the chain and with the work the worker owns.
   * The one place that pauses, resumes, re-arms or completes such a goal; callers only say that something
   * changed. It decides from the current state, so running it twice does nothing the second time, and a
   * worker that is not loaded is simply looked at again by its next evaluation. A goal a human paused (no
   * `goalPausedByRelay` on the entry) and a goal the user created are never touched. Never throws.
   * 1. The chain is done or failed: the goal ends.
   * 2. The worker owns no unfinished feature, or the chain is paused: the goal is paused and flagged.
   * 3. The chain is active and the worker owns work: a goal this plugin paused is resumed; a goal left disarmed
   *    by a reload is re-armed, once per session load.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object|undefined} entry - the worker's session entry.
   * @param {{ features: Array<object> }|undefined} [given] - features.json as the caller already read it; read here when absent.
   * @returns {void}
   */
  syncWorkerGoal(chain, store, entry, given) {
    try {
      const found = this.workerGoalOf(entry)
      if (found === undefined) return
      const { goals, agent, view } = found
      const ref = { id: view.id, revision: view.revision }
      const detail = { sessionId: agent.id, goalId: view.id }
      const setFlag = value => store.update(chain.chainId, record => {
        const target = record.sessions.find(session => session.sessionId === entry.sessionId)
        if (target === undefined) return
        if (value) target.goalPausedByRelay = true
        else delete target.goalPausedByRelay
      })
      // A goal that is no longer paused was taken over by a human: the flag is spent, and a later pause is theirs.
      let pausedByRelay = entry.goalPausedByRelay === true
      if (pausedByRelay && view.phase !== 'paused') {
        setFlag(false)
        pausedByRelay = false
      }
      if (chain.status === 'done' || chain.status === 'failed') {
        if (['active', 'paused', 'blocked'].includes(view.phase) && typeof goals.complete === 'function') {
          goals.complete(agent, ref)
          this.record(store, chain.chainId, { kind: 'goal.completed', actor: 'system', detail })
        }
        if (pausedByRelay) setFlag(false)
        return
      }
      const document = given ?? store.readFeatures(chain.chainId)
      const owns = (document?.features ?? []).some(feature => feature.assignedSessionId === agent.id && !feature.passes)
      if (!owns || chain.status === 'paused') {
        if (view.phase === 'active' && typeof goals.pause === 'function') {
          goals.pause(agent, ref)
          setFlag(true)
          this.record(store, chain.chainId, { kind: 'goal.paused', actor: 'system', detail: { ...detail, why: owns ? 'chain-paused' : 'no-work' } })
        }
        return
      }
      if (chain.status !== 'active') return
      const roundsLeft = view.roundsStarted < view.maxGoalRounds
      if (view.phase === 'paused' && pausedByRelay && roundsLeft && typeof goals.resume === 'function') {
        goals.resume(agent, ref)
        setFlag(false)
        this.record(store, chain.chainId, { kind: 'goal.resumed', actor: 'system', detail })
        return
      }
      // The host disarms goals each time a session is loaded: one re-arm attempt per load, like the head's.
      const stats = this.statsFor(agent.id)
      if (!this.config.rearmGoalOnReload || stats.rearmChecked) return
      stats.rearmChecked = true
      if (view.phase === 'active' && view.activation === 'disarmed' && stats.wrapupSentAt === 0 && roundsLeft
        && typeof goals.resume === 'function') {
        goals.resume(agent, ref)
        this.record(store, chain.chainId, { kind: 'goal.rearmed', actor: 'system', detail })
      }
    } catch (error) {
      this.warn(`could not sync the goal of worker ${entry?.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Reconcile the goals of every worker of a chain after something that can change the chain's status or
   * who owns which feature. Reads the chain again, so the caller may hold an older record.
   * @param {object} chain - chain record, for the identity.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @returns {void}
   */
  syncWorkerGoals(chain, store) {
    try {
      const current = store.readChain(chain.chainId)
      if (current === undefined) return
      const document = store.readFeatures(chain.chainId)
      for (const entry of current.sessions) {
        if (this.isWorker(entry) && (entry.retiredAt === null || entry.retiredAt === undefined)) this.syncWorkerGoal(current, store, entry, document)
      }
    } catch (error) {
      this.warn(`could not sync the worker goals of chain ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
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
    const describe = session => ({
      ...this.sessionSnapshot(session),
      goal: this.goalViewOf(this.ctx.get('agents')?.get(session.sessionId)),
      planMode: this.planActive(this.ctx.get('agents')?.get(session.sessionId)),
    })
    const brief = feature => ({
      id: feature.id,
      title: feature.title,
      passes: feature.passes,
      evidence: feature.evidence,
      verify: feature.verify,
      coverage: feature.coverage ?? null,
      acceptedBy: feature.acceptedBy ?? null,
    })
    const children = chain.sessions
      .filter(session => session.parentSessionId === sessionId)
      .map(session => {
        const owned = features.filter(feature => feature.assignedSessionId === session.sessionId)
        return {
          ...describe(session),
          features: owned.map(feature => feature.id),
          featuresPassed: owned.filter(feature => feature.passes).length,
          // Titles and pass state, so the tab does not show bare ids.
          featureList: owned.map(feature => ({ id: feature.id, title: feature.title, passes: feature.passes })),
        }
      })
    return {
      chain: chainSummary(chain, {
        progress: document === undefined ? undefined : featureProgress(document),
        stall: this.stallOf(chain),
        conflicts: this.crossChainConflicts(chain, document),
      }),
      head: this.headState(chain),
      self: describe(self),
      parent: self.parentSessionId === null || self.parentSessionId === undefined
        ? null
        : chain.sessions.find(session => session.sessionId === self.parentSessionId) === undefined
          ? { sessionId: self.parentSessionId }
          : describe(chain.sessions.find(session => session.sessionId === self.parentSessionId)),
      children,
      assignedFeatures: features
        .filter(feature => feature.assignedSessionId === sessionId)
        .map(brief),
      // Features nobody was delegated: the chain's main-line session works on these.
      openFeatures: features
        .filter(feature => typeof feature.assignedSessionId !== 'string' || feature.assignedSessionId.length === 0)
        .map(brief),
    }
  }

  /**
   * One truth-source document of a chain, for the panel's document reader.
   * Long ledgers return their newest part: the tail is what a reader wants from
   * an append-only file.
   * @param {string} chainId - chain identity.
   * @param {'handoff'|'progress'|'history'|'decisions'|'traps'|'plan'|'spec'} name - which document.
   * @returns {{ name: string, text: string, truncated: boolean }} document text.
   */
  doc(chainId, name) {
    if (!['handoff', 'progress', 'history', 'decisions', 'traps', 'plan', 'spec'].includes(name)) {
      throw new RelayError(RELAY_CODES.invalid, `unknown document ${String(name)}`)
    }
    const { store } = this.findChain(chainId)
    let text = ''
    try {
      text = readFileSync(store.paths(chainId)[name], 'utf8')
    } catch {
      /* a document that was never written reads as empty */
    }
    const limit = 16000
    return { name, text: text.length > limit ? text.slice(-limit) : text, truncated: text.length > limit }
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

  /**
   * How many handoffs the history file already records.
   * @param {import('./chain-store.js').ChainStore} store - chain store.
   * @param {string} chainId - chain identity.
   * @returns {number} entry count.
   */
  historyEntries(store, chainId) {
    try {
      return (store.readHistory(chainId).match(/^## Handoff #/gm) ?? []).length
    } catch {
      return 0
    }
  }

  /**
   * Append the brief the retiring session wrote, so a later session can still
   * read it after HANDOFF.md is overwritten.
   * @param {import('./chain-store.js').ChainStore} store - chain store.
   * @param {object} chain - chain record.
   * @param {{ from: string, to: string, handoffNo: number, reason: string, handoff: string }} entry - handoff facts.
   * @returns {void}
   */
  appendHistory(store, chain, entry) {
    const brief = entry.handoff.trim()
    const body = [
      `## Handoff #${entry.handoffNo} — ${entry.from} → ${entry.to} — ${new Date().toISOString()}`,
      `Reason: ${entry.reason}`,
      '',
      brief.length === 0 ? '(the previous session wrote no handoff brief)' : brief,
    ].join('\n')
    try {
      store.appendHistory(chain.chainId, body)
    } catch (error) {
      this.warn(`could not append the handoff history for ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Search this chain's memory for lines containing every word of the query.
   * The ledgers grow across handoffs, so recall lets a session look things up
   * instead of reading every file in full.
   * @param {{ agent?: object, chainId?: string, query: string, limit?: number }} input - recall input.
   * @returns {{ chainId: string, query: string, total: number, returned: number, truncated: boolean, matches: Array<object> }} matches.
   */
  recall({ agent, chainId, query, limit }) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'query is required')
    }
    const { chain, store } = this.resolveChain(agent, chainId)
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 30
    const paths = store.paths(chain.chainId)
    const matches = []
    let total = 0

    /** Match one line at a time; used for JSON where a paragraph has no meaning. */
    const collectLines = (name, file) => {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        return
      }
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!words.every(word => line.toLowerCase().includes(word))) continue
        total += 1
        if (matches.length < cap) matches.push({ file: name, line: index + 1, text: line.trim().slice(0, 240) })
      }
    }

    /** Match a blank-line separated block and report the block's first line. */
    const collectParagraphs = (name, file) => {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        return
      }
      let start = -1
      let buffer = []
      const flush = () => {
        if (buffer.length === 0) return
        const body = buffer.join('\n')
        if (words.every(word => body.toLowerCase().includes(word))) {
          total += 1
          if (matches.length < cap) {
            matches.push({ file: name, line: start, text: body.trim().replace(/\s+/g, ' ').slice(0, 240) })
          }
        }
        start = -1
        buffer = []
      }
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line.trim().length === 0) {
          flush()
          continue
        }
        if (buffer.length === 0) start = index + 1
        buffer.push(line)
      }
      flush()
    }

    collectParagraphs('PLAN.md', paths.plan)
    collectParagraphs('HANDOFF.md', paths.handoff)
    collectParagraphs('history.md', paths.history)
    collectParagraphs('PROGRESS.md', paths.progress)
    collectParagraphs('decisions.md', paths.decisions)
    collectParagraphs('traps.md', paths.traps)
    collectLines('features.json', paths.features)
    // The audit log can grow without bound; only its tail is searchable.
    try {
      for (const record of store.readAudit(chain.chainId, 500)) {
        const body = JSON.stringify(record)
        if (!words.every(word => body.toLowerCase().includes(word))) continue
        total += 1
        if (matches.length < cap) matches.push({ file: 'audit.jsonl', line: null, text: body.slice(0, 240) })
      }
    } catch {
      /* the audit log is optional */
    }
    return {
      chainId: chain.chainId,
      query: query.trim(),
      total,
      returned: matches.length,
      truncated: total > matches.length,
      matches,
    }
  }

  /** Record one successful compaction for a session and persist the count. */
  noteCompaction(sessionId) {
    const stats = this.statsFor(sessionId)
    const known = this.members.get(sessionId)
    // A compaction can arrive before the first evaluation; start from the
    // durable count so a reload does not reset the budget.
    if (!stats.hydrated) {
      if (known !== undefined) {
        try {
          const chain = this.storeFor(known.truthDir).readChain(known.chainId)
          const recorded = chain?.sessions.find(session => session.sessionId === sessionId)?.compactions
          if (typeof recorded === 'number' && recorded > stats.compactions) stats.compactions = recorded
        } catch {
          /* the count restarts from this process */
        }
      }
      stats.hydrated = true
    }
    stats.compactions += 1
    if (known === undefined) return
    try {
      this.storeFor(known.truthDir).update(known.chainId, record => {
        const session = record.sessions.find(entry => entry.sessionId === sessionId)
        if (session !== undefined) session.compactions = stats.compactions
      })
    } catch (error) {
      this.warn(`could not persist the compaction count for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
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
    const entry = chain.sessions.find(session => session.sessionId === agent.id)
    if (entry === undefined) return

    // A delegated worker only supervises its own phase; the chain head owns handoff.
    if (this.isWorker(entry)) {
      // Whatever the chain's status: a worker of a paused or finished chain still has to be reconciled, and
      // a worker loaded after the change was made is only reached here. `chain` was read a moment ago.
      this.syncWorkerGoal(chain, store, entry)
      await this.evaluateWorker(chain, store, entry, agent)
      return
    }
    if (chain.currentSessionId !== agent.id) return

    // A half-finished handoff is reconciled before any policy decision.
    this.reconcilePendingHandoff(chain, store)
    const reconciled = store.readChain(chain.chainId)
    if (reconciled === undefined) return
    chain = reconciled
    // Resolving a leftover handoff can move the chain head; the old one must stop.
    if (chain.currentSessionId !== agent.id) return

    // Goal state is synced before the handoff policy: a blocked goal means the
    // session will not continue on its own, and that must reach the chain even
    // when automatic handoff is off. The record may have just been rewritten.
    if (this.syncGoalBlocker(chain, store, agent)) return
    const refreshed = store.readChain(chain.chainId)
    if (refreshed === undefined) return
    chain = refreshed
    // Whatever path changed the chain's status, the head going idle reconciles every worker's goal.
    if (chain.mode === 'cluster') this.syncWorkerGoals(chain, store)
    if (chain.status !== 'active' && chain.status !== 'initializing') return
    this.releasePausedGoal(chain, store, 'system')
    // Before the group release: that starts a background launch, which marks the chain busy and would make the re-arm give up.
    this.rearmGoal(chain, store, agent, entry)
    // A restart, or features marked passing by editing the file, still releases waiting groups.
    this.releaseWaitingGroups(chain)
    // A wrap-up that was already sent (a manual handoff on a stale brief, or the
    // switch turned off mid-wrap-up) holds the goal, so it must still reach its handoff.
    // Only a wrap-up that was actually sent passes: a model-reported `ready` alone must not re-enable the automatic policy.
    if (!this.config.autoHandoff && (chain.wrapupAt === null || chain.wrapupAt === undefined)) return

    const stats = this.statsFor(agent.id)
    // Compaction counts live in memory; the chain record is the only value that
    // survives a plugin reload or Host restart.
    if (!stats.hydrated) {
      const recorded = chain.sessions.find(session => session.sessionId === agent.id)?.compactions
      if (typeof recorded === 'number' && recorded > stats.compactions) stats.compactions = recorded
      if (chain.wrapupAt !== null && chain.wrapupAt !== undefined) {
        const at = Date.parse(chain.wrapupAt)
        // A timestamp in the future (clock skew) would stall both deadlines.
        if (Number.isFinite(at)) stats.wrapupSentAt = Math.min(at, Date.now())
      }
      if (chain.readySessionId === agent.id && typeof chain.readyAt === 'string') stats.ready = true
      stats.hydrated = true
      // A reload in the middle of a wrap-up must still hit the deadline.
      this.scheduleWrapupDeadline(agent)
    }
    const now = Date.now()
    const wait = this.config.cooldownMs - (now - stats.lastEvaluatedAt)
    if (wait > 0) {
      // Do not drop a cooled-down check: run it when the window opens instead.
      this.scheduleEvaluate(agent.id, wait)
      return
    }
    stats.lastEvaluatedAt = now

    const pressure = this.pressure(agent.session)
    if (pressure.ratio > stats.peakRatio) stats.peakRatio = pressure.ratio
    const freshness = this.handoffFreshness(chain, store, entry)

    this.busyAgents.add(agent.id)
    try {
      if (stats.compactions >= this.config.hardCompactions) {
        if (!freshness.fresh) {
          const graceElapsed = stats.wrapupSentAt !== 0
            && now - stats.wrapupSentAt >= this.config.staleHandoffMinutes * 60_000
          if (!graceElapsed) {
            // Compactions force a handoff, but a stale brief means the next
            // session would start blind: wrap up first and give it the grace.
            if (stats.wrapupSentAt === 0) {
              this.record(store, chain.chainId, {
                kind: 'supervisor.decision',
                actor: 'system',
                detail: { action: 'wrapup', by: 'stale-handoff', ratio: Number(pressure.ratio.toFixed(3)) },
              })
              await this.wrapup(chain, store, agent)
              this.scheduleEvaluate(agent.id, this.config.staleHandoffMinutes * 60_000)
            } else {
              this.scheduleEvaluate(agent.id, this.config.staleHandoffMinutes * 60_000 - (now - stats.wrapupSentAt))
            }
            return
          }
        }
        this.record(store, chain.chainId, {
          kind: 'supervisor.decision',
          actor: 'system',
          detail: { action: 'handoff', reason: 'compactions', compactions: stats.compactions, ratio: Number(pressure.ratio.toFixed(3)) },
        })
        await this.handoff(chain, agent, 'compactions', store, { stale: !freshness.fresh })
        return
      }
      if (stats.wrapupSentAt === 0) {
        // A session may wrap itself up without the supervisor's prompt (the
        // model sets ready when its own plan says the work is handed off);
        // that is an explicit handoff signal, not a no-op.
        if (stats.ready) {
          this.record(store, chain.chainId, {
            kind: 'supervisor.decision',
            actor: 'system',
            detail: { action: 'handoff', reason: 'checkpoint', ratio: Number(pressure.ratio.toFixed(3)) },
          })
          await this.handoff(chain, agent, 'checkpoint', store, { stale: !freshness.fresh })
          return
        }
        // wrapupRatio starts the wrap-up with half the window still available;
        // handoffRatio only forces a handoff once the wrap-up was already sent.
        const byPressure = pressure.ratio >= this.config.wrapupRatio
        const byCompaction = stats.compactions >= this.config.handoffAfterCompactions
          && pressure.ratio >= this.config.compactedRatioFloor
        if (byPressure || byCompaction) {
          this.record(store, chain.chainId, {
            kind: 'supervisor.decision',
            actor: 'system',
            detail: { action: 'wrapup', by: byPressure ? 'pressure' : 'compaction', ratio: Number(pressure.ratio.toFixed(3)) },
          })
          await this.wrapup(chain, store, agent)
          return
        }
        this.maybeAutoContinue(chain, store, agent, stats)
        return
      }
      const timedOut = now - stats.wrapupSentAt >= this.config.wrapupTimeoutMinutes * 60_000
      const stale = !freshness.fresh
      const staleGrace = stale && now - stats.wrapupSentAt >= this.config.staleHandoffMinutes * 60_000
      // A stale brief suppresses the pressure trigger until its grace passes;
      // ready and timeout are stronger signals and keep their meaning.
      const ratioTrigger = pressure.ratio >= this.config.handoffRatio && (!stale || staleGrace)
      if (stats.ready || ratioTrigger || timedOut || staleGrace) {
        const reason = stats.ready ? 'checkpoint' : timedOut ? 'timeout' : staleGrace ? 'stale' : 'pressure'
        this.record(store, chain.chainId, {
          kind: 'supervisor.decision',
          actor: 'system',
          detail: { action: 'handoff', reason, ratio: Number(pressure.ratio.toFixed(3)) },
        })
        await this.handoff(chain, agent, reason, store, { stale })
        return
      }
      // Keep a re-check attached for whichever deadline comes first, so a
      // wrapped-up session never waits for an idle event that will not come.
      const wrapRemaining = this.config.wrapupTimeoutMinutes * 60_000 - (now - stats.wrapupSentAt)
      const staleRemaining = stale
        ? this.config.staleHandoffMinutes * 60_000 - (now - stats.wrapupSentAt)
        : Number.POSITIVE_INFINITY
      this.scheduleEvaluate(agent.id, Math.max(1000, Math.min(wrapRemaining, staleRemaining)))
    } catch (error) {
      this.warn(`evaluate failed for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busyAgents.delete(agent.id)
    }
  }

  /**
   * Whether the handoff brief was written by the session that is retiring.
   * A brief without a state block is missing; one whose content is still what
   * this session was handed belongs to an earlier session.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object|undefined} entry - the retiring session entry.
   * @returns {{ fresh: boolean, reason?: string }} freshness.
   */
  handoffFreshness(chain, store, entry) {
    let text = ''
    try {
      text = store.readHandoff(chain.chainId)
    } catch {
      text = ''
    }
    if (!/<!--\s*relay:state\s*-->/.test(text)) return { fresh: false, reason: 'missing' }
    // The session rewrote the brief when its content differs from what the
    // session was given. A file time cannot say that: a checkout, a stash, or a
    // copied workspace touches the file without anyone rewriting it.
    if (typeof entry?.handoffHashAtJoin === 'string') {
      return handoffHash(text) === entry.handoffHashAtJoin ? { fresh: false, reason: 'stale' } : { fresh: true }
    }
    // Sessions that joined before the fingerprint was recorded keep the time rule.
    let mtime = 0
    try {
      mtime = statSync(store.paths(chain.chainId).handoff).mtimeMs
    } catch {
      mtime = 0
    }
    const joined = typeof entry?.joinedAt === 'string' ? Date.parse(entry.joinedAt) : Number.NaN
    if (Number.isFinite(joined) && mtime > 0 && mtime < joined - HANDOFF_MTIME_SLACK_MS) return { fresh: false, reason: 'stale' }
    return { fresh: true }
  }

  /**
   * Resolve a leftover `pendingHandoff` from a failed handoff.
   * When the created session is already a chain member it becomes the current
   * session; otherwise the pending record is dropped so the next handoff starts
   * clean instead of leaving an orphan session in play.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @returns {void}
   */
  reconcilePendingHandoff(chain, store) {
    const pending = chain.pendingHandoff
    if (pending === null || pending === undefined || typeof pending.sessionId !== 'string') return
    const sessionId = pending.sessionId
    let live
    try {
      live = this.ctx.get('agents')?.get(sessionId)
    } catch {
      live = undefined
    }
    const entry = chain.sessions.find(session => session.sessionId === sessionId)
    if (live !== undefined && entry !== undefined) {
      store.update(chain.chainId, record => {
        record.currentSessionId = sessionId
        record.pendingHandoff = null
        record.status = 'active'
        record.pausedBy = null
        record.lastError = null
      })
      this.syncWorkerGoals(chain, store)
      this.record(store, chain.chainId, { kind: 'handoff.recovered', actor: 'system', detail: { sessionId } })
      return
    }
    store.update(chain.chainId, record => { record.pendingHandoff = null })
    this.record(store, chain.chainId, { kind: 'handoff.abandoned', actor: 'system', detail: { sessionId } })
  }

  /**
   * Nudge an idle chain head when the automatic continuation is enabled.
   * A goal that is already driving the session wins: two loops would double-run.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object} agent - live chain head.
   * @param {object} stats - its supervisor state.
   * @returns {void}
   */
  maybeAutoContinue(chain, store, agent, stats) {
    if (!this.config.autoContinue) return
    if (stats.ready || stats.wrapupSentAt !== 0) return
    if (chain.blocker !== null && chain.blocker !== undefined) return
    try {
      const goals = this.ctx.get('goals')
      const view = goals?.get?.(agent)
      // A disarmed goal does not drive the session, so only an armed one wins.
      if (view !== undefined && view.phase === 'active' && view.activation === 'armed') return
    } catch {
      /* the goal service is optional */
    }
    if (stats.autoContinues >= this.config.maxAutoContinues) {
      this.recordBlocker(store, chain.chainId, {
        kind: 'external',
        who: 'human',
        action: `${CONTINUE_LIMIT_BLOCKER_PREFIX} of ${this.config.maxAutoContinues} reached; resume or hand off manually`,
      })
      this.record(store, chain.chainId, {
        kind: 'session.continue-limit',
        actor: 'system',
        detail: { continues: stats.autoContinues },
      })
      return
    }
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) return
    const progress = featureProgress(document)
    const next = document.features
      .filter(feature => !feature.passes && (feature.assignedSessionId === null || feature.assignedSessionId === undefined))
      .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))[0]
    if (next === undefined) return
    try {
      agent.followup(relayMessage(renderContinuePrompt({
        truthDir: join(store.truthDir, chain.chainId),
        feature: next,
        done: progress.done,
        total: progress.total,
      })))
    } catch (error) {
      this.warn(`could not queue the continue prompt for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    stats.autoContinues += 1
    this.record(store, chain.chainId, {
      kind: 'session.continued',
      actor: 'system',
      detail: { feature: next.id, count: stats.autoContinues },
    })
  }

  /**
   * Pressure supervision for a delegated worker: ask it to wrap up and take its
   * unfinished features back to the chain instead of letting it compact.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object} entry - the worker's session entry.
   * @param {object} agent - live worker.
   * @returns {Promise<void>} settles after any action.
   */
  async evaluateWorker(chain, store, entry, agent) {
    if (this.unloaded) return
    if (chain.status !== 'active' && chain.status !== 'initializing') return
    const stats = this.statsFor(agent.id)
    const now = Date.now()
    if (now - stats.lastEvaluatedAt < this.config.cooldownMs) return
    stats.lastEvaluatedAt = now
    if (stats.wrapupSentAt !== 0) return
    const pressure = this.pressure(agent.session)
    const byPressure = pressure.ratio >= this.config.wrapupRatio
    const byCompaction = stats.compactions >= this.config.hardCompactions
    if (!byPressure && !byCompaction) return
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) return
    const owned = document.features.filter(feature => feature.assignedSessionId === entry.sessionId && !feature.passes)
    if (owned.length === 0) return
    try {
      agent.followup(relayMessage(renderWorkerWrapupPrompt({
        truthDir: join(store.truthDir, chain.chainId),
        features: owned,
      })))
    } catch (error) {
      this.warn(`could not queue the worker wrap-up for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    stats.wrapupSentAt = Date.now()
    store.patchFeatures(chain.chainId, owned.map(feature => ({ id: feature.id, assignedSessionId: null })))
    const stamp = new Date().toISOString()
    store.writeProgress(chain.chainId, `${store.readProgress(chain.chainId).replace(/\s*$/, '\n')}- [${stamp}] returned ${owned.map(feature => feature.id).join(', ')} from worker ${entry.sessionId} (context ${Math.round(pressure.ratio * 100)}%)\n`)
    this.record(store, chain.chainId, {
      kind: 'delegation.returned',
      actor: 'system',
      detail: { sessionId: entry.sessionId, features: owned.map(feature => feature.id), ratio: Number(pressure.ratio.toFixed(3)) },
    })
    // The worker owns nothing now: a goal round would only send it back to work it no longer has.
    this.syncWorkerGoal(chain, store, entry)
  }

  /**
   * Take a worker's unfinished features back to the chain.
   * Only the chain head may reclaim, and the worker is told to stop.
   * @param {{ agent?: object, chainId?: string, sessionId: string }} input - reclaim input.
   * @returns {object} reclaim result.
   */
  reclaimDelegation({ agent, chainId, sessionId }) {
    const { chain, store } = this.resolveChain(agent, chainId)
    this.assertChainHeadWriter(chain, agent)
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RelayError(RELAY_CODES.invalid, 'sessionId is required')
    }
    const entry = chain.sessions.find(session => session.sessionId === sessionId)
    if (entry === undefined || !this.isWorker(entry)) {
      throw new RelayError(RELAY_CODES.invalid, `session ${sessionId} is not a delegated worker of this chain`)
    }
    const document = store.readFeatures(chain.chainId)
    if (document === undefined) return { chainId: chain.chainId, sessionId, features: [] }
    const owned = document.features.filter(feature => feature.assignedSessionId === sessionId && !feature.passes)
    if (owned.length > 0) {
      store.patchFeatures(chain.chainId, owned.map(feature => ({ id: feature.id, assignedSessionId: null })))
    }
    const stamp = new Date().toISOString()
    store.writeProgress(chain.chainId, `${store.readProgress(chain.chainId).replace(/\s*$/, '\n')}- [${stamp}] reclaimed ${owned.map(feature => feature.id).join(', ') || '(nothing pending)'} from worker ${sessionId}\n`)
    // Before the notice below, so the goal does not answer it with another round.
    this.syncWorkerGoal(chain, store, entry)
    const live = this.ctx.get('agents')?.get(sessionId)
    if (live !== undefined) {
      try {
        live.inject(relayMessage(renderReclaimNotice({ chainId: chain.chainId, features: owned.map(feature => feature.id) })))
      } catch (error) {
        this.warn(`could not notify the reclaimed worker ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.record(store, chain.chainId, {
      kind: 'delegation.reclaimed',
      actor: agent?.session?.id ?? 'host',
      detail: { sessionId, features: owned.map(feature => feature.id) },
    })
    return { chainId: chain.chainId, sessionId, features: owned.map(feature => feature.id) }
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
      commitTruth: this.config.commitTruth,
    })
    try {
      agent.followup(relayMessage(prompt))
    } catch (error) {
      this.warn(`could not queue the wrap-up prompt for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.holdGoal(chain, store, agent, 'wrapup')
    this.statsFor(agent.id).wrapupSentAt = Date.now()
    try {
      store.update(chain.chainId, record => { record.wrapupAt = new Date().toISOString() })
    } catch (error) {
      this.warn(`could not persist the wrap-up time for ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    // The model may never call ready; re-check at the persisted deadline.
    this.scheduleEvaluate(agent.id, this.config.wrapupTimeoutMinutes * 60_000)
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
   * @param {import('./chain-store.js').ChainStore} [storeOverride] - the store the chain was found in.
   * @param {{ stale?: boolean }} [options] - handoff options.
   * @returns {Promise<object>} handoff result.
   */
  async handoff(chain, oldAgent, reason, storeOverride, options = {}) {
    if (this.busyChains.has(chain.chainId)) {
      throw new RelayError(RELAY_CODES.limit, `chain ${chain.chainId} is already handing off`)
    }
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) {
      throw new RelayError(RELAY_CODES.invalid, 'this Host cannot create sessions; handoff is unavailable')
    }
    // Act on the store the chain was found in; relay.json may name a directory
    // the workspace has since moved or renamed.
    const store = storeOverride ?? this.storeFor(chain.truthDir)
    try {
      store.ensureGitignore(chain.chainId)
    } catch {
      /* the ignore file is advisory */
    }
    // Freeze an un-frozen list before handing over, then refuse a drifted one.
    this.freezeFeatures(chain, store, 'system')
    this.verifyFrozen(chain, store)
    const handoffNo = chain.handoffCount + 1
    if (handoffNo > chain.maxHandoffs) {
      // Running out of handoffs is a human decision, not a dead chain.
      this.recordBlocker(store, chain.chainId, {
        kind: 'external',
        who: 'human',
        action: `raise maxHandoffs above ${chain.maxHandoffs}, then resume the chain`,
      })
      // The blocker may be configured not to pause; the cap always must.
      store.update(chain.chainId, record => {
        record.status = 'paused'
        record.pausedBy = 'handoff-limit'
        record.lastError = `handoff limit of ${record.maxHandoffs} reached`
      })
      this.syncWorkerGoals(chain, store)
      throw new RelayError(RELAY_CODES.limit, `chain ${chain.chainId} reached its handoff limit`)
    }
    // Before the first await: a goal round must not start on the retiring session
    // while the successor is being created.
    const heldHere = this.holdGoal(chain, store, oldAgent, 'handoff')

    this.busyChains.add(chain.chainId)
    this.record(store, chain.chainId, {
      kind: 'handoff.started',
      actor: 'system',
      detail: { from: oldAgent.session.id, reason, handoffNo },
    })
    let createdSessionId
    try {
      // A failed handoff may already have created the successor. Reuse it when
      // it is still live instead of leaving an orphan and creating a second one.
      const pending = this.ctx.get('agents')
      if (chain.pendingHandoff !== null && chain.pendingHandoff !== undefined
        && typeof chain.pendingHandoff.sessionId === 'string') {
        const live = pending?.get(chain.pendingHandoff.sessionId)
        if (live !== undefined) createdSessionId = chain.pendingHandoff.sessionId
      }
      if (createdSessionId !== undefined) {
        const current = store.readChain(chain.chainId)
        const known = current?.sessions.some(session => session.sessionId === createdSessionId) === true
        if (known && current.currentSessionId === createdSessionId) {
          return { chainId: chain.chainId, newSessionId: createdSessionId, handoffNo: current.handoffCount, reason: 'recovered' }
        }
      } else {
        const preset = this.presetFor(oldAgent)
        const created = await controller.create({
          cwd: chain.cwd,
          ...(preset === undefined ? {} : { agentPreset: preset }),
        })
        createdSessionId = created.sessionId
      }
      const newAgent = this.ctx.get('agents')?.get(createdSessionId)
      const session = newAgent?.session
      // The preset first: it sets the sandbox mode, then the worker policy
      // may still tighten the approval side for an unattended session.
      const inheritedPreset = this.inheritPermission(chain, store, oldAgent, newAgent)
      this.inheritPlanMode(chain, store, oldAgent, newAgent)
      if (newAgent !== undefined) this.applyWorkerPolicy(newAgent)

      store.update(chain.chainId, record => {
        record.pendingHandoff = { sessionId: createdSessionId, createdAt: new Date().toISOString(), reason }
      })

      if (session !== undefined) this.decorateSession(chain, newAgent, handoffNo)

      const document = store.readFeatures(chain.chainId)
      const previousHandoff = store.readHandoff(chain.chainId)
      const prompt = renderHandoffPrompt({
        chain,
        features: document,
        handoff: previousHandoff,
        historyEntries: this.historyEntries(store, chain.chainId),
        handoffNo,
        previousSessionId: oldAgent.session.id,
        truthDir: join(store.truthDir, chain.chainId),
        stale: options.stale === true,
      })
      await controller.prompt({
        requestId: `relay-${chain.chainId}-${handoffNo}-${randomUUID().slice(0, 8)}`,
        sessionId: createdSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, AbortSignal.timeout(60_000))

      // Only after the handoff brief is queued: a failed prompt must retry
      // cleanly, and a pre-created goal would then be an orphan on that session.
      const continued = this.continueGoal(chain, store, oldAgent, newAgent)

      const retiredAt = new Date().toISOString()
      store.update(chain.chainId, record => {
        const previous = record.sessions.find(entry => entry.sessionId === oldAgent.session.id)
        if (previous !== undefined) {
          previous.retiredAt = retiredAt
          previous.retireReason = reason
          const stats = this.stats.get(oldAgent.session.id)
          if (stats !== undefined) previous.peakPressureRatio = Number(stats.peakRatio.toFixed(3))
          // Never shrink a durable count a reload has not hydrated yet.
          previous.compactions = Math.max(
            Number(previous.compactions ?? 0),
            this.stats.get(oldAgent.session.id)?.compactions ?? 0,
          )
        }
        const alreadyJoined = record.sessions.some(session => session.sessionId === createdSessionId)
        if (!alreadyJoined) {
          record.sessions.push({
            sessionId: createdSessionId,
            role: 'worker',
            index: handoffNo,
            joinedAt: retiredAt,
            compactions: 0,
            // A handoff continues the same delegation, so the next session keeps
            // the previous session's parent rather than becoming a child of it.
            parentSessionId: previous?.parentSessionId ?? null,
            ...(inheritedPreset === undefined ? {} : { permissionPreset: inheritedPreset }),
            ...(typeof continued.goalId === 'string' ? { goalId: continued.goalId } : {}),
            ...(continued.seeded === true ? { goalSeeded: true } : {}),
            // The brief this session received: rewriting it is what makes its own brief fresh.
            handoffHashAtJoin: handoffHash(previousHandoff),
          })
        }
        record.currentSessionId = createdSessionId
        record.handoffCount = handoffNo
        record.status = 'active'
        record.pausedBy = null
        record.pendingHandoff = null
        record.lastError = null
        record.wrapupAt = null
        record.readyAt = null
        record.readySessionId = null
        record.goalPausedByRelay = null
      })

      this.members.set(createdSessionId, { chainId: chain.chainId, truthDir: store.truthDir })
      this.misses.delete(createdSessionId)
      // A failed attempt paused the workers; the chain is active again.
      this.syncWorkerGoals(chain, store)
      // The goal was just created armed in this process; a later disarm is somebody's decision.
      this.statsFor(createdSessionId).rearmChecked = true
      this.clearTimer(oldAgent.session.id)
      const settled = store.readChain(chain.chainId)
      if (settled !== undefined) this.remember(settled, store)
      this.appendHistory(store, chain, {
        from: oldAgent.session.id,
        to: createdSessionId,
        handoffNo,
        reason,
        handoff: previousHandoff,
      })
      this.retire(oldAgent, chain, createdSessionId, handoffNo)
      const stalled = continued.exhausted === true
        ? 'the goal ran out of rounds'
        : continued.blocked === true ? 'the goal of the previous session was blocked' : null
      if (stalled !== null) {
        // Without it the chain reads as running while nothing drives the successor.
        try {
          this.recordBlocker(store, chain.chainId, {
            kind: 'external',
            who: 'human',
            action: `${stalled}; set a new goal on the current session or let it go on without one, then clear this blocker`,
          })
        } catch (error) {
          this.warn(`could not record the goal blocker for ${chain.chainId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
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
          record.pausedBy = 'handoff-failed'
          record.lastError = message
        })
      } catch (updateError) {
        this.warn(`could not record the failed handoff: ${updateError instanceof Error ? updateError.message : String(updateError)}`)
      }
      this.syncWorkerGoals(chain, store)
      this.record(store, chain.chainId, {
        kind: 'handoff.failed',
        actor: 'system',
        detail: { from: oldAgent.session.id, reason, error: message },
      })
      // This handoff took the continuation away and no wrap-up is waiting for a
      // retry, so it gives it back. Not once the chain moved on: a failure after
      // the successor took over must not restart the retired session.
      if (heldHere && !this.isWrapping(chain) && store.readChain(chain.chainId)?.currentSessionId === oldAgent.id) {
        const view = this.goalOf(oldAgent)
        const goals = this.ctx.get('goals')
        if (view !== undefined && view.phase === 'active' && view.activation === 'disarmed' && typeof goals?.resume === 'function') {
          try {
            goals.resume(oldAgent, { id: view.id, revision: view.revision })
            this.record(store, chain.chainId, {
              kind: 'goal.released',
              actor: 'system',
              detail: { sessionId: oldAgent.id, goalId: view.id, why: 'handoff-failed' },
            })
          } catch (releaseError) {
            this.warn(`could not release the goal of ${oldAgent.id}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`)
          }
        }
      }
      throw error instanceof RelayError ? error : new RelayError(RELAY_CODES.io, `handoff failed: ${message}`)
    } finally {
      this.busyChains.delete(chain.chainId)
    }
  }

  /** Name and place a freshly created session; failures are advisory. */
  decorateSession(chain, newAgent, handoffNo) {
    try {
      this.ctx.get('sessionTitle')?.rename(newAgent.session, sessionTitle('handoff', { title: chain.title, index: handoffNo }))
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
   * Read a session's goal without ever throwing.
   * @param {object|undefined} agent - live agent.
   * @returns {object|undefined} the goal view, or undefined when there is none or the service is unavailable.
   */
  goalOf(agent) {
    if (agent === undefined) return undefined
    try {
      return this.ctx.get('goals')?.get?.(agent) ?? undefined
    } catch (error) {
      this.warn(`could not read the goal of ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Whether the chain's head has been asked to wrap up or has reported ready.
   * @param {object} chain - chain record.
   * @returns {boolean} true while a wrap-up is under way.
   */
  isWrapping(chain) {
    return (chain.wrapupAt !== null && chain.wrapupAt !== undefined)
      || (chain.readyAt !== null && chain.readyAt !== undefined)
  }

  /**
   * The chain's current live session together with its goal.
   * @param {object} chain - chain record.
   * @returns {{ goals: object, agent: object, entry: object|undefined, view: object }|undefined} the goal of the
   *   current session; undefined when the session is not loaded or has no goal.
   */
  headGoal(chain) {
    if (typeof chain.currentSessionId !== 'string') return undefined
    const goals = this.ctx.get('goals')
    const agent = this.ctx.get('agents')?.get(chain.currentSessionId)
    if (goals === undefined || agent === undefined) return undefined
    const view = this.goalOf(agent)
    if (view === undefined) return undefined
    return { goals, agent, entry: chain.sessions.find(session => session.sessionId === agent.id), view }
  }

  /**
   * Stop the goal driver from sending further rounds to a session that is wrapping up or retiring.
   * Without this the host driver sends another goal round as soon as the wrapped-up session is
   * idle, so the session keeps working past its own handoff brief, and a retiring session can run
   * one more round while its successor has already started. Only the automatic continuation is
   * removed: the goal keeps its phase and revision.
   * @param {object} chain - chain record, for the audit.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object} agent - the session being held.
   * @param {'wrapup'|'handoff'} why - which step holds it.
   * @returns {boolean} true when this call disarmed the goal.
   */
  holdGoal(chain, store, agent, why) {
    const view = this.goalOf(agent)
    if (view === undefined || view.phase !== 'active' || view.activation !== 'armed') return false
    const goals = this.ctx.get('goals')
    if (typeof goals?.disarm !== 'function') return false
    try {
      goals.disarm(agent)
    } catch (error) {
      this.warn(`could not hold the goal of ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    this.record(store, chain.chainId, {
      kind: 'goal.held',
      actor: 'system',
      detail: { sessionId: agent.id, goalId: view.id, why },
    })
    return true
  }

  /**
   * Decide the successor's goal: inherit the user's goal, else seed one.
   * A goal the plugin seeded is not inherited: each handoff seeds a fresh one. The user's goal is
   * inherited with its remaining rounds, so the round cap is a budget for the whole chain. When
   * those rounds are spent it is not replaced by a seeded goal (that would hand out a budget the
   * owner already used); the caller records a blocker instead. A user's goal that is blocked, or
   * paused by the user, is not replaced either; a goal the panel paused together with the chain
   * counts as active. A blocked goal is reported as `blocked` so the caller can leave a blocker.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object} oldAgent - the retiring session.
   * @param {object|undefined} newAgent - the created successor session.
   * @returns {{ goalId?: string, seeded?: boolean, exhausted?: boolean, blocked?: boolean }} the goal the successor now
   *   has, when any; `exhausted` when the user's goal had no rounds left.
   */
  continueGoal(chain, store, oldAgent, newAgent) {
    if (newAgent === undefined) return {}
    const previous = this.goalOf(oldAgent)
    const oldEntry = chain.sessions.find(session => session.sessionId === oldAgent.id)
    const recorded = previous !== undefined && oldEntry?.goalId === previous.id
    const seededPrevious = recorded && (oldEntry.goalSeeded === true
      || (oldEntry.goalSeeded === undefined && this.auditSeeded(store, chain.chainId, previous.id)))
    if (!this.config.inheritGoal || previous === undefined || seededPrevious || previous.phase === 'complete') {
      const id = this.config.seedGoalOnHandoff ? this.seedGoal(chain, store, newAgent) : undefined
      return id === undefined ? {} : { goalId: id, seeded: true }
    }
    // From here the goal is the user's (or one inherited from the user's).
    const marker = chain.goalPausedByRelay
    const pausedByRelay = previous.phase === 'paused' && marker?.sessionId === oldAgent.id && marker?.goalId === previous.id
    if (previous.phase === 'blocked') return { blocked: true }
    if (previous.phase !== 'active' && !pausedByRelay) return {}
    const remaining = previous.maxGoalRounds - previous.roundsStarted
    if (remaining < 1) {
      this.record(store, chain.chainId, {
        kind: 'goal.inherit-skipped',
        actor: 'system',
        detail: { from: previous.id, reason: 'no rounds left' },
      })
      return { exhausted: true }
    }
    const goals = this.ctx.get('goals')
    try {
      const view = goals.create(newAgent, { objective: previous.objective, maxGoalRounds: remaining })
      this.record(store, chain.chainId, {
        kind: 'goal.inherited',
        actor: 'system',
        detail: { goalId: view?.id ?? null, from: previous.id, rounds: remaining },
      })
      return typeof view?.id === 'string' ? { goalId: view.id } : {}
    } catch (error) {
      this.warn(`could not carry the goal to ${newAgent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
  }

  /**
   * Whether the audit says the plugin seeded this goal.
   * Entries written before the `goalSeeded` flag existed carry only the goal id.
   * @param {import('./chain-store.js').ChainStore} store - the chain's store.
   * @param {string} chainId - chain identity.
   * @param {string} goalId - the goal to look for.
   * @returns {boolean} true when a `goal.seeded` record names it.
   */
  auditSeeded(store, chainId, goalId) {
    try {
      return store.readAudit(chainId, 500).some(record => record.kind === 'goal.seeded' && record.detail?.goalId === goalId)
    } catch {
      return false
    }
  }

  /**
   * Re-arm a goal this plugin created after a Host restart or plugin reload.
   * The host disarms goals at a session-start boundary. A goal the user created is left
   * alone for that reason; only the goal recorded as this plugin's (`entry.goalId`) is resumed,
   * and never while a wrap-up or handoff is under way. It is one attempt per session load
   * (see `sessionLoaded`): a goal disarmed later (a user abort, an agent error) is somebody's decision.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object} agent - the chain's current live session.
   * @param {object} entry - that session's chain entry.
   * @returns {void}
   */
  rearmGoal(chain, store, agent, entry) {
    if (!this.config.rearmGoalOnReload || typeof entry?.goalId !== 'string') return
    // A handoff holds the goal before its first await; a timer-driven evaluation
    // that lands inside that handoff must not hand the rounds back. It checked
    // nothing, so it must not spend the attempt either.
    if (this.busyChains.has(chain.chainId)) return
    const stats = this.statsFor(agent.id)
    if (stats.rearmChecked) return
    stats.rearmChecked = true
    if (chain.pendingHandoff !== null && chain.pendingHandoff !== undefined) return
    if (this.isWrapping(chain)) return
    const view = this.goalOf(agent)
    if (view === undefined || view.id !== entry.goalId || view.phase !== 'active' || view.activation !== 'disarmed') return
    if (view.roundsStarted >= view.maxGoalRounds) return
    const goals = this.ctx.get('goals')
    if (typeof goals?.resume !== 'function') return
    try {
      goals.resume(agent, { id: view.id, revision: view.revision })
    } catch (error) {
      this.warn(`could not re-arm the goal of ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.record(store, chain.chainId, { kind: 'goal.rearmed', actor: 'system', detail: { sessionId: agent.id, goalId: view.id } })
  }

  /**
   * Whether a session is in plan mode; a selected state that is not logged yet counts.
   * @param {object|undefined} agent - live agent.
   * @returns {boolean} true when plan mode is on or about to be.
   */
  planActive(agent) {
    if (agent === undefined) return false
    const planMode = this.ctx.get('planMode')
    if (typeof planMode?.get !== 'function') return false
    try {
      const state = planMode.get(agent)
      return (state?.pending ?? state?.active) === true
    } catch (error) {
      this.warn(`could not read the plan mode of ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Start a created session in plan mode when the session it continues is in plan mode.
   * Without it the new session silently leaves plan mode and starts editing.
   * @param {object} chain - chain record, for the audit.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object|undefined} source - the live session being continued.
   * @param {object|undefined} created - the created live session.
   * @returns {void}
   */
  inheritPlanMode(chain, store, source, created) {
    if (!this.config.inheritPlanMode || source === undefined || created === undefined) return
    if (!this.planActive(source)) return
    const planMode = this.ctx.get('planMode')
    if (typeof planMode?.set !== 'function') return
    try {
      planMode.set(created, true)
    } catch (error) {
      this.warn(`could not carry plan mode to ${created.id}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.record(store, chain.chainId, { kind: 'plan.inherited', actor: 'system', detail: { sessionId: created.id, from: source.id } })
  }

  /**
   * Give the handoff successor a goal so the goal-round driver keeps it moving.
   * The goal is per-session, so the objective carries the progress the successor
   * would otherwise have to rediscover.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object|undefined} agent - the created successor session.
   * @returns {string|undefined} id of the created goal, when any.
   */
  seedGoal(chain, store, agent) {
    if (!this.config.seedGoalOnHandoff || agent === undefined) return undefined
    return this.createChainGoal(chain, store, agent)
  }

  /**
   * Create a goal for a session from the chain's objective and progress, whatever the config says.
   * `seedGoal` (handoff) and `launchCluster` (planning session) each decide on their own setting first.
   * @param {object} chain - chain record.
   * @param {import('./chain-store.js').ChainStore} store - its store.
   * @param {object} agent - the live session that gets the goal.
   * @returns {string|undefined} id of the created goal, when any.
   */
  createChainGoal(chain, store, agent) {
    const goals = this.ctx.get('goals')
    if (goals === undefined || typeof goals.create !== 'function') {
      this.warn(`the goals service is unavailable; ${agent.id} has no goal`)
      return undefined
    }
    const document = store.readFeatures(chain.chainId)
    const progress = document === undefined ? { total: 0, done: 0 } : featureProgress(document)
    const objective = `${chain.objective} — relay chain ${chain.chainId}, ${progress.done}/${progress.total} features pass. Truth source: ${join(store.truthDir, chain.chainId)}.`
    let view
    try {
      view = goals.create(agent, { objective, maxGoalRounds: this.config.goalRoundsPerHandoff })
    } catch (error) {
      this.warn(`could not seed a goal on ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    this.record(store, chain.chainId, {
      kind: 'goal.seeded',
      actor: 'system',
      detail: { goalId: view?.id ?? null, rounds: view?.maxGoalRounds ?? this.config.goalRoundsPerHandoff },
    })
    return view?.id ?? undefined
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
      const view = this.goalOf(oldAgent)
      // The handoff disarmed this goal before it started, so the phase decides:
      // a retired session must not keep a goal that a later resume would run.
      if (view !== undefined && view.phase === 'active') {
        goals.pause(oldAgent, { id: view.id, revision: view.revision })
      }
    } catch (error) {
      this.warn(`could not pause the retired session's goal: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Stop every pending action on unload. */
  dispose() {
    this.unloaded = true
    for (const timer of this.timers.values()) clearTimeout(timer.handle)
    this.timers.clear()
    this.misses.clear()
    this.statusCache = null
    this.busyAgents.clear()
    this.busyChains.clear()
    this.stats.clear()
    this.members.clear()
    this.stores.clear()
  }
}
