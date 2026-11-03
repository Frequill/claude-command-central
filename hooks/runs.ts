import type { EngineInterface } from 'claude-code'

import { isSafeSessionId } from './snapshot'

/**
 * A command the person ran from a code block in CCC's chat (its Run button), as the board's server
 * keeps it (serve.py CommandRuns): in a terminal of its own, in the session's folder, with the last
 * lines it printed and how it ended. No `endedAt` while it still runs; no `exitCode` when its
 * terminal was closed before it ended.
 */
export type CommandRun = { id: string; command: string; folder: string; startedAt: number; endedAt?: number; exitCode?: number; output: string }

/** What Claude was told of a run: that it ran, or also how it ended. */
export type Told = { ended: boolean }

/** What the runs need from the session, so a test can stand in for it. */
export type RunsIo = {
  dir: string
  exists: (path: string) => Promise<boolean>
  list: (dir: string) => Promise<readonly { name: string; kind: string }[]>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  now: () => Promise<number>
}

const RUN_ID = /^r[0-9a-f]{12}$/
// what Claude is told of a run's output: its last lines, as the chat shows them
const NOTE_OUTPUT_MAX = 8_000
const NOTE_LINES_MAX = 120

/** A stored run, or undefined when the file is not one. */
export function readRun(text: string): CommandRun | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!data || typeof data !== 'object') return undefined
  const { id, command, folder, startedAt, endedAt, exitCode, output } = data as Record<string, unknown>
  if (typeof id !== 'string' || !RUN_ID.test(id) || typeof command !== 'string' || !command.trim() || typeof startedAt !== 'number') return undefined
  return {
    id,
    command,
    folder: typeof folder === 'string' ? folder : '',
    startedAt,
    ...(typeof endedAt === 'number' ? { endedAt } : {}),
    ...(Number.isInteger(exitCode) ? { exitCode: exitCode as number } : {}),
    output: typeof output === 'string' ? output : '',
  }
}

/** What a `.told` file says; an old or broken one counts as told that the run ended. */
export function readTold(text: string): Told {
  try {
    return { ended: (JSON.parse(text) as { ended?: unknown }).ended !== false }
  } catch {
    return { ended: true }
  }
}

/**
 * The runs Claude has not heard of as they stand now, oldest first: new ones, and ones told of while
 * they ran that have ended since. One still running that Claude knows of is not told again.
 */
export function untold(runs: readonly CommandRun[], told: ReadonlyMap<string, Told>): CommandRun[] {
  return runs.filter(run => {
    const known = told.get(run.id)
    return !known || (!known.ended && run.endedAt !== undefined)
  })
}

/** The note beside the next prompt that tells Claude what the person ran, or undefined for none. */
export function runsNote(runs: readonly CommandRun[]): string | undefined {
  if (runs.length === 0) return undefined
  const parts = [...runs]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(run => {
      const where = run.folder ? `In ${run.folder}, it` : 'It'
      const how =
        run.endedAt === undefined
          ? 'is still running. What it printed so far:'
          : run.exitCode === undefined
            ? 'was closed before it ended. What it printed:'
            : `exited with code ${run.exitCode}. The last lines it printed:`
      const output = lastLines(run.output)
      return `$ ${run.command}\n${where} ${how}\n${output ? fenced(output) : '(nothing)'}`
    })
  return [
    "The person ran these commands from CCC's chat, with Run on a code block of yours, each in a terminal of its own in this session's folder. Oldest first:",
    ...parts,
  ].join('\n\n')
}

function lastLines(output: string): string {
  return output.split('\n').slice(-NOTE_LINES_MAX).join('\n').slice(-NOTE_OUTPUT_MAX).trimEnd()
}

/** The output in a fence longer than any run of backticks inside it. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(ticks => ticks.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${text}\n${fence}`
}

/**
 * The note on what the person ran since Claude last heard, marking each run told (and whether it had
 * ended by then), or undefined when there is nothing new.
 */
export async function takeRunsNote(io: RunsIo): Promise<string | undefined> {
  // most sessions never run anything from CCC: look before listing
  if (!(await io.exists(io.dir))) return undefined
  const entries = (await io.list(io.dir)).filter(entry => entry.kind === 'file')
  const runs: CommandRun[] = []
  const told = new Map<string, Told>()
  for (const { name } of entries) {
    const id = name.replace(/\.(json|told)$/, '')
    if (!RUN_ID.test(id)) continue
    const text = await io.read(`${io.dir}/${name}`).catch(() => '')
    if (name.endsWith('.told')) told.set(id, readTold(text))
    else if (name.endsWith('.json')) {
      const run = readRun(text)
      if (run && run.id === id) runs.push(run)
    }
  }
  const fresh = untold(runs, told)
  if (fresh.length === 0) return undefined
  const at = await io.now()
  for (const run of fresh) await io.write(`${io.dir}/${run.id}.told`, JSON.stringify({ at, ended: run.endedAt !== undefined }))
  return runsNote(fresh)
}

/** This session's runs from CCC, or undefined where none can be read. */
export async function runsFor($: EngineInterface): Promise<RunsIo | undefined> {
  const home = await $.env.get('HOME')
  const sessionId = await $.session.id()
  if (!home || !isSafeSessionId(sessionId)) return undefined
  return {
    dir: `${home}/.claude/ccc/runs/${sessionId}`,
    exists: path => $.fs.exists(path),
    list: dir => $.fs.list(dir),
    read: async path => {
      const text = await $.fs.read(path)
      return typeof text === 'string' ? text : ''
    },
    write: (path, text) => $.fs.write(path, text),
    now: () => $.clock.now(),
  }
}
