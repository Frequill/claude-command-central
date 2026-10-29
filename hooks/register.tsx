import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, TurnState } from '../types'

import {
  addStep,
  askReason,
  backgroundRunFor,
  countTool,
  describeCall,
  endingOf,
  finishAgent,
  isOnlyNotification,
  isOnlyStoppedReport,
  noteAgentPlan,
  placeAgent,
  proposalStarted,
  resumeAgent,
  settleTasks,
  startProposal,
  stopTarget,
  stoppedByUs,
  pushLog,
  readContext,
  rememberStopped,
  stopRunIn,
  stopTaskOf,
  replyChoices,
  runFor,
  settleLog,
  settleRun,
  settleStep,
  toolKind,
  trackAgent,
  waitFor,
} from './activity'
import { cavemanNote, cavemanNow, cavemanPrompt, cavemanRules } from './caveman'
import type { CavemanLevel } from './caveman'
import { drawPane } from './draw'
import type { Kit } from './draw'
import { endChat, startChat } from './chat'
import { closeReply, draftReply, openReply } from './reply'
import { publishCommands } from './commands'
import { inboxFor } from './inbox'
import type { Inbox } from './inbox'
import { applyPlanUpdate, completeAll, readPlanUpdate } from './plan'
import { openLedger, rollLedger, spentToday } from './spend'
import { publisherFor } from './publish'
import type { Publisher, SessionParts } from './publish'
import { topicOf } from './snapshot'
import { EMPTY_STATS, withMeasure } from './stats'

const PANE = 'ccc'
const TITLE = 'CCC'
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'
const TICK_MS = 1000
const SUGGESTION_MAX = 2000
const POLL_EVERY_TICKS = 3
const RELOCATE_EVERY_TICKS = 10

const plan = atom({ plugin: 'ccc', key: 'plan' } as const, [])
const runs = atom({ plugin: 'ccc', key: 'runs' } as const, [])
const log = atom({ plugin: 'ccc', key: 'log' } as const, [])
const context = atom({ plugin: 'ccc', key: 'context' } as const, null)
const stats = atom({ plugin: 'ccc', key: 'stats' } as const, EMPTY_STATS)
const turn = atom({ plugin: 'ccc', key: 'turn' } as const, { isRunning: false })
const tools = atom({ plugin: 'ccc', key: 'tools' } as const, {})
const spend = atom({ plugin: 'ccc', key: 'spend' } as const, null)
const chat = atom({ plugin: 'ccc', key: 'chat' } as const, [])
const reply = atom({ plugin: 'ccc', key: 'reply' } as const, null)
const stoppedTasks = atom({ plugin: 'ccc', key: 'stoppedTasks' } as const, [])

