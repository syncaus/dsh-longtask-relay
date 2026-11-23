/**
 * Standalone checks for the relay pieces that do not need the Harness runtime.
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChainIndex, ChainStore, RELAY_CODES, RelayError, skeletonTruth } from '../lib/chain-store.js'
import { resolveConfig } from '../lib/config.js'
import { RelayEngine, clusterConflicts } from '../lib/engine.js'
import { ChainFingerprints } from '../lib/fingerprints.js'
import { apply as applyPlugin } from '../index.js'
import { handleRelayCommand } from '../lib/command.js'
import { sessionTitle } from '../lib/labels.js'
import {
  renderClusterLaunchedNotice, renderClusterPlanningPrompt, renderDelegationPrompt, renderHandoffPrompt,
  renderInitializerPrompt, renderWrapupPrompt, stateBlockLines, truthPaths,
} from '../lib/prompts.js'
import { RelayRemote } from '../lib/remote.js'
import { registerTools } from '../lib/tools.js'
import { applyPluginUpdate, checkPluginUpdate } from '../lib/update.js'

const failures = []
let checks = 0

/** Run one named check. */
function check(name, fn) {
  checks += 1
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Run one async named check. */
async function checkAsync(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const workspace = mkdtempSync(join(tmpdir(), 'relay-smoke-'))
const store = ChainStore.forCwd(workspace)

check('create writes the chain and registers the index', () => {
  const chain = store.create({ objective: 'ship the thing', cwd: workspace, maxHandoffs: 4 })
  assert.equal(store.listChainIds().length, 1)
  assert.equal(store.readChain(chain.chainId).objective, 'ship the thing')
  assert.ok(readFileSync(store.paths(chain.chainId).chain, 'utf8').includes('ship the thing'))
})

check('patchFeatures refuses to add an entry', () => {
  const [chainId] = store.listChainIds()
  store.writeFeatures(chainId, {
    version: 1,
    objective: 'o',
    features: [{ id: 'F001', title: 'first', passes: false }],
  })
  assert.throws(
    () => store.patchFeatures(chainId, [{ id: 'F999', passes: true }]),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
  )
})

check('patchFeatures only changes the mutable fields', () => {
  const [chainId] = store.listChainIds()
  const progress = store.patchFeatures(chainId, [{ id: 'F001', passes: true, evidence: 'test passed' }])
  assert.equal(progress.done, 1)
  const features = store.readFeatures(chainId)
  assert.equal(features.features[0].title, 'first')
  assert.equal(features.features[0].passes, true)
  assert.equal(features.features[0].evidence, 'test passed')
})

check('truth keys are absolute paths under the chain directory', () => {
  const [chainId] = store.listChainIds()
  const prompt = renderHandoffPrompt({
    chain: store.readChain(chainId),
    features: store.readFeatures(chainId),
    handoff: '# HANDOFF\n\nfinished F001',
    handoffNo: 1,
    previousSessionId: 'session-old',
    truthDir: store.paths(chainId).dir,
  })
  assert.match(prompt, /<relay_handoff>/)
  assert.ok(prompt.includes(store.paths(chainId).features))
  assert.ok(prompt.includes('Previous session: session-old'))
  assert.ok(prompt.length < 2600, `handoff prompt is ${prompt.length} chars`)
})

check('wrapup prompt names the progress and forbids new features', () => {
  const [chainId] = store.listChainIds()
  const prompt = renderWrapupPrompt({ truthDir: store.paths(chainId).dir, featuresTotal: 3, featuresDone: 1 })
  assert.ok(prompt.includes('1/3'))
  assert.ok(prompt.includes('Do not begin another feature'))
})

check('config rejects unknown keys and out-of-range ratios', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /not a recognised setting/)
  assert.throws(() => resolveConfig({ handoffRatio: 1.2 }), /between 0 and 1/)
  assert.throws(() => resolveConfig({ wrapupRatio: 0.8, handoffRatio: 0.7 }), /lower than handoffRatio/)
  assert.equal(resolveConfig({ handoffRatio: 0.6 }).handoffRatio, 0.6)
  assert.equal(resolveConfig({}).wrapupRatio, 0.5)
  assert.equal(resolveConfig({}).pauseOnExternalBlocker, true)
})

check('the chain index remembers a chain across lifetimes', () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-index-'))
  const index = new ChainIndex(home)
  const [chainId] = store.listChainIds()
  const chain = store.readChain(chainId)
  index.remember(chain)
  assert.equal(index.locate(chainId), store.truthDir)
  assert.equal(index.entries().length, 1)
  index.remember(chain)
  assert.equal(index.entries().length, 1, 'remember duplicated the entry')
})

/** Build a fake agent and the services the engine reads. */
function fakeWorld({ goalService = true, ...overrides } = {}) {
  const config = resolveConfig({
    cooldownMs: 0,
    wrapupRatio: 0.5,
    handoffRatio: 0.6,
    compactedRatioFloor: 0.4,
    ...overrides,
  })
  const workspaceDir = mkdtempSync(join(tmpdir(), 'relay-engine-'))
  const indexHome = mkdtempSync(join(tmpdir(), 'relay-home-'))
  const local = ChainStore.forCwd(workspaceDir)
  const chain = local.create({ objective: 'engine objective', cwd: workspaceDir, maxHandoffs: 4 })
  local.writeFeatures(chain.chainId, {
    version: 1,
    objective: 'engine objective',
    features: [{ id: 'F001', title: 'a', passes: false, verify: 'npm test' }],
  })

  const calls = []
  const newSessionId = 'session-new'
  const oldAgent = {
    id: 'session-old',
    session: { id: 'session-old', header: { cwd: workspaceDir }, events: [] },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) { calls.push({ kind: 'followup', text: message.content[0].text }) },
    inject(message) { calls.push({ kind: 'inject', text: message.content[0].text }) },
  }
  const newAgent = {
    id: newSessionId,
    session: { id: newSessionId, header: { cwd: workspaceDir }, events: [] },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    inject() {},
  }
  let ratio = 0.2
  let goal
  const services = {
    tokenMeter: {
      contextPressure: () => ({ pressureTokens: Math.round(ratio * 1000), contextWindow: 1000 }),
      measure: () => ({ totalTokens: Math.round(ratio * 1000) }),
    },
    agents: { get: id => (id === newSessionId ? newAgent : id === 'session-old' ? oldAgent : undefined) },
    sessions: { flush: async () => true },
    sessionController: {
      async create(request) {
        calls.push({ kind: 'create', cwd: request.cwd })
        return { sessionId: newSessionId }
      },
      async prompt(request) {
        calls.push({ kind: 'prompt', sessionId: request.sessionId, text: request.content[0].text })
        return { accepted: true }
      },
    },
  }
  if (goalService) {
    services.goals = {
      create(agent, request) {
        calls.push({ kind: 'goal-create', agentId: agent.id, objective: request.objective, maxGoalRounds: request.maxGoalRounds })
        goal = {
          id: 'goal-seeded',
          revision: 1,
          phase: 'active',
          activation: 'armed',
          objective: request.objective,
          maxGoalRounds: request.maxGoalRounds,
          roundsStarted: 0,
        }
        return goal
      },
      get() {
        return goal
      },
    }
  }
  const ctx = {
    logger: { warn: () => {} },
    get: name => services[name],
  }
  const engine = new RelayEngine(ctx, config, {
    chainIndex: new ChainIndex(indexHome),
    fingerprints: new ChainFingerprints(indexHome),
  })
  // Adopt the existing chain so the fake agent is its current session.
  local.update(chain.chainId, record => {
    record.sessions.push({ sessionId: 'session-old', role: 'initializer', index: 0, joinedAt: new Date().toISOString() })
    record.currentSessionId = 'session-old'
    record.status = 'active'
  })
  // Write the brief after the session joined: an older file is a stale handoff.
  local.writeHandoff(chain.chainId, '# HANDOFF\n\n<!-- relay:state -->\n- step: start F001\n<!-- /relay:state -->\n')
  engine.members.set('session-old', { chainId: chain.chainId, truthDir: local.truthDir })
  engine.remember(local.readChain(chain.chainId), local)
  // A second engine over the same files, as after a plugin reload.
  const rebuild = () => {
    const next = new RelayEngine(ctx, config, {
      chainIndex: new ChainIndex(indexHome),
      fingerprints: new ChainFingerprints(indexHome),
    })
    next.members.set('session-old', { chainId: chain.chainId, truthDir: local.truthDir })
    return next
  }
  return { engine, calls, oldAgent, newAgent, local, chain, rebuild, setRatio: value => { ratio = value }, setGoal: value => { goal = value } }
}

await checkAsync('crossing the wrapup ratio starts the wrap-up without handing off', async () => {
  const world = fakeWorld({ wrapupRatio: 0.5, handoffRatio: 0.7 })
  world.setRatio(0.55)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.filter(call => /<relay_wrapup>/.test(call.text ?? '')).length, 1)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0, 'the wrap-up must come first')
})

await checkAsync('below the wrapup ratio nothing happens', async () => {
  const world = fakeWorld({ wrapupRatio: 0.5, handoffRatio: 0.7 })
  world.setRatio(0.45)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.length, 0)
})

await checkAsync('a compaction count survives a reload', async () => {
  const world = fakeWorld()
  world.engine.noteCompaction('session-old')
  const recorded = () => world.local.readChain(world.chain.chainId).sessions
    .find(session => session.sessionId === 'session-old').compactions
  assert.equal(recorded(), 1)
  const restarted = world.rebuild()
  world.setRatio(0.3)
  await restarted.evaluate(world.oldAgent)
  assert.equal(restarted.statsFor('session-old').compactions, 1, 'the count was not read back from the chain')
  restarted.noteCompaction('session-old')
  assert.equal(recorded(), 2)
})

await checkAsync('a wrapped-up session does not wrap up again after a reload', async () => {
  const world = fakeWorld()
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.filter(call => /<relay_wrapup>/.test(call.text ?? '')).length, 1)
  const restarted = world.rebuild()
  await restarted.evaluate(world.oldAgent)
  assert.equal(world.calls.filter(call => /<relay_wrapup>/.test(call.text ?? '')).length, 1, 'the wrap-up repeated after a reload')
  assert.ok(world.calls.some(call => call.kind === 'create'), 'the reloaded engine should hand off instead')
})

await checkAsync('a ready checkpoint survives a reload', async () => {
  const world = fakeWorld()
  world.setRatio(0.6)
  await world.engine.evaluate(world.oldAgent)
  world.engine.checkpoint({ agent: world.oldAgent, ready: true })
  const restarted = world.rebuild()
  world.setRatio(0.3)
  await restarted.evaluate(world.oldAgent)
  assert.ok(world.calls.some(call => call.kind === 'create'), 'the ready checkpoint was lost across the reload')
})

await checkAsync('an active chain cannot be deleted', async () => {
  const world = fakeWorld()
  assert.throws(
    () => world.engine.deleteChain(world.chain.chainId),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
  )
  assert.equal(existsSync(world.local.paths(world.chain.chainId).dir), true)
})

await checkAsync('deleting a paused chain removes its files and both indexes', async () => {
  const world = fakeWorld()
  world.engine.setPaused({ chainId: world.chain.chainId, paused: true })
  const result = world.engine.deleteChain(world.chain.chainId)
  assert.equal(result.chainId, world.chain.chainId)
  assert.equal(result.status, 'paused')
  assert.equal(existsSync(world.local.paths(world.chain.chainId).dir), false)
  assert.deepEqual(world.local.listChainIds(), [])
  assert.deepEqual(world.engine.chainIndex.entries(), [])
  assert.equal(world.engine.members.has('session-old'), false)
})

await checkAsync('deleting an unknown chain is refused', async () => {
  const world = fakeWorld()
  // A malformed id never reaches the filesystem.
  assert.throws(
    () => world.engine.deleteChain('chain-missing'),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
  )
  // A well-formed id that does not exist is a not-found.
  assert.throws(
    () => world.engine.deleteChain('chain-00000000-0000-4000-8000-000000000000'),
    error => error instanceof RelayError && error.code === RELAY_CODES.notFound,
  )
})

await checkAsync('a handoff appends the previous brief to history', async () => {
  const world = fakeWorld()
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  world.engine.statsFor('session-old').ready = true
  await world.engine.evaluate(world.oldAgent)
  const history = world.local.readHistory(world.chain.chainId)
  assert.match(history, /## Handoff #1/)
  assert.ok(history.includes('start F001'), 'the previous brief was not copied into the history')
  assert.ok(history.includes('session-old'), 'the history does not name the retiring session')
})

check('doc returns a truth document and the tail of a long ledger', () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  assert.deepEqual(world.engine.doc(chainId, 'traps'), { name: 'traps', text: '', truncated: false })
  world.local.appendLedger(chainId, 'traps', '- EOL CRLF broke the PowerShell script')
  assert.match(world.engine.doc(chainId, 'traps').text, /EOL CRLF/)
  world.local.appendLedger(chainId, 'decisions', `${'x'.repeat(20000)} newest-line`)
  const long = world.engine.doc(chainId, 'decisions')
  assert.equal(long.truncated, true)
  assert.ok(long.text.trimEnd().endsWith('newest-line'), 'a truncated ledger must keep its newest part')
  assert.throws(() => world.engine.doc(chainId, 'relay'), error => error instanceof RelayError && error.code === RELAY_CODES.invalid)
})

await checkAsync('a chain summary reports the wrap-up phase', async () => {
  const world = fakeWorld()
  const before = world.engine.status().find(chain => chain.chainId === world.chain.chainId)
  assert.equal(before.wrapupAt, null)
  assert.equal(before.handoffPending, false)
  world.setRatio(0.55)
  await world.engine.evaluate(world.oldAgent)
  const after = world.engine.status().find(chain => chain.chainId === world.chain.chainId)
  assert.equal(typeof after.wrapupAt, 'string', 'the summary must say the session is wrapping up')
})

check('recall searches the chain ledgers', () => {
  const world = fakeWorld()
  world.local.appendLedger(world.chain.chainId, 'decisions', '- chose the clone site because the live one is the only baseline')
  world.local.appendLedger(world.chain.chainId, 'traps', '- EOL CRLF broke the PowerShell script')
  const result = world.engine.recall({ chainId: world.chain.chainId, query: 'crlf script' })
  assert.equal(result.total, 1)
  assert.equal(result.matches[0].file, 'traps.md')
  assert.match(result.matches[0].text, /EOL CRLF/)
  assert.equal(world.engine.recall({ chainId: world.chain.chainId, query: 'nonexistent' }).total, 0)
  assert.equal(world.engine.recall({ chainId: world.chain.chainId, query: 'clone baseline' }).total, 1)
})

await checkAsync('ready is refused without a structured handoff brief', async () => {
  const world = fakeWorld()
  world.local.writeHandoff(world.chain.chainId, 'no structured block here')
  const result = world.engine.checkpoint({ agent: world.oldAgent, ready: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'handoff_missing')
  const withBlock = fakeWorld()
  const accepted = withBlock.engine.checkpoint({ agent: withBlock.oldAgent, ready: true })
  assert.notEqual(accepted.ok, false, 'a structured brief must be accepted')
})

await checkAsync('below every threshold the engine does nothing', async () => {
  const world = fakeWorld()
  world.setRatio(0.3)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.length, 0)
})

await checkAsync('crossing the handoff ratio wraps the session up exactly once', async () => {
  const world = fakeWorld()
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.filter(call => call.kind === 'followup').length, 1)
  assert.match(world.calls[0].text, /<relay_wrapup>/)
  assert.equal(world.local.readChain(world.chain.chainId).sessions.length, 1, 'handoff ran before the wrap-up turn')
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.filter(call => /<relay_wrapup>/.test(call.text ?? '')).length, 1, 'wrap-up repeated')
})

await checkAsync('a ready session hands off and creates the next session', async () => {
  const world = fakeWorld()
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  world.engine.statsFor('session-old').ready = true
  await world.engine.evaluate(world.oldAgent)
  const created = world.calls.find(call => call.kind === 'create')
  assert.equal(created.cwd, world.local.readChain(world.chain.chainId).cwd)
  const prompt = world.calls.find(call => call.kind === 'prompt')
  assert.match(prompt.text, /<relay_handoff>/)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.currentSessionId, 'session-new')
  assert.equal(chain.handoffCount, 1)
  assert.equal(chain.sessions.find(s => s.sessionId === 'session-old').retireReason, 'checkpoint')
  assert.ok(world.calls.some(call => call.kind === 'inject' && /<relay_retired>/.test(call.text)))
})

/** Mount a stand-in for the Host's permission preset service on a fake world. */
function withPresets(world, initial) {
  const current = new Map(Object.entries(initial))
  const switches = []
  const original = world.engine.ctx.get
  world.engine.ctx.get = name => (name === 'permissionPresets'
    ? {
      current: session => current.get(session.id) ?? 'workspace-write',
      set: (session, preset) => { current.set(session.id, preset); switches.push({ sessionId: session.id, preset }) },
      resolve: name => ({
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
        'read-only': { sandbox: 'read-only', approval: 'ask' },
      })[name],
    }
    : original(name))
  return { current, switches }
}

/** Drive the fake world through one automatic handoff. */
async function handOffOnce(world) {
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  world.engine.statsFor('session-old').ready = true
  await world.engine.evaluate(world.oldAgent)
}

await checkAsync('a handoff carries the permission preset to the successor', async () => {
  const world = fakeWorld()
  const presets = withPresets(world, { 'session-old': 'danger-full-access' })
  await handOffOnce(world)
  assert.deepEqual(presets.switches, [{ sessionId: 'session-new', preset: 'danger-full-access' }])
  const record = world.engine.audit(world.chain.chainId, 50).find(entry => entry.kind === 'session.permission')
  assert.deepEqual(record.detail, { sessionId: 'session-new', from: 'session-old', preset: 'danger-full-access' })
})

await checkAsync('a brief is fresh only once the session rewrote what it was handed', async () => {
  const world = fakeWorld()
  await handOffOnce(world)
  const chainId = world.chain.chainId
  const freshness = () => world.engine.detail(chainId).handoffFreshness
  const handed = world.local.readHandoff(chainId)
  assert.equal(typeof world.local.readChain(chainId).sessions.find(session => session.sessionId === 'session-new').handoffHashAtJoin, 'string')
  assert.deepEqual(freshness(), { fresh: false, reason: 'stale' }, 'the successor has not written anything yet')
  // Touching the file is what a checkout or a copied workspace does: no new content.
  world.local.writeHandoff(chainId, handed)
  assert.deepEqual(freshness(), { fresh: false, reason: 'stale' }, 'a newer file time passed for a rewritten brief')
  world.local.writeHandoff(chainId, handed.split('\n').join('\r\n'))
  assert.deepEqual(freshness(), { fresh: false, reason: 'stale' }, 'rewritten line endings passed for a rewritten brief')
  world.local.writeHandoff(chainId, '# HANDOFF\n\n<!-- relay:state -->\n- step: F001 done, start F002\n<!-- /relay:state -->\n')
  assert.deepEqual(freshness(), { fresh: true })
})

await checkAsync('ready is refused while the brief is still the one the session was handed', async () => {
  const world = fakeWorld()
  await handOffOnce(world)
  const chainId = world.chain.chainId
  const refused = world.engine.checkpoint({ agent: world.newAgent, ready: true })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'handoff_stale')
  assert.equal(world.local.readChain(chainId).readySessionId ?? null, null, 'a refused ready must not be recorded')
  world.local.writeHandoff(chainId, '# HANDOFF\n\n<!-- relay:state -->\n- step: F001 done, start F002\n<!-- /relay:state -->\n')
  const accepted = world.engine.checkpoint({ agent: world.newAgent, ready: true })
  assert.notEqual(accepted.ok, false)
  assert.equal(world.local.readChain(chainId).readySessionId, 'session-new')
  world.engine.clearChainTimers(world.local.readChain(chainId))
})

check('a session without a recorded brief keeps the time rule, with clock slack', () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  const chain = world.local.readChain(chainId)
  const written = statSync(world.local.paths(chainId).handoff).mtimeMs
  const entryAt = offset => ({ sessionId: 'session-old', joinedAt: new Date(written + offset).toISOString() })
  assert.deepEqual(world.engine.handoffFreshness(chain, world.local, entryAt(200)), { fresh: true }, 'a few milliseconds of clock skew read as stale')
  assert.deepEqual(world.engine.handoffFreshness(chain, world.local, entryAt(60_000)), { fresh: false, reason: 'stale' })
})

await checkAsync('the preset survives a second hop after the worker policy made it custom', async () => {
  const world = fakeWorld()
  const presets = withPresets(world, { 'session-old': 'read-only' })
  await handOffOnce(world)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.sessions.find(session => session.sessionId === 'session-new').permissionPreset, 'read-only')
  // What `workerApproval` does to the successor: its bundle no longer matches a preset.
  presets.current.set('session-new', 'custom')
  const third = { id: 'session-third', session: { id: 'session-third' } }
  const carried = world.engine.inheritPermission(chain, world.local, world.newAgent, third)
  assert.equal(carried, 'read-only', 'the second hop fell back to the Host default preset')
  assert.deepEqual(presets.switches.at(-1), { sessionId: 'session-third', preset: 'read-only' })
})

await checkAsync('a successor already on the same preset is not switched', async () => {
  const world = fakeWorld()
  const presets = withPresets(world, { 'session-old': 'workspace-write' })
  await handOffOnce(world)
  assert.deepEqual(presets.switches, [])
  assert.equal(world.local.readChain(world.chain.chainId).currentSessionId, 'session-new')
})

await checkAsync('inheritPermission=false and a custom combination leave the successor alone', async () => {
  const off = fakeWorld({ inheritPermission: false })
  const offPresets = withPresets(off, { 'session-old': 'danger-full-access' })
  await handOffOnce(off)
  assert.deepEqual(offPresets.switches, [])
  const custom = fakeWorld()
  const customPresets = withPresets(custom, { 'session-old': 'custom' })
  await handOffOnce(custom)
  assert.deepEqual(customPresets.switches, [])
  assert.equal(custom.local.readChain(custom.chain.chainId).currentSessionId, 'session-new', 'the handoff itself must still complete')
})

await checkAsync('a handoff seeds a goal on the successor when configured', async () => {
  const world = fakeWorld({ seedGoalOnHandoff: true, goalRoundsPerHandoff: 9 })
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  world.engine.statsFor('session-old').ready = true
  await world.engine.evaluate(world.oldAgent)
  const seeded = world.calls.find(call => call.kind === 'goal-create')
  assert.ok(seeded !== undefined, 'no goal was created on the successor')
  assert.equal(seeded.agentId, 'session-new')
  assert.equal(seeded.maxGoalRounds, 9)
  assert.match(seeded.objective, /engine objective/)
  assert.match(seeded.objective, /0\/1 features pass/)
  assert.ok(world.local.readAudit(world.chain.chainId, 50).some(record => record.kind === 'goal.seeded'))
})

await checkAsync('the successor gets no goal by default', async () => {
  const world = fakeWorld()
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  world.engine.statsFor('session-old').ready = true
  await world.engine.evaluate(world.oldAgent)
  assert.ok(!world.calls.some(call => call.kind === 'goal-create'))
})

await checkAsync('a blocked goal pauses the chain and is recorded once', async () => {
  const world = fakeWorld({ seedGoalOnHandoff: true })
  world.setGoal({
    id: 'goal-1',
    revision: 1,
    phase: 'blocked',
    activation: 'disarmed',
    objective: 'engine objective',
    maxGoalRounds: 16,
    roundsStarted: 16,
    blockedReason: { code: 'round-limit', message: 'round cap reached' },
  })
  await world.engine.evaluate(world.oldAgent)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.status, 'paused')
  assert.equal(chain.blocker.kind, 'external')
  assert.match(chain.blocker.action, /round cap reached/)
  const progress = world.local.readProgress(world.chain.chainId)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.local.readProgress(world.chain.chainId), progress, 'the blocker was recorded twice')
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0, 'a blocked goal must not hand off')
})

await checkAsync('resuming the goal releases the chain blocker', async () => {
  const world = fakeWorld()
  const blocked = {
    id: 'goal-1',
    revision: 1,
    phase: 'blocked',
    activation: 'disarmed',
    objective: 'engine objective',
    maxGoalRounds: 16,
    roundsStarted: 16,
    blockedReason: { code: 'round-limit', message: 'round cap reached' },
  }
  world.setGoal(blocked)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.local.readChain(world.chain.chainId).status, 'paused')
  world.setGoal({ ...blocked, phase: 'active', activation: 'armed', blockedReason: undefined })
  await world.engine.evaluate(world.oldAgent)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.blocker, null)
  assert.equal(chain.status, 'active')
})

await checkAsync('pauseOnExternalBlocker=false keeps handing off past a blocked goal', async () => {
  const world = fakeWorld({ pauseOnExternalBlocker: false })
  world.setGoal({
    id: 'goal-1',
    revision: 1,
    phase: 'blocked',
    activation: 'disarmed',
    objective: 'engine objective',
    maxGoalRounds: 16,
    roundsStarted: 16,
    blockedReason: { code: 'round-limit', message: 'round cap reached' },
  })
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.local.readChain(world.chain.chainId).blocker.kind, 'external')
  assert.equal(world.calls.filter(call => /<relay_wrapup>/.test(call.text ?? '')).length, 1)
  // The same blocked goal must not stop the succeeding handoff either.
  world.engine.statsFor('session-old').ready = true
  await world.engine.evaluate(world.oldAgent)
  assert.ok(world.calls.some(call => call.kind === 'create'), 'the chain must keep handing off')
})

check('a host without a goals service is left alone', () => {
  const world = fakeWorld({ goalService: false })
  assert.equal(
    world.engine.syncGoalBlocker(world.local.readChain(world.chain.chainId), world.local, world.oldAgent),
    false,
  )
})

await checkAsync('two compactions force a handoff without a wrap-up', async () => {
  const world = fakeWorld({ hardCompactions: 2 })
  world.engine.noteCompaction('session-old')
  world.engine.noteCompaction('session-old')
  await world.engine.evaluate(world.oldAgent)
  assert.ok(world.calls.some(call => call.kind === 'create'))
  assert.ok(!world.calls.some(call => /<relay_wrapup>/.test(call.text ?? '')))
})

await checkAsync('finish refuses while features are pending', async () => {
  const world = fakeWorld()
  const result = world.engine.finish({ agent: world.oldAgent, evidence: 'done', chainId: world.chain.chainId })
  assert.equal(result.ok, false)
  assert.equal(result.code, RELAY_CODES.incomplete)
  world.local.patchFeatures(world.chain.chainId, [{ id: 'F001', passes: true, evidence: 'npm test -> exit 0, 3/3 passed' }])
  const second = world.engine.finish({ agent: world.oldAgent, evidence: 'done', chainId: world.chain.chainId })
  assert.equal(second.ok, true)
  assert.equal(world.local.readChain(world.chain.chainId).status, 'done')
})

await checkAsync('a handoff failure pauses the chain and keeps the old session current', async () => {
  const world = fakeWorld()
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  world.engine.statsFor('session-old').ready = true
  const original = world.engine.ctx.get.bind(world.engine.ctx)
  world.engine.ctx.get = name => (name === 'sessionController'
    ? { create: async () => ({ sessionId: 'session-new' }), prompt: async () => { throw new Error('flush failed') } }
    : original(name))
  await world.engine.evaluate(world.oldAgent)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.status, 'paused')
  assert.equal(chain.currentSessionId, 'session-old')
  assert.ok(chain.pendingHandoff !== null)
  assert.match(chain.lastError, /flush failed/)
})

check('addFeatures appends work and demands a reason', () => {
  const chain = store.create({ objective: 'append objective', cwd: workspace, maxHandoffs: 2 })
  store.writeFeatures(chain.chainId, {
    version: 1,
    objective: 'append objective',
    features: [{ id: 'F001', title: 'first', passes: false }],
  })
  assert.throws(
    () => store.appendFeatures(chain.chainId, [{ id: 'F002', title: 'second' }], '   '),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
  )
  const result = store.appendFeatures(chain.chainId, [{ id: 'F002', title: 'second' }], 'found a subsystem the initializer missed')
  assert.deepEqual(result.appended, ['F002'])
  assert.equal(result.total, 2)
  assert.equal(result.done, 0)
  const document = store.readFeatures(chain.chainId)
  assert.equal(document.features[1].coverage, 'full')
  assert.equal(document.features[0].title, 'first', 'appending must not touch existing entries')
  assert.ok(store.readProgress(chain.chainId).includes('found a subsystem'))
  assert.throws(
    () => store.appendFeatures(chain.chainId, [{ id: 'F002', title: 'again' }], 'duplicate'),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
  )
})

