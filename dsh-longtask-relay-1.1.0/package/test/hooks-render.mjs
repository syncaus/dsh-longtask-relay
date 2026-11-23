/**
 * Render-level guard for the session tabs, the launch dock, and the panel.
 *
 * `client-boot.mjs` only proves the bundle registers; it never renders a
 * component. That hid a real crash: `ChildrenTab` called `usePendingDecisions`
 * after three early returns, so the second render (when `relay/sessionView`
 * finally answers) called more hooks than the first and React threw
 * "Rendered more hooks than during the previous render", blanking the
 * conversation view.
 *
 * This file runs the registered `conversation.view` and
 * `conversation.input.dock` components against a minimal React stand-in that
 * enforces the hook-count invariant across renders, drives the async load
 * effects, and then requires each surface to render with its data.
 *
 * Run with: node test/hooks-render.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * Build a React stand-in that keeps hook cells across renders and fails the
 * same way React does when the hook count grows or shrinks.
 */
function createFakeReact() {
  /** Per-component hook storage, so two tabs never share a hook chain. */
  const stores = new Map()
  const storeFor = (component) => {
    let store = stores.get(component)
    if (store === undefined) {
      store = { cells: [], previousCount: -1, pending: false, cleanups: [] }
      stores.set(component, store)
    }
    return store
  }
  let store
  let cursor = 0
  let effectQueue = []

  const schedule = () => { store.pending = true }
  const write = (index, next) => {
    const cell = store.cells[index]
    cell.value = typeof next === 'function' ? next(cell.value) : next
    schedule()
  }

  function useState(initial) {
    const index = cursor++
    if (store.cells[index] === undefined) {
      store.cells[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    return [store.cells[index].value, (next) => write(index, next)]
  }

  function useRef(initial) {
    const index = cursor++
    if (store.cells[index] === undefined) store.cells[index] = { value: { current: initial } }
    return store.cells[index].value
  }

  function useCallback(fn) {
    cursor++
    return fn
  }

  function useEffect(fn, deps) {
    const index = cursor++
    const previous = store.cells[index]
    const nextDeps = Array.isArray(deps) ? deps : null
    const changed = previous === undefined
      || previous.deps === null
      || nextDeps === null
      || previous.deps.length !== nextDeps.length
      || previous.deps.some((value, position) => value !== nextDeps[position])
    store.cells[index] = { deps: nextDeps, fn }
    if (changed) effectQueue.push(fn)
  }

  const createElement = (type, props, ...children) => {
    const merged = { ...props }
    if (!('children' in merged) && children.length > 0) {
      merged.children = children.length === 1 ? children[0] : children
    }
    return { type, props: merged, children }
  }

  function render(component, props) {
    store = storeFor(component)
    cursor = 0
    effectQueue = []
    for (const cleanup of store.cleanups) cleanup()
    store.cleanups = []
    const tree = component(props)
    if (store.previousCount >= 0 && cursor > store.previousCount) {
      throw new Error(`Rendered more hooks than during the previous render (${cursor} > ${store.previousCount})`)
    }
    if (store.previousCount >= 0 && cursor < store.previousCount) {
      throw new Error(`Rendered fewer hooks than expected (${cursor} < ${store.previousCount})`)
    }
    store.previousCount = cursor
    for (const effect of effectQueue) {
      const cleanup = effect()
      if (typeof cleanup === 'function') store.cleanups.push(cleanup)
    }
    return tree
  }

  /** Render until no state change is pending, so async effects settle. */
  async function settle(component, props) {
    let tree = render(component, props)
    const target = storeFor(component)
    for (let round = 0; round < 10 && target.pending; round += 1) {
      target.pending = false
      await new Promise(resolve => setImmediate(resolve))
      tree = render(component, props)
    }
    for (const cleanup of storeFor(component).cleanups) cleanup()
    storeFor(component).cleanups = []
    return tree
  }

  return { createElement, useState, useRef, useCallback, useEffect, settle }
}

/**
 * Boot the browser bundle against a stub context and return its registered
 * components plus the RPC stub.
 * @returns {{ registrations: object[], calls: object[] }}
 */
function boot({ failSessionViewOnce = false, headPlanMode = true, chains = null, onOpenSession = null, planning = false, preview = null, launchResults = [], clusterChildren = false, mainline = false, deleted = null, deletedSessionView = null, runningSession = false, pausedChain = false } = {}) {
  const react = createFakeReact()
  const registrations = []
  const calls = []
  let failedOnce = false

  const activeChainView = {
    chain: { chainId: 'chain-1', status: 'active', title: 'demo', objective: 'ship it', featuresTotal: 2, featuresDone: 1, handoffCount: 0, maxHandoffs: 32, coveragePartial: 0, blocker: null },
    head: { goal: null, planMode: headPlanMode, goalHeld: false, goalPausedByRelay: false },
    self: {
      sessionId: 'session-1',
      role: 'worker',
      running: false,
      pressureRatio: 0.1,
      compactions: 0,
      planMode: true,
      goal: { phase: 'blocked', activation: 'disarmed', roundsStarted: 16, maxGoalRounds: 16, blockedCode: 'round-limit', blockedMessage: 'round cap reached' },
    },
    parent: { sessionId: 'session-parent', running: false },
    children: [],
    assignedFeatures: [{ id: 'F001', title: 'first', passes: false, evidence: null, verify: 'node test', coverage: 'full', acceptedBy: null }],
  }
  if (clusterChildren) {
    // A cluster head whose workers were launched by the previous head: the Host
    // now reports them as this session's children.
    Object.assign(activeChainView.chain, { mode: 'cluster', currentSessionId: 'session-1' })
    activeChainView.children = [{ sessionId: 'session-kid', role: 'worker', parentSessionId: 'session-old', running: false, loaded: true, pressureRatio: 0.1, peakRatio: 0.1 }]
  }
  if (mainline) {
    // A mainline session: no parent, and the Host sends the mainline list
    // separately from the oldest open-feature field.
    activeChainView.parent = null
    activeChainView.mainlineFeatures = [{
      id: 'F009', title: 'inherited', passes: true, evidence: 'ran true', verify: 'true',
      coverage: 'full', acceptedBy: null, assignedSessionId: 'session-old',
    }]
  }
  const planningChain = {
    chainId: 'chain-plan', status: 'planning', title: 'cluster demo', objective: 'ship it in parallel',
    featuresTotal: 3, featuresDone: 0, handoffCount: 0, maxHandoffs: 32, coveragePartial: 0, blocker: null,
    currentSessionId: 'session-plan', mode: 'cluster', launchPending: true, sessions: 1,
  }
  const planningChainView = {
    chain: planningChain,
    head: { goal: null, planMode: false, goalHeld: false, goalPausedByRelay: false },
    self: { sessionId: 'session-plan', role: 'initializer', running: true, pressureRatio: 0.1, compactions: 0, planMode: false, goal: null },
    parent: null,
    children: [],
    assignedFeatures: [],
  }
  const chainView = planning ? planningChainView : activeChainView

  const chainSummary = { chainId: 'chain-1', status: runningSession || pausedChain ? 'paused' : 'active', title: 'demo', objective: 'ship it', featuresTotal: 2, featuresDone: 1, handoffCount: 0, maxHandoffs: 32, coveragePartial: 0, blocker: null, sessions: 1 }
  const panelChains = chains ?? {
    chains: [{
      ...chainSummary,
      blocker: { kind: 'external', who: 'human', action: 'grant access' },
      // The same text lands in lastError; the panel must not show it twice.
      lastError: 'external blocker: grant access',
      sessionsDetail: [{ sessionId: 'session-1', role: 'initializer', running: false, loaded: true, peakRatio: 0.4, pressureRatio: 0.23 }],
      head: { goal: { phase: 'active', activation: 'armed', roundsStarted: 3, maxGoalRounds: 10, blockedCode: null, blockedMessage: null }, planMode: true, goalHeld: false, goalPausedByRelay: false },
    }],
  }
  const panelDetail = {
    chain: chainSummary,
    head: {
      goal: { phase: 'active', activation: 'disarmed', roundsStarted: 3, maxGoalRounds: 10, blockedCode: null, blockedMessage: null },
      planMode: true,
      goalHeld: true,
      goalPausedByRelay: false,
    },
    features: [],
    truthDir: 'D:/demo/.relay/chain-1',
    sessions: [{ sessionId: 'session-1', role: 'initializer', running: runningSession, loaded: true, pressureRatio: 0.2, peakRatio: 0.4 }],
    handoff: null,
  }
  const planningDetail = {
    chain: planningChain,
    head: { goal: null, planMode: false, goalHeld: false, goalPausedByRelay: false },
    maxClusterSessions: 4,
    features: [
      { id: 'F001', title: 'first', passes: false, assignedSessionId: null, files: [], dependsOn: [] },
      { id: 'F002', title: 'second', passes: false, assignedSessionId: null, files: [], dependsOn: [] },
      { id: 'F003', title: 'third', passes: false, assignedSessionId: null, files: [], dependsOn: [] },
    ],
    sessions: [{ sessionId: 'session-plan', role: 'initializer', running: true, loaded: true, pressureRatio: 0.1, peakRatio: 0.1 }],
    handoff: null,
    launchPlan: {
      proposedAt: '2026-11-23T00:00:00.000Z',
      proposedBy: 'session-plan',
      note: 'two groups',
      conflicts: [],
      groups: [
        { id: 'G1', title: 'Go API', features: ['F001', 'F002'], isolation: 'shared', reason: 'same router' },
        { id: 'G2', title: 'Linux', features: ['F003'], isolation: 'shared', reason: 'separate files' },
      ],
    },
  }

  const context = {
    connection: {
      rpc: {
        call: (_route, endpoint) => {
          calls.push(endpoint)
          if (endpoint === 'relay/sessionView') {
            if (failSessionViewOnce && !failedOnce) {
              failedOnce = true
              return Promise.reject(new Error('transport down'))
            }
            if (deletedSessionView !== null) {
              return Promise.resolve({ ok: true, value: { chain: null, deleted: deletedSessionView } })
            }
            return Promise.resolve({ ok: true, value: chainView })
          }
          if (endpoint === 'relay/listChains') return Promise.resolve({ ok: true, value: panelChains })
          if (endpoint === 'relay/listDeleted') return Promise.resolve({ ok: true, value: deleted ?? { chains: [] } })
          if (endpoint === 'relay/deleteChain') {
            return Promise.resolve({ ok: true, value: { chainId: 'chain-1', status: 'paused', title: 'demo', sessions: ['session-1'], deletedAt: '2026-11-23T11:11:55.928Z' } })
          }
          if (endpoint === 'relay/restoreChain') return Promise.resolve({ ok: true, value: { chainId: 'chain-1', status: 'paused', title: 'demo', sessions: ['session-1'] } })
          if (endpoint === 'relay/purgeChain') return Promise.resolve({ ok: true, value: { chainId: 'chain-1', purged: true, title: 'demo' } })
          if (endpoint === 'relay/chainDetail') return Promise.resolve({ ok: true, value: planning ? planningDetail : panelDetail })
          if (endpoint === 'relay/previewCluster') return Promise.resolve({ ok: true, value: preview ?? { issues: [], conflicts: [], waiting: [] } })
          if (endpoint === 'relay/launchCluster') return Promise.resolve({ ok: true, value: { chainId: 'chain-plan', status: 'active', results: launchResults } })
          if (endpoint === 'relay/chainAudit') return Promise.resolve({ ok: true, value: [] })
          return Promise.resolve({ ok: true, value: {} })
        },
      },
    },
    slots: {
      inject: (_owner, factory) => factory(),
      register: (registration, component) => {
        registrations.push({ options: registration, component })
        return () => undefined
      },
    },
    locale: {
      register: () => undefined,
      bind: () => (key) => key,
    },
    layout: { selectPanel: () => undefined },
    uiWorkspace: { openSession: (sessionId) => { if (onOpenSession !== null) onOpenSession(sessionId) } },
    get: () => undefined,
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => {
          const plugin = factory(name => {
            if (name === 'react') return react
            throw new Error(`unexpected require(${name})`)
          })
          plugin.apply(context)
        },
      },
      confirm: () => false,
    },
    console,
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout,
    clearTimeout,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  }

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return { registrations, calls, react }
}

