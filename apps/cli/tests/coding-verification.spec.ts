import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as WorkspaceChanges from '@deepseek-ai/dsh-workspace-changes'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Verification from '../config/examples/coding-verification.ts'

async function setup(maxTurnSteps = 12) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-verify-'))
  onTestFinished(() => rm(workspace, { recursive: true, force: true }))
  const cwd = await realpath(workspace)
  execFileSync('git', ['init', '-q', cwd])
  await mkdir(join(cwd, 'packages', 'a'), { recursive: true })
  await mkdir(join(cwd, 'packages', 'b'), { recursive: true })
  const file = join(cwd, 'packages', 'a', 'feature.ts')
  await writeFile(file, 'export const value = 0\n')

  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(WorkspaceChanges)
  const plugin = await ctx.plugin(Verification, { runtimeReminder: true, maxTurnSteps })
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(brandString<SessionId>('verify'), {}, { cwd })
  const steer = vi.spyOn(agent, 'steer').mockImplementation(() => {})
  onTestFinished(() => { steer.mockRestore() })

  let edits = 0
  let exitCode = 0
  let checkCwd = cwd
  ctx.tools.register(defineTool({
    name: 'edit', description: 'Edit a fixture file', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute() {
      await writeFile(file, `export const value = ${++edits}\n`)
      return 'Edited the fixture'
    },
  }))
  ctx.tools.register(defineTool({
    name: 'bash', description: 'Return a foreground shell outcome',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'fixture output' }] },
    async execute() { return { kind: 'foreground', exitCode, cwd: checkCwd, signal: null, timedOut: false, aborted: false } },
  }))

  let call = 0
  const run = async (turn: number, name: string, args: object = {}) => {
    const outcome = await ctx.tools.execute({
      agent, log: { turn, step: 1 }, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: brandString<ToolCallId>(`call-${++call}`), name, arguments: JSON.stringify(args) }],
    })
    expect(outcome.results[0]?.result.isError).toBe(false)
  }
  return {
    plugin, steer, ctx,
    open(turn: number) {
      agent.session.append('turn/start', { turn })
      agent.session.append('step/start', { turn, step: 1 })
    },
    close(turn: number) {
      agent.session.append('step/end', { turn, step: 1 })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    },
    edit: (turn: number) => run(turn, 'edit'),
    async check(turn: number, command = 'pnpm exec vitest run example.spec.ts', status = 0, workdir = '.') {
      exitCode = status
      checkCwd = join(cwd, workdir)
      await run(turn, 'bash', { command })
    },
    stop: (turn: number, signal = new AbortController().signal) => ctx.serial('agent/turn-stopping', { agent, turn, signal }),
  }
}

it('reminds once per changed turn and identifies the reminder as automation', async () => {
  const fixture = await setup()
  for (const turn of [1, 2]) {
    fixture.open(turn)
    await fixture.edit(turn)
    await fixture.stop(turn)
    await fixture.stop(turn)
    fixture.close(turn)
    expect(fixture.steer).toHaveBeenCalledTimes(turn)
  }
  expect(fixture.steer.mock.calls[0]?.[0].source.kind).toBe('coding-verification')
})

it.each([0, 1])('counts a settled check with exit code %i after the edit', async (exitCode) => {
  const fixture = await setup()
  fixture.open(1)
  await fixture.edit(1)
  await fixture.check(1, undefined, exitCode)
  await fixture.stop(1)
  expect(fixture.steer).not.toHaveBeenCalled()
})

it.each(['before-edit', 'quoted-echo', 'unavailable'])('does not count %s as post-edit verification', async (scenario) => {
  const fixture = await setup()
  fixture.open(1)
  if (scenario === 'before-edit') await fixture.check(1)
  await fixture.edit(1)
  if (scenario === 'quoted-echo') await fixture.check(1, 'echo "pnpm test"')
  if (scenario === 'unavailable') await fixture.check(1, undefined, 127)
  await fixture.stop(1)
  expect(fixture.steer).toHaveBeenCalledOnce()
})

it.each([
  ['packages/a', 0],
  ['packages/b', 1],
] as const)('scopes verification to the changed package when checking from %s', async (workdir, reminders) => {
  const fixture = await setup()
  fixture.open(1)
  await fixture.edit(1)
  await fixture.check(1, undefined, 0, workdir)
  await fixture.stop(1)
  expect(fixture.steer).toHaveBeenCalledTimes(reminders)
})

it('skips turns with no net change, aborted stops, and disposed observers', async () => {
  const fixture = await setup()
  fixture.open(1)
  await fixture.check(1)
  await fixture.stop(1)
  await fixture.edit(1)
  await fixture.stop(1, AbortSignal.abort())
  await fixture.plugin.dispose()
  await fixture.stop(1)
  expect(fixture.steer).not.toHaveBeenCalled()
  const prompt = await fixture.ctx.systemPrompt.assemble()
  expect(prompt.sections.some(section => section.name === Verification.name)).toBe(false)
})

it('skips an otherwise eligible turn that reached the configured step bound', async () => {
  const fixture = await setup(1)
  fixture.open(1)
  await fixture.edit(1)
  await fixture.stop(1)
  expect(fixture.steer).not.toHaveBeenCalled()
})