let publisher: Publisher | undefined
// the caveman level the last note to Claude gave; undefined until one was given
let cavemanTold: CavemanLevel | 'off' | undefined
let inbox: Inbox | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ccc', description: 'Show the CCC panel' })
    openPane($)
    const usage = await $.session.usage()
    const fill = readContext(usage.context)
    if (fill) await update($, context, () => fill)
    const model = await $.session.model()
    await update($, stats, now => withMeasure({ ...now, model }, usage))
    const startedNow = await $.clock.now()
    await update($, spend, ledger => ledger ?? openLedger(usage.startedAt, startedNow, usage.cost?.usd))
    publisher = await publisherFor($, () => snapshotParts($)).catch(() => undefined)
    inbox = await inboxFor(
      $,
      at => stopTurn($, at),
      async () => Boolean((await read($, turn)).isRunning),
      text => cavemanDressed($, text),
      runId => stopRun($, runId),
    ).catch(() => undefined)
    await publishCommands($).catch(() => undefined)
    startTicking($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const model = await sessionModel($)
      if (model) await update($, stats, now => ({ ...now, model }))
      const startedAt = await $.clock.now()
      await update($, turn, now => {
        const topic = now.topic || topicOf(e.text)
        return { isRunning: true, startedAt, turnId: e.turnId, ...(topic ? { topic } : {}) }
      })
      if (!isOnlyNotification(e.text)) {
        await update($, chat, list => startChat(list, e.text, startedAt))
        // the task list belongs to the turn that keeps it, as in the app: a new message from the
        // person starts with none, until Claude writes one; a notice of background work keeps it
        await update($, plan, () => [])
      }
      await update($, reply, () => openReply(startedAt))
      await update($, runs, list => settleTasks(list, e.text, startedAt))
    } else {
      const agentId = e.agentId
      await update($, runs, list => resumeAgent(list, agentId))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const endedAt = await $.clock.now()
      const ending = endingOf(e.isAborted ? undefined : (await read($, turn)).asked, e.isAborted ? '' : (e.answer ?? ''))
      await update($, turn, now => {
        const { waiting: _waiting, asked, choices, turnId: _turnId, stopAsked: _stopAsked, ...rest } = now
        const keeps = Boolean(asked) && ending.ending === 'question' && (choices?.length ?? 0) > 0
        return { ...rest, isRunning: false, endedAt, ...ending, ...(keeps ? { choices } : {}) }
      })
      await update($, chat, list => endChat(list, e.isAborted ? '' : (e.answer ?? ''), endedAt))
      await update($, reply, now => closeReply(now, e.isAborted ? '' : (e.answer ?? ''), endedAt))
    } else {
      const agentId = e.agentId
      const endedAt = await $.clock.now()
      await update($, runs, list => finishAgent(list, agentId, e.reason, endedAt))
    }

    return next(e)
  })

  // Claude's text as it streams, so the board can show the reply while it is being written.
  // The pieces pass on untouched; what the board gets is written down now and then.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (e.agentId !== undefined) return yield* stream
    await noteEffort($, e.effort)
    const start = await replySoFar($)
    const draft = draftReply(start)
    try {
      for await (const chunk of stream) {
        if (chunk.kind === 'text' && typeof chunk.text === 'string' && draft.add(chunk.index, chunk.text)) {
          await saveReply($, draft.text(), true)
        }
        yield chunk
      }
    } finally {
      if (draft.text() !== start) await saveReply($, draft.text(), false)
    }
    // returning nothing lets the result from beneath stand, untouched
  })

  on('session.end', async ($, e, next) => {
    // The last write; the ticks stop here, or they would overwrite it with the emptied state.
    const last = publisher
    publisher = undefined
    await last?.publish(await $.clock.now()).catch(() => undefined)

    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const level = e.agent_id === undefined ? e.effort?.level : undefined
    if (level) await update($, stats, now => ({ ...now, effort: level }))
    await noteMode($, e.agent_id === undefined ? e.permission_mode : undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  // the session's permission mode, as each prompt finds it, for the board's session settings
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteMode($, e.permission_mode)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'ccc' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'The CCC panel is open.' }
  })

  on('tool.call', async ($, e, next) => {
    const input: Record<string, unknown> = { ...e }
    const id = e.tool_use_id
    const now = await $.clock.now()
    const text = describeCall(e.tool, input)
    const run = e.agentId === undefined ? runFor(e.tool, input, id, now) : undefined
    if (text) await noteStart($, id, text, now, e.agentId)
    if (text) await update($, tools, counts => countTool(counts, toolKind(e.tool)))
    if (run) await update($, runs, list => [...list, run])
    const wait = e.agentId === undefined ? waitFor(e.tool, input) : undefined
    if (wait) await update($, turn, state => ({ ...state, waiting: { ...wait, since: now, toolUseId: id } }))

    const result = await next(e)
    await update($, turn, state => (state.waiting?.toolUseId === id ? withoutWaiting(state) : state))
    const isError = result.deny !== undefined || result.isError === true
    // an agent's task list and wrap-up are its own: the session's list is the main thread's
    if (!isError && e.agentId === undefined) await notePlan($, e.tool, input)
    if (!isError && e.agentId !== undefined) await update($, runs, list => noteAgentPlan(list, e.agentId as string, e.tool, input, result.result))
    const end = await $.clock.now()
    if (text) await update($, log, list => settleLog(list, id, isError ? 'error' : 'ok', end))
    if (text && e.agentId !== undefined) await update($, runs, list => settleStep(list, e.agentId as string, id, isError ? 'error' : 'ok', end))
    // a command a stop from CCC moved to the background is ended, as Stop in the app ends it
    const stopped = e.agentId === undefined && !isError ? stoppedByUs(result.result, (await read($, turn)).stopAsked, end) : undefined
    // ended on the next tick: a call made now belongs to the stopped turn and is cancelled with it
    if (stopped) {
      await update($, stoppedTasks, list => rememberStopped(list, stopped))
      toEnd.add(stopped)
    }
    const background = e.agentId === undefined && !isError && !stopped ? backgroundRunFor(e.tool, input, result.result, id, now) : undefined
    if (background) await update($, runs, list => [...list.filter(one => one.id !== id), background])
    if (run) {
      await update($, runs, list =>
        list.map(one => (one.id === id ? settleRun(one, isError, input, end, result.result) : one)),
      )
    }
    const started = isError ? undefined : proposalStarted(e.tool, input)
    if (started) await update($, runs, list => startProposal(list, started))

    return result
  }).catch(($, e, next) => next(e))

  // the report of a task a stop from CCC ended starts no turn: Claude does not carry on with it
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification' && isOnlyStoppedReport(e.text, await read($, stoppedTasks))) {
      return { drop: 'Stopped from CCC.' }
    }
    // caveman mode switched in CCC: a note beside the message that the person does not see
    const note = e.command ? undefined : await nextCavemanNote($)

    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  }).catch(($, e, next) => next(e))

  // the engine's own guess at the person's next prompt, which the app shows dim in its prompt box for
  // Tab to take: kept on the turn for CCC's write box, until the next turn starts and drops it
  on('prompt.suggest', async ($, e, next) => {
    const shown = await next(e)
    const text = e.origin.kind === 'suggestion' ? e.text.trim().slice(0, SUGGESTION_MAX) : ''
    if (text) await update($, turn, now => (now.isRunning ? now : { ...now, suggestion: text }))

    return shown
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const input = e.input && typeof e.input === 'object' ? (e.input as Record<string, unknown>) : {}
    const id = e.tool_use_id
    if (verdict.decision === 'ask' && e.agentId === undefined && id && !waitFor(e.tool, input)) {
      const since = await $.clock.now()
      const text = describeCall(e.tool, input) ?? e.tool
      const reason = askReason(verdict.reason)
      await update($, turn, now => ({ ...now, waiting: { kind: 'approval', since, text, toolUseId: id, ...(reason ? { reason } : {}) } }))
    }

    return verdict
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    // the session's own mode comes along with each agent it starts: a second source for it, where
    // another plugin keeps the prompt and tool hooks from this one
    await noteMode($, e.permissionMode)
    const spawned = await next(e)
    const { agentId } = spawned
    if (agentId) {
      const now = await $.clock.now()
      await update($, runs, list => placeAgent(list, e, agentId, now))
      // the agent was allowed to start: the session no longer waits for that approval while it works
      await update($, turn, state => (state.waiting?.kind === 'approval' && state.waiting.toolUseId === e.tool_use_id ? withoutWaiting(state) : state))
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const fill = readContext(e.context)
    if (fill) await update($, context, () => fill)
    const previousCost = (await read($, stats)).costUsd
    const measuredAt = await $.clock.now()
    await update($, spend, ledger => (ledger ? rollLedger(ledger, measuredAt, previousCost) : ledger))
    await update($, stats, now => withMeasure(now, e))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const kit: Kit = {
      Box: elements.Box,
      Text: elements.Text,
      Code: elements.Code,
      Svg: e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined,
    }

    return drawPane(kit, {
      plan: await read($, plan),
      runs: await read($, runs),
      log: await read($, log),
      context: await read($, context),
      stats: await read($, stats),
      now: await $.clock.now(),
      columns: e.props.bodyColumns,
    })
  })
}

