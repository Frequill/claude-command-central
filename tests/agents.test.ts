import type { Register } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { AgentRun } from '../types'
import { backgroundRunFor, finishAgent, isOnlyNotification, isOnlyStoppedReport, proposalOf, rememberStopped, resumeAgent, runFor, settleRun, settleTasks, startProposal, stopRunIn, stopTarget, stopTaskOf, stoppedByUs, trackAgent } from '../hooks/activity'

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)
const FLOW: AgentRun = { id: 'w1', kind: 'workflow', label: 'probe', status: 'started', startedAt: 1 }
const A1: AgentRun = { id: 'a1', kind: 'agent', label: 'zsh', status: 'running', startedAt: 2, agentId: 'a1', parentId: 'w1' }
const A2: AgentRun = { id: 'a2', kind: 'agent', label: 'anrop', status: 'running', startedAt: 3, agentId: 'a2', parentId: 'w1' }

const notification = (id: string, status: string) =>
  `<task-notification>\n<task-id>x1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`

describe('agents that finish', () => {
  test('an agent whose turn ends is done, or failed when it did not end in an answer', async () => {
    expect(finishAgent([FLOW, A1, A2], 'a1', 'answer', 9)).toEqual([FLOW, { ...A1, status: 'done', endedAt: 9 }, A2])
    expect(finishAgent([A1], 'a1', 'error', 9)[0]).toMatchObject({ status: 'failed', endedAt: 9 })
    expect(finishAgent([A1], 'a1', 'aborted', 9)[0]?.status).toBe('failed')
    expect(finishAgent([A1], 'other', 'answer', 9)).toEqual([A1])
    const done = { ...A1, status: 'done' as const, endedAt: 5 }
    expect(finishAgent([done], 'a1', 'error', 9)).toEqual([done])
  })

  test('an agent that starts a turn again works again', async () => {
    expect(resumeAgent([{ ...A1, status: 'done', endedAt: 5 }], 'a1')).toEqual([A1])
    expect(resumeAgent([A1], 'a1')).toEqual([A1])
    expect(resumeAgent([FLOW], 'w1')).toEqual([FLOW])
  })

  test('a finish report settles the run it names, and a finished workflow its agents still working', async () => {
    const done = { ...A1, status: 'done' as const, endedAt: 5 }
    const settled = settleTasks([FLOW, done, A2], `hi\n${notification('w1', 'completed')}`, 9)
    expect(settled).toEqual([{ ...FLOW, status: 'done', endedAt: 9 }, done, { ...A2, status: 'done', endedAt: 9 }])
    expect(settleTasks([FLOW, A2], notification('w1', 'failed'), 9).map(r => r.status)).toEqual(['failed', 'failed'])
    expect(settleTasks([FLOW], notification('w1', 'running'), 9)).toEqual([FLOW])
    expect(settleTasks([FLOW], notification('other', 'completed'), 9)).toEqual([FLOW])
    expect(settleTasks([FLOW], 'no report here', 9)).toEqual([FLOW])
    expect(settleTasks([FLOW], '<task-notification><status>completed</status></task-notification>', 9)).toEqual([FLOW])
  })

  test('two reports in one prompt settle both', async () => {
    const lone: AgentRun = { id: 't9', kind: 'agent', label: 'Granska', status: 'running', startedAt: 1 }
    const text = `${notification('w1', 'completed')}\n${notification('t9', 'killed')}`
    expect(settleTasks([FLOW, lone], text, 9).map(r => r.status)).toEqual(['done', 'failed'])
  })

  test('a prompt that is only a report is told apart from one the person wrote', async () => {
    expect(isOnlyNotification(notification('w1', 'completed'))).toBe(true)
    expect(isOnlyNotification(`<system-reminder>x</system-reminder>\n${notification('w1', 'completed')}`)).toBe(true)
    expect(isOnlyNotification(`${notification('w1', 'completed')}\nwhat happened?`)).toBe(false)
    expect(isOnlyNotification('a plain question')).toBe(false)
  })
})

const peekRegister: Register = on => {
  on('tool.call', { tool: 'Peek' }, async $ => ({
    result: JSON.stringify({ runs: (await $.state.get({ plugin: 'ccc', key: 'runs' })).value, chat: (await $.state.get({ plugin: 'ccc', key: 'chat' })).value }),
  }))
}

async function peek($: { tool: { call: (e: never) => Promise<unknown> } }) {
  const answer = (await $.tool.call({ tool: 'Peek' } as never)) as { result: string }
  return JSON.parse(answer.result) as { runs: AgentRun[]; chat: { prompt: string }[] | null }
}

