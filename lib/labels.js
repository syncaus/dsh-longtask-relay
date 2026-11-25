/**
 * Host-side session titles.
 *
 * The DSH locale service is a client plugin, so a Host string cannot resolve it
 * through `ctx.locale`. The templates live in this package's locale files
 * (`ui.handoffTitle` / `ui.subtaskTitle`) and fall back to the built-in Chinese
 * text, which keeps the wording out of the engine.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()

/** Read one locale file's `ui` block, or an empty object. */
function uiStrings(language) {
  if (!cache.has(language)) {
    try {
      const document = JSON.parse(readFileSync(join(packageDir, 'locale', `${language}.json`), 'utf8'))
      cache.set(language, document?.ui ?? {})
    } catch {
      cache.set(language, {})
    }
  }
  return cache.get(language)
}

/**
 * Render a session title from the locale template.
 * @param {'handoff'|'subtask'|'review'} kind - which title to render.
 * @param {{ title: string, index?: number }} input - chain title and sequence.
 * @returns {string} the title.
 */
export function sessionTitle(kind, { title, index }) {
  const key = kind === 'handoff' ? 'handoffTitle' : kind === 'review' ? 'reviewTitle' : 'subtaskTitle'
  const fallback = kind === 'handoff' ? '{title} · 接力 {n}' : kind === 'review' ? '独立评审 第{n}轮 · {title}' : '{title} · 子任务'
  const template = uiStrings('zh')[key] ?? fallback
  return template
    .replaceAll('{title}', String(title ?? ''))
    .replaceAll('{n}', String(index ?? ''))
}