check('coverage is validated and defaults to full', () => {
  const chain = store.create({ objective: 'coverage objective', cwd: workspace, maxHandoffs: 2 })
  store.writeFeatures(chain.chainId, {
    version: 1,
    objective: 'coverage objective',
    features: [{ id: 'F001', title: 'first', passes: false }],
  })
  assert.equal(store.readFeatures(chain.chainId).features[0].coverage, 'full')
  store.patchFeatures(chain.chainId, [{ id: 'F001', coverage: 'partial' }])
  assert.equal(store.readFeatures(chain.chainId).features[0].coverage, 'partial')
  assert.throws(
    () => store.patchFeatures(chain.chainId, [{ id: 'F001', coverage: 'mostly' }]),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
  )
  // 旧版本的取值在读取时迁移成新名字，且不会被当成完整验证
  const legacy = store.create({ objective: 'legacy objective', cwd: workspace, maxHandoffs: 2 })
  store.writeFeatures(legacy.chainId, {
    version: 1,
    objective: 'legacy objective',
    features: [{ id: 'F001', title: 'old', passes: true, evidence: 'make -> 4/4 passed', coverage: 'error-path-only' }],
  })
  assert.equal(store.readFeatures(legacy.chainId).features[0].coverage, 'partial')
  assert.equal(store.readFeatures(legacy.chainId).features[0].coverage === 'full', false)
})

check('project commands survive a round trip', () => {
  const chain = store.create({ objective: 'commands objective', cwd: workspace, maxHandoffs: 2 })
  store.writeFeatures(chain.chainId, {
    version: 1,
    objective: 'commands objective',
    statusCheck: 'node tools/status.mjs',
    verifyFast: 'node tools/smoke.mjs',
    verifyFull: 'pnpm test',
    features: [{ id: 'F001', title: 'first', passes: false }],
  })
  const document = store.readFeatures(chain.chainId)
  assert.equal(document.statusCheck, 'node tools/status.mjs')
  assert.equal(document.verifyFast, 'node tools/smoke.mjs')
  assert.equal(document.verifyFull, 'pnpm test')
})

check('stateBlockLines prefers the relay:state block over headings', () => {
  const handoff = [
    '# Big heading',
    '',
    '<!-- relay:state -->',
    '- environment: ssh box, secret in $DEPLOY_PASS',
    'Next: F007',
    '<!-- /relay:state -->',
    '',
    'free-form detail that should not be quoted',
  ].join('\n')
  const lines = stateBlockLines(handoff)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('$DEPLOY_PASS'))
  assert.ok(!lines.join(' ').includes('Big heading'))
  assert.deepEqual(stateBlockLines('no block at all'), ['no block at all'])
})

await checkAsync('finish refuses partial coverage that no human accepted', async () => {
  const world = fakeWorld()
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'engine objective',
    features: [{
      id: 'F001',
      title: 'a',
      passes: true,
      evidence: 'node tools/smoke.mjs -> exit 0, 13/13 checks passed',
      coverage: 'partial',
    }],
  })
  const refused = world.engine.finish({ agent: world.oldAgent, evidence: 'done' })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /partial coverage/)
  world.local.patchFeatures(world.chain.chainId, [{ id: 'F001', acceptedBy: 'human' }])
  const handEdited = world.engine.finish({ agent: world.oldAgent, evidence: 'done' })
  assert.equal(handEdited.ok, false, 'a hand-written human without the panel stamp must not count')
  world.engine.acceptCoverage({ chainId: world.chain.chainId, featureId: 'F001', accepted: true })
  const accepted = world.engine.finish({ agent: world.oldAgent, evidence: 'done' })
  assert.equal(accepted.ok, true)
})

await checkAsync('finish refuses a pass without usable evidence', async () => {
  const world = fakeWorld()
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'engine objective',
    features: [{ id: 'F001', title: 'a', passes: true, evidence: 'ok' }],
  })
  const refused = world.engine.finish({ agent: world.oldAgent, evidence: 'done' })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /without usable evidence/)
})

await checkAsync('an external blocker pauses the chain and names the human action', async () => {
  const world = fakeWorld()
  const result = world.engine.checkpoint({
    agent: world.oldAgent,
    blocker: { kind: 'external', action: 'open port 5985 for the new IP' },
  })
  assert.equal(result.paused, true)
  assert.equal(result.blocker.kind, 'external')
  assert.equal(result.blocker.who, 'human')
  assert.equal(result.status, 'paused')
  assert.ok(world.local.readProgress(world.chain.chainId).includes('open port 5985'))
  world.engine.checkpoint({ agent: world.oldAgent, blocker: null })
  const cleared = world.local.readChain(world.chain.chainId)
  assert.equal(cleared.blocker, null)
  assert.equal(cleared.status, 'active', 'clearing the external blocker must resume the chain')
  assert.equal(cleared.lastError, null)
})

await checkAsync('a human clears an external blocker from the panel', async () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  assert.equal(world.engine.clearBlocker({ chainId }).cleared, false, 'nothing to clear yet')
  world.engine.checkpoint({ agent: world.oldAgent, blocker: { kind: 'external', action: 'open port 5985' } })
  assert.equal(world.local.readChain(chainId).status, 'paused')
  const result = world.engine.clearBlocker({ chainId })
  assert.equal(result.cleared, true)
  assert.equal(result.status, 'active', 'clearing the blocker must release the pause it caused')
  assert.equal(world.local.readChain(chainId).blocker, null)
  const kinds = world.engine.audit(chainId, 20).map(record => `${record.kind}:${record.actor}`)
  assert.ok(kinds.includes('blocker.cleared:host'), 'the human action must be audited')
})

await checkAsync('clearing a blocker wakes the idle session up again', async () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  world.engine.checkpoint({ agent: world.oldAgent, blocker: { kind: 'external', action: 'open port 5985' } })
  world.engine.clearChainTimers(world.local.readChain(chainId))
  assert.equal(world.engine.timers.has('session-old'), false)
  world.engine.clearBlocker({ chainId })
  assert.equal(world.engine.timers.has('session-old'), true, 'nothing would evaluate the idle session after the blocker is cleared')
  world.engine.clearChainTimers(world.local.readChain(chainId))
})

await checkAsync('resuming a paused chain wakes the idle session up again', async () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  world.engine.setPaused({ chainId, paused: true })
  assert.equal(world.engine.timers.has('session-old'), false, 'a pause must drop the pending re-checks')
  world.engine.setPaused({ chainId, paused: false })
  assert.equal(world.local.readChain(chainId).status, 'active')
  assert.equal(world.engine.timers.has('session-old'), true, 'nothing would evaluate the idle session after the resume')
  world.engine.clearChainTimers(world.local.readChain(chainId))
})

await checkAsync('clearing a blocker releases a pause the session reported itself', async () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  world.engine.checkpoint({
    agent: world.oldAgent,
    blocked: true,
    note: 'need a decision on the queue',
    blocker: { kind: 'decision', action: 'pick Redis Stream or RabbitMQ' },
  })
  const paused = world.local.readChain(chainId)
  assert.equal(paused.status, 'paused')
  assert.equal(paused.pausedBy, 'blocked')
  const result = world.engine.clearBlocker({ chainId })
  assert.equal(result.status, 'active', 'the chain stayed paused after its blocker was cleared')
  const resumed = world.local.readChain(chainId)
  assert.equal(resumed.pausedBy, null)
  assert.equal(resumed.lastError, null)
  world.engine.clearChainTimers(resumed)
})

await checkAsync('clearing the auto-continue limit grants a new budget', async () => {
  const world = fakeWorld({ autoContinue: true, maxAutoContinues: 2 })
  const chainId = world.chain.chainId
  const stats = world.engine.statsFor('session-old')
  stats.autoContinues = 2
  world.engine.maybeAutoContinue(world.local.readChain(chainId), world.local, world.oldAgent, stats)
  assert.match(world.local.readChain(chainId).blocker.action, /^auto-continue limit/)
  world.engine.clearBlocker({ chainId })
  assert.equal(stats.autoContinues, 0, 'the same blocker would be recorded again on the next idle')
  world.engine.clearChainTimers(world.local.readChain(chainId))
})

await checkAsync('a goal-owned blocker cannot be cleared from the panel', async () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  world.local.update(chainId, record => {
    record.blocker = { kind: 'external', who: 'human', action: 'goal blocked: round cap reached' }
  })
  assert.throws(
    () => world.engine.clearBlocker({ chainId }),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
  )
  assert.notEqual(world.local.readChain(chainId).blocker, null)
})

await checkAsync('chain detail reports whether the handoff brief is fresh', async () => {
  const world = fakeWorld()
  const freshness = world.engine.detail(world.chain.chainId).handoffFreshness
  assert.equal(typeof freshness.fresh, 'boolean')
  world.local.writeHandoff(world.chain.chainId, 'no state block here')
  assert.deepEqual(world.engine.detail(world.chain.chainId).handoffFreshness, { fresh: false, reason: 'missing' })
})

await checkAsync('clearing a blocker keeps an unrelated pause', async () => {
  const world = fakeWorld()
  world.local.update(world.chain.chainId, record => {
    record.status = 'paused'
    record.lastError = 'flush failed'
  })
  world.engine.checkpoint({ agent: world.oldAgent, blocker: null })
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.status, 'paused')
  assert.equal(chain.lastError, 'flush failed')
})

await checkAsync('a code blocker does not pause the chain', async () => {
  const world = fakeWorld()
  const result = world.engine.checkpoint({
    agent: world.oldAgent,
    blocker: { kind: 'code', action: 'fix the parser first' },
  })
  assert.equal(result.paused, false)
  assert.equal(result.blocker.who, 'model')
})

check('relay_recall forwards the query to the engine', () => {
  const registered = new Map()
  registerTools(
    { tools: { register: definition => registered.set(definition.name, definition) } },
    {
      recall: input => ({ ok: true, total: 1, matches: [{ file: 'traps.md', line: 2, text: input.query }] }),
    },
  )
  const definition = registered.get('relay_recall')
  const exec = { agent: { session: { header: {} } } }
  const result = definition.execute({ query: 'crlf script' }, exec)
  assert.equal(result.ok, true)
  assert.equal(result.matches[0].file, 'traps.md')
  assert.equal(definition.execute({ query: '  ' }, exec).code, 'invalid_arguments')
})

check('relay_checkpoint refuses weak evidence and unexplained additions', () => {
  const registered = new Map()
  const ctx = { tools: { register: definition => registered.set(definition.name, definition) } }
  registerTools(ctx, { checkpoint: () => ({ ok: true }) })
  const definition = registered.get('relay_checkpoint')
  const exec = { agent: { session: { header: {} } } }

  const weak = definition.execute({ features: [{ id: 'F001', passes: true, evidence: 'all green' }] }, exec)
  assert.equal(weak.code, 'evidence_too_weak')

  const strong = definition.execute({
    features: [{ id: 'F001', passes: true, evidence: 'node test/smoke.mjs -> exit 0, 13/13 passed' }],
  }, exec)
  assert.equal(strong.ok, true)

  // 任何技术栈的结果形态都要能过：比例、退出码、构建结论、中文结论
  for (const evidence of [
    'pytest -q -> 41 passed, 2 skipped',
    'go test ./... -> ok  6 packages, 0 failures',
    'mvn -B verify -> BUILD SUCCESS, 0 errors',
    'cargo test -> test result: ok. 18 passed',
    'gradle check -> 3/3 tasks passed',
    '验证脚本 -> 通过 23/23',
    'tsc --noEmit -> exit 0, 0 errors',
  ]) {
    const accepted = definition.execute({ features: [{ id: 'F001', passes: true, evidence }] }, exec)
    assert.equal(accepted.ok, true, `evidence should be accepted: ${evidence}`)
  }

  const unreasoned = definition.execute({ addFeatures: [{ id: 'F002', title: 'new' }] }, exec)
  assert.equal(unreasoned.code, 'missing_reason')

  const vague = definition.execute({ blocker: { kind: 'external' } }, exec)
  assert.equal(vague.code, 'invalid_arguments')

  // requireStrongEvidence=false：只要求长度与数字，不要求结果标记
  const relaxed = new Map()
  registerTools(
    { tools: { register: definition => relaxed.set(definition.name, definition) } },
    { checkpoint: () => ({ ok: true }), config: { requireStrongEvidence: false } },
  )
  const loose = relaxed.get('relay_checkpoint')
  const accepted = loose.execute({ features: [{ id: 'F001', passes: true, evidence: '手工走查过一遍，确认没问题' }] }, exec)
  assert.equal(accepted.ok, true)
  // 强模式下这类散文证据仍然被拒
  const prose = definition.execute({ features: [{ id: 'F001', passes: true, evidence: '手工走查过一遍，确认没问题' }] }, exec)
  assert.equal(prose.code, 'evidence_too_weak')
})

await checkAsync('requireHumanAcceptedCoverage=false lets partial work finish', async () => {
  const world = fakeWorld({ requireHumanAcceptedCoverage: false })
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'engine objective',
    features: [{
      id: 'F001',
      title: 'a',
      passes: true,
      evidence: 'make check -> 12/12 passed',
      coverage: 'partial',
    }],
  })
  const result = world.engine.finish({ agent: world.oldAgent, evidence: 'done' })
  assert.equal(result.ok, true)
})

/** Build a world for delegation checks. */
function spawnWorld() {
  const config = resolveConfig({ cooldownMs: 0 })
  const workspaceDir = mkdtempSync(join(tmpdir(), 'relay-spawn-'))
  const indexHome = mkdtempSync(join(tmpdir(), 'relay-spawn-home-'))
  const local = ChainStore.forCwd(workspaceDir)
  const chain = local.create({ objective: 'delegation', cwd: workspaceDir, maxHandoffs: 4 })
  local.writeFeatures(chain.chainId, {
    version: 1,
    objective: 'delegation',
    features: [
      { id: 'F001', title: 'done already', passes: true, evidence: 'ran true', verify: 'true' },
      { id: 'F002', title: 'second', passes: false, verify: 'node two.mjs' },
      { id: 'F003', title: 'third', passes: false, verify: 'node three.mjs' },
    ],
  })
  local.update(chain.chainId, record => {
    record.sessions.push({
      sessionId: 'session-parent',
      role: 'initializer',
      index: 0,
      joinedAt: new Date().toISOString(),
      parentSessionId: null,
    })
    record.currentSessionId = 'session-parent'
    record.status = 'active'
  })
  const calls = []
  const makeAgent = (id) => ({
    id,
    session: { id, header: { cwd: workspaceDir } },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) { calls.push({ kind: 'followup', sessionId: id, text: message.content[0].text }) },
    inject(message) { calls.push({ kind: 'inject', sessionId: id, text: message.content[0].text }) },
  })
  const parent = makeAgent('session-parent')
  const child = makeAgent('session-child')
  let ratio = 0.1
  let goal
  const services = {
    agents: { get: id => (id === 'session-parent' ? parent : id === 'session-child' ? child : undefined) },
    goals: { get: agent => (agent.id === 'session-parent' ? goal : undefined) },
    sessionController: {
      async create() { return { sessionId: 'session-child' } },
      async prompt(request) {
        calls.push({ kind: 'prompt', sessionId: request.sessionId, text: request.content[0].text })
        return { accepted: true }
      },
    },
    tokenMeter: {
      contextPressure: () => ({ pressureTokens: Math.round(ratio * 1000), contextWindow: 1000 }),
      measure: () => ({ totalTokens: Math.round(ratio * 1000) }),
    },
    sessions: { flush: async () => true },
  }
  const ctx = { logger: { warn: () => {} }, get: name => services[name] }
  const engine = new RelayEngine(ctx, config, {
    chainIndex: new ChainIndex(indexHome),
    fingerprints: new ChainFingerprints(indexHome),
  })
  engine.members.set('session-parent', { chainId: chain.chainId, truthDir: local.truthDir })
  engine.remember(local.readChain(chain.chainId), local)
  return { engine, local, chain, parent, child, calls, setGoal: value => { goal = value }, setRatio: value => { ratio = value } }
}

await checkAsync('spawn delegates features to a child session', async () => {
  const world = spawnWorld()
  const result = await world.engine.spawn({ agent: world.parent, features: ['F002', 'F003'] })
  assert.equal(result.sessionId, 'session-child')
  assert.deepEqual(result.features, ['F002', 'F003'])
  const chain = world.local.readChain(world.chain.chainId)
  const child = chain.sessions.find(session => session.sessionId === 'session-child')
  assert.equal(child.parentSessionId, 'session-parent')
  const features = world.local.readFeatures(world.chain.chainId).features
  assert.equal(features.find(feature => feature.id === 'F002').assignedSessionId, 'session-child')
  const prompt = world.calls.find(call => call.kind === 'prompt')
  assert.match(prompt.text, /<relay_delegation>/)
  assert.ok(prompt.text.includes('F002'))
})

await checkAsync('spawn carries the parent permission preset to the child', async () => {
  const world = spawnWorld()
  const presets = withPresets(world, { 'session-parent': 'danger-full-access' })
  await world.engine.spawn({ agent: world.parent, features: ['F002'] })
  assert.deepEqual(presets.switches, [{ sessionId: 'session-child', preset: 'danger-full-access' }])
})

await checkAsync('spawn refuses a feature that already passes', async () => {
  const world = spawnWorld()
  await assert.rejects(
    () => world.engine.spawn({ agent: world.parent, features: ['F001'] }),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
  )
})

await checkAsync('spawn refuses a feature already delegated', async () => {
  const world = spawnWorld()
  await world.engine.spawn({ agent: world.parent, features: ['F002'] })
  await assert.rejects(
    () => world.engine.spawn({ agent: world.parent, features: ['F002'] }),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
  )
})

await checkAsync('spawn refuses a session that is not the chain head', async () => {
  const world = spawnWorld()
  const outsider = {
    id: 'session-outsider',
    session: { id: 'session-outsider', header: { cwd: world.chain.cwd } },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    inject() {},
  }
  await assert.rejects(
    () => world.engine.spawn({ agent: outsider, features: ['F002'] }),
    error => error instanceof RelayError && error.code === RELAY_CODES.notFound,
  )
})

await checkAsync('sessionView rediscovers a chain after a reload', async () => {
  const world = spawnWorld()
  world.engine.stores.clear()
  world.engine.members.clear()
  const view = world.engine.sessionView('session-parent')
  assert.ok(view !== undefined, 'the loaded session did not rediscover its chain')
  assert.equal(view.chain.chainId, world.chain.chainId)
  assert.equal(view.self.sessionId, 'session-parent')
})

await checkAsync('status reports the live pressure as a peak too', async () => {
  const world = spawnWorld()
  const [chain] = world.engine.status()
  assert.equal(chain.sessionsDetail.length, 1)
  assert.equal(chain.sessionsDetail[0].pressureRatio, 0.1)
  assert.ok(chain.sessionsDetail[0].peakRatio >= 0.1, 'peakRatio ignored the loaded session\'s pressure')
})

await checkAsync('the list, the detail, and the session tab agree on a session peak', async () => {
  const world = spawnWorld()
  const [listed] = world.engine.status()
  const detailed = world.engine.detail(world.chain.chainId).sessions[0]
  const viewed = world.engine.sessionView('session-parent').self
  assert.equal(listed.sessionsDetail[0].peakRatio, 0.1)
  assert.equal(detailed.peakRatio, 0.1, 'the detail peak ignored the live reading')
  assert.equal(viewed.peakRatio, 0.1, 'the session tab peak ignored the live reading')
})

await checkAsync('sessionView reports parent, children, and owned features', async () => {
  const world = spawnWorld()
  world.setGoal({ phase: 'active', activation: 'armed', roundsStarted: 2, maxGoalRounds: 16 })
  await world.engine.spawn({ agent: world.parent, features: ['F002'] })
  const parentView = world.engine.sessionView('session-parent')
  assert.equal(parentView.chain.chainId, world.chain.chainId)
  assert.equal(parentView.parent, null)
  assert.equal(parentView.children.length, 1)
  assert.equal(parentView.children[0].sessionId, 'session-child')
  assert.deepEqual(parentView.children[0].features, ['F002'])
  assert.deepEqual(parentView.children[0].featureList, [{ id: 'F002', title: 'second', passes: false }])
  assert.deepEqual(parentView.openFeatures.map(feature => feature.id), ['F001', 'F003'])
  assert.equal(parentView.self.index, 0)
  assert.deepEqual(parentView.self.goal, {
    phase: 'active',
    activation: 'armed',
    roundsStarted: 2,
    maxGoalRounds: 16,
    blockedCode: null,
    blockedMessage: null,
  })
  const childView = world.engine.sessionView('session-child')
  assert.equal(childView.parent.sessionId, 'session-parent')
  assert.equal(childView.children.length, 0)
  assert.deepEqual(childView.assignedFeatures.map(feature => feature.id), ['F002'])
  assert.equal(childView.self.goal, null)
  assert.equal(world.engine.sessionView('session-unknown'), undefined)
})

await checkAsync('audit records chain lifecycle, delegations, and feature changes', async () => {
  const world = spawnWorld()
  await world.engine.spawn({ agent: world.parent, features: ['F002'] })
  world.engine.checkpoint({
    agent: world.parent,
    chainId: world.chain.chainId,
    features: [{ id: 'F002', passes: true, evidence: 'ran node two.mjs, exit 0, 3 checks' }],
  })
  const records = world.engine.audit(world.chain.chainId, 50)
  const kinds = records.map(record => record.kind)
  assert.ok(kinds.includes('delegation.created'), `expected delegation.created, got ${kinds.join(',')}`)
  assert.ok(kinds.includes('feature.assigned'), `expected feature.assigned, got ${kinds.join(',')}`)
  assert.ok(kinds.includes('feature.passed'), `expected feature.passed, got ${kinds.join(',')}`)
  const passed = records.find(record => record.kind === 'feature.passed')
  assert.equal(passed.detail.id, 'F002')
  assert.equal(passed.actor, 'session-parent')
  for (const record of records) {
    assert.equal(typeof record.at, 'string', 'every audit record needs a timestamp')
    assert.equal(typeof record.kind, 'string', 'every audit record needs a kind')
  }
})

check('readAudit keeps valid lines and skips a truncated one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-audit-'))
  const local = ChainStore.forCwd(dir)
  const chain = local.create({ objective: 'audit', cwd: dir })
  const path = local.paths(chain.chainId).audit
  writeFileSync(path, `{"not":"closed"\n${JSON.stringify({ at: new Date().toISOString(), kind: 'ok' })}\n`)
  const records = local.readAudit(chain.chainId, 10)
  assert.equal(records.length, 1)
  assert.equal(records[0].kind, 'ok')
  local.appendAudit(chain.chainId, { kind: 'second', actor: 'session-x' })
  const later = local.readAudit(chain.chainId, 1)
  assert.equal(later.length, 1)
  assert.equal(later[0].kind, 'second')
  assert.equal(later[0].actor, 'session-x')
})

// --- first batch: caller gates, acceptance, fingerprint, timers ---

await checkAsync('a session outside the chain cannot write to it', async () => {
  const world = fakeWorld()
  const outsider = {
    id: 'session-outsider',
    session: { id: 'session-outsider', header: { cwd: world.chain.cwd } },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
  }
  assert.throws(
    () => world.engine.checkpoint({ agent: outsider, chainId: world.chain.chainId, note: 'x' }),
    error => error instanceof RelayError && error.code === RELAY_CODES.notMember,
  )
  assert.throws(
    () => world.engine.finish({ agent: outsider, chainId: world.chain.chainId, evidence: 'done' }),
    error => error instanceof RelayError && error.code === RELAY_CODES.notMember,
  )
  assert.throws(
    () => world.engine.setPaused({ agent: outsider, chainId: world.chain.chainId, paused: true }),
    error => error instanceof RelayError && error.code === RELAY_CODES.notMember,
  )
  await assert.rejects(
    () => world.engine.handoffNow({ agent: outsider, chainId: world.chain.chainId }),
    error => error instanceof RelayError && error.code === RELAY_CODES.notMember,
  )
})

await checkAsync('a retired session is read-only', async () => {
  const world = fakeWorld()
  world.local.update(world.chain.chainId, record => {
    const session = record.sessions.find(entry => entry.sessionId === 'session-old')
    session.retiredAt = new Date().toISOString()
  })
  assert.throws(
    () => world.engine.checkpoint({ agent: world.oldAgent, note: 'late' }),
    error => error instanceof RelayError && error.code === RELAY_CODES.retired,
  )
  assert.throws(
    () => world.engine.finish({ agent: world.oldAgent, evidence: 'done' }),
    error => error instanceof RelayError && error.code === RELAY_CODES.retired,
  )
})

await checkAsync('a delegated worker only writes its own features', async () => {
  const world = spawnWorld()
  await world.engine.spawn({ agent: world.parent, features: ['F002'] })
  assert.throws(
    () => world.engine.finish({ agent: world.child, evidence: 'done' }),
    error => error instanceof RelayError && error.code === RELAY_CODES.workerReadOnly,
  )
  assert.throws(
    () => world.engine.setPaused({ agent: world.child, chainId: world.chain.chainId, paused: true }),
    error => error instanceof RelayError && error.code === RELAY_CODES.workerReadOnly,
  )
  const own = world.engine.checkpoint({
    agent: world.child,
    features: [{ id: 'F002', passes: true, evidence: 'node two.mjs -> exit 0, 3 checks' }],
  })
  assert.equal(own.chainId, world.chain.chainId)
  assert.throws(
    () => world.engine.checkpoint({ agent: world.child, features: [{ id: 'F003', notes: 'not mine' }] }),
    error => error instanceof RelayError && error.code === RELAY_CODES.workerReadOnly,
  )
  assert.throws(
    () => world.engine.checkpoint({ agent: world.child, ready: true }),
    error => error instanceof RelayError && error.code === RELAY_CODES.workerReadOnly,
  )
  assert.throws(
    () => world.engine.checkpoint({ agent: world.child, features: [{ id: 'F002', assignedSessionId: null }] }),
    error => error instanceof RelayError && error.code === RELAY_CODES.workerReadOnly,
  )
})

check('the model cannot write acceptedBy itself', () => {
  const world = fakeWorld()
  const registered = new Map()
  registerTools({ tools: { register: definition => registered.set(definition.name, definition) } }, world.engine)
  const definition = registered.get('relay_checkpoint')
  const result = definition.execute({
    features: [{ id: 'F001', passes: true, evidence: 'npm test -> exit 0, 3/3 passed', acceptedBy: 'human' }],
  }, { agent: world.oldAgent })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_arguments')
  assert.throws(
    () => world.engine.checkpoint({
      agent: world.oldAgent,
      features: [{ id: 'F001', acceptedBy: 'human' }],
    }),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
  )
})

check('the panel acceptance path releases partial coverage', () => {
  const world = fakeWorld({ requireHumanAcceptedCoverage: true })
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'engine objective',
    features: [{ id: 'F001', title: 'a', passes: true, evidence: 'npm test -> exit 0, 3/3 passed', verify: 'npm test', coverage: 'partial' }],
  })
  world.engine.freezeFeatures(world.local.readChain(world.chain.chainId), world.local, 'test')
  const refused = world.engine.finish({ agent: world.oldAgent, evidence: 'done' })
  assert.equal(refused.ok, false, 'partial coverage must not finish before acceptance')
  const remote = new RelayRemote(world.engine)
  remote.acceptCoverage(world.chain.chainId, 'F001', true)
  const accepted = world.engine.finish({ agent: world.oldAgent, evidence: 'done' })
  assert.equal(accepted.ok, true)
  remote.acceptCoverage(world.chain.chainId, 'F001', false)
  const revoked = world.engine.finish({ agent: world.oldAgent, evidence: 'done' })
  assert.equal(revoked.ok, false)
  const descriptor = Object.getOwnPropertyDescriptor(RelayRemote.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods')
  assert.ok(descriptor.value.methods.some(method => method.method === 'acceptCoverage'))
})

check('finish refuses a deleted, renamed, or unannounced feature', () => {
  const world = fakeWorld()
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'engine objective',
    features: [
      { id: 'F001', title: 'a', passes: false },
      { id: 'F002', title: 'b', passes: false },
    ],
  })
  world.engine.freezeFeatures(world.local.readChain(world.chain.chainId), world.local, 'test')
  const deleted = world.local.readFeatures(world.chain.chainId)
  deleted.features = deleted.features.filter(feature => feature.id !== 'F002')
  world.local.writeFeatures(world.chain.chainId, deleted)
  assert.throws(
    () => world.engine.finish({ agent: world.oldAgent, evidence: 'done' }),
    error => error instanceof RelayError && error.code === RELAY_CODES.drift,
  )
  const renamed = world.local.readFeatures(world.chain.chainId)
  renamed.features.push({ id: 'F002', title: 'renamed', passes: false })
  renamed.features[1].title = 'renamed by hand'
  world.local.writeFeatures(world.chain.chainId, renamed)
  assert.throws(
    () => world.engine.finish({ agent: world.oldAgent, evidence: 'done' }),
    error => error instanceof RelayError && error.code === RELAY_CODES.drift,
  )
  const added = world.local.readFeatures(world.chain.chainId)
  added.features[1].title = 'b'
  added.features.push({ id: 'F003', title: 'sneaked in', passes: false })
  world.local.writeFeatures(world.chain.chainId, added)
  assert.throws(
    () => world.engine.finish({ agent: world.oldAgent, evidence: 'done' }),
    error => error instanceof RelayError && error.code === RELAY_CODES.drift,
  )
})