/** A message from CCC's write box, sent through the caveman skill while caveman mode is on (cavemanPrompt). */
async function cavemanDressed($: EngineInterface, text: string): Promise<string> {
  try {
    const { level } = await cavemanNow($)
    const hasSkill = (await $.command.list()).some(command => command.name === 'caveman')
    const dressed = cavemanPrompt(text, level, cavemanTold, hasSkill)
    if (dressed !== text) cavemanTold = level ?? 'off'
    return dressed
  } catch {
    return text
  }
}

async function nextCavemanNote($: EngineInterface): Promise<string | undefined> {
  try {
    const { level, wasChosen } = await cavemanNow($)
    const note = cavemanNote(level, cavemanTold, level ? await cavemanRules($) : '', wasChosen)
    if (note) cavemanTold = level ?? 'off'
    return note
  } catch {
    return undefined
  }
}

async function noteStart(
  $: EngineInterface,
  id: string,
  text: string,
  now: number,
  agentId: string | undefined,
) {
  const who = agentId ? (await runOf($, agentId))?.label : undefined
  const entry = { id, at: now, text, status: 'running' as const, ...(who ? { who } : {}) }
  await update($, log, list => pushLog(list, entry))
  if (agentId) await update($, runs, list => addStep(list, agentId, { id, at: now, text, status: 'running' }))
}

