import type { AgentStatus, SessionContextUsage } from 'claude-code'

import type { AgentRun, AgentStep, Choice, ContextFill, LogEntry, LogStatus, RunStatus, WaitKind } from '../types'
import { agentPlanAfter } from './plan'

export const LOG_KEPT = 50
const TEXT_MAX = 90

type Input = Record<string, unknown>

const QUIET = /^(mcp__ccd_turn__.*|ToolSearch)$/
const BROWSER_CLICKS = /^mcp__(Claude_Browser|claude-in-chrome)__computer$/
const BROWSER_NAVIGATE = /^mcp__(Claude_Browser|claude-in-chrome)__navigate$/
const SIMULATOR = 'mcp__Claude_Code_iOS_Simulator__control'
const START_SESSION = 'mcp__ccd_session__start_session'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One line for the log, or undefined for calls that only add noise. */
export function describeCall(tool: string, input: Input): string | undefined {
  if (QUIET.test(tool)) return undefined
  return clip(describeBuiltin(tool, input) ?? describeMcp(tool, input) ?? tool)
}

function describeBuiltin(tool: string, input: Input): string | undefined {
  switch (tool) {
    case 'Bash':
      return '$ ' + firstLine(field(input, 'command'))
    case 'Read':
      return 'Read ' + shortPath(field(input, 'file_path'))
    case 'Edit':
      return 'Edit ' + shortPath(field(input, 'file_path'))
    case 'Write':
      return 'Write ' + shortPath(field(input, 'file_path'))
    case 'Grep':
      return `Search "${field(input, 'pattern')}"`
    case 'Glob':
      return 'Find files ' + field(input, 'pattern')
    case 'Agent':
      return 'Start agent: ' + field(input, 'description')
    case 'Skill':
      return 'Load skill ' + field(input, 'skill')
    case 'WebSearch':
      return 'Web search: ' + field(input, 'query')
    case 'WebFetch':
      return 'Fetch ' + field(input, 'url')
    case 'Workflow':
      return 'Start workflow ' + workflowName(input)
    default:
      return undefined
  }
}

function describeMcp(tool: string, input: Input): string | undefined {
  const action = field(input, 'action')
  if (BROWSER_CLICKS.test(tool)) {
    return action === 'screenshot' ? 'Screenshot (browser)' : 'Browser: ' + action
  }
  if (BROWSER_NAVIGATE.test(tool)) return 'Open ' + field(input, 'url')
  if (tool === SIMULATOR) {
    return action === 'screenshot' ? 'Screenshot (simulator)' : 'Simulator: ' + action
  }
  if (tool === START_SESSION) return 'Start session: ' + field(input, 'title')
  const match = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!match) return undefined
  const [, server = '', name = ''] = match
  return UUID.test(server) ? name : `${server}: ${name}`
}

const TOOL_KINDS: Record<string, string> = {
  Bash: 'Bash',
  Read: 'Read',
  Edit: 'Edit',
  Write: 'Edit',
  NotebookEdit: 'Edit',
  Grep: 'Search',
  Glob: 'Search',
  Agent: 'Agent',
  Workflow: 'Agent',
  WebFetch: 'Web',
  WebSearch: 'Web',
}

/** The kind of tool a call counts as in the tool mix. */
export function toolKind(tool: string): string {
  if (TOOL_KINDS[tool]) return TOOL_KINDS[tool]
  if (tool === START_SESSION) return 'Agent'
  if (BROWSER_CLICKS.test(tool) || BROWSER_NAVIGATE.test(tool)) return 'Web'
  return tool.startsWith('mcp__') ? 'MCP' : 'Other'
}

export function countTool(counts: Readonly<Record<string, number>>, kind: string): Record<string, number> {
  return { ...counts, [kind]: (counts[kind] ?? 0) + 1 }
}

const QUESTION_TOOLS = new Set(['AskUserQuestion'])
const PLAN_TOOLS = new Set(['ExitPlanMode'])

/** What a call asks of the person while it is open, for the calls that wait on them. */
export function waitFor(tool: string, input: Input): { kind: WaitKind; text?: string } | undefined {
  if (QUESTION_TOOLS.has(tool)) return { kind: 'question', ...withText(firstQuestion(input)) }
  if (PLAN_TOOLS.has(tool)) return { kind: 'plan' }
  if (tool === START_SESSION && input.initiation === 'offer') {
    return { kind: 'question', text: clip(`Start "${field(input, 'title')}" as its own session?`) }
  }
  return undefined
}

