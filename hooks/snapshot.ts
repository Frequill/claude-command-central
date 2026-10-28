import type {
  AgentRun,
  ContextFill,
  LogEntry,
  PlanStep,
  ChatTurn,
  LiveReply,
  SessionStats,
  ToolCounts,
  TurnState,
} from '../types'

/** Bumped when the board would misread an older shape. */
export const SNAPSHOT_VERSION = 1
export const HEARTBEAT_MS = 10_000
const LOG_IN_SNAPSHOT = 30
const TOPIC_MAX = 120

export type Where = { folder: string; branch?: string }

export type TodaySpend = { day: string; usd: number }

export type Snapshot = {
  version: number
  sessionId: string
  startedAt: number
  updatedAt: number
  endedAt?: number
  folder: string
  branch?: string
  turn: TurnState
  plan: readonly PlanStep[]
  runs: readonly AgentRun[]
  log: readonly LogEntry[]
  context: ContextFill | null
  stats: SessionStats
  tools: ToolCounts
  today: TodaySpend | null
  chat: readonly ChatTurn[]
  reply: LiveReply | null
}

export type SnapshotParts = {
  sessionId: string
  /** The session that started this one from its shell (Claude running `claude` itself). */
  parentSessionId?: string
  startedAt: number
  where: Where
  turn: TurnState
  plan: readonly PlanStep[]
  runs: readonly AgentRun[]
  log: readonly LogEntry[]
  context: ContextFill | null
  stats: SessionStats
  tools: ToolCounts
  today: TodaySpend | null
  chat: readonly ChatTurn[]
  reply: LiveReply | null
}

/** The session as the board reads it: everything but the time it was written. */
export function snapshotBody(parts: SnapshotParts): string {
  const { sessionId, parentSessionId, startedAt, where, turn, plan, runs, log, context, stats, tools, today, chat, reply } = parts
  return JSON.stringify({
    version: SNAPSHOT_VERSION,
    sessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
    // this mod takes messages written in CCC's chat window (hooks/inbox.ts)
    takesMessages: true,
    startedAt,
    folder: where.folder,
    ...(where.branch ? { branch: where.branch } : {}),
    turn,
    plan,
    runs,
    log: log.slice(-LOG_IN_SNAPSHOT),
    context,
    stats,
    tools,
    today,
    chat,
    reply,
  })
}

/** The file's text: the body stamped with when it was written (and ended). */
export function stamp(body: string, now: number, endedAt?: number): string {
  const ended = endedAt === undefined ? '' : `,"endedAt":${endedAt}`
  return `${body.slice(0, -1)},"updatedAt":${now}${ended}}`
}

/** Writes when something changed, and now and then anyway so the board sees it is alive. */
export function isWriteDue(body: string, last: { body: string; at: number } | undefined, now: number) {
  return last === undefined || last.body !== body || now - last.at >= HEARTBEAT_MS
}

/** The branch a `.git/HEAD` names, or undefined for a detached head or anything else. */
export function branchFromHead(head: string): string | undefined {
  return /^ref: refs\/heads\/(.+)$/.exec(head.trim())?.[1]
}

/** The git dir a worktree's `.git` file points at, or undefined. */
export function gitDirFromFile(text: string): string | undefined {
  return /^gitdir: (.+)$/.exec(text.trim())?.[1]
}

export function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function topicOf(prompt: string): string {
  const flat = (commandLine(prompt) ?? prompt).replace(/\s+/g, ' ').trim()
  return flat.length <= TOPIC_MAX ? flat : flat.slice(0, TOPIC_MAX - 1) + '…'
}

/**
 * A slash command or skill the person ran, as they typed it ("/caveman ultra"), the way the Claude
 * app shows it; undefined when the prompt is no such command.
 */
export function commandLine(prompt: string): string | undefined {
  const name = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/.exec(prompt)?.[1]
  if (!name) return undefined
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(prompt)?.[1]?.trim() ?? ''
  const command = name.startsWith('/') ? name : `/${name}`
  return args ? `${command} ${args}` : command
}

/** Only names the engine gives us go into the file name. */
/**
 * The session that started this one, from what Claude Code hands the commands it runs: a child
 * mark and its own session id. A session started any other way has none.
 */
export function parentFrom(childMark: string | undefined, parentId: string | undefined, ownId: string): string | undefined {
  if (childMark !== '1' || !parentId || parentId === ownId || !isSafeSessionId(parentId)) return undefined
  return parentId
}

export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}
