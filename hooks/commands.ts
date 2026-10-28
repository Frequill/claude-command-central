import type { EngineInterface } from 'claude-code'

import { isSafeSessionId } from './snapshot'

/** A slash command as the board's "/" menu lists it: built-in, a skill or another plugin's. */
export type CommandEntry = { name: string; description: string; source: string }

/** What the board reads for one session: its slash commands, and the models /model takes. */
export type CommandSheet = { commands: CommandEntry[]; models: string[] }

// a slash command written in CCC's chat: its name, then whatever follows it
const SLASH = /^\/([A-Za-z0-9_:.-]{1,80})(?:\s+([\s\S]*))?$/

/** The command and its arguments when the words are a slash command, else undefined. */
export function slashOf(text: string): { command: string; args: string } | undefined {
  const match = SLASH.exec(text.trim())
  const command = match?.[1]
  return command ? { command, args: (match?.[2] ?? '').trim() } : undefined
}

/** The sheet the board reads, from the session's own lists. */
export function commandSheet(commands: readonly { name: string; description: string; source: string }[], models: readonly string[] | undefined): CommandSheet {
  return {
    commands: commands.map(({ name, description, source }) => ({ name, description, source })),
    models: [...(models ?? [])],
  }
}

/**
 * Writes this session's slash commands where the board's server reads them, so the chat's "/" menu
 * offers what the session itself would: built-in commands, skills and the other plugins' commands.
 */
export async function publishCommands($: EngineInterface): Promise<void> {
  const home = await $.env.get('HOME')
  const sessionId = await $.session.id()
  if (!home || !isSafeSessionId(sessionId)) return
  const commands = await $.command.list()
  const modelRow = (await $.config.list()).find(row => row.key === 'model')
  await $.fs.write(`${home}/.claude/ccc/commands/${sessionId}.json`, JSON.stringify(commandSheet(commands, modelRow?.options)))
}

/** Runs a slash command written in CCC as if typed in the session; false when the session has no such command. */
export async function runSlash($: EngineInterface, text: string): Promise<boolean> {
  const slash = slashOf(text)
  if (!slash) return false
  const known = (await $.command.list()).some(command => command.name === slash.command)
  if (!known) return false
  // a known command that cannot run now is not sent to Claude as words instead
  await $.command.run({ command: slash.command, args: slash.args }).catch(() => undefined)
  return true
}