check('checkpoint refuses a drifted feature list', () => {
  const world = fakeWorld()
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'engine objective',
    features: [{ id: 'F001', title: 'a', passes: false }, { id: 'F002', title: 'b', passes: false }],
  })
  world.engine.freezeFeatures(world.local.readChain(world.chain.chainId), world.local, 'test')
  const document = world.local.readFeatures(world.chain.chainId)
  document.features[1].title = 'renamed by hand'
  world.local.writeFeatures(world.chain.chainId, document)
  assert.throws(
    () => world.engine.checkpoint({ agent: world.oldAgent, features: [{ id: 'F001', notes: 'x' }] }),
    error => error instanceof RelayError && error.code === RELAY_CODES.drift,
  )
})

check('finish re-checks evidence for every passing feature', () => {
  const world = fakeWorld()
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'engine objective',
    features: [{ id: 'F001', title: 'a', passes: true, evidence: 'looks fine', verify: 'npm test', coverage: 'full' }],
  })
  const result = world.engine.finish({ agent: world.oldAgent, evidence: 'done' })
  assert.equal(result.ok, false)
  assert.equal(result.code, RELAY_CODES.incomplete)
  assert.equal(result.features[0].id, 'F001')
})

await checkAsync('a wrap-up deadline hands off without a ready checkpoint', async () => {
  const world = fakeWorld()
  world.engine.config.wrapupTimeoutMinutes = 0.005
  world.setRatio(0.55)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.filter(call => /<relay_wrapup>/.test(call.text ?? '')).length, 1)
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.ok(world.calls.some(call => call.kind === 'create'), 'the wrap-up deadline did not hand off')
  world.engine.dispose()
})

await checkAsync('a cooled-down evaluation is retried instead of dropped', async () => {
  const world = fakeWorld({ cooldownMs: 200 })
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  world.engine.statsFor('session-old').ready = true
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0, 'the cooled check ran immediately')
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.ok(world.calls.some(call => call.kind === 'create'), 'the cooled check was never retried')
  world.engine.dispose()
})

await checkAsync('the initializer freezes the list on its first checkpoint', async () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-start-home-'))
  const workspaceDir = mkdtempSync(join(tmpdir(), 'relay-start-ws-'))
  const agent = {
    id: 'session-initial',
    session: { id: 'session-initial', header: { cwd: workspaceDir } },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    inject() {},
  }
  const services = {
    agents: { get: id => (id === 'session-initial' ? agent : undefined) },
    sessions: { flush: async () => true },
  }
  const engine = new RelayEngine(
    { logger: { warn: () => {} }, get: name => services[name] },
    resolveConfig({}),
    { chainIndex: new ChainIndex(home), fingerprints: new ChainFingerprints(home) },
  )
  const started = engine.start({ agent, objective: 'freeze me' })
  assert.equal(engine.findChain(started.chainId).chain.status, 'initializing')
  const store = engine.storeFor(engine.findChain(started.chainId).store.truthDir)
  store.writeFeatures(started.chainId, {
    version: 1,
    objective: 'freeze me',
    features: [{ id: 'F001', title: 'one', passes: false }],
  })
  engine.checkpoint({ agent, features: [{ id: 'F001', notes: 'listed' }] })
  assert.equal(engine.findChain(started.chainId).chain.status, 'active')
  assert.deepEqual(engine.fingerprints.get(started.chainId).features, [{ id: 'F001', title: 'one' }])
  engine.dispose()
})

await checkAsync('a reload re-attaches the wrap-up deadline', async () => {
  const world = fakeWorld()
  world.engine.config.wrapupTimeoutMinutes = 0.005
  world.setRatio(0.55)
  await world.engine.evaluate(world.oldAgent)
  world.engine.dispose()
  const restarted = world.rebuild()
  restarted.config.wrapupTimeoutMinutes = 0.005
  restarted.scheduleWrapupDeadline(world.oldAgent)
  assert.ok(restarted.timers.has('session-old'), 'the reload did not re-attach the deadline')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.ok(world.calls.some(call => call.kind === 'create'), 'the reloaded deadline did not hand off')
  restarted.dispose()
})

check('pausing a chain clears its pending re-checks', () => {
  const world = fakeWorld()
  world.engine.scheduleEvaluate('session-old', 60_000)
  assert.ok(world.engine.timers.has('session-old'))
  world.engine.setPaused({ chainId: world.chain.chainId, paused: true })
  assert.equal(world.engine.timers.has('session-old'), false)
  world.engine.dispose()
})

// --- second batch: handoff robustness ---

await checkAsync('a stale brief forces a wrap-up before a compaction handoff', async () => {
  const world = fakeWorld({ hardCompactions: 2 })
  world.local.writeHandoff(world.chain.chainId, 'Not written yet')
  world.engine.noteCompaction('session-old')
  world.engine.noteCompaction('session-old')
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.filter(call => /<relay_wrapup>/.test(call.text ?? '')).length, 1)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0, 'handed off with a stale brief')
})

await checkAsync('a compaction handoff waits out the stale grace', async () => {
  const world = fakeWorld({ hardCompactions: 2, staleHandoffMinutes: 5 })
  world.local.writeHandoff(world.chain.chainId, 'Not written yet')
  world.local.update(world.chain.chainId, record => {
    record.wrapupAt = new Date(Date.now() - 10_000).toISOString()
  })
  world.engine.noteCompaction('session-old')
  world.engine.noteCompaction('session-old')
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0, 'handed off before the stale grace')
  world.engine.dispose()
})

await checkAsync('a stale handoff is forced with a warning after the grace', async () => {
  const world = fakeWorld({ staleHandoffMinutes: 1, wrapupTimeoutMinutes: 10 })
  world.local.writeHandoff(world.chain.chainId, 'Not written yet')
  world.local.update(world.chain.chainId, record => {
    record.wrapupAt = new Date(Date.now() - 2 * 60_000).toISOString()
  })
  await world.engine.evaluate(world.oldAgent)
  const prompt = world.calls.find(call => call.kind === 'prompt')
  assert.ok(prompt !== undefined, 'the stale grace did not hand off')
  assert.match(prompt.text, /WARNING: the previous HANDOFF\.md is stale/)
  const decision = world.local.readAudit(world.chain.chainId, 50)
    .find(record => record.kind === 'supervisor.decision' && record.detail.action === 'handoff')
  assert.equal(decision.detail.reason, 'stale')
})

await checkAsync('a stale brief waits out the grace even when pressure is high', async () => {
  const world = fakeWorld({ staleHandoffMinutes: 5, wrapupTimeoutMinutes: 10, handoffRatio: 0.6 })
  world.local.writeHandoff(world.chain.chainId, 'Not written yet')
  world.local.update(world.chain.chainId, record => {
    record.wrapupAt = new Date().toISOString()
  })
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0, 'pressure bypassed the stale grace')
  assert.ok(world.engine.timers.has('session-old'), 'no re-check was scheduled for the grace')
  world.engine.dispose()
})

await checkAsync('the handoff cap pauses even when external blockers do not', async () => {
  const world = fakeWorld({ pauseOnExternalBlocker: false, maxHandoffs: 1 })
  world.local.update(world.chain.chainId, record => {
    record.handoffCount = 1
    record.maxHandoffs = 1
  })
  await assert.rejects(
    () => world.engine.handoff(world.local.readChain(world.chain.chainId), world.oldAgent, 'manual', world.local),
    error => error instanceof RelayError && error.code === RELAY_CODES.limit,
  )
  const after = world.local.readChain(world.chain.chainId)
  assert.equal(after.status, 'paused')
  assert.equal(after.pausedBy, 'handoff-limit')
})

await checkAsync('reconciling a pending handoff stops the old head from acting', async () => {
  const world = fakeWorld()
  world.local.update(world.chain.chainId, record => {
    record.sessions.push({
      sessionId: 'session-new',
      role: 'worker',
      index: 1,
      joinedAt: new Date().toISOString(),
      parentSessionId: null,
      compactions: 0,
    })
    record.pendingHandoff = { sessionId: 'session-new', createdAt: new Date().toISOString(), reason: 'manual' }
  })
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.currentSessionId, 'session-new')
  assert.equal(chain.pendingHandoff, null)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0)
})

await checkAsync('a handoff does not shrink a durable compaction count', async () => {
  const world = fakeWorld()
  world.local.update(world.chain.chainId, record => {
    record.sessions.find(session => session.sessionId === 'session-old').compactions = 3
  })
  const restarted = world.rebuild()
  await restarted.handoff(world.local.readChain(world.chain.chainId), world.oldAgent, 'manual', world.local)
  const after = world.local.readChain(world.chain.chainId).sessions
    .find(session => session.sessionId === 'session-old').compactions
  assert.equal(after, 3)
})

await checkAsync('manual handoff is refused while the session is running', async () => {
  const world = fakeWorld()
  world.oldAgent.status = 'running'
  await assert.rejects(
    () => world.engine.handoffNow({ agent: world.oldAgent, chainId: world.chain.chainId }),
    error => error instanceof RelayError && error.code === RELAY_CODES.busy,
  )
  world.oldAgent.status = 'idle'
})

await checkAsync('a failed handoff reuses the pending session on retry', async () => {
  const world = fakeWorld()
  const controller = world.engine.ctx.get('sessionController')
  const originalPrompt = controller.prompt
  controller.prompt = async () => { throw new Error('flush failed') }
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  world.engine.statsFor('session-old').ready = true
  await world.engine.evaluate(world.oldAgent)
  assert.ok(world.local.readChain(world.chain.chainId).pendingHandoff !== null)
  controller.prompt = originalPrompt
  const result = await world.engine.handoff(world.local.readChain(world.chain.chainId), world.oldAgent, 'checkpoint', world.local)
  assert.equal(result.newSessionId, 'session-new', 'the retry created a second session instead of reusing the pending one')
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 1)
})

await checkAsync('the handoff limit pauses the chain instead of failing it', async () => {
  const world = fakeWorld({ maxHandoffs: 1 })
  world.local.update(world.chain.chainId, record => {
    record.handoffCount = 1
    record.maxHandoffs = 1
  })
  const chain = world.local.readChain(world.chain.chainId)
  await assert.rejects(
    () => world.engine.handoff(chain, world.oldAgent, 'manual', world.local),
    error => error instanceof RelayError && error.code === RELAY_CODES.limit,
  )
  const limited = world.local.readChain(world.chain.chainId)
  assert.equal(limited.status, 'paused')
  assert.equal(limited.pausedBy, 'handoff-limit')
  assert.equal(limited.blocker.kind, 'external')
  const raised = world.engine.raiseHandoffLimit({ chainId: world.chain.chainId, maxHandoffs: 5 })
  assert.equal(raised.maxHandoffs, 5)
  assert.notEqual(world.local.readChain(world.chain.chainId).status, 'paused')
})

await checkAsync('autoContinue nudges an idle chain head once', async () => {
  const world = fakeWorld({ autoContinue: true })
  world.setRatio(0.2)
  await world.engine.evaluate(world.oldAgent)
  assert.ok(world.calls.some(call => /<relay_continue>/.test(call.text ?? '')))
  assert.equal(world.engine.statsFor('session-old').autoContinues, 1)
})

await checkAsync('autoContinue stops at the configured limit', async () => {
  const world = fakeWorld({ autoContinue: true, maxAutoContinues: 1 })
  world.setRatio(0.2)
  await world.engine.evaluate(world.oldAgent)
  await world.engine.evaluate(world.oldAgent)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.blocker.kind, 'external')
  assert.equal(chain.status, 'paused')
})

await checkAsync('a pressured worker returns its unfinished features', async () => {
  const world = spawnWorld()
  await world.engine.spawn({ agent: world.parent, features: ['F002'] })
  world.setRatio(0.6)
  await world.engine.evaluate(world.child)
  assert.ok(world.calls.some(call => /<relay_worker_wrapup>/.test(call.text ?? '')))
  const feature = world.local.readFeatures(world.chain.chainId).features.find(entry => entry.id === 'F002')
  assert.equal(feature.assignedSessionId, null)
})

await checkAsync('the chain head can reclaim a worker delegation', async () => {
  const world = spawnWorld()
  await world.engine.spawn({ agent: world.parent, features: ['F002'] })
  const result = world.engine.reclaimDelegation({ agent: world.parent, sessionId: 'session-child' })
  assert.deepEqual(result.features, ['F002'])
  const feature = world.local.readFeatures(world.chain.chainId).features.find(entry => entry.id === 'F002')
  assert.equal(feature.assignedSessionId, null)
})

check('the handoff prompt skips delegated features and sorts by priority', () => {
  const prompt = renderHandoffPrompt({
    chain: { chainId: 'chain-x', objective: 'o', cwd: '/w' },
    features: {
      statusCheck: '',
      features: [
        { id: 'F001', title: 'p3', priority: 3, passes: false },
        { id: 'F002', title: 'p1-delegated', priority: 1, passes: false, assignedSessionId: 'session-w' },
        { id: 'F003', title: 'p2', priority: 2, passes: false },
      ],
    },
    handoff: '<!-- relay:state -->\n- x\n<!-- /relay:state -->',
    handoffNo: 1,
    previousSessionId: 'session-old',
    truthDir: '/w/.relay/chain-x',
  })
  assert.match(prompt, /Next feature: F003/)
})

await checkAsync('clearing an external blocker resumes a chain paused by it', async () => {
  const world = fakeWorld()
  world.engine.checkpoint({
    agent: world.oldAgent,
    blocked: true,
    note: 'waiting for access',
    blocker: { kind: 'external', action: 'grant access' },
  })
  const paused = world.local.readChain(world.chain.chainId)
  assert.equal(paused.status, 'paused')
  assert.equal(paused.pausedBy, 'blocker')
  world.engine.checkpoint({ agent: world.oldAgent, blocker: null })
  assert.equal(world.local.readChain(world.chain.chainId).status, 'active')
})

await checkAsync('a timed-out handoff records the timeout reason', async () => {
  const world = fakeWorld()
  world.engine.config.wrapupTimeoutMinutes = 0.005
  world.setRatio(0.55)
  await world.engine.evaluate(world.oldAgent)
  await new Promise(resolve => setTimeout(resolve, 500))
  const decision = world.local.readAudit(world.chain.chainId, 50)
    .find(record => record.kind === 'supervisor.decision' && record.detail.action === 'handoff')
  assert.equal(decision.detail.reason, 'timeout')
  world.engine.dispose()
})

check('a moved chain record is corrected on read', () => {
  const world = fakeWorld()
  world.local.update(world.chain.chainId, record => {
    record.truthDir = '/nonexistent/.relay'
    record.cwd = '/nonexistent'
  })
  const { chain } = world.engine.findChain(world.chain.chainId)
  assert.equal(chain.truthDir, world.local.truthDir)
  assert.equal(chain.cwd, world.chain.cwd)
  assert.equal(world.local.readChain(world.chain.chainId).truthDir, world.local.truthDir)
})

check('the chain gitignore covers host-owned files', () => {
  const world = fakeWorld()
  world.local.ensureGitignore(world.chain.chainId)
  const text = readFileSync(join(world.local.paths(world.chain.chainId).dir, '.gitignore'), 'utf8')
  assert.match(text, /relay\.json/)
  assert.match(text, /audit\.jsonl/)
})

check('commitTruth=false removes the commit instruction', () => {
  const wrapup = renderWrapupPrompt({ truthDir: '/w/.relay/c', featuresTotal: 1, featuresDone: 0, commitTruth: false })
  assert.ok(!wrapup.includes('Commit the workspace state'))
  assert.ok(wrapup.includes('Do not commit'))
  const initial = renderInitializerPrompt({ truthDir: '/w/.relay/c', objective: 'o', commitTruth: false })
  assert.ok(!initial.includes('Commit the truth source'))
})

// --- third batch: small items ---

check('malformed chain ids are rejected before touching the filesystem', () => {
  const world = fakeWorld()
  for (const bad of ['../chain-00000000-0000-4000-8000-000000000000', 'chain-', 'chain-../../x', '']) {
    assert.throws(
      () => world.local.paths(bad),
      error => error instanceof RelayError && error.code === RELAY_CODES.invalid,
      `paths accepted ${JSON.stringify(bad)}`,
    )
  }
  assert.equal(world.local.readChain('../chain-00000000-0000-4000-8000-000000000000'), undefined)
})

check('truthDir may not contain a parent segment', () => {
  assert.throws(() => resolveConfig({ truthDir: '../escape' }), /must not contain "\.\."/)
  assert.throws(() => resolveConfig({ truthDir: 'a/../../b' }), /must not contain "\.\."/)
  assert.equal(resolveConfig({ truthDir: 'relay' }).truthDir, 'relay')
})

check('recall matches whole paragraphs in markdown', () => {
  const world = fakeWorld()
  world.local.appendLedger(world.chain.chainId, 'traps', 'first line of the block CRLF\nsecond line also CRLF')
  const result = world.engine.recall({ chainId: world.chain.chainId, query: 'CRLF' })
  assert.equal(result.total, 1)
  assert.equal(result.matches[0].file, 'traps.md')
  assert.ok(result.matches[0].text.includes('first line'))
  assert.ok(result.matches[0].text.includes('second line'))
})

check('status reuses its payload until a chain file changes', () => {
  const world = fakeWorld()
  const first = world.engine.status()
  const second = world.engine.status()
  assert.equal(first, second, 'status did not reuse the cached payload')
  world.local.update(world.chain.chainId, record => { record.lastError = 'changed' })
  const third = world.engine.status()
  assert.notEqual(first, third, 'status ignored a changed chain file')
  assert.equal(third[0].lastError, 'changed')
})

check('status notices a chain file rewritten within the same file-time tick', () => {
  const world = fakeWorld()
  const chainFile = world.local.paths(world.chain.chainId).chain
  // What a coarse filesystem clock does to two quick writes: the same mtime.
  const tick = new Date('2026-01-01T00:00:00.000Z')
  utimesSync(chainFile, tick, tick)
  const before = statSync(chainFile).mtimeMs
  const first = world.engine.status()
  world.local.update(world.chain.chainId, record => { record.lastError = 'changed' })
  utimesSync(chainFile, tick, tick)
  assert.equal(statSync(chainFile).mtimeMs, before, 'the fixture did not reproduce an unchanged file time')
  const second = world.engine.status()
  assert.notEqual(first, second, 'status served a stale payload for a changed chain file')
  assert.equal(second[0].lastError, 'changed')
})

// A head blocked inside one long command keeps `running` and writes nothing, so
// the chain looks alive while it stands still. The summary has to say how long.
check('a running head that writes nothing reports a stall, and a write clears it', () => {
  // `update()` stamps updatedAt, so a quiet session is aged by leaving the file
  // alone; the report has to follow that age, not the last time the engine looked.
  const ageRecord = (world, minutes) => {
    const chainFile = world.local.paths(world.chain.chainId).chain
    const record = JSON.parse(readFileSync(chainFile, 'utf8'))
    record.updatedAt = new Date(Date.now() - minutes * 60000).toISOString()
    writeFileSync(chainFile, JSON.stringify(record))
  }
  const summaryOf = world => world.engine.status().find(item => item.chainId === world.chain.chainId)

  const running = fakeWorld({ stallMinutes: 10 })
  running.oldAgent.status = 'running'
  ageRecord(running, 40)
  const stalled = summaryOf(running)
  assert.ok(stalled.stall !== null, 'a running head with an old record must report a stall')
  assert.ok(stalled.stall.minutes >= 39 && stalled.stall.minutes <= 41, `stall minutes follow the record age, got ${JSON.stringify(stalled.stall)}`)
  // The detail and the session tab read the same field.
  assert.ok(running.engine.detail(running.chain.chainId).chain.stall.minutes >= 39, 'detail must carry the stall')
  assert.ok(running.engine.sessionView('session-old').chain.stall.minutes >= 39, 'the session view must carry the stall')
  // Any write to the record is progress.
  running.local.update(running.chain.chainId, () => {})
  assert.equal(summaryOf(running).stall, null, 'a fresh write must clear the stall')

  // A head that is not running never stalls, however old the record.
  const idle = fakeWorld({ stallMinutes: 10 })
  ageRecord(idle, 40)
  assert.equal(summaryOf(idle).stall, null, 'an idle head is never stalled')

  // The threshold decides, not the age alone.
  const tolerant = fakeWorld({ stallMinutes: 120 })
  tolerant.oldAgent.status = 'running'
  ageRecord(tolerant, 40)
  assert.equal(summaryOf(tolerant).stall, null, 'a longer threshold must keep a 40 minute head out of the report')
})

// Two chains can share one workspace. Feature scopes are file-level, so the
// panel and the checkpoint result have to name the other chain and the paths.
check('two chains in one workspace report the paths they share', () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  world.local.appendFeatures(chainId, [{ id: 'F002', title: 'mine', files: ['src/a'] }], 'test fixture')
  const other = world.local.create({ objective: 'other chain', cwd: world.local.cwd, maxHandoffs: 4 })
  world.local.writeFeatures(other.chainId, {
    version: 1,
    objective: 'other chain',
    features: [{ id: 'G001', title: 'theirs', files: ['src/a/deep'] }],
  })
  world.local.update(other.chainId, record => { record.status = 'active' })

  const summary = () => world.engine.status().find(item => item.chainId === chainId)
  const conflicts = summary().conflicts
  assert.equal(conflicts.length, 1, 'the overlap must be reported once per other chain')
  assert.equal(conflicts[0].chainId, other.chainId)
  assert.deepEqual(conflicts[0].paths, ['src/a'], 'the covering path is the one a human has to look at')
  assert.deepEqual(conflicts[0].features, { mine: ['F002'], other: ['G001'] })
  // The other side sees it too, and the checkpoint result carries it.
  assert.equal(world.engine.status().find(item => item.chainId === other.chainId).conflicts[0].chainId, chainId)
  assert.ok(world.engine.detail(chainId).chain.conflicts.length === 1, 'detail must carry the conflict')
  assert.ok(world.engine.checkpoint({ agent: world.oldAgent }).conflicts.length === 1, 'a checkpoint must report it')

  // Passing work stops claiming, and a finished chain is not building anything.
  world.local.writeFeatures(other.chainId, {
    version: 1,
    objective: 'other chain',
    features: [{ id: 'G001', title: 'theirs', files: ['src/a/deep'], passes: true, evidence: 'ran it' }],
  })
  assert.equal(summary().conflicts.length, 0, 'a passing feature no longer claims its paths')
  world.local.writeFeatures(other.chainId, {
    version: 1,
    objective: 'other chain',
    features: [{ id: 'G001', title: 'theirs', files: ['src/a/deep'] }],
  })
  world.local.update(other.chainId, record => { record.status = 'done' })
  assert.equal(summary().conflicts.length, 0, 'a done chain is not building anything')

  // A chain in another workspace is never compared, even with the same scope.
  world.local.update(other.chainId, record => { record.status = 'active' })
  const elsewhere = ChainStore.forCwd(mkdtempSync(join(tmpdir(), 'relay-other-')))
  const remote = elsewhere.create({ objective: 'elsewhere', cwd: elsewhere.cwd, maxHandoffs: 4 })
  elsewhere.writeFeatures(remote.chainId, {
    version: 1,
    objective: 'elsewhere',
    features: [{ id: 'H001', title: 'remote', files: ['src/a'] }],
  })
  elsewhere.update(remote.chainId, record => { record.status = 'active' })
  world.engine.remember(elsewhere.readChain(remote.chainId), elsewhere)
  const after = summary().conflicts
  assert.equal(after.length, 1, 'a chain in another workspace must stay out of the comparison')
  assert.equal(after[0].chainId, other.chainId)
})

// A session that hands a long command to a background job ends its turn: the
// agent is idle while the job keeps working, so `idle` alone reads as "stopped".
check('a head that ended its turn with a live background job is not idle', () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  const summary = () => world.engine.status().find(item => item.chainId === chainId)
  const running = { id: 'pwsh-1', kind: 'pwsh', label: 'full rig', status: 'running', startedAt: Date.now() }
  const jobs = {
    list: caller => (caller === 'session-old'
      ? [running, { id: 'pwsh-0', kind: 'pwsh', label: 'previous', status: 'completed', startedAt: Date.now() - 1000 }]
      // An unowned job is listed for every caller; it must still count once.
      : [{ id: 'pwsh-9', kind: 'pwsh', label: 'unowned tool', status: 'running', startedAt: Date.now() }]),
  }
  const original = world.engine.ctx.get
  world.engine.ctx.get = name => (name === 'jobs' ? jobs : original(name))
  // A job may outlive the session that started it, so every session of the chain counts.
  world.local.update(chainId, record => {
    record.sessions.push({ sessionId: 'session-worker', role: 'worker', index: 1, joinedAt: new Date().toISOString(), parentSessionId: null })
  })
  const reported = summary()
  assert.deepEqual(reported.jobs, { running: 2, labels: ['full rig', 'unowned tool'] }, 'live jobs must be reported once each, with their labels')
  assert.equal(world.engine.detail(chainId).chain.jobs.running, 2, 'detail must carry the jobs')
  assert.equal(world.engine.sessionView('session-old').chain.jobs.running, 2, 'the session view must carry the jobs')
  // A settled record stays listed by the registry, but it is not work in flight.
  world.local.update(chainId, () => {})
  jobs.list = () => [{ id: 'pwsh-1', kind: 'pwsh', label: 'full rig', status: 'completed', startedAt: Date.now() }]
  assert.equal(summary().jobs, null, 'a completed job must not count as running')
  // A Host without the registry is not an error.
  world.local.update(chainId, () => {})
  world.engine.ctx.get = original
  assert.equal(summary().jobs, null, 'a Host without a jobs registry reports none')
})

check('starting a chain clears the negative locate cache', () => {
  const world = fakeWorld()
  const workspaceDir = mkdtempSync(join(tmpdir(), 'relay-later-'))
  const outsider = {
    id: 'session-later',
    session: { id: 'session-later', header: { cwd: workspaceDir } },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    inject() {},
  }
  assert.equal(world.engine.locate(outsider.session), undefined)
  assert.equal(world.engine.misses.has('session-later'), true)
  world.engine.start({ agent: outsider, objective: 'later' })
  assert.equal(world.engine.misses.has('session-later'), false)
  assert.ok(world.engine.locate(outsider.session) !== undefined)
})

check('a compaction before the first evaluation starts from the durable count', () => {
  const world = fakeWorld()
  world.engine.noteCompaction('session-old')
  const restarted = world.rebuild()
  restarted.members.set('session-old', { chainId: world.chain.chainId, truthDir: world.local.truthDir })
  restarted.noteCompaction('session-old')
  assert.equal(world.local.readChain(world.chain.chainId).sessions
    .find(session => session.sessionId === 'session-old').compactions, 2)
})

check('session titles come from the locale file', () => {
  assert.equal(sessionTitle('handoff', { title: 'demo', index: 3 }), 'demo · 接力 3')
  assert.equal(sessionTitle('subtask', { title: 'demo' }), 'demo · 子任务')
})

check('handoff steps are numbered without gaps', () => {
  const base = {
    chain: { chainId: 'chain-x', objective: 'o', cwd: '/w' },
    features: { statusCheck: '', features: [{ id: 'F001', title: 'a', passes: false }] },
    handoff: '<!-- relay:state -->\n- x\n<!-- /relay:state -->',
    handoffNo: 1,
    previousSessionId: 'session-old',
    truthDir: '/w/.relay/chain-x',
  }
  const plain = renderHandoffPrompt(base)
  const plainNumbers = [...plain.matchAll(/^(\d+)\. /gm)].map(match => Number(match[1]))
  assert.deepEqual(plainNumbers, [1, 2, 3, 4])
  const withStatus = renderHandoffPrompt({
    ...base,
    features: { statusCheck: 'npm test', features: base.features.features },
  })
  const statusNumbers = [...withStatus.matchAll(/^(\d+)\. /gm)].map(match => Number(match[1]))
  assert.deepEqual(statusNumbers, [1, 2, 3, 4, 5])
})

