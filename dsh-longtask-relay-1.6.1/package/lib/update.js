/**
 * Plugin self-update for a `link:`-installed bundle.
 *
 * The plugin lives inside a git working tree, so "latest" means the upstream
 * branch of that repository. Nothing here talks to a registry: the same git
 * binary and credentials the user already uses decide what is newer.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** This package's directory, the default subject of every check. */
export const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Preserve a diagnostic from any failure. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Run git with a bounded wall clock. */
function git(cwd, args, timeout = 20_000) {
  return run('git', args, { cwd, timeout, windowsHide: true })
}

/** Walk up from a directory to the working tree that contains it. */
export function findRepoRoot(from) {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** The one background ref refresh this process runs at a time. */
let refreshing = null

/**
 * Refresh the upstream refs without making a caller wait; failures are silent
 * because the comparison falls back to the refs already on disk.
 * @param {string} root - repository root.
 * @returns {Promise<void>} settles when the fetch ends.
 */
function refreshRefs(root) {
  if (refreshing !== null) return refreshing
  refreshing = git(root, ['fetch', '--quiet'], 8_000)
    .catch(() => null)
    .finally(() => { refreshing = null })
  return refreshing
}

/** The manifest version at one directory, or null. */
export function readVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * Compare this package with its upstream branch.
 * @param {string} [at] - package directory; defaults to this package.
 * @param {{ wait?: boolean }} [options] - `wait` also awaits the background fetch.
 * @returns {Promise<object>} update facts; `reason` says why a check failed.
 */
export async function checkPluginUpdate(at = packageDir, options = {}) {
  const currentVersion = readVersion(at)
  const root = findRepoRoot(at)
  if (root === undefined) return { available: false, reason: 'not-git', currentVersion }
  const rel = relative(root, at).split('\\').join('/')
  try {
    const { stdout: branch } = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const { stdout: upstreamOut } = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    const upstream = upstreamOut.trim()
    // One background fetch per process: the comparison below uses the refs
    // already on disk so the panel never waits on a slow remote, and the next
    // open sees the refreshed refs.
    refreshRefs(root)
    if (options?.wait === true && refreshing !== null) await refreshing
    const { stdout: behindOut } = await git(root, ['rev-list', '--count', `HEAD..${upstream}`])
    const { stdout: aheadOut } = await git(root, ['rev-list', '--count', `${upstream}..HEAD`])
    const { stdout: statusOut } = await git(root, ['status', '--porcelain'])
    const behind = Number.parseInt(behindOut.trim(), 10)
    const ahead = Number.parseInt(aheadOut.trim(), 10)
    let latestVersion = currentVersion
    try {
      const { stdout: manifest } = await git(root, ['show', `${upstream}:${rel}/package.json`])
      latestVersion = JSON.parse(manifest).version ?? currentVersion
    } catch {
      /* an upstream without this package keeps the local version */
    }
    return {
      available: behind > 0,
      reason: 'ok',
      fetchPending: refreshing !== null,
      currentVersion,
      latestVersion,
      behind,
      ahead,
      dirty: statusOut.trim().length > 0,
      branch: branch.trim(),
      upstream,
      repoRoot: root,
    }
  } catch (error) {
    return { available: false, reason: 'git-error', currentVersion, message: messageOf(error) }
  }
}

/**
 * Fast-forward this package to its upstream branch.
 * `pull` refreshes the refs itself, so a just-pushed upstream commit is seen
 * even when the background check has not finished fetching.
 * @param {string} [at] - package directory; defaults to this package.
 * @returns {Promise<object>} whether the tree changed and the new version.
 */
export async function applyPluginUpdate(at = packageDir) {
  const root = findRepoRoot(at)
  if (root === undefined) return { ok: false, reason: 'not-git', message: 'this package is not inside a git working tree' }
  try {
    const { stdout: statusOut } = await git(root, ['status', '--porcelain'])
    if (statusOut.trim().length > 0) {
      return { ok: false, reason: 'dirty', message: 'the working tree has local changes' }
    }
  } catch (error) {
    return { ok: false, reason: 'git-error', message: messageOf(error) }
  }
  const before = readVersion(at)
  try {
    await git(root, ['pull', '--ff-only'], 60_000)
  } catch (error) {
    return { ok: false, reason: 'pull-failed', message: messageOf(error) }
  }
  const after = readVersion(at)
  return {
    ok: true,
    upToDate: after === before,
    previousVersion: before,
    version: after,
    reloadRequired: after !== before,
  }
}
