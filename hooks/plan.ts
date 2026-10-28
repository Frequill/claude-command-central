import type { PlanStep, StepStatus } from '../types'

export type PlanUpdate = {
  items?: PlanStep[]
  advance?: boolean
  done?: number[]
  start?: number
}

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']

export function readPlanUpdate(input: Record<string, unknown>): PlanUpdate {
  const update: PlanUpdate = {}
  if (Array.isArray(input.items)) update.items = input.items.flatMap(toStep)
  if (input.advance === true) update.advance = true
  if (Array.isArray(input.done)) update.done = input.done.filter(isStepNumber)
  if (isStepNumber(input.start)) update.start = input.start
  return update
}

export function applyPlanUpdate(steps: readonly PlanStep[], update: PlanUpdate): PlanStep[] {
  let next = update.items ?? [...steps]
  if (update.advance) next = advance(next)
  for (const n of update.done ?? []) next = setStatus(next, n - 1, 'completed')
  if (update.start !== undefined) next = setStatus(next, update.start - 1, 'in_progress')
  return next
}

export function completeAll(steps: readonly PlanStep[]): PlanStep[] {
  return steps.map(step => ({ ...step, status: 'completed' }))
}

function toStep(item: unknown): PlanStep[] {
  if (typeof item !== 'object' || item === null) return []
  const { content, status } = item as Record<string, unknown>
  if (typeof content !== 'string') return []
  const known = typeof status === 'string' && STATUSES.includes(status)
  return [{ text: content, status: known ? (status as StepStatus) : 'pending' }]
}

function isStepNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function advance(steps: PlanStep[]): PlanStep[] {
  const current = steps.findIndex(step => step.status === 'in_progress')
  const finished = current === -1 ? steps : setStatus(steps, current, 'completed')
  const following = finished.findIndex((step, i) => i > current && step.status === 'pending')
  return following === -1 ? finished : setStatus(finished, following, 'in_progress')
}

function setStatus(steps: PlanStep[], index: number, status: StepStatus): PlanStep[] {
  if (index < 0 || index >= steps.length) return steps
  return steps.map((step, i) => (i === index ? { ...step, status } : step))
}

// the desktop app's task list, which an agent may keep too
const DESKTOP_PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const AGENT_PLAN_MAX = 40
const TASK_NUMBER = /#(\d{1,9})/

/**
 * An agent's own plan after a call of a task-list tool: the whole list it wrote (TodoWrite, the
 * desktop app's list), or a task it added or changed (TaskCreate, TaskUpdate). Undefined for any
 * other call, which leaves the plan as it was.
 */
export function agentPlanAfter(steps: readonly PlanStep[], tool: string, input: Record<string, unknown>, output: unknown): PlanStep[] | undefined {
  if (tool === 'TodoWrite') return Array.isArray(input.todos) ? input.todos.flatMap(toStep).slice(0, AGENT_PLAN_MAX) : undefined
  if (tool === DESKTOP_PLAN_TOOL) return applyPlanUpdate(steps, readPlanUpdate(input)).slice(0, AGENT_PLAN_MAX)
  if (tool === 'TaskCreate') return created(steps, input, output)
  if (tool === 'TaskUpdate' && typeof input.taskId === 'string') return updated(steps, input.taskId, input)
  return undefined
}

function created(steps: readonly PlanStep[], input: Record<string, unknown>, output: unknown): PlanStep[] | undefined {
  const task = output && typeof output === 'object' ? (output as { task?: { id?: unknown; subject?: unknown } }).task : undefined
  const subject = typeof task?.subject === 'string' ? task.subject : typeof input.subject === 'string' ? input.subject : ''
  if (!subject.trim()) return undefined
  // the id is in the result, as a field or in its words ("Task #3 created")
  const id = typeof task?.id === 'string' ? task.id : typeof output === 'string' ? TASK_NUMBER.exec(output)?.[1] : undefined
  return [...steps, { text: subject.trim(), status: 'pending' as const, ...(id ? { id } : {}) }].slice(0, AGENT_PLAN_MAX)
}

function updated(steps: readonly PlanStep[], id: string, input: Record<string, unknown>): PlanStep[] {
  if (input.status === 'deleted') return steps.filter(step => step.id !== id)
  const status = typeof input.status === 'string' && STATUSES.includes(input.status) ? (input.status as StepStatus) : undefined
  const text = typeof input.subject === 'string' && input.subject.trim() ? input.subject.trim() : undefined
  return steps.map(step => (step.id === id ? { ...step, ...(text ? { text } : {}), ...(status ? { status } : {}) } : step))
}
