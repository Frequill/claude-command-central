import type { LiveReply } from '../types'

/** How much of Claude's latest reply a session keeps while it is written: enough for a long answer whole. */
export const REPLY_KEPT = 40_000
/** Written down once this much new text has come in, or at a line break. */
const SAVE_AFTER_CHARS = 48

/** A turn starts with nothing written yet. */
export function openReply(at: number): LiveReply {
  return { text: '', at, isWriting: false }
}

/** The reply grows by one streamed piece; a new block starts a new paragraph. Only the end is kept. */
export function appendReply(text: string, piece: string, isNewBlock: boolean): string {
  const joined = isNewBlock && text.trim() ? `${text.trimEnd()}\n\n${piece.trimStart()}` : text + piece
  return joined.length <= REPLY_KEPT ? joined : joined.slice(-REPLY_KEPT)
}

/** Once the turn is over the reply stands still; when no text streamed, the turn's answer fills it. */
export function closeReply(reply: LiveReply | null, answer: string, at: number): LiveReply {
  const text = reply?.text || appendReply('', answer.trim(), false)
  return { text, at: reply?.text ? reply.at : at, isWriting: false }
}

export type ReplyDraft = {
  /** Adds a piece of block `index`; true when enough came in to write it down. */
  add: (index: number, piece: string) => boolean
  text: () => string
}

/** One model step's share of the reply, starting from what the turn wrote before it. */
export function draftReply(start: string): ReplyDraft {
  let text = start
  let block = -1
  let unsaved = 0
  return {
    add(index, piece) {
      if (!piece) return false
      text = appendReply(text, piece, index !== block)
      block = index
      unsaved += piece.length
      if (unsaved < SAVE_AFTER_CHARS && !piece.includes('\n')) return false
      unsaved = 0
      return true
    },
    text: () => text,
  }
}