/** The model the session runs; a lookup that fails leaves the one already known. */
async function sessionModel($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.session.model()
  } catch {
    return undefined
  }
}

async function replySoFar($: EngineInterface): Promise<string> {
  try {
    return (await read($, reply))?.text ?? ''
  } catch {
    return ''
  }
}

/** A missed write only means the card is a moment behind; the reply keeps streaming. */
async function saveReply($: EngineInterface, text: string, isWriting: boolean) {
  try {
    const at = await $.clock.now()
    await update($, reply, () => ({ text, at, isWriting }))
  } catch {
    // the next piece or the turn's end writes it
  }
}

async function noteMode($: EngineInterface, mode: string | undefined) {
  if (!mode) return
  try {
    await update($, stats, now => (now.mode === mode ? now : { ...now, mode }))
  } catch {
    // the mode stays as it was
  }
}

async function noteEffort($: EngineInterface, effort: string | number | undefined) {
  if (effort === undefined) return
  const level = String(effort)
  try {
    await update($, stats, now => (now.effort === level ? now : { ...now, effort: level }))
  } catch {
    // effort stays as it was
  }
}

async function notePlan($: EngineInterface, tool: string, input: Record<string, unknown>) {
  if (tool === WRAP_UP_TOOL) {
    await update($, plan, completeAll)
    const asked = typeof input.ask === 'string' ? input.ask.trim() : ''
    const choices = replyChoices(input.actions)
    await update($, turn, now => (asked ? { ...now, asked, ...(choices.length ? { choices } : {}) } : now))
  }
  if (tool !== PLAN_TOOL) return
  await update($, plan, steps => applyPlanUpdate(steps, readPlanUpdate(input)))
  if (Array.isArray(input.items)) openPane($)
}

async function snapshotParts($: EngineInterface): Promise<SessionParts> {
  return {
    turn: await read($, turn),
    plan: await read($, plan),
    runs: await read($, runs),
    log: await read($, log),
    context: await read($, context),
    stats: await read($, stats),
    tools: await read($, tools),
    today: await todaySpend($),
    chat: await read($, chat),
    reply: await read($, reply),
  }
}

/** Today's spend; on a new day with no reading yet, nothing has been spent today. */
async function todaySpend($: EngineInterface) {
  const ledger = await read($, spend)
  if (!ledger) return null
  const cost = (await read($, stats)).costUsd
  const current = rollLedger(ledger, await $.clock.now(), cost)
  return { day: current.day, usd: spentToday(current, cost) }
}

async function runOf($: EngineInterface, agentId: string): Promise<AgentRun | undefined> {
  return (await read($, runs)).find(one => one.agentId === agentId)
}

