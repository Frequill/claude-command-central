import { describe, expect, test } from 'claude-code/testing'

import { dayOf, openLedger, rollLedger, spentToday } from '../hooks/spend'

const MORNING = new Date(2026, 9, 19, 8, 0, 0).getTime()
const EVENING = new Date(2026, 9, 19, 22, 0, 0).getTime()
const YESTERDAY = new Date(2026, 9, 18, 15, 0, 0).getTime()
const TOMORROW = new Date(2026, 9, 20, 0, 5, 0).getTime()

describe('spend today', () => {
  test('the day is the local calendar date', async () => {
    expect(dayOf(MORNING)).toBe('2026-10-19')
    expect(dayOf(TOMORROW)).toBe('2026-10-20')
  })

  test('a session first launched today counts all of its cost', async () => {
    const ledger = openLedger(MORNING, EVENING, 3)
    expect(spentToday(ledger, 5)).toBe(5)
  })

  test('a session resumed from yesterday counts only what it costs from now', async () => {
    const ledger = openLedger(YESTERDAY, MORNING, 3)
    expect(spentToday(ledger, 5)).toBe(2)
  })

  test('at midnight the count starts over from the cost the day ended with', async () => {
    const ledger = rollLedger(openLedger(MORNING, EVENING, 0), TOMORROW, 7)
    expect(ledger).toEqual({ day: '2026-10-20', baseline: 7 })
    expect(spentToday(ledger, 7.5)).toBe(0.5)
  })

  test('the same day keeps its ledger', async () => {
    const ledger = openLedger(MORNING, MORNING, 0)
    expect(rollLedger(ledger, EVENING, 4)).toBe(ledger)
  })

  test('missing or broken costs count as nothing, and spend never goes negative', async () => {
    expect(openLedger(YESTERDAY, MORNING, undefined).baseline).toBe(0)
    expect(spentToday({ day: '2026-10-19', baseline: 4 }, 2)).toBe(0)
    expect(spentToday({ day: '2026-10-19', baseline: 0 }, Number.NaN)).toBe(0)
  })
})
