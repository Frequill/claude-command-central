import type { ChatTurn } from '../types'

import { commandLine } from './snapshot'

export const CHAT_KEPT = 6
const PROMPT_MAX = 400
const ANSWER_MAX = 900

/** A new exchange starts with the person's prompt; only the latest few are kept. */
export function startChat(chat: readonly ChatTurn[], prompt: string, at: number): ChatTurn[] {
  const text = squeeze(commandLine(prompt) ?? prompt, PROMPT_MAX)
  if (!text) return [...chat]
  return [...chat, { at, prompt: text }].slice(-CHAT_KEPT)
}

/** The latest exchange gets Claude's answer once the turn ends. */
export function endChat(chat: readonly ChatTurn[], answer: string, at: number): ChatTurn[] {
  if (chat.length === 0) return []
  const last = chat[chat.length - 1] as ChatTurn
  if (last.answer !== undefined) return [...chat]
  const text = squeeze(answer, ANSWER_MAX)
  return [...chat.slice(0, -1), { ...last, endedAt: at, ...(text ? { answer: text } : {}) }]
}

function squeeze(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}
