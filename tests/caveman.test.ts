import { describe, expect, test } from 'claude-code/testing'

import { cavemanNote, levelInForce, readChoice, skillRules } from '../hooks/caveman'

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
})