const { registrations, calls, react } = boot()
const tabs = registrations.filter(entry => entry.options.name === 'conversation.view')
assert.equal(tabs.length, 2, 'expected the two session tabs')

for (const tab of tabs) {
  const label = tab.options.id
  await assert.doesNotReject(
    () => react.settle(tab.component, { sessionId: 'session-1' }),
    `the "${label}" tab must keep its hook order while its data loads`,
  )
  assert.ok(calls.includes('relay/sessionView'), `the "${label}" tab must request relay/sessionView`)
}

// A cluster head must explain that the downstream workers include the ones a
// previous head launched; otherwise the inherited sessions look unexplained.
const clusterChildrenBoot = boot({ clusterChildren: true })
const clusterChildrenTab = clusterChildrenBoot.registrations.find(entry => entry.options.id === 'relay-children')
const clusterChildrenText = collectText(await clusterChildrenBoot.react.settle(clusterChildrenTab.component, { sessionId: 'session-1' }))
assert.ok(clusterChildrenText.includes('childrenClusterNote'), 'a cluster head must explain the inherited workers')

// A mainline session lists the Host's mainlineFeatures, which include features a
// retired mainline leg still owns; the old openFeatures field does not.
const mainlineBoot = boot({ mainline: true })
const mainlineTab = mainlineBoot.registrations.find(entry => entry.options.id === 'relay-tasks')
const mainlineText = collectText(await mainlineBoot.react.settle(mainlineTab.component, { sessionId: 'session-1' }))
assert.ok(mainlineText.includes('F009'), 'the mainline tab must use view.mainlineFeatures')
assert.ok(mainlineText.includes('inherited'))

