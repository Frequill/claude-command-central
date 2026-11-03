import { describe, expect, mock, test } from 'claude-code/testing'

import { readRun, readTold, runsNote, takeRunsNote, untold } from '../hooks/runs'
import type { CommandRun, RunsIo } from '../hooks/runs'

const run = (fields: Partial<CommandRun> = {}): CommandRun => ({ id: 'r000000000001', command: 'npm test', folder: '/p', startedAt: 1, output: '', ...fields })

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
    const text = JSON.stringify({ id: 'r000000000001', command: 'ls', folder: '/p', terminalId: 't1', startedAt: 1, endedAt: null, exitCode: null, output: 'a' })
    expect(readRun(text)).toEqual({ id: 'r000000000001', command: 'ls', folder: '/p', startedAt: 1, output: 'a' })
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
    ]) as string
    expect(note).toContain("from CCC's chat, with Run on a code block")
    expect(note.indexOf('$ npm test')).toBeLessThan(note.indexOf('$ npm run dev'))
    expect(note).toContain('$ npm test\nIn /p, it exited with code 1. The last lines it printed:\n````text\nFAIL src/a.test.ts\n```oops```\n````')
    expect(note).toContain('$ npm run dev\nIn /p, it is still running. What it printed so far:\n```text\nready on :3000\n```')
    expect(note).toContain('$ sleep 9\nIn /p, it was closed before it ended. What it printed:\n(nothing)')
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

test('the next prompt carries what the person ran, once', async ($, on) => {
  mock.clock(on, { now: 42 })
  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: 's1' }))
  const dir = '/h/.claude/ccc/runs/s1'
  const files = new Map([[`${dir}/r000000000001.json`, JSON.stringify(run({ endedAt: 5, exitCode: 1, output: 'FAIL' }))]])
  on('fs.exists', (_, e) => ({ value: e.path === dir || files.has(e.path) }))
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(path => path.startsWith(`${e.path}/`)).map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_, e) => {
    if (!files.has(e.path)) throw new Error('missing')
    return { value: files.get(e.path) as string }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  const entered: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    entered.push(e.context)
    return { text: e.text }
  })

  await $.prompt.submit({ text: 'why did it fail?', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'and now?', wait: false, origin: { kind: 'composer' } })

  expect(entered[0]?.join('\n')).toContain('$ npm test\nIn /p, it exited with code 1.')
  expect(entered[1]?.join('\n') ?? '').not.toContain('$ npm test')
  expect(JSON.parse(files.get(`${dir}/r000000000001.told`) as string)).toEqual({ at: 42, ended: true })
})
