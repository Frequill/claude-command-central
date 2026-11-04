import type { EngineInterface } from 'claude-code'

import { isSafeSessionId } from './snapshot'

/**
 * The model and effort the person picked for one session in CCC's session menu, as the board's
 * server keeps it in `~/.claude/ccc/choices/<session>.json`. The mod sends each of the session's
 * own requests to the model with it, so a pick changes this session alone: no /model command, no
 * setting saved as the default for new sessions, nothing another session reads.
 */
export type SessionChoice = { model?: string; effort?: Effort }

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
// an alias (opus, opus[1m], opusplan) or a full id (claude-opus-5-5)
const MODEL = /^[A-Za-z0-9._-]{1,80}(\[1m\])?$/

/** A stored choice, with what does not fit left out; nothing at all for a file that is not one. */
export function readSessionChoice(text: string | undefined): SessionChoice {
  if (!text) return {}
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return {}
  }
  if (!data || typeof data !== 'object') return {}
  const { model, effort } = data as { model?: unknown; effort?: unknown }
  return {
    ...(typeof model === 'string' && MODEL.test(model) ? { model } : {}),
    ...(typeof effort === 'string' && (EFFORTS as readonly string[]).includes(effort) ? { effort: effort as Effort } : {}),
  }
}

/** A request with the session's choice in it: the model and effort picked, else as the engine had them. */
export function withChoice<T extends { model: string; effort?: Effort | number }>(step: T, choice: SessionChoice): T {
  return { ...step, ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}) }
}

/** This session's choice, read fresh for each request: a pick counts from the very next one. */
export async function sessionChoice($: EngineInterface): Promise<SessionChoice> {
  try {
    const home = await $.env.get('HOME')
    const sessionId = await $.session.id()
    if (!home || !isSafeSessionId(sessionId)) return {}
    const path = `${home}/.claude/ccc/choices/${sessionId}.json`
    if (!(await $.fs.exists(path))) return {}
    const text = await $.fs.read(path)
    return readSessionChoice(typeof text === 'string' ? text : undefined)
  } catch {
    return {}
  }
}