// the app's approval box gives its reason in a sentence
const REASON_MAX = 300

/** Why a call asks for approval, as the app's box says it (a check on the command, a rule); none when the check gave none. */
export function askReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined
  const text = reason.trim()
  return text ? text.slice(0, REASON_MAX) : undefined
}

const CHOICES_MAX = 2
const CHOICE_LABEL_MAX = 40
const CHOICE_MESSAGE_MAX = 300

/**
 * The reply buttons of the next-step box: what each says and the message it sends. A button that
 * runs one of the app's own actions (commit, open a pull request) is the app's alone and is left out.
 */
export function replyChoices(actions: unknown): Choice[] {
  if (!Array.isArray(actions)) return []
  return actions
    .filter((one): one is Record<string, unknown> => Boolean(one) && typeof one === 'object' && (one as Record<string, unknown>).action === undefined)
    .map(one => {
      const label = typeof one.label === 'string' ? one.label.trim() : ''
      const message = typeof one.message === 'string' && one.message.trim() ? one.message.trim() : label
      return { label: label.slice(0, CHOICE_LABEL_MAX), message: message.slice(0, CHOICE_MESSAGE_MAX) }
    })
    .filter(one => one.label !== '')
    .slice(0, CHOICES_MAX)
}

/** How long after a stop from CCC a command moved to the background counts as moved by that stop. */
const STOP_REACH_MS = 30_000
const STOPPED_KEPT = 20

/**
 * The background task a stop from CCC made of a running command: when a turn is aborted, Claude
 * Code moves its shell command to the background instead of ending it, and Stop is to end it.
 */
export function stoppedByUs(output: unknown, stopAsked: number | undefined, now: number): string | undefined {
  if (!output || typeof output !== 'object' || stopAsked === undefined || now - stopAsked > STOP_REACH_MS) return undefined
  const { backgroundTaskId, backgroundedByTurnAbort } = output as Record<string, unknown>
  return backgroundedByTurnAbort === true && typeof backgroundTaskId === 'string' && backgroundTaskId ? backgroundTaskId : undefined
}

/** The turn a stop asked at `at` ends: the running one, when it began before the ask; else none. */
export function stopTarget(turn: { isRunning?: boolean; turnId?: string; startedAt?: number }, at: number): string | undefined {
  if (!turn.isRunning || !turn.turnId || (turn.startedAt ?? Number.POSITIVE_INFINITY) > at) return undefined
  return turn.turnId
}

/** The tasks stopped from CCC, the newest kept. */
export function rememberStopped(list: readonly string[] | null | undefined, taskId: string): string[] {
  return [...(list ?? []).filter(one => one !== taskId), taskId].slice(-STOPPED_KEPT)
}

/** Whether a prompt is only the report of tasks a stop from CCC ended, which is to start no turn. */
export function isOnlyStoppedReport(text: string, stopped: readonly string[] | null | undefined): boolean {
  if (!isOnlyNotification(text)) return false
  const ids = [...text.matchAll(/<task-id>([^<]*)<\/task-id>/g)].map(match => match[1]?.trim() ?? '')
  return ids.length > 0 && ids.every(id => (stopped ?? []).includes(id))
}

