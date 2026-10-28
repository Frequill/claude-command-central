import { describe, expect, test } from 'claude-code/testing'

import type { AgentRun, LogEntry, PlanStep } from '../types'

import {
  LOG_KEPT,
  countTool,
  describeCall,
  endingOf,
  placeAgent,
  pushLog,
  readContext,
  settleLog,
  runFor,
  settleRun,
  toolKind,
  trackAgent,
  waitFor,
} from '../hooks/activity'
import { agentMapSvg } from '../hooks/agentmap'
import { bar, duration, tokens } from '../hooks/format'
import { applyPlanUpdate, completeAll, readPlanUpdate } from '../hooks/plan'
import { HISTORY_KEPT, resetTime, sparkline, withMeasure } from '../hooks/stats'

const THREE: PlanStep[] = [
  { text: 'Read', status: 'in_progress' },
  { text: 'Skriv', status: 'pending' },
  { text: 'Testa', status: 'pending' },
]

const statuses = (steps: PlanStep[]) => steps.map(step => step.status)

describe('plan', () => {
  test('a new list of items replaces the plan', async () => {
    const update = readPlanUpdate({ items: [{ content: 'Ett', status: 'in_progress' }] })
    expect(applyPlanUpdate(THREE, update)).toEqual([{ text: 'Ett', status: 'in_progress' }])
  })

  test('advance completes the current step and starts the next pending one', async () => {
    const next = applyPlanUpdate(THREE, readPlanUpdate({ advance: true }))
    expect(statuses(next)).toEqual(['completed', 'in_progress', 'pending'])
  })

  test('advance on the last step only completes it', async () => {
    const last: PlanStep[] = [
      { text: 'A', status: 'completed' },
      { text: 'B', status: 'in_progress' },
    ]
    expect(statuses(applyPlanUpdate(last, { advance: true }))).toEqual(['completed', 'completed'])
  })

  test('advance with nothing in progress starts the first pending step', async () => {
    const idle: PlanStep[] = [{ text: 'A', status: 'pending' }]
    expect(statuses(applyPlanUpdate(idle, { advance: true }))).toEqual(['in_progress'])
  })

  test('done and start mark steps by their 1-based number', async () => {
    const next = applyPlanUpdate(THREE, readPlanUpdate({ done: [1, 2], start: 3 }))
    expect(statuses(next)).toEqual(['completed', 'completed', 'in_progress'])
  })

  test('step numbers out of range or malformed are ignored', async () => {
    const update = readPlanUpdate({ done: [0, 9, 1.5, 'x'], start: -1 })
    expect(applyPlanUpdate(THREE, update)).toEqual(THREE)
  })

  test('malformed items are dropped and unknown statuses read as pending', async () => {
    const update = readPlanUpdate({
      items: [null, 'text', { status: 'completed' }, { content: 'Ok', status: 'weird' }],
    })
    expect(update.items).toEqual([{ text: 'Ok', status: 'pending' }])
  })

  test('wrapping up completes every step', async () => {
    expect(statuses(completeAll(THREE))).toEqual(['completed', 'completed', 'completed'])
  })
})

describe('log lines', () => {
  test('a shell command shows its first line', async () => {
    expect(describeCall('Bash', { command: 'git status\ngit diff' })).toBe('$ git status …')
  })

  test('a long path is cut to its last three parts', async () => {
    const text = describeCall('Read', { file_path: '/Users/a/Documents/Work/shop/build.gradle' })
    expect(text).toBe('Read …/Work/shop/build.gradle')
  })

  test('task list and wrap-up calls stay out of the log', async () => {
    expect(describeCall('mcp__ccd_turn__update_plan', { advance: true })).toBeUndefined()
    expect(describeCall('mcp__ccd_turn__wrap_up', { recap: 'x' })).toBeUndefined()
  })

  test('a screenshot is named as one', async () => {
    const text = describeCall('mcp__Claude_Browser__computer', { action: 'screenshot' })
    expect(text).toBe('Screenshot (browser)')
  })

  test('an MCP server named by an id shows only the tool name', async () => {
    const tool = 'mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch'
    expect(describeCall(tool, {})).toBe('batch')
    expect(describeCall('mcp__github__create_issue', {})).toBe('github: create_issue')
  })

  test('a very long line is clipped', async () => {
    const text = describeCall('Bash', { command: 'x'.repeat(500) }) ?? ''
    expect(text.length).toBe(90)
    expect(text.endsWith('…')).toBe(true)
  })

  test('missing fields do not break a line', async () => {
    expect(describeCall('Read', {})).toBe('Read ')
    expect(describeCall('UnknownTool', {})).toBe('UnknownTool')
  })

  test('calls are grouped into kinds for the tool mix', async () => {
    expect(toolKind('Write')).toBe('Edit')
    expect(toolKind('Glob')).toBe('Search')
    expect(toolKind('mcp__ccd_session__start_session')).toBe('Agent')
    expect(toolKind('mcp__Claude_Browser__navigate')).toBe('Web')
    expect(toolKind('mcp__github__create_issue')).toBe('MCP')
    expect(toolKind('SomethingNew')).toBe('Other')
  })

  test('counting a kind adds one without touching the others', async () => {
    const counts = { Bash: 2 }
    expect(countTool(counts, 'Bash')).toEqual({ Bash: 3 })
    expect(countTool(counts, 'Read')).toEqual({ Bash: 2, Read: 1 })
    expect(counts).toEqual({ Bash: 2 })
  })

  test('settling a call records how it ended and when', async () => {
    const log: LogEntry[] = [{ id: 'a', at: 1, text: 'x', status: 'running' }]
    expect(settleLog(log, 'a', 'error', 9)).toEqual([{ id: 'a', at: 1, text: 'x', status: 'error', endedAt: 9 }])
    expect(settleLog(log, 'b', 'ok', 9)).toEqual(log)
  })

  test('the log keeps only the latest entries', async () => {
    let log: LogEntry[] = []
    for (let i = 0; i < LOG_KEPT + 5; i += 1) {
      log = pushLog(log, { id: String(i), at: i, text: `line ${i}`, status: 'ok' })
    }
    expect(log).toHaveLength(LOG_KEPT)
    expect(log[0]?.id).toBe('5')
  })
})