// The cluster launch dock: only the chain head that is still planning gets it,
// and confirming it launches the plan on record without opening the panel.
const planningBoot = boot({ planning: true })
const launchDock = planningBoot.registrations.find(entry => entry.options.name === 'conversation.input.dock')
assert.ok(launchDock, 'the launch dock must be registered in conversation.input.dock')
const dockTree = await planningBoot.react.settle(launchDock.component, { sessionId: 'session-plan' })
const dockText = collectText(dockTree)
assert.ok(dockText.includes('launchDockTitle'), 'the planning head must see the launch dock')
assert.ok(dockText.some(text => text.includes('launchGo')), 'the dock must offer the start action')
assert.ok(
  planningBoot.calls.includes('relay/chainDetail') && planningBoot.calls.includes('relay/previewCluster'),
  'the dock must ask the Host for the plan and its refusals',
)
const startButton = nodesOf(dockTree).find(node => node.type === 'button' && String(node.props?.className ?? '').includes('is-cta'))
assert.ok(startButton, 'the start action must be a primary button')
startButton.props.onClick()
const armedTree = await planningBoot.react.settle(launchDock.component, { sessionId: 'session-plan' })
assert.ok(collectText(armedTree).includes('launchConfirm'), 'the first click must arm a confirmation')
const confirmButton = nodesOf(armedTree).find(node => node.type === 'button' && String(node.props?.className ?? '').includes('is-cta'))
assert.ok(confirmButton, 'the armed state must keep a primary confirm button')
confirmButton.props.onClick()
await new Promise(resolve => setImmediate(resolve))
assert.ok(planningBoot.calls.includes('relay/launchCluster'), 'confirming the dock must launch the plan')

