/**
 * Per-session relay state published to the browser.
 *
 * The session list already carries every session, so the panel only needs the
 * facts a chain does not record outside the log: how many times this session
 * was compacted and how active it is. Chain membership and feature progress
 * come from the Host Remote instead.
 *
 * `summary: true` is what puts the value on every list row; the harness's own
 * `contextPressure` projection is summary-excluded and cannot be used here.
 */

/** Projection key; unique across installed plugins. */
export const RELAY_SESSION_KEY = 'relaySession'

/** Initial state for a session with no recorded activity. */
function initialState() {
  return { compactions: 0, turns: 0, lastTurnAt: 0 }
}

/**
 * Build the `relaySession` projection definition.
 * @returns {object} projection definition for `ctx.sessionProjections.register`.
 */
export function relaySessionProjection() {
  return {
    key: RELAY_SESSION_KEY,
    stateVersion: 1,
    // The registry only calls parse(); plain identity keeps this dependency-free.
    stateSchema: { parse: value => value },
    init: () => initialState(),
    apply(state, event) {
      if (event.type === 'compaction/end') {
        if (event.data?.error !== undefined) return state
        return { ...state, compactions: state.compactions + 1 }
      }
      if (event.type === 'turn/end') {
        const time = typeof event.time === 'string' ? Date.parse(event.time) : Number.NaN
        return {
          ...state,
          turns: state.turns + 1,
          lastTurnAt: Number.isFinite(time) ? time : state.lastTurnAt,
        }
      }
      return state
    },
    wire: {
      viewSchema: { parse: value => value },
      view: state => state,
      summary: true,
    },
  }
}
