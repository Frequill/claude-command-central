import { describe, expect, test } from 'claude-code/testing'

import { askReason } from '../hooks/activity'

describe('why an approval box asks', () => {
  test('the reason the check gave, trimmed and kept to a sentence', async () => {
    expect(askReason('  Contains brace with quote character (expansion obfuscation)  ')).toBe('Contains brace with quote character (expansion obfuscation)')
    expect(askReason('x'.repeat(400))).toBe('x'.repeat(300))
  })

  test('none when the check gave none', async () => {
    expect(askReason('   ')).toBeUndefined()
    expect(askReason(undefined)).toBeUndefined()
    expect(askReason(42)).toBeUndefined()
  })
})