// A finished launch reports what happened and stops offering the action; the
// session view can keep calling the chain planning for a few seconds after the
// Host has already moved it to active.
const doneTree = await planningBoot.react.settle(launchDock.component, { sessionId: 'session-plan' })
const doneText = collectText(doneTree)
assert.ok(doneText.some(text => text.includes('launchDone')), 'a finished launch must report its outcome')
assert.ok(
  !nodesOf(doneTree).some(node => node.type === 'button' && String(node.props?.className ?? '').includes('is-cta')),
  'a finished launch must not offer the start action again',
)

// A partial launch resolve is not a full success: the dock names the groups the
// Host could not open, so the human does not have to find the chain error later.
const partialBoot = boot({
  planning: true,
  launchResults: [
    { id: 'G1', launched: true, sessionId: 'session-g1' },
    { id: 'G2', launched: false, reason: 'the session could not be opened' },
    { id: 'G3', launched: false, waiting: true, waitsFor: ['F001'] },
  ],
})
const partialDock = partialBoot.registrations.find(entry => entry.options.name === 'conversation.input.dock')
await partialBoot.react.settle(partialDock.component, { sessionId: 'session-plan' })
const partialTree = await partialBoot.react.settle(partialDock.component, { sessionId: 'session-plan' })
const partialStart = nodesOf(partialTree).find(node => node.type === 'button' && String(node.props?.className ?? '').includes('is-cta'))
assert.ok(partialStart, 'the partial launch boot starts from an enabled dock')
partialStart.props.onClick()
const partialArmed = await partialBoot.react.settle(partialDock.component, { sessionId: 'session-plan' })
const partialConfirm = nodesOf(partialArmed).find(node => node.type === 'button' && String(node.props?.className ?? '').includes('is-cta'))
partialConfirm.props.onClick()
await new Promise(resolve => setImmediate(resolve))
const partialDoneTree = await partialBoot.react.settle(partialDock.component, { sessionId: 'session-plan' })
const partialDoneText = collectText(partialDoneTree)
assert.ok(partialDoneText.some(text => text.includes('launchDone')), 'a partial launch still reports how many sessions opened')
assert.ok(partialDoneText.includes('launchFailedGroups'), 'a partial launch must name the groups that did not open')
assert.ok(partialDoneText.some(text => text.includes('the session could not be opened')), 'a partial launch keeps the Host reason')
assert.ok(partialDoneText.includes('launchWaitingTitle'), 'a waiting group must be named, not folded into a failure')

