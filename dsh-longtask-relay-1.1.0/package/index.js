/**
 * Long-task relay: keep one task moving across fresh sessions.
 *
 * The Host half owns the chain store, the supervisor, the handoff, the
 * model-facing tools, and the `relay` Remote namespace. The browser half
 * (client.js) adds the monitoring panel.
 */
import { Config, resolveConfig } from './lib/config.js'
import { handleRelayCommand } from './lib/command.js'
import { RelayEngine } from './lib/engine.js'
import { relaySessionProjection } from './lib/projection.js'
import { RelayRemote, provideRelay } from './lib/remote.js'
import { registerTools } from './lib/tools.js'

/** Plugin name registered with the Loader. */
export const name = 'longtask-relay'

/** Services this plugin requires; it stays pending while any is missing. */
export const inject = ['agents', 'sessions', 'tools']

export { Config }

/**
 * Register the relay engine, its tools, its Remote namespace, and its listeners.
 * @param {object} ctx - plugin context.
 * @param {object|undefined} config - row config, validated by {@link Config}.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const engine = new RelayEngine(ctx, resolved)

  provideRelay(ctx, new RelayRemote(engine))

  ctx.effect(() => {
    registerTools(ctx, engine)

    // Re-discovery: a restarted Host has no in-memory membership, so opening a
    // session re-reads the workspace truth index and makes its chain visible.
    const offCreated = ctx.on('agent/created', ({ agent }) => {
      try {
        engine.sessionLoaded(agent.id)
        const located = engine.locate(agent.session)
        // A session that is already idle emits no further idle event, so a goal
        // left disarmed by a restart would never be looked at without this.
        if (located?.chain.currentSessionId === agent.id) engine.scheduleEvaluate(agent.id, 2000)
        // A reload in the middle of a wrap-up re-attaches its deadline here.
        engine.scheduleWrapupDeadline(agent)
      } catch (error) {
        engine.warn(`could not locate ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    const offStatus = ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      void engine.evaluate(agent).catch((error) => {
        engine.warn(`supervisor failed for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    const offEvent = ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/end') return
      if (event.data?.error !== undefined) return
      engine.noteCompaction(session.id)
    })

    return () => {
      offCreated()
      offStatus()
      offEvent()
      engine.dispose()
    }
  }, 'longtask-relay lifecycle')

  // `/relay` is the human entry point from the composer; the command itself
  // never reaches the model, and stays optional so a composition without the
  // command registry still runs.
  ctx.inject(['commands'], (scope) => {
    scope.effect(() => {
      const dispose = scope.commands.register({
        name: 'relay',
        description: 'Start or inspect a long-task relay chain',
        input: { hint: '[start <objective> | cluster <objective> | launch | status | pause | resume | handoff]' },
        handler: invocation => handleRelayCommand(engine, invocation),
      })
      return () => dispose()
    }, 'longtask-relay command')
  })

  // The panel needs per-session compaction counts on every list row; the
  // projection is optional so a composition without projections still runs.
  ctx.inject(['sessionProjections'], (scope) => {
    let handle
    scope.effect(() => {
      void Promise.resolve(scope.sessionProjections.register(relaySessionProjection()))
        .then((registered) => { handle = registered })
        .catch((error) => {
          engine.warn(`projection registration failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      return () => { handle?.dispose?.() }
    }, 'longtask-relay projection')
  })
}