describe('a workflow from start to finish', () => {
  test('its agents finish one by one, and the finish report closes the workflow', { plugins: [{ name: 'peek', register: peekRegister }] }, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('tool.call', () => ({ result: 'Workflow launched in background.' }))
    on('agent.spawn', (_, e) => ({ model: 'claude-opus-5-5', agentId: e.description === 'Kolla zsh' ? 'a1' : 'a2' }))
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    await $.tool.call({ tool: 'Workflow', tool_use_id: 'w1', script: "export const meta = { name: 'probe' }" } as never)
    const spawn = { tool_use_id: 'w1', prompt: 'p', subagentType: 'general-purpose', provider: 'anthropic', parentModel: 'm', background: true, fork: false }
    await $.agent.spawn({ ...spawn, description: 'Kolla zsh', workflow: { runId: 'r1', agentIndex: 0 } } as never)
    await $.agent.spawn({ ...spawn, description: 'Granska anropen', workflow: { runId: 'r1', agentIndex: 1 } } as never)

    await $.turn.complete({ turnId: 'ta1', agentId: 'a1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
    expect((await peek($)).runs.map(r => [r.label, r.status])).toEqual([['probe', 'started'], ['Kolla zsh', 'done'], ['Granska anropen', 'running']])

    await $.turn.start({ turnId: 't2', text: notification('w1', 'completed') })
    const after = await peek($)
    expect(after.runs.map(r => [r.label, r.status])).toEqual([['probe', 'done'], ['Kolla zsh', 'done'], ['Granska anropen', 'done']])
    expect(after.chat ?? []).toEqual([])
  })
})

describe('commands in the background', () => {
  const OUT = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }

  test('a command that goes on in the background becomes a run, named by what it does', async () => {
    expect(backgroundRunFor('Bash', { command: 'npm test', description: 'Run the tests' }, OUT, 't1', 5)).toEqual({
      id: 't1',
      kind: 'command',
      label: 'Run the tests',
      status: 'running',
      startedAt: 5,
      // its task, so Stop on the agent map can end it
      taskId: 'b1',
    })
    expect(backgroundRunFor('Bash', { command: 'sleep 60\necho done' }, OUT, 't1', 5)?.label).toBe('sleep 60 …')
    expect(backgroundRunFor('Bash', {}, OUT, 't1', 5)?.label).toBe('Background command')
  })

  test('a command that ran to its end, or ends with the final answer, gets no run', async () => {
    expect(backgroundRunFor('Bash', { command: 'ls' }, { ...OUT, backgroundTaskId: undefined }, 't1', 5)).toBeUndefined()
    expect(backgroundRunFor('Bash', { command: 'ls' }, { ...OUT, backgroundEndsWithFinalResponse: true }, 't1', 5)).toBeUndefined()
    expect(backgroundRunFor('Bash', { command: 'ls' }, 'text', 't1', 5)).toBeUndefined()
    expect(backgroundRunFor('Read', { file_path: '/x' }, OUT, 't1', 5)).toBeUndefined()
  })

  test('it works on the map until the finish report comes', { plugins: [{ name: 'peek', register: peekRegister }] }, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('tool.call', () => ({ result: OUT }))
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    await $.tool.call({ tool: 'Bash', tool_use_id: 'tb1', command: 'npm test', description: 'Run the tests', run_in_background: true } as never)
    expect((await peek($)).runs).toEqual([{ id: 'tb1', kind: 'command', label: 'Run the tests', status: 'running', startedAt: NOW, taskId: 'b1' }])

    await $.turn.start({ turnId: 't2', text: notification('tb1', 'failed') })
    expect((await peek($)).runs.map(r => [r.label, r.status])).toEqual([['Run the tests', 'failed']])
  })

  test('a subagent command stays off the map', { plugins: [{ name: 'peek', register: peekRegister }] }, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('tool.call', () => ({ result: OUT }))
    await $.tool.call({ tool: 'Bash', tool_use_id: 'tb2', command: 'npm test', agentId: 'a1' } as never)
    expect((await peek($)).runs ?? []).toEqual([])
  })
})

describe('session cards proposed and started later', () => {
  const START = 'mcp__ccd_session__start_session'
  const ANSWER = 'Proposed "CCC chat: read history" (task_id: task_4e634aac). The user sees a card.'

  test('a proposal keeps the task id it was answered with', async () => {
    const run = runFor(START, { initiation: 'own_initiative', title: 'CCC chat: read history' }, 't1', 5)
    expect(run?.status).toBe('proposed')
    expect(settleRun(run as AgentRun, false, {}, 9, ANSWER).taskId).toBe('task_4e634aac')
    expect(settleRun(run as AgentRun, false, {}, 9, { content: [{ type: 'text', text: ANSWER }] }).taskId).toBe('task_4e634aac')
    expect(settleRun(run as AgentRun, false, {}, 9, 'no id here').taskId).toBeUndefined()
    expect(proposalOf(undefined)).toBeUndefined()
  })

  test('starting it marks that card started and adds no card of its own', async () => {
    expect(runFor(START, { proposal_id: 'task_4e634aac' }, 't2', 9)).toBeUndefined()
    const proposed: AgentRun = { id: 't1', kind: 'session', label: 'CCC chat', status: 'proposed', startedAt: 5, taskId: 'task_4e634aac' }
    const other: AgentRun = { ...proposed, id: 't3', taskId: 'task_other' }
    expect(startProposal([proposed, other], 'task_4e634aac').map(r => r.status)).toEqual(['started', 'proposed'])
  })

  test('from call to start on the map', { plugins: [{ name: 'peek', register: peekRegister }] }, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('tool.call', (_, e) => ({ result: (e as { proposal_id?: string }).proposal_id ? 'Started session' : ANSWER }))
    await $.tool.call({ tool: START, tool_use_id: 'ts1', initiation: 'own_initiative', title: 'CCC chat: read history', prompt: 'x' } as never)
    await $.tool.call({ tool: START, tool_use_id: 'ts2', proposal_id: 'task_4e634aac' } as never)
    expect((await peek($)).runs.map(r => [r.label, r.status])).toEqual([['CCC chat: read history', 'started']])
  })
})

