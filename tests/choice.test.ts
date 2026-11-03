import { describe, expect, test } from 'claude-code/testing'

import { readSessionChoice, withChoice } from '../hooks/choice'

describe('a model and effort picked for one session in CCC', () => {
  test('a stored choice keeps only a model name and an effort level', () => {
    expect(readSessionChoice('{"model":"opus","effort":"high"}')).toEqual({ model: 'opus', effort: 'high' })
    expect(readSessionChoice('{"model":"opus[1m]"}')).toEqual({ model: 'opus[1m]' })
    expect(readSessionChoice('{"model":"claude-fable-5-1"}')).toEqual({ model: 'claude-fable-5-1' })
    expect(readSessionChoice('{"model":"opus; rm -rf","effort":"huge"}')).toEqual({})
    expect(readSessionChoice('{"model":5}')).toEqual({})
    expect(readSessionChoice('not json')).toEqual({})
    expect(readSessionChoice(undefined)).toEqual({})
  })

  test("each request goes out with the session's choice, the rest of it as the engine made it", () => {
    const step = { turnId: 't1', index: 0, model: 'claude-fable-5-1', effort: 'medium' as const, messageCount: 3 }
    expect(withChoice(step, { model: 'opus', effort: 'max' })).toEqual({ ...step, model: 'opus', effort: 'max' })
    expect(withChoice(step, { effort: 'low' })).toEqual({ ...step, effort: 'low' })
    expect(withChoice(step, {})).toEqual(step)
  })
})
