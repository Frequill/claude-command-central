import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'ccc',
  component: 'Pane',
  requestId: 'ccc',
  props: {
    title: 'CCC',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)

test('a shell command shows in the log once it has run', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Code' }))?.text).toMatch(/✓ \$ git status/)
    await ui.unmount()
  }
})

test('a failed call is marked in the log', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ deny: 'no' }))
  await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Code' }))?.text).toMatch(/✗ \$ rm -rf x/)
})

test('the task list drives the progress bar', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Read', status: 'completed' },
      { content: 'Skriv', status: 'in_progress' },
      { content: 'Testa', status: 'pending' },
    ],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /1 of 3 done/ })).toBeDefined()
    expect(await ui.find({ text: 'Now: Skriv' })).toBeDefined()
    await ui.unmount()
  }

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /2 of 3 done/ })).toBeDefined()
  expect(await ui.find({ text: 'Now: Testa' })).toBeDefined()
})

test('a new message starts with no task list, as in the app; a notice of background work keeps it', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.turn.start({ turnId: 't1', text: 'Fixa buggen' })
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Hitta', status: 'completed' },
      { content: 'Laga', status: 'in_progress' },
    ],
  })
  await $.turn.start({ turnId: 't2', text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /1 of 2 done/ })).toBeDefined()
  await ui.unmount()

  await $.turn.start({ turnId: 't3', text: 'Can you ask a question?' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /of 2 done/ })).toBeUndefined()
})

test('wrapping up completes the progress bar', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'pending' },
    ],
  })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Done.' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /2 of 2 done/ })).toBeDefined()
})

test('a started agent shows on the map: a drawing on desktop, a line in the terminal', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: { status: 'async_launched' } }))
  await $.tool.call({ tool: 'Agent', description: 'Granska koden', prompt: 'x' })

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const map = await desktop.find({ type: 'Svg' })
  expect(map?.props.alt).toBe('Granska koden: working')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ text: /● Granska koden · working/ })).toBeDefined()
})

test('an empty session draws placeholders instead of failing', async ($, on) => {
  mock.clock(on, { now: NOW })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: 'No task list yet.' })).toBeDefined()
    expect(await ui.find({ text: 'No agents yet.' })).toBeDefined()
    expect(await ui.find({ text: 'Nothing has happened yet.' })).toBeDefined()
    await ui.unmount()
  }
})

test('a very narrow pane still draws', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 4 } }

  const ui = await $.ui.mount({ ...narrow, surface: 'terminal' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
})

test('the effort a step asks for shows beside the model', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('turn.step', async function* (_, e) {
    yield* []
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, effort: 'high' })
  for await (const chunk of stream) void chunk

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /effort high/ })).toBeDefined()
})

test('the agents a workflow starts show in the map, each on its own', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: 'started' }))
  on('agent.spawn', (_, e) => ({ model: 'claude-opus-5-5', agentId: e.description === 'Kolla zsh' ? 'a1' : 'a2' }))
  on('agent.list', () => [])
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'w1', script: "export const meta = { name: 'probe' }" } as never)
  const spawn = { tool_use_id: 'w1', prompt: 'p', subagentType: 'general-purpose', provider: 'anthropic', parentModel: 'm', background: true, fork: false }
  await $.agent.spawn({ ...spawn, description: 'Kolla zsh', workflow: { runId: 'r1', agentIndex: 0 } } as never)
  await $.agent.spawn({ ...spawn, description: 'Granska anropen', workflow: { runId: 'r1', agentIndex: 1 } } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Kolla zsh/ })).toBeDefined()
  expect(await ui.find({ text: /Granska anropen/ })).toBeDefined()
  expect(await ui.find({ text: /probe/ })).toBeDefined()
})