// A refusal disables the start action and says why; it never offers a launch that
// the Host would reject.
const blockedBoot = boot({ planning: true, preview: { issues: [{ code: 'blocker', action: 'clear it' }], conflicts: [], waiting: [] } })
const blockedDock = blockedBoot.registrations.find(entry => entry.options.name === 'conversation.input.dock')
const blockedTree = await blockedBoot.react.settle(blockedDock.component, { sessionId: 'session-plan' })
assert.ok(collectText(blockedTree).some(text => text.includes('issueBlocker')), 'a refused launch must name the reason')
const blockedStart = nodesOf(blockedTree).find(node => node.type === 'button' && String(node.props?.className ?? '').includes('is-cta'))
assert.ok(blockedStart, 'the dock keeps its start button while refused')
assert.equal(blockedStart.props.disabled, true, 'a refused launch must not be clickable')

// An active chain, and a worker session of a planning chain, get no dock.
const idleBoot = boot()
const idleDock = idleBoot.registrations.find(entry => entry.options.name === 'conversation.input.dock')
const idleTree = await idleBoot.react.settle(idleDock.component, { sessionId: 'session-1' })
assert.equal(idleTree, null, 'an active chain must not show the launch dock')
const workerTree = await planningBoot.react.settle(launchDock.component, { sessionId: 'session-worker' })
assert.equal(workerTree, null, 'only the chain head gets the launch dock')

// The panel keeps the same action at the top of the launch card, not below the groups.
const planningSummary = {
  chainId: 'chain-plan', status: 'planning', title: 'cluster demo', objective: 'ship it in parallel',
  featuresTotal: 3, featuresDone: 0, handoffCount: 0, maxHandoffs: 32, coveragePartial: 0, blocker: null,
  currentSessionId: 'session-plan', mode: 'cluster', launchPending: true, sessions: 1,
  sessionsDetail: [{ sessionId: 'session-plan', role: 'initializer', running: true, loaded: true, pressureRatio: 0.1, peakRatio: 0.1 }],
  head: { goal: null, planMode: false, goalHeld: false, goalPausedByRelay: false },
}
const panelPlanning = boot({ planning: true, chains: { chains: [planningSummary] } })
const planningPanelEntry = panelPlanning.registrations.find(entry => entry.options.name === 'main')
const planningPanelTree = await panelPlanning.react.settle(planningPanelEntry.component, {})
const planningPanelText = collectText(planningPanelTree)
assert.ok(planningPanelText.includes('launchTitle'), 'a planning chain must show its launch card')
assert.ok(planningPanelText.some(text => text.includes('launchGo')), 'the launch card must show the start action')
assert.ok(
  nodesOf(planningPanelTree).some(node => node.type === 'button' && String(node.props?.className ?? '').includes('is-cta')),
  'the launch card must render a primary start button',
)
const planningRows = nodesOf(planningPanelTree).filter(node => typeof node.props?.className === 'string' && /^relay-row( |$)/.test(node.props.className))
assert.equal(planningRows.length, 1, 'the planning chain must have a row')
const planningRowText = collectText(planningRows[0])
assert.ok(planningRowText.includes('modeCluster'), 'a planning cluster must be marked as a cluster on its row')
assert.ok(planningRowText.includes('attnLaunch'), 'a planning cluster waiting for launch must say so on its row')

