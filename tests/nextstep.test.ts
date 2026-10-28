import type { Register } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { replyChoices } from '../hooks/activity'

const NOW = Date.UTC(2026, 9, 20, 12, 30, 0)
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const ASK = {
  recap: 'Done, nothing committed.',
  ask: 'Shall I add the hook?',
  actions: [{ label: 'Yes, add it', message: 'Yes, add the hook to settings.' }, { label: 'Not now' }],
}

describe('the buttons of the next-step box', () => {
  test('each button says what it sends; one without a message sends its label', async () => {
    expect(replyChoices(ASK.actions)).toEqual([
      { label: 'Yes, add it', message: 'Yes, add the hook to settings.' },
      { label: 'Not now', message: 'Not now' },
    ])
  })

  test('the app actions, empty and odd buttons are left out, at most two kept', async () => {
    expect(replyChoices([{ action: 'commit' }, { label: '  ' }, 'nope', null, { label: 'A' }, { label: 'B' }, { label: 'C' }])).toEqual([
      { label: 'A', message: 'A' },
      { label: 'B', message: 'B' },
    ])
    expect(replyChoices(undefined)).toEqual([])
    expect(replyChoices([{ label: 'x'.repeat(80), message: 'y'.repeat(500) }])[0]).toEqual({ label: 'x'.repeat(40), message: 'y'.repeat(300) })
  })
})

const peekRegister: Register = on => {
  on('tool.call', { tool: 'Peek' }, async $ => ({ result: JSON.stringify(await $.state.get({ plugin: 'ccc', key: 'turn' })) }))
}
const PEEK = { plugins: [{ name: 'peek', register: peekRegister }] }

async function peekTurn($: { tool: { call: (e: never) => Promise<unknown> } }) {
  const answer = (await $.tool.call({ tool: 'Peek' } as never)) as { result: string }
  return JSON.parse(answer.result).value
}

describe('a turn that closes with the next-step box', () => {
  test('keeps its question and buttons once it has ended, and a new turn clears them', PEEK, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('tool.call', () => ({ result: 'shown' }))
    await $.turn.start({ turnId: 't1', text: 'Add the hook' })
    await $.tool.call({ tool: WRAP_UP, tool_use_id: 'w1', ...ASK } as never)
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
    const ended = await peekTurn($)
    expect(ended.ending).toBe('question')
    expect(ended.question).toBe('Shall I add the hook?')
    expect(ended.choices).toEqual(replyChoices(ASK.actions))

    await $.turn.start({ turnId: 't2', text: 'Yes, add the hook to settings.' })
    expect((await peekTurn($)).choices).toBeUndefined()
  })

  test('a box with only a recap has no buttons', PEEK, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('tool.call', () => ({ result: 'shown' }))
    await $.turn.start({ turnId: 't1', text: 'Finish it' })
    await $.tool.call({ tool: WRAP_UP, tool_use_id: 'w1', recap: 'Done.', actions: [{ label: 'Yes' }] } as never)
    await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 5, isAborted: false, reason: 'answer' })
    const ended = await peekTurn($)
    expect(ended.ending).toBe('done')
    expect(ended.choices).toBeUndefined()
  })
})
