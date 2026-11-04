import type { EngineInterface, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { inboxFor } from '../hooks/inbox'
import { readRun, readTold, runsNote, takeRunsNote, tellRuns, untold } from '../hooks/runs'
import type { CommandRun, RunsIo } from '../hooks/runs'

const run = (fields: Partial<CommandRun> = {}): CommandRun => ({ id: 'r000000000001', command: 'npm test', folder: '/p', startedAt: 1, typedAt: 1, output: '', ...fields })

function fakeRuns(files: Record<string, string>, isThere = true) {
  const written: Record<string, string> = {}
  const io: RunsIo = {
    dir: '/h/.claude/ccc/runs/s1',
    exists: async () => isThere,
    list: async () => Object.keys(files).map(name => ({ name, kind: 'file' })),
    read: async path => {
      const name = path.split('/').pop() as string
      if (!(name in files)) throw new Error('missing')
      return files[name] as string
    },
    write: async (path, text) => {
      const name = path.split('/').pop() as string
      written[name] = text
      files[name] = text
    },
    now: async () => 42,
  }
  return { io, written }
}

describe('commands run from the chat', () => {
  test('a stored run is read as the server writes it', () => {
    const text = JSON.stringify({ id: 'r000000000001', command: 'ls', folder: '/p', terminalId: 't1', shell: 'zsh', startedAt: 1, typedAt: 2, from: 40, endedAt: null, exitCode: null, output: 'a' })
    expect(readRun(text)).toEqual({ id: 'r000000000001', command: 'ls', folder: '/p', startedAt: 1, typedAt: 2, output: 'a' })
    expect(readRun(JSON.stringify({ id: 'r000000000001', command: 'ls', startedAt: 1, endedAt: 5, exitCode: 0 }))?.exitCode).toBe(0)
    expect(readRun('{')).toBeUndefined()
    expect(readRun(JSON.stringify({ id: '../x', command: 'ls', startedAt: 1 }))).toBeUndefined()
    expect(readRun(JSON.stringify({ id: 'r000000000001', command: ' ', startedAt: 1 }))).toBeUndefined()
  })

  test('a run Claude knows runs is told again once it ended, and never twice after that', () => {
    const going = run()
    const ended = run({ endedAt: 5, exitCode: 0 })
    expect(untold([going], new Map())).toEqual([going])
    expect(untold([going], new Map([[going.id, { ended: false }]]))).toEqual([])
    expect(untold([ended], new Map([[ended.id, { ended: false }]]))).toEqual([ended])
    expect(untold([ended], new Map([[ended.id, { ended: true }]]))).toEqual([])
    expect(readTold('not json')).toEqual({ ended: true })
  })

  test('the note says how each ended, with its last lines, oldest first', () => {
    const note = runsNote([
      run({ id: 'r000000000002', command: 'npm run dev', startedAt: 9, output: 'ready on :3000' }),
      run({ startedAt: 2, endedAt: 5, exitCode: 1, output: 'FAIL src/a.test.ts\n```oops```' }),
      run({ id: 'r000000000003', command: 'sleep 9', startedAt: 10, endedAt: 11 }),
      run({ id: 'r000000000004', command: 'ls', startedAt: 12, typedAt: undefined }),
    ]) as string
    expect(note).toContain("from CCC's chat, with Run on a code block")
    expect(note.indexOf('$ npm test')).toBeLessThan(note.indexOf('$ npm run dev'))
    expect(note).toContain('$ npm test\nIn /p, it exited with code 1. The last lines it printed:\n````text\nFAIL src/a.test.ts\n```oops```\n````')
    expect(note).toContain('$ npm run dev\nIn /p, it is still running. What it printed so far:\n```text\nready on :3000\n```')
    expect(note).toContain('$ sleep 9\nIn /p, it was closed before it ended. What it printed:\n(nothing)')
    expect(note).toContain('$ ls\nIt waits for the one before it to end, and has not run yet.')
    expect(runsNote([])).toBeUndefined()
  })

  test('the note keeps only the last lines of a long output', () => {
    const output = Array.from({ length: 500 }, (_, n) => `line ${n}`).join('\n')
    const note = runsNote([run({ endedAt: 5, exitCode: 0, output })]) as string
    expect(note).toContain('line 499')
    expect(note).not.toContain('line 379\n')
  })

  test('each run is told once, and marked with whether it had ended by then', async () => {
    const files: Record<string, string> = {
      'r000000000001.json': JSON.stringify(run({ endedAt: 5, exitCode: 0 })),
      'r000000000002.json': JSON.stringify(run({ id: 'r000000000002', command: 'npm run dev', startedAt: 3 })),
      'r000000000003.json': JSON.stringify(run({ id: 'r000000000003', command: 'ls', startedAt: 4, endedAt: 6, exitCode: 0 })),
      'r000000000003.told': JSON.stringify({ at: 7, ended: true }),
      'notes.txt': 'x',
    }
    const { io, written } = fakeRuns(files)
    const note = await takeRunsNote(io)
    expect(note).toContain('$ npm test')
    expect(note).toContain('$ npm run dev')
    expect(note).not.toContain('$ ls')
    expect(JSON.parse(written['r000000000001.told'] as string)).toEqual({ at: 42, ended: true })
    expect(JSON.parse(written['r000000000002.told'] as string)).toEqual({ at: 42, ended: false })
    expect(await takeRunsNote(io)).toBeUndefined()
  })

  test('a session that never ran anything from CCC has no note', async () => {
    expect(await takeRunsNote(fakeRuns({}, false).io)).toBeUndefined()
  })
})

const RUNS_DIR = '/h/.claude/ccc/runs/s1'

/** A session `s1` under HOME `/h` with one run that failed, its files kept in memory. */
function oneFailedRun(on: On) {
  mock.clock(on, { now: 42 })
  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: 's1' }))
  const files = new Map([[`${RUNS_DIR}/r000000000001.json`, JSON.stringify(run({ endedAt: 5, exitCode: 1, output: 'FAIL' }))]])
  on('fs.exists', (_, e) => ({ value: e.path === RUNS_DIR || files.has(e.path) }))
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(path => path.startsWith(`${e.path}/`)).map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_, e) => {
    if (!files.has(e.path)) throw new Error('missing')
    return { value: files.get(e.path) as string }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  return files
}