check('a cluster handoff names the workers and the verification rule', () => {
  const base = {
    chain: {
      chainId: 'chain-c', objective: 'parallel work', cwd: '/w', mode: 'cluster', blocker: null,
      sessions: [
        { sessionId: 'session-old', parentSessionId: null },
        { sessionId: 'session-w1', parentSessionId: 'session-old' },
        { sessionId: 'session-w2', parentSessionId: 'session-old' },
      ],
    },
    features: {
      statusCheck: '',
      features: [
        { id: 'F001', title: 'one', passes: true, assignedSessionId: 'session-w1', verify: 'true' },
        { id: 'F002', title: 'two', passes: false, assignedSessionId: 'session-w1', verify: 'node two' },
        { id: 'F003', title: 'three', passes: false, assignedSessionId: 'session-w2', verify: 'node three' },
        { id: 'F004', title: 'four', passes: false, verify: 'node four' },
      ],
    },
    handoff: '<!-- relay:state -->\n- x\n<!-- /relay:state -->',
    handoffNo: 1,
    previousSessionId: 'session-old',
    truthDir: join(tmpdir(), 'relay-cluster-prompt'),
  }
  const prompt = renderHandoffPrompt(base)
  assert.match(prompt, /<relay_handoff>/)
  assert.match(prompt, /Cluster rules/)
  assert.ok(prompt.includes('- session-w1:') && prompt.includes('- session-w2:'), 'workers must be listed')
  assert.ok(prompt.includes('F002') && prompt.includes('F003'), 'unfinished worker features must be named')
  assert.match(prompt, /re-run .*verify/i)
  // The single-session relay keeps the old prompt: no worker section.
  const relay = renderHandoffPrompt({ ...base, chain: { ...base.chain, mode: 'relay' } })
  assert.ok(!relay.includes('Cluster rules'))
})

check('a nested truthDir still resolves the workspace cwd', () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-nested-home-'))
  const workspaceDir = mkdtempSync(join(tmpdir(), 'relay-nested-ws-'))
  const store = ChainStore.forCwd(workspaceDir, 'docs/relay')
  const chain = store.create({ objective: 'nested', cwd: workspaceDir })
  const engine = new RelayEngine(
    { logger: { warn: () => {} }, get: () => undefined },
    resolveConfig({ truthDir: 'docs/relay' }),
    { chainIndex: new ChainIndex(home), fingerprints: new ChainFingerprints(home) },
  )
  const normalized = engine.normalizeLocation({ ...chain, cwd: '/wrong', truthDir: '/wrong' }, store)
  assert.equal(normalized.cwd, workspaceDir)
  assert.equal(normalized.truthDir, store.truthDir)
  engine.dispose()
})

check('package metadata exposes the test script and version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // A semver, not one pinned release: the market index records the exact version
  // a build belongs to, and this check must not fail on every bump.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/u)
  assert.match(pkg.scripts.test, /node test\/smoke\.mjs/)
})

// --- goal and plan mode carried across sessions ---

/** One goal view as the Host's goal service reports it. */
function goalView(overrides = {}) {
  return {
    id: 'goal-old',
    revision: 1,
    objective: 'old objective',
    phase: 'active',
    activation: 'armed',
    maxGoalRounds: 10,
    roundsStarted: 3,
    ...overrides,
  }
}

/** Mount a per-session stand-in for the Host's goal service on a fake world. */
function withGoals(world, initial = {}) {
  const views = new Map(Object.entries(initial))
  const log = []
  const original = world.engine.ctx.get
  const service = {
    get: agent => views.get(agent.id),
    create(agent, request) {
      const view = goalView({ id: `goal-for-${agent.id}`, objective: request.objective, maxGoalRounds: request.maxGoalRounds, roundsStarted: 0 })
      views.set(agent.id, view)
      log.push({ op: 'create', agentId: agent.id, objective: request.objective, maxGoalRounds: request.maxGoalRounds })
      return view
    },
    disarm(agent) { views.get(agent.id).activation = 'disarmed'; log.push({ op: 'disarm', agentId: agent.id }) },
    pause(agent, ref) { Object.assign(views.get(agent.id), { phase: 'paused' }); log.push({ op: 'pause', agentId: agent.id, ...ref }) },
    resume(agent, ref) { Object.assign(views.get(agent.id), { phase: 'active', activation: 'armed' }); log.push({ op: 'resume', agentId: agent.id, ...ref }) },
    complete(agent, ref) { Object.assign(views.get(agent.id), { phase: 'complete' }); log.push({ op: 'complete', agentId: agent.id, ...ref }) },
  }
  world.engine.ctx.get = name => (name === 'goals' ? service : original(name))
  return { views, log, ops: op => log.filter(entry => entry.op === op) }
}

/** Mount a stand-in for the Host's plan mode service on a fake world. */
function withPlanMode(world, initial = {}) {
  const states = new Map(Object.entries(initial))
  const sets = []
  const original = world.engine.ctx.get
  world.engine.ctx.get = name => (name === 'planMode'
    ? {
      get: agent => states.get(agent.id) ?? { active: false },
      set: (agent, active) => { states.set(agent.id, { active }); sets.push({ sessionId: agent.id, active }); return 'committed' },
    }
    : original(name))
  return { states, sets }
}

/** Audit records of one kind. */
function auditOf(world, kind) {
  return world.engine.audit(world.chain.chainId, 200).filter(entry => entry.kind === kind)
}

/** Record a goal id on the chain's current session, as a handoff does for a goal it created. */
function markGoal(world, goalId) {
  world.local.update(world.chain.chainId, record => {
    record.sessions.find(session => session.sessionId === 'session-old').goalId = goalId
  })
}

await checkAsync('a wrap-up holds an armed active goal and leaves any other goal alone', async () => {
  const armed = fakeWorld()
  const held = withGoals(armed, { 'session-old': goalView() })
  armed.setRatio(0.7)
  await armed.engine.evaluate(armed.oldAgent)
  assert.deepEqual(held.ops('disarm'), [{ op: 'disarm', agentId: 'session-old' }])
  assert.equal(held.views.get('session-old').phase, 'active', 'only the continuation is removed')
  assert.deepEqual(auditOf(armed, 'goal.held')[0].detail, { sessionId: 'session-old', goalId: 'goal-old', why: 'wrapup' })

  const idle = fakeWorld()
  const untouched = withGoals(idle, { 'session-old': goalView({ activation: 'disarmed' }) })
  idle.setRatio(0.7)
  await idle.engine.evaluate(idle.oldAgent)
  assert.equal(idle.calls.filter(call => /<relay_wrapup>/.test(call.text ?? '')).length, 1)
  assert.equal(untouched.ops('disarm').length, 0)
  const paused = fakeWorld()
  const pausedGoals = withGoals(paused, { 'session-old': goalView({ phase: 'paused' }) })
  paused.setRatio(0.7)
  await paused.engine.evaluate(paused.oldAgent)
  assert.equal(pausedGoals.ops('disarm').length, 0)
  assert.equal(auditOf(paused, 'goal.held').length, 0)
})

await checkAsync('a handoff carries the goal with its remaining rounds to the successor', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  await handOffOnce(world)
  assert.deepEqual(goals.ops('create'), [{ op: 'create', agentId: 'session-new', objective: 'old objective', maxGoalRounds: 7 }])
  const entry = world.local.readChain(world.chain.chainId).sessions.find(session => session.sessionId === 'session-new')
  assert.equal(entry.goalId, 'goal-for-session-new')
  assert.deepEqual(auditOf(world, 'goal.inherited')[0].detail, { goalId: 'goal-for-session-new', from: 'goal-old', rounds: 7 })
  assert.equal(goals.views.get('session-old').activation, 'disarmed', 'the retiring goal must not run another round')
})

await checkAsync('a goal with no rounds left is not inherited and is not replaced by a seeded one', async () => {
  const world = fakeWorld({ seedGoalOnHandoff: true })
  const goals = withGoals(world, { 'session-old': goalView({ roundsStarted: 10 }) })
  await handOffOnce(world)
  assert.equal(goals.ops('create').length, 0)
  assert.deepEqual(auditOf(world, 'goal.inherit-skipped')[0].detail, { from: 'goal-old', reason: 'no rounds left' })
  const entry = world.local.readChain(world.chain.chainId).sessions.find(session => session.sessionId === 'session-new')
  assert.equal(entry.goalId, undefined)
})

await checkAsync('inheritGoal=false inherits nothing and keeps the seeding behaviour', async () => {
  const off = fakeWorld({ inheritGoal: false })
  const offGoals = withGoals(off, { 'session-old': goalView() })
  await handOffOnce(off)
  assert.equal(offGoals.ops('create').length, 0)
  assert.equal(auditOf(off, 'goal.inherited').length, 0)

  const seeded = fakeWorld({ inheritGoal: false, seedGoalOnHandoff: true })
  const seededGoals = withGoals(seeded, { 'session-old': goalView() })
  await handOffOnce(seeded)
  const created = seededGoals.ops('create')
  assert.equal(created.length, 1)
  assert.match(created[0].objective, /engine objective — relay chain/)
  assert.equal(created[0].maxGoalRounds, 16)
  assert.equal(auditOf(seeded, 'goal.seeded').length, 1)
  const entry = seeded.local.readChain(seeded.chain.chainId).sessions.find(session => session.sessionId === 'session-new')
  assert.equal(entry.goalId, 'goal-for-session-new')
})

check('auto-continue stands aside only for an armed goal', () => {
  const run = activation => {
    const world = fakeWorld({ autoContinue: true })
    withGoals(world, { 'session-old': goalView({ activation }) })
    const chain = world.local.readChain(world.chain.chainId)
    world.engine.maybeAutoContinue(chain, world.local, world.oldAgent, world.engine.statsFor('session-old'))
    return world.calls.filter(call => /<relay_continue>/.test(call.text ?? '')).length
  }
  assert.equal(run('disarmed'), 1, 'a disarmed goal does not drive the session')
  assert.equal(run('armed'), 0, 'an armed goal is already driving the session')
})

await checkAsync('a plugin-created goal is re-armed after a reload and nothing else is', async () => {
  const setup = (view, entryGoalId, chainPatch) => {
    const world = fakeWorld()
    const goals = withGoals(world, { 'session-old': view })
    if (entryGoalId !== undefined) markGoal(world, entryGoalId)
    if (chainPatch !== undefined) world.local.update(world.chain.chainId, chainPatch)
    const chain = world.local.readChain(world.chain.chainId)
    world.engine.rearmGoal(chain, world.local, world.oldAgent, chain.sessions[0])
    return { world, goals }
  }
  const rearmed = setup(goalView({ activation: 'disarmed' }), 'goal-old')
  assert.deepEqual(rearmed.goals.ops('resume'), [{ op: 'resume', agentId: 'session-old', id: 'goal-old', revision: 1 }])
  assert.deepEqual(auditOf(rearmed.world, 'goal.rearmed')[0].detail, { sessionId: 'session-old', goalId: 'goal-old' })
  assert.equal(setup(goalView({ activation: 'disarmed' }), 'goal-someone-else').goals.ops('resume').length, 0, 'a user goal is left alone')
  assert.equal(setup(goalView({ activation: 'disarmed' }), undefined).goals.ops('resume').length, 0, 'no recorded goal id')
  assert.equal(
    setup(goalView({ activation: 'disarmed' }), 'goal-old', record => { record.wrapupAt = new Date().toISOString() }).goals.ops('resume').length,
    0,
    'no re-arm during a wrap-up',
  )
  assert.equal(setup(goalView({ activation: 'disarmed', roundsStarted: 10 }), 'goal-old').goals.ops('resume').length, 0, 'no rounds left')
  assert.equal(setup(goalView({ activation: 'armed' }), 'goal-old').goals.ops('resume').length, 0, 'already armed')
})

await checkAsync('evaluating the chain head re-arms its plugin-created goal', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView({ activation: 'disarmed' }) })
  markGoal(world, 'goal-old')
  world.setRatio(0.3)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(goals.ops('resume').length, 1)
})

await checkAsync('finish completes the goal the plugin created', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  markGoal(world, 'goal-old')
  world.local.patchFeatures(world.chain.chainId, [{ id: 'F001', passes: true, evidence: 'npm test -> exit 0, 3/3 passed' }])
  const result = world.engine.finish({ agent: world.oldAgent, evidence: 'done' })
  assert.equal(result.ok, true)
  assert.deepEqual(goals.ops('complete'), [{ op: 'complete', agentId: 'session-old', id: 'goal-old', revision: 1 }])
  assert.deepEqual(auditOf(world, 'goal.completed')[0].detail, { sessionId: 'session-old', goalId: 'goal-old' })

  const foreign = fakeWorld()
  const foreignGoals = withGoals(foreign, { 'session-old': goalView() })
  foreign.local.patchFeatures(foreign.chain.chainId, [{ id: 'F001', passes: true, evidence: 'npm test -> exit 0, 3/3 passed' }])
  assert.equal(foreign.engine.finish({ agent: foreign.oldAgent, evidence: 'done' }).ok, true)
  assert.equal(foreignGoals.ops('complete').length, 0, 'a goal the user created is not completed')
})

await checkAsync('a Host pause pauses the goal and a resume restores it', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  const chainId = world.chain.chainId
  world.engine.setPaused({ chainId, paused: true })
  assert.equal(goals.ops('pause').length, 1)
  assert.deepEqual(world.local.readChain(chainId).goalPausedByRelay, { sessionId: 'session-old', goalId: 'goal-old' })
  assert.equal(auditOf(world, 'goal.paused').length, 1)
  world.engine.setPaused({ chainId, paused: false })
  assert.equal(goals.ops('resume').length, 1)
  assert.equal(goals.views.get('session-old').phase, 'active')
  assert.equal(world.local.readChain(chainId).goalPausedByRelay, null)
  assert.equal(auditOf(world, 'goal.resumed').length, 1)
  world.engine.dispose()
})

await checkAsync('a pause the session asks for leaves its goal alone, and a resume does not touch a goal the user paused', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  const chainId = world.chain.chainId
  world.engine.setPaused({ agent: world.oldAgent, chainId, paused: true })
  assert.equal(goals.ops('pause').length, 0)
  assert.equal(world.local.readChain(chainId).goalPausedByRelay ?? null, null)
  goals.views.get('session-old').phase = 'paused'
  world.engine.setPaused({ agent: world.oldAgent, chainId, paused: false })
  assert.equal(goals.ops('resume').length, 0, 'the plugin did not pause this goal')
  world.engine.dispose()
})

await checkAsync('the retired session ends with a paused goal even though the handoff disarmed it first', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  await handOffOnce(world)
  assert.equal(goals.ops('pause').filter(entry => entry.agentId === 'session-old').length, 1, 'the retired goal stayed active')
  assert.equal(goals.views.get('session-old').phase, 'paused')
})

await checkAsync('resuming a chain that was wrapping up does not hand the goal rounds back', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  const chainId = world.chain.chainId
  world.local.update(chainId, record => { record.wrapupAt = new Date().toISOString() })
  world.engine.setPaused({ chainId, paused: true })
  world.engine.setPaused({ chainId, paused: false })
  assert.equal(goals.ops('resume').length, 1)
  assert.equal(goals.views.get('session-old').phase, 'active')
  assert.equal(goals.views.get('session-old').activation, 'disarmed', 'a session waiting for its handoff got its goal rounds back')
  world.engine.dispose()
})

await checkAsync('a goal is not re-armed while a handoff of its chain is in flight', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView({ activation: 'disarmed' }) })
  markGoal(world, 'goal-old')
  const chain = world.local.readChain(world.chain.chainId)
  world.engine.busyChains.add(chain.chainId)
  world.engine.rearmGoal(chain, world.local, world.oldAgent, chain.sessions[0])
  assert.equal(goals.ops('resume').length, 0, 'the goal was re-armed in the middle of a handoff')
  world.engine.busyChains.delete(chain.chainId)
  // A reload is what forgets that this session was already checked.
  world.engine.stats.delete('session-old')
  world.engine.rearmGoal(chain, world.local, world.oldAgent, chain.sessions[0])
  assert.equal(goals.ops('resume').length, 1)
})

await checkAsync('a goal the user disarmed after the handoff is not re-armed on a later idle', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  await handOffOnce(world)
  assert.equal(goals.views.get('session-new').activation, 'armed')
  goals.views.get('session-new').activation = 'disarmed'
  world.setRatio(0.3)
  await world.engine.evaluate(world.newAgent)
  assert.equal(goals.views.get('session-new').activation, 'disarmed', 'a goal disarmed on purpose was re-armed')
  assert.equal(auditOf(world, 'goal.rearmed').length, 0)
})

/** Hand the chain head off a second time, to a third session. */
async function handOffAgain(world) {
  const third = {
    id: 'session-third',
    session: { id: 'session-third', header: world.newAgent.session.header, events: [] },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    inject() {},
  }
  world.engine.ctx.get('sessionController').create = async () => ({ sessionId: 'session-third' })
  const agents = world.engine.ctx.get('agents')
  const original = agents.get
  agents.get = id => (id === 'session-third' ? third : original(id))
  world.setRatio(0.7)
  await world.engine.evaluate(world.newAgent)
  world.engine.statsFor('session-new').ready = true
  await world.engine.evaluate(world.newAgent)
  return third
}

await checkAsync('a goal the plugin seeded is not inherited; each handoff seeds a fresh one', async () => {
  const world = fakeWorld({ seedGoalOnHandoff: true, inheritGoal: true })
  const goals = withGoals(world, { 'session-old': goalView({ phase: 'complete' }) })
  await handOffOnce(world)
  assert.equal(auditOf(world, 'goal.seeded').length, 1)
  goals.views.get('session-new').roundsStarted = 5
  await handOffAgain(world)
  assert.equal(world.local.readChain(world.chain.chainId).currentSessionId, 'session-third')
  assert.equal(goals.views.get('session-third').maxGoalRounds, world.engine.config.goalRoundsPerHandoff)
  assert.equal(auditOf(world, 'goal.seeded').length, 2)
  assert.equal(auditOf(world, 'goal.inherited').length, 0, 'a seeded goal was inherited')
})

await checkAsync('a user goal with no rounds left is not replaced and the chain waits for a human', async () => {
  const world = fakeWorld({ seedGoalOnHandoff: true })
  const goals = withGoals(world, { 'session-old': goalView({ roundsStarted: 10 }) })
  await handOffOnce(world)
  assert.equal(goals.ops('create').length, 0)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.blocker?.kind, 'external', 'nothing tells the human the goal ran out')
  assert.match(chain.blocker.action, /ran out of rounds/)
  assert.equal(chain.status, 'paused')
  assert.equal(chain.pausedBy, 'blocker')
})

await checkAsync('a blocked user goal is not replaced by a seeded one', async () => {
  const world = fakeWorld({ seedGoalOnHandoff: true, pauseOnExternalBlocker: false })
  const goals = withGoals(world, { 'session-old': goalView({ phase: 'blocked' }) })
  await handOffOnce(world)
  assert.equal(world.local.readChain(world.chain.chainId).currentSessionId, 'session-new')
  assert.equal(goals.ops('create').length, 0, 'a goal was created over a blocked user goal')
})

await checkAsync('a session loaded again gets one more goal re-arm attempt', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  await handOffOnce(world)
  goals.views.get('session-new').activation = 'disarmed'
  world.engine.sessionLoaded('session-new')
  world.setRatio(0.3)
  await world.engine.evaluate(world.newAgent)
  assert.equal(goals.views.get('session-new').activation, 'armed', 'the reopened session kept its disarmed goal')
  assert.equal(auditOf(world, 'goal.rearmed').length, 1)
})

await checkAsync('with autoHandoff off a ready report without a wrap-up does not hand off', async () => {
  const world = fakeWorld({ autoHandoff: false })
  const chainId = world.chain.chainId
  assert.notEqual(world.engine.checkpoint({ agent: world.oldAgent, ready: true }).ok, false)
  world.setRatio(0.7)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.local.readChain(chainId).handoffCount, 0, 'a ready report re-enabled the automatic handoff')
  assert.equal(world.calls.filter(call => /<relay_wrapup>/.test(call.text ?? '')).length, 0)
  world.engine.dispose()
})

await checkAsync('a user goal blocked at the handoff leaves a blocker that survives the next evaluation', async () => {
  const world = fakeWorld({ seedGoalOnHandoff: true, pauseOnExternalBlocker: false })
  withGoals(world, { 'session-old': goalView({ phase: 'blocked' }) })
  await handOffOnce(world)
  const blocker = world.local.readChain(world.chain.chainId).blocker
  assert.equal(blocker?.kind, 'external', 'nothing tells the human the goal was blocked')
  assert.match(blocker.action, /was blocked/)
  world.setRatio(0.3)
  await world.engine.evaluate(world.newAgent)
  assert.match(world.local.readChain(world.chain.chainId).blocker?.action ?? '', /was blocked/, 'the next evaluation cleared the blocker')
})

await checkAsync('a failing blocker write cannot fail a finished handoff', async () => {
  const world = fakeWorld({ seedGoalOnHandoff: true })
  withGoals(world, { 'session-old': goalView({ roundsStarted: 10 }) })
  const original = world.local.writeProgress.bind(world.local)
  world.local.writeProgress = (chainId, text) => {
    if (text.includes('blocked (external')) throw new Error('progress write failed')
    return original(chainId, text)
  }
  await handOffOnce(world)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.currentSessionId, 'session-new')
  assert.notEqual(chain.pausedBy, 'handoff-failed')
  assert.equal(auditOf(world, 'handoff.completed').length, 1)
})

await checkAsync('handoffNow on a paused chain says it is paused', async () => {
  const stale = '# HANDOFF\n\nnothing yet\n'
  const paused = fakeWorld()
  paused.local.writeHandoff(paused.chain.chainId, stale)
  paused.engine.setPaused({ chainId: paused.chain.chainId, paused: true })
  const pausedResult = await paused.engine.handoffNow({ chainId: paused.chain.chainId })
  assert.equal(pausedResult.code, 'handoff_not_ready')
  assert.match(pausedResult.message, /The chain is paused, so hand off again once the session is idle/)
  const active = fakeWorld()
  active.local.writeHandoff(active.chain.chainId, stale)
  const activeResult = await active.engine.handoffNow({ chainId: active.chain.chainId })
  assert.match(activeResult.message, /the handoff follows when it reports ready/)
  assert.doesNotMatch(activeResult.message, /paused/)
  paused.engine.dispose()
  active.engine.dispose()
})

await checkAsync('a seeded goal recorded by 1.3.0 without the flag is still told apart by the audit', async () => {
  const world = fakeWorld({ seedGoalOnHandoff: true, inheritGoal: true })
  const goals = withGoals(world, { 'session-old': goalView({ phase: 'complete' }) })
  await handOffOnce(world)
  assert.equal(auditOf(world, 'goal.seeded').length, 1)
  world.local.update(world.chain.chainId, record => {
    delete record.sessions.find(session => session.sessionId === 'session-new').goalSeeded
  })
  goals.views.get('session-new').roundsStarted = 5
  await handOffAgain(world)
  assert.equal(goals.views.get('session-third').maxGoalRounds, world.engine.config.goalRoundsPerHandoff)
  assert.equal(auditOf(world, 'goal.inherited').length, 0, 'a seeded goal was inherited')
})

await checkAsync('a finished chain cannot be paused or resumed', async () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  world.local.patchFeatures(chainId, [{ id: 'F001', passes: true, evidence: 'npm test -> exit 0, 3/3 passed' }])
  assert.equal(world.engine.finish({ agent: world.oldAgent, evidence: 'done', chainId }).ok, true)
  assert.throws(
    () => world.engine.setPaused({ chainId, paused: true }),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid && /cannot be paused or resumed/.test(error.message),
  )
  assert.equal(world.local.readChain(chainId).status, 'done')
})

await checkAsync('a panel pause then a manual handoff still carries the user goal', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  const chainId = world.chain.chainId
  world.engine.setPaused({ chainId, paused: true })
  assert.equal(goals.views.get('session-old').phase, 'paused')
  const result = await world.engine.handoffNow({ chainId })
  assert.equal(result.newSessionId, 'session-new')
  assert.deepEqual(goals.ops('create'), [{ op: 'create', agentId: 'session-new', objective: 'old objective', maxGoalRounds: 7 }])
  assert.equal(world.local.readChain(chainId).goalPausedByRelay ?? null, null)
  world.engine.dispose()
})

await checkAsync('the pause marker waits for the session when the head is not loaded', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  const chainId = world.chain.chainId
  world.engine.setPaused({ chainId, paused: true })
  const agents = world.engine.ctx.get('agents')
  const original = agents.get
  agents.get = () => undefined
  world.engine.setPaused({ chainId, paused: false })
  assert.deepEqual(world.local.readChain(chainId).goalPausedByRelay, { sessionId: 'session-old', goalId: 'goal-old' })
  agents.get = original
  world.setRatio(0.3)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(goals.views.get('session-old').phase, 'active')
  assert.equal(world.local.readChain(chainId).goalPausedByRelay, null)
  assert.equal(auditOf(world, 'goal.resumed').length, 1)
  world.engine.dispose()
})

await checkAsync('a handoff that fails without a wrap-up gives the goal rounds back', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  world.engine.ctx.get('sessionController').prompt = async () => { throw new Error('flush failed') }
  await assert.rejects(() => world.engine.handoffNow({ chainId: world.chain.chainId }))
  assert.equal(auditOf(world, 'goal.held').length, 1)
  assert.equal(goals.views.get('session-old').activation, 'armed', 'the goal stayed disarmed after the failed handoff')
  assert.deepEqual(auditOf(world, 'goal.released')[0].detail, { sessionId: 'session-old', goalId: 'goal-old', why: 'handoff-failed' })
})

await checkAsync('a handoff that fails after a wrap-up keeps the goal held', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  world.local.update(world.chain.chainId, record => { record.wrapupAt = new Date().toISOString() })
  world.engine.ctx.get('sessionController').prompt = async () => { throw new Error('flush failed') }
  await assert.rejects(() => world.engine.handoffNow({ chainId: world.chain.chainId }))
  assert.equal(goals.views.get('session-old').activation, 'disarmed')
  assert.equal(auditOf(world, 'goal.released').length, 0)
})

await checkAsync('a handoff that fails after the successor took over does not restart the retired session', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  world.engine.remember = () => { throw new Error('index write failed') }
  await assert.rejects(() => world.engine.handoffNow({ chainId: world.chain.chainId }))
  assert.equal(world.local.readChain(world.chain.chainId).currentSessionId, 'session-new')
  assert.equal(goals.views.get('session-old').activation, 'disarmed', 'the retired session got its goal rounds back')
  assert.equal(auditOf(world, 'goal.released').length, 0)
})

await checkAsync('with autoHandoff off a manual wrap-up still ends in its handoff', async () => {
  const world = fakeWorld({ autoHandoff: false })
  const chainId = world.chain.chainId
  world.local.writeHandoff(chainId, '# HANDOFF\n\nnothing yet\n')
  const refused = await world.engine.handoffNow({ chainId })
  assert.equal(refused.code, 'handoff_not_ready')
  assert.match(refused.message, /the handoff follows when it reports ready/)
  world.local.writeHandoff(chainId, '# HANDOFF\n\n<!-- relay:state -->\n- step: F001 done\n<!-- /relay:state -->\n')
  assert.notEqual(world.engine.checkpoint({ agent: world.oldAgent, ready: true }).ok, false)
  await world.engine.evaluate(world.oldAgent)
  assert.equal(world.local.readChain(chainId).handoffCount, 1, 'the wrap-up never reached its handoff')
  world.engine.dispose()
})

await checkAsync('a custom session falls back to the recorded preset only for the plugin approval override', async () => {
  const run = (recorded, overrides) => {
    const world = fakeWorld(overrides)
    const presets = withPresets(world, { 'session-old': 'custom' })
    world.local.update(world.chain.chainId, record => {
      record.sessions.find(session => session.sessionId === 'session-old').permissionPreset = recorded
    })
    const chain = world.local.readChain(world.chain.chainId)
    const third = { id: 'session-third', session: { id: 'session-third' } }
    return { carried: world.engine.inheritPermission(chain, world.local, world.oldAgent, third), presets }
  }
  const inherit = run('read-only', { workerApproval: 'inherit' })
  assert.equal(inherit.carried, undefined, 'the user custom combination was undone under workerApproval=inherit')
  assert.deepEqual(inherit.presets.switches, [])
  const same = run('danger-full-access', { workerApproval: 'never' })
  assert.equal(same.carried, undefined, 'the override changes nothing for this preset, so custom is the user choice')
  assert.deepEqual(same.presets.switches, [])
  const overridden = run('workspace-write', { workerApproval: 'never' })
  assert.equal(overridden.carried, 'workspace-write')
})

