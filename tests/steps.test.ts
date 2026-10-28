import type { Register } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { AgentRun } from '../types'
import { addStep, settleStep } from '../hooks/activity'
import { agentPlanAfter } from '../hooks/plan'

const NOW = Date.UTC(2026, 9, 22, 13, 0, 0)
const AGENT: AgentRun = { id: 't1', kind: 'agent', label: 'Review the client', status: 'running', startedAt: 1, agentId: 'a1' }
const OTHER: AgentRun = { id: 't2', kind: 'agent', label: 'Granska backend', status: 'running', startedAt: 1, agentId: 'a2' }

describe('the steps of an agent', () => {
  test('each step goes last and is counted; the agent shows it as its latest action', async () => {
    const one = addStep([AGENT, OTHER], 'a1', { id: 's1', at: 10, text: 'Read …/client.go', status: 'running' })
    expect(one[0]).toEqual({ ...AGENT, lastAction: 'Read …/client.go', stepCount: 1, steps: [{ id: 's1', at: 10, text: 'Read …/client.go', status: 'running' }] })
    expect(one[1]).toBe(OTHER)
    const two = addStep(one, 'a1', { id: 's2', at: 20, text: '$ go test ./...', status: 'running' })
    expect(two[0]?.steps?.map(step => step.id)).toEqual(['s1', 's2'])
    expect(two[0]?.stepCount).toBe(2)
  })

  test('only the last sixty steps are kept, the count goes on', async () => {
    let list: AgentRun[] = [AGENT]
    for (let i = 1; i <= 75; i += 1) list = addStep(list, 'a1', { id: `s${i}`, at: i, text: `Read ${i}`, status: 'ok' })
    expect(list[0]?.stepCount).toBe(75)
    expect(list[0]?.steps?.length).toBe(60)
    expect(list[0]?.steps?.[0]?.id).toBe('s16')
  })

  test('a step that ends is marked as it went; another agent and an unknown step are left alone', async () => {
    const list = addStep([AGENT, OTHER], 'a1', { id: 's1', at: 10, text: 'Read x', status: 'running' })
    const settled = settleStep(list, 'a1', 's1', 'error', 15)
    expect(settled[0]?.steps).toEqual([{ id: 's1', at: 10, text: 'Read x', status: 'error', endedAt: 15 }])
    expect(settleStep(list, 'a2', 's1', 'ok', 15)).toEqual(list)
    expect(settleStep(list, 'a1', 'nope', 'ok', 15)[0]).toEqual(list[0])
  })
})

const peekRegister: Register = on => {
  on('tool.call', { tool: 'Peek' }, async $ => ({
    result: JSON.stringify({ runs: (await $.state.get({ plugin: 'ccc', key: 'runs' })).value, turn: (await $.state.get({ plugin: 'ccc', key: 'turn' })).value }),
  }))
}

async function peek($: { tool: { call: (e: never) => Promise<unknown> } }) {
  const answer = (await $.tool.call({ tool: 'Peek' } as never)) as { result: string }
  return JSON.parse(answer.result) as { runs: AgentRun[]; turn: { waiting?: unknown } }
}

describe('an agent at work', () => {
  test('its own tool calls become its steps, each settled as it ends', { plugins: [{ name: 'peek', register: peekRegister }] }, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('tool.call', (_, e) => (e.tool === 'Bash' ? { result: 'fail', isError: true } : { result: 'ok' }))
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
    await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'Review the client', prompt: 'p', run_in_background: true } as never)
    await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Review the client', subagentType: 'general-purpose', provider: 'anthropic', parentModel: 'm', background: true, fork: false } as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 's1', file_path: '/repo/client.go', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Bash', tool_use_id: 's2', command: 'go test ./...', agentId: 'a1' } as never)
    const [run] = (await peek($)).runs
    expect(run?.stepCount).toBe(2)
    expect(run?.steps?.map(step => [step.id, step.status])).toEqual([
      ['s1', 'ok'],
      ['s2', 'error'],
    ])
    expect(run?.lastAction).toBe(run?.steps?.[1]?.text)
  })
})

