import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as L from './board-logic.js'
import { nearestCrater } from './arrivals.js'
import { blocks, inline } from './markdown.js'
import * as C from './chat-logic.js'
import { chooseCrater, planFlight } from './dragon.js'
import * as P from './placement.js'
import { cellsOf, lowestSpot } from './grid.js'

const NOW = 1_000_000_000

function session(id, fields = {}) {
  return { sessionId: id, folder: 'shop', updatedAt: NOW, turn: { isRunning: false, startedAt: 1 }, ...fields }
}

test('a session is working, done, quiet or ended', () => {
  assert.equal(L.sessionState(session('a', { turn: { isRunning: true } }), NOW), 'working')
  assert.equal(L.sessionState(session('a'), NOW), 'done')
  assert.equal(L.sessionState(session('a', { updatedAt: NOW - L.STALE_MS - 1 }), NOW), 'stale')
  assert.equal(L.sessionState(session('a', { endedAt: NOW }), NOW), 'ended')
})

test('sessions keep the order they started in, and nothing disappears for its age', () => {
  const day = 24 * 3_600_000
  const list = [
    session('second', { startedAt: 20, turn: { isRunning: true, startedAt: 20 } }),
    session('first', { startedAt: 10 }),
    session('ended-days-ago', { startedAt: 30, endedAt: NOW - 3 * day }),
    session('quiet-for-days', { startedAt: 40, updatedAt: NOW - 2 * day }),
  ]
  assert.deepEqual(L.visibleSessions(list, NOW).map(s => s.sessionId), ['first', 'second', 'ended-days-ago', 'quiet-for-days'])
})

test('a card says where its session runs: the Claude app, VS Code or a terminal', () => {
  assert.deepEqual(L.sourceOf({ entrypoint: 'claude-vscode' }), { kind: 'vscode', label: 'VS Code', about: 'Started in VS Code' })
  assert.equal(L.sourceOf({ entrypoint: 'cli' }).label, 'Terminal')
  assert.equal(L.sourceOf({ entrypoint: 'claude-desktop' }).label, 'Claude app')
  assert.equal(L.sourceOf({ entrypoint: 'something-new' }), null)
  assert.equal(L.sourceOf({}), null)
  assert.equal(L.sourceOf(undefined), null)
})

test('the Open button goes to the chat in the Claude app, or in VS Code', () => {
  const id = '0fdd9824-442d-42dc-9756-d9f049e58923'
  assert.deepEqual(L.openLink({ sessionId: id, appSessionId: 'local_ddd5074f-dd4d', entrypoint: 'claude-desktop' }), {
    href: 'claude://code/continue?session=local_ddd5074f-dd4d',
    about: 'Open this chat in the Claude app',
  })
  assert.equal(L.openLink({ sessionId: id, entrypoint: 'claude-vscode' }).href, `vscode://anthropic.claude-code/open?session=${id}`)
  assert.equal(L.openLink({ sessionId: id, entrypoint: 'cli' }), null)
  assert.equal(L.openLink({ sessionId: id, entrypoint: 'claude-desktop' }), null)
  assert.equal(L.openLink({ sessionId: 'not-a-uuid', entrypoint: 'claude-vscode' }), null)
  assert.equal(L.openLink({ sessionId: id, appSessionId: 'local_x&evil=1' }), null)
  assert.equal(L.openLink(undefined), null)
})

test('a session arrives when it comes onto the board, not when the page loads', () => {
  assert.deepEqual(L.arrivals(null, ['a', 'b']), [])
  assert.deepEqual(L.arrivals(new Set(['a']), ['a', 'b']), ['b'])
  assert.deepEqual(L.arrivals(new Set(['a', 'b']), ['a']), [])
  assert.deepEqual(L.arrivals(new Set(), ['a']), ['a'])
})

test('a chat only opened in the app, never written in, stays off the board', () => {
  const list = [session('written', { startedAt: 1 }), session('opened', { startedAt: 2, turn: { isRunning: false } }), session('bad', { startedAt: 3, turn: undefined })]
  assert.deepEqual(L.visibleSessions(list, NOW).map(s => s.sessionId), ['written'])
})

test('a session the person just removed is left out until the server stops sending it', () => {
  const list = [session('keep', { startedAt: 1 }), session('gone', { startedAt: 2 })]
  assert.deepEqual(L.visibleSessions(list, NOW, new Map(), new Set(['gone'])).map(s => s.sessionId), ['keep'])
})

test('a session without a start time is placed by when the board first saw it', () => {
  const list = [session('old'), session('new', { startedAt: 50 })]
  const firstSeen = new Map([['old', 100]])
  assert.deepEqual(L.visibleSessions(list, NOW, firstSeen).map(s => s.sessionId), ['new', 'old'])
})

test('spend today counts only snapshots that speak of today, closed sessions too', () => {
  const list = [
    session('a', { today: { day: '2026-10-19', usd: 1.5 } }),
    session('b', { endedAt: NOW, today: { day: '2026-10-19', usd: 2 } }),
    session('c', { today: { day: '2026-10-18', usd: 9 } }),
    session('d', { today: { day: '2026-10-19', usd: Number.NaN } }),
    session('e'),
  ]
  assert.equal(L.totalOn(list, '2026-10-19'), 3.5)
  assert.equal(L.dayOf(new Date(2026, 9, 19, 23, 59).getTime()), '2026-10-19')
})