await checkAsync('plan mode is carried to the successor on handoff', async () => {
  const world = fakeWorld()
  const plan = withPlanMode(world, { 'session-old': { active: false, pending: true } })
  await handOffOnce(world)
  assert.deepEqual(plan.sets, [{ sessionId: 'session-new', active: true }])
  assert.deepEqual(auditOf(world, 'plan.inherited')[0].detail, { sessionId: 'session-new', from: 'session-old' })

  const outside = fakeWorld()
  const outsidePlan = withPlanMode(outside, { 'session-old': { active: false } })
  await handOffOnce(outside)
  assert.equal(outsidePlan.sets.length, 0, 'the source is not in plan mode')

  const off = fakeWorld({ inheritPlanMode: false })
  const offPlan = withPlanMode(off, { 'session-old': { active: true } })
  await handOffOnce(off)
  assert.equal(offPlan.sets.length, 0, 'inheritPlanMode is off')
})

await checkAsync('plan mode is carried to a spawned child', async () => {
  const world = spawnWorld()
  const plan = withPlanMode(world, { 'session-parent': { active: true } })
  await world.engine.spawn({ agent: world.parent, features: ['F002'] })
  assert.deepEqual(plan.sets, [{ sessionId: 'session-child', active: true }])

  const quiet = spawnWorld()
  const quietPlan = withPlanMode(quiet, { 'session-parent': { active: false } })
  await quiet.engine.spawn({ agent: quiet.parent, features: ['F002'] })
  assert.equal(quietPlan.sets.length, 0)
})

/** A session in a fresh workspace that belongs to no chain yet. */
function outsiderIn(world, id) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-plan-'))
  const agent = {
    id,
    session: { id, header: { cwd: dir } },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    inject() {},
  }
  return { agent, dir }
}

check('relay_start is refused in plan mode and writes nothing', () => {
  const world = fakeWorld()
  withPlanMode(world, { 'session-planner': { active: false, pending: true } })
  const { agent, dir } = outsiderIn(world, 'session-planner')
  assert.throws(
    () => world.engine.start({ agent, objective: 'planned work' }),
    error => error instanceof RelayError && error.code === RELAY_CODES.invalid && /plan mode is active/.test(error.message),
  )
  assert.equal(existsSync(join(dir, '.relay')), false, 'nothing may be written before the plan is approved')
})

check('start writes PLAN.md, doc reads it and recall searches it', () => {
  const world = fakeWorld()
  withPlanMode(world, { 'session-planner': { active: false } })
  const { agent } = outsiderIn(world, 'session-planner')
  const started = world.engine.start({ agent, objective: 'planned work' })
  const store = world.engine.storeFor(world.engine.members.get('session-planner').truthDir)
  const planFile = store.paths(started.chainId).plan
  assert.match(readFileSync(planFile, 'utf8'), /^# PLAN/)
  assert.match(world.engine.doc(started.chainId, 'plan').text, /^# PLAN/)
  writeFileSync(planFile, '# PLAN\n\nmigrate the zebrafish table first\n')
  const found = world.engine.recall({ agent, query: 'zebrafish' })
  assert.deepEqual(found.matches.map(match => match.file), ['PLAN.md'])
})

check('detail reports the head goal, plan mode, and a held goal only during a wrap-up', () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView({ activation: 'disarmed' }) })
  const plan = withPlanMode(world, { 'session-old': { active: false } })
  const chainId = world.chain.chainId
  const before = world.engine.detail(chainId).head
  assert.deepEqual(before.goal, {
    phase: 'active',
    activation: 'disarmed',
    roundsStarted: 3,
    maxGoalRounds: 10,
    blockedCode: null,
    blockedMessage: null,
  })
  assert.equal(before.planMode, false)
  assert.equal(before.goalHeld, false, 'a disarmed goal outside a wrap-up is not held by the plugin')
  assert.equal(before.goalPausedByRelay, false)
  plan.states.set('session-old', { active: false, pending: true })
  assert.equal(world.engine.detail(chainId).head.planMode, true)
  world.local.update(chainId, record => { record.wrapupAt = new Date().toISOString() })
  assert.equal(world.engine.detail(chainId).head.goalHeld, true)
  world.local.update(chainId, record => { record.wrapupAt = null; record.readyAt = new Date().toISOString() })
  assert.equal(world.engine.detail(chainId).head.goalHeld, true, 'a ready session is waiting for its handoff too')
  goals.views.get('session-old').activation = 'armed'
  assert.equal(world.engine.detail(chainId).head.goalHeld, false, 'an armed goal is not held')
  goals.views.get('session-old').activation = 'disarmed'
  goals.views.get('session-old').phase = 'paused'
  assert.equal(world.engine.detail(chainId).head.goalHeld, false, 'only an active goal counts as held')
})

check('status carries the head and notices a Host pause of the goal', () => {
  const world = fakeWorld()
  withGoals(world, { 'session-old': goalView() })
  const chainId = world.chain.chainId
  const first = world.engine.status()[0]
  assert.ok(first.head !== undefined, 'status items need a head')
  assert.equal(first.head.goal.roundsStarted, 3)
  assert.equal(first.head.goalPausedByRelay, false)
  world.engine.setPaused({ chainId, paused: true })
  assert.equal(world.engine.status()[0].head.goalPausedByRelay, true)
  world.engine.setPaused({ chainId, paused: false })
  assert.equal(world.engine.status()[0].head.goalPausedByRelay, false)
  world.engine.dispose()
})

await checkAsync('sessionView carries the head and each session plan mode', async () => {
  const world = spawnWorld()
  const states = new Map([['session-parent', { active: true }], ['session-child', { active: false }]])
  const original = world.engine.ctx.get
  world.engine.ctx.get = name => (name === 'planMode' ? { get: agent => states.get(agent.id) } : original(name))
  await world.engine.spawn({ agent: world.parent, features: ['F002'] })
  const parentView = world.engine.sessionView('session-parent')
  assert.equal(parentView.head.planMode, true)
  assert.equal(parentView.self.planMode, true)
  assert.equal(parentView.children[0].planMode, false)
  states.set('session-child', { pending: true })
  const childView = world.engine.sessionView('session-child')
  assert.equal(childView.self.planMode, true)
  assert.equal(childView.parent.planMode, true)
  assert.equal(parentView.head.goal, null, 'no goal service view: no goal')
  assert.equal(world.engine.sessionView('session-parent').children[0].planMode, true)
})

check('headState survives a chain whose current session is not loaded', () => {
  const world = fakeWorld()
  withGoals(world, { 'session-old': goalView() })
  withPlanMode(world, { 'session-old': { active: true } })
  world.local.update(world.chain.chainId, record => { record.currentSessionId = 'session-gone' })
  const chain = world.local.readChain(world.chain.chainId)
  assert.deepEqual(world.engine.headState(chain), { goal: null, planMode: false, goalHeld: false, goalPausedByRelay: false })
  assert.equal(world.engine.detail(world.chain.chainId).head.planMode, false)
})

// --- the /relay command ---

const commandInvocation = (agent, rawInput) => ({
  agent,
  rawInput,
  attachments: [],
  signal: new AbortController().signal,
})

await checkAsync('/relay status lists the chain this session belongs to', async () => {
  const world = fakeWorld()
  const result = await handleRelayCommand(world.engine, commandInvocation(world.oldAgent, ''))
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes(world.chain.chainId), 'status did not name the chain')
  assert.match(result.text, /features/)
})

await checkAsync('/relay start begins a chain for a session without one', async () => {
  const world = fakeWorld()
  const workspaceDir = mkdtempSync(join(tmpdir(), 'relay-command-'))
  const outsider = {
    id: 'session-command',
    session: { id: 'session-command', header: { cwd: workspaceDir } },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    inject() {},
  }
  const result = await handleRelayCommand(world.engine, commandInvocation(outsider, 'start ship the command'))
  assert.equal(result.kind, 'success')
  assert.ok(world.engine.locate(outsider.session) !== undefined, 'start did not register the chain')
})

await checkAsync('/relay pause and resume toggle the chain', async () => {
  const world = fakeWorld()
  const paused = await handleRelayCommand(world.engine, commandInvocation(world.oldAgent, 'pause'))
  assert.equal(paused.kind, 'success')
  assert.equal(world.local.readChain(world.chain.chainId).status, 'paused')
  const resumed = await handleRelayCommand(world.engine, commandInvocation(world.oldAgent, 'resume'))
  assert.equal(resumed.kind, 'success')
  assert.equal(world.local.readChain(world.chain.chainId).status, 'active')
})

await checkAsync('/relay rejects an unknown sub-command', async () => {
  const world = fakeWorld()
  const result = await handleRelayCommand(world.engine, commandInvocation(world.oldAgent, 'explode'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Unknown sub-command/)
})

await checkAsync('/relay handoff swaps the chain head', async () => {
  const world = fakeWorld()
  const result = await handleRelayCommand(world.engine, commandInvocation(world.oldAgent, 'handoff'))
  assert.equal(result.kind, 'success')
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.currentSessionId, 'session-new')
})

await checkAsync('/relay start begins a new chain from a session whose chain is done', async () => {
  const world = fakeWorld()
  const chainId = world.chain.chainId
  world.local.patchFeatures(chainId, [{ id: 'F001', passes: true, evidence: 'npm test -> exit 0, 3/3 passed' }])
  assert.equal(world.engine.finish({ agent: world.oldAgent, evidence: 'done', chainId }).ok, true)
  const result = await handleRelayCommand(world.engine, commandInvocation(world.oldAgent, 'start the next objective'))
  assert.equal(result.kind, 'success', result.text)
  assert.notEqual(world.engine.locate(world.oldAgent.session).chain.chainId, chainId)
})

await checkAsync('/relay pause acts as the human: the goal pauses and the audit actor is the host', async () => {
  const world = fakeWorld()
  const goals = withGoals(world, { 'session-old': goalView() })
  const result = await handleRelayCommand(world.engine, commandInvocation(world.oldAgent, 'pause'))
  assert.equal(result.kind, 'success')
  assert.equal(goals.views.get('session-old').phase, 'paused')
  assert.equal(auditOf(world, 'chain.paused')[0].actor, 'host')
  world.engine.dispose()
})

// --- cluster mode: host half ---

check('cluster config: maxClusterSessions and clusterGoals defaults and validation', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.maxClusterSessions, 4)
  assert.equal(defaults.clusterGoals, true)
  assert.equal(resolveConfig({ maxClusterSessions: 12 }).maxClusterSessions, 12)
  assert.equal(resolveConfig({ clusterGoals: false }).clusterGoals, false)
  assert.throws(() => resolveConfig({ maxClusterSessions: 0 }), /maxClusterSessions must be an integer from 1 to 12/)
  assert.throws(() => resolveConfig({ maxClusterSessions: 13 }), /maxClusterSessions must be an integer from 1 to 12/)
  assert.throws(() => resolveConfig({ maxClusterSessions: 2.5 }), /maxClusterSessions/)
  assert.throws(() => resolveConfig({ clusterGoals: 'yes' }), /clusterGoals must be a boolean/)
})

check('store: files and dependsOn survive write, read and appendFeatures; malformed ones are dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cluster-store-'))
  const local = ChainStore.forCwd(dir)
  const chain = local.create({ objective: 'scope', cwd: dir })
  local.writeFeatures(chain.chainId, {
    version: 1,
    objective: 'scope',
    features: [
      { id: 'F001', title: 'one', files: ['src/a', 'lib/b.js'], dependsOn: ['F002'] },
      { id: 'F002', title: 'two' },
      { id: 'F003', title: 'three', files: 'src/a', dependsOn: ['F001', ''] },
      { id: 'F004', title: 'four', files: ['ok', 3], dependsOn: [] },
    ],
  })
  const read = local.readFeatures(chain.chainId).features
  assert.deepEqual(read[0].files, ['src/a', 'lib/b.js'])
  assert.deepEqual(read[0].dependsOn, ['F002'])
  assert.equal('files' in read[1], false, 'an absent field must stay absent')
  assert.equal('dependsOn' in read[1], false)
  assert.deepEqual(read[2].files, ['src/a'], 'a single string becomes a one-item list')
  assert.deepEqual(read[2].dependsOn, ['F001'], 'an empty string inside an array is dropped')
  assert.deepEqual(read[3].files, ['ok'], 'a non-string inside an array is dropped')
  assert.equal('dependsOn' in read[3], false, 'an empty array leaves nothing usable, so no field')
  local.appendFeatures(chain.chainId, [{ id: 'F005', title: 'five', files: ['docs'], dependsOn: ['F001'] }, { id: 'F006', title: 'six', files: [''] }], 'found later')
  const appended = local.readFeatures(chain.chainId).features
  assert.deepEqual(appended[4].files, ['docs'])
  assert.deepEqual(appended[4].dependsOn, ['F001'])
  assert.equal('files' in appended[5], false)
  // The frozen fingerprint hashes only id and title.
  const home = mkdtempSync(join(tmpdir(), 'relay-cluster-fp-'))
  const prints = new ChainFingerprints(home)
  prints.set(chain.chainId, appended)
  assert.deepEqual(prints.get(chain.chainId).features[0], { id: 'F001', title: 'one' })
  assert.equal(local.paths(chain.chainId).spec, join(local.paths(chain.chainId).dir, 'SPEC.md'))
  assert.match(skeletonTruth('obj').spec, /^# SPEC[\s\S]*obj[\s\S]*planning session/)
})

check('cluster prompts: planning, launched notice and the delegation subagent rule', () => {
  const truthDir = '/work/.relay/chain-x'
  assert.ok(truthPaths({ truthDir }).spec.endsWith('SPEC.md'))
  const planning = renderClusterPlanningPrompt({ truthDir, objective: 'build it', maxSessions: 3 })
  assert.match(planning, /^<relay_cluster_planning>/)
  assert.match(planning, /<\/relay_cluster_planning>$/)
  for (const needle of ['exit_plan_mode', 'SPEC.md', 'PLAN.md', 'features.json', 'relay_propose', 'worktree', '"dependsOn"', '"files"', 'relay_spawn', 'at most 3']) {
    assert.ok(planning.includes(needle), `planning prompt lacks ${needle}`)
  }
  assert.ok(planning.length < 3000, `planning prompt is ${planning.length} chars`)
  const notice = renderClusterLaunchedNotice({
    chainId: 'chain-x',
    truthDir,
    groups: [{ id: 'G1', launched: true, sessionId: 'session-w1', features: ['F002', 'F003'] }],
    kept: [{ id: 'F004', why: 'group G2 uses worktree isolation, which is not available yet' }],
  })
  assert.match(notice, /^<relay_cluster_launched>/)
  assert.ok(notice.includes('session-w1') && notice.includes('F002, F003'))
  assert.ok(notice.includes('F004') && notice.includes('worktree'))
  assert.ok(notice.includes('relay_finish'))
  const base = { chain: { objective: 'o', chainId: 'chain-x' }, truthDir, parentSessionId: 'p', features: [{ id: 'F002', title: 't' }], note: '' }
  const plain = renderDelegationPrompt(base)
  assert.equal(renderDelegationPrompt({ ...base, cluster: false }), plain, 'cluster:false must not change the prompt')
  assert.ok(plain.includes('Do not start a chain, spawn sessions, or hand off; the parent owns that.'))
  const clustered = renderDelegationPrompt({ ...base, cluster: true })
  assert.ok(clustered.includes('relay_spawn') && clustered.includes('subagent'))
  assert.ok(!clustered.includes('spawn sessions, or hand off; the parent owns that.'))
})

/** A planning session in a fresh workspace; `sent` collects the follow-up prompts it receives. */
function plannerIn(world, id = 'session-planner') {
  const { dir } = outsiderIn(world, id)
  const sent = []
  const agent = {
    id,
    session: { id, header: { cwd: dir } },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) { sent.push(message.content[0].text) },
    inject() {},
  }
  return { agent, dir, sent }
}

await checkAsync('startCluster opens a planning chain, switches plan mode on and sends the planning prompt', async () => {
  const world = fakeWorld()
  const plan = withPlanMode(world, { 'session-planner': { active: false } })
  const { agent, dir, sent } = plannerIn(world)
  const started = world.engine.startCluster({ agent, objective: 'cluster work' })
  assert.equal(started.mode, 'cluster')
  const store = world.engine.storeFor(world.engine.members.get('session-planner').truthDir)
  const chain = store.readChain(started.chainId)
  assert.equal(chain.status, 'planning')
  assert.equal(chain.mode, 'cluster')
  assert.match(readFileSync(store.paths(started.chainId).spec, 'utf8'), /^# SPEC/)
  assert.deepEqual(plan.sets, [{ sessionId: 'session-planner', active: true }])
  assert.equal(sent.length, 1)
  assert.match(sent[0], /<relay_cluster_planning>/)
  assert.ok(sent[0].includes('at most 4'), 'the prompt must carry maxClusterSessions')
  assert.ok(!sent.some(text => /<relay_start>/.test(text)), 'the initializer prompt must not be sent')
  assert.deepEqual(world.engine.audit(started.chainId, 10).find(record => record.kind === 'chain.started').detail, { objective: 'cluster work', maxHandoffs: 32, mode: 'cluster' })
  assert.equal(existsSync(join(dir, '.relay')), true)
  // A planning chain is never wrapped up or handed off, whatever the pressure.
  world.setRatio(0.9)
  await world.engine.evaluate(agent)
  assert.equal(sent.length, 1, 'a planning chain must not receive a wrap-up')
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0)
  // The status label survives a round trip through the validator.
  assert.equal(world.engine.status().find(item => item.chainId === started.chainId).status, 'planning')
})

await checkAsync('startCluster without a plan mode service still starts, and does not touch a session already in plan mode', async () => {
  const bare = fakeWorld()
  const first = plannerIn(bare)
  const started = bare.engine.startCluster({ agent: first.agent, objective: 'no service' })
  assert.equal(started.mode, 'cluster')
  const world = fakeWorld()
  const plan = withPlanMode(world, { 'session-planner': { active: true } })
  const second = plannerIn(world)
  world.engine.startCluster({ agent: second.agent, objective: 'already planning' })
  assert.equal(plan.sets.length, 0, 'plan mode was already on')
  // A plan mode service whose set throws only warns.
  const failing = fakeWorld()
  const original = failing.engine.ctx.get
  failing.engine.ctx.get = name => (name === 'planMode' ? { get: () => ({ active: false }), set: () => { throw new Error('nope') } } : original(name))
  const third = plannerIn(failing)
  assert.equal(failing.engine.startCluster({ agent: third.agent, objective: 'set throws' }).mode, 'cluster')
})

check('start still refuses in plan mode when the cluster entry exists', () => {
  const world = fakeWorld()
  withPlanMode(world, { 'session-planner': { active: true } })
  const { agent } = plannerIn(world)
  assert.throws(
    () => world.engine.start({ agent, objective: 'plain start' }),
    error => error instanceof RelayError && /plan mode is active/.test(error.message),
  )
  const normal = plannerIn(fakeWorld(), 'session-other')
  const started = world.engine.start({ agent: normal.agent, objective: 'plain start' })
  assert.equal(started.mode, undefined, 'start keeps its old result shape')
  const store = world.engine.storeFor(world.engine.members.get('session-other').truthDir)
  assert.equal(store.readChain(started.chainId).status, 'initializing')
  assert.equal(store.readChain(started.chainId).mode, undefined)
})

/**
 * A planning chain with a loaded head session, a registry of live agents, and a controller that
 * mints one distinct worker id per create (`session-w1`, `session-w2`, ...).
 * `failCreate` lists the 1-based create calls that must throw.
 */
function clusterWorld({ failCreate = [], ...overrides } = {}) {
  const config = resolveConfig({ cooldownMs: 0, ...overrides })
  const workspaceDir = mkdtempSync(join(tmpdir(), 'relay-cluster-'))
  const indexHome = mkdtempSync(join(tmpdir(), 'relay-cluster-home-'))
  const local = ChainStore.forCwd(workspaceDir)
  const chain = local.create({ objective: 'cluster objective', cwd: workspaceDir, maxHandoffs: 4 })
  local.writeFeatures(chain.chainId, {
    version: 1,
    objective: 'cluster objective',
    features: [
      { id: 'F001', title: 'done already', passes: true, evidence: 'ran true', verify: 'true', files: ['src/a'] },
      { id: 'F002', title: 'second', verify: 'node two.mjs', files: ['src/a'] },
      { id: 'F003', title: 'third', verify: 'node three.mjs', files: ['src/b'] },
      { id: 'F004', title: 'fourth', verify: 'node four.mjs', files: ['src/a/deep'], dependsOn: ['F002'] },
      { id: 'F005', title: 'fifth' },
      { id: 'F006', title: 'sixth', files: ['docs'], dependsOn: ['F003'] },
    ],
  })
  local.update(chain.chainId, record => {
    record.sessions.push({ sessionId: 'session-head', role: 'initializer', index: 0, joinedAt: new Date().toISOString(), parentSessionId: null })
    record.currentSessionId = 'session-head'
    record.status = 'planning'
    record.mode = 'cluster'
  })
  const calls = []
  const agents = new Map()
  const makeAgent = id => {
    const agent = {
      id,
      session: { id, header: { cwd: workspaceDir } },
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
      followup(message) { calls.push({ kind: 'followup', sessionId: id, text: message.content[0].text }) },
      inject() {},
    }
    agents.set(id, agent)
    return agent
  }
  const head = makeAgent('session-head')
  let created = 0
  const services = {
    agents: { get: id => agents.get(id) },
    sessionController: {
      async create(request) {
        created += 1
        calls.push({ kind: 'create', cwd: request.cwd })
        if (failCreate.includes(created)) throw new Error(`create ${created} refused`)
        const id = `session-w${created}`
        makeAgent(id)
        return { sessionId: id }
      },
      async prompt(request) {
        calls.push({ kind: 'prompt', sessionId: request.sessionId, text: request.content[0].text })
        return { accepted: true }
      },
    },
    sessions: { flush: async () => true },
  }
  const ctx = { logger: { warn: () => {} }, get: name => services[name] }
  const engine = new RelayEngine(ctx, config, { chainIndex: new ChainIndex(indexHome), fingerprints: new ChainFingerprints(indexHome) })
  engine.members.set('session-head', { chainId: chain.chainId, truthDir: local.truthDir })
  engine.remember(local.readChain(chain.chainId), local)
  return { engine, local, chain, head, agents, makeAgent, calls }
}

/** One launch group as the model submits it. */
const clusterGroup = (title, features, isolation = 'shared', reason = `because ${title}`) => ({ title, features, isolation, reason })

/** Propose the standard two-group plan on a cluster world. */
function proposeTwoGroups(world) {
  return world.engine.proposeCluster({
    agent: world.head,
    groups: [clusterGroup('left', ['F002', 'F004']), clusterGroup('right', ['F003', 'F006'])],
    note: 'ready',
  })
}

/** Assert a RelayError with the given code and a message matching `pattern`. */
const refusal = (pattern, code = RELAY_CODES.invalid) => error => error instanceof RelayError && error.code === code && pattern.test(error.message)

check('proposeCluster refuses every malformed or unsafe proposal', () => {
  const world = clusterWorld()
  const propose = (groups, agent = world.head) => () => world.engine.proposeCluster({ agent, groups })
  const outsider = outsiderIn(world, 'session-outsider').agent
  assert.throws(propose([clusterGroup('a', ['F002'])], outsider), refusal(/does not belong to a chain/))
  world.local.update(world.chain.chainId, record => {
    record.sessions.push({ sessionId: 'session-other', role: 'worker', index: 1, joinedAt: new Date().toISOString(), parentSessionId: 'session-head' })
  })
  const other = world.makeAgent('session-other')
  assert.throws(propose([clusterGroup('a', ['F002'])], other), refusal(/only the chain's current session/))
  // groups shape
  assert.throws(propose(undefined), refusal(/groups must be a non-empty array/))
  assert.throws(propose([]), refusal(/groups must be a non-empty array/))
  assert.throws(propose([1, 2, 3, 4, 5].map(n => clusterGroup(`g${n}`, ['F002']))), refusal(/at most 4 groups/))
  assert.throws(propose([clusterGroup('', ['F002'])]), refusal(/groups\[0\]\.title/))
  assert.throws(propose([clusterGroup('a', [])]), refusal(/groups\[0\]\.features/))
  assert.throws(propose([clusterGroup('a', [7])]), refusal(/groups\[0\]\.features/))
  assert.throws(propose([clusterGroup('a', ['F002'], 'copy')]), refusal(/groups\[0\]\.isolation/))
  assert.throws(propose([clusterGroup('a', ['F002'], 'shared', '  ')]), refusal(/groups\[0\]\.reason/))
  // feature state
  assert.throws(propose([clusterGroup('a', ['F404'])]), refusal(/feature F404 does not exist/))
  assert.throws(propose([clusterGroup('a', ['F001'])]), refusal(/feature F001 already passes/))
  assert.throws(propose([clusterGroup('a', ['F002']), clusterGroup('b', ['F002'])]), refusal(/feature F002 appears in more than one group \(G1 and G2\)/))
  assert.throws(propose([clusterGroup('a', ['F002', 'F004']), clusterGroup('b', ['F004'])]), refusal(/feature F004 appears in more than one group/))
  assert.throws(propose([clusterGroup('a', ['F002']), clusterGroup('b', ['F004'])]), refusal(/F004 \(group G2\) depends on F002 \(group G1\); put both in the same group/))
  world.local.patchFeatures(world.chain.chainId, [{ id: 'F003', assignedSessionId: 'session-other' }])
  assert.throws(propose([clusterGroup('a', ['F003'])]), refusal(/feature F003 is already delegated to session-other/))
  // chain state
  const plan = withPlanMode(world, { 'session-head': { active: true } })
  assert.throws(propose([clusterGroup('a', ['F002'])]), refusal(/plan is not approved yet; present it through exit_plan_mode first/))
  plan.states.set('session-head', { active: false })
  world.local.update(world.chain.chainId, record => { record.status = 'active' })
  assert.throws(propose([clusterGroup('a', ['F002'])]), refusal(/is active; only a planning chain/))
  assert.equal(world.local.readChain(world.chain.chainId).launchPlan, undefined, 'a refusal must write nothing')
  assert.equal(world.engine.fingerprints.get(world.chain.chainId), undefined, 'a refusal must not freeze the list')
})

check('proposeCluster stores the launch plan, leaves the list unfrozen, audits, and status shows launchPending', () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  const before = world.engine.status().find(item => item.chainId === chainId)
  assert.equal(before.launchPending, false)
  assert.equal(before.mode, 'cluster')
  const result = proposeTwoGroups(world)
  assert.equal(result.waitingFor, 'human')
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.groups.map(group => group.id), ['G1', 'G2'])
  assert.deepEqual(result.groups[0], { id: 'G1', title: 'left', features: ['F002', 'F004'], isolation: 'shared', reason: 'because left' })
  const record = world.local.readChain(chainId)
  assert.equal(record.status, 'planning')
  assert.equal(record.launchPlan.proposedBy, 'session-head')
  assert.equal(record.launchPlan.note, 'ready')
  assert.equal(typeof record.launchPlan.proposedAt, 'string')
  assert.deepEqual(record.launchPlan.groups, result.groups)
  assert.equal(world.engine.fingerprints.get(chainId), undefined, 'the list is frozen at launch, not by a proposal')
  assert.equal(auditOf(world, 'features.frozen').length, 0)
  assert.deepEqual(auditOf(world, 'cluster.proposed')[0].detail, { groups: 2, conflicts: 0 })
  const after = world.engine.status().find(item => item.chainId === chainId)
  assert.equal(after.launchPending, true, 'the status cache must notice the new launch plan')
  // A second proposal overwrites the first.
  world.engine.proposeCluster({ agent: world.head, groups: [clusterGroup('only', ['F002'])] })
  const second = world.local.readChain(chainId).launchPlan
  assert.equal(second.groups.length, 1)
  assert.equal(second.note, '')
  assert.equal(auditOf(world, 'features.frozen').length, 0)
  assert.equal(auditOf(world, 'cluster.proposed').length, 2)
})

