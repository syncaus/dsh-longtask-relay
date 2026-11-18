/**
 * Standalone checks for the relay pieces that do not need the Harness runtime.
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChainIndex, ChainStore, RELAY_CODES, RelayError } from '../lib/chain-store.js'
import { resolveConfig } from '../lib/config.js'
import { RelayEngine } from '../lib/engine.js'
import { renderHandoffPrompt, renderWrapupPrompt } from '../lib/prompts.js'

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
  assert.equal(resolveConfig({ handoffRatio: 0.6 }).handoffRatio, 0.6)
  assert.equal(resolveConfig({}).wrapupRatio, 0.55)
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
function fakeWorld(overrides = {}) {
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
  return { engine, calls, oldAgent, newAgent, local, chain, setRatio: value => { ratio = value } }
}

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

rmSync(workspace, { recursive: true, force: true })

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) process.exitCode = 1