/** How a finished turn left things: with a question for the person, or simply done. */
export function endingOf(asked: string | undefined, answer: string): { ending: 'question' | 'done'; question?: string } {
  if (asked && asked.trim()) return { ending: 'question', question: clip(asked.trim()) }
  const lines = answer.trim().split('\n').map(line => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  return last.endsWith('?') ? { ending: 'question', question: clip(last) } : { ending: 'done' }
}

function firstQuestion(input: Input): string {
  const questions = input.questions
  if (!Array.isArray(questions)) return ''
  const first = questions[0] as Record<string, unknown> | undefined
  return first && typeof first.question === 'string' ? clip(first.question) : ''
}

function withText(text: string) {
  return text ? { text } : {}
}

/** The node an agent-starting call adds to the agent map, if it is one. */
export function runFor(tool: string, input: Input, id: string, now: number): AgentRun | undefined {
  const base = { id, startedAt: now }
  if (tool === 'Agent') {
    const label = field(input, 'description') || 'Agent'
    return { ...base, kind: 'agent', label, status: 'running' }
  }
  if (tool === START_SESSION) {
    // starting a proposal made earlier is that proposal's run, not a new one (see startProposal)
    if (proposalStarted(tool, input)) return undefined
    const status = input.initiation === 'user_asked' ? 'started' : 'proposed'
    return { ...base, kind: 'session', label: field(input, 'title') || 'Session', status }
  }
  if (tool === 'Workflow') {
    return { ...base, kind: 'workflow', label: workflowName(input) || 'Workflow', status: 'started' }
  }
  return undefined
}

/**
 * A shell command that went on in the background, asked for or moved there (it timed out, or the
 * person pressed Ctrl+B): a run of its own until Claude Code reports it ended. A command that ends
 * with the session's final answer gets no report, so it gets no run.
 */
export function backgroundRunFor(tool: string, input: Input, output: unknown, id: string, startedAt: number): AgentRun | undefined {
  if (tool !== 'Bash' || !output || typeof output !== 'object') return undefined
  const { backgroundTaskId, backgroundEndsWithFinalResponse } = output as Record<string, unknown>
  if (typeof backgroundTaskId !== 'string' || !backgroundTaskId || backgroundEndsWithFinalResponse === true) return undefined
  const label = field(input, 'description').trim() || firstLine(field(input, 'command')) || 'Background command'
  return { id, kind: 'command', label: clip(label), status: 'running', startedAt }
}

/** A run once its starting call has answered. */
/** What `agent.spawn` says about the agent it started. */
export type Spawn = { tool_use_id: string; description?: string; name?: string; workflow?: { agentIndex: number } }

/**
 * Places a spawned agent. An Agent call's own run gets the agent's id. A workflow's agents
 * each get a run of their own under the workflow's, so the map shows every one of them.
 */
export function placeAgent(list: readonly AgentRun[], spawn: Spawn, agentId: string, now: number): AgentRun[] {
  const owner = list.find(one => one.id === spawn.tool_use_id)
  const inWorkflow = owner?.kind === 'workflow' || spawn.workflow !== undefined
  if (!inWorkflow) return list.map(one => (one === owner ? { ...one, agentId } : one))
  const known = list.find(one => one.agentId === agentId && one.parentId !== undefined)
  if (known) return list.map(one => (one === known ? running(one) : one))
  const label = (spawn.description ?? '').trim() || (spawn.name ?? '').trim() || `Agent ${(spawn.workflow?.agentIndex ?? 0) + 1}`
  return [...list, { id: agentId, kind: 'agent', label, status: 'running', startedAt: now, agentId, parentId: spawn.tool_use_id }]
}

function running(run: AgentRun): AgentRun {
  const { endedAt: _endedAt, ...rest } = run
  return { ...rest, status: 'running' }
}

/** How an agent's loop ended its turn: an answer is done work, anything else failed. */
export type TurnEnd = 'answer' | 'aborted' | 'refusal' | 'error'

/** An agent's loop ended its turn: its run is done, or failed when the turn did not end in an answer. */
export function finishAgent(list: readonly AgentRun[], agentId: string, reason: TurnEnd, now: number): AgentRun[] {
  const status: RunStatus = reason === 'answer' ? 'done' : 'failed'
  return list.map(one => (one.agentId === agentId && one.status === 'running' ? { ...one, status, endedAt: now } : one))
}

/** An agent's loop starts a turn again (a resumed agent, a teammate's next message): its run works again. */
export function resumeAgent(list: readonly AgentRun[], agentId: string): AgentRun[] {
  return list.map(one => (one.agentId === agentId && one.kind === 'agent' && one.status !== 'running' ? running(one) : one))
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g

/** True when a prompt is nothing but Claude Code reporting background work back. */
export function isOnlyNotification(text: string): boolean {
  return text.includes('<task-notification>') && text.replace(NOTIFICATION, '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() === ''
}

/**
 * Background work reports back in the session's prompt when it ends (`<task-notification>`,
 * naming the tool call that started it). Each run it names is settled, and a finished
 * workflow settles the agents of it that still show as working.
 */
export function settleTasks(list: readonly AgentRun[], text: string, now: number): AgentRun[] {
  let next = [...list]
  for (const [, body = ''] of text.matchAll(NOTIFICATION)) {
    const id = tagOf(body, 'tool-use-id')
    const ended = taskEndOf(tagOf(body, 'status'))
    if (!id || !ended) continue
    next = next.map(one => {
      const isNamed = one.id === id && (one.status === 'running' || one.status === 'started')
      const isLeftOver = one.parentId === id && one.status === 'running'
      return isNamed || isLeftOver ? { ...one, status: ended, endedAt: now } : one
    })
  }
  return next
}

function tagOf(body: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body)?.[1]?.trim() || undefined
}

function taskEndOf(status: string | undefined): RunStatus | undefined {
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'killed' || status === 'stopped' || status === 'error') return 'failed'
  return undefined
}

export function settleRun(run: AgentRun, isError: boolean, input: Input, now: number, output?: unknown): AgentRun {
  if (isError) return { ...run, status: 'failed', endedAt: now }
  const ranInForeground = run.kind === 'agent' && input.run_in_background === false
  if (ranInForeground) return { ...run, status: 'done', endedAt: now }
  const taskId = run.kind === 'session' ? proposalOf(output) : undefined
  return taskId ? { ...run, taskId } : run
}

const TASK_ID = /task_id:\s*(task_[A-Za-z0-9_-]{1,64})/

/** The task id a session card's call answered with, so the start of that proposal can find its run. */
export function proposalOf(output: unknown): string | undefined {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  return TASK_ID.exec(text ?? '')?.[1]
}

/** The proposal a call starts, when it starts one made earlier (by its task id alone). */
export function proposalStarted(tool: string, input: Input): string | undefined {
  const id = tool === START_SESSION ? input.proposal_id : undefined
  return typeof id === 'string' && id ? id : undefined
}

/** The runs once a proposed session was started: the proposal's own card says so. */
export function startProposal(list: readonly AgentRun[], taskId: string): AgentRun[] {
  return list.map(one => (one.kind === 'session' && one.taskId === taskId && one.status === 'proposed' ? { ...one, status: 'started' } : one))
}

/** A run as the engine's agent list says it stands now. */
export function trackAgent(run: AgentRun, status: AgentStatus, now: number): AgentRun {
  const next = runStatusOf(status)
  if (next === run.status) return run
  return next === 'running' ? { ...run, status: next } : { ...run, status: next, endedAt: now }
}

function runStatusOf(status: AgentStatus): RunStatus {
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'killed') return 'failed'
  return 'running'
}