describe('the plan an agent keeps', () => {
  test('a whole list it writes is its plan', async () => {
    const todos = [
      { content: 'Read the client', status: 'completed', activeForm: 'Reading' },
      { content: 'Run the tests', status: 'in_progress', activeForm: 'Running' },
      { content: 'Skriv rapporten', status: 'odd', activeForm: 'Skriver' },
    ]
    expect(agentPlanAfter([], 'TodoWrite', { todos }, undefined)).toEqual([
      { text: 'Read the client', status: 'completed' },
      { text: 'Run the tests', status: 'in_progress' },
      { text: 'Skriv rapporten', status: 'pending' },
    ])
    expect(agentPlanAfter([], 'mcp__ccd_turn__update_plan', { items: [{ content: 'Ett', status: 'in_progress' }] }, undefined)).toEqual([{ text: 'Ett', status: 'in_progress' }])
  })

  test('tasks it adds and changes one by one, by their ids', async () => {
    const one = agentPlanAfter([], 'TaskCreate', { subject: 'Read the client', description: 'd' }, { task: { id: '1', subject: 'Read the client' } }) ?? []
    const two = agentPlanAfter(one, 'TaskCreate', { subject: 'Run the tests', description: 'd' }, 'Task #2 created successfully: Run the tests') ?? []
    expect(two).toEqual([
      { text: 'Read the client', status: 'pending', id: '1' },
      { text: 'Run the tests', status: 'pending', id: '2' },
    ])
    const started = agentPlanAfter(two, 'TaskUpdate', { taskId: '1', status: 'completed' }, undefined) ?? []
    expect(started[0]?.status).toBe('completed')
    expect(agentPlanAfter(started, 'TaskUpdate', { taskId: '2', status: 'deleted' }, undefined)).toEqual([started[0]])
    expect(agentPlanAfter(two, 'TaskUpdate', { taskId: '9', status: 'completed' }, undefined)).toEqual(two)
  })

  test('any other call leaves the plan', async () => {
    expect(agentPlanAfter([], 'Read', { file_path: '/x' }, 'text')).toBeUndefined()
    expect(agentPlanAfter([], 'TodoWrite', { todos: 'nope' }, undefined)).toBeUndefined()
    expect(agentPlanAfter([], 'TaskCreate', { subject: '  ' }, undefined)).toBeUndefined()
  })
})

const planPeekRegister: Register = on => {
  on('tool.call', { tool: 'Peek' }, async $ => ({
    result: JSON.stringify({ runs: (await $.state.get({ plugin: 'ccc', key: 'runs' })).value, plan: (await $.state.get({ plugin: 'ccc', key: 'plan' })).value }),
  }))
}

describe('an agent with a task list of its own', () => {
  test('keeps it on its run, and never touches the session list', { plugins: [{ name: 'peek', register: planPeekRegister }] }, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('tool.call', () => ({ result: 'ok' }))
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', tool_use_id: 'p0', items: [{ content: 'Sessionens steg', status: 'in_progress' }] } as never)
    await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'Granska', prompt: 'p', run_in_background: true } as never)
    await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Granska', subagentType: 'general-purpose', provider: 'anthropic', parentModel: 'm', background: true, fork: false } as never)
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'p1', todos: [{ content: 'Read', status: 'in_progress', activeForm: 'Reading' }], agentId: 'a1' } as never)
    await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', tool_use_id: 'p2', recap: 'Done.', agentId: 'a1' } as never)
    const seen = JSON.parse(((await $.tool.call({ tool: 'Peek' } as never)) as { result: string }).result) as { runs: AgentRun[]; plan: unknown }
    expect(seen.runs[0]?.plan).toEqual([{ text: 'Read', status: 'in_progress' }])
    expect(seen.plan).toEqual([{ text: 'Sessionens steg', status: 'in_progress' }])
  })
})