describe('agent runs', () => {
  test('a background agent keeps running after its call answers', async () => {
    const run = runFor('Agent', { description: 'Granska' }, 't1', 0) as AgentRun
    expect(settleRun(run, false, {}, 5).status).toBe('running')
  })

  test('a foreground agent is done once its call answers', async () => {
    const input = { description: 'Granska', run_in_background: false }
    const run = runFor('Agent', input, 't1', 0) as AgentRun
    expect(settleRun(run, false, input, 5)).toMatchObject({ status: 'done', endedAt: 5 })
  })

  test('a failed call fails its run', async () => {
    const run = runFor('Workflow', { script: "export const meta = { name: 'review' }" }, 't1', 0)
    expect(run?.label).toBe('review')
    expect(settleRun(run as AgentRun, true, {}, 5).status).toBe('failed')
  })

  test('a session card that is only offered shows as proposed', async () => {
    const tool = 'mcp__ccd_session__start_session'
    expect(runFor(tool, { title: 'Fix', initiation: 'offer' }, 't1', 0)?.status).toBe('proposed')
    expect(runFor(tool, { title: 'Fix', initiation: 'user_asked' }, 't1', 0)?.status).toBe('started')
  })

  test('an Agent call gets the id of the agent it started', async () => {
    const run = runFor('Agent', { description: 'Granska' }, 't1', 0) as AgentRun
    expect(placeAgent([run], { tool_use_id: 't1' }, 'a1', 5)).toEqual([{ ...run, agentId: 'a1' }])
    expect(placeAgent([run], { tool_use_id: 'other' }, 'a1', 5)).toEqual([run])
  })

  test('each agent of a workflow gets a run of its own under the workflow', async () => {
    const flow = runFor('Workflow', { script: "export const meta = { name: 'probe' }" }, 'w1', 0) as AgentRun
    let list = placeAgent([flow], { tool_use_id: 'w1', description: ' Kolla zsh ', workflow: { agentIndex: 0 } }, 'a1', 5)
    list = placeAgent(list, { tool_use_id: 'w1', name: 'granskare', workflow: { agentIndex: 1 } }, 'a2', 6)
    list = placeAgent(list, { tool_use_id: 'w1', workflow: { agentIndex: 2 } }, 'a3', 7)
    expect(list[0]).toEqual(flow)
    expect(list.slice(1)).toEqual([
      { id: 'a1', kind: 'agent', label: 'Kolla zsh', status: 'running', startedAt: 5, agentId: 'a1', parentId: 'w1' },
      { id: 'a2', kind: 'agent', label: 'granskare', status: 'running', startedAt: 6, agentId: 'a2', parentId: 'w1' },
      { id: 'a3', kind: 'agent', label: 'Agent 3', status: 'running', startedAt: 7, agentId: 'a3', parentId: 'w1' },
    ])
  })

  test('a workflow agent the board missed the start of still shows, and a resumed one runs again', async () => {
    const orphan = placeAgent([], { tool_use_id: 'w9', description: 'Sen', workflow: { agentIndex: 0 } }, 'a1', 5)
    expect(orphan).toEqual([{ id: 'a1', kind: 'agent', label: 'Sen', status: 'running', startedAt: 5, agentId: 'a1', parentId: 'w9' }])
    const finished = [{ ...orphan[0], status: 'done', endedAt: 8 }] as AgentRun[]
    expect(placeAgent(finished, { tool_use_id: 'w9', workflow: { agentIndex: 0 } }, 'a1', 9)).toEqual(orphan)
  })

  test('other tools start no run', async () => {
    expect(runFor('Bash', { command: 'ls' }, 't1', 0)).toBeUndefined()
  })

  test('the agent list moves a run to done or failed', async () => {
    const run = runFor('Agent', { description: 'A' }, 't1', 0) as AgentRun
    expect(trackAgent(run, 'completed', 9)).toMatchObject({ status: 'done', endedAt: 9 })
    expect(trackAgent(run, 'killed', 9).status).toBe('failed')
    expect(trackAgent(run, 'waiting', 9)).toBe(run)
  })

  test('labels are escaped in the agent map', async () => {
    const run = runFor('Agent', { description: '<script>&"' }, 't1', 0) as AgentRun
    const svg = agentMapSvg([run], 1000)
    expect(svg.includes('<script>')).toBe(false)
    expect(svg.includes('&lt;script&gt;&amp;&quot;')).toBe(true)
  })

  test('the agent map has one node per run besides the session', async () => {
    const runs = ['a', 'b', 'c'].map(id => runFor('Agent', { description: id }, id, 0) as AgentRun)
    expect(agentMapSvg(runs, 0).match(/<rect /g)).toHaveLength(4)
  })
})