function startTicking($: EngineInterface) {
  let tick = 0
  $.clock.every(TICK_MS, () => {
    tick += 1
    refresh($, tick % POLL_EVERY_TICKS === 0).catch(() => undefined)
    if (tick % RELOCATE_EVERY_TICKS === 0) publisher?.relocate().catch(() => undefined)
    publisher?.publish().catch(() => undefined)
    inbox?.check().catch(() => undefined)
    if (toEnd.size > 0) endStoppedTasks($).catch(() => undefined)
  })
}

async function refresh($: EngineInterface, shouldPoll: boolean) {
  const list = await read($, runs)
  const isAgentRunning = list.some(one => one.status === 'running')
  const isCallRunning = (await read($, log)).some(entry => entry.status === 'running')
  if (!isAgentRunning && !isCallRunning) return
  if (shouldPoll && list.some(one => one.agentId && one.status === 'running')) await pollAgents($)
  $.ui.invalidate('ui.render')
}

async function pollAgents($: EngineInterface) {
  const statuses = new Map((await $.agent.list()).map(agent => [agent.id, agent.status]))
  const now = await $.clock.now()
  await update($, runs, list =>
    list.map(one => {
      const status = one.agentId ? statuses.get(one.agentId) : undefined
      return status ? trackAgent(one, status, now) : one
    }),
  )
}

/** Opens the pane without waiting; a surface that cannot place it leaves it closed. */
function openPane($: EngineInterface) {
  $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
}

/** How long a stop waits for the turn to end before the inbox goes on with the next message. */
const STOP_WAIT_MS = 5_000

/**
 * Ends the main loop's running turn, when it began before the person asked (`at`): a stop left
 * over from a turn that is gone never ends a new one.
 */
async function stopTurn($: EngineInterface, at: number) {
  const turnId = stopTarget(await read($, turn), at)
  if (!turnId) return
  const stopAsked = await $.clock.now()
  await update($, turn, state => (state.turnId === turnId ? { ...state, stopAsked } : state))
  await Promise.race([$.turn.abort({ turnId }), $.clock.sleep(STOP_WAIT_MS)])
}

/** Background tasks a stop from CCC moved there, to end on the next tick, once the stopped turn is over. */
const toEnd = new Set<string>()

async function endStoppedTasks($: EngineInterface) {
  for (const taskId of [...toEnd]) {
    toEnd.delete(taskId)
    await endStoppedTask($, taskId)
  }
}

async function endStoppedTask($: EngineInterface, taskId: string): Promise<boolean> {
  try {
    const answer = (await $.tool.call({ tool: 'TaskStop', task_id: taskId } as never)) as { deny?: string; isError?: boolean; text?: string }
    if (answer?.deny === undefined && !answer?.isError) return true
    $.ui.log(`ccc: could not end background task ${taskId}: ${answer.deny ?? answer.text ?? 'refused'}`)
    return false
  } catch (error) {
    $.ui.log(`ccc: could not end background task ${taskId}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Stop on CCC's agent map: one agent or background command ends, as TaskStop ends it, and the
 * turn goes on. Its report starts no turn. A run its task no longer answers for (it ended without
 * the board hearing, or came from before CCC kept its task) is marked stopped all the same; an
 * agent the engine still says is working is left as it is.
 */
async function stopRun($: EngineInterface, runId: string) {
  const run = (await read($, runs)).find(one => one.id === runId && one.status === 'running')
  if (!run) return
  const taskId = stopTaskOf(run)
  if (taskId) await update($, stoppedTasks, list => rememberStopped(list, taskId))
  const isEnded = taskId ? await endStoppedTask($, taskId) : false
  if (!isEnded && run.agentId) {
    const agent = (await $.agent.list()).find(one => one.id === run.agentId)
    if (agent && agent.status === 'running') return
  }
  const now = await $.clock.now()
  await update($, runs, list => stopRunIn(list, runId, now))
}

function withoutWaiting(state: TurnState): TurnState {
  const { waiting: _waiting, ...rest } = state
  return rest
}