check('clusterConflicts: exact path, directory prefix, sibling that is not a prefix, worktree compared as main, unknown scope', () => {
  const doc = features => ({ features: features.map(([id, files]) => ({ id, title: id, ...(files === undefined ? {} : { files }) })) })
  const shared = (id, features) => ({ id, isolation: 'shared', features })
  const exact = clusterConflicts(doc([['A', ['src\\x.js']], ['B', ['src/x.js']]]), [shared('G1', ['A']), shared('G2', ['B'])])
  assert.deepEqual(exact, [{ kind: 'overlap', groups: ['G1', 'G2'], features: ['A', 'B'], path: 'src/x.js' }])
  const prefix = clusterConflicts(doc([['A', ['a/b/']], ['B', ['a/b/c.js']]]), [shared('G1', ['A']), shared('G2', ['B'])])
  assert.equal(prefix.length, 1)
  assert.equal(prefix[0].kind, 'overlap')
  assert.equal(prefix[0].path, 'a/b', 'the covering directory is reported')
  const reversed = clusterConflicts(doc([['A', ['a/b/c.js']], ['B', ['a/b']]]), [shared('G1', ['A']), shared('G2', ['B'])])
  assert.equal(reversed.length, 1, 'the prefix may sit on either side')
  const sibling = clusterConflicts(doc([['A', ['a/b']], ['B', ['a/bc.js']]]), [shared('G1', ['A']), shared('G2', ['B'])])
  assert.deepEqual(sibling, [], 'a/b is not a prefix of a/bc.js')
  const worktree = clusterConflicts(doc([['A', ['a']], ['B', ['a']]]), [shared('G1', ['A']), { id: 'G2', isolation: 'worktree', features: ['B'] }])
  assert.deepEqual(worktree, [{ kind: 'overlap', groups: ['G1', 'main'], features: ['A', 'B'], path: 'a' }], 'a worktree group stays with the planning session, which is compared as main')
  const same = clusterConflicts(doc([['A', ['a']], ['B', ['a']]]), [shared('G1', ['A', 'B'])])
  assert.deepEqual(same, [], 'features in one group run in order and cannot collide')
  const unknown = clusterConflicts(doc([['A', undefined], ['B', ['x']], ['C', undefined]]), [shared('G1', ['A', 'B']), { id: 'G2', isolation: 'worktree', features: ['C'] }])
  assert.deepEqual(unknown, [{ kind: 'unknown-scope', groups: ['G1'], features: ['A'] }])
})

check('proposeCluster reports overlap and unknown scope as conflicts without refusing', () => {
  const world = clusterWorld()
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'cluster objective',
    features: [
      { id: 'F002', title: 'second', files: ['src/a'] },
      { id: 'F003', title: 'third', files: ['src/a/deep'] },
      { id: 'F005', title: 'fifth' },
    ],
  })
  const result = world.engine.proposeCluster({
    agent: world.head,
    groups: [clusterGroup('a', ['F002']), clusterGroup('b', ['F003']), clusterGroup('c', ['F005'])],
  })
  assert.deepEqual(result.conflicts.map(item => item.kind).sort(), ['overlap', 'unknown-scope'])
  const overlap = result.conflicts.find(item => item.kind === 'overlap')
  assert.deepEqual(overlap, { kind: 'overlap', groups: ['G1', 'G2'], features: ['F002', 'F003'], path: 'src/a' })
  assert.deepEqual(world.local.readChain(world.chain.chainId).launchPlan.conflicts, result.conflicts)
  assert.deepEqual(auditOf(world, 'cluster.proposed')[0].detail, { groups: 3, conflicts: 2 })
})

await checkAsync('launchCluster opens one worker per shared group and activates the chain', async () => {
  const world = clusterWorld()
  const goals = withGoals(world)
  const plan = withPlanMode(world, { 'session-head': { active: false } })
  proposeTwoGroups(world)
  const result = await world.engine.launchCluster({ chainId: world.chain.chainId })
  assert.equal(result.status, 'active')
  assert.deepEqual(result.results, [
    { id: 'G1', launched: true, sessionId: 'session-w1' },
    { id: 'G2', launched: true, sessionId: 'session-w2' },
  ])
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.status, 'active')
  assert.equal(typeof chain.launchedAt, 'string')
  assert.equal(chain.lastError, null)
  assert.deepEqual(chain.launchPlan.results, result.results)
  assert.equal(typeof chain.launchPlan.launchedAt, 'string')
  assert.equal(chain.launchPlan.groups.length, 2, 'the plan stays for the panel to show')
  const owner = id => world.local.readFeatures(world.chain.chainId).features.find(feature => feature.id === id).assignedSessionId
  assert.deepEqual(['F002', 'F004', 'F003', 'F006', 'F005'].map(owner), ['session-w1', 'session-w1', 'session-w2', 'session-w2', null])
  const worker = chain.sessions.find(session => session.sessionId === 'session-w1')
  assert.equal(worker.role, 'worker')
  assert.equal(worker.parentSessionId, 'session-head')
  const prompts = world.calls.filter(call => call.kind === 'prompt')
  assert.equal(prompts.length, 2)
  assert.match(prompts[0].text, /<relay_delegation>/)
  assert.ok(prompts[0].text.includes('subagent') && prompts[0].text.includes('relay_spawn'))
  assert.ok(prompts[0].text.includes('Cluster group G1: left. because left'), 'the group note reaches the worker')
  assert.equal(auditOf(world, 'cluster.launched').length, 1)
  assert.deepEqual(auditOf(world, 'cluster.launched')[0].detail, { results: result.results })
  assert.equal(auditOf(world, 'delegation.created')[0].actor, 'host')
  const notice = world.calls.find(call => call.kind === 'followup' && call.sessionId === 'session-head')
  assert.match(notice.text, /<relay_cluster_launched>/)
  assert.ok(notice.text.includes('session-w1') && notice.text.includes('F002, F004') && notice.text.includes('F005'))
  // goals: one for the head and one per worker, each recorded as the plugin's own
  assert.deepEqual(goals.ops('create').map(op => op.agentId), ['session-w1', 'session-w2', 'session-head'])
  assert.equal(goals.ops('create')[0].objective, 'cluster objective — cluster group left: features F002, F004')
  assert.equal(goals.ops('create')[0].maxGoalRounds, 16)
  const entry = id => chain.sessions.find(session => session.sessionId === id)
  assert.equal(entry('session-w1').goalId, 'goal-for-session-w1')
  assert.equal(entry('session-w1').goalSeeded, true)
  assert.equal(entry('session-head').goalId, 'goal-for-session-head')
  assert.equal(entry('session-head').goalSeeded, true)
  assert.equal(plan.sets.length, 0)
})

await checkAsync('launchCluster creates no goals when clusterGoals is off, and keeps an existing head goal', async () => {
  const off = clusterWorld({ clusterGoals: false })
  const offGoals = withGoals(off)
  proposeTwoGroups(off)
  await off.engine.launchCluster({ chainId: off.chain.chainId })
  assert.equal(offGoals.ops('create').length, 0)
  const kept = clusterWorld()
  const keptGoals = withGoals(kept, { 'session-head': goalView() })
  proposeTwoGroups(kept)
  await kept.engine.launchCluster({ chainId: kept.chain.chainId })
  assert.deepEqual(keptGoals.ops('create').map(op => op.agentId), ['session-w1', 'session-w2'], 'the head already had a goal')
  assert.equal(kept.local.readChain(kept.chain.chainId).sessions[0].goalId, undefined)
  // A missing goals service is not an error.
  const bare = clusterWorld()
  proposeTwoGroups(bare)
  assert.equal((await bare.engine.launchCluster({ chainId: bare.chain.chainId })).status, 'active')
})

await checkAsync('launchCluster leaves a worktree group to the planning session', async () => {
  const world = clusterWorld()
  world.engine.proposeCluster({ agent: world.head, groups: [clusterGroup('fast', ['F002']), clusterGroup('heavy', ['F003'], 'worktree')] })
  const result = await world.engine.launchCluster({ chainId: world.chain.chainId })
  assert.equal(result.results[0].launched, true)
  assert.equal(result.results[1].launched, false)
  assert.match(result.results[1].reason, /worktree isolation is not available yet/)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 1)
  const features = world.local.readFeatures(world.chain.chainId).features
  assert.equal(features.find(feature => feature.id === 'F003').assignedSessionId, null)
  assert.equal(world.local.readChain(world.chain.chainId).status, 'active')
  assert.equal(world.local.readChain(world.chain.chainId).lastError, null, 'a worktree group is expected, not an error')
  const notice = world.calls.find(call => call.kind === 'followup' && call.sessionId === 'session-head').text
  assert.ok(notice.includes('F003') && /worktree/.test(notice))
})

await checkAsync('launchCluster keeps going when one group fails and records which', async () => {
  const world = clusterWorld({ failCreate: [1] })
  proposeTwoGroups(world)
  const result = await world.engine.launchCluster({ chainId: world.chain.chainId })
  assert.deepEqual(result.results[0], { id: 'G1', launched: false, reason: 'spawn failed: create 1 refused' })
  assert.deepEqual(result.results[1], { id: 'G2', launched: true, sessionId: 'session-w2' })
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.status, 'active')
  assert.equal(chain.lastError, 'cluster groups not launched: G1')
  const features = world.local.readFeatures(world.chain.chainId).features
  assert.equal(features.find(feature => feature.id === 'F002').assignedSessionId, null, 'the failed group keeps its features')
  assert.equal(features.find(feature => feature.id === 'F003').assignedSessionId, 'session-w2')
  assert.equal(auditOf(world, 'cluster.launched').length, 1)
})

await checkAsync('launchCluster keeps the plan when every shared group fails', async () => {
  const world = clusterWorld({ failCreate: [1, 2] })
  proposeTwoGroups(world)
  await assert.rejects(() => world.engine.launchCluster({ chainId: world.chain.chainId }), refusal(/create 1 refused/, RELAY_CODES.io))
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.status, 'planning')
  assert.equal(chain.launchPlan.launchedAt, undefined)
  assert.equal(auditOf(world, 'cluster.launched').length, 0)
  assert.equal(world.engine.busyChains.has(world.chain.chainId), false, 'the busy mark must be released')
})

await checkAsync('a launch where every group fails freezes nothing; a successful one freezes once and then refuses a rename', async () => {
  const failed = clusterWorld({ failCreate: [1, 2] })
  proposeTwoGroups(failed)
  await assert.rejects(() => failed.engine.launchCluster({ chainId: failed.chain.chainId }), refusal(/create 1 refused/, RELAY_CODES.io))
  assert.equal(failed.engine.fingerprints.get(failed.chain.chainId), undefined, 'a failed launch must not leave a fingerprint')
  assert.equal(auditOf(failed, 'features.frozen').length, 0, 'a failed launch must not record the freeze')
  const world = clusterWorld()
  proposeTwoGroups(world)
  await world.engine.launchCluster({ chainId: world.chain.chainId })
  assert.equal(auditOf(world, 'features.frozen').length, 1)
  assert.notEqual(world.engine.fingerprints.get(world.chain.chainId), undefined)
  const later = world.local.readFeatures(world.chain.chainId)
  later.features.find(feature => feature.id === 'F005').title = 'renamed after the launch'
  world.local.writeFeatures(world.chain.chainId, later)
  assert.throws(() => world.engine.checkpoint({ agent: world.head, note: 'x' }), refusal(/no longer matches the frozen list/, RELAY_CODES.drift))
})

await checkAsync('the launch freezes the list that was validated, so a rename while the groups open is drift', async () => {
  const world = clusterWorld()
  proposeTwoGroups(world)
  const original = world.engine.ctx.get
  const controller = original('sessionController')
  world.engine.ctx.get = name => (name === 'sessionController'
    ? {
        ...controller,
        async create(request) {
          const during = world.local.readFeatures(world.chain.chainId)
          during.features.find(feature => feature.id === 'F005').title = 'renamed while the groups open'
          world.local.writeFeatures(world.chain.chainId, during)
          return controller.create(request)
        },
      }
    : original(name))
  await world.engine.launchCluster({ chainId: world.chain.chainId })
  assert.equal(world.engine.fingerprints.get(world.chain.chainId).features.find(feature => feature.id === 'F005').title, 'fifth')
  assert.deepEqual(auditOf(world, 'features.frozen')[0].detail, { features: 6 })
  assert.throws(() => world.engine.checkpoint({ agent: world.head, note: 'x' }), refusal(/renamed: F005/, RELAY_CODES.drift))
})

await checkAsync('a fingerprint that cannot be written does not fail the launch', async () => {
  const world = clusterWorld()
  proposeTwoGroups(world)
  world.engine.fingerprints.set = () => { throw new Error('disk full') }
  const result = await world.engine.launchCluster({ chainId: world.chain.chainId })
  assert.equal(result.status, 'active')
  assert.equal(world.local.readChain(world.chain.chainId).status, 'active')
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 2)
})

/** Write a brief that is newer than the one the current head received. */
function writeFreshBrief(world) {
  world.local.writeHandoff(world.chain.chainId, '# HANDOFF\n\n<!-- relay:state -->\n- step: pass the chain on\n<!-- /relay:state -->\n')
}

await checkAsync('a cluster handoff re-seeds the head goal, keeps the workers visible, and forwards reports', async () => {
  const world = clusterWorld()
  const goals = withGoals(world)
  proposeTwoGroups(world)
  await world.engine.launchCluster({ chainId: world.chain.chainId })
  assert.ok(goals.ops('create').some(op => op.agentId === 'session-head'), 'the launch seeds the head goal')

  writeFreshBrief(world)
  const handed = await world.engine.handoff(world.local.readChain(world.chain.chainId), world.head, 'manual', world.local)
  const newHead = handed.newSessionId
  assert.ok(typeof newHead === 'string' && newHead !== 'session-head')

  // The cluster head keeps driving after the handoff even though seedGoalOnHandoff is off.
  assert.equal(goals.ops('create').filter(op => op.agentId === newHead).length, 1)
  const entry = world.local.readChain(world.chain.chainId).sessions.find(session => session.sessionId === newHead)
  assert.equal(entry.goalId, `goal-for-${newHead}`)
  assert.equal(entry.goalSeeded, true)

  // The handoff prompt must tell the new head that it is running a cluster.
  const prompt = world.calls.filter(call => call.kind === 'prompt').at(-1).text
  assert.match(prompt, /<relay_handoff>/)
  assert.match(prompt, /Cluster rules/)
  assert.ok(prompt.includes('session-w1') && prompt.includes('session-w2'), 'the workers must be named')

  // The new head's downstream view inherits the workers the previous head launched.
  const view = world.engine.sessionView(newHead)
  assert.equal(view.chain.mode, 'cluster')
  assert.deepEqual(view.children.map(child => child.sessionId).sort(), ['session-w1', 'session-w2'])

  // A worker reporting a passing feature wakes the new head; a progress-only note does not.
  const worker = world.agents.get('session-w1')
  const owned = world.local.readFeatures(world.chain.chainId).features
    .find(feature => feature.assignedSessionId === 'session-w1' && !feature.passes)
  world.calls.length = 0
  world.engine.checkpoint({ agent: worker, features: [{ id: owned.id, passes: true, evidence: 'ran it', coverage: 'full' }] })
  const notice = world.calls.find(call => call.kind === 'followup' && call.sessionId === newHead)
  assert.ok(notice, 'the worker report must wake the new head')
  assert.match(notice.text, /<relay_worker_report>/)
  assert.ok(notice.text.includes(owned.id))

  world.calls.length = 0
  world.engine.checkpoint({ agent: worker, note: 'still working' })
  assert.equal(world.calls.filter(call => call.kind === 'followup' && call.sessionId === newHead).length, 0)
})

await checkAsync('a cluster handoff creates no head goal when clusterGoals is off', async () => {
  const world = clusterWorld({ clusterGoals: false })
  const goals = withGoals(world)
  proposeTwoGroups(world)
  await world.engine.launchCluster({ chainId: world.chain.chainId })
  assert.equal(goals.ops('create').length, 0)
  writeFreshBrief(world)
  const handed = await world.engine.handoff(world.local.readChain(world.chain.chainId), world.head, 'manual', world.local)
  assert.equal(goals.ops('create').length, 0)
  const entry = world.local.readChain(world.chain.chainId).sessions.find(session => session.sessionId === handed.newSessionId)
  assert.equal(entry.goalId, undefined)
})

check('previewCluster reports conflicts with group positions and waiting groups, and writes nothing', () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  const stored = proposeTwoGroups(world)
  const before = world.local.readChain(chainId)
  const auditBefore = world.engine.audit(chainId, 200).length
  const preview = world.engine.previewCluster({ chainId, groups: [clusterGroup('late', ['F004']), clusterGroup('now', ['F003'])] })
  assert.deepEqual(preview, {
    issues: [],
    conflicts: [{ kind: 'overlap', groups: ['G1', 'main'], features: ['F004', 'F002'], path: 'src/a' }],
    waiting: [{ index: 0, waitsFor: ['F002'] }],
  })
  const unknown = world.engine.previewCluster({ chainId, groups: [clusterGroup('x', ['F002']), clusterGroup('y', ['F005'])] })
  assert.deepEqual(unknown.conflicts.find(item => item.kind === 'unknown-scope'), { kind: 'unknown-scope', groups: ['G2'], features: ['F005'] })
  assert.deepEqual(world.local.readChain(chainId), before, 'a preview must not change the chain record')
  assert.equal(world.local.readChain(chainId).launchPlan.groups.length, stored.groups.length)
  assert.equal(world.engine.audit(chainId, 200).length, auditBefore, 'a preview must not audit')
  // Without groups the stored plan is read.
  assert.deepEqual(world.engine.previewCluster({ chainId }).conflicts, [])
  assert.deepEqual(world.engine.previewCluster({ chainId }).waiting, [])
  assert.deepEqual(world.engine.previewCluster({ chainId }).issues, [])
})

check('previewCluster lists every launch issue instead of throwing, and refuses a chain that is not planning', () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  const preview = groups => world.engine.previewCluster({ chainId, groups })
  // Preconditions first: without a stored plan nothing else is looked at.
  const bare = preview([clusterGroup('a', ['F404'])])
  assert.deepEqual(bare, {
    issues: [{ code: 'no-plan', message: `chain ${chainId} has no launch plan yet; the planning session must call relay_propose first` }],
    conflicts: [],
    waiting: [],
  })
  proposeTwoGroups(world)
  const cross = preview([clusterGroup('a', ['F002']), clusterGroup('b', ['F004'])])
  assert.deepEqual(cross.issues, [{
    code: 'cross-group-dependency',
    message: 'feature F004 (group G2) depends on F002 (group G1); put both in the same group',
    feature: 'F004',
    dependency: 'F002',
    index: 1,
    dependencyIndex: 0,
  }])
  assert.deepEqual([cross.conflicts, cross.waiting], [[], []])
  assert.deepEqual(preview([clusterGroup('a', ['F404'])]).issues, [{ code: 'unknown-feature', message: 'feature F404 does not exist', feature: 'F404', index: 0 }])
  assert.deepEqual(preview([]).issues.map(issue => issue.code), ['invalid-groups'])
  world.engine.checkpoint({ agent: world.head, blocker: { kind: 'external', who: 'human', action: 'supply the API key' } })
  const blocked = preview([clusterGroup('a', ['F404'])])
  assert.deepEqual(blocked.issues, [{
    code: 'blocker',
    message: `chain ${chainId} has an open blocker ("supply the API key"); clear it before launching`,
    action: 'supply the API key',
  }], 'a precondition issue skips the group checks')
  assert.deepEqual([blocked.conflicts, blocked.waiting], [[], []])
  world.local.update(chainId, record => { record.status = 'active' })
  assert.throws(() => preview([clusterGroup('a', ['F002'])]), refusal(/is active; only a planning chain/))
})

await checkAsync('every launch precondition is a previewCluster issue and makes launchCluster refuse with the same message', async () => {
  const launchOf = world => () => world.engine.launchCluster({ chainId: world.chain.chainId })
  const issueOf = (world, code) => {
    const issues = world.engine.previewCluster({ chainId: world.chain.chainId }).issues
    assert.deepEqual(issues.map(issue => issue.code), [code])
    return issues[0]
  }
  const noPlan = clusterWorld()
  const noPlanIssue = issueOf(noPlan, 'no-plan')
  await assert.rejects(launchOf(noPlan), error => error instanceof RelayError && error.code === RELAY_CODES.invalid && error.message === noPlanIssue.message)

  const busy = clusterWorld()
  proposeTwoGroups(busy)
  busy.engine.busyChains.add(busy.chain.chainId)
  const busyIssue = issueOf(busy, 'busy')
  await assert.rejects(launchOf(busy), error => error instanceof RelayError && error.code === RELAY_CODES.invalid && error.message === busyIssue.message)

  const unloaded = clusterWorld()
  proposeTwoGroups(unloaded)
  unloaded.agents.delete('session-head')
  const unloadedIssue = issueOf(unloaded, 'not-loaded')
  await assert.rejects(launchOf(unloaded), error => error instanceof RelayError && error.code === RELAY_CODES.notFound && error.message === unloadedIssue.message)

  const pending = clusterWorld()
  proposeTwoGroups(pending)
  withPlanMode(pending, { 'session-head': { active: true } })
  const pendingIssue = issueOf(pending, 'plan-pending')
  await assert.rejects(launchOf(pending), error => error instanceof RelayError && error.code === RELAY_CODES.invalid && error.message === pendingIssue.message)

  const blocked = clusterWorld()
  proposeTwoGroups(blocked)
  blocked.engine.checkpoint({ agent: blocked.head, blocker: { kind: 'external', who: 'human', action: 'supply the API key' } })
  const blockedIssue = issueOf(blocked, 'blocker')
  assert.equal(blockedIssue.action, 'supply the API key')
  await assert.rejects(launchOf(blocked), error => error instanceof RelayError && error.code === RELAY_CODES.invalid && error.message === blockedIssue.message)

  const several = clusterWorld()
  proposeTwoGroups(several)
  several.engine.busyChains.add(several.chain.chainId)
  several.agents.delete('session-head')
  assert.deepEqual(several.engine.previewCluster({ chainId: several.chain.chainId }).issues.map(issue => issue.code), ['busy', 'not-loaded'], 'all preconditions are listed, in order')
  for (const world of [noPlan, busy, unloaded, pending, blocked]) assert.equal(world.calls.filter(call => call.kind === 'create').length, 0)
})

check('previewCluster returns every group issue with its position', () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  world.local.writeFeatures(chainId, {
    version: 1,
    objective: 'cluster objective',
    features: [
      { id: 'F002', title: 'second' },
      { id: 'F003', title: 'third', dependsOn: ['F002', 'F09'] },
      { id: 'F004', title: 'fourth', dependsOn: ['F002'] },
      { id: 'F005', title: 'fifth', dependsOn: ['F003'] },
      { id: 'F006', title: 'sixth', passes: true, evidence: 'ran' },
      { id: 'F007', title: 'seventh', assignedSessionId: 'session-w9' },
    ],
  })
  world.engine.proposeCluster({ agent: world.head, groups: [clusterGroup('seed', ['F002'])] })
  const issues = world.engine.previewCluster({
    chainId,
    groups: [clusterGroup('a', ['F002']), clusterGroup('b', ['F003', 'F004']), clusterGroup('c', ['F005'])],
  }).issues
  assert.deepEqual(issues.map(({ code, feature, dependency, index, dependencyIndex }) => ({ code, feature, dependency, index, dependencyIndex })), [
    { code: 'cross-group-dependency', feature: 'F003', dependency: 'F002', index: 1, dependencyIndex: 0 },
    { code: 'missing-dependency', feature: 'F003', dependency: 'F09', index: 1, dependencyIndex: undefined },
    { code: 'cross-group-dependency', feature: 'F004', dependency: 'F002', index: 1, dependencyIndex: 0 },
    { code: 'cross-group-dependency', feature: 'F005', dependency: 'F003', index: 2, dependencyIndex: 1 },
  ])
  assert.equal(issues[1].message, 'feature F003 depends on F09, which is not in features.json')
  const mixed = world.engine.previewCluster({
    chainId,
    groups: [clusterGroup('a', ['F002', 'F006', 'F007']), clusterGroup('b', ['F002', 'F404']), { title: 'bad' }],
  }).issues
  assert.deepEqual(mixed.map(({ code, feature, index }) => ({ code, feature, index })), [
    { code: 'feature-passes', feature: 'F006', index: 0 },
    { code: 'feature-delegated', feature: 'F007', index: 0 },
    { code: 'duplicate-feature', feature: 'F002', index: 1 },
    { code: 'unknown-feature', feature: 'F404', index: 1 },
    { code: 'invalid-groups', feature: undefined, index: 2 },
    { code: 'invalid-groups', feature: undefined, index: 2 },
    { code: 'invalid-groups', feature: undefined, index: 2 },
  ])
  assert.equal(world.engine.previewCluster({ chainId, groups: [1, 2, 3, 4, 5].map(n => clusterGroup(`g${n}`, ['F002'])) }).issues[0].code, 'invalid-groups')
})

await checkAsync('launchCluster refuses unsafe states', async () => {
  const world = clusterWorld()
  const launch = groups => () => world.engine.launchCluster({ chainId: world.chain.chainId, groups })
  await assert.rejects(launch(), refusal(/has no launch plan/))
  proposeTwoGroups(world)
  const plan = withPlanMode(world, { 'session-head': { active: true } })
  await assert.rejects(launch(), refusal(/plan is not approved yet/))
  plan.states.set('session-head', { active: false })
  world.engine.busyChains.add(world.chain.chainId)
  await assert.rejects(launch(), refusal(/busy/))
  world.engine.busyChains.delete(world.chain.chainId)
  world.agents.delete('session-head')
  await assert.rejects(launch(), refusal(/open the planning session first/, RELAY_CODES.notFound))
  world.agents.set('session-head', world.head)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0, 'nothing may be created by a refused launch')
  world.local.update(world.chain.chainId, record => { record.status = 'active' })
  await assert.rejects(launch(), refusal(/is active; only a planning chain/))
})

await checkAsync('launchCluster validates groups edited by the human and launches them as edited', async () => {
  const world = clusterWorld()
  proposeTwoGroups(world)
  const launch = groups => () => world.engine.launchCluster({ chainId: world.chain.chainId, groups })
  await assert.rejects(launch([clusterGroup('a', ['F002']), clusterGroup('b', ['F002'])]), refusal(/appears in more than one group/))
  await assert.rejects(launch([clusterGroup('a', ['F002']), clusterGroup('b', ['F004'])]), refusal(/put both in the same group/))
  await assert.rejects(launch([1, 2, 3, 4, 5].map(n => clusterGroup(`g${n}`, ['F002']))), refusal(/at most 4 groups/))
  assert.equal(world.local.readChain(world.chain.chainId).status, 'planning')
  const edited = [clusterGroup('solo', ['F003', 'F002', 'F004'], 'shared', 'human merged them')]
  const result = await world.engine.launchCluster({ chainId: world.chain.chainId, groups: edited })
  assert.equal(result.results.length, 1)
  const stored = world.local.readChain(world.chain.chainId).launchPlan
  assert.deepEqual(stored.groups.map(group => group.features), [['F003', 'F002', 'F004']])
  assert.equal(world.local.readFeatures(world.chain.chainId).features.find(feature => feature.id === 'F006').assignedSessionId, null)
})

await checkAsync('spawnWorker skips plan mode inheritance for a cluster worker only', async () => {
  const world = clusterWorld()
  const plan = withPlanMode(world, { 'session-head': { active: true } })
  const chain = world.local.readChain(world.chain.chainId)
  const features = world.local.readFeatures(world.chain.chainId).features
  await world.engine.spawnWorker(chain, world.local, world.head, [features[1]], { actor: 'host', cluster: true })
  assert.equal(plan.sets.length, 0)
  await world.engine.spawnWorker(chain, world.local, world.head, [features[2]], { actor: 'host' })
  assert.deepEqual(plan.sets, [{ sessionId: 'session-w2', active: true }])
})

check('a planning chain cannot be paused or resumed but can be deleted', () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  assert.throws(() => world.engine.setPaused({ chainId, paused: true }), refusal(/is planning; launch it or delete it/))
  assert.throws(() => world.engine.setPaused({ chainId, paused: false }), refusal(/is planning; launch it or delete it/))
  assert.equal(world.local.readChain(chainId).status, 'planning')
  const deleted = world.engine.deleteChain(chainId)
  assert.equal(deleted.status, 'planning')
  assert.equal(existsSync(world.local.paths(chainId).dir), false)
  assert.deepEqual(world.engine.chainIndex.entries(), [])
})

