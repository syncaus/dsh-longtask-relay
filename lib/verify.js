/**
 * The plugin's own run of a feature's verify command.
 *
 * A session's "it passed" is a claim; this runs the command in the chain's
 * workspace and records what actually happened: exit code, duration, the tail of
 * the output, and the git commit it ran against. The command runs in the Host
 * process, outside the session's sandbox, which is why commands need a human's
 * approval before they run (see the engine's `verifyFeatures`).
 */
import { execFileSync, spawn } from 'node:child_process'

/** Characters of combined output kept from the end of a run. */
const OUTPUT_TAIL = 2000

/** Root command names a feature's `verify` may reference instead of a command line. */
export const ROOT_COMMANDS = Object.freeze(['statusCheck', 'verifyFast', 'verifyFull'])

/**
 * The command line one feature's verify resolves to.
 * @param {{ verify?: string }} feature - normalized feature.
 * @param {{ statusCheck?: string, verifyFast?: string, verifyFull?: string }} document - normalized features document.
 * @returns {string} command line; empty when there is nothing to run.
 */
export function resolveVerify(feature, document) {
  const text = String(feature?.verify ?? '').trim()
  if (ROOT_COMMANDS.includes(text)) return String(document?.[text] ?? '').trim()
  return text
}

/**
 * The commit a run verified, or null outside a git repository.
 * @param {string} cwd - workspace directory.
 * @returns {string|null} commit hash.
 */
export function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000 }).trim() || null
  } catch {
    return null
  }
}

/**
 * Kill a child and everything it started.
 * @param {import('node:child_process').ChildProcess} child - running child.
 */
function killTree(child) {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run one command line through the platform shell.
 * @param {string} command - command line.
 * @param {{ cwd: string, timeoutMs: number }} options - where and how long.
 * @returns {Promise<{ command: string, exitCode: number|null, timedOut: boolean, durationMs: number, outputTail: string, head: string|null, at: string, by: 'plugin' }>} run record.
 */
export function runVerifyCommand(command, { cwd, timeoutMs }) {
  const startedAt = Date.now()
  const at = new Date(startedAt).toISOString()
  const head = gitHead(cwd)
  return new Promise((resolvePromise) => {
    let output = ''
    let timedOut = false
    let settled = false
    let timer
    const keep = (chunk) => {
      output += chunk.toString('utf8')
      if (output.length > OUTPUT_TAIL * 2) output = output.slice(-OUTPUT_TAIL)
    }
    const finish = (exitCode, extra = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const text = `${output}${extra}`
      resolvePromise({
        command,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        outputTail: text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text,
        head,
        at,
        by: 'plugin',
      })
    }
    let child
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      finish(null, `\n[relay] could not start: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (error) => finish(null, `\n[relay] could not start: ${error.message}`))
    child.on('close', (code) => finish(timedOut ? null : code, timedOut ? `\n[relay] killed after ${Math.round(timeoutMs / 1000)}s` : ''))
  })
}