/** The context fill as the panel shows it, or null before the first reading. */
export function readContext(usage: SessionContextUsage): ContextFill | null {
  const { tokens, window } = usage
  if (tokens === undefined || window <= 0) return null
  const percent = usage.percent ?? Math.round((tokens / window) * 100)
  return { percent, tokens, window }
}

const STEPS_KEPT = 60

/** An agent's run once the agent starts a step (a tool call of its own): the step goes last, and is counted. */
export function addStep(list: readonly AgentRun[], agentId: string, step: AgentStep): AgentRun[] {
  return list.map(one =>
    one.agentId === agentId ? { ...one, lastAction: step.text, stepCount: (one.stepCount ?? 0) + 1, steps: [...(one.steps ?? []), step].slice(-STEPS_KEPT) } : one,
  )
}

/** An agent's run once the agent wrote or changed its own task list; any other call leaves it. */
export function noteAgentPlan(list: readonly AgentRun[], agentId: string, tool: string, input: Input, output: unknown): AgentRun[] {
  return list.map(one => {
    if (one.agentId !== agentId) return one
    const plan = agentPlanAfter(one.plan ?? [], tool, input, output)
    return plan ? { ...one, plan } : one
  })
}

/** An agent's step once it ended, well or not. */
export function settleStep(list: readonly AgentRun[], agentId: string, id: string, status: LogStatus, now: number): AgentRun[] {
  return list.map(one =>
    one.agentId === agentId && one.steps?.some(step => step.id === id)
      ? { ...one, steps: one.steps.map(step => (step.id === id ? { ...step, status, endedAt: now } : step)) }
      : one,
  )
}

export function pushLog(log: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  return [...log, entry].slice(-LOG_KEPT)
}

export function settleLog(log: readonly LogEntry[], id: string, status: LogStatus, now: number): LogEntry[] {
  return log.map(entry => (entry.id === id ? { ...entry, status, endedAt: now } : entry))
}

function field(input: Input, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

function workflowName(input: Input): string {
  const saved = field(input, 'name')
  if (saved) return saved
  return /name:\s*['"]([^'"]+)['"]/.exec(field(input, 'script'))?.[1] ?? ''
}

function firstLine(text: string): string {
  const [first = ''] = text.trim().split('\n')
  return text.trim().includes('\n') ? first + ' …' : first
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 3 ? path : '…/' + parts.slice(-3).join('/')
}

function clip(text: string): string {
  return text.length <= TEXT_MAX ? text : text.slice(0, TEXT_MAX - 1) + '…'
}