check('detail, doc and the session view carry the cluster fields', () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  world.local.writeText(world.local.paths(chainId).spec, '# SPEC\n\nacceptance: it works\n')
  assert.match(world.engine.doc(chainId, 'spec').text, /acceptance: it works/)
  const empty = world.engine.detail(chainId)
  assert.equal(empty.mode, 'cluster')
  assert.equal(empty.launchPlan, null)
  assert.equal(empty.maxClusterSessions, 4)
  assert.deepEqual(empty.features.find(feature => feature.id === 'F004').files, ['src/a/deep'])
  assert.deepEqual(empty.features.find(feature => feature.id === 'F004').dependsOn, ['F002'])
  assert.deepEqual(empty.features.find(feature => feature.id === 'F005').files, [])
  assert.deepEqual(empty.features.find(feature => feature.id === 'F005').dependsOn, [])
  proposeTwoGroups(world)
  assert.equal(world.engine.detail(chainId).launchPlan.groups.length, 2)
  const view = world.engine.sessionView('session-head')
  assert.equal(view.chain.mode, 'cluster')
  assert.equal(view.chain.launchPending, true)
  const plain = fakeWorld()
  assert.equal(plain.engine.status()[0].mode, 'relay')
  assert.equal(plain.engine.status()[0].launchPending, false)
})

check('relay_start with mode cluster starts a planning chain', () => {
  const world = fakeWorld()
  const registered = new Map()
  registerTools({ tools: { register: definition => registered.set(definition.name, definition) } }, world.engine)
  const start = registered.get('relay_start')
  assert.deepEqual(start.parameters.properties.mode.enum, ['relay', 'cluster'])
  const { agent, sent } = plannerIn(world)
  assert.equal(start.execute({ objective: 'x', mode: 'bogus' }, { agent }).code, 'invalid_arguments')
  const result = start.execute({ objective: 'planned together', mode: 'cluster' }, { agent })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'cluster')
  assert.match(sent[0], /<relay_cluster_planning>/)
  const plain = plannerIn(world, 'session-plain')
  const normal = start.execute({ objective: 'plain', mode: 'relay' }, { agent: plain.agent })
  assert.equal(normal.ok, true)
  assert.equal(normal.mode, undefined)
  assert.match(plain.sent[0], /<relay_start>/)
})

check('relay_propose records a proposal, and refuses bad input and bad state', () => {
  const world = clusterWorld()
  const registered = new Map()
  registerTools({ tools: { register: definition => registered.set(definition.name, definition) } }, world.engine)
  const propose = registered.get('relay_propose')
  assert.equal(propose.presentCall({}).title, 'Propose the cluster launch')
  const exec = { agent: world.head }
  assert.equal(propose.execute({}, exec).code, 'invalid_arguments')
  assert.equal(propose.execute({ groups: 'all' }, exec).code, 'invalid_arguments')
  assert.equal(propose.execute({ groups: [clusterGroup('a', 'F002')] }, exec).code, 'invalid_arguments')
  assert.equal(propose.execute({ groups: [{ ...clusterGroup('a', ['F002']), isolation: 3 }] }, exec).code, 'invalid_arguments')
  assert.equal(propose.execute({ groups: [clusterGroup('a', ['F002'])], note: 4 }, exec).code, 'invalid_arguments')
  assert.equal(propose.execute({ groups: [clusterGroup('a', ['F002'])] }, {}).code, 'no_agent')
  const refused = propose.execute({ groups: [clusterGroup('a', ['F404'])] }, exec)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, RELAY_CODES.invalid)
  assert.match(refused.message, /F404 does not exist/)
  const ok = propose.execute({ groups: [clusterGroup('left', ['F002']), clusterGroup('right', ['F003'])], note: 'n' }, exec)
  assert.equal(ok.ok, true)
  assert.equal(ok.waitingFor, 'human')
  assert.equal(ok.groups.length, 2)
  assert.match(ok.message, /do not spawn sessions yourself/)
  assert.equal(world.local.readChain(world.chain.chainId).launchPlan.note, 'n')
})

await checkAsync('the remote exposes launchCluster and forwards the human edit', async () => {
  const world = clusterWorld()
  const remote = new RelayRemote(world.engine)
  const descriptor = Object.getOwnPropertyDescriptor(RelayRemote.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods')
  assert.ok(descriptor.value.methods.some(method => method.method === 'launchCluster'))
  await assert.rejects(() => remote.launchCluster(''), error => error instanceof RelayError && /chainId is required/.test(error.message))
  await assert.rejects(() => remote.launchCluster(world.chain.chainId), refusal(/has no launch plan/))
  proposeTwoGroups(world)
  const edited = [clusterGroup('merged', ['F002', 'F003', 'F004', 'F006'])]
  const result = await remote.launchCluster(world.chain.chainId, edited)
  assert.equal(result.status, 'active')
  assert.equal(result.results.length, 1, 'the edited groups, not the stored ones, were launched')
  const plain = clusterWorld()
  proposeTwoGroups(plain)
  const stored = await new RelayRemote(plain.engine).launchCluster(plain.chain.chainId, 'not an array')
  assert.equal(stored.results.length, 2, 'a non-array groups argument falls back to the stored plan')
})

check('the remote exposes previewCluster and forwards the edited groups', () => {
  const world = clusterWorld()
  const remote = new RelayRemote(world.engine)
  const descriptor = Object.getOwnPropertyDescriptor(RelayRemote.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods')
  assert.ok(descriptor.value.methods.some(method => method.method === 'previewCluster'))
  assert.throws(() => remote.previewCluster(''), error => error instanceof RelayError && /chainId is required/.test(error.message))
  assert.deepEqual(remote.previewCluster(world.chain.chainId).issues.map(issue => issue.code), ['no-plan'])
  proposeTwoGroups(world)
  assert.deepEqual(remote.previewCluster(world.chain.chainId), { issues: [], conflicts: [], waiting: [] })
  const edited = [clusterGroup('late', ['F004']), clusterGroup('now', ['F003'])]
  assert.deepEqual(remote.previewCluster(world.chain.chainId, edited), world.engine.previewCluster({ chainId: world.chain.chainId, groups: edited }))
  assert.equal(remote.previewCluster(world.chain.chainId, edited).waiting.length, 1, 'the edited groups, not the stored ones, were checked')
  assert.equal(remote.previewCluster(world.chain.chainId, 'not an array').waiting.length, 0, 'a non-array groups argument falls back to the stored plan')
})

await checkAsync('/relay cluster starts a planning chain and /relay launch opens the sessions', async () => {
  const world = fakeWorld()
  withPlanMode(world, { 'session-planner': { active: false } })
  const { agent, sent } = plannerIn(world)
  const missing = await handleRelayCommand(world.engine, commandInvocation(agent, 'cluster'))
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /objective is required/)
  const started = await handleRelayCommand(world.engine, commandInvocation(agent, 'cluster build the thing together'))
  assert.equal(started.kind, 'success', started.text)
  assert.match(started.text, /planning prompt/)
  assert.match(started.text, /\/relay launch/)
  assert.match(sent[0], /<relay_cluster_planning>/)
  assert.equal(world.engine.locate(agent.session).chain.status, 'planning')
  const early = await handleRelayCommand(world.engine, commandInvocation(agent, 'launch'))
  assert.equal(early.kind, 'error')
  assert.match(early.text, /has no launch plan/)
  assert.match((await handleRelayCommand(world.engine, commandInvocation(agent, 'explode'))).text, /cluster <objective> \| launch/, 'the usage text lists cluster and launch')

  const cluster = clusterWorld()
  cluster.engine.proposeCluster({ agent: cluster.head, groups: [clusterGroup('fast', ['F002']), clusterGroup('heavy', ['F003'], 'worktree')] })
  const launched = await handleRelayCommand(cluster.engine, commandInvocation(cluster.head, 'launch'))
  assert.equal(launched.kind, 'success', launched.text)
  assert.ok(launched.text.includes('session-w1'))
  assert.match(launched.text, /G2/)
  assert.match(launched.text, /worktree isolation is not available yet/)
  assert.equal(cluster.local.readChain(cluster.chain.chainId).status, 'active')
})

// --- cluster mode: staged launch ---

/** The head's follow-up messages, newest last. */
const headTexts = world => world.calls.filter(call => call.kind === 'followup' && call.sessionId === 'session-head').map(call => call.text)

/** Pass F002 through a checkpoint from the head, as a session would. */
const passF002 = world => world.engine.checkpoint({
  agent: world.head,
  features: [{ id: 'F002', passes: true, evidence: 'node two.mjs -> exit 0, 3/3 passed' }],
})

/** A planning world with a waiting group G1 (F004 needs the ungrouped F002) and a ready group G2. */
async function waitingWorld(overrides = {}) {
  const world = clusterWorld(overrides)
  world.engine.proposeCluster({ agent: world.head, groups: [clusterGroup('late', ['F004']), clusterGroup('now', ['F003'])] })
  const result = await world.engine.launchCluster({ chainId: world.chain.chainId })
  return { world, result }
}

await checkAsync('launchCluster holds back a group whose dependency is outside every group and unfinished', async () => {
  const { world, result } = await waitingWorld()
  assert.deepEqual(result.results[0], { id: 'G1', launched: false, waiting: true, waitsFor: ['F002'], reason: 'waits for F002 to pass' })
  assert.equal(result.results[1].launched, true)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.status, 'active')
  assert.equal(chain.lastError, null, 'a waiting group is not a failure')
  const owner = id => world.local.readFeatures(world.chain.chainId).features.find(feature => feature.id === id).assignedSessionId
  assert.equal(owner('F004'), null)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 1)
  const notice = headTexts(world)[0]
  assert.ok(notice.includes('F002'), 'the dependency stays with the planning session')
  assert.match(notice, /group G1.*waits for F002/)
  assert.match(notice, /opened automatically/)
  assert.ok(!/- F004:/.test(notice), 'a waiting feature is not kept by the planning session')
  const summary = world.engine.status().find(item => item.chainId === world.chain.chainId)
  assert.equal('launchWaiting' in summary, false, 'nothing reads launchWaiting, so the summary must not carry it')
})

await checkAsync('launchCluster still activates the chain when every shared group waits', async () => {
  const world = clusterWorld()
  world.engine.proposeCluster({ agent: world.head, groups: [clusterGroup('a', ['F004']), clusterGroup('b', ['F006'])] })
  const result = await world.engine.launchCluster({ chainId: world.chain.chainId })
  assert.deepEqual(result.results.map(item => item.waiting), [true, true])
  assert.deepEqual(result.results[1].waitsFor, ['F003'])
  assert.equal(world.local.readChain(world.chain.chainId).status, 'active')
  assert.equal(world.local.readChain(world.chain.chainId).lastError, null)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0)
})

await checkAsync('a dependency that already passes does not make a group wait', async () => {
  const world = clusterWorld()
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'cluster objective',
    features: [
      { id: 'F001', title: 'done', passes: true, evidence: 'ran true', files: ['x'] },
      { id: 'F002', title: 'second', files: ['a'], dependsOn: ['F001'] },
      { id: 'F003', title: 'third', files: ['b'], dependsOn: ['F001'] },
    ],
  })
  world.engine.proposeCluster({ agent: world.head, groups: [clusterGroup('a', ['F002']), clusterGroup('b', ['F003'])] })
  const result = await world.engine.launchCluster({ chainId: world.chain.chainId })
  assert.equal(result.results[0].launched, true, 'F001 passes, so G1 opens')
  assert.equal(result.results[1].launched, true, 'F001 passes, so G2 opens')
  // A plan can no longer name a missing dependency, but the check stays defensive for a list edited later.
  assert.deepEqual(world.engine.unmetDependencies({ features: [{ id: 'F003', dependsOn: ['F404'] }] }, { features: ['F003'] }), ['F404'])
})

await checkAsync('launchWaitingGroups opens the group once its dependency passes, and checkpoint triggers it', async () => {
  const { world } = await waitingWorld()
  const chainId = world.chain.chainId
  await world.engine.launchWaitingGroups(chainId)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 1, 'nothing opens while the dependency is open')
  const original = world.engine.launchWaitingGroups.bind(world.engine)
  const triggered = []
  world.engine.launchWaitingGroups = id => { triggered.push(id); return Promise.resolve() }
  passF002(world)
  assert.deepEqual(triggered, [chainId], 'checkpoint must trigger the release')
  world.engine.launchWaitingGroups = original
  await world.engine.launchWaitingGroups(chainId)
  const chain = world.local.readChain(chainId)
  const late = chain.launchPlan.results.find(item => item.id === 'G1')
  assert.equal(late.launched, true)
  assert.equal(late.waiting, undefined)
  assert.ok(world.agents.has(late.sessionId))
  const owner = world.local.readFeatures(chainId).features.find(feature => feature.id === 'F004').assignedSessionId
  assert.equal(owner, late.sessionId)
  assert.equal(chain.sessions.find(session => session.sessionId === late.sessionId).parentSessionId, 'session-head')
  assert.deepEqual(auditOf(world, 'cluster.group-launched')[0].detail, { id: 'G1', sessionId: late.sessionId })
  const notice = headTexts(world).at(-1)
  assert.match(notice, /<relay_cluster_group_opened>/)
  assert.ok(notice.includes(late.sessionId) && notice.includes('F004'))
  await world.engine.launchWaitingGroups(chainId)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 2, 'an opened group is not opened twice')
  // A relay-mode checkpoint never reaches it.
  const plain = fakeWorld()
  let touched = false
  plain.engine.launchWaitingGroups = () => { touched = true; return Promise.resolve() }
  plain.engine.checkpoint({ agent: plain.oldAgent, note: 'x' })
  assert.equal(touched, false)
})

await checkAsync('evaluate also releases waiting groups for the chain head', async () => {
  const { world } = await waitingWorld()
  world.local.patchFeatures(world.chain.chainId, [{ id: 'F002', passes: true, evidence: 'node two.mjs -> exit 0, 3/3 passed' }])
  const opened = []
  const original = world.engine.launchWaitingGroups.bind(world.engine)
  world.engine.launchWaitingGroups = id => { opened.push(id); return original(id) }
  await world.engine.evaluate(world.head)
  assert.deepEqual(opened, [world.chain.chainId])
})

await checkAsync('a waiting group whose open fails becomes a plain failure and is not retried', async () => {
  const { world } = await waitingWorld({ failCreate: [2] })
  const chainId = world.chain.chainId
  world.local.patchFeatures(chainId, [{ id: 'F002', passes: true, evidence: 'node two.mjs -> exit 0, 3/3 passed' }])
  await world.engine.launchWaitingGroups(chainId)
  const chain = world.local.readChain(chainId)
  assert.deepEqual(chain.launchPlan.results.find(item => item.id === 'G1'), { id: 'G1', launched: false, reason: 'spawn failed: create 2 refused' })
  assert.match(chain.lastError, /cluster groups not launched: G1/)
  assert.match(auditOf(world, 'cluster.group-failed')[0].detail.error, /create 2 refused/)
  assert.equal(world.engine.busyChains.has(chainId), false)
  await world.engine.launchWaitingGroups(chainId)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 2, 'no retry')
})

await checkAsync('launchWaitingGroups does nothing for relay chains, paused chains, a busy chain, or an unloaded head', async () => {
  const relay = fakeWorld()
  await relay.engine.launchWaitingGroups(relay.chain.chainId)
  assert.equal(relay.calls.filter(call => call.kind === 'create').length, 0)
  await relay.engine.launchWaitingGroups('chain-00000000-0000-4000-8000-000000000000')

  const { world } = await waitingWorld()
  const chainId = world.chain.chainId
  world.local.patchFeatures(chainId, [{ id: 'F002', passes: true, evidence: 'node two.mjs -> exit 0, 3/3 passed' }])
  const creates = () => world.calls.filter(call => call.kind === 'create').length
  world.engine.setPaused({ chainId, paused: true })
  await world.engine.launchWaitingGroups(chainId)
  assert.equal(creates(), 1, 'a paused chain opens nothing')
  world.local.update(chainId, record => { record.status = 'active' })
  world.engine.busyChains.add(chainId)
  await world.engine.launchWaitingGroups(chainId)
  assert.equal(creates(), 1, 'a busy chain opens nothing')
  world.engine.busyChains.delete(chainId)
  world.agents.delete('session-head')
  await world.engine.launchWaitingGroups(chainId)
  assert.equal(creates(), 1, 'an unloaded head opens nothing')
  world.agents.set('session-head', world.head)
  await world.engine.launchWaitingGroups(chainId)
  assert.equal(creates(), 2)
})

await checkAsync('handoffNow refuses a planning chain, from the engine and from /relay handoff', async () => {
  const world = clusterWorld()
  await assert.rejects(() => world.engine.handoffNow({ chainId: world.chain.chainId }), refusal(/is planning; there is no work to hand off yet/))
  const result = await handleRelayCommand(world.engine, commandInvocation(world.head, 'handoff'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /there is no work to hand off yet/)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0)
})

// --- cluster mode: review fixes ---

/** Mount a context meter that reports one fixed pressure ratio for every session. */
function withPressure(world, ratio) {
  const original = world.engine.ctx.get
  world.engine.ctx.get = name => (name === 'tokenMeter'
    ? { contextPressure: () => ({ pressureTokens: Math.round(ratio * 1000), contextWindow: 1000 }), measure: () => ({ totalTokens: 0 }) }
    : original(name))
}

/** A launched two-group cluster whose head and both workers have plugin-created goals. */
async function launchedWithGoals(overrides = {}) {
  const world = clusterWorld(overrides)
  const goals = withGoals(world)
  proposeTwoGroups(world)
  await world.engine.launchCluster({ chainId: world.chain.chainId })
  return { world, goals }
}

/** Mark features as passing the way a session would, with evidence strong enough for finish. */
const passFeatures = (world, ids) => world.local.patchFeatures(
  world.chain.chainId,
  ids.map(id => ({ id, passes: true, evidence: 'node x.mjs -> exit 0, 3/3 passed' })),
)

await checkAsync('the list is frozen at launch: renames and additions made while planning are accepted', async () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  proposeTwoGroups(world)
  const edited = world.local.readFeatures(chainId)
  edited.features.find(feature => feature.id === 'F005').title = 'fifth, renamed'
  edited.features.push({ id: 'F007', title: 'seventh', verify: 'node seven.mjs', files: ['src/c'] })
  world.local.writeFeatures(chainId, edited)
  world.engine.proposeCluster({
    agent: world.head,
    groups: [clusterGroup('left', ['F002', 'F004']), clusterGroup('right', ['F003', 'F006']), clusterGroup('extra', ['F007'])],
  })
  assert.equal(world.engine.fingerprints.get(chainId), undefined)
  await world.engine.launchCluster({ chainId })
  assert.equal(auditOf(world, 'features.frozen').length, 1)
  assert.equal(auditOf(world, 'features.frozen')[0].actor, 'host')
  assert.deepEqual(auditOf(world, 'features.frozen')[0].detail, { features: 7 })
  assert.doesNotThrow(() => world.engine.checkpoint({ agent: world.head, note: 'after the launch' }))
  const later = world.local.readFeatures(chainId)
  later.features.find(feature => feature.id === 'F005').title = 'renamed by hand'
  world.local.writeFeatures(chainId, later)
  assert.throws(() => world.engine.checkpoint({ agent: world.head, note: 'x' }), refusal(/no longer matches the frozen list/, RELAY_CODES.drift))
})

check('a checkpoint during planning does not freeze the list', () => {
  const world = clusterWorld()
  world.engine.checkpoint({ agent: world.head, note: 'planning notes' })
  assert.equal(world.engine.fingerprints.get(world.chain.chainId), undefined)
  assert.equal(auditOf(world, 'features.frozen').length, 0)
  assert.equal(world.local.readChain(world.chain.chainId).status, 'planning')
})

await checkAsync('blockers and blocked reports never move a planning chain out of planning', async () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  const chain = () => world.local.readChain(chainId)
  const first = world.engine.checkpoint({ agent: world.head, blocked: true, note: 'need a decision' })
  assert.equal(first.status, 'planning')
  assert.equal(first.paused, false)
  assert.equal(chain().status, 'planning')
  assert.equal(chain().pausedBy ?? null, null)
  assert.equal(chain().lastError, 'need a decision', 'the note stays visible')
  world.engine.checkpoint({ agent: world.head, blocker: { kind: 'external', who: 'human', action: 'supply the API key' } })
  assert.equal(chain().status, 'planning')
  assert.equal(chain().pausedBy ?? null, null)
  assert.equal(chain().blocker.action, 'supply the API key', 'the blocker is still recorded')
  const cleared = world.engine.clearBlocker({ chainId })
  assert.equal(cleared.cleared, true)
  assert.equal(cleared.status, 'planning')
  assert.equal(chain().blocker, null)
  proposeTwoGroups(world)
  assert.equal((await world.engine.launchCluster({ chainId })).status, 'active')
})