test('model ids read as people say them', () => {
  assert.equal(L.modelName('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(L.modelName('claude-sonnet-5-5[1m]'), 'Sonnet 5.5 · 1M')
  assert.equal(L.modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(L.modelName('claude-fable-5'), 'Fable 5')
  assert.equal(L.modelName('gpt-something-odd'), 'gpt-something-odd')
  assert.equal(L.modelName(undefined), '')
})

test('the summary counts live sessions and agents', () => {
  const list = [
    session('a', {
      turn: { isRunning: true },
      runs: [{ status: 'running' }, { status: 'done' }],
      stats: { costUsd: 1.5, limits: [{ kind: 'five_hour', percentUsed: 40 }] },
    }),
    session('b', { stats: { costUsd: Number.NaN, limits: [] } }),
    session('c', { endedAt: NOW, runs: [{ status: 'running' }], stats: { costUsd: 2 } }),
  ]
  const summary = L.summarize(list, NOW)
  assert.equal(summary.live, 2)
  assert.equal(summary.working, 1)
  assert.equal(summary.done, 1)
  assert.equal(summary.needsYou, 0)
  assert.equal(summary.agentsRunning, 1)
})

const AT = Date.parse('2026-10-19T12:55:00.000Z')
const limits = (...list) => ({ stats: { limits: list } })

test('limits: a window that has already reset is dropped, the highest reading of the current one wins', () => {
  const sessions = [
    session('a', limits({ kind: 'five_hour', percentUsed: 29, resetsAt: '2026-10-19T12:40:00.000Z' }, { kind: 'seven_day', percentUsed: 20, resetsAt: '2026-10-19T21:00:00.000Z' })),
    session('b', limits({ kind: 'five_hour', percentUsed: 2, resetsAt: '2026-10-19T17:40:00.000Z' }, { kind: 'seven_day', percentUsed: 21, resetsAt: '2026-10-19T21:00:00.000Z' })),
    session('c', limits({ kind: 'five_hour', percentUsed: 24, resetsAt: '2026-10-19T12:40:00.000Z' }, { kind: 'seven_day', percentUsed: 19, resetsAt: '2026-10-19T21:00:00.000Z' })),
    session('d', limits({ kind: 'five_hour', percentUsed: 1, resetsAt: '2026-10-19T17:40:00.000Z' })),
  ]
  assert.deepEqual(L.currentLimits(sessions, AT), [
    { kind: 'five_hour', percentUsed: 2, resetsAt: '2026-10-19T17:40:00.000Z' },
    { kind: 'seven_day', percentUsed: 21, resetsAt: '2026-10-19T21:00:00.000Z' },
  ])
})

test('limits: readings whose window end differs by seconds are one window; broken ones are skipped', () => {
  const sessions = [
    session('a', limits({ kind: 'five_hour', percentUsed: 5, resetsAt: '2026-10-19T17:40:00.000Z' })),
    session('b', limits({ kind: 'five_hour', percentUsed: 7, resetsAt: '2026-10-19T17:40:30.000Z' })),
    session('c', limits({ kind: 'five_hour', percentUsed: Number.NaN }, null, { percentUsed: 3 })),
  ]
  assert.equal(L.currentLimits(sessions, AT)[0].percentUsed, 7)
  assert.deepEqual(L.currentLimits([session('x')], AT), [])
})

test('limits: the board never shows less than before in the same window, and starts over after a reset', () => {
  const window = '2026-10-19T21:00:00.000Z'
  let state = L.holdPeaks([{ kind: 'seven_day', percentUsed: 21, resetsAt: window }], new Map(), AT)
  state = L.holdPeaks([{ kind: 'seven_day', percentUsed: 19, resetsAt: window }], state.peaks, AT)
  assert.equal(state.limits[0].percentUsed, 21)
  state = L.holdPeaks([{ kind: 'seven_day', percentUsed: 23, resetsAt: window }], state.peaks, AT)
  assert.equal(state.limits[0].percentUsed, 23)
  const next = L.holdPeaks([{ kind: 'seven_day', percentUsed: 1, resetsAt: '2026-10-26T21:00:00.000Z' }], state.peaks, Date.parse(window) + 1000)
  assert.equal(next.limits[0].percentUsed, 1)
})

test('repeated folders get an id suffix in tags', () => {
  const tags = L.sessionTags([session('abcd1'), session('efgh2'), session('x', { folder: 'blog' })])
  assert.equal(tags.get('abcd1'), 'shop ·abcd')
  assert.equal(tags.get('x'), 'blog')
})

test("a session's log reads newest first, capped", () => {
  const s = session('a', {
    log: [
      { id: '1', at: 10, text: 'old', status: 'ok' },
      { id: '2', at: 30, text: 'newest', status: 'ok' },
      { id: '3', at: 20, text: 'middle', status: 'error' },
    ],
  })
  assert.deepEqual(L.recentLog(s, 2).map(e => e.text), ['newest', 'middle'])
  assert.deepEqual(L.recentLog(session('b')), [])
})

test('a workflow is drawn with its agents right under it', () => {
  const flow = { id: 'w1', kind: 'workflow', label: 'probe', status: 'started' }
  const lone = { id: 't2', kind: 'agent', label: 'Review', status: 'done' }
  const a1 = { id: 'a1', kind: 'agent', label: 'zsh', status: 'running', parentId: 'w1' }
  const a2 = { id: 'a2', kind: 'agent', label: 'anrop', status: 'done', parentId: 'w1' }
  const rows = L.mapRows([flow, a1, lone, a2])
  assert.deepEqual(rows.map(r => [r.run.id, r.depth, r.status]), [['w1', 0, 'running'], ['a1', 1, 'running'], ['a2', 1, 'done'], ['t2', 0, 'done']])
  assert.deepEqual([rows[0].agents, rows[0].working], [2, 1])
  assert.equal(L.mapRows([flow, { ...a1, status: 'done' }, a2])[0].status, 'done')
  assert.equal(L.mapRows([flow])[0].status, 'started')
  assert.equal(L.mapRows([{ ...flow, status: 'failed' }, a1])[0].status, 'failed')
  assert.deepEqual(L.mapRows([{ ...a1, parentId: 'gone' }]).map(r => [r.run.id, r.depth]), [['a1', 0]])
  assert.deepEqual(L.mapRows(undefined), [])
})

test('clearing finished runs keeps what still works and whatever starts later', () => {
  const flow = { id: 'w1', kind: 'workflow', status: 'started', startedAt: 1 }
  const a1 = { id: 'a1', kind: 'agent', status: 'done', startedAt: 2, endedAt: 8, parentId: 'w1' }
  const a2 = { id: 'a2', kind: 'agent', status: 'done', startedAt: 3, endedAt: 9, parentId: 'w1' }
  const working = { id: 't1', kind: 'agent', status: 'running', startedAt: 4 }
  const failed = { id: 't2', kind: 'agent', status: 'failed', startedAt: 5, endedAt: 6 }
  const card = { id: 's1', kind: 'session', status: 'proposed', startedAt: 7 }
  const later = { id: 't3', kind: 'agent', status: 'done', startedAt: 20, endedAt: 30 }
  const all = [flow, a1, a2, working, failed, card, later]
  assert.deepEqual(L.shownRuns(all, 10).map(r => r.id), ['t1', 't3'])
  assert.deepEqual(L.shownRuns(all, 0), all)
  assert.deepEqual(L.shownRuns(all, undefined), all)
  assert.deepEqual(L.shownRuns(undefined, 10), [])
  const stillWorking = [flow, a1, { ...a2, status: 'running', endedAt: undefined }]
  assert.deepEqual(L.shownRuns(stillWorking, 10).map(r => r.id), ['w1', 'a2'])
  assert.deepEqual(L.shownRuns([flow, a1, a2], 8.5).map(r => r.id), ['w1', 'a2'])
})

test('clearing also takes a run left standing as started that nothing reports on', () => {
  const stuck = { id: 'w9', kind: 'workflow', status: 'started', startedAt: 1 }
  const fresh = { id: 'w8', kind: 'workflow', status: 'started', startedAt: 50 }
  assert.deepEqual(L.shownRuns([stuck, fresh], 10).map(r => r.id), ['w8'])
  const agent = { id: 'a9', kind: 'agent', status: 'running', startedAt: 60, parentId: 'w9' }
  assert.deepEqual(L.shownRuns([stuck, agent], 10).map(r => r.id), ['w9', 'a9'])
})

test('the layout keeps which cards are open as a chat, and how big', () => {
  const layout = L.normalizeLayout({
    open: ['a', 'a', 'b', 7],
    chats: { a: { span: 3, height: 900 }, b: { span: 40, height: 10 }, c: 'x', d: { showSide: true }, e: { showSide: 'yes' }, f: { cols: 5 }, g: { w: 700 } },
  })
  assert.deepEqual(layout.open, ['a', 'b'])
  // widths kept in grid columns become pixels
  assert.deepEqual(layout.chats, { a: { w: 3 * 2 * 146 - 12, height: 900 }, d: { showSide: true }, f: { w: 5 * 146 - 12 }, g: { w: 700 } })
  assert.deepEqual(L.normalizeLayout(null).open, [])
  // the panel of facts opens inside the window: open or folded in, the window keeps its size
  assert.deepEqual(L.chatBox(undefined), { w: L.CHAT_WIDTH, h: L.CHAT_HEIGHT })
  assert.deepEqual(L.chatBox({ hideSide: true }), L.chatBox({}))
  assert.deepEqual(L.chatBox({ w: 100, height: 100 }), { w: L.CHAT_MIN_WIDTH, h: L.CHAT_MIN_HEIGHT })
  assert.deepEqual(L.chatBox({ w: 900, height: 1000 }), { w: 900, h: 1000 })
})

test('a grip in any corner or on any edge grows the card as it is pulled away from it', () => {
  assert.deepEqual(L.gripGrowth(undefined, 30, 20), { width: 30, height: 20 })
  assert.deepEqual(L.gripGrowth('corner-bl', -30, 20), { width: 30, height: 20 })
  assert.deepEqual(L.gripGrowth('corner-tr', 30, -20), { width: 30, height: 20 })
  assert.deepEqual(L.gripGrowth('corner-tl', -30, -20), { width: 30, height: 20 })
  assert.deepEqual(L.gripGrowth('corner-tl', 30, 20), { width: -30, height: -20 })
  assert.deepEqual(L.gripGrowth('x', 30, 20), { width: 30, height: 0 })
  assert.deepEqual(L.gripGrowth('left', -30, 20), { width: 30, height: 0 })
  assert.deepEqual(L.gripGrowth('y', 30, 20), { width: 0, height: 20 })
})

test('a grip moves the sides it sits on', () => {
  assert.deepEqual(L.gripSides(undefined), { left: false, right: true, top: false, bottom: true })
  assert.deepEqual(L.gripSides('corner-tl'), { left: true, right: false, top: true, bottom: false })
  assert.deepEqual(L.gripSides('corner-tr'), { left: false, right: true, top: true, bottom: false })
  assert.deepEqual(L.gripSides('corner-bl'), { left: true, right: false, top: false, bottom: true })
  assert.deepEqual(L.gripSides('x'), { left: false, right: true, top: false, bottom: false })
  assert.deepEqual(L.gripSides('y'), { left: false, right: false, top: false, bottom: true })
})

test('the layout keeps when finished runs were cleared', () => {
  assert.equal(L.normalizeLayout({ runsClearedAt: 1234 }).runsClearedAt, 1234)
  assert.equal('runsClearedAt' in L.normalizeLayout({ runsClearedAt: 'soon' }), false)
  assert.equal('runsClearedAt' in L.normalizeLayout({ runsClearedAt: -5 }), false)
  assert.equal('runsClearedAt' in L.normalizeLayout(null), false)
})

test('the agents of a workflow count as running agents', () => {
  const runs = [{ id: 'w1', kind: 'workflow', status: 'started' }, { id: 'a1', status: 'running', parentId: 'w1' }, { id: 'a2', status: 'running', parentId: 'w1' }]
  assert.equal(L.runningRuns({ runs }).length, 2)
})

test('the reply box knows what Claude is doing with its answer', () => {
  const running = { turn: { isRunning: true } }
  assert.deepEqual(L.liveReply({ turn: { isRunning: true } }), { state: 'thinking', text: '' })
  assert.deepEqual(L.liveReply({ turn: { isRunning: false } }), { state: 'empty', text: '' })
  assert.deepEqual(L.liveReply(undefined), { state: 'empty', text: '' })
  assert.deepEqual(L.liveReply({ ...running, reply: null }), { state: 'thinking', text: '' })
  assert.deepEqual(L.liveReply({ turn: { isRunning: false }, reply: null }), { state: 'empty', text: '' })
  assert.deepEqual(L.liveReply({ ...running, reply: { text: 'Hi', isWriting: true } }), { state: 'writing', text: 'Hi' })
  assert.deepEqual(L.liveReply({ ...running, reply: { text: 'Hi', isWriting: false } }), { state: 'written', text: 'Hi' })
  assert.deepEqual(L.liveReply({ turn: { isRunning: false }, reply: { text: 'Hi', isWriting: true } }), { state: 'written', text: 'Hi' })
  assert.deepEqual(L.liveReply({ ...running, reply: { text: '  \n ', isWriting: true } }), { state: 'thinking', text: '' })
})

test('a session on an older mod shows its chat\'s latest answer instead', () => {
  const chat = [{ prompt: 'status', answer: 'Step 1 of 3 is **done**.' }]
  assert.deepEqual(L.liveReply({ turn: { isRunning: false }, chat }), { state: 'written', text: 'Step 1 of 3 is done.' })
  assert.deepEqual(L.liveReply({ turn: { isRunning: true }, chat: [...chat, { prompt: 'ok' }] }), { state: 'thinking', text: '' })
  assert.deepEqual(L.liveReply({ turn: { isRunning: false }, chat: [{ prompt: 'ok', endedAt: 2 }] }), { state: 'empty', text: '' })
})

test('while a turn runs, the answer before it stays in view above the new one', () => {
  const chat = [{ prompt: 'a', answer: 'First answer' }, { prompt: 'b', answer: 'Second **answer**', endedAt: 5 }]
  assert.equal(L.earlierAnswer({ turn: { isRunning: true }, chat: [...chat, { prompt: 'c' }] }), 'Second answer')
  assert.equal(L.earlierAnswer({ turn: { isRunning: true }, chat }), 'Second answer')
  assert.equal(L.earlierAnswer({ turn: { isRunning: true }, chat: [...chat, { prompt: 'c', endedAt: 6 }, { prompt: 'd' }] }), 'Second answer')
  assert.equal(L.earlierAnswer({ turn: { isRunning: false }, chat }), '')
  assert.equal(L.earlierAnswer({ turn: { isRunning: true }, chat: [{ prompt: 'c' }] }), '')
  assert.equal(L.earlierAnswer({ turn: { isRunning: true } }), '')
  assert.equal(L.earlierAnswer(undefined), '')
})

test('the reply reads as plain lines, and only its end is kept', () => {
  assert.equal(L.plainReply('## Done\n\n\nIt **works** now in `board.js`.'), 'Done\nIt works now in board.js.')
  assert.equal(L.plainReply('Run:\n```bash\nccc\n```\nthen done'), 'Run:\nccc\nthen done')
  assert.equal(L.plainReply(undefined), '')
  assert.equal(L.plainReply(null), '')
  const long = L.plainReply('ord '.repeat(1000) + 'SLUT')
  assert.ok(long.length <= 3000)
  assert.ok(long.endsWith('SLUT'))
  assert.ok(long.startsWith('ord'))
})

test('a scroll box follows its newest line until the person scrolls up in it', () => {
  assert.equal(L.isAtBottom({ scrollHeight: 500, scrollTop: 362, clientHeight: 138 }), true)
  assert.equal(L.isAtBottom({ scrollHeight: 500, scrollTop: 358, clientHeight: 138 }), true)
  assert.equal(L.isAtBottom({ scrollHeight: 500, scrollTop: 200, clientHeight: 138 }), false)
  assert.equal(L.scrollAfterRedraw(undefined, 640), 640)
  assert.equal(L.scrollAfterRedraw({ isAtBottom: true, top: 362 }, 640), 640)
  assert.equal(L.scrollAfterRedraw({ isAtBottom: false, top: 120 }, 640), 120)
})

test('the live terminal keeps its number of lines, newest at the bottom', () => {
  const s = { log: [{ at: 3, text: 'c' }, { at: 1, text: 'a' }, { at: 4, text: 'd' }, { at: 2, text: 'b' }] }
  assert.deepEqual(L.terminalLines(s, 3).map(e => e.text), ['b', 'c', 'd'])
  assert.deepEqual(L.terminalLines({ log: [{ at: 1, text: 'only' }] }, 3).map(e => e?.text ?? null), [null, null, 'only'])
  assert.deepEqual(L.terminalLines({}, 3), [null, null, null])
  assert.deepEqual(L.terminalLines(s, 0), [])
  assert.deepEqual(L.terminalLines(s, -2), [])
  assert.deepEqual(L.terminalLines(s, undefined), [])
  assert.equal(L.terminalLines(s, 8).length, 8)
})

test('plan progress counts done steps and names the current one', () => {
  const plan = [
    { text: 'A', status: 'completed' },
    { text: 'B', status: 'in_progress' },
    { text: 'C', status: 'pending' },
  ]
  assert.deepEqual(L.planProgress(plan), { done: 1, total: 3, current: 'B' })
  assert.deepEqual(L.planProgress(undefined), { done: 0, total: 0, current: undefined })
})

test('main and master are protected branches', () => {
  assert.equal(L.isProtectedBranch('main'), true)
  assert.equal(L.isProtectedBranch('master'), true)
  assert.equal(L.isProtectedBranch('ABC-1-main-fix'), false)
})

test('numbers format for reading', () => {
  assert.equal(L.usd(1.234), '$1.23')
  assert.equal(L.usd(undefined), '$0.00')
  assert.equal(L.tokens(122_200), '122.2k')
  assert.equal(L.duration(134_000), '2m14s')
  assert.equal(L.duration(3_720_000), '1h02m')
  assert.equal(L.limitName('five_hour'), '5H')
  assert.equal(L.clamp01(4), 1)
})

test('sessions keep their colour slot while visible; a freed slot is reused', () => {
  let slots = L.assignSlots(new Map(), ['a', 'b', 'c', 'd'])
  assert.deepEqual([...slots], [['a', 0], ['b', 1], ['c', 2], ['d', 3]])
  slots = L.assignSlots(slots, ['c', 'd', 'e'])
  assert.deepEqual([...slots], [['c', 2], ['d', 3], ['e', 0]])
  // every colour is used before a session goes grey
  const many = Array.from({ length: L.IDENTITY.length + 1 }, (_, i) => `s${i}`)
  slots = L.assignSlots(new Map(), many)
  assert.equal(new Set(many.slice(0, -1).map(id => L.identityColor(slots, id))).size, L.IDENTITY.length)
  assert.equal(L.identityColor(slots, many.at(-1)), L.OTHER_COLOR)
})

test('ring dash fills the share of the circle and clamps', () => {
  const length = 2 * Math.PI * 10
  assert.equal(L.ringDash(50, 10), `${(length / 2).toFixed(1)} ${(length / 2).toFixed(1)}`)
  assert.equal(L.ringDash(150, 10), `${length.toFixed(1)} 0.0`)
  assert.equal(L.ringDash(Number.NaN, 10), `0.0 ${length.toFixed(1)}`)
})

test('donut segments follow each other and skip empty values', () => {
  const segments = L.donutSegments([{ value: 3 }, { value: 0 }, { value: 1 }], 10, 0)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].share, 0.75)
  assert.equal(segments[1].offset, (-(0.75 * 2 * Math.PI * 10)).toFixed(1))
  assert.deepEqual(L.donutSegments([{ value: 0 }], 10), [])
})

test('the prompts today read per session on the board, then the other sessions', () => {
  const tags = new Map([['a', 'shop'], ['b', 'CCC']])
  assert.equal(L.promptSummary({ total: 9, bySession: { b: 3, a: 5, gone: 1, none: 0 } }, tags), '9 prompts you wrote today: shop 5, CCC 3, other sessions 1')
  assert.equal(L.promptSummary({ total: 1, bySession: { a: 1 } }, tags), '1 prompt you wrote today: shop 1')
  assert.equal(L.promptSummary(undefined, tags), '0 prompts you wrote today')
})

test('the tool mix adds up every session, most used first', () => {
  const mix = L.toolMix([
    session('a', { tools: { Bash: 3, Read: 1 } }),
    session('b', { tools: { Read: 4, Edit: Number.NaN } }),
    session('c'),
  ])
  assert.deepEqual(mix, [{ name: 'Read', count: 5 }, { name: 'Bash', count: 3 }])
})

test('token counts read short, up to billions', () => {
  assert.equal(L.tokens(640_000), '640k')
  assert.equal(L.tokens(309_619_953), '309.6M')
  assert.equal(L.tokens(1_250_000_000), '1.25B')
  assert.equal(L.tokens(1_038_000_000), '1.04B')
  assert.equal(L.tokens(2_000_000_000), '2B')
  assert.equal(L.tokens(12), '12')
})

test('the token graph runs today up to now, scaled to the day so far', () => {
  const at = new Date(2026, 9, 20, 2, 30).getTime()
  const paths = L.tokenPaths([10, 10, 20, ...Array(21).fill(0)], at, 240, 48)
  assert.equal(paths.line, 'M0.0 46.0 L10.0 35.0 L20.0 24.0 L25.0 2.0')
  assert.ok(paths.area.startsWith(paths.line) && paths.area.endsWith('L25.0 48 L0 48 Z'))
})

test('a token graph with nothing used stays flat', () => {
  const paths = L.tokenPaths(undefined, new Date(2026, 9, 20, 0, 0).getTime(), 240, 48)
  assert.equal(paths.line, 'M0.0 46.0 L0.0 46.0')
  assert.equal(L.runningTotals(['x', -5, 3]).slice(0, 3).join(), '0,0,3')
})

test('an hour of the token graph tells that hour and the total by then; later hours are empty', () => {
  const at = new Date(2026, 9, 20, 2, 30).getTime()
  const hours = [10, 10, 20, ...Array(21).fill(0)]
  assert.deepEqual(L.tokenHour(hours, 2, at), { hour: 2, label: '02:00–03:00', used: 20, soFar: 40 })
  assert.deepEqual(L.tokenHour(hours, 5, at), { hour: 5, label: '05:00–06:00' })
  assert.equal(L.tokenHour(hours, 23.9, at).label, '23:00–00:00')
  assert.equal(L.tokenHour(hours, -3, at).hour, 0)
})

test('a session is named after its first prompt, else its folder; repeats get an id', () => {
  const long = session('a1b2', { turn: { topic: 'When you start a new session it should land at the bottom' } })
  assert.equal(L.sessionLabel(long), 'When you start a new session it…')
  assert.equal(L.sessionLabel(session('x')), 'shop')
  const tags = L.sessionTags([session('aaaa1'), session('bbbb2'), session('c', { turn: { topic: 'Fix it' } })])
  assert.equal(tags.get('aaaa1'), 'shop ·aaaa')
  assert.equal(tags.get('c'), 'Fix it')
})

test('activity: running a tool, thinking since the last tool, waiting, ended', () => {
  const turn = { isRunning: true, startedAt: NOW - 100 }
  const running = session('a', { turn, log: [{ id: '1', at: NOW - 50, text: '$ ls', status: 'running' }] })
  assert.deepEqual(L.activityOf(running, NOW), { kind: 'tool', label: 'Running', since: NOW - 50, text: '$ ls' })
  const thinking = session('b', { turn, log: [{ id: '1', at: NOW - 90, endedAt: NOW - 40, text: '$ ls', status: 'ok' }] })
  assert.deepEqual(L.activityOf(thinking, NOW), { kind: 'thinking', label: 'Thinking', since: NOW - 40 })
  const fresh = session('c', { turn, log: [{ id: '1', at: NOW - 500, endedAt: NOW - 400, text: 'old', status: 'ok' }] })
  assert.equal(L.activityOf(fresh, NOW).since, NOW - 100)
  const done = session('d', { turn: { isRunning: false, endedAt: NOW - 30, ending: 'done' } })
  assert.deepEqual(L.activityOf(done, NOW), { kind: 'done', label: 'Done', since: NOW - 30 })
  assert.equal(L.activityOf(session('e', { endedAt: NOW - 5 }), NOW).kind, 'ended')
})

test('cards placed by hand keep their place; new ones follow in start order', () => {
  const list = ['a', 'b', 'c', 'd'].map(id => session(id))
  assert.deepEqual(L.arrangeSessions(list, ['c', 'gone', 'a']).map(s => s.sessionId), ['c', 'a', 'b', 'd'])
  assert.deepEqual(L.arrangeSessions(list, []).map(s => s.sessionId), ['a', 'b', 'c', 'd'])
})

test('a wider window always gives the board more room, and it stops shrinking at 72 %', () => {
  const room = width => width / L.scaleFor(width)
  assert.equal(L.scaleFor(600), 0.72)
  assert.equal(L.scaleFor(2400), 1)
  for (const [narrow, wide] of [[900, 1100], [1100, 1300], [1300, 1500], [1500, 1700], [1700, 2400]]) {
    assert.ok(room(wide) > room(narrow), `${wide} px should give more room than ${narrow} px`)
  }
})

test('a card is one card wide, two when large, or the width it was pulled to', () => {
  assert.equal(L.cardWidth(undefined, false), L.CARD_WIDTH)
  assert.equal(L.cardWidth(undefined, true), L.LARGE_CARD_WIDTH)
  assert.equal(L.cardWidth({ w: 444 }, false), 444)
  assert.equal(L.cardWidth({ w: 100 }, false), L.CARD_MIN_WIDTH)
  assert.equal(L.cardWidth({ collapsed: true }, true), L.CARD_WIDTH)
})

test('settings fall back to their defaults; wobble follows the mode', () => {
  assert.deepEqual(L.normalizeSettings(null), { theme: 'clean', animations: true, wobble: 'aero', cardSize: 'compact', freeze: false, statusBar: true, sidePanel: true, shiftScroll: false, scrollButtons: ['key:Shift'], showNotes: true, terminalApp: 'auto', editor: 'off' })
  assert.deepEqual(L.normalizeSettings({ theme: 'doom', animations: 'yes', wobble: 'x', cardSize: 'huge', freeze: 'no', statusBar: 1 }), { theme: 'clean', animations: true, wobble: 'aero', cardSize: 'compact', freeze: false, statusBar: true, sidePanel: true, shiftScroll: false, scrollButtons: ['key:Shift'], showNotes: true, terminalApp: 'auto', editor: 'off' })
  assert.equal(L.normalizeSettings({ statusBar: false }).statusBar, false)
  assert.equal(L.normalizeSettings({ freeze: true }).freeze, true)
  assert.equal(L.normalizeSettings({ cardSize: 'large' }).cardSize, 'large')
  assert.equal(L.wobbles({ theme: 'aero', animations: true, wobble: 'aero' }), true)
  assert.equal(L.wobbles({ theme: 'neon', animations: true, wobble: 'aero' }), false)
  assert.equal(L.wobbles({ theme: 'neon', animations: true, wobble: 'always' }), true)
  assert.equal(L.wobbles({ theme: 'aero', animations: false, wobble: 'always' }), false)
})

test('a stored layout keeps only sensible ids and sizes', () => {
  const layout = L.normalizeLayout({
    order: ['a', 'a', 7, '', 'b'],
    cards: { a: { span: 2, minHeight: 300, collapsed: true }, b: { span: 9, expanded: true }, c: 'x', d: { minHeight: 5, collapsed: 'yes' }, e: { x: 40, y: 1200, w: 350 }, f: { x: -5, y: 'top' } },
    sidebarWidth: 420,
    panels: { map: { basis: 800, minHeight: 9999 }, side: { basis: 10 } },
    panelOrder: ['spend', 'map'],
  })
  assert.deepEqual(layout.order, ['a', 'b'])
  assert.deepEqual(layout.cards, { a: { w: 2 * 2 * 146 - 12, minHeight: 300, collapsed: true }, e: { x: 40, y: 1200, w: 350 } })
  assert.deepEqual(L.normalizeLayout({ cards: { a: { cols: 3 } } }).cards, { a: { w: 3 * 146 - 12 } })
  assert.equal(layout.sidebarWidth, 420)
  assert.equal(L.normalizeLayout({ sidebarWidth: 50 }).sidebarWidth, undefined)
  assert.deepEqual(layout.panels, { map: { basis: 800 } })
  assert.deepEqual(layout.panelOrder, ['spend', 'map'])
  assert.deepEqual(L.normalizeLayout('junk'), { order: [], panelOrder: [], cards: {}, open: [], chats: {}, panels: {} })
})

test('needs you: a question box, a plan, an approval when the person decides, a closing question', () => {
  const asking = session('q', { turn: { isRunning: true, waiting: { kind: 'question', since: NOW - 9, text: 'Which branch?' } } })
  assert.equal(L.sessionState(asking, NOW), 'needs-you')
  assert.deepEqual(L.activityOf(asking, NOW), { kind: 'question', label: 'Question for you', since: NOW - 9, text: 'Which branch?' })
  const plan = session('p', { turn: { isRunning: true, waiting: { kind: 'plan', since: NOW - 4 } } })
  assert.equal(L.activityOf(plan, NOW).label, 'Plan to review')
  const closing = session('c', { turn: { isRunning: false, endedAt: NOW - 20, ending: 'question', question: 'Shall I build it?' } })
  assert.deepEqual(L.activityOf(closing, NOW), { kind: 'question', label: 'Question for you', since: NOW - 20, text: 'Shall I build it?' })
})

test('an approval needs the person where the person decides, or once its box is shown', () => {
  const turn = { isRunning: true, waiting: { kind: 'approval', since: NOW - 3, text: '$ rm -rf build' } }
  assert.equal(L.sessionState(session('d', { turn, permissionMode: 'default' }), NOW), 'needs-you')
  assert.equal(L.activityOf(session('d', { turn, permissionMode: 'default' }), NOW).label, 'Needs approval')
  assert.equal(L.sessionState(session('u', { turn }), NOW), 'needs-you')
  assert.equal(L.sessionState(session('a', { turn, permissionMode: 'auto' }), NOW), 'working')
  assert.equal(L.sessionState(session('b', { turn, permissionMode: 'bypassPermissions' }), NOW), 'working')
  const shown = { isRunning: true, waiting: { ...turn.waiting, isShown: true } }
  assert.equal(L.sessionState(session('s', { turn: shown, permissionMode: 'auto' }), NOW), 'needs-you')
  assert.equal(L.activityOf(session('s', { turn: shown, permissionMode: 'auto' }), NOW).label, 'Needs approval')
})

test('an answer picks the option it names, or each one listed when more than one may be picked', () => {
  const one = { multiSelect: false, options: [{ label: 'Output' }, { label: 'Allt' }] }
  const many = { multiSelect: true, options: [{ label: 'Output' }, { label: 'Input' }, { label: 'Cached' }] }
  assert.deepEqual([...C.chosenOptions(one, 'Allt')], ['Allt'])
  assert.deepEqual([...C.chosenOptions(one, 'it can stand apart')], [])
  assert.deepEqual([...C.chosenOptions(many, 'Output, Cached')], ['Output', 'Cached'])
  assert.deepEqual([...C.chosenOptions(many, 'Output, something else')], [])
  assert.deepEqual([...C.chosenOptions(one, '')], [])
  assert.deepEqual([...C.chosenOptions(undefined, 'x')], [])
})

test('a box answered here: one pick replaces the last, many go in and out, Other takes words', () => {
  const one = { multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }
  const many = { multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }
  const draft = C.emptyDraft([one, many])
  assert.deepEqual(draft.parts, [{ picks: [], other: '', isOther: false }, { picks: [], other: '', isOther: false }])
  assert.equal(C.isDraftReady([one, many], draft), false)
  let first = C.pickOption(one, draft.parts[0], 'Red')
  first = C.pickOption(one, first, 'Blue')
  assert.equal(C.answerText(one, first), 'Blue')
  first = C.chooseOther(one, { ...first, other: '  green  ' })
  assert.deepEqual([first.picks, C.answerText(one, first)], [[], 'green'])
  assert.equal(C.answerText(one, C.pickOption(one, first, 'Red')), 'Red')
  let second = C.pickOption(many, draft.parts[1], 'C')
  second = C.pickOption(many, second, 'A')
  second = C.pickOption(many, second, 'B')
  second = C.pickOption(many, second, 'B')
  assert.equal(C.answerText(many, second), 'A, C')
  second = { ...C.chooseOther(many, second), other: 'D' }
  assert.equal(C.answerText(many, second), 'A, C, D')
  assert.equal(C.isDraftReady([one, many], { ...draft, parts: [first, second] }), true)
  assert.equal(C.isDraftReady([one], { parts: [{ picks: [], other: '   ', isOther: true }] }), false)
  assert.equal(C.isDraftReady([], draft), false)
})

test('only boxes in the Claude app and VS Code can be answered from CCC', () => {
  assert.equal(C.ANSWERS_FROM_CCC.has('claude-desktop'), true)
  assert.equal(C.ANSWERS_FROM_CCC.has('claude-vscode'), true)
  assert.equal(C.ANSWERS_FROM_CCC.has('cli'), false)
})

test('the next-step box offers its buttons while its question waits, in a session that takes messages', () => {
  const choices = [{ label: 'Yes, add it', message: 'Yes, add the hook.' }, { label: 'Not now', message: 'Not now' }]
  const asking = session('n1', { takesMessages: true, turn: { isRunning: false, endedAt: 5, ending: 'question', question: 'Shall I?', choices } })
  assert.deepEqual(L.openNextStep(asking), { question: 'Shall I?', choices })
  assert.equal(L.openNextStep({ ...asking, turn: { ...asking.turn, isRunning: true } }), null)
  assert.equal(L.openNextStep({ ...asking, endedAt: 9 }), null)
  assert.equal(L.openNextStep({ ...asking, takesMessages: false }), null)
  assert.equal(L.openNextStep({ ...asking, turn: { ...asking.turn, ending: 'done' } }), null)
  assert.equal(L.openNextStep({ ...asking, turn: { ...asking.turn, choices: [{ label: ' ', message: 'x' }, 'nope'] } }), null)
  assert.equal(L.openNextStep(undefined), null)
})

test('the board loads new code by itself only while nothing would be lost', () => {
  assert.equal(L.mayReloadNow({ isWriting: false, isWindowOpen: false, isInteracting: false }), true)
  assert.equal(L.mayReloadNow({ isWriting: true, isWindowOpen: false, isInteracting: false }), false)
  assert.equal(L.mayReloadNow({ isWriting: false, isWindowOpen: true, isInteracting: false }), false)
  assert.equal(L.mayReloadNow({ isWriting: false, isWindowOpen: false, isInteracting: true }), false)
})

test('a folder reads by its name and the folder it sits in, home as ~', () => {
  assert.deepEqual(L.folderLabel('/Users/me/Documents/Work/shop'), { name: 'shop', parent: '~/Documents/Work' })
  assert.deepEqual(L.folderLabel('/opt/work'), { name: 'work', parent: '/opt' })
  assert.deepEqual(L.folderLabel('/'), { name: '/', parent: '/' })
})

test('a session can be started once a folder is picked, in the app unless the Terminal is chosen', () => {
  assert.equal(L.startState({ folder: '', where: 'app' }).canStart, false)
  assert.equal(L.startState({ folder: '/x', where: 'app' }).canStart, true)
  assert.equal(L.startState({ folder: '/x', where: 'app', isStarting: true }).canStart, false)
  assert.equal(L.startState({ folder: '/x', where: 'nowhere' }).where, 'app')
  assert.match(L.startState({ folder: '/x', where: 'terminal' }).note, /Terminal/)
  assert.match(L.startState({ folder: '/x', where: 'app' }).note, /Claude app/)
  assert.match(L.startState({ folder: '/x', where: 'app' }).note, /first message already written/)
})

test('the token history picks a period, a week when the choice is unknown', () => {
  assert.equal(L.tokenPeriod('30').days, 30)
  assert.equal(L.tokenPeriod('today').days, 1)
  assert.equal(L.tokenPeriod('nope').id, '7')
})

const HISTORY = {
  days: [
    { day: '2026-10-18', input: 1, output: 10, cached: 100, total: 111 },
    { day: '2026-10-19', input: 0, output: 0, cached: 0, total: 0 },
    { day: '2026-10-20', input: 2, output: 20, cached: 'x', total: 22 },
  ],
  hours: Array.from({ length: 24 }, (_, i) => ({ input: 0, output: i === 9 ? 5 : 0, cached: 0, total: i === 9 ? 5 : 0 })),
  hour: 14,
  firstDay: '2026-10-19',
}

test('a kind over days is one point a day, today last; over today one point an hour', () => {
  const days = L.historySeries(HISTORY, '7', 'output')
  assert.deepEqual(days.map(d => d.value), [10, 0, 20])
  assert.deepEqual(days.map(d => d.isNow), [false, false, true])
  assert.equal(days[0].label, '18 Oct')
  assert.deepEqual(L.historySeries(HISTORY, '7', 'cached').map(d => d.value), [100, 0, 0])
  const hours = L.historySeries(HISTORY, 'today', 'output')
  assert.equal(hours.length, 24)
  assert.deepEqual([hours[9].value, hours[9].label, hours[14].isNow, hours[14].isToCome, hours[15].isToCome], [5, '09:00', true, false, true])
  assert.deepEqual(L.historySeries(undefined, '7', 'total'), [])
})

test('the picked kind is kept, the total when the choice is unknown', () => {
  assert.equal(L.tokenKind('cached').label, 'Cached')
  assert.equal(L.tokenKind('nope').key, 'total')
  assert.equal(L.tokenKind(null).key, 'total')
})

test('each tab shows its sum over the period and its share of all tokens', () => {
  const week = L.historyTotals(HISTORY, '7')
  assert.deepEqual(week.output, { sum: 30, share: 30 / 133 })
  assert.deepEqual(week.total, { sum: 133, share: 1 })
  assert.deepEqual(L.historyTotals(HISTORY, 'today').output, { sum: 5, share: 1 })
  assert.deepEqual(L.historyTotals(undefined, '7').cached, { sum: 0, share: 0 })
  assert.equal(L.shareOfAll(30 / 133), '23% of all')
  assert.equal(L.shareOfAll(0.004), 'under 1% of all')
  assert.equal(L.shareOfAll(0), '0% of all')
})

test('the figures under the graph: average over the days transcripts cover, busiest, now', () => {
  const week = L.historyStats(HISTORY, '7', 'output')
  // 18 Oct is before the oldest transcript, so the average is over 19 and 20 Oct
  assert.deepEqual(week, { average: 15, spanned: 2, peak: { label: '20 Oct', value: 20 }, now: 20 })
  assert.equal(L.historyStats({ ...HISTORY, firstDay: null }, '7', 'output').average, 10)
  const today = L.historyStats(HISTORY, 'today', 'output')
  assert.deepEqual(today, { average: 5 / 15, spanned: 15, peak: { label: '09:00', value: 5 }, now: 0 })
  assert.deepEqual(L.historyStats(undefined, '7', 'total'), { average: 0, spanned: 0, peak: null, now: 0 })
})

test('the value axis goes up in round steps past the largest value', () => {
  assert.deepEqual(L.niceScale(1000), { max: 1000, ticks: [0, 250, 500, 750, 1000] })
  assert.deepEqual(L.niceScale(1_160_000_000), { max: 1_500_000_000, ticks: [0, 500_000_000, 1_000_000_000, 1_500_000_000] })
  assert.deepEqual(L.niceScale(7), { max: 8, ticks: [0, 2, 4, 6, 8] })
  assert.deepEqual(L.niceScale(0), { max: 0, ticks: [0] })
  assert.deepEqual(L.niceScale(Number.NaN), { max: 0, ticks: [0] })
})

test('points spread evenly over the width, 0 on the bottom edge, and the line and area through them', () => {
  assert.deepEqual(L.linePoints([0, 50, 100], 200, 40, 100), [
    { x: 0, y: 40 },
    { x: 100, y: 20 },
    { x: 200, y: 0 },
  ])
  assert.deepEqual(L.linePoints([5], 200, 40, 10), [{ x: 100, y: 20 }])
  assert.deepEqual(L.linePoints([0, 0], 200, 40, 0), [
    { x: 0, y: 40 },
    { x: 200, y: 40 },
  ])
  assert.deepEqual(L.linePath([{ x: 0, y: 40 }, { x: 100, y: 20 }], 40), { line: 'M0 40 L100 20', area: 'M0 40 L100 20 L100 40 L0 40 Z' })
  assert.deepEqual(L.linePath([], 40), { line: '', area: '' })
})

test('the days under the graph: all of a week, about seven of longer periods with both ends, every sixth hour of today', () => {
  const labels = (count, periodId) =>
    L.axisTicks(
      Array.from({ length: count }, (_, i) => ({ label: String(i) })),
      periodId,
    ).map(tick => tick.index)
  assert.deepEqual(labels(7, '7'), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(labels(14, '14'), [0, 3, 6, 9, 13])
  assert.deepEqual(labels(30, '30'), [0, 5, 10, 15, 20, 25, 29])
  assert.deepEqual(labels(90, '90'), [0, 15, 30, 45, 60, 75, 89])
  assert.deepEqual(labels(24, 'today'), [0, 6, 12, 18, 23])
  // a narrow graph names fewer days, so they never run into each other
  const narrow = (count, room) => L.axisTicks(Array.from({ length: count }, (_, i) => ({ label: String(i) })), String(count), room).map(tick => tick.index)
  assert.deepEqual(narrow(7, 4), [0, 2, 4, 6])
  assert.deepEqual(narrow(7, 3), [0, 3, 6])
  assert.deepEqual(narrow(30, 4), [0, 10, 20, 29])
  assert.deepEqual(narrow(90, 1), [0, 89])
  assert.deepEqual(L.axisTicks(L.historySeries(HISTORY, '7', 'total'), '7'), [
    { index: 0, label: '18 Oct' },
    { index: 1, label: '19 Oct' },
    { index: 2, label: '20 Oct' },
  ])
  assert.deepEqual(L.axisTicks([], '7'), [])
})

test('hovering picks the nearest point, never one still to come', () => {
  assert.equal(L.nearestPoint(0, 230, 24), 0)
  assert.equal(L.nearestPoint(115, 230, 24), 12)
  assert.equal(L.nearestPoint(230, 230, 24, 14), 14)
  assert.equal(L.nearestPoint(-50, 230, 7), 0)
  assert.equal(L.nearestPoint(500, 230, 7), 6)
  assert.equal(L.nearestPoint(80, 230, 1), 0)
})

test('the window says when the period reaches past the oldest transcript', () => {
  assert.match(L.historyNote(HISTORY, '7'), /^Transcripts go back to 19 Oct\./)
  assert.equal(L.historyNote({ ...HISTORY, firstDay: '2026-10-01' }, '7'), '')
  assert.equal(L.historyNote(HISTORY, 'today'), '')
  assert.equal(L.shortDay('nope'), '')
})

test('a session Claude started from another one goes on that session map, not on a card', () => {
  const parent = session('p1', { runs: [{ id: 'a1', kind: 'agent', label: 'Review', status: 'running', startedAt: 1 }] })
  const child = session('c1', {
    parentSessionId: 'p1',
    startedAt: 50,
    turn: { isRunning: true, topic: 'Reply with hi' },
    log: [{ id: 'l1', at: 60, text: '$ ls', status: 'ok' }],
  })
  const grandchild = session('g1', { parentSessionId: 'c1', startedAt: 70, endedAt: 90, turn: { isRunning: false, topic: 'Nested' } })
  const folded = L.foldChildren([parent, child, grandchild])
  assert.deepEqual(folded.map(s => s.sessionId), ['p1'])
  assert.deepEqual(folded[0].runs.slice(1), [
    { id: 'session:c1', kind: 'session', label: 'Reply with hi', status: 'running', startedAt: 50, lastAction: '$ ls' },
    { id: 'session:g1', kind: 'session', label: 'Nested', status: 'done', startedAt: 70, endedAt: 90, lastAction: 'session Claude started' },
  ])
})

test('a child keeps its card when its parent is unknown, and goes when its parent was removed', () => {
  const orphan = session('c1', { parentSessionId: 'gone' })
  const other = session('o1')
  assert.deepEqual(L.foldChildren([orphan, other]).map(s => s.sessionId), ['c1', 'o1'])
  assert.deepEqual(L.foldChildren([orphan, other], [session('gone')]).map(s => s.sessionId), ['o1'])
  const loop = [session('x', { parentSessionId: 'y' }), session('y', { parentSessionId: 'x' })]
  assert.equal(L.foldChildren(loop).length, 2)
  const plain = [other]
  assert.equal(L.foldChildren(plain), plain)
})

test('the summary counts sessions that need you apart from those that are done', () => {
  const list = [
    session('w', { turn: { isRunning: true } }),
    session('q', { turn: { isRunning: false, ending: 'question' } }),
    session('d', { turn: { isRunning: false, ending: 'done' } }),
  ]
  const summary = L.summarize(list, NOW)
  assert.deepEqual([summary.live, summary.working, summary.needsYou, summary.done], [3, 1, 1, 1])
})

test("the Claude app's name for a session comes first", () => {
  assert.equal(L.sessionLabel(session('a', { title: 'Claude Code mods and skills', turn: { topic: 'which mods' } })), 'Claude Code mods and skills')
  assert.equal(L.sessionLabel(session('b', { title: '  ', turn: { topic: 'Fix it' } })), 'Fix it')
})

test('the dragon takes the card from where it sits and drops it into the crater', () => {
  const card = { cx: 300, top: 200, width: 320 }
  const crater = { x: 900, y: 500 }
  const plan = planFlight({ card, crater, viewport: { w: 1400, h: 900 }, zoom: 0.9 })
  assert.deepEqual(plan.cargo[0], { offset: 0, x: 300, y: 200, k: 0.9, r: 0, opacity: 1 })
  const landed = plan.cargo.find(f => f.offset * plan.duration >= plan.landedAt)
  assert.ok(Math.abs(landed.x - crater.x) < 1 && Math.abs(landed.y - (crater.y + 4)) < 1)
  assert.equal(landed.opacity, 0)
  assert.equal(plan.cargo.at(-1).opacity, 0)
  const offsets = plan.cargo.map(f => f.offset)
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b))
  assert.equal(offsets.at(-1), 1)
})

