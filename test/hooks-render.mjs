/**
 * Render-level guard for the session tabs.
 *
 * `client-boot.mjs` only proves the bundle registers; it never renders a
 * component. That hid a real crash: `ChildrenTab` called `usePendingDecisions`
 * after three early returns, so the second render (when `relay/sessionView`
 * finally answers) called more hooks than the first and React threw
 * "Rendered more hooks than during the previous render", blanking the
 * conversation view.
 *
 * This file runs the registered `conversation.view` components against a
 * minimal React stand-in that enforces the hook-count invariant across
 * renders, drives the async load effect, and then requires each tab to render
 * with its data.
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
function boot({ failSessionViewOnce = false } = {}) {
  const react = createFakeReact()
  const registrations = []
  const calls = []
  let failedOnce = false

  const chainView = {
    chain: { chainId: 'chain-1', status: 'active', title: 'demo', objective: 'ship it', featuresTotal: 2, featuresDone: 1, handoffCount: 0, maxHandoffs: 32, coveragePartial: 0, blocker: null },
    self: {
      sessionId: 'session-1',
      role: 'worker',
      running: false,
      pressureRatio: 0.1,
      compactions: 0,
      goal: { phase: 'blocked', activation: 'disarmed', roundsStarted: 16, maxGoalRounds: 16, blockedCode: 'round-limit', blockedMessage: 'round cap reached' },
    },
    parent: { sessionId: 'session-parent', running: false },
    children: [],
    assignedFeatures: [{ id: 'F001', title: 'first', passes: false, evidence: null, verify: 'node test', coverage: 'full', acceptedBy: null }],
  }

  const chainSummary = { chainId: 'chain-1', status: 'active', title: 'demo', objective: 'ship it', featuresTotal: 2, featuresDone: 1, handoffCount: 0, maxHandoffs: 32, coveragePartial: 0, blocker: null, sessions: 1 }
  const panelChains = {
    chains: [{
      ...chainSummary,
      blocker: { kind: 'external', who: 'human', action: 'grant access' },
      // The same text lands in lastError; the panel must not show it twice.
      lastError: 'external blocker: grant access',
      sessionsDetail: [{ sessionId: 'session-1', role: 'initializer', running: false, loaded: true, peakRatio: 0.4, pressureRatio: 0.23 }],
    }],
  }
  const panelDetail = {
    chain: chainSummary,
    features: [],
    sessions: [{ sessionId: 'session-1', role: 'initializer', running: false, loaded: true, pressureRatio: 0.2, peakRatio: 0.4 }],
    handoff: null,
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
            return Promise.resolve({ ok: true, value: chainView })
          }
          if (endpoint === 'relay/listChains') return Promise.resolve({ ok: true, value: panelChains })
          if (endpoint === 'relay/chainDetail') return Promise.resolve({ ok: true, value: panelDetail })
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

console.log('session tab render check passed: hook order holds, a read error clears after recovery, and the panel shows the peak ratio')
