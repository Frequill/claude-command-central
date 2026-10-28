import type { EngineInterface } from 'claude-code'

import {
  branchFromHead,
  folderName,
  gitDirFromFile,
  isSafeSessionId,
  isWriteDue,
  parentFrom,
  snapshotBody,
  stamp,
} from './snapshot'
import type { SnapshotParts, Where } from './snapshot'

/** The session's own state, as the hooks module reads it. */
export type SessionParts = Omit<SnapshotParts, 'sessionId' | 'parentSessionId' | 'startedAt' | 'where'>

/** What the publisher needs from the session, so a test can stand in for it. */
export type PublishIo = {
  path: string
  sessionId: string
  parentSessionId?: string
  startedAt: number
  now: () => Promise<number>
  write: (path: string, text: string) => Promise<void>
  parts: () => Promise<SessionParts>
  locate: () => Promise<Where>
}

export type Publisher = {
  /** Writes the snapshot when it changed or the heartbeat is due; always when ending. Nothing before the first prompt. */
  publish: (endedAt?: number) => Promise<void>
  /** Reads the folder and branch again (the branch can change under a session). */
  relocate: () => Promise<void>
}

/** A session shows on the board once the person has written in it; opening an old chat is not enough. */
export function isOnBoard(parts: SessionParts): boolean {
  return parts.turn.startedAt !== undefined
}

export async function createPublisher(io: PublishIo): Promise<Publisher> {
  let where = await io.locate()
  let last: { body: string; at: number } | undefined

  return {
    async publish(endedAt) {
      const parts = await io.parts()
      if (!isOnBoard(parts)) return
      const body = snapshotBody({ sessionId: io.sessionId, parentSessionId: io.parentSessionId, startedAt: io.startedAt, where, ...parts })
      const now = await io.now()
      if (endedAt === undefined && !isWriteDue(body, last, now)) return
      await io.write(io.path, stamp(body, now, endedAt))
      last = { body, at: now }
    },
    async relocate() {
      where = await io.locate()
    },
  }
}

/** The publisher for this session, or undefined where no snapshot can be written. */
export async function publisherFor(
  $: EngineInterface,
  parts: () => Promise<SessionParts>,
): Promise<Publisher | undefined> {
  const home = await $.env.get('HOME')
  const sessionId = await $.session.id()
  if (!home || !isSafeSessionId(sessionId)) return undefined

  const parentSessionId = parentFrom(await $.env.get('CLAUDE_CODE_CHILD_SESSION'), await $.env.get('CLAUDE_CODE_SESSION_ID'), sessionId)
  return createPublisher({
    path: `${home}/.claude/ccc/sessions/${sessionId}.json`,
    sessionId,
    parentSessionId,
    startedAt: (await $.session.usage()).startedAt,
    now: () => $.clock.now(),
    write: (path, text) => $.fs.write(path, text),
    parts,
    locate: () => locate($),
  })
}

async function locate($: EngineInterface): Promise<Where> {
  const repo = await $.session.repo()
  if (!repo) return { folder: folderName(await $.session.cwd()) }
  const branch = await readBranch($, repo.root)
  return { folder: folderName(repo.root), ...(branch ? { branch } : {}) }
}

async function readBranch($: EngineInterface, root: string): Promise<string | undefined> {
  const head = await readText($, `${root}/.git/HEAD`)
  if (head !== undefined) return branchFromHead(head)
  const pointer = await readText($, `${root}/.git`)
  const gitDir = pointer === undefined ? undefined : gitDirFromFile(pointer)
  if (gitDir === undefined) return undefined
  const absolute = gitDir.startsWith('/') ? gitDir : `${root}/${gitDir}`
  const worktreeHead = await readText($, `${absolute}/HEAD`)
  return worktreeHead === undefined ? undefined : branchFromHead(worktreeHead)
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}