await checkAsync('a blocked goal on the planning head records the blocker but keeps the chain planning; the launch waits for it', async () => {
  const world = clusterWorld()
  const goals = withGoals(world, { 'session-head': goalView({ phase: 'blocked', blockedReason: { code: 'stuck', message: 'needs a human' } }) })
  await world.engine.evaluate(world.head)
  const chain = world.local.readChain(world.chain.chainId)
  assert.equal(chain.status, 'planning')
  assert.match(chain.blocker.action, /needs a human/)
  proposeTwoGroups(world)
  const launch = () => world.engine.launchCluster({ chainId: world.chain.chainId })
  await assert.rejects(launch, refusal(/has an open blocker \("goal blocked: needs a human/))
  assert.throws(() => world.engine.clearBlocker({ chainId: world.chain.chainId }), refusal(/follows a blocked goal/))
  goals.views.get('session-head').phase = 'active'
  await world.engine.evaluate(world.head)
  assert.equal(world.local.readChain(world.chain.chainId).blocker, null, 'the goal letting go releases the blocker')
  assert.equal((await launch()).status, 'active')
})

await checkAsync('a goal blocker whose goal no longer blocks stops refusing the launch without any evaluation; preview leaves it alone and launch clears it', async () => {
  for (const release of [
    goals => { goals.views.get('session-head').phase = 'active' },
    goals => { goals.views.delete('session-head') },
  ]) {
    const world = clusterWorld()
    const chainId = world.chain.chainId
    const goals = withGoals(world, { 'session-head': goalView({ phase: 'blocked', blockedReason: { code: 'stuck', message: 'needs a human' } }) })
    await world.engine.evaluate(world.head)
    proposeTwoGroups(world)
    assert.match(world.local.readChain(chainId).blocker.action, /^goal blocked: needs a human/)
    const blocked = world.engine.previewCluster({ chainId })
    assert.deepEqual(blocked.issues.map(issue => issue.code), ['blocker'], 'the goal still blocks')
    assert.match(blocked.issues[0].action, /^goal blocked: needs a human/)
    await assert.rejects(() => world.engine.launchCluster({ chainId }), refusal(/has an open blocker \("goal blocked: needs a human/))
    release(goals)
    const stored = world.local.readChain(chainId)
    assert.deepEqual(world.engine.previewCluster({ chainId }), { issues: [], conflicts: [], waiting: [] })
    assert.deepEqual(world.local.readChain(chainId).blocker, stored.blocker, 'a preview writes nothing')
    assert.equal((await world.engine.launchCluster({ chainId })).status, 'active')
    assert.equal(world.local.readChain(chainId).blocker, null, 'the launch cleared the blocker the goal no longer owns')
  }
  // A blocker somebody else recorded is never judged by the goal.
  const world = clusterWorld()
  withGoals(world, { 'session-head': goalView() })
  world.engine.checkpoint({ agent: world.head, blocker: { kind: 'external', who: 'human', action: 'supply the API key' } })
  proposeTwoGroups(world)
  assert.deepEqual(world.engine.previewCluster({ chainId: world.chain.chainId }).issues.map(issue => issue.code), ['blocker'])
})

await checkAsync('a blocker recorded by the supervisor itself pauses the worker goals at once', async () => {
  const { world, goals } = await launchedWithGoals()
  const { engine, local, chain } = world
  engine.recordBlocker(local, chain.chainId, { kind: 'external', who: 'human', action: 'continue limit reached' })
  assert.equal(local.readChain(chain.chainId).status, 'paused')
  assert.equal(goals.views.get('session-w1').phase, 'paused', 'the worker goal kept running under a blocker pause')
  engine.recordBlocker(local, chain.chainId, null)
  assert.equal(goals.views.get('session-w1').phase, 'active')
})

await checkAsync('launchCluster refuses while an external blocker is open and works after it is cleared', async () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  world.engine.checkpoint({ agent: world.head, blocker: { kind: 'external', who: 'human', action: 'supply the API key' } })
  proposeTwoGroups(world)
  await assert.rejects(
    () => world.engine.launchCluster({ chainId }),
    refusal(new RegExp(`chain ${chainId} has an open blocker \\("supply the API key"\\); clear it before launching`)),
  )
  assert.equal(world.local.readChain(chainId).status, 'planning')
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 0, 'nothing may be created by a refused launch')
  world.engine.clearBlocker({ chainId })
  assert.equal((await world.engine.launchCluster({ chainId })).status, 'active')
})

check('a normal checkpoint ends the stale blocked note of a planning chain; proposing does too', () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  world.engine.checkpoint({ agent: world.head, blocked: true, note: 'need a decision' })
  assert.equal(world.local.readChain(chainId).lastError, 'need a decision')
  world.engine.checkpoint({ agent: world.head, note: 'decided' })
  assert.equal(world.local.readChain(chainId).lastError, null)
  world.engine.checkpoint({ agent: world.head, blocked: true, note: 'blocked again' })
  assert.equal(world.local.readChain(chainId).lastError, 'blocked again')
  proposeTwoGroups(world)
  assert.equal(world.local.readChain(chainId).lastError, null)
})

check('a planning chain cannot be finished, even when every feature already passes', () => {
  const world = clusterWorld({ requireStrongEvidence: false })
  passFeatures(world, ['F002', 'F003', 'F004', 'F005', 'F006'])
  assert.throws(() => world.engine.finish({ agent: world.head, evidence: 'done' }), refusal(/is planning; launch it or delete it/))
  assert.equal(world.local.readChain(world.chain.chainId).status, 'planning')
})

check('clusterConflicts also compares shared groups with the work the planning session keeps', () => {
  const feature = (id, files, extra = {}) => ({ id, title: id, passes: false, assignedSessionId: null, ...(files === undefined ? {} : { files }), ...extra })
  const shared = (id, features) => ({ id, isolation: 'shared', features })
  const worktree = (id, features) => ({ id, isolation: 'worktree', features })
  const wt = clusterConflicts({ features: [feature('A', ['src/api']), feature('B', ['src/api/user.js'])] }, [shared('G1', ['A']), worktree('G2', ['B'])])
  assert.deepEqual(wt, [{ kind: 'overlap', groups: ['G1', 'main'], features: ['A', 'B'], path: 'src/api' }])
  const doc = {
    features: [
      feature('A', ['src/api']),
      feature('C', ['src/api/x.js']),
      feature('D', ['src/api'], { passes: true }),
      feature('E', ['src/api'], { assignedSessionId: 'session-w9' }),
      feature('F'),
    ],
  }
  assert.deepEqual(
    clusterConflicts(doc, [shared('G1', ['A'])]),
    [{ kind: 'overlap', groups: ['G1', 'main'], features: ['A', 'C'], path: 'src/api' }],
    'a passing or delegated feature is not the planning session\'s work, and a scopeless one adds no unknown-scope',
  )
})

check('clusterConflicts normalises ./, case, trailing slashes and the working directory', () => {
  const feature = (id, files) => ({ id, title: id, passes: false, files: [files] })
  const pair = (left, right, cwd) => clusterConflicts(
    { features: [feature('A', left), feature('B', right)] },
    [{ id: 'G1', isolation: 'shared', features: ['A'] }, { id: 'G2', isolation: 'shared', features: ['B'] }],
    cwd,
  )
  assert.deepEqual(pair('./src/api', 'src/api/user.js').map(item => item.path), ['src/api'])
  assert.deepEqual(pair('././src/api/', 'src/api/user.js').map(item => item.path), ['src/api'])
  assert.deepEqual(pair('Src/Api', 'src/api').map(item => item.path), ['src/api'])
  assert.deepEqual(pair('D:\\Work\\Proj\\src\\api\\user.js', 'src/api', 'd:/work/proj/').map(item => item.path), ['src/api'])
  assert.deepEqual(pair('D:\\Work\\Proj\\src\\api', 'src/api/user.js', 'D:\\Work\\Proj').map(item => item.path), ['src/api'])
  assert.deepEqual(pair('D:/work/proj2/src/api', 'src/api', 'D:/work/proj'), [], 'a sibling directory that merely starts with the cwd is not under it')
  assert.deepEqual(pair('src/api', 'src/apis'), [], 'a name prefix is not a directory prefix')
})

check('clusterConflicts resolves ., .., empty and doubled segments', () => {
  const feature = (id, files) => ({ id, title: id, passes: false, files: [files] })
  const pair = (left, right, cwd) => clusterConflicts(
    { features: [feature('A', left), feature('B', right)] },
    [{ id: 'G1', isolation: 'shared', features: ['A'] }, { id: 'G2', isolation: 'shared', features: ['B'] }],
    cwd,
  )
  assert.deepEqual(pair('.', 'src/api').map(item => item.path), [''], '. is the whole working directory')
  assert.deepEqual(pair('./', 'src/api').map(item => item.path), [''], './ is the whole working directory')
  assert.deepEqual(pair('D:/work/proj', 'src/api', 'D:/work/proj').map(item => item.path), [''], 'the working directory itself is the whole working directory')
  assert.deepEqual(pair('a/./b', 'a/b').map(item => item.path), ['a/b'])
  assert.deepEqual(pair('a//b', 'a/b/c.js').map(item => item.path), ['a/b'])
  assert.deepEqual(pair('a/b/../c', 'a/c/x.js').map(item => item.path), ['a/c'])
  assert.deepEqual(pair('../x', 'x'), [], 'a leading .. stays and is not the working directory')
  assert.deepEqual(pair('../x', '../x').map(item => item.path), ['../x'])
  assert.deepEqual(pair('a/..', 'src/api').map(item => item.path), [''], 'a/.. resolves to the working directory')
})

check('clusterConflicts resolves a relative path against the working directory and keeps outside locations apart', () => {
  const feature = (id, files) => ({ id, title: id, passes: false, files: [files] })
  const pair = (left, right, cwd) => clusterConflicts(
    { features: [feature('A', left), feature('B', right)] },
    [{ id: 'G1', isolation: 'shared', features: ['A'] }, { id: 'G2', isolation: 'shared', features: ['B'] }],
    cwd,
  )
  const cwd = 'D:/work/proj'
  assert.deepEqual(pair('../proj/src/a', 'src/a', cwd).map(item => item.path), ['src/a'], '../proj/ comes back into the working directory')
  assert.deepEqual(pair('D:/work/x/../proj/src/a', 'src/a', cwd).map(item => item.path), ['src/a'], '.. inside an absolute path is resolved')
  assert.deepEqual(pair('/src/api', 'src/api', cwd), [], 'a root-relative path is outside the working directory')
  assert.deepEqual(pair('.', 'src/api', cwd).map(item => item.path), [''], '. under a cwd is the working directory')
  assert.deepEqual(pair('d:\\WORK\\Proj\\Src\\a', 'src/a', 'D:\\work\\proj\\').map(item => item.path), ['src/a'], 'trailing slash and mixed case on the cwd')
  assert.deepEqual(pair('../x', 'x', cwd), [], 'a path above the working directory is not inside it')
  assert.deepEqual(pair('../x', '../x').map(item => item.path), ['../x'], 'without a cwd a relative path stays relative')
  assert.deepEqual(pair('/src/api', 'src/api'), [], 'without a cwd an absolute path is still not a relative one')
})

check('a feature scoped to . overlaps a feature of another shared group', () => {
  const doc = { features: [
    { id: 'A', title: 'a', passes: false, files: ['.'] },
    { id: 'B', title: 'b', passes: false, files: ['src/api'] },
  ] }
  const result = clusterConflicts(doc, [{ id: 'G1', isolation: 'shared', features: ['A'] }, { id: 'G2', isolation: 'shared', features: ['B'] }])
  assert.deepEqual(result, [{ kind: 'overlap', groups: ['G1', 'G2'], features: ['A', 'B'], path: '' }])
})

check('proposeCluster refuses a dependsOn id that is not in features.json', () => {
  const world = clusterWorld()
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'cluster objective',
    features: [{ id: 'F002', title: 'second', dependsOn: ['F01'] }, { id: 'F003', title: 'third' }],
  })
  const propose = groups => () => world.engine.proposeCluster({ agent: world.head, groups })
  assert.throws(propose([clusterGroup('a', ['F002'])]), refusal(/feature F002 depends on F01, which is not in features\.json/))
  assert.equal(world.local.readChain(world.chain.chainId).launchPlan, undefined)
  assert.doesNotThrow(propose([clusterGroup('b', ['F003'])]), 'a feature nobody depends on from a missing id is unaffected')
})

check('scope fields are read leniently: a single string, mixed arrays, nothing usable', () => {
  const world = clusterWorld()
  world.local.writeFeatures(world.chain.chainId, {
    version: 1,
    objective: 'cluster objective',
    features: [
      { id: 'F001', title: 'a', dependsOn: 'F002' },
      { id: 'F002', title: 'b', dependsOn: ['F001', '', 3], files: ['  src/x  ', ' '] },
      { id: 'F003', title: 'c', dependsOn: 42, files: [] },
    ],
  })
  const features = world.local.readFeatures(world.chain.chainId).features
  assert.deepEqual(features[0].dependsOn, ['F002'])
  assert.deepEqual(features[1].dependsOn, ['F001'])
  assert.deepEqual(features[1].files, ['src/x'])
  assert.equal('dependsOn' in features[2], false)
  assert.equal('files' in features[2], false)
})

check('relay_checkpoint addFeatures accepts files and dependsOn and stores them', () => {
  const world = clusterWorld()
  const registered = new Map()
  registerTools({ tools: { register: definition => registered.set(definition.name, definition) } }, world.engine)
  const checkpoint = registered.get('relay_checkpoint')
  const item = checkpoint.parameters.properties.addFeatures.items.properties
  assert.deepEqual(item.files, { type: 'array', items: { type: 'string' } })
  assert.deepEqual(item.dependsOn, { type: 'array', items: { type: 'string' } })
  const result = checkpoint.execute({
    addFeatures: [{ id: 'F007', title: 'seventh', files: ['src/z'], dependsOn: ['F002'] }],
    reason: 'found while planning',
  }, { agent: world.head })
  assert.equal(result.ok, true, result.message)
  const added = world.local.readFeatures(world.chain.chainId).features.find(feature => feature.id === 'F007')
  assert.deepEqual(added.files, ['src/z'])
  assert.deepEqual(added.dependsOn, ['F002'])
})

/** The worker entry's record of a goal pause the plugin made. */
const pausedFlag = (world, sessionId) => world.local.readChain(world.chain.chainId).sessions.find(session => session.sessionId === sessionId).goalPausedByRelay

await checkAsync('a worker whose features are returned for pressure has its seeded goal paused and flagged', async () => {
  const { world, goals } = await launchedWithGoals()
  withPressure(world, 0.9)
  await world.engine.evaluate(world.agents.get('session-w1'))
  assert.deepEqual(goals.ops('pause'), [{ op: 'pause', agentId: 'session-w1', id: 'goal-for-session-w1', revision: 1 }])
  assert.deepEqual(auditOf(world, 'goal.paused')[0].detail, { sessionId: 'session-w1', goalId: 'goal-for-session-w1', why: 'no-work' })
  assert.equal(auditOf(world, 'goal.paused')[0].actor, 'system')
  assert.equal(pausedFlag(world, 'session-w1'), true)
  assert.equal(pausedFlag(world, 'session-w2'), undefined)
  assert.equal(goals.views.get('session-w2').phase, 'active')
})

await checkAsync('reclaiming a worker pauses its seeded goal and flags it', async () => {
  const { world, goals } = await launchedWithGoals()
  world.engine.reclaimDelegation({ agent: world.head, sessionId: 'session-w2' })
  assert.deepEqual(goals.ops('pause').map(op => op.agentId), ['session-w2'])
  assert.equal(auditOf(world, 'goal.paused')[0].detail.why, 'no-work')
  assert.equal(pausedFlag(world, 'session-w2'), true)
  assert.equal(goals.views.get('session-w1').phase, 'active')
})

await checkAsync('the chain pausing, by the panel, by a session itself or by an external blocker, pauses the worker goals', async () => {
  const panel = await launchedWithGoals()
  panel.world.engine.setPaused({ chainId: panel.world.chain.chainId, paused: true })
  assert.deepEqual(panel.goals.ops('pause').map(op => op.agentId).sort(), ['session-head', 'session-w1', 'session-w2'])
  assert.deepEqual(auditOf(panel.world, 'goal.paused').filter(record => record.detail.sessionId !== 'session-head').map(record => record.detail.why), ['chain-paused', 'chain-paused'])
  assert.equal(pausedFlag(panel.world, 'session-w1'), true)

  const own = await launchedWithGoals()
  own.world.engine.setPaused({ agent: own.world.head, chainId: own.world.chain.chainId, paused: true })
  assert.deepEqual(own.goals.ops('pause').map(op => op.agentId).sort(), ['session-w1', 'session-w2'], 'a session pausing its own chain leaves its own goal alone')

  const blocked = await launchedWithGoals()
  blocked.world.engine.checkpoint({ agent: blocked.world.head, blocker: { kind: 'external', who: 'human', action: 'supply the API key' } })
  assert.equal(blocked.world.local.readChain(blocked.world.chain.chainId).status, 'paused')
  assert.deepEqual(blocked.goals.ops('pause').map(op => op.agentId).sort(), ['session-w1', 'session-w2'])
})

await checkAsync('resuming through setPaused or clearBlocker resumes the worker goals that still own work, and only those the plugin paused', async () => {
  const { world, goals } = await launchedWithGoals()
  const chainId = world.chain.chainId
  goals.views.get('session-w2').phase = 'paused'
  world.engine.setPaused({ chainId, paused: true })
  assert.deepEqual(goals.ops('pause').map(op => op.agentId).sort(), ['session-head', 'session-w1'])
  world.engine.setPaused({ chainId, paused: false })
  assert.deepEqual(goals.ops('resume').map(op => op.agentId).sort(), ['session-head', 'session-w1'])
  assert.equal(goals.views.get('session-w2').phase, 'paused', 'a pause a human made stays')
  assert.equal(pausedFlag(world, 'session-w1'), undefined, 'the flag is spent by the resume')
  assert.ok(auditOf(world, 'goal.resumed').some(record => record.detail.sessionId === 'session-w1' && record.actor === 'system'))

  const finished = await launchedWithGoals()
  finished.world.engine.setPaused({ chainId: finished.world.chain.chainId, paused: true })
  passFeatures(finished.world, ['F002', 'F004'])
  finished.world.engine.setPaused({ chainId: finished.world.chain.chainId, paused: false })
  assert.deepEqual(finished.goals.ops('resume').map(op => op.agentId), ['session-head', 'session-w2'], 'w1 has nothing left to do and stays paused; w2 still owns work')

  const blocked = await launchedWithGoals()
  const blockedId = blocked.world.chain.chainId
  blocked.world.engine.checkpoint({ agent: blocked.world.head, blocker: { kind: 'external', who: 'human', action: 'supply the API key' } })
  passFeatures(blocked.world, ['F002', 'F004'])
  blocked.world.engine.clearBlocker({ chainId: blockedId })
  assert.equal(blocked.world.local.readChain(blockedId).status, 'active')
  assert.deepEqual(blocked.goals.ops('resume').map(op => op.agentId), ['session-w2'], 'w1 owns nothing now; the head goal was never paused')
})

await checkAsync('a goal a human resumed by hand drops the pause flag, so a later human pause is never undone', async () => {
  const { world, goals } = await launchedWithGoals()
  const chainId = world.chain.chainId
  world.engine.setPaused({ chainId, paused: true })
  assert.equal(goals.views.get('session-w1').phase, 'paused')
  assert.equal(pausedFlag(world, 'session-w1'), true)
  goals.views.get('session-w1').phase = 'active'
  world.engine.setPaused({ chainId, paused: false })
  assert.equal(pausedFlag(world, 'session-w1'), undefined, 'a human took the goal over: the flag is dropped')
  assert.deepEqual(goals.ops('resume').map(op => op.agentId), ['session-head', 'session-w2'], 'the plugin resumed nobody it had not paused')
  goals.views.get('session-w1').phase = 'paused'
  world.engine.checkpoint({ agent: world.head, note: 'any session reports in' })
  world.engine.checkpoint({ agent: world.agents.get('session-w2'), note: 'a worker reports in' })
  assert.equal(goals.views.get('session-w1').phase, 'paused', 'a pause a human made after that stays')
  assert.ok(!goals.ops('resume').some(op => op.agentId === 'session-w1'))
})

await checkAsync('workers paused by a failed handoff get their goals back when the retry succeeds', async () => {
  const { world, goals } = await launchedWithGoals({ failCreate: [3] })
  const chainId = world.chain.chainId
  await assert.rejects(() => world.engine.handoff(world.local.readChain(chainId), world.head, 'manual'), refusal(/create 3 refused/, RELAY_CODES.io))
  assert.equal(world.local.readChain(chainId).status, 'paused')
  assert.deepEqual(goals.ops('pause').map(op => op.agentId).sort(), ['session-w1', 'session-w2'])
  assert.equal(pausedFlag(world, 'session-w1'), true)
  await world.engine.handoff(world.local.readChain(chainId), world.head, 'manual')
  assert.equal(world.local.readChain(chainId).status, 'active')
  assert.deepEqual(goals.ops('resume').map(op => op.agentId).filter(id => id !== 'session-head').sort(), ['session-w1', 'session-w2'])
  assert.equal(goals.views.get('session-w1').phase, 'active')
  assert.equal(pausedFlag(world, 'session-w1'), undefined)
})

await checkAsync('a recovered pending handoff gives the worker goals back', async () => {
  const { world, goals } = await launchedWithGoals()
  const chainId = world.chain.chainId
  world.engine.setPaused({ chainId, paused: true })
  assert.equal(goals.views.get('session-w1').phase, 'paused')
  world.makeAgent('session-w9')
  world.local.update(chainId, record => {
    record.sessions.push({ sessionId: 'session-w9', role: 'worker', index: 1, joinedAt: new Date().toISOString(), parentSessionId: null })
    record.pendingHandoff = { sessionId: 'session-w9', createdAt: new Date().toISOString(), reason: 'failed: x' }
  })
  world.engine.reconcilePendingHandoff(world.local.readChain(chainId), world.local)
  assert.equal(auditOf(world, 'handoff.recovered').length, 1)
  assert.equal(world.local.readChain(chainId).status, 'active')
  assert.deepEqual(goals.ops('resume').map(op => op.agentId).filter(id => id !== 'session-head').sort(), ['session-w1', 'session-w2'])
  assert.equal(goals.views.get('session-w2').phase, 'active')
})

await checkAsync('evaluating the head of an active cluster chain gives back the worker goals the plugin paused', async () => {
  const { world, goals } = await launchedWithGoals()
  const chainId = world.chain.chainId
  world.engine.setPaused({ chainId, paused: true })
  assert.equal(goals.views.get('session-w1').phase, 'paused')
  // Whatever path moved the chain back to active, without a sync of its own.
  world.local.update(chainId, record => { record.status = 'active'; record.pausedBy = null })
  assert.equal(goals.views.get('session-w1').phase, 'paused')
  await world.engine.evaluate(world.head)
  assert.equal(goals.views.get('session-w1').phase, 'active')
  assert.equal(goals.views.get('session-w2').phase, 'active')
  assert.equal(pausedFlag(world, 'session-w1'), undefined)
})

await checkAsync('a worker that is not loaded when the chain resumes gets its goal back once it is loaded and idle', async () => {
  const { world, goals } = await launchedWithGoals()
  const chainId = world.chain.chainId
  const worker = world.agents.get('session-w1')
  world.engine.setPaused({ chainId, paused: true })
  assert.equal(goals.views.get('session-w1').phase, 'paused')
  world.agents.delete('session-w1')
  world.engine.setPaused({ chainId, paused: false })
  assert.deepEqual(goals.ops('resume').map(op => op.agentId), ['session-head', 'session-w2'], 'an unloaded worker cannot be resumed')
  assert.equal(pausedFlag(world, 'session-w1'), true, 'the flag waits for the session')
  world.agents.set('session-w1', worker)
  world.engine.sessionLoaded('session-w1')
  await world.engine.evaluate(worker)
  assert.deepEqual(goals.ops('resume').map(op => op.agentId), ['session-head', 'session-w2', 'session-w1'])
  assert.equal(goals.views.get('session-w1').phase, 'active')
  assert.equal(pausedFlag(world, 'session-w1'), undefined)
})

await checkAsync('finish completes the seeded goals of workers whose goal is active or paused, and of a worker loaded only afterwards', async () => {
  const { world, goals } = await launchedWithGoals({ requireStrongEvidence: false })
  const late = world.agents.get('session-w1')
  goals.views.get('session-w2').phase = 'paused'
  world.agents.delete('session-w1')
  passFeatures(world, ['F002', 'F003', 'F004', 'F005', 'F006'])
  const result = world.engine.finish({ agent: world.head, evidence: 'everything passes' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(goals.ops('complete').map(op => op.agentId).sort(), ['session-head', 'session-w2'], 'an unloaded worker is not reachable yet')
  assert.equal(auditOf(world, 'goal.completed').length, 2)
  world.agents.set('session-w1', late)
  await world.engine.evaluate(late)
  assert.deepEqual(goals.ops('complete').map(op => op.agentId).sort(), ['session-head', 'session-w1', 'session-w2'])
  assert.equal(goals.views.get('session-w1').phase, 'complete')
  assert.equal(auditOf(world, 'goal.completed').length, 3)
})

await checkAsync('a goal a human paused on a worker, and a goal the user created, are never touched', async () => {
  const { world, goals } = await launchedWithGoals()
  const chainId = world.chain.chainId
  goals.views.get('session-w1').phase = 'paused'
  world.engine.setPaused({ chainId, paused: true })
  world.engine.setPaused({ chainId, paused: false })
  await world.engine.evaluate(world.agents.get('session-w1'))
  assert.equal(goals.views.get('session-w1').phase, 'paused')
  assert.ok(!goals.ops('pause').concat(goals.ops('resume')).some(op => op.agentId === 'session-w1'))
})

await checkAsync('a disarmed seeded worker goal is re-armed once per session load', async () => {
  const { world, goals } = await launchedWithGoals()
  const worker = world.agents.get('session-w1')
  goals.views.get('session-w1').activation = 'disarmed'
  await world.engine.evaluate(worker)
  assert.equal(goals.ops('resume').length, 0, 'the goal was created in this process, so the load has nothing to re-arm')
  world.engine.sessionLoaded('session-w1')
  await world.engine.evaluate(worker)
  assert.deepEqual(goals.ops('resume').map(op => op.agentId), ['session-w1'])
  assert.deepEqual(auditOf(world, 'goal.rearmed')[0].detail, { sessionId: 'session-w1', goalId: 'goal-for-session-w1' })
  goals.views.get('session-w1').activation = 'disarmed'
  await world.engine.evaluate(worker)
  assert.equal(goals.ops('resume').length, 1, 'a goal disarmed later is somebody\'s decision')
})

await checkAsync('a goal the user created on a worker is never paused, completed or re-armed', async () => {
  const world = clusterWorld({ clusterGoals: false, requireStrongEvidence: false })
  const chainId = world.chain.chainId
  const goals = withGoals(world, { 'session-w1': goalView({ id: 'goal-user', roundsStarted: 0, activation: 'disarmed' }), 'session-w2': goalView({ id: 'goal-user-2', roundsStarted: 0 }) })
  proposeTwoGroups(world)
  await world.engine.launchCluster({ chainId })
  // A goal id on the entry without `goalSeeded` is not the plugin's either.
  world.local.update(chainId, record => { record.sessions.find(session => session.sessionId === 'session-w1').goalId = 'goal-user' })
  world.engine.sessionLoaded('session-w1')
  await world.engine.evaluate(world.agents.get('session-w1'))
  withPressure(world, 0.9)
  await world.engine.evaluate(world.agents.get('session-w2'))
  world.engine.setPaused({ chainId, paused: true })
  world.engine.setPaused({ chainId, paused: false })
  world.engine.reclaimDelegation({ agent: world.head, sessionId: 'session-w1' })
  passFeatures(world, ['F002', 'F003', 'F004', 'F005', 'F006'])
  assert.equal(world.engine.finish({ agent: world.head, evidence: 'all pass' }).ok, true)
  for (const op of ['pause', 'resume', 'complete']) assert.deepEqual(goals.ops(op), [], `${op} must not touch a user goal`)
})

await checkAsync('one evaluation re-arms the head goal and still opens a releasable waiting group', async () => {
  const world = clusterWorld()
  const chainId = world.chain.chainId
  const goals = withGoals(world)
  world.engine.proposeCluster({ agent: world.head, groups: [clusterGroup('late', ['F004']), clusterGroup('now', ['F003'])] })
  await world.engine.launchCluster({ chainId })
  passFeatures(world, ['F002'])
  goals.views.get('session-head').activation = 'disarmed'
  world.engine.sessionLoaded('session-head')
  const opened = []
  const original = world.engine.launchWaitingGroups.bind(world.engine)
  world.engine.launchWaitingGroups = id => { const settled = original(id); opened.push(settled); return settled }
  await world.engine.evaluate(world.head)
  await Promise.all(opened)
  assert.deepEqual(goals.ops('resume').map(op => op.agentId), ['session-head'])
  assert.equal(auditOf(world, 'goal.rearmed').length, 1)
  assert.equal(opened.length, 1)
  assert.equal(world.calls.filter(call => call.kind === 'create').length, 2, 'the waiting group was opened')
})

await checkAsync('a busy chain does not spend the head\'s re-arm attempt', async () => {
  const { world } = await launchedWithGoals()
  const chainId = world.chain.chainId
  world.engine.sessionLoaded('session-head')
  const chain = world.local.readChain(chainId)
  world.engine.busyChains.add(chainId)
  world.engine.rearmGoal(chain, world.local, world.head, chain.sessions.find(session => session.sessionId === 'session-head'))
  world.engine.busyChains.delete(chainId)
  assert.equal(world.engine.statsFor('session-head').rearmChecked, false)
})

await checkAsync('the agent/created handler schedules an evaluation for every session of a chain, worker or head, and for no other', async () => {
  const { world } = await launchedWithGoals()
  const handlers = new Map()
  const cleanups = []
  const ctx = {
    logger: { warn: () => {} },
    get: name => world.engine.ctx.get(name),
    provide: () => {},
    effect: (fn) => { cleanups.push(fn()) },
    on: (event, handler) => { handlers.set(event, handler); return () => {} },
    inject: () => {},
    tools: { register: () => () => {} },
  }
  const scheduled = []
  const original = RelayEngine.prototype.scheduleEvaluate
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'relay-apply-home-'))
  RelayEngine.prototype.scheduleEvaluate = function record(sessionId, delayMs) { scheduled.push([sessionId, delayMs]) }
  try {
    applyPlugin(ctx, {})
    const created = handlers.get('agent/created')
    assert.equal(typeof created, 'function')
    created({ agent: world.agents.get('session-w1') })
    created({ agent: world.head })
    const stranger = world.makeAgent('session-stranger')
    stranger.session.header.cwd = mkdtempSync(join(tmpdir(), 'relay-stranger-'))
    created({ agent: stranger })
    assert.deepEqual(scheduled, [['session-w1', 2000], ['session-head', 2000]])
  } finally {
    RelayEngine.prototype.scheduleEvaluate = original
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
  }
})

// --- bulk coverage acceptance and plugin self-update ---

await checkAsync('many partial features are accepted in one write', async () => {
  const world = fakeWorld()
  world.local.patchFeatures(world.chain.chainId, [
    { id: 'F001', passes: true, evidence: 'ran it, exit 0', coverage: 'partial' },
  ])
  const result = world.engine.acceptCoverageMany({ chainId: world.chain.chainId })
  assert.equal(result.accepted, 1)
  assert.equal(world.local.readFeatures(world.chain.chainId).features[0].acceptedBy, 'human')
  const again = world.engine.acceptCoverageMany({ chainId: world.chain.chainId })
  assert.equal(again.accepted, 0, 'an accepted feature must not be accepted twice')
})

await checkAsync('finish succeeds after partial coverage is accepted', async () => {
  const world = fakeWorld({ requireHumanAcceptedCoverage: true })
  world.local.patchFeatures(world.chain.chainId, [
    { id: 'F001', passes: true, evidence: 'npm test exit 0: 42/42 passed', coverage: 'partial' },
  ])
  const refused = world.engine.finish({ agent: world.oldAgent, evidence: 'npm test exit 0: 42/42 passed' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, RELAY_CODES.incomplete)
  world.engine.acceptCoverageMany({ chainId: world.chain.chainId })
  const result = world.engine.finish({ agent: world.oldAgent, evidence: 'npm test exit 0: 42/42 passed' })
  assert.equal(result.ok, true)
})

/** Build a git working tree whose upstream holds one newer commit. */
async function updateFixture() {
  const base = mkdtempSync(join(tmpdir(), 'relay-update-'))
  const remoteDir = join(base, 'origin.git')
  const workDir = join(base, 'work')
  const peerDir = join(base, 'peer')
  const pkgRel = 'dsh-longtask-relay-1.1.0/package'
  const pkgDir = join(workDir, pkgRel)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-longtask-relay', version: '1.0.0' }))
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true })
  mkdirSync(remoteDir)
  git(remoteDir, 'init', '--bare', '-b', 'main')
  git(workDir, 'init', '-b', 'main')
  git(workDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
  git(workDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'v1.0.0')
  git(workDir, 'remote', 'add', 'origin', remoteDir)
  git(workDir, 'push', '-u', 'origin', 'main')
  git(base, 'clone', remoteDir, peerDir)
  writeFileSync(join(peerDir, pkgRel, 'package.json'), JSON.stringify({ name: 'dsh-longtask-relay', version: '1.1.0' }))
  git(peerDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
  git(peerDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'v1.1.0')
  git(peerDir, 'push')
  return { base, pkgDir }
}

await checkAsync('the update check sees commits behind the upstream branch', async () => {
  const { base, pkgDir } = await updateFixture()
  const check = await checkPluginUpdate(pkgDir, { wait: true })
  assert.equal(check.reason, 'ok')
  assert.equal(check.available, true)
  assert.equal(check.behind, 1)
  assert.equal(check.latestVersion, '1.1.0')
  assert.equal(check.dirty, false)
  const applied = await applyPluginUpdate(pkgDir)
  assert.equal(applied.ok, true)
  assert.equal(applied.version, '1.1.0')
  assert.equal(applied.reloadRequired, true)
  const after = await checkPluginUpdate(pkgDir, { wait: true })
  assert.equal(after.available, false)
  rmSync(base, { recursive: true, force: true })
})

await checkAsync('an update refuses a dirty working tree', async () => {
  const { base, pkgDir } = await updateFixture()
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-longtask-relay', version: '1.0.0', dirty: true }))
  const applied = await applyPluginUpdate(pkgDir)
  assert.equal(applied.ok, false)
  assert.equal(applied.reason, 'dirty')
  rmSync(base, { recursive: true, force: true })
})

await checkAsync('an update check reports a package outside git', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-nogit-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-longtask-relay', version: '1.0.0' }))
  const check = await checkPluginUpdate(dir)
  assert.equal(check.reason, 'not-git')
  assert.equal(check.currentVersion, '1.0.0')
  const applied = await applyPluginUpdate(dir)
  assert.equal(applied.ok, false)
  rmSync(dir, { recursive: true, force: true })
})

await checkAsync('a hand-edited acceptedBy does not release the coverage gate', async () => {
  const world = fakeWorld({ requireHumanAcceptedCoverage: true })
  world.local.patchFeatures(world.chain.chainId, [
    {
      id: 'F001',
      passes: true,
      evidence: 'npm test exit 0: 42/42 passed',
      coverage: 'partial',
      acceptedBy: 'human',
    },
  ])
  const refused = world.engine.finish({ agent: world.oldAgent, evidence: 'npm test exit 0: 42/42 passed' })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /partial coverage/)
  const retried = world.engine.acceptCoverageMany({ chainId: world.chain.chainId })
  assert.equal(retried.accepted, 1, 'the panel acceptance must re-stamp a hand-written human value')
  const result = world.engine.finish({ agent: world.oldAgent, evidence: 'npm test exit 0: 42/42 passed' })
  assert.equal(result.ok, true)
})

await checkAsync('a session that wraps itself up hands off without the supervisor prompt', async () => {
  const world = fakeWorld()
  // The model sets ready itself: no wrap-up was ever requested, pressure is low.
  world.setRatio(0.2)
  world.engine.checkpoint({ agent: world.oldAgent, ready: true })
  await world.engine.evaluate(world.oldAgent)
  assert.ok(world.calls.some(call => call.kind === 'create'), 'a self-reported ready must hand off')
  assert.equal(world.local.readChain(world.chain.chainId).currentSessionId, 'session-new')
})

check('a reload re-evaluates live chain heads', () => {
  const world = fakeWorld()
  world.engine.resumeEvaluations()
  assert.ok(world.engine.timers.has('session-old'), 'an idle chain head must be re-checked after a reload')
  world.engine.dispose()
})

rmSync(workspace, { recursive: true, force: true })

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) process.exitCode = 1