test('the dragon comes in from the side away from the crater and holds a big card smaller', () => {
  const right = planFlight({ card: { cx: 300, top: 200, width: 600 }, crater: { x: 900, y: 500 }, viewport: { w: 1400, h: 900 } })
  const left = planFlight({ card: { cx: 1100, top: 200, width: 600 }, crater: { x: 300, y: 500 }, viewport: { w: 1400, h: 900 } })
  assert.equal(right.dir, 1)
  assert.ok(right.dragon[0].x < 0)
  assert.equal(left.dir, -1)
  assert.ok(left.dragon[0].x > 1400)
  const atGrab = right.dragon.find(f => f.offset * right.duration >= right.grabAt)
  assert.ok(Math.abs(atGrab.x - 300) < 1 && Math.abs(atGrab.y - 206) < 2)
  const carried = right.cargo.filter(f => f.offset * right.duration > right.grabAt + 400 && f.offset * right.duration < right.landedAt - 800)
  assert.ok(carried.length > 0 && carried.every(f => f.k * 600 <= 300 + 0.01))
})

test('while it flies the card over, the whole dragon stays in the window', () => {
  for (const top of [120, 229, 600]) {
    const plan = planFlight({ card: { cx: 300, top, width: 300 }, crater: { x: 900, y: 300 }, viewport: { w: 1400, h: 900 } })
    const from = plan.liftAt + (plan.releaseAt - plan.liftAt) * 0.35
    const flying = plan.dragon.filter(f => f.offset * plan.duration >= from && f.offset * plan.duration <= plan.releaseAt)
    assert.ok(flying.length > 0 && flying.every(f => f.y - 156 * f.s >= 0), `card at ${top}`)
  }
})

