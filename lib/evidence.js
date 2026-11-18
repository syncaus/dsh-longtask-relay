/**
 * Evidence rules shared by the tool layer and the engine.
 *
 * The tool layer refuses weak evidence when a feature is marked passing; the
 * engine re-checks every passing feature before a chain may finish. Keeping one
 * implementation means the two gates cannot drift apart.
 */

/**
 * Check that recorded evidence can actually prove a pass.
 * "all green" is a claim: a usable record carries the command and a result — an exit
 * code, a pass/fail count, or a ratio — and enough text that a later session can tell
 * what ran. The marker list spans common toolchains and both languages the prompts use,
 * so the rule does not assume one test runner.
 * @param {unknown} evidence - recorded evidence text.
 * @param {{ requireStrong?: boolean }} [options] - set requireStrong false to only check length and a number.
 * @returns {string|undefined} an issue message, or undefined when the record is usable.
 */
export function evidenceIssue(evidence, options = {}) {
  const requireStrong = options.requireStrong !== false
  if (typeof evidence !== 'string') return 'a passing feature needs evidence text'
  const text = evidence.trim()
  if (text.length < 8) return 'evidence is too short to prove anything'
  // Only the strong policy demands machine-shaped output, so a project whose checks
  // produce prose (a design review, a manual sign-off) can turn that off entirely.
  if (!requireStrong) return undefined
  if (!/[0-9]/.test(text)) return 'evidence must contain at least one number (a count, a case total, or an exit code)'
  if (/\d+\s*\/\s*\d+/.test(text)) return undefined
  const lower = text.toLowerCase()
  const markers = [
    'exit', 'pass', 'fail', 'ok', 'success', 'error', 'skip', 'test', 'check',
    'diff', 'identical', 'match', 'result', 'build',
    '通过', '失败', '错误', '成功', '跳过', '测试', '覆盖', '差异',
  ]
  if (markers.some(marker => lower.includes(marker))) return undefined
  return 'evidence must include the result, such as "exit 0", "12/12 passed", or "BUILD SUCCESS"'
}
