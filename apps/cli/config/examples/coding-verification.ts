/** Optional guidance and a bounded end-of-turn verification reminder. */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage, lastAssistantStreamChunk, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { RUN_CODE_NAME, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace-changes'

/** Stable Loader identity. */
export const name = 'coding-verification'
/** Prompt registry. Runtime overlays also inject the workspace-change service. */
export const inject = ['systemPrompt']

export interface Config {
  /** Steer once when a changed turn has no observed post-edit verification attempt. */
  runtimeReminder: boolean
  /** Skip steering at or above this many model steps in the current turn. */
  maxTurnSteps: number
}

/** Loader configuration for the optional reminder. */
export const Config: z<Config> = z.object({
  runtimeReminder: z.boolean().default(false),
  maxTurnSteps: z.number().default(12),
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'coding-verification': { kind: 'coding-verification' } & ContextFormed
  }
}

const GUIDANCE = 'For code changes, run the narrowest relevant tests or checks after the final edit when the user’s instructions and available permissions allow. Broaden coverage when shared behavior changes. Report the checks you actually ran and their outcomes, including checks you could not run and why.'
const REMINDER = 'The workspace recorder found changes in this turn, and the available tool evidence does not establish a verification attempt after the latest possible edit. If appropriate and authorized, run the smallest relevant check before finishing. If you already ran it or cannot run it, report the outcome or blocker without repeating checks unnecessarily.'

interface Turn {
  turn: number
  steps: number
  writes: number
  verification: Map<string, number>
  changes?: SessionSeq
  maxTokens: boolean
  reminded: boolean
}

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'glob', 'list_tools', 'get_tool_schema', RUN_CODE_NAME])
const NON_CHECK_FLAGS = [
  /(?:^| )(?:--help|--version|--list(?:Tests|-tests)?|--collect-only|--dry-run|-h)(?=[ =]|$)/,
  /(?:^| )(?:--watch(?:All)?|--update(?:Snapshot)?|-u)(?=[ =]|$)/,
]
const CHECK_COMMANDS = [
  /^(?:npm|pnpm|yarn|bun) (?:run )?test(?::[\w:-]+)?(?: |$)/,
  /^(?:(?:npm|pnpm|bun) exec |npx |(?:\.\/)?node_modules\/\.bin\/)?(?:vitest run|jest|pytest)(?: |$)/,
  /^python3? -m pytest(?: |$)/,
  /^(?:go|cargo|dotnet|mvn|gradle|make) test(?: |$)/,
]

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVerification(exec: ToolExecution): boolean {
  if (exec.name !== 'bash' && exec.name !== 'pwsh') return false
  const args = exec.arguments
  if (!record(args) || typeof args.command !== 'string' || args.run_in_background === true) return false
  const command = args.command.trim()
  // shortcut: recognize simple foreground runners only, expand when structured command evidence is available.
  return /^[\w ./\\:@=,+%~-]+$/.test(command)
    && !NON_CHECK_FLAGS.some(pattern => pattern.test(command)) && CHECK_COMMANDS.some(pattern => pattern.test(command))
}

function verificationCwd(result: ToolExecutionResult): string | undefined {
  if (result.isError || !record(result.value)) return undefined
  const value = result.value
  if (value.kind !== 'foreground' || value.timedOut !== false || value.aborted !== false
    || value.signal !== null || value.stopped !== undefined || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)
    || (value.exitCode !== 0 && value.exitCode !== 1)
    || (record(value.sandbox) && (value.sandbox.denied === true || value.sandbox.runnerFailed === true))) return undefined
  // An ordinary test failure counts as an attempt, so the model can report it.
  return value.cwd
}

function inside(cwd: string, path: string): boolean {
  const fromRoot = relative(cwd, path)
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

/**
 * Contribute prompt guidance and install optional read-only turn observers.
 * @param ctx - context holding the prompt registry and optional workspace-change service.
 * @param config - whether to remind and the bound on eligible turn length.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.maxTurnSteps) || config.maxTurnSteps < 1) {
    throw new Error('coding-verification requires a positive integer maxTurnSteps')
  }
  const workspaceChanges = ctx.get('workspaceChanges')
  if (config.runtimeReminder && workspaceChanges === undefined) {
    throw new Error('coding-verification runtimeReminder requires workspaceChanges as a Loader injection')
  }
  ctx.systemPrompt.section({
    name,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    text: GUIDANCE,
  })
  if (!config.runtimeReminder || workspaceChanges === undefined) return

  const turns = new WeakMap<Session, Turn>()
  const checks = new WeakMap<ToolExecution, { state: Turn; writes: number }>()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      turns.set(session, {
        turn: event.data.turn, steps: 0, writes: 0, verification: new Map(), maxTokens: false, reminded: false,
      })
      return
    }
    const state = turns.get(session)
    if (state === undefined) return
    if (event.type === 'turn/end' && event.data.turn === state.turn) turns.delete(session)
    if (event.type === 'step/start' && event.data.turn === state.turn) state.steps++
    if (event.type === 'workspace/changes' && event.data.turn === state.turn) state.changes = event.seq
    if (event.type === 'assistant/message' && event.data.turn === state.turn
      && lastAssistantStreamChunk(event.data.stream, 'finish')?.reason.kind === 'max-tokens') state.maxTokens = true
  })
  ctx.on('session/disposed', (session) => { turns.delete(session) })

  // The shared executor traverses this pipeline for both Native calls and PTC subcalls.
  ctx.on('tools/execute', async (exec, next) => {
    const state = exec.agent === undefined ? undefined : turns.get(exec.agent.session)
    if (state === undefined || exec.signal.aborted || READ_ONLY_TOOLS.has(exec.name)) return next()
    if (isVerification(exec)) {
      checks.set(exec, { state, writes: state.writes })
      return next()
    }
    try {
      return await next()
    } finally {
      // Unknown tools or shell commands might write, even when the result is an error.
      state.writes++
    }
  })
  ctx.on('tools/result', (exec, result) => {
    const check = checks.get(exec)
    checks.delete(exec)
    if (check === undefined || exec.signal.aborted) return
    const cwd = verificationCwd(result)
    if (cwd !== undefined) {
      check.state.verification.set(cwd, Math.max(check.writes, check.state.verification.get(cwd) ?? -1))
    } else {
      // A detached or interrupted candidate may still have changed the workspace.
      check.state.writes++
    }
  })
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    const state = turns.get(agent.session)
    if (signal.aborted || state === undefined || state.turn !== turn || state.reminded || state.maxTokens
      || state.steps >= config.maxTurnSteps || state.changes === undefined) return
    const summary = workspaceChanges.summary(agent.session.id, state.changes)
    if (summary === undefined) return
    const workspaceFiles = summary.files.filter(file => !isAbsolute(file.display) && !file.display.startsWith('~/'))
    if (workspaceFiles.length === 0) return
    const checkRoots = [...state.verification].filter(([cwd, writes]) => writes === state.writes && inside(summary.cwd, cwd))
    if (state.writes > 0 && summary.files.length === summary.total && workspaceFiles.every(file =>
      checkRoots.some(([cwd]) => inside(cwd, resolve(summary.cwd, file.path))),
    )) return
    state.reminded = true
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: REMINDER }],
      source: { kind: 'coding-verification', form: 'notice', summary: 'Check verification before finishing' },
    }))
  })
}