describe('stops from CCC', () => {
  const report = (task: string, status = 'killed') => `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>${status}</status>\n</task-notification>`

  test('a stop ends the turn that ran when it was asked, never a later one', async () => {
    const turn = { isRunning: true, turnId: 'turn-2', startedAt: 1000 }
    expect(stopTarget(turn, 1500)).toBe('turn-2')
    expect(stopTarget(turn, 900)).toBeUndefined()
    expect(stopTarget({ ...turn, isRunning: false }, 1500)).toBeUndefined()
    expect(stopTarget({ isRunning: true, startedAt: 1000 }, 1500)).toBeUndefined()
  })

  test('a command the stop moved to the background is ours to end, for a while after the stop', async () => {
    const moved = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bw9', backgroundedByTurnAbort: true }
    expect(stoppedByUs(moved, 1000, 2000)).toBe('bw9')
    expect(stoppedByUs(moved, undefined, 2000)).toBeUndefined()
    expect(stoppedByUs(moved, 1000, 1000 + 31_000)).toBeUndefined()
    expect(stoppedByUs({ ...moved, backgroundedByTurnAbort: undefined }, 1000, 2000)).toBeUndefined()
    expect(stoppedByUs('text', 1000, 2000)).toBeUndefined()
  })

  test('the report of a task we ended starts no turn; any other report does', async () => {
    const stopped = rememberStopped(rememberStopped(undefined, 'bw9'), 'bx1')
    expect(stopped).toEqual(['bw9', 'bx1'])
    expect(rememberStopped(Array.from({ length: 25 }, (_, i) => `t${i}`), 'new')).toHaveLength(20)
    expect(isOnlyStoppedReport(report('bw9'), stopped)).toBe(true)
    expect(isOnlyStoppedReport(`${report('bw9')}\n${report('other')}`, stopped)).toBe(false)
    expect(isOnlyStoppedReport(`${report('bw9')}\nwhat happened?`, stopped)).toBe(false)
    expect(isOnlyStoppedReport('plain prompt', stopped)).toBe(false)
  })
})

describe('Stop on the agent map', () => {
  test("a background command keeps its task, so Stop can end it; an agent is ended by its id", () => {
    const command = backgroundRunFor('Bash', { command: 'npm test', description: 'Run the tests', run_in_background: true }, { backgroundTaskId: 'bash_7' }, 'toolu_1', 5)
    expect(command?.taskId).toBe('bash_7')
    expect(stopTaskOf(command as AgentRun)).toBe('bash_7')
    expect(stopTaskOf({ id: 'a', kind: 'agent', label: 'x', status: 'running', startedAt: 1, agentId: 'ag1' })).toBe('ag1')
    // a command from before CCC kept its task, and a workflow, have nothing for TaskStop to end
    expect(stopTaskOf({ id: 'c', kind: 'command', label: 'x', status: 'running', startedAt: 1 })).toBeUndefined()
    expect(stopTaskOf({ id: 'w', kind: 'workflow', label: 'x', status: 'started', startedAt: 1 })).toBeUndefined()
  })

  test('a stopped run, and what still worked under it, show as stopped, and the engine word for it does not undo that', () => {
    const list: AgentRun[] = [
      { id: 'r1', kind: 'agent', label: 'a', status: 'running', startedAt: 1, agentId: 'ag1' },
      { id: 'r2', kind: 'agent', label: 'b', status: 'running', startedAt: 1, parentId: 'r1' },
      { id: 'r3', kind: 'agent', label: 'c', status: 'done', startedAt: 1, endedAt: 2, parentId: 'r1' },
      { id: 'r4', kind: 'command', label: 'd', status: 'running', startedAt: 1 },
    ]
    const stopped = stopRunIn(list, 'r1', 9)
    expect(stopped.map(one => one.status)).toEqual(['stopped', 'stopped', 'done', 'running'])
    expect(stopped[0]?.endedAt).toBe(9)
    expect(trackAgent(stopped[0] as AgentRun, 'killed', 10).status).toBe('stopped')
  })
})
