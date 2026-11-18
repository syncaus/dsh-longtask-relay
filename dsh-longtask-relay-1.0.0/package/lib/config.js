/**
 * Plugin configuration.
 *
 * Declared with the Standard Schema interface so the Loader validates the
 * `config` written in a profile patch. No schema library is imported: the
 * profile cannot resolve one, and this plugin needs four checks.
 */

/** Every accepted setting and its default. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Directory that holds the truth source, relative to the workspace. */
  truthDir: '.relay',
  /** Whether the supervisor may hand off on its own. */
  autoHandoff: true,
  /** Pressure ratio the session is wrapped up at. Must stay below the compaction threshold. */
  wrapupRatio: 0.55,
  /** Pressure ratio that forces a handoff even if the session did not wrap up yet. */
  handoffRatio: 0.70,
  /** Successful compactions after which the floor ratio also triggers a wrapup. */
  handoffAfterCompactions: 1,
  /** Pressure ratio that qualifies a compacted session for a wrapup. */
  compactedRatioFloor: 0.50,
  /** Successful compactions that force a handoff without waiting for a boundary. */
  hardCompactions: 2,
  /** Hard cap on handoffs per chain. */
  maxHandoffs: 32,
  /** Milliseconds between two evaluations of the same session. */
  cooldownMs: 5000,
  /** Minutes a wrapped-up session may sit idle before the handoff happens anyway. */
  wrapupTimeoutMinutes: 10,
  /** Agent preset for the next session; empty inherits the creator's preset. */
  agentPreset: '',
  /** Whether to pause an armed goal on the retired session. */
  pauseGoalOnRetire: true,
  /** Whether to leave a retirement notice in the old session. */
  notifyOldSession: true,
})

/**
 * Validate one setting.
 * @param {string} name - setting name.
 * @param {unknown} value - candidate value.
 * @returns {string|undefined} an issue message, or undefined when valid.
 */
function issueFor(name, value) {
  const numeric = [
    'wrapupRatio', 'handoffRatio', 'compactedRatioFloor',
  ]
  if (numeric.includes(name)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
      return `${name} must be a number between 0 and 1`
    }
    return undefined
  }
  if (name === 'handoffAfterCompactions' || name === 'hardCompactions') {
    if (!Number.isInteger(value) || value < 1) return `${name} must be an integer of at least 1`
    return undefined
  }
  if (name === 'maxHandoffs') {
    if (!Number.isInteger(value) || value < 1 || value > 1000) return `${name} must be an integer from 1 to 1000`
    return undefined
  }
  if (name === 'cooldownMs') {
    if (!Number.isInteger(value) || value < 0) return `${name} must be a non-negative integer`
    return undefined
  }
  if (name === 'wrapupTimeoutMinutes') {
    if (!Number.isInteger(value) || value < 1) return `${name} must be an integer of at least 1`
    return undefined
  }
  if (name === 'truthDir') {
    if (typeof value !== 'string' || value.trim().length === 0) return 'truthDir must be a non-empty string'
    if (/^([A-Za-z]:|[\\/])/.test(value.trim())) return 'truthDir must be relative to the workspace'
    return undefined
  }
  if (name === 'agentPreset') {
    if (typeof value !== 'string') return 'agentPreset must be a string'
    return undefined
  }
  if (name === 'autoHandoff' || name === 'pauseGoalOnRetire' || name === 'notifyOldSession') {
    if (typeof value !== 'boolean') return `${name} must be a boolean`
    return undefined
  }
  return undefined
}

/**
 * Merge defaults with a raw config object, rejecting unknown or invalid keys.
 * @param {unknown} raw - raw config from the Loader.
 * @returns {object} complete config.
 */
export function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    throw new Error('config must be an object')
  }
  const given = raw ?? {}
  const issues = []
  for (const [name, value] of Object.entries(given)) {
    if (!(name in DEFAULT_CONFIG)) {
      issues.push(`${name} is not a recognised setting`)
      continue
    }
    const issue = issueFor(name, value)
    if (issue !== undefined) issues.push(issue)
  }
  if (issues.length > 0) throw new Error(issues.join('; '))
  return { ...DEFAULT_CONFIG, ...given }
}

/** Standard Schema object the Loader validates the row's `config` with. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'longtask-relay',
    /**
     * Validate the row config.
     * @param {unknown} value - raw value.
     * @returns {{ value: object } | { issues: Array<{ message: string }> }} result.
     */
    validate(value) {
      try {
        return { value: resolveConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
}
