import type { EngineInterface } from 'claude-code'

import { runSlash } from './commands'
import { isSafeSessionId } from './snapshot'

/**
 * A message the person wrote in CCC's chat window, as the board's server stores it. `now` stops
 * Claude's running turn so it goes in at once; `queue` waits in the inbox until Claude is done, so
 * the board can show it there with Send now (which makes it `now`). Handed to the session while it
 * works, a prompt would wait in the session's own queue, which a stop empties: it would be lost.
 */
export type InboxMessage = { text: string; images: string[]; files?: string[]; mode: 'now' | 'queue'; isStop?: true; stopRun?: string; at?: number }

/** What the inbox needs from the session, so a test can stand in for it. */
export type InboxIo = {
  dir: string
  exists: (path: string) => Promise<boolean>
  list: (dir: string) => Promise<readonly { name: string; kind: string }[]>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  submit: (text: string) => Promise<void>
  /** Stops Claude's running turn, if one began before `at` (when the person asked). */
  interrupt: (at: number) => Promise<void>
  /** Stops one agent or background command, by its run's id (Stop on CCC's agent map). */
  stopRun?: (runId: string) => Promise<void>
  now: () => Promise<number>
  /** Whether Claude works on a turn now: a queued message waits until it is done. */
  isBusy?: () => Promise<boolean>
}

const MESSAGE_ID = /^[0-9]{1,16}-[0-9a-f]{1,32}$/
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The ids of messages that still wait: `<id>.json` with no `<id>.taken` beside it, oldest first. */
export function waiting(entries: readonly { name: string; kind: string }[]): string[] {
  const names = new Set(entries.filter(entry => entry.kind === 'file').map(entry => entry.name))
  return [...names]
    .filter(name => name.endsWith('.json') && !names.has(`${name.slice(0, -5)}.taken`))
    .map(name => name.slice(0, -5))
    .filter(id => MESSAGE_ID.test(id))
    .sort()
}

/** A stored message, or undefined when the file is not one. */
export function readMessage(text: string): InboxMessage | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!data || typeof data !== 'object') return undefined
  // the person pressed Stop: no words, only the running turn ends
  const asked = (data as { at?: unknown }).at
  const at = typeof asked === 'number' && Number.isFinite(asked) ? { at: asked } : {}
  if ((data as { stop?: unknown }).stop === true) return { text: '', images: [], mode: 'now', isStop: true, ...at }
  // Stop on the agent map: one agent or background command ends, and the turn goes on
  const run = (data as { stopRun?: unknown }).stopRun
  if (typeof run === 'string') return RUN_ID.test(run) ? { text: '', images: [], mode: 'now', stopRun: run, ...at } : undefined
  const { text: words, images, files, mode } = data as { text?: unknown; images?: unknown; files?: unknown; mode?: unknown }
  const paths = absolutePaths(images)
  const filePaths = absolutePaths(files)
  const body = typeof words === 'string' ? words.trim() : ''
  const others = filePaths.length > 0 ? { files: filePaths } : {}
  return body || paths.length > 0 || filePaths.length > 0 ? { text: body, images: paths, ...others, mode: mode === 'now' ? 'now' : 'queue', ...at } : undefined
}

function absolutePaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string' && path.startsWith('/')) : []
}

/** The prompt a message becomes: its words, then where its other files and its images are so Claude opens them. */
export function promptFor(message: InboxMessage): string {
  const list = (paths: readonly string[]) => paths.map(path => `- ${path}`).join('\n')
  const parts = [
    message.text,
    message.files?.length ? `Files I added (open them with the Read tool):\n${list(message.files)}` : '',
    message.images.length ? `Images I added (open them with the Read tool):\n${list(message.images)}` : '',
  ]
  return parts.filter(Boolean).join('\n\n')
}

export type Inbox = {
  /** Sends what waits into the session, each once and in order; how many it sent. */
  check: () => Promise<number>
}

export function createInbox(io: InboxIo): Inbox {
  const taken = new Set<string>()
  let isBusy = false
  return {
    async check() {
      if (isBusy) return 0
      isBusy = true
      try {
        let entries: readonly { name: string; kind: string }[]
        try {
          // most sessions never get a message: look before listing, so no failed listing is logged each second
          if (!(await io.exists(io.dir))) return 0
          entries = await io.list(io.dir)
        } catch {
          return 0
        }
        let sent = 0
        let isWorking = io.isBusy ? await io.isBusy().catch(() => false) : false
        for (const id of waiting(entries)) {
          if (taken.has(id)) continue
          let message: InboxMessage | undefined
          try {
            message = readMessage(await io.read(`${io.dir}/${id}.json`))
          } catch {
            message = undefined
          }
          // a queued message waits, untaken, while Claude works; one the person hurried is `now` by then
          if (message && !message.isStop && message.mode === 'queue' && isWorking) continue
          taken.add(id)
          // marked taken before it is sent: a message is never sent twice, even across a reload
          await io.write(`${io.dir}/${id}.taken`, String(await io.now()))
          if (!message) continue
          if (message.stopRun) {
            await io.stopRun?.(message.stopRun).catch(() => undefined)
            continue
          }
          // a stop, or a message to go in at once, ends the turn that ran when the person asked
          const asked = message.at ?? (await io.now())
          if (message.isStop) {
            await io.interrupt(asked).catch(() => undefined)
            continue
          }
          if (message.mode === 'now') await io.interrupt(asked).catch(() => undefined)
          // handed over without waiting: a prompt resolves only once it has gone in. The turn it starts
          // makes Claude busy, so whatever is queued after it waits in the inbox for that turn to end
          io.submit(promptFor(message)).catch(() => undefined)
          sent += 1
          // where the inbox can tell when Claude works, the turn this prompt starts holds the next
          if (io.isBusy) isWorking = true
        }
        return sent
      } finally {
        isBusy = false
      }
    },
  }
}

/**
 * This session's inbox, or undefined where none can be read. `dress` turns a message that is not a
 * slash command into what goes in (caveman mode sends it through its skill).
 */
export async function inboxFor(
  $: EngineInterface,
  interrupt: (at: number) => Promise<void>,
  isBusy?: () => Promise<boolean>,
  dress?: (text: string) => Promise<string>,
  stopRun?: (runId: string) => Promise<void>,
): Promise<Inbox | undefined> {
  const home = await $.env.get('HOME')
  const sessionId = await $.session.id()
  if (!home || !isSafeSessionId(sessionId)) return undefined
  return createInbox({
    dir: `${home}/.claude/ccc/inbox/${sessionId}`,
    exists: path => $.fs.exists(path),
    list: dir => $.fs.list(dir),
    read: async path => {
      const text = await $.fs.read(path)
      return typeof text === 'string' ? text : ''
    },
    write: (path, text) => $.fs.write(path, text),
    submit: async text => {
      // a slash command the session knows (a skill, /model, /effort...) runs as one, as if typed
      if (await runSlash($, text).catch(() => false)) return
      const dressed = dress ? await dress(text).catch(() => text) : text
      if (dressed !== text && (await runSlash($, dressed).catch(() => false))) return
      await $.prompt.submit({ text: dressed, asUser: true })
    },
    interrupt,
    now: () => $.clock.now(),
    ...(isBusy ? { isBusy } : {}),
    ...(stopRun ? { stopRun } : {}),
  })
}