test('the next prompt typed in the app or a terminal carries what the person ran, once', async ($, on) => {
  const files = oneFailedRun(on)
  const entered: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    entered.push(e.context)
    return { text: e.text }
  })

  await $.prompt.submit({ text: 'why did it fail?', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'and now?', wait: false, origin: { kind: 'composer' } })

  expect(entered[0]?.join('\n')).toContain('$ npm test\nIn /p, it exited with code 1.')
  expect(entered[1]?.join('\n') ?? '').not.toContain('$ npm test')
  expect(JSON.parse(files.get(`${RUNS_DIR}/r000000000001.told`) as string)).toEqual({ at: 42, ended: true })
})

/** As much of a session's `$` as the runs and the inbox use: `s1` under HOME `/h`, its files in memory, what it did in order. */
function fakeSession(files: Map<string, string>) {
  const did: string[] = []
  const $ = {
    env: { get: async (name: string) => (name === 'HOME' ? '/h' : undefined) },
    session: {
      id: async () => 's1',
      append: async (args: { message: { type: string; content: { text: string }[] } }) => void did.push(`${args.message.type} row: ${args.message.content.map(block => block.text).join('')}`),
    },
    fs: {
      exists: async (path: string) => files.has(path) || [...files.keys()].some(name => name.startsWith(`${path}/`)),
      list: async (dir: string) => [...files.keys()].filter(path => path.startsWith(`${dir}/`)).map(path => ({ name: path.slice(dir.length + 1), kind: 'file' })),
      read: async (path: string) => files.get(path) ?? '',
      write: async (path: string, text: string) => void files.set(path, text),
    },
    clock: { now: async () => 42 },
    command: { list: async () => [] },
    prompt: { submit: async ({ text }: { text: string }) => void did.push(`prompt: ${text}`) },
  } as unknown as EngineInterface
  return { $, did }
}

describe("a message from CCC's chat", () => {
  test('Claude hears what the person ran in a row of its own, once', async () => {
    const { $, did } = fakeSession(new Map([[`${RUNS_DIR}/r000000000001.json`, JSON.stringify(run({ endedAt: 5, exitCode: 1, output: 'FAIL' }))]]))
    await tellRuns($)
    await tellRuns($)
    expect(did).toHaveLength(1)
    expect(did[0]).toMatch(/^user row: The person ran these commands[\s\S]*\$ npm test/)
  })

  test('the note goes in just before the message', async () => {
    const files = new Map([
      [`${RUNS_DIR}/r000000000001.json`, JSON.stringify(run({ endedAt: 5, exitCode: 1, output: 'FAIL' }))],
      ['/h/.claude/ccc/inbox/s1/1000-aa.json', JSON.stringify({ text: 'why did it fail?', images: [], mode: 'queue' })],
    ])
    const { $, did } = fakeSession(files)
    const inbox = await inboxFor($, async () => undefined, undefined, undefined, undefined, undefined, () => tellRuns($))
    await inbox?.check()
    // the inbox hands a message over without waiting for it
    for (let step = 0; step < 100; step++) await Promise.resolve()
    expect(did.map(line => line.split(':')[0])).toEqual(['user row', 'prompt'])
    expect(did[1]).toBe('prompt: why did it fail?')
  })
})