test('the dragon aims at a crater that shows, the big middle one first', () => {
  const craters = [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]
  assert.equal(chooseCrater(craters, () => false).x, 2)
  assert.equal(chooseCrater(craters, c => c.x === 2).x, 1)
  assert.equal(chooseCrater(craters, c => c.x !== 3).x, 3)
  assert.equal(chooseCrater(craters, () => true).x, 2)
})

test('in Inferno a new card comes out of the crater nearest to its spot', () => {
  const craters = [{ x: 100, y: 500 }, { x: 600, y: 300 }, { x: 900, y: 550 }]
  assert.equal(nearestCrater(craters, 80).x, 100)
  assert.equal(nearestCrater(craters, 640).x, 600)
  assert.equal(nearestCrater(craters, 2000).x, 900)
})

test('Claude\'s Markdown is read into plain blocks', () => {
  const text = [
    '## Done',
    '',
    'It **works** now in `board.js`.',
    'Second line.',
    '',
    '- ett',
    '- two',
    '  goes on',
    '',
    '1. first',
    '2. then',
    '',
    '| Del | Antal |',
    '|---|---|',
    '| Board | 55 |',
    '',
    '> citat',
    '',
    '```bash',
    'ccc',
    '```',
    '---',
  ].join('\n')
  const out = blocks(text)
  assert.deepEqual(out.map(b => b.type), ['heading', 'paragraph', 'list', 'list', 'table', 'quote', 'code', 'rule'])
  assert.equal(out[0].level, 2)
  assert.deepEqual(out[1].inline.map(s => s.t), ['text', 'strong', 'text', 'code', 'text'])
  assert.equal(out[2].items.length, 2)
  assert.deepEqual(out[2].items[1].map(s => s.text), ['two goes on'])
  assert.equal(out[3].ordered, true)
  assert.deepEqual(out[4].head.map(c => c[0].text), ['Del', 'Antal'])
  assert.deepEqual(out[4].rows[0].map(c => c[0].text), ['Board', '55'])
  assert.equal(out[6].lang, 'bash')
  assert.equal(out[6].text, 'ccc')
})

