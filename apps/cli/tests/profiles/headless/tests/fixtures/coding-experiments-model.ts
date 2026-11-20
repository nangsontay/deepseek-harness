/** Keyless model request checks for the real headless agent and tool pipeline. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk, type ToolCallId,
} from '@deepseek-ai/dsh-llm'

const patch = '*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch'
const bash = { command: "printf 'PREVIEW-HEAD\\n%070000d\\nPREVIEW-TAIL\\n' 0", description: 'Print a long diagnostic stream' }

class CodingExperimentsAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const results = options.messages.filter(message => message.role === 'tool' && message.toolCallId.startsWith('coding-experiment-'))
    const reminders = options.messages.filter(message => message.role === 'user'
      && JSON.stringify(message.content).includes('workspace recorder found changes'))
    assert.ok(reminders.length <= 1, 'verification reminder repeated')
    const step = results.length + reminders.length
    const tools = options.tools?.map(tool => tool.name) ?? []
    const ptc = tools.includes('run_code')
    const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
    assert.match(system, /keep the original indentation/)
    assert.match(system, /run the narrowest relevant tests/)
    if (ptc) {
      assert.match(system, /job_wait/)
      assert.match(system, /apply_patch/)
    } else {
      assert.ok(tools.includes('job_wait'))
      assert.ok(tools.includes('apply_patch'))
    }
    const previous = results.at(-1)
    if (results.length > 0) assert.ok(previous?.role === 'tool' && previous.isError !== true)
    if (results.length === 2) {
      assert.ok(previous?.role === 'tool' && previous.isError !== true)
      const content = JSON.stringify(previous.content)
      assert.ok(content.includes('PREVIEW-HEAD'), `missing preview head: ${content.slice(0, 180)}`)
      assert.ok(content.includes('PREVIEW-TAIL'), `missing preview tail: ${content.slice(-180)}`)
    }
    if (results.length === 3) assert.match(JSON.stringify(previous?.content), /no active jobs|no-active-jobs/)
    if (step >= 3) {
      const text = step === 3 ? 'Changes complete.' : 'Verification unavailable in the fixture.'
      assert.ok(step <= 4, 'verification reminder repeated')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const call = [
      { name: 'apply_patch', args: { input: patch }, description: 'Apply two file additions',
        code: `await tools.apply_patch(${JSON.stringify({ input: patch })});` },
      { name: 'bash', args: bash, description: bash.description,
        code: `const r = await tools.bash(${JSON.stringify(bash)}); if (r.kind === 'foreground') console.log(r.stdout.text.slice(0, 18), r.stdout.text.slice(-18));` },
      { name: 'job_wait', args: { timeout_ms: 100 }, description: 'Collect a finished test job',
        code: 'console.log((await tools.job_wait({ timeout_ms: 100 })).outcome);' },
    ][step]!
    const name = ptc ? 'run_code' : call.name
    const args = ptc ? {
      description: call.description,
      code: call.code,
    } : call.args
    const raw = JSON.stringify(args)
    const id = brandString<ToolCallId>(`coding-experiment-${step}`)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'coding-experiments-model'
export const inject = ['llm']

/** Register the keyless test provider.
 * @param ctx - Cordis context containing the production LLM registry.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['coding-experiments'], new CodingExperimentsAdapter())
}
