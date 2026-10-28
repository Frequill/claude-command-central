import { describe, expect, test } from 'claude-code/testing'

import { createPublisher } from '../hooks/publish'
import type { PublishIo, SessionParts } from '../hooks/publish'
import {
  HEARTBEAT_MS,
  branchFromHead,
  folderName,
  gitDirFromFile,
  isSafeSessionId,
  isWriteDue,
  parentFrom,
  snapshotBody,
  stamp,
  topicOf,
} from '../hooks/snapshot'

const PARTS: SessionParts = {
  turn: { isRunning: true, startedAt: 1, topic: 'Build the board' },
  plan: [{ text: 'Read', status: 'in_progress' }],
  runs: [],
  log: [],
  context: { percent: 12, tokens: 120, window: 1000 },
  stats: { model: 'claude-opus-5-5', costHistory: [0.5], costUsd: 0.5, limits: [] },
  tools: { Bash: 2, Read: 1 },
  today: { day: '2026-10-19', usd: 0.5 },
  chat: [{ at: 1, prompt: 'hi', answer: 'hi there', endedAt: 2 }],
  reply: { text: 'hi there', at: 2, isWriting: false },
}

function fakeIo(start = 0) {
  let clock = start
  let parts = PARTS
  const writes: { path: string; text: string }[] = []
  const io: PublishIo = {
    path: '/h/.claude/ccc/sessions/s1.json',
    sessionId: 's1',
    startedAt: 1,
    now: async () => clock,
    write: async (path, text) => void writes.push({ path, text }),
    parts: async () => parts,
    locate: async () => ({ folder: 'shop', branch: 'ABC-1-x' }),
  }
  return {
    io,
    writes,
    tick: (ms: number) => void (clock += ms),
    change: (next: SessionParts) => void (parts = next),
  }
}

describe('snapshot file', () => {
  test('the stamped body is valid JSON with the write time last', async () => {
    const body = snapshotBody({ sessionId: 's1', startedAt: 1, where: { folder: 'shop' }, ...PARTS })
    const file = JSON.parse(stamp(body, 42, 50))
    expect(file).toMatchObject({ version: 1, sessionId: 's1', folder: 'shop', updatedAt: 42, endedAt: 50 })
    expect('branch' in file).toBe(false)
    expect(file.tools).toEqual({ Bash: 2, Read: 1 })
    expect(file.reply).toEqual({ text: 'hi there', at: 2, isWriting: false })
    expect(file.takesMessages).toBe(true)
    expect(file).toMatchObject({ startedAt: 1, today: { day: '2026-10-19', usd: 0.5 } })
  })

  test('only the latest 30 log lines go into the file', async () => {
    const log = Array.from({ length: 45 }, (_, i) => ({
      id: String(i),
      at: i,
      text: 'x',
      status: 'ok' as const,
    }))
    const body = JSON.parse(snapshotBody({ sessionId: 's', startedAt: 1, where: { folder: 'f' }, ...PARTS, log }))
    expect(body.log).toHaveLength(30)
    expect(body.log[0].id).toBe('15')
  })

  test('a write is due on change or heartbeat, not otherwise', async () => {
    expect(isWriteDue('a', undefined, 0)).toBe(true)
    expect(isWriteDue('a', { body: 'a', at: 0 }, 1000)).toBe(false)
    expect(isWriteDue('b', { body: 'a', at: 0 }, 1000)).toBe(true)
    expect(isWriteDue('a', { body: 'a', at: 0 }, HEARTBEAT_MS)).toBe(true)
  })

  test('a chat that is only opened, never written in, stays off the board', async () => {
    const fake = fakeIo()
    fake.change({ ...PARTS, turn: { isRunning: false } })
    const publisher = await createPublisher(fake.io)
    await publisher.publish()
    fake.tick(HEARTBEAT_MS)
    await publisher.publish()
    await publisher.publish(5)
    expect(fake.writes).toHaveLength(0)

    fake.change({ ...PARTS, turn: { isRunning: true, startedAt: 7 } })
    await publisher.publish()
    expect(fake.writes).toHaveLength(1)
  })

  test('the publisher writes once, then only on change or heartbeat', async () => {
    const fake = fakeIo()
    const publisher = await createPublisher(fake.io)
    await publisher.publish()
    await publisher.publish()
    expect(fake.writes).toHaveLength(1)
    expect(JSON.parse(fake.writes[0]?.text ?? '{}')).toMatchObject({ folder: 'shop', branch: 'ABC-1-x' })

    fake.change({ ...PARTS, turn: { isRunning: false, startedAt: 1, endedAt: 2 } })
    await publisher.publish()
    expect(fake.writes).toHaveLength(2)

    fake.tick(HEARTBEAT_MS)
    await publisher.publish()
    expect(fake.writes).toHaveLength(3)
  })

  test('ending always writes, with the end time', async () => {
    const fake = fakeIo(5)
    const publisher = await createPublisher(fake.io)
    await publisher.publish()
    await publisher.publish(7)
    expect(JSON.parse(fake.writes[1]?.text ?? '{}').endedAt).toBe(7)
  })
})

describe('where a session works', () => {
  test('a branch is read from HEAD; a detached head names none', async () => {
    expect(branchFromHead('ref: refs/heads/ABC-12-ccc\n')).toBe('ABC-12-ccc')
    expect(branchFromHead('3f2a9c0d1e\n')).toBeUndefined()
  })

  test('a worktree points at its git dir', async () => {
    expect(gitDirFromFile('gitdir: /r/.git/worktrees/x\n')).toBe('/r/.git/worktrees/x')
    expect(gitDirFromFile('nonsense')).toBeUndefined()
  })

  test('the folder is the last part of the path', async () => {
    expect(folderName('/Users/a/Documents/Projects/')).toBe('Projects')
  })

  test('the topic is the prompt on one line, clipped', async () => {
    expect(topicOf('  hi\n\nwörld ')).toBe('hi wörld')
    expect(topicOf('x'.repeat(300))).toHaveLength(120)
    expect(topicOf('<command-message>caveman</command-message>\n<command-name>/caveman</command-name>\n<command-args>ultra</command-args>')).toBe('/caveman ultra')
    expect(topicOf('<command-name>/clear</command-name>')).toBe('/clear')
  })

  test('a session started from another session names it; any other session names none', async () => {
    expect(parentFrom('1', '940781d6-854f-4888-b3f1-7e0c17d37de4', 's2')).toBe('940781d6-854f-4888-b3f1-7e0c17d37de4')
    expect(parentFrom(undefined, '940781d6-854f-4888-b3f1-7e0c17d37de4', 's2')).toBeUndefined()
    expect(parentFrom('1', 's2', 's2')).toBeUndefined()
    expect(parentFrom('1', '../etc', 's2')).toBeUndefined()
    expect(parentFrom('1', undefined, 's2')).toBeUndefined()
  })

  test('the parent goes into the snapshot only when there is one', async () => {
    const where = { folder: 'shop' }
    const child = JSON.parse(snapshotBody({ sessionId: 's2', parentSessionId: 's1', startedAt: 1, where, ...PARTS }))
    expect(child.parentSessionId).toBe('s1')
    const plain = JSON.parse(snapshotBody({ sessionId: 's2', startedAt: 1, where, ...PARTS }))
    expect('parentSessionId' in plain).toBe(false)
  })

  test('only plain session ids become file names', async () => {
    expect(isSafeSessionId('940781d6-854f-4888-b3f1-7e0c17d37de4')).toBe(true)
    expect(isSafeSessionId('../../etc/passwd')).toBe(false)
    expect(isSafeSessionId('')).toBe(false)
  })
})
