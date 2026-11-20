/** Check the experimental overlays together through the shipped launcher and tool pipeline. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../../../', import.meta.url))
const examples = join(root, 'apps/cli/config/examples')
const configPath = fileURLToPath(new URL('./fixtures/coding-experiments.patch.yml', import.meta.url))

describe.skipIf(process.platform === 'win32')('headless coding experiment overlays', () => {
  it.each(['native', 'ptc'])('works through the %s executor', async (mode) => {
    const paths = [
      configPath,
      ...(mode === 'ptc' ? [join(examples, 'ptc.yml')] : []),
      ...['file-editing', 'shell-preview', 'wait-any-job', 'verification-reminder'].map(
        name => join(examples, 'coding-experiments', `${name}.yml`),
      ),
    ]
    const { stdout, stderr } = await runLoaderSmoke({
      label: `coding experiments (${mode})`,
      tempDirPrefix: 'dsh-coding-experiments-',
      binScript: join(root, 'apps/cli/src/bin.ts'),
      sourceImport: 'tsx/esm',
      configPath,
      binArgs: ['--profile', 'headless', ...paths.flatMap(path => ['--patch', path]), 'Exercise the coding overlays.'],
      tsconfigPath: join(root, 'tsconfig.json'),
      env: { DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1' },
      processTimeoutMs: 40_000,
      inspect: async (cwd) => {
        expect(await readFile(join(cwd, 'first.txt'), 'utf8')).toBe('first\n')
        expect(await readFile(join(cwd, 'second.txt'), 'utf8')).toBe('second\n')
      },
    })
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('Verification unavailable in the fixture.')
  }, 50_000)
})
