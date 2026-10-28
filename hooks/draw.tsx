import type { Elements } from 'claude-code'

import type { AgentRun, ContextFill, LogEntry, PlanStep, SessionStats } from '../types'

import { agentMapAlt, agentMapSvg } from './agentmap'
import { STATUS_WORD, bar, clip, clock, runTime, tokens } from './format'
import { limitName, resetTime, sparkline, usd } from './stats'

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Code'> & {
  Svg?: Elements['desktop']['Svg']
}

export type PaneData = {
  plan: readonly PlanStep[]
  runs: readonly AgentRun[]
  log: readonly LogEntry[]
  context: ContextFill | null
  stats: SessionStats
  now: number
  columns: number
}

const LOG_SHOWN = 10
const STEP_MARK = { completed: '✓', in_progress: '▶', pending: '○' } as const
const LOG_MARK = { running: '…', ok: '✓', error: '✗' } as const

export function drawPane(kit: Kit, data: PaneData) {
  const { Box } = kit
  const barWidth = Math.max(10, Math.min(40, data.columns - 14))

  return (
    <Box flexDirection="column" gap={1}>
      {drawSession(kit, data.stats, data.now, barWidth)}
      {drawProgress(kit, data.plan, barWidth)}
      {drawAgents(kit, data.runs, data.now, data.columns)}
      {drawLog(kit, data.log, data.columns)}
      {drawContext(kit, data.context, barWidth)}
    </Box>
  )
}

function heading(kit: Kit, text: string) {
  return <kit.Text bold>{text}</kit.Text>
}

function drawSession(kit: Kit, stats: SessionStats, now: number, width: number) {
  const { Box, Text } = kit
  const model = stats.model || 'unknown model'
  const effort = stats.effort ? ` · effort ${stats.effort}` : ''
  const cost =
    stats.costUsd === undefined ? 'no reading yet' : `${usd(stats.costUsd)} ${sparkline(stats.costHistory)}`

  return (
    <Box flexDirection="column" key="session">
      {heading(kit, 'Session')}
      <Text key="session-model">
        {model}
        {effort}
      </Text>
      <Text key="session-cost">Cost: {cost}</Text>
      {stats.limits.map(limit => {
        const reset = limit.resetsAt ? resetTime(limit.resetsAt, now) : ''
        return (
          <Text key={`limit-${limit.kind}`} color={limit.percentUsed >= 80 ? 'warning' : undefined}>
            {limitName(limit.kind)}: {bar(limit.percentUsed / 100, width)} {Math.round(limit.percentUsed)}%
            {reset ? ` · resets ${reset}` : ''}
          </Text>
        )
      })}
    </Box>
  )
}

function drawProgress(kit: Kit, plan: readonly PlanStep[], width: number) {
  const { Box, Text } = kit
  if (plan.length === 0) {
    return (
      <Box flexDirection="column" key="progress">
        {heading(kit, 'Progress')}
        <Text dimColor>No task list yet.</Text>
      </Box>
    )
  }
  const done = plan.filter(step => step.status === 'completed').length
  const current = plan.find(step => step.status === 'in_progress')

  return (
    <Box flexDirection="column" key="progress">
      {heading(kit, 'Progress')}
      <Text key="progress-count">
        {bar(done / plan.length, width)} {done} of {plan.length} done
      </Text>
      {current && <Text color="claude">Now: {current.text}</Text>}
      {plan.map((step, i) => (
        <Text key={`step-${i}`} dimColor={step.status === 'completed'}>
          {STEP_MARK[step.status]} {step.text}
        </Text>
      ))}
    </Box>
  )
}

function drawAgents(kit: Kit, runs: readonly AgentRun[], now: number, columns: number) {
  const { Box, Text, Svg } = kit
  const body =
    runs.length === 0 ? (
      <Text dimColor>No agents yet.</Text>
    ) : Svg ? (
      <Svg source={agentMapSvg(runs, now)} alt={agentMapAlt(runs)} isInteractive />
    ) : (
      runs.map(run => (
        <Text key={`run-${run.id}`}>
          {clip(`● ${run.label} · ${STATUS_WORD[run.status]} · ${runTime(run, now)}`, columns)}
        </Text>
      ))
    )

  return (
    <Box flexDirection="column" key="agents">
      {heading(kit, 'Agents')}
      {body}
    </Box>
  )
}

function drawLog(kit: Kit, log: readonly LogEntry[], columns: number) {
  const { Box, Text, Code } = kit
  const lines = log
    .slice(-LOG_SHOWN)
    .map(entry => {
      const who = entry.who ? `[${clip(entry.who, 16)}] ` : ''
      return clip(`${clock(entry.at)} ${LOG_MARK[entry.status]} ${who}${entry.text}`, columns)
    })

  return (
    <Box flexDirection="column" key="log">
      {heading(kit, 'Log')}
      {lines.length === 0 ? (
        <Text dimColor>Nothing has happened yet.</Text>
      ) : (
        <Code source={lines.join('\n')} language="text" />
      )}
    </Box>
  )
}

function drawContext(kit: Kit, context: ContextFill | null, width: number) {
  const { Box, Text } = kit
  const body = context ? (
    <Text key="context-fill">
      {bar(context.percent / 100, width)} {context.percent}% · {tokens(context.tokens)} of{' '}
      {tokens(context.window)}
    </Text>
  ) : (
    <Text dimColor>No reading yet.</Text>
  )

  return (
    <Box flexDirection="column" key="context">
      {heading(kit, 'Context')}
      {body}
    </Box>
  )
}
