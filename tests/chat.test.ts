import { describe, expect, test } from 'claude-code/testing'

import { CHAT_KEPT, endChat, startChat } from '../hooks/chat'

describe('chat history on the card', () => {
  test('a prompt starts an exchange and the answer closes it', async () => {
    const started = startChat([], '  Fix   the map\n please ', 10)
    expect(started).toEqual([{ at: 10, prompt: 'Fix the map please' }])
    expect(endChat(started, 'Done, it stays still now.', 20)).toEqual([
      { at: 10, prompt: 'Fix the map please', answer: 'Done, it stays still now.', endedAt: 20 },
    ])
  })

  test('only the latest exchanges are kept, and long texts are cut', async () => {
    let chat = startChat([], 'x'.repeat(1000), 1)
    expect(chat[0]?.prompt.length).toBe(400)
    for (let i = 0; i < CHAT_KEPT + 3; i += 1) chat = endChat(startChat(chat, `question ${i}`, i), `answer ${i}`, i)
    expect(chat).toHaveLength(CHAT_KEPT)
    expect(chat[chat.length - 1]?.prompt).toBe(`question ${CHAT_KEPT + 2}`)
  })

  test('an empty prompt starts nothing; an answer never overwrites one already there', async () => {
    expect(startChat([], '   ', 1)).toEqual([])
    const done = endChat(startChat([], 'q', 1), 'first', 2)
    expect(endChat(done, 'second', 3)).toEqual(done)
    expect(endChat([], 'lonely', 3)).toEqual([])
    expect(endChat(startChat([], 'q', 1), '', 2)).toEqual([{ at: 1, prompt: 'q', endedAt: 2 }])
  })
})
