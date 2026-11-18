/**
 * Standalone checks for the relay pieces that do not need the Harness runtime.
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChainIndex, ChainStore, RELAY_CODES, RelayError } from '../lib/chain-store.js'
import { resolveConfig } from '../lib/config.js'
import { RelayEngine } from '../lib/engine.js'
import { renderHandoffPrompt, renderWrapupPrompt, stateBlockLines } from '../lib/prompts.js'
import { registerTools } from '../lib/tools.js'

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
  assert.ok(prompt.length < 2400, `handoff prompt is ${prompt.length} chars`)
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
  local.writeHandoff(chain.chainId, '# HANDOFF\n\nstart F001')

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
  const engine = new RelayEngine(ctx, config, { chainIndex: new ChainIndex(indexHome) })
  // Adopt the existing chain so the fake agent is its current session.
  local.update(chain.chainId, record => {
    record.sessions.push({ sessionId: 'session-old', role: 'initializer', index: 0, joinedAt: new Date().toISOString() })
    record.currentSessionId = 'session-old'
    record.status = 'active'
  })
  engine.members.set('session-old', { chainId: chain.chainId, truthDir: local.truthDir })
  engine.remember(local.readChain(chain.chainId), local)
  // A second engine over the same files, as after a plugin reload.
  const rebuild = () => {
    const next = new RelayEngine(ctx, config, { chainIndex: new ChainIndex(indexHome) })
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
  assert.throws(
    () => world.engine.deleteChain('chain-missing'),
    error => error instanceof RelayError && error.code === RELAY_CODES.notFound,
  )
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
  world.local.patchFeatures(world.chain.chainId, [{ id: 'F001', passes: true, evidence: 'ran npm test' }])
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
  const makeAgent = (id) => ({
    id,
    session: { id, header: { cwd: workspaceDir } },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    inject() {},
  })
  const parent = makeAgent('session-parent')
  const child = makeAgent('session-child')
  const calls = []
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
      contextPressure: () => ({ pressureTokens: 100, contextWindow: 1000 }),
      measure: () => ({ totalTokens: 100 }),
    },
    sessions: { flush: async () => true },
  }
  const ctx = { logger: { warn: () => {} }, get: name => services[name] }
  const engine = new RelayEngine(ctx, config, { chainIndex: new ChainIndex(indexHome) })
  engine.members.set('session-parent', { chainId: chain.chainId, truthDir: local.truthDir })
  engine.remember(local.readChain(chain.chainId), local)
  return { engine, local, chain, parent, child, calls, setGoal: value => { goal = value } }
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

rmSync(workspace, { recursive: true, force: true })

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) process.exitCode = 1