describe('usage', () => {
  test('context fill is null before the first reading', async () => {
    expect(readContext({ window: 1000 })).toBeNull()
    expect(readContext({ tokens: 10, window: 0 })).toBeNull()
  })

  test('context percent is computed when the engine gives none', async () => {
    expect(readContext({ tokens: 250, window: 1000 })).toEqual({ percent: 25, tokens: 250, window: 1000 })
  })

  test('cost readings build a capped history; a bad reading is skipped', async () => {
    let stats = { model: 'm', costHistory: [] as number[], limits: [] }
    for (let i = 0; i < HISTORY_KEPT + 3; i += 1) stats = withMeasure(stats, { rateLimits: [], cost: { usd: i } })
    expect(stats.costHistory).toHaveLength(HISTORY_KEPT)
    const after = withMeasure(stats, { rateLimits: [], cost: { usd: Number.NaN } })
    expect(after.costHistory).toEqual(stats.costHistory)
  })

  test('limits are copied from the reading', async () => {
    const stats = withMeasure(
      { model: 'm', costHistory: [], limits: [] },
      { rateLimits: [{ kind: 'five_hour', percentUsed: 42 }] },
    )
    expect(stats.limits).toEqual([{ kind: 'five_hour', percentUsed: 42 }])
  })

  test('sparkline spans lowest to highest, flat when all equal', async () => {
    expect(sparkline([0, 7, 14])).toBe('▁▅█')
    expect(sparkline([3, 3])).toBe('▁▁')
    expect(sparkline([])).toBe('')
  })

  test('an unreadable reset time shows nothing', async () => {
    expect(resetTime('not a date', 0)).toBe('')
  })

  test('bars, durations and token counts format for reading', async () => {
    expect(bar(0.5, 10)).toBe('█████░░░░░')
    expect(bar(2, 4)).toBe('████')
    expect(bar(Number.NaN, 4)).toBe('░░░░')
    expect(duration(65_000)).toBe('1m 5s')
    expect(tokens(122_200)).toBe('122.2k')
    expect(tokens(1_000_000)).toBe('1M')
  })
})

describe('what a session waits for', () => {
  test('a question box waits for an answer and carries its first question', async () => {
    const wait = waitFor('AskUserQuestion', { questions: [{ question: 'Which branch?' }, { question: 'More?' }] })
    expect(wait).toEqual({ kind: 'question', text: 'Which branch?' })
    expect(waitFor('AskUserQuestion', {})).toEqual({ kind: 'question' })
  })

  test('a plan waits for review; an offered session card waits for an answer', async () => {
    expect(waitFor('ExitPlanMode', { plan: 'x' })).toEqual({ kind: 'plan' })
    expect(waitFor('mcp__ccd_session__start_session', { initiation: 'offer', title: 'Fix CI' })?.kind).toBe('question')
    expect(waitFor('mcp__ccd_session__start_session', { initiation: 'user_asked', title: 'Fix CI' })).toBeUndefined()
    expect(waitFor('Bash', { command: 'ls' })).toBeUndefined()
  })

  test('a turn that closes with a question asks; otherwise it is done', async () => {
    expect(endingOf('Shall I build it?', 'Done.')).toEqual({ ending: 'question', question: 'Shall I build it?' })
    expect(endingOf(undefined, 'Here is the fix.\n\nWant me to commit it?')).toEqual({ ending: 'question', question: 'Want me to commit it?' })
    expect(endingOf(undefined, 'All tests pass.')).toEqual({ ending: 'done' })
    expect(endingOf('   ', '')).toEqual({ ending: 'done' })
  })
})
