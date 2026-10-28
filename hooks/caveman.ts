import type { EngineInterface } from 'claude-code'

import { isSafeSessionId } from './snapshot'

/**
 * Caveman mode, switched per session from CCC. The board's server keeps the choice in
 * `~/.claude/ccc/caveman/<session>.json` (or `default.json` for sessions with no choice of their own).
 * While it is on, each message to Claude carries a note the person does not see: the caveman skill's
 * whole rules, every time, so they hold however long the session runs. Switching costs no turn and
 * no message.
 *
 * Not the system prompt: the built-in security plugin answers those events before any mod sees them.
 */
export const CAVEMAN_LEVELS = ['lite', 'full', 'ultra'] as const
export type CavemanLevel = (typeof CAVEMAN_LEVELS)[number]

const SKILL_MAX = 20_000

// used when the caveman skill is not installed: its rules in short
const FALLBACK_RULES = `Respond terse like smart caveman. All technical substance stay. Only fluff die.

Drop articles, filler, pleasantries and hedging. Fragments OK. Short synonyms. Technical terms exact. Code blocks unchanged. Errors quoted exact.

lite: no filler or hedging, keep articles and full sentences. full: drop articles, fragments OK. ultra: abbreviate prose words, arrows for causality.

Write normally for security warnings, confirmations of irreversible actions, and wherever terse words could be misread. Code, commits and PRs: write normal.`

/** The level a stored choice names: a level, 'off', or undefined when the file says neither. */
export function readChoice(text: string | undefined): CavemanLevel | 'off' | undefined {
  if (!text) return undefined
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  const level = data && typeof data === 'object' ? (data as { level?: unknown }).level : undefined
  if (level === 'off') return 'off'
  return CAVEMAN_LEVELS.find(one => one === level)
}

/** The level in force: the session's own choice, else the default; undefined when caveman is off. */
export function levelInForce(own: CavemanLevel | 'off' | undefined, fallback: CavemanLevel | 'off' | undefined): CavemanLevel | undefined {
  const chosen = own ?? fallback
  return chosen === 'off' ? undefined : chosen
}

/** The skill's rules without the frontmatter at its top. */
export function skillRules(text: string | undefined): string {
  const body = (text ?? '').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  return body ? body.slice(0, SKILL_MAX) : FALLBACK_RULES
}

/**
 * The note a message carries: the whole rules on every message while caveman mode is on (`told` is
 * the level the last note gave, undefined when none was given yet), one line when it was just switched
 * off, else nothing. `wasChosen` says a choice is stored: after a restart the mod cannot know what
 * earlier messages said, so off is said once.
 */
export function cavemanNote(level: CavemanLevel | undefined, told: CavemanLevel | 'off' | undefined, rules: string, wasChosen = false): string | undefined {
  if (!level) {
    if (told === undefined && wasChosen) return 'Caveman mode is off for this session (set in CCC). If earlier messages switched it on, write normally again from this reply on.'
    return told && told !== 'off' ? 'Caveman mode was switched off in CCC. Write normally again from this reply on.' : undefined
  }
  const said = level === told ? `Caveman mode is still on for this session in CCC, at the ${level} level.` : `Caveman mode is switched on for this session in CCC, at the ${level} level.`
  return [
    `${said} Follow these rules in this reply and every reply after it, at that level, until a note says it was switched off. The rules mention /caveman and "stop caveman": here the level is set in CCC instead.`,
    rules,
  ].join('\n\n')
}

/** The level in force for this session now, read from where the board's server keeps it, and whether any choice is stored. */
export async function cavemanNow($: EngineInterface): Promise<{ level: CavemanLevel | undefined; wasChosen: boolean }> {
  const home = await $.env.get('HOME')
  const sessionId = await $.session.id()
  if (!home || !isSafeSessionId(sessionId)) return { level: undefined, wasChosen: false }
  const dir = `${home}/.claude/ccc/caveman`
  const own = readChoice(await readIfThere($, `${dir}/${sessionId}.json`))
  const fallback = own === undefined ? readChoice(await readIfThere($, `${dir}/default.json`)) : undefined
  return { level: levelInForce(own, fallback), wasChosen: own !== undefined || fallback !== undefined }
}

let rulesRead: string | undefined

/** The caveman skill's rules, read once per load of the mod. */
export async function cavemanRules($: EngineInterface): Promise<string> {
  if (rulesRead === undefined) {
    const home = await $.env.get('HOME')
    rulesRead = skillRules(home ? await readIfThere($, `${home}/.claude/skills/caveman/SKILL.md`) : undefined)
  }
  return rulesRead
}

async function readIfThere($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}
