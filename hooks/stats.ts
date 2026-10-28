import type { SessionCost, SessionRateLimit } from 'claude-code'

import type { SessionStats } from '../types'

export const HISTORY_KEPT = 60
const SPARKS = '▁▂▃▄▅▆▇█'

export const EMPTY_STATS: SessionStats = { model: '', costHistory: [], limits: [] }

type Measure = { rateLimits: readonly SessionRateLimit[]; cost?: SessionCost }

/** Stats after a usage reading: the latest cost and limits, the cost kept as history. */
export function withMeasure(stats: SessionStats, measure: Measure): SessionStats {
  const limits = measure.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({
    kind,
    percentUsed,
    ...(resetsAt ? { resetsAt } : {}),
  }))
  const usd = measure.cost?.usd
  if (usd === undefined || !Number.isFinite(usd)) return { ...stats, limits }
  const costHistory = [...stats.costHistory, usd].slice(-HISTORY_KEPT)
  return { ...stats, limits, costUsd: usd, costHistory }
}

/** A text sparkline of the values, scaled between their lowest and highest. */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return ''
  const low = Math.min(...values)
  const span = Math.max(...values) - low
  const last = SPARKS.length - 1
  return values
    .map(value => SPARKS[span === 0 ? 0 : Math.round(((value - low) / span) * last)])
    .join('')
}

export function limitName(kind: string): string {
  if (kind === 'five_hour') return '5h limit'
  if (kind === 'seven_day') return 'Weekly limit'
  return kind.replace(/_/g, ' ')
}

/** When a limit resets: the time of day within a day, else the date. */
export function resetTime(resetsAt: string, now: number): string {
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  const isWithinDay = at.getTime() - now < 24 * 60 * 60 * 1000
  return isWithinDay
    ? `${pad(at.getHours())}:${pad(at.getMinutes())}`
    : `${at.getDate()}/${at.getMonth() + 1}`
}

export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`
}