test('links keep their address only when it is http or https', () => {
  assert.deepEqual(inline('see [docs](https://example.com) and [x](javascript:alert(1))'), [
    { t: 'text', text: 'see ' },
    { t: 'link', text: 'docs', href: 'https://example.com' },
    { t: 'text', text: ' and ' },
    { t: 'text', text: 'x' },
    { t: 'text', text: ')' },
  ])
  assert.deepEqual(inline('<b>hi</b> *some* 2*3*4'), [{ t: 'text', text: '<b>hi</b> ' }, { t: 'em', text: 'some' }, { t: 'text', text: ' 2*3*4' }])
  assert.deepEqual(blocks(undefined), [])
  assert.deepEqual(blocks('```\nnever closed'), [{ type: 'code', lang: '', text: 'never closed' }])
})

test('the chat window folds each run of steps into one', () => {
  const items = [{ kind: 'you', text: 'q' }, { kind: 'tool', text: 'a' }, { kind: 'tool', text: 'b' }, { kind: 'claude', text: 'svar' }, { kind: 'tool', text: 'c' }]
  assert.deepEqual(C.groupSteps(items).map(i => (i.kind === 'steps' ? i.steps.map(s => s.text).join('+') : i.kind)), ['you', 'a+b', 'claude', 'c'])
  assert.deepEqual(C.groupSteps(undefined), [])
})

test('only what the history does not hold yet shows as the live reply', () => {
  const items = [{ kind: 'you', text: 'old' }, { kind: 'claude', text: 'Old answer.' }, { kind: 'you', text: 'new question' }, { kind: 'claude', text: 'Let me check.' }, { kind: 'tool', text: '$ ls' }]
  assert.equal(C.liveRemainder(items, 'Let me check.\n\nNow I write on'), 'Now I write on')
  assert.equal(C.liveRemainder(items, 'Let me check.'), '')
  assert.equal(C.liveRemainder([{ kind: 'you', text: 'q' }], 'All of it is new'), 'All of it is new')
  assert.equal(C.liveRemainder(items, undefined), '')
})

test('the window says when it can write and when the message has to wait', () => {
  assert.equal(C.composeState(undefined).canSend, false)
  assert.deepEqual(C.composeState({ turn: { isRunning: false } }), { canSend: false, note: 'This session runs an older CCC. Restart it to write to it from here.' })
  assert.deepEqual(C.composeState({ takesMessages: true, turn: { isRunning: false } }), { canSend: true, note: '' })
  assert.match(C.composeState({ takesMessages: true, turn: { isRunning: true } }).note, /Enter or Send queues it until Claude is done; ⌘Enter stops Claude/)
  assert.match(C.composeState({ takesMessages: true, endedAt: 5, turn: {} }).note, /has ended/)
  // a stopped session of the Claude app or VS Code is woken by opening it there
  const asleep = C.composeState({ takesMessages: true, endedAt: 5, turn: {}, appSessionId: 'local_abc-1' })
  assert.deepEqual([asleep.canSend, asleep.wakeIn], [true, 'the Claude app'])
  assert.match(asleep.note, /asleep/)
  assert.equal(C.composeState({ takesMessages: true, endedAt: 5, turn: {}, entrypoint: 'claude-vscode' }).wakeIn, 'VS Code')
  assert.equal(C.composeState({ takesMessages: true, turn: { isRunning: false }, appSessionId: 'local_abc-1' }).wakeIn, undefined)
  assert.equal(C.isWakeable({ appSessionId: 'local_../x' }), '')
})

test('Enter queues while Claude works, sends when it does not; with Cmd it stops Claude and sends', () => {
  assert.equal(C.enterMode(true, false), 'queue')
  assert.equal(C.enterMode(true, true), 'now')
  assert.equal(C.enterMode(false, false), 'now')
  assert.equal(C.enterMode(false, true), 'now')
})

test('a long message goes; one over the server limit says how long it is', () => {
  assert.equal(C.lengthProblem('x'.repeat(C.MESSAGE_MAX)), '')
  assert.equal(C.lengthProblem('x'.repeat(C.MESSAGE_MAX + 1)), 'The message is too long: 4 000 001 characters, at most 4 000 000.')
  assert.equal(C.lengthProblem(undefined), '')
})

test('only real images of a fair size go with a message', () => {
  assert.equal(C.imageProblem({ type: 'image/png', size: 2000 }, 0), '')
  assert.match(C.imageProblem({ type: 'image/svg+xml', size: 2000 }, 0), /PNG/)
  assert.match(C.imageProblem({ type: 'image/png', size: 11 * 1024 * 1024 }, 0), /10 MB/)
  assert.match(C.imageProblem({ type: 'image/png', size: 0 }, 0), /10 MB/)
  assert.match(C.imageProblem({ type: 'image/png', size: 10 }, C.MAX_IMAGES), /At most/)
  assert.match(C.imageProblem(undefined, 0), /PNG/)
})

test('a code block can hold a shorter fence of its own, and keeps its language', () => {
  const text = ['````markdown', '# Titel', '', '```bash', 'ccc', '```', '````', 'efter'].join('\n')
  assert.deepEqual(blocks(text), [
    { type: 'code', lang: 'markdown', text: '# Titel\n\n```bash\nccc\n```' },
    { type: 'paragraph', inline: [{ t: 'text', text: 'efter' }] },
  ])
  assert.deepEqual(blocks('```js title="a.js"\nx\n```'), [{ type: 'code', lang: 'js', text: 'x' }])
  assert.deepEqual(blocks('~~~\ny\n~~~'), [{ type: 'code', lang: '', text: 'y' }])
  assert.deepEqual(blocks('text\n```\nz\n```').map(b => b.type), ['paragraph', 'code'])
})

// ---------- where cards sit ----------

const card = (id, x, y, w = 300, h = 200) => ({ id, x, y, w, h })

test('cards closer than the gap count as lying over each other; side by side at the gap they do not', () => {
  assert.equal(P.overlaps(card('a', 0, 0), card('b', 300 + P.GAP, 0)), false)
  assert.equal(P.overlaps(card('a', 0, 0), card('b', 305, 0)), true)
  assert.equal(P.overlaps(card('a', 0, 0), card('b', 0, 200 + P.GAP)), false)
  assert.equal(P.overlaps(card('a', 0, 0), card('b', 400, 400)), false)
})

test('a card let go near an edge sticks to it: the board, beside a card, under a card, lined up', () => {
  const chat = card('chat', 0, 0, 600, 700)
  assert.deepEqual(P.snapPlace(card('c', 7, 9), [], 1200), card('c', 0, 0))
  assert.deepEqual(P.snapPlace(card('c', 620, 5), [chat], 1200), card('c', 600 + P.GAP, 0))
  assert.deepEqual(P.snapPlace(card('c', 10, 705), [chat], 1200), card('c', 0, 700 + P.GAP))
  assert.deepEqual(P.snapPlace(card('c', 890, 40), [], 1200), card('c', 900, 40))
  assert.deepEqual(P.snapPlace(card('c', 450, 300), [chat], 1200), card('c', 450, 300))
})

test('a card let go over another goes under it, and the others stay put', () => {
  const chat = card('chat', 0, 0, 600, 700)
  const dropped = P.dropPlace(card('c', 100, 500), [chat], 1200)
  assert.deepEqual(dropped, card('c', 100, 700 + P.GAP))
  assert.deepEqual(P.dropPlace(card('c', -50, -20, 300), [], 1200), card('c', 0, 0))
  assert.deepEqual(P.dropPlace(card('c', 1100, 0, 300), [], 1200), card('c', 900, 0))
})

test('the board keeps every place, moving a card down only past one above that grew into it', () => {
  const grown = card('chat', 0, 0, 600, 900)
  const under = card('c', 0, 712)
  const beside = card('d', 612, 0)
  const { places, height } = P.arrange([under, beside, grown], 1200)
  assert.deepEqual(places.get('chat'), grown)
  assert.deepEqual(places.get('d'), beside)
  assert.deepEqual(places.get('c'), card('c', 0, 900 + P.GAP))
  assert.equal(height, 900 + P.GAP + 200)
  const shrunk = P.arrange([under, beside, { ...grown, h: 700 }], 1200)
  assert.deepEqual(shrunk.places.get('c'), under)
})

test('a card with no place yet takes the first free spot, beside or under the others', () => {
  const { places } = P.arrange([card('a', 0, 0, 600, 700), { id: 'new', w: 300, h: 200 }, { id: 'next', w: 300, h: 200 }], 1000)
  assert.deepEqual(places.get('new'), card('new', 612, 0))
  assert.deepEqual(places.get('next'), card('next', 612, 212))
  const narrow = P.arrange([{ id: 'a', w: 300, h: 100 }, { id: 'b', w: 300, h: 100 }], 400)
  assert.deepEqual(narrow.places.get('b'), card('b', 0, 112, 300, 100))
  assert.deepEqual(P.arrange([{ id: 'wide', w: 2000, h: 50 }], 800).places.get('wide'), card('wide', 0, 0, 800, 50))
})

test('a pulled side sticks to the nearest edge; the sides not pulled stay', () => {
  const other = card('o', 400, 0, 300, 300)
  assert.deepEqual(P.snapSides(card('c', 0, 0, 380, 200), { right: true }, [other], 1200), card('c', 0, 0, 400 - P.GAP, 200))
  assert.deepEqual(P.snapSides(card('c', 715, 10, 297, 200), { left: true, top: true }, [other], 1200), card('c', 700 + P.GAP, 0, 300, 210))
  assert.deepEqual(P.snapSides(card('c', 712, 50, 300, 200), { top: true }, [other], 1200), card('c', 712, 50, 300, 200))
  assert.deepEqual(P.snapSides(card('c', 0, 0, 300, 290), { bottom: true }, [other], 1200), card('c', 0, 0, 300, 300))
  assert.deepEqual(P.snapSides(card('c', 0, 0, 300, 150), { bottom: true }, [other], 1200), card('c', 0, 0, 300, 150))
})

test('a pulled side stops at its neighbour with the gap; pulled down it may reach a card below', () => {
  const chat = card('chat', 0, 0, 600, 700)
  const from = card('c', 612, 0, 300, 200)
  const pulledLeft = P.limitSides(card('c', 400, 0, 512, 200), from, { left: true }, [chat])
  assert.deepEqual(pulledLeft, card('c', 612, 0, 300, 200))
  const besideRight = card('r', 1000, 0, 200, 200)
  assert.deepEqual(P.limitSides(card('c', 612, 0, 500, 200), from, { right: true }, [chat, besideRight]), card('c', 612, 0, 1000 - P.GAP - 612, 200))
  const above = card('a', 612, 0, 300, 100)
  const lower = { ...from, y: 300 }
  assert.deepEqual(P.limitSides(card('c', 612, 50, 300, 400), lower, { top: true }, [above]), card('c', 612, 100 + P.GAP, 300, 400 - (100 + P.GAP - 50)))
  const below = card('b', 612, 300, 300, 200)
  assert.deepEqual(P.limitSides(card('c', 612, 0, 300, 500), from, { bottom: true }, [below]), card('c', 612, 0, 300, 500))
  assert.deepEqual(P.limitSides(card('c', 300, 800, 612, 200), card('c', 612, 800, 300, 200), { left: true }, [chat]), card('c', 300, 800, 612, 200))
})

