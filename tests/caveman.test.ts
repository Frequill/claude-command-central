import { describe, expect, test } from 'claude-code/testing'

import { cavemanNote, cavemanPrompt, levelInForce, readChoice, skillRules } from '../hooks/caveman'

describe('caveman mode switched from CCC', () => {
  test('a stored choice is a level, off, or nothing', () => {
    expect(readChoice('{"level":"ultra"}')).toBe('ultra')
    expect(readChoice('{"level":"off"}')).toBe('off')
    expect(readChoice('{"level":"wenyan-full"}')).toBeUndefined()
    expect(readChoice('not json')).toBeUndefined()
    expect(readChoice(undefined)).toBeUndefined()
  })

  test("the session's own choice wins over the default, and off stays off", () => {
    expect(levelInForce('lite', 'full')).toBe('lite')
    expect(levelInForce('off', 'full')).toBeUndefined()
    expect(levelInForce(undefined, 'full')).toBe('full')
    expect(levelInForce(undefined, undefined)).toBeUndefined()
  })

  test("the skill's rules come without its frontmatter, and a missing skill still gives rules", () => {
    expect(skillRules('---\nname: caveman\ndescription: x\n---\n\nTalk terse.\n')).toBe('Talk terse.')
    expect(skillRules(undefined)).toContain('caveman')
  })

  test('switched on, or to another level, the message carries the whole rules', () => {
    expect(cavemanNote('full', undefined, 'Talk terse.')).toContain('Talk terse.')
    expect(cavemanNote('ultra', 'full', 'Talk terse.')).toContain('at the ultra level')
    expect(cavemanNote('lite', 'off', 'Talk terse.')).toContain('Talk terse.')
  })

  test('while it stays on, every message carries the whole rules again; switched off, one line; never on, nothing', () => {
    const again = cavemanNote('full', 'full', 'Talk terse.')
    expect(again).toContain('still on')
    expect(again).toContain('at the full level')
    expect(again).toContain('Talk terse.')
    expect(cavemanNote(undefined, 'ultra', 'Talk terse.')).toContain('switched off')
    expect(cavemanNote(undefined, 'off', 'Talk terse.')).toBeUndefined()
    expect(cavemanNote(undefined, undefined, 'Talk terse.')).toBeUndefined()
  })

  test('after a restart, a stored off is said once, as earlier messages may have switched it on', () => {
    expect(cavemanNote(undefined, undefined, '', true)).toContain('write normally again')
    expect(cavemanNote(undefined, 'off', '', true)).toBeUndefined()
  })

  test("a message from CCC goes through the caveman skill every time it is on, and says off once", () => {
    expect(cavemanPrompt('Fix the login bug', 'full', undefined, true)).toBe('/caveman full Fix the login bug')
    expect(cavemanPrompt('And the tests', 'full', 'full', true)).toBe('/caveman full And the tests')
    expect(cavemanPrompt('Explain it', 'ultra', 'full', true)).toBe('/caveman ultra Explain it')
    // switched off: the first message after says so with the skill's own words, then nothing
    expect(cavemanPrompt('Explain it', undefined, 'full', true)).toBe('stop caveman\n\nExplain it')
    expect(cavemanPrompt('Explain it', undefined, 'off', true)).toBe('Explain it')
    expect(cavemanPrompt('Explain it', undefined, undefined, true)).toBe('Explain it')
    // a session with no caveman skill gets the message as written
    expect(cavemanPrompt('Fix the login bug', 'full', undefined, false)).toBe('Fix the login bug')
  })
})
