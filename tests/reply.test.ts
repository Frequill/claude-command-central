import type { Register } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { REPLY_KEPT, appendReply, closeReply, draftReply, openReply } from '../hooks/reply'

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)
const STEP = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }
const DONE = { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as const

describe('the reply as it streams', () => {
  test('pieces of one block run on; a new block or step starts a new paragraph', async () => {
    expect(appendReply('Hi', ' there', false)).toBe('Hi there')
    expect(appendReply('First.  ', '  Then.', true)).toBe('First.\n\nThen.')
    expect(appendReply('', '  Start', true)).toBe('  Start')
    expect(appendReply('   ', 'Start', true)).toBe('   Start')
  })

  test('only the end of a long reply is kept', async () => {
    const long = appendReply('a'.repeat(REPLY_KEPT), 'SLUT', false)
    expect(long).toHaveLength(REPLY_KEPT)
    expect(long.endsWith('SLUT')).toBe(true)
  })

  test('a draft says when enough came in to write it down', async () => {
    const draft = draftReply('')
    expect(draft.add(0, 'Short')).toBe(false)
    expect(draft.add(0, '')).toBe(false)
    expect(draft.add(0, ' line\n')).toBe(true)
    expect(draft.add(0, 'x'.repeat(60))).toBe(true)
    expect(draft.add(0, 'y')).toBe(false)
    expect(draft.text()).toBe(`Short line\n${'x'.repeat(60)}y`)
  })

  test('a later step goes on from what the turn already wrote', async () => {
    const draft = draftReply('Let me check the file.')
    draft.add(0, 'Done.')
    expect(draft.text()).toBe('Let me check the file.\n\nDone.')
  })

  test('a turn opens empty and closes still, with the answer when nothing streamed', async () => {
    expect(openReply(5)).toEqual({ text: '', at: 5, isWriting: false })
    expect(closeReply({ text: 'Streamed', at: 3, isWriting: true }, 'The answer', 9)).toEqual({ text: 'Streamed', at: 3, isWriting: false })
    expect(closeReply({ text: '', at: 3, isWriting: false }, '  The answer  ', 9)).toEqual({ text: 'The answer', at: 9, isWriting: false })
    expect(closeReply(null, '', 9)).toEqual({ text: '', at: 9, isWriting: false })
  })
})

/** A helper plugin that reads what CCC kept, through a tool call the test makes. */
const peekRegister: Register = on => {
  on('tool.call', { tool: 'Peek' }, async $ => ({ result: JSON.stringify(await $.state.get({ plugin: 'ccc', key: 'reply' })) }))
}
const PEEK = { plugins: [{ name: 'peek', register: peekRegister }] }

async function peekReply($: { tool: { call: (e: never) => Promise<unknown> } }) {
  const answer = (await $.tool.call({ tool: 'Peek' } as never)) as { result: string }
  return JSON.parse(answer.result).value ?? null
}

/** Reads a stream to its end the way the engine does, keeping its chunks and what it returned. */
async function drain<C, R>(stream: AsyncGenerator<C, R>) {
  const chunks: C[] = []
  let step = await stream.next()
  while (!step.done) {
    chunks.push(step.value)
    step = await stream.next()
  }
  return { chunks, result: step.value }
}

describe('the step hook', () => {
  test('passes every piece on untouched and keeps the text for the board', PEEK, async ($, on) => {
    mock.clock(on, { now: NOW })
    const answer = { ...DONE, answer: 'First line\nand a bit more' }
    on('turn.step', async function* () {
      yield { kind: 'thinking', index: 0, text: 'hmm' } as const
      yield { kind: 'text', index: 1, text: 'First line\n' } as const
      yield { kind: 'text', index: 1, text: 'and a bit more' } as const
      return answer
    })

    const { chunks, result } = await drain($.turn.step({ ...STEP, effort: 'high' }))

    expect(chunks).toEqual([
      { kind: 'thinking', index: 0, text: 'hmm' },
      { kind: 'text', index: 1, text: 'First line\n' },
      { kind: 'text', index: 1, text: 'and a bit more' },
    ])
    expect(result).toEqual(answer)
    expect(await peekReply($)).toEqual({ text: 'First line\nand a bit more', at: NOW, isWriting: false })
  })

  test('the next step of the same turn adds a new paragraph', PEEK, async ($, on) => {
    mock.clock(on, { now: NOW })
    let step = 0
    on('turn.step', async function* (_, e) {
      step += 1
      yield { kind: 'text', index: 0, text: step === 1 ? 'Reading the file.' : 'Done.' } as const
      return { ...DONE, index: e.index }
    })

    await drain($.turn.step(STEP))
    await drain($.turn.step({ ...STEP, index: 1 }))

    expect((await peekReply($)).text).toBe('Reading the file.\n\nDone.')
  })

  test('a subagent step is passed on and leaves the reply alone', PEEK, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'agentens text' } as const
      return { ...DONE, answer: 'agentens text' }
    })

    const { chunks, result } = await drain($.turn.step({ ...STEP, agentId: 'a1' }))

    expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'agentens text' }])
    expect(result).toEqual({ ...DONE, answer: 'agentens text' })
    expect(await peekReply($)).toBeNull()
  })

  test('a reply cut short (the person stops Claude) is kept and no longer marked as being written', PEEK, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'A long sentence that is cut off in the middle\n' } as const
      yield { kind: 'text', index: 0, text: 'never read' } as const
      return DONE
    })

    const stream = $.turn.step(STEP)
    await stream.next()
    await stream.return(DONE)

    expect(await peekReply($)).toEqual({ text: 'A long sentence that is cut off in the middle\n', at: NOW, isWriting: false })
  })

  test('a step that only calls tools leaves the reply as it was', PEEK, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('turn.step', async function* () {
      yield { kind: 'tool', index: 0, id: 'tu1', name: 'Bash' } as const
      return DONE
    })

    const { chunks } = await drain($.turn.step(STEP))

    expect(chunks).toHaveLength(1)
    expect(await peekReply($)).toBeNull()
  })
})

describe('the reply over a turn', () => {
  const complete = (turnId: string, answer: string) => ({ turnId, answer, durationMs: 5, isAborted: false, reason: 'answer' }) as const

  test('a new turn starts empty, and the turn\'s end keeps what was written', PEEK, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'This is the answer.' } as const
      return DONE
    })

    await $.turn.start({ text: 'first question', turnId: 't0' })
    await drain($.turn.step(STEP))
    await $.turn.complete(complete('t0', 'This is the answer.'))
    expect(await peekReply($)).toEqual({ text: 'This is the answer.', at: NOW, isWriting: false })

    await $.turn.start({ text: 'next question', turnId: 't1' })
    expect(await peekReply($)).toEqual({ text: '', at: NOW, isWriting: false })
  })

  test('when no text streamed, the turn\'s answer fills the reply', PEEK, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_, e) => ({ text: e.answer }))

    await $.turn.start({ text: 'question', turnId: 't1' })
    await $.turn.complete(complete('t1', 'The whole answer'))

    expect((await peekReply($)).text).toBe('The whole answer')
  })
})