/** Flatten the strings a rendered tree would show. */
function collectText(node, parts = []) {
  if (node === null || node === undefined || node === false) return parts
  if (typeof node === 'string' || typeof node === 'number') {
    parts.push(String(node))
    return parts
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, parts)
    return parts
  }
  if (typeof node === 'object') {
    // Child components render their own trees; hook-using ones are left to the
    // top-level render, so a throw here only means "not collectable".
    if (typeof node.type === 'function') {
      try {
        collectText(node.type(node.props), parts)
      } catch {
        /* the child owns hooks and is rendered by the component under test */
      }
    }
    for (const [key, value] of Object.entries(node.props ?? {})) {
      // `children` is mirrored into props by this stand-in; counting it again
      // would collect every text node twice.
      if (key === 'children') continue
      if (typeof value === 'string') parts.push(value)
    }
    collectText(node.children, parts)
  }
  return parts
}

// Plan mode must be visible on the tab: a planning session has no feature list
// and would otherwise look stuck.
const tasksTab = tabs.find(entry => entry.options.id === 'relay-tasks')
const tasksText = collectText(await react.settle(tasksTab.component, { sessionId: 'session-1' }))
assert.ok(tasksText.includes('planModeChip'), 'the tasks tab must show the plan mode chip')
// With the head quiet, only the position card (self) can still show the chip.
const selfOnly = boot({ headPlanMode: false })
const selfOnlyEntry = selfOnly.registrations.find(entry => entry.options.id === 'relay-tasks')
const selfOnlyText = collectText(await selfOnly.react.settle(selfOnlyEntry.component, { sessionId: 'session-1' }))
assert.ok(selfOnlyText.includes('planModeChip'), 'the position card must show the plan mode chip of its own session')

// A transient RPC failure must not pin the tab on its error state: the next
// poll succeeds and the tab has to render the recovered data.
for (const tab of tabs) {
  const flaky = boot({ failSessionViewOnce: true })
  const entry = flaky.registrations.find(candidate => candidate.options.id === tab.options.id)
  const failed = await flaky.react.settle(entry.component, { sessionId: 'session-a' })
  assert.ok(collectText(failed).includes('failed'), 'the first load should render the failure')
  const recovered = await flaky.react.settle(entry.component, { sessionId: 'session-b' })
  assert.ok(
    !collectText(recovered).includes('failed'),
    `the "${tab.options.id}" tab kept a stale read error after a successful load`,
  )
}

// The panel's "peak context" KPI must read the field the Host actually sends;
// it used to read a name `status()` never returned and always showed 0%.
const panel = registrations.find(entry => entry.options.name === 'main')
const panelTree = await react.settle(panel.component, {})
const panelText = collectText(panelTree)
assert.ok(panelText.includes('40%'), 'the chain card must show the peak context ratio')
assert.ok(!panelText.includes('23%'), 'the chain row must show the peak, not the current reading')
const viewChainButtons = panelText.filter(text => text === 'viewChain').length
assert.equal(viewChainButtons, 1, 'a blocker echoed in lastError must produce one attention row, not two')
assert.ok(panelText.includes('planModeChip'), 'the panel must show the plan mode chip')
assert.ok(panelText.includes('goalRow'), 'the panel must show the goal row')
assert.ok(panelText.includes('goalBudget'), 'the chain detail must label the goal rounds as a chain-wide budget')
assert.ok(panelText.includes('goalHeld'), 'the chain detail must explain a held goal')

/**
 * Every element of a rendered tree, rendering child components where possible.
 * Hook-owning components throw here and are skipped: the top-level settle has
 * already rendered them.
 */
function nodesOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) nodesOf(child, out)
    return out
  }
  if (typeof node === 'object') {
    out.push(node)
    if (typeof node.type === 'function') {
      try { nodesOf(node.type(node.props), out) } catch { /* the child owns hooks */ }
    }
    nodesOf(node.children, out)
  }
  return out
}

