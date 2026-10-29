export type StepStatus = 'pending' | 'in_progress' | 'completed'
export type PlanStep = { text: string; status: StepStatus; /** The task's own id, for a task list kept by id (TaskCreate). */ id?: string }

/** What a run on the agent map is: an agent, a session card, a workflow, or a command that runs in the background. */
export type RunKind = 'agent' | 'session' | 'workflow' | 'command'
export type RunStatus = 'running' | 'done' | 'failed' | 'stopped' | 'started' | 'proposed'
export type AgentRun = {
  id: string
  kind: RunKind
  label: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  agentId?: string
  lastAction?: string
  /** The workflow run an agent works in; absent for a run the session started itself. */
  parentId?: string
  /** A proposed session card's task id, which a later start names; a background command's task, which TaskStop ends. */
  taskId?: string
  /** An agent's own tool calls, the latest last; only the last ones are kept. */
  steps?: AgentStep[]
  /** How many steps the agent has taken, the ones no longer kept too. */
  stepCount?: number
  /** The agent's own task list, when it keeps one: the steps it plans, the done ones too. */
  plan?: PlanStep[]
}

/** One step of an agent: a tool call of its own, as the session log words it. */
export type AgentStep = {
  id: string
  at: number
  text: string
  status: LogStatus
  endedAt?: number
}

export type LogStatus = 'running' | 'ok' | 'error'
export type LogEntry = {
  id: string
  at: number
  text: string
  status: LogStatus
  who?: string
  endedAt?: number
}

export type ContextFill = { percent: number; tokens: number; window: number }

export type UsageLimit = { kind: string; percentUsed: number; resetsAt?: string }
export type SessionStats = {
  model: string
  effort?: string
  /** The session's permission mode (default, acceptEdits, plan, auto...), as its hooks last saw it. */
  mode?: string
  costUsd?: number
  costHistory: number[]
  limits: UsageLimit[]
}

/** What a session waits for from the person: an approval, an answer, or a plan to review. */
export type WaitKind = 'approval' | 'question' | 'plan'
export type Waiting = { kind: WaitKind; since: number; text?: string; toolUseId?: string; reason?: string }

export type TurnState = {
  isRunning: boolean
  startedAt?: number
  endedAt?: number
  topic?: string
  /** Something mid-turn that waits for the person (a question box, a plan, an approval). */
  waiting?: Waiting
  /** The question the turn closed with (the desktop's next-step box), while it is open. */
  asked?: string
  /** How the last turn ended: with a question for the person, or simply done. */
  ending?: 'question' | 'done'
  question?: string
  /** The answers the next-step box offers as buttons, while its question is open (asked first, kept at the end). */
  choices?: readonly Choice[]
  /** The running turn's id, which a stop from CCC ends; kept here so a reload of the mod keeps it. */
  turnId?: string
  /** When CCC asked to stop this turn: a command the stop moves to the background is ended then. */
  stopAsked?: number
  /** The engine's guess at the person's next prompt after the turn (the app's dim suggestion, Tab to take). */
  suggestion?: string
}

/** A button of the next-step box: what it says, and the message it sends to the session. */
export type Choice = { label: string; message: string }

/** What a session has cost today: its total minus what it had cost when today began. */
export type SpendLedger = { day: string; baseline: number }

/** One exchange: what the person asked and what Claude answered, both cut short. */
export type ChatTurn = { at: number; prompt: string; answer?: string; endedAt?: number }

/** The end of what Claude has written in the latest turn, as it streams; `isWriting` while text comes in. */
export type LiveReply = { text: string; at: number; isWriting: boolean }

/** Calls per kind of tool (Bash, Read, Edit, ...) over the session. */
export type ToolCounts = Record<string, number>

declare module 'claude-code' {
  interface PluginState {
    ccc: {
      plan: PlanStep[]
      runs: AgentRun[]
      log: LogEntry[]
      context: ContextFill | null
      stats: SessionStats
      turn: TurnState
      tools: ToolCounts
      spend: SpendLedger | null
      chat: ChatTurn[]
      reply: LiveReply | null
      /** Background tasks a stop from CCC ended, whose report of it is not to start a turn. */
      stoppedTasks: string[]
    }
  }
}