test('a card a chat grows into makes way by the shorter move: aside when it got wider, down when taller', () => {
  const wider = card('chat', 0, 0, 900, 640)
  const beside = card('b', 612 + P.GAP, 0)
  assert.deepEqual(P.makeRoom(beside, [wider], 1400), card('b', 900 + P.GAP, 0))
  // no room aside on a narrow board: it goes down
  assert.deepEqual(P.makeRoom(beside, [wider], 1000), card('b', 624, 640 + P.GAP))
  const taller = card('chat', 0, 0, 600, 800)
  const under = card('u', 0, 652)
  assert.deepEqual(P.makeRoom(under, [taller], 1400), card('u', 0, 800 + P.GAP))
  const { places } = P.arrange([wider, beside], 1400)
  assert.deepEqual(places.get('b'), card('b', 912, 0))
  const back = P.arrange([{ ...wider, w: 600 }, beside], 1400)
  assert.deepEqual(back.places.get('b'), beside)
})

test('an approval box says what the app says: run a command, edit a file, use a tool', () => {
  const bash = C.approvalView({ kind: 'approval', reason: 'Contains brace with quote character', box: { box: 'ab12cd34ef567890', tool: 'Bash', description: 'Fetch source files', command: 'S=1\necho $S' } })
  assert.deepEqual(bash, { branch: null, title: 'Allow Claude to run Fetch source files?', description: '', reason: 'Contains brace with quote character', code: 'S=1\necho $S', box: 'ab12cd34ef567890', canAnswer: true })
  assert.equal(C.approvalView({ kind: 'approval', box: { box: 'b', tool: 'Bash', command: 'ls' } }).title, 'Allow Claude to run this command?')
  const edit = C.approvalView({ kind: 'approval', box: { box: 'b', tool: 'Edit', target: '/Users/x/shop/src/Main.java' } })
  assert.deepEqual([edit.title, edit.code], ['Allow Claude to edit Main.java?', '/Users/x/shop/src/Main.java'])
  const mcp = C.approvalView({ kind: 'approval', box: { box: 'b', tool: 'mcp__github__create_issue', description: 'File the bug', detail: '{"title": "x"}' } })
  assert.deepEqual([mcp.title, mcp.description, mcp.code], ['Allow Claude to use create_issue (github)?', 'File the bug', '{"title": "x"}'])
})

test('an approval box only the app holds says where to answer, and other waits draw none', () => {
  const only = C.approvalView({ kind: 'approval', text: '$ rm -rf build' })
  assert.deepEqual([only.title, only.code, only.canAnswer, only.reason], ['Claude asks to go ahead with this', '$ rm -rf build', false, ''])
  assert.equal(C.approvalView({ kind: 'question' }), null)
  assert.equal(C.approvalView(undefined), null)
  assert.equal(C.toolLabel(''), 'a tool')
  assert.equal(C.toolLabel('WebSearch'), 'WebSearch')
})

test('the approval box says how the answer from here goes', () => {
  assert.equal(C.approvalStatus(undefined), 'Answer here, or in the app.')
  assert.equal(C.approvalStatus({ state: 'sending', choice: 'allow' }), 'Sending…')
  assert.equal(C.approvalStatus({ state: 'sent', choice: 'allow' }), 'Allowed. Claude goes on in a moment.')
  assert.equal(C.approvalStatus({ state: 'sent', choice: 'deny' }), 'Denied. Claude hears it in a moment.')
  assert.equal(C.approvalStatus({ state: 'open', problem: 'That approval is no longer waiting.' }), 'That approval is no longer waiting.')
})

test('an agent shows its steps numbered from its first, with how many earlier ones are gone', () => {
  const steps = [
    { id: 's9', at: 9, text: 'Read a.go', status: 'ok', endedAt: 10 },
    { id: 's10', at: 11, text: '$ go test', status: 'error', endedAt: 12 },
    { id: 's11', at: 13, text: 'Grep foo', status: 'running' },
  ]
  const shown = L.agentSteps({ steps, stepCount: 11 })
  assert.deepEqual([shown.count, shown.earlier], [11, 8])
  assert.deepEqual(shown.steps.map(step => step.number), [9, 10, 11])
  assert.deepEqual(L.agentSteps({ steps }).count, 3)
  assert.deepEqual(L.agentSteps({ steps: [{ id: 'x' }, ...steps], stepCount: 'x' }).steps.length, 3)
  assert.deepEqual(L.agentSteps(undefined), { count: 0, earlier: 0, steps: [] })
})

test('an agent without a plan shows its latest tool calls as boxes, as many as there is room for', () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, at: i, text: `Read ${i}`, status: i === 11 ? 'running' : i === 9 ? 'error' : 'ok' }))
  const shown = L.stepNodes({ steps, stepCount: 20 }, 4)
  assert.deepEqual(shown.nodes.map(node => [node.number, node.status]), [[17, 'ok'], [18, 'error'], [19, 'ok'], [20, 'running']])
  assert.deepEqual([shown.earlier, shown.later], [16, 0])
  assert.deepEqual(L.stepNodes({ steps }, 0), { nodes: [], earlier: 12, later: 0 })
  assert.deepEqual(L.stepNodes({}, 5), { nodes: [], earlier: 0, later: 0 })
})

