import type { AgentRun, RunStatus } from '../types'

export const STATUS_WORD: Record<RunStatus, string> = {
  running: 'working',
  done: 'done',
  failed: 'failed',
  started: 'started',
  proposed: 'proposed',
}

export const STATUS_COLOR: Record<RunStatus, string> = {
  running: '#3b82f6',
  done: '#16a34a',
  failed: '#dc2626',
  started: '#64748b',
  proposed: '#94a3b8',
}

export function bar(fraction: number, width: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  const filled = Math.round(clamped * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function runTime(run: AgentRun, now: number): string {
  return duration((run.endedAt ?? now) - run.startedAt)
}

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${trim(count / 1_000_000)}M`
  if (count >= 1_000) return `${trim(count / 1_000)}k`
  return String(count)
}

export function clock(ms: number): string {
  const at = new Date(ms)
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map(part => String(part).padStart(2, '0'))
    .join(':')
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '…'
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}
