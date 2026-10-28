import type { SpendLedger } from '../types'

/** The local calendar day of a moment, as YYYY-MM-DD. */
export function dayOf(ms: number): string {
  const at = new Date(ms)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * The ledger a session starts with: a session first launched today counts all of its cost,
 * one resumed from an earlier day counts only what it costs from now on.
 */
export function openLedger(startedAt: number, now: number, cost: number | undefined): SpendLedger {
  const day = dayOf(now)
  const isFromToday = dayOf(startedAt) === day
  return { day, baseline: isFromToday ? 0 : finite(cost) }
}

/** A new day starts counting from the cost the session had when the day turned. */
export function rollLedger(ledger: SpendLedger, now: number, previousCost: number | undefined): SpendLedger {
  const day = dayOf(now)
  return day === ledger.day ? ledger : { day, baseline: finite(previousCost) }
}

export function spentToday(ledger: SpendLedger, cost: number | undefined): number {
  return Math.max(0, finite(cost) - ledger.baseline)
}

function finite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}