test('an agent with a plan shows its planned steps around the one it works on', () => {
  const plan = ['Read', 'Run tests', 'Review', 'Write', 'Send', 'Clean up'].map((text, i) => ({ text, status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending' }))
  const shown = L.stepNodes({ plan, steps: [{ id: 'x', at: 1, text: 'Read a', status: 'ok' }] }, 3)
  assert.deepEqual(shown.nodes.map(node => [node.kind, node.number, node.text, node.status]), [['plan', 3, 'Review', 'ok'], ['plan', 4, 'Write', 'running'], ['plan', 5, 'Send', 'pending']])
  assert.deepEqual([shown.earlier, shown.later], [2, 1])
  // all of it shown when there is room; a plan not begun starts at its first step; a plan done ends at its last
  assert.equal(L.stepNodes({ plan }, 10).nodes.length, 6)
  const fresh = plan.map(step => ({ ...step, status: 'pending' }))
  assert.equal(L.stepNodes({ plan: fresh }, 2).nodes[0].number, 1)
  const done = plan.map(step => ({ ...step, status: 'completed' }))
  assert.deepEqual(L.stepNodes({ plan: done }, 2).nodes.map(node => node.number), [5, 6])
  assert.deepEqual(L.agentPlan({ plan: [{ text: '  ', status: 'pending' }, { text: 'Ett', status: 'pending' }] }), [{ text: 'Ett', status: 'pending' }])
})

test('a step box says what the step does and on what', () => {
  assert.deepEqual(L.stepWords('Read …/client.go'), { verb: 'Read', rest: '…/client.go' })
  assert.deepEqual(L.stepWords('$ go test ./...'), { verb: '$', rest: 'go test ./...' })
  assert.deepEqual(L.stepWords('Start agent: Review'), { verb: 'Start', rest: 'agent: Review' })
  assert.deepEqual(L.stepWords('Grep'), { verb: 'Grep', rest: '' })
})

test('a long prompt is cut down with Show more, as in the app', () => {
  assert.equal(C.isLongPrompt('short'), false)
  assert.equal(C.isLongPrompt('x'.repeat(481)), true)
  assert.equal(C.isLongPrompt('a\nb\nc\nd\ne\nf\ng'), true)
  assert.equal(C.promptKey('hi'), C.promptKey('hi'))
  assert.notEqual(C.promptKey('hi'), C.promptKey('hi!'))
})

test('any file goes along: images as images, the rest as files of at most 20 MB', () => {
  assert.equal(C.isImage({ type: 'image/png' }), true)
  assert.equal(C.isImage({ type: 'text/plain' }), false)
  assert.equal(C.fileProblem({ size: 1000 }, 0), '')
  assert.match(C.fileProblem({ size: 0 }, 0), /empty/)
  assert.match(C.fileProblem({ size: 21 * 1024 * 1024 }, 0), /20 MB/)
  assert.match(C.fileProblem({ size: 10 }, C.MAX_FILES), /At most 10 files/)
  assert.equal(C.fileSize(820), '820 B')
  assert.equal(C.fileSize(14 * 1024), '14 KB')
  assert.equal(C.fileSize(3.2 * 1024 * 1024), '3.2 MB')
})

test('the "/" menu opens on the first word and narrows to what is typed', () => {
  assert.equal(C.slashTyped('/'), '')
  assert.equal(C.slashTyped('/cave'), 'cave')
  assert.equal(C.slashTyped('/caveman do it'), null)
  assert.equal(C.slashTyped('hi /cave'), null)
  const commands = [{ name: 'model' }, { name: 'caveman' }, { name: 'caveman-help' }, { name: 'anthropic-skills:pdf' }, { name: 'pdf' }]
  assert.deepEqual(C.matchCommands(commands, 'cave').map(c => c.name), ['caveman', 'caveman-help'])
  assert.deepEqual(C.matchCommands(commands, 'pdf').map(c => c.name), ['pdf', 'anthropic-skills:pdf'])
  assert.equal(C.matchCommands(commands, '').length, 5)
  assert.equal(C.commandKind({ source: 'plugin' }), 'plugin')
  assert.equal(C.commandKind({ source: 'builtin' }), 'built-in')
})

test('the session settings mark what the session runs now', () => {
  assert.deepEqual(C.sessionSetup({ stats: { model: 'claude-opus-5-5', effort: 'high', mode: 'auto' } }), { modelId: 'claude-opus-5-5', effort: 'high', mode: 'auto' })
  assert.deepEqual(C.sessionSetup(undefined), { modelId: '', effort: '', mode: '' })
  assert.equal(C.sessionSetup({ stats: {}, permissionMode: 'auto' }).mode, 'auto')
  assert.equal(C.sessionSetup({ stats: { mode: 'plan' }, permissionMode: 'auto' }).mode, 'plan')
  assert.equal(C.sameChoice('opus', 'claude-opus-5-5'), true)
  assert.equal(C.sameChoice('opus[1m]', 'claude-opus-5-5'), false)
  assert.equal(C.sameChoice('opus[1m]', 'claude-opus-5-5[1m]'), true)
  assert.equal(C.sameChoice('sonnet', 'claude-opus-5-5'), false)
  assert.equal(C.sameChoice('high', 'high'), true)
  assert.deepEqual(C.modelChoices([]), ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best', 'opusplan'])
  assert.deepEqual(C.modelChoices(['opus', 5]), ['opus'])
})

test('a context is cleared only in a session that runs the new CCC and is running', () => {
  assert.equal(L.endProblem({ takesMessages: true }), '')
  assert.match(L.endProblem({ takesMessages: false }), /older CCC/)
  assert.match(L.endProblem({ takesMessages: true, endedAt: 5 }), /not running/)
  assert.match(L.endProblem(undefined), /no longer/)
})

test('the history of conversations is searched by name and folder, and says how long ago', () => {
  const list = [{ title: 'Fix the login bug', folder: '/Users/me/blog' }, { title: 'Theme work', folder: '/Users/me/ccc' }]
  assert.deepEqual(L.matchConversations(list, 'login').map(c => c.title), ['Fix the login bug'])
  assert.deepEqual(L.matchConversations(list, 'ccc theme').map(c => c.title), ['Theme work'])
  assert.equal(L.matchConversations(list, '').length, 2)
  assert.equal(L.timeAgo(1000, 1000 + 20_000), 'just now')
  assert.equal(L.timeAgo(0, 5 * 60_000), '5 min ago')
  assert.equal(L.timeAgo(0, 3 * 3600_000), '3 h ago')
  assert.equal(L.timeAgo(0, 30 * 3600_000), 'yesterday')
  assert.equal(L.timeAgo(0, 5 * 86400_000), '5 days ago')
})

test('a run of steps is summed up in the app\'s own words', () => {
  assert.equal(C.stepsSummary([{ tool: 'Bash' }, { tool: 'Bash' }, { tool: 'Read' }]), 'Ran 2 commands, read a file')
  assert.equal(C.stepsSummary([{ tool: 'mcp__Claude_Browser__browser_batch', actions: ['javascript_tool:javascript_exec', 'computer:screenshot'] }]), 'Ran page script, captured page')
  assert.equal(C.stepsSummary([{ tool: 'Edit' }, { tool: 'Edit' }, { tool: 'Write' }]), 'Edited 2 files, wrote a file')
  assert.equal(C.stepsSummary([{ tool: 'mcp__github__create_issue' }]), 'Used create issue')
  assert.equal(C.stepsSummary([{ tool: 'mcp__Claude_Browser__computer' }]), 'Worked the page')
  assert.equal(C.stepsSummary([{}]), 'Took a step')
  assert.equal(C.stepsSummary([]), '')
})

test('the app\'s own bookkeeping calls never show as steps', () => {
  const grouped = C.groupSteps([{ kind: 'tool', tool: 'Bash', text: '$ ls' }, { kind: 'tool', tool: 'mcp__ccd_turn__update_plan', text: 'update plan' }, { kind: 'claude', text: 'hi' }, { kind: 'tool', tool: 'mcp__ccd_turn__wrap_up', text: 'wrap up' }])
  assert.deepEqual(grouped.map(item => item.kind), ['steps', 'claude'])
  assert.equal(grouped[0].steps.length, 1)
})

test('the suggested next prompt shows only while Claude is not working', () => {
  assert.equal(C.suggestionOf({ turn: { isRunning: false, suggestion: '  run the tests  ' } }), 'run the tests')
  assert.equal(C.suggestionOf({ turn: { isRunning: true, suggestion: 'run the tests' } }), '')
  assert.equal(C.suggestionOf({ turn: { isRunning: false } }), '')
  assert.equal(C.suggestionOf(undefined), '')
})

test('emoticons and shortcodes become emoji, as whole words outside code', () => {
  assert.equal(C.emojiFor(':)'), '🙂')
  assert.equal(C.emojiFor(':fire:'), '🔥')
  assert.equal(C.emojiFor(':nope:'), undefined)
  assert.equal(C.emojiFor('hello'), undefined)
  assert.deepEqual(C.emojifyAt('merged! :)', 10), { text: 'merged! 🙂', caret: 10 })
  assert.deepEqual(C.emojifyAt('so :fire: now', 9), { text: 'so 🔥 now', caret: 5 })
  assert.equal(C.emojifyAt('a:)', 3), null)
  assert.equal(C.emojifyAt('run `x :)', 9), null)
  assert.equal(C.emojifyAt('run `x` :)', 10)?.text, 'run `x` 🙂')
  assert.equal(C.findEmoji('party').map(([e]) => e).includes('🎉'), true)
  assert.equal(C.findEmoji('').length, C.EMOJI.length)
})

test('a closed steps card stays closed until its steps change', () => {
  const plan = [{ text: 'Find it', status: 'completed' }, { text: 'Fix it', status: 'in_progress' }]
  const closed = C.closePlan({}, 's1', plan)
  assert.equal(C.isPlanClosed(closed, 's1', plan), true)
  assert.equal(C.isPlanClosed(closed, 's2', plan), false)
  assert.equal(C.isPlanClosed(closed, 's1', [{ text: 'Find it', status: 'completed' }, { text: 'Fix it', status: 'completed' }]), false)
  assert.equal(C.isPlanClosed(closed, 's1', [...plan, { text: 'Test it', status: 'pending' }]), false)
  assert.equal(C.isPlanClosed({}, 's1', plan), false)
})

test('terminals open in the app picked, else iTerm when this Mac has it, else Terminal', () => {
  const both = [{ id: 'iterm', name: 'iTerm' }, { id: 'terminal', name: 'Terminal' }]
  assert.deepEqual(L.terminalApp('auto', both), { id: 'iterm', name: 'iTerm' })
  assert.deepEqual(L.terminalApp('terminal', both), { id: 'terminal', name: 'Terminal' })
  assert.deepEqual(L.terminalApp('iterm', [{ id: 'terminal', name: 'Terminal' }]), { id: 'terminal', name: 'Terminal' })
  assert.deepEqual(L.terminalApp('auto', undefined), { id: 'terminal', name: 'Terminal' })
  assert.equal(L.normalizeSettings({ terminalApp: 'iterm' }).terminalApp, 'iterm')
  assert.equal(L.normalizeSettings({ terminalApp: 'xterm' }).terminalApp, 'auto')
  assert.match(L.startState({ folder: '/x', where: 'terminal', appName: 'iTerm' }).note, /Opens iTerm/)
})

test('a terminal is named by its shell, else by its folder', () => {
  assert.equal(L.terminalTitle('', '/Users/me/shop'), 'shop')
  assert.equal(L.terminalTitle('  vim notes.md \u0007', '/Users/me/shop'), 'vim notes.md')
  assert.equal(L.terminalTitle(undefined, '/'), '/')
  assert.equal(L.terminalTitle('me@my-mac:/Users/me/shop', '/x'), 'shop')
  assert.equal(L.terminalTitle('me@work-laptop:~', '/x'), '~')
  assert.equal(L.terminalTitle('me@mac:~/code/blog', '/x'), 'blog')
  assert.equal(L.terminalTitle('npm run dev', '/x'), 'npm run dev')
})

test('every theme has its own terminal colours, Spectrum its square letters', () => {
  for (const id of L.THEME_IDS) {
    const look = L.terminalLook(id)
    assert.match(look.theme.background, /^#[0-9a-f]{6}$/, id)
    assert.ok(look.theme.foreground && look.theme.red && look.theme.brightWhite, id)
  }
  assert.match(L.terminalLook('spectrum').fontFamily, /Press Start 2P/)
  assert.equal(L.terminalLook('spectrum').theme.brightRed, '#ff0000')
  assert.equal(L.terminalLook('clean').theme.background, '#ffffff')
  assert.deepEqual(L.terminalLook('nope'), L.terminalLook('aero'))
})

test('the side panel is shown unless turned off', () => {
  assert.equal(L.normalizeSettings({}).sidePanel, true)
  assert.equal(L.normalizeSettings({ sidePanel: false }).sidePanel, false)
  assert.equal(L.normalizeSettings({ sidePanel: 'no' }).sidePanel, true)
})

test('words not sent yet are kept per chat until sent, emptied or a month old', () => {
  const day = 86_400_000
  let drafts = C.keepDraft({}, 's1', 'Fix the login ', NOW)
  drafts = C.keepDraft(drafts, 's2', 'hi', NOW)
  assert.equal(C.draftOf(drafts, 's1', NOW + day), 'Fix the login ')
  assert.equal(C.draftOf(drafts, 's3', NOW), '')
  assert.equal(C.draftOf(drafts, 's1', NOW + 31 * day), '')
  drafts = C.keepDraft(drafts, 's1', '   ', NOW)
  assert.equal(C.draftOf(drafts, 's1', NOW), '')
  assert.equal(C.draftOf(drafts, 's2', NOW), 'hi')
  assert.equal(C.draftOf(C.keepDraft({}, 's1', 'x'.repeat(C.DRAFT_MAX + 1), NOW), 's1', NOW), '')
  let many = {}
  for (let i = 0; i < 105; i++) many = C.keepDraft(many, `s${i}`, 'w', NOW + i)
  assert.equal(Object.keys(many).length, 100)
  assert.equal(C.draftOf(many, 's0', NOW), '')
  assert.equal(C.draftOf(many, 's104', NOW), 'w')
  assert.equal(C.draftOf({ s1: { text: 5, at: NOW } }, 's1', NOW), '')
})

test('with shift-scrolling on, the wheel moves what is under the pointer, and a scroll button moves the board', () => {
  const on = { isOn: true, buttonHeld: false, ctrlKey: false, inWindow: false, canScrollInside: false, inCard: false }
  assert.equal(L.wheelGoes({ ...on, isOn: false }), 'default')
  assert.equal(L.wheelGoes(on), 'nothing')
  assert.equal(L.wheelGoes({ ...on, inCard: true }), 'card')
  assert.equal(L.wheelGoes({ ...on, inCard: true, canScrollInside: true }), 'inside')
  assert.equal(L.wheelGoes({ ...on, buttonHeld: true, inCard: true, canScrollInside: true }), 'page')
  // with shift-scrolling off, a scroll button held changes nothing
  assert.equal(L.wheelGoes({ ...on, isOn: false, buttonHeld: true }), 'default')
  // a window over the board, and pinch-to-zoom, are never touched
  assert.equal(L.wheelGoes({ ...on, inWindow: true, buttonHeld: true }), 'default')
  assert.equal(L.wheelGoes({ ...on, ctrlKey: true }), 'default')
  assert.equal(L.normalizeSettings({ shiftScroll: true }).shiftScroll, true)
  assert.equal(L.normalizeSettings({ shiftScroll: 'yes' }).shiftScroll, false)
})

test('a scroll button is held: Shift from the wheel event, the others from their presses', () => {
  const none = new Set()
  // Shift, there from the start
  assert.equal(L.scrollButtonHeld([L.SHIFT_BUTTON], { held: none, shiftKey: true }), true)
  assert.equal(L.scrollButtonHeld([L.SHIFT_BUTTON], { held: none, shiftKey: false }), false)
  // Shift removed: holding it moves nothing, the button added instead does
  assert.equal(L.scrollButtonHeld(['mouse:3'], { held: none, shiftKey: true }), false)
  assert.equal(L.scrollButtonHeld(['mouse:3'], { held: new Set(['mouse:3']), shiftKey: false }), true)
  // several: any one of them held is enough
  assert.equal(L.scrollButtonHeld([L.SHIFT_BUTTON, 'mouse:3', 'key:KeyG'], { held: new Set(['key:KeyG']), shiftKey: false }), true)
  // a button held that is no longer a scroll button moves nothing
  assert.equal(L.scrollButtonHeld([L.SHIFT_BUTTON], { held: new Set(['key:KeyG']), shiftKey: false }), false)
  assert.equal(L.scrollButtonHeld([], { held: new Set(['key:KeyG']), shiftKey: true }), false)
})

test('a scroll that Shift changes in the middle of stops there; its glide goes nowhere', () => {
  const step = (state, now, shiftKey, delta) => L.followWheel(state, { now, shiftKey, delta })
  // Shift and the wheel move the board, and the Mac glides on after the fingers lift
  let { state, drop } = step(L.WHEEL_START, 0, true, 40)
  assert.equal(drop, false)
  ;({ state, drop } = step(state, 16, true, 30))
  assert.equal(drop, false)
  // Shift let go while it glides: the rest of the glide is dropped, never sent to the chat under the mouse
  ;({ state, drop } = step(state, 32, false, 20))
  assert.equal(drop, true)
  ;({ state, drop } = step(state, 48, false, 10))
  assert.equal(drop, true)
  // after a pause the wheel works again, in the chat under the mouse
  ;({ state, drop } = step(state, 48 + L.WHEEL_GAP_MS + 1, false, 10))
  assert.equal(state.mode, 'inside')
  assert.equal(drop, false)
  // a new push in the middle of a dropped glide is bigger than it, and goes through at once
  let s2 = step(L.WHEEL_START, 0, false, 30).state
  s2 = L.shiftChanged(s2, 10)
  let next = step(s2, 16, true, 12)
  assert.equal(next.drop, true)
  next = step(next.state, 32, true, 60)
  assert.deepEqual([next.drop, next.state.mode], [false, 'page'])
  // pressing Shift with no scroll going on changes nothing
  assert.deepEqual(L.shiftChanged(L.WHEEL_START, 500), L.WHEEL_START)
})

test('a scroll button: a mouse button or a key added in the settings', () => {
  const mouse = button => L.scrollButtonPress({ kind: 'mouse', button })
  const key = code => L.scrollButtonPress({ kind: 'key', code })
  // the extra mouse buttons and the middle one are picked
  assert.deepEqual(mouse(3), { pick: 'mouse:3' })
  assert.deepEqual(mouse(4), { pick: 'mouse:4' })
  assert.deepEqual(mouse(1), { pick: 'mouse:1' })
  assert.deepEqual(mouse(7), { pick: 'mouse:7' })
  // a left click goes on as a click; the right button opens menus
  assert.equal(mouse(0), null)
  assert.deepEqual(mouse(2), { refuse: 'The right button opens menus.' })
  // keys are picked by where they sit on the keyboard; Escape stops the picking
  assert.deepEqual(key('AltLeft'), { pick: 'key:AltLeft' })
  assert.deepEqual(key('F13'), { pick: 'key:F13' })
  assert.deepEqual(key('Escape'), { cancel: true })
  assert.deepEqual(key('ControlLeft'), { refuse: 'Control with the wheel zooms.' })
  // Shift is one button, either side of it, so it can be added back after it was removed
  assert.deepEqual(key('ShiftRight'), { pick: L.SHIFT_BUTTON })
  assert.deepEqual(key('ShiftLeft'), { pick: L.SHIFT_BUTTON })
  // a key with no place on the keyboard, as a mouse's own app can send, goes by its name instead
  const sent = name => L.scrollButtonPress({ kind: 'key', code: '', key: name })
  assert.deepEqual(sent('F13'), { pick: 'key:F13' })
  assert.deepEqual(sent('Alt'), { pick: 'key:Alt' })
  assert.deepEqual(sent('Shift'), { pick: L.SHIFT_BUTTON })
  assert.deepEqual(sent('Escape'), { cancel: true })
  assert.deepEqual(sent('Unidentified'), { refuse: 'That key cannot be used.' })
  assert.deepEqual(sent('+'), { refuse: 'That key cannot be used.' })
  assert.deepEqual(sent(''), { refuse: 'That key cannot be used.' })
  assert.deepEqual(key('<script>'), { refuse: 'That key cannot be used.' })
  // the board holds a press against the kept buttons the same way
  assert.equal(L.scrollButtonOf({ kind: 'key', code: 'AltLeft', key: 'Alt' }), 'key:AltLeft')
  assert.equal(L.scrollButtonOf({ kind: 'key', code: '', key: 'F13' }), 'key:F13')
  assert.equal(L.scrollButtonOf({ kind: 'mouse', button: 3 }), 'mouse:3')
  assert.equal(L.scrollButtonOf({ kind: 'key', code: 'ShiftRight', key: 'Shift' }), L.SHIFT_BUTTON)
  // several can be added, but not the same one twice
  const picked = [L.SHIFT_BUTTON, 'mouse:3', 'key:AltLeft']
  assert.deepEqual(L.scrollButtonPress({ kind: 'mouse', button: 4 }, picked), { pick: 'mouse:4' })
  assert.deepEqual(L.scrollButtonPress({ kind: 'key', code: 'KeyG', key: 'g' }, picked), { pick: 'key:KeyG' })
  assert.deepEqual(L.scrollButtonPress({ kind: 'mouse', button: 3 }, picked), { refuse: 'Mouse button 4 (back) is already added.' })
  assert.deepEqual(L.scrollButtonPress({ kind: 'key', code: 'AltLeft', key: 'Alt' }, picked), { refuse: 'Left Option is already added.' })
  assert.deepEqual(L.scrollButtonPress({ kind: 'key', code: 'ShiftLeft', key: 'Shift' }, picked), { refuse: 'Shift is already added.' })
  assert.deepEqual(L.scrollButtonPress({ kind: 'key', code: 'Escape' }, picked), { cancel: true })
})

test('scroll buttons are named as the settings show them, and broken ones are dropped', () => {
  assert.equal(L.scrollButtonName('mouse:3'), 'Mouse button 4 (back)')
  assert.equal(L.scrollButtonName('mouse:4'), 'Mouse button 5 (forward)')
  assert.equal(L.scrollButtonName('mouse:1'), 'Middle mouse button')
  assert.equal(L.scrollButtonName('mouse:6'), 'Mouse button 7')
  assert.equal(L.scrollButtonName('key:AltRight'), 'Right Option')
  assert.equal(L.scrollButtonName('key:MetaLeft'), 'Left Command')
  assert.equal(L.scrollButtonName('key:KeyF'), 'F')
  assert.equal(L.scrollButtonName('key:Digit5'), '5')
  assert.equal(L.scrollButtonName('key:F13'), 'F13')
  assert.equal(L.scrollButtonName('key:CapsLock'), 'Caps Lock')
  assert.equal(L.scrollButtonName('key:Alt'), 'Option')
  assert.equal(L.scrollButtonName(L.SHIFT_BUTTON), 'Shift')
  assert.equal(L.scrollButtonName('key:KeyG'), 'G')
  assert.equal(L.scrollButtonName(''), 'None')
  // Shift from the start, and for everyone who used shift-scrolling before there were other buttons
  assert.deepEqual(L.normalizeSettings({ shiftScroll: true }).scrollButtons, [L.SHIFT_BUTTON])
  // kept values are checked again when the settings are read: in order, each once, broken ones dropped
  assert.deepEqual(L.normalizeSettings({ scrollButtons: [L.SHIFT_BUTTON, 'mouse:3', 'key:KeyG'] }).scrollButtons, [L.SHIFT_BUTTON, 'mouse:3', 'key:KeyG'])
  assert.deepEqual(L.normalizeSettings({ scrollButtons: ['mouse:4', 'mouse:4', 'mouse:3'] }).scrollButtons, ['mouse:4', 'mouse:3'])
  const broken = ['mouse:0', 'mouse:2', 'mouse:123', 'key:ShiftLeft', 'key:Escape', 'key:', 'keyboard:F', 3, null]
  assert.deepEqual(L.normalizeSettings({ scrollButtons: [...broken, 'mouse:1'] }).scrollButtons, ['mouse:1'])
  for (const one of broken) assert.equal(L.scrollButtonName(one), 'None', String(one))
  // all of them removed stays that way; something that is no list at all is Shift again
  assert.deepEqual(L.normalizeSettings({ scrollButtons: [] }).scrollButtons, [])
  for (const notList of ['mouse:3', null, { 0: 'mouse:3' }]) assert.deepEqual(L.normalizeSettings({ scrollButtons: notList }).scrollButtons, [L.SHIFT_BUTTON])
  // no more than the most there is room for
  const many = Array.from({ length: 12 }, (_, i) => `key:F${i + 1}`)
  assert.equal(L.normalizeSettings({ scrollButtons: many }).scrollButtons.length, L.MAX_SCROLL_BUTTONS)
})

test('the Claude app branch question is drawn as the app draws it, not as an approval', () => {
  const view = C.approvalView({ kind: 'approval', box: { box: 'abcdef0123456789', tool: 'mcp__ccd_directory__propose_branch', kind: 'branch', suggested: 'fix/tax' } })
  assert.deepEqual(view.branch, { suggested: 'fix/tax' })
  assert.equal(view.title, 'Work on a separate branch?')
  assert.equal(C.approvalView({ kind: 'approval', box: { box: 'abcdef0123456789', tool: 'Bash', command: 'ls' } }).branch, null)
  assert.equal(C.approvalStatus({ state: 'sent', choice: 'allow', branch: 'stay' }), 'Sent. Claude goes on in a moment.')
})

test('a card keeps its place from the old free board, rounded to the grid', () => {
  // a board 1200 px wide has columns of 100 px and rows of 20 px
  assert.deepEqual(cellsOf({ x: 612, y: 660, w: 588, h: 640 }, 1200), { x: 6, y: 33, w: 6, h: 32 })
  // never narrower than a readable card, never past the right edge
  assert.deepEqual(cellsOf({ x: 1150, y: 0, w: 100, h: 100 }, 1200), { x: 9, y: 0, w: 3, h: 16 })
  assert.equal(cellsOf(null, 1200), null)
  assert.equal(cellsOf({ x: 'a', y: 0 }, 1200), null)
  assert.equal(cellsOf({ x: 0, y: 0, w: 100, h: 100 }, 0), null)
})

test('a screenshot a step took goes with its steps, as a thumbnail, and the run goes on past it', () => {
  const items = [
    { kind: 'tool', tool: 'Bash', text: '$ ls' },
    { kind: 'image', pictures: ['10:0'] },
    { kind: 'tool', tool: 'Bash', text: '$ pwd' },
    { kind: 'claude', text: 'hi' },
    { kind: 'image', pictures: ['20:0'] },
  ]
  const grouped = C.groupSteps(items)
  assert.equal(grouped.length, 3)
  assert.deepEqual([grouped[0].steps.length, grouped[0].pictures], [2, ['10:0']])
  // with no steps before it, a picture keeps a line of its own
  assert.deepEqual(grouped[2], { kind: 'image', pictures: ['20:0'] })
})

test('steps on one file name it as the app does, and the lines changed are added up', () => {
  const steps = [
    { tool: 'Read', file: 'integrations.plist' },
    { tool: 'Edit', file: 'integrations.plist', added: 1, removed: 0 },
    { tool: 'Bash' },
  ]
  assert.equal(C.stepsSummary(steps), 'Read and edited integrations.plist, ran a command')
  assert.deepEqual(C.linesChanged(steps), { added: 1, removed: 0 })
  // more than one file: counted, as before
  assert.equal(C.stepsSummary([{ tool: 'Read', file: 'a.js' }, { tool: 'Read', file: 'b.js' }]), 'Read 2 files')
  assert.equal(C.stepsSummary([{ tool: 'Edit', file: 'a.js' }, { tool: 'Edit', file: 'a.js' }, { tool: 'Write', file: 'a.js' }]), 'Edited and wrote a.js')
  assert.deepEqual(C.linesChanged([{ tool: 'Edit', added: 3, removed: 1 }, { tool: 'Write', added: 10, removed: 0 }]), { added: 13, removed: 1 })
  assert.equal(C.linesChanged([{ tool: 'Bash' }, { tool: 'Read', file: 'a' }]), null)
})

test('the file of a step opens in the editor picked, and only with the setting on', () => {
  const both = [{ id: 'intellij', name: 'IntelliJ IDEA' }, { id: 'vscode', name: 'VS Code' }]
  assert.equal(L.normalizeSettings({}).editor, 'off')
  assert.equal(L.normalizeSettings({ editor: 'vim' }).editor, 'off')
  assert.equal(L.editorChoice('off', both), null)
  assert.deepEqual(L.editorChoice('intellij', both), { id: 'intellij', name: 'IntelliJ IDEA' })
  assert.deepEqual(L.editorChoice('auto', both), { id: 'auto', name: 'your editor' })
  assert.deepEqual(L.editorChoice('auto', [both[0]]), { id: 'auto', name: 'IntelliJ IDEA' })
  // one this Mac lacks goes to the one it has
  assert.deepEqual(L.editorChoice('vscode', [both[0]]), { id: 'auto', name: 'IntelliJ IDEA' })
  assert.equal(L.editorChoice('auto', []), null)
})

test('a new card goes to the very bottom of the board, under the half that ends lowest', () => {
  assert.deepEqual(lowestSpot([]), { x: 0, y: 0, w: 6, h: 32 })
  // the left half ends at 64, the right at 32: under the right one it would rise, so it goes under the left
  const nodes = [{ x: 0, y: 0, w: 6, h: 32 }, { x: 6, y: 0, w: 6, h: 32 }, { x: 0, y: 32, w: 6, h: 32 }]
  assert.deepEqual(lowestSpot(nodes), { x: 0, y: 64, w: 6, h: 32 })
  assert.deepEqual(lowestSpot([{ x: 6, y: 0, w: 6, h: 90 }]), { x: 6, y: 90, w: 6, h: 32 })
  // a card as wide as the board ends both halves
  assert.deepEqual(lowestSpot([{ x: 0, y: 0, w: 12, h: 40 }]), { x: 0, y: 40, w: 6, h: 32 })
})

test("caveman mode: a session's own level wins over the default, and unknown levels count as none", () => {
  const choices = { default: 'full', sessions: { a: 'off', b: 'ultra', c: 'loud' } }
  assert.deepEqual(C.cavemanOf(choices, 'a'), { level: 'off', isOwn: true })
  assert.deepEqual(C.cavemanOf(choices, 'b'), { level: 'ultra', isOwn: true })
  assert.deepEqual(C.cavemanOf(choices, 'c'), { level: 'full', isOwn: false })
  assert.deepEqual(C.cavemanOf(undefined, 'a'), { level: 'off', isOwn: false })
})

test('caveman mode: the rock button switches off when on, else back to the level last used', () => {
  assert.equal(C.cavemanToggled('lite', 'ultra'), 'off')
  assert.equal(C.cavemanToggled('off', 'ultra'), 'ultra')
  assert.equal(C.cavemanToggled('off', ''), 'full')
  assert.equal(C.cavemanToggled('off', 'off'), 'full')
})

test("Claude's notes between steps show unless the person hides them, and hidden they let steps group together", () => {
  const items = [{ kind: 'tool', text: 'a', at: 1 }, { kind: 'claude', text: 'note', at: 2, note: true }, { kind: 'tool', text: 'b', at: 3 }, { kind: 'claude', text: 'reply', at: 4 }]
  assert.equal(C.shownItems(items, true).length, 4)
  assert.deepEqual(C.shownItems(items, false).map(item => item.text), ['a', 'b', 'reply'])
  assert.equal(C.groupSteps(C.shownItems(items, false)).length, 2)
  assert.equal(L.normalizeSettings({}).showNotes, true)
  assert.equal(L.normalizeSettings({ showNotes: false }).showNotes, false)
})

test('radar: a session keeps its place round the radar, and a new one goes into the widest gap', () => {
  const first = L.radarAngles(new Map(), ['a'])
  assert.equal(first.get('a'), 0)
  const two = L.radarAngles(first, ['a', 'b'])
  assert.deepEqual([...two], [['a', 0], ['b', 180]])
  const three = L.radarAngles(two, ['a', 'b', 'c'])
  assert.equal(three.get('a'), 0)
  assert.equal(three.get('b'), 180)
  assert.equal(three.get('c'), 270)
  // one leaves: the others stay put, and the next one fills the gap it left
  const after = L.radarAngles(three, ['a', 'c', 'd'])
  assert.deepEqual([after.get('a'), after.get('c')], [0, 270])
  assert.equal(after.get('d'), 135)
})

test("radar: its title counts the sessions waiting for the person", () => {
  assert.equal(L.waitingCount(['working', 'done']), '')
  assert.equal(L.waitingCount(['needs-you', 'done']), '1 needs you')
  assert.equal(L.waitingCount(['needs-you', 'needs-you', 'working']), '2 need you')
})

test("a terminal card reads the shell's folder from its window title, with ~ as the person's home", () => {
  assert.equal(L.titleFolder('me@mac:~/code/blog', '/Users/me'), '/Users/me/code/blog')
  assert.equal(L.titleFolder('~/code', '/Users/me/x'), '/Users/me/code')
  assert.equal(L.titleFolder('me@mac:~', '/Users/me'), '/Users/me')
  assert.equal(L.titleFolder('me@mac:/tmp/a b/', '/Users/me'), '/tmp/a b')
  assert.equal(L.titleFolder('/', '/Users/me'), '/')
  // a running command, or no title: the server's word stands
  assert.equal(L.titleFolder('npm run dev', '/Users/me'), undefined)
  assert.equal(L.titleFolder('', '/Users/me'), undefined)
  // ~ cannot be told without a known home
  assert.equal(L.titleFolder('~/code', '/opt/x'), undefined)
})
