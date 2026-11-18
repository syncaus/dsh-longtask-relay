/**
 * Boot-check the browser bundle outside a browser.
 *
 * Executes client.js with a stub `window.__ModuleLoader__`, a stub `require`,
 * and a stub client context. Two rounds run:
 *
 * 1. Cordis-like context: reading a service that was never injected throws.
 *    This is the real failure mode that took the whole plugin down once
 *    (`ctx.remote` instead of `ctx.get('remote')`), so apply() must survive it.
 * 2. A context exposing a stub `remote` service, asserting the approval and
 *    question streams are watched.
 *
 * This catches factory/apply failures; it cannot prove how the panel renders.
 *
 * Run with: node test/client-boot.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * Run the bundle once against a stub context.
 * @param {{ remote?: object }} options - services `ctx.get` should answer.
 * @returns {{ registrations: object[], injected: string[], locales: string[], onCalls: object[] }}
 */
function boot(options = {}) {
  const registrations = []
  const injected = []
  const locales = []
  const onCalls = []

  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: fn => fn,
    useEffect: () => undefined,
    useRef: initial => ({ current: initial }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => undefined],
  }

  const context = {
    connection: {
      rpc: {
        call: () => Promise.resolve({ ok: true, value: { chains: [] } }),
      },
    },
    slots: {
      inject: (owner, factory) => {
        injected.push(owner)
        return factory()
      },
      register: (registration, component) => {
        registrations.push({ options: registration, component })
        return () => undefined
      },
    },
    locale: {
      register: (namespace) => { locales.push(namespace) },
      bind: () => (key) => key,
    },
    layout: {
      selectPanel: () => undefined,
    },
    get: (name) => (name === 'remote' ? options.remote : undefined),
  }

  // Cordis throws on a service read the plugin never injected.
  Object.defineProperty(context, 'remote', {
    get() { throw new Error('cannot read "remote": it is not injected') },
  })

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          const plugin = factory(name => {
            if (name === 'react') return react
            throw new Error(`unexpected require(${name})`)
          })
          assert.equal(typeof plugin.apply, 'function', 'plugin exports no apply')
          assert.ok(Array.isArray(plugin.inject), 'plugin exports no inject list')
          plugin.apply(context)
          sandbox.loaded = { id, plugin }
        },
      },
      confirm: () => false,
    },
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  }

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(sandbox.loaded, 'the bundle never registered a factory')
  assert.equal(sandbox.loaded.id, '@local/longtask-relay')
  return { registrations, injected, locales, onCalls }
}

// Round 1: the strict context. apply() must complete without touching `remote`.
const strict = boot()
assert.deepEqual(
  strict.injected.sort(),
  ['conversation.view', 'conversation.view', 'main', 'plugins.bundle.config', 'sidebar.panellist'],
)
assert.equal(strict.registrations.length, 5, 'expected five slot registrations')
const names = strict.registrations.map(entry => entry.options.name).sort()
assert.deepEqual(names, ['conversation.view', 'conversation.view', 'main', 'plugins.bundle.config', 'sidebar.panellist'])
assert.equal(strict.registrations.find(entry => entry.options.name === 'main').options.key, 'relay')
assert.equal(strict.registrations.find(entry => entry.options.name === 'sidebar.panellist').options.id, 'relay')
assert.equal(strict.registrations.find(entry => entry.options.name === 'plugins.bundle.config').options.key, '@local/longtask-relay')
const viewIds = strict.registrations
  .filter(entry => entry.options.name === 'conversation.view')
  .map(entry => entry.options.id)
  .sort()
assert.deepEqual(viewIds, ['relay-children', 'relay-tasks'])
for (const entry of strict.registrations.filter(item => item.options.name === 'conversation.view')) {
  assert.equal(typeof entry.options.label, 'function', 'a view tab needs a label function')
}
assert.equal(strict.locales[0], 'relay')

// Round 2: a context that exposes `remote`, so the decision watcher must attach.
const watched = []
const withRemote = boot({
  remote: {
    $on: (event, handler) => {
      watched.push({ event, handler })
      assert.equal(typeof handler, 'function', `the ${event} listener must be a function`)
      return () => undefined
    },
  },
})
assert.equal(withRemote.registrations.length, 5, 'a live remote must not change the registrations')
assert.deepEqual(watched.map(item => item.event).sort(), ['approval/request', 'user-questions/request'])

console.log('client boot check passed: 5 slots registered (2 session tabs), locale namespace registered, decision streams watched')
