/**
 * The host-side home of the running installation.
 *
 * Seals, audit copies, and the chain indexes live under it, outside the
 * workspace, so every store that keeps host state resolves it the same way.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The profile's DSH home directory.
 * @returns {string} absolute directory.
 */
export function dshHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}
