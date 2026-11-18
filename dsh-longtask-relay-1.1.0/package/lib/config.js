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
  /**
   * Pressure ratio the session is wrapped up at. Must stay below the compaction threshold.
   * Long tasks lose the most work when a wrap-up starts after the session already spent its
   * remaining budget inside one long read, so the default leaves half the window for the wrap-up.
   */
  wrapupRatio: 0.50,
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
  /**
   * Minutes a session gets to produce a fresh HANDOFF.md before a stale one is
   * accepted anyway (the handoff brief then carries a warning).
   */
  staleHandoffMinutes: 5,
  /** Whether the supervisor nudges an idle chain head to keep going. */
  autoContinue: false,
  /** Automatic continuations allowed per session before a blocker is recorded. */
  maxAutoContinues: 20,
  /** Whether wrap-up and initialization prompts tell the session to commit. */
  commitTruth: true,
  /** Agent preset for the next session; empty inherits the creator's preset. */
  agentPreset: '',
  /**
   * Whether a session this plugin creates starts with the permission preset
   * (sandbox mode + approval policy) of the session it continues. Without it
   * the new session gets the Host's default preset, so a chain started under
   * full access drops back to the default at the first handoff.
   */
  inheritPermission: true,
  /**
   * Approval policy applied to sessions this plugin creates on its own
   * (delegated workers and handoff successors). An unattended session's
   * approval request has no timeout, so `ask` can park a chain forever;
   * `never` fails closed instead and surfaces as a blocker.
   */
  workerApproval: 'never',
  /** Whether to pause an armed goal on the retired session. */
  pauseGoalOnRetire: true,
  /**
   * Whether the handoff successor gets a goal of its own.
   * A goal keeps the DSH goal-round driver continuing the session between turns;
   * without one the successor runs the handoff prompt and then stops, which
   * leaves an unattended chain idle until a human writes again.
   */
  seedGoalOnHandoff: false,
  /** Goal-round cap given to a seeded goal. */
  goalRoundsPerHandoff: 16,
  /**
   * Whether a handoff successor gets a goal with the retiring session's objective and its
   * remaining rounds. The round cap then works as a budget for the whole chain instead of
   * restarting at every handoff.
   */
  inheritGoal: true,
  /**
   * Whether a session this plugin creates starts in plan mode when the session it continues
   * is in plan mode. Without it the new session silently leaves plan mode.
   */
  inheritPlanMode: true,
  /**
   * Whether, after a Host restart or plugin reload, a goal this plugin created on the chain's
   * current session is re-armed. The Host disarms every goal when it reloads, so without this
   * the chain stops being driven until a human resumes the goal.
   */
  rearmGoalOnReload: true,
  /**
   * Whether a blocker of kind `external` pauses the chain.
   * An external blocker means only a human can unblock it, so spending fresh sessions on
   * handoffs makes the chain churn through its handoff budget without making progress.
   */
  pauseOnExternalBlocker: true,
  /** Whether to leave a retirement notice in the old session. */
  notifyOldSession: true,
  /**
   * Whether a passing feature must carry evidence that looks like a command result.
   * Turn it off for projects whose verification prints free-form prose.
   */
  requireStrongEvidence: true,
  /**
   * Whether partial coverage must be accepted by a human before the chain can finish.
   * Turn it off for projects where partial coverage is the normal outcome.
   */
  requireHumanAcceptedCoverage: true,
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
  if (name === 'handoffAfterCompactions' || name === 'hardCompactions' || name === 'goalRoundsPerHandoff') {
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
  if (name === 'wrapupTimeoutMinutes' || name === 'staleHandoffMinutes') {
    if (!Number.isInteger(value) || value < 1) return `${name} must be an integer of at least 1`
    return undefined
  }
  if (name === 'maxAutoContinues') {
    if (!Number.isInteger(value) || value < 1) return `${name} must be an integer of at least 1`
    return undefined
  }
  if (name === 'truthDir') {
    if (typeof value !== 'string' || value.trim().length === 0) return 'truthDir must be a non-empty string'
    if (/^([A-Za-z]:|[\\/])/.test(value.trim())) return 'truthDir must be relative to the workspace'
    if (value.split(/[\\/]/).includes('..')) return 'truthDir must not contain ".."'
    return undefined
  }
  if (name === 'agentPreset') {
    if (typeof value !== 'string') return 'agentPreset must be a string'
    return undefined
  }
  if (name === 'workerApproval') {
    if (!['inherit', 'ask', 'never'].includes(value)) return 'workerApproval must be inherit, ask, or never'
    return undefined
  }
  if (name === 'autoHandoff' || name === 'pauseGoalOnRetire' || name === 'pauseOnExternalBlocker'
    || name === 'notifyOldSession' || name === 'requireStrongEvidence' || name === 'requireHumanAcceptedCoverage'
    || name === 'seedGoalOnHandoff' || name === 'autoContinue' || name === 'commitTruth'
    || name === 'inheritPermission' || name === 'inheritGoal' || name === 'inheritPlanMode'
    || name === 'rearmGoalOnReload') {
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
  const merged = { ...DEFAULT_CONFIG, ...given }
  // The wrap-up has to start before the forced handoff, or the second ratio
  // can never apply.
  if (merged.wrapupRatio >= merged.handoffRatio) {
    throw new Error('wrapupRatio must be lower than handoffRatio')
  }
  return merged
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