// Several chains can be active at once, and chain status alone cannot tell them
// apart. The row has to say which one is generating, how many sessions run in
// it, and open the conversation it lives in.
const opened = []
const twoActive = boot({
  onOpenSession: id => opened.push(id),
  chains: {
    chains: [
      {
        chainId: 'chain-a', status: 'active', title: 'alpha', objective: 'alpha', featuresTotal: 4, featuresDone: 1,
        handoffCount: 0, maxHandoffs: 32, sessions: 2, currentSessionId: 'session-alpha', mode: 'cluster',
        sessionsDetail: [
          { sessionId: 'session-alpha', role: 'initializer', running: true, loaded: true, pressureRatio: 0.1, peakRatio: 0.2 },
          { sessionId: 'session-kid', role: 'worker', parentSessionId: 'session-alpha', running: true, loaded: true, pressureRatio: 0.1, peakRatio: 0.1 },
        ],
        head: { goal: null, planMode: false, goalHeld: false, goalPausedByRelay: false },
        // A head stuck in one long command still says `running`; this is the only
        // field that tells the reader it has not written anything for a while.
        stall: { minutes: 23 },
      },
      {
        chainId: 'chain-b', status: 'active', title: 'beta', objective: 'beta', featuresTotal: 4, featuresDone: 2,
        handoffCount: 0, maxHandoffs: 32, sessions: 1, currentSessionId: 'session-beta', mode: 'relay',
        sessionsDetail: [{ sessionId: 'session-beta', role: 'initializer', running: false, loaded: true, pressureRatio: 0.05, peakRatio: 0.3 }],
        head: { goal: null, planMode: false, goalHeld: false, goalPausedByRelay: false },
        // The other chain in this workspace is building one of the same files.
        conflicts: [{ chainId: 'chain-a', title: 'alpha', paths: ['src/a'], features: { mine: ['F003'], other: ['F001'] } }],
      },
      {
        chainId: 'chain-c', status: 'active', title: 'gamma', objective: 'gamma', featuresTotal: 3, featuresDone: 0,
        handoffCount: 0, maxHandoffs: 32, sessions: 1, currentSessionId: 'session-gamma',
        sessionsDetail: [{ sessionId: 'session-gamma', role: 'initializer', running: false, loaded: true, pressureRatio: 0.02, peakRatio: 0.1 }],
        head: { goal: null, planMode: false, goalHeld: false, goalPausedByRelay: false },
        // Its turn ended while its own long command keeps running in a job.
        jobs: { running: 1, labels: ['pwsh: full rig'] },
      },
    ],
  },
})
const panelEntry = twoActive.registrations.find(entry => entry.options.name === 'main')
const twoActiveTree = await twoActive.react.settle(panelEntry.component, {})
const twoActiveText = collectText(twoActiveTree)
assert.ok(twoActiveText.includes('rowRunning'), 'a chain with a generating session must say it is running')
assert.ok(twoActiveText.includes('rowIdle'), 'a second active chain that is not generating must read as idle')
assert.ok(twoActiveText.includes('rowBusy'), 'a head whose background job still runs must not read as idle')
assert.ok(twoActiveText.includes('jobChip'), 'the row must name how many background jobs run')
assert.ok(twoActiveText.includes('rowParallel'), 'a chain with two live sessions must show the parallel count')
assert.ok(twoActiveText.includes('stallChip'), 'a running head with no progress must be called out instead of looking alive')
assert.ok(twoActiveText.includes('conflictChip'), 'a chain sharing files with another chain must say so')
const liveMarkers = nodesOf(twoActiveTree).filter(node => typeof node.props?.className === 'string' && node.props.className.includes('is-live'))
// alpha generates, gamma waits on its own job: both are live. beta is idle.
assert.equal(liveMarkers.length, 2, 'only chains with live work (a running session or a running job) get the marker')

const openButtons = nodesOf(twoActiveTree).filter(node => typeof node.props?.className === 'string' && node.props.className.includes('relay-row-open'))
assert.equal(openButtons.length, 3, 'every chain row must offer a way into its conversation')
for (const button of openButtons) button.props.onClick({ stopPropagation: () => undefined })
assert.deepEqual(opened, ['session-alpha', 'session-beta', 'session-gamma'], 'a row must open the chain head session it shows')

// The list card itself must say which shape the chain is; opening it is too late.
const rows = nodesOf(twoActiveTree).filter(node => typeof node.props?.className === 'string' && /^relay-row( |$)/.test(node.props.className))
assert.equal(rows.length, 3, 'the rail must render one row per chain')
const rowTexts = rows.map(row => collectText(row))
assert.ok(rowTexts[0].includes('modeCluster'), 'a cluster chain must be marked on its row')
assert.ok(rowTexts[1].includes('modeRelay'), 'a single-task chain must be marked on its row')

// A session whose chain was moved to the trash must say so, not look like a
// fresh session that should call relay_start again.
const deletedBoot = boot({
  deletedSessionView: {
    chainId: 'chain-gone',
    title: 'gone task',
    deletedAt: '2026-11-23T11:11:55.928Z',
    status: 'paused',
    featuresDone: 1,
    featuresTotal: 3,
  },
})
for (const tab of deletedBoot.registrations.filter(entry => entry.options.name === 'conversation.view')) {
  const deletedText = collectText(await deletedBoot.react.settle(tab.component, { sessionId: 'session-1' }))
  assert.ok(deletedText.includes('deletedChainTitle'), 'a deleted chain tab must use the tombstone title')
  assert.ok(deletedText.includes('deletedChainBody'), 'the tombstone must explain the deletion')
  assert.ok(deletedText.includes('openPanel'), 'the tombstone must offer the way to the panel')
  assert.ok(!deletedText.includes('noChainBody'), 'a deleted chain must not tell the reader to start a new chain')
}

// The panel lists deleted chains separately and can restore one.
const trash = {
  chains: [{
    chainId: 'chain-gone', title: 'gone task', objective: 'gone', status: 'paused',
    deletedAt: '2026-11-23T11:11:55.928Z', sessions: ['session-gone'], featuresDone: 1, featuresTotal: 3,
  }],
}
const trashBoot = boot({ deleted: trash })
const trashPanel = trashBoot.registrations.find(entry => entry.options.name === 'main')
const trashTree = await trashBoot.react.settle(trashPanel.component, {})
const trashText = collectText(trashTree)
assert.ok(trashText.some(text => text.includes('recentlyDeleted')), 'the panel must expose the deleted list')
assert.ok(trashText.includes('restore'), 'a deleted chain needs a restore action')
assert.ok(trashText.includes('purge'), 'a deleted chain needs a permanent-delete action')
const restoreButton = nodesOf(trashTree).find(node => node.type === 'button' && collectText(node).includes('restore'))
assert.ok(restoreButton, 'the restore action must be clickable')
restoreButton.props.onClick()
await new Promise(resolve => setImmediate(resolve))
assert.ok(trashBoot.calls.includes('relay/restoreChain'), 'restoring must call the Host')

// Deleting a chain first shows what survives, then reports the move and offers undo.
const deleteBoot = boot({ pausedChain: true })
const deletePanel = deleteBoot.registrations.find(entry => entry.options.name === 'main')
let deleteTree = await deleteBoot.react.settle(deletePanel.component, {})
const deleteButton = nodesOf(deleteTree).find(node => node.type === 'button' && collectText(node).includes('delete'))
assert.ok(deleteButton, 'the chain detail must offer delete')
deleteButton.props.onClick()
deleteTree = await deleteBoot.react.settle(deletePanel.component, {})
const armedText = collectText(deleteTree)
assert.ok(armedText.includes('deleteConfirmTitle'), 'delete must open a confirmation panel')
assert.ok(armedText.includes('deleteKeepsSessions'), 'the confirmation must say the sessions survive')
assert.ok(armedText.includes('deleteTrashNote'), 'the confirmation must say it can be restored')
const confirmDelete = nodesOf(deleteTree).find(node => node.type === 'button' && String(node.props?.className ?? '').includes('is-danger'))
assert.ok(confirmDelete, 'the confirmation must have a confirm button')
confirmDelete.props.onClick()
await new Promise(resolve => setImmediate(resolve))
deleteTree = await deleteBoot.react.settle(deletePanel.component, {})
assert.ok(deleteBoot.calls.includes('relay/deleteChain'), `confirming must call the Host: ${deleteBoot.calls.join(',')}`)
const deleteNoticeText = collectText(deleteTree)
assert.ok(deleteNoticeText.includes('deletedNotice'), 'a delete must report what was moved')
assert.ok(deleteNoticeText.includes('undo'), 'a delete must offer undo')
const undoButton = nodesOf(deleteTree).find(node => node.type === 'button' && collectText(node).includes('undo'))
undoButton.props.onClick()
await new Promise(resolve => setImmediate(resolve))
assert.ok(deleteBoot.calls.includes('relay/restoreChain'), 'undo must restore the chain')

// A running session blocks the delete before the Host has to refuse it.
const runningBoot = boot({ runningSession: true })
const runningPanel = runningBoot.registrations.find(entry => entry.options.name === 'main')
const runningTree = await runningBoot.react.settle(runningPanel.component, {})
const runningDelete = nodesOf(runningTree).find(node => node.type === 'button' && collectText(node).includes('delete'))
assert.equal(runningDelete.props.disabled, true, 'a running chain must not be deletable')
assert.equal(runningDelete.props.title, 'deleteRunning', 'the disabled delete must say why')

console.log('session tab render check passed: hook order holds, a read error clears after recovery, the launch dock starts the plan on record, deleted chains keep their tombstone, and the panel shows the peak ratio')
