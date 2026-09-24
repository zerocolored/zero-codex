import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveArtifactSource } from './artifact-source.ts'
import { ContinuedArtifactMessage } from './continued-artifact-message.ts'

test('nested proposals survive continuation while foreign and protected sources are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-source-'))
  try {
    const outbox = join(root, 'outbox'), scratch = join(root, 'scratch'), foreign = join(root, 'foreign')
    for (const path of [outbox, join(scratch, 'proposal'), foreign]) mkdirSync(path, { recursive: true })
    const image = join(scratch, 'proposal', 'after.png')
    writeFileSync(image, 'synthetic image')
    const message = `承認してください<zerokun_files>${JSON.stringify([image])}</zerokun_files>`
    const continued = new ContinuedArtifactMessage(outbox, [scratch])
    continued.observe(message, 1)
    expect(continued.resolve('待機中', 1, 'blocked')).toBe(message)
    const partial = `比較案<zerokun_files>${JSON.stringify([image, join(outbox, 'missing.png')])}</zerokun_files>`
    continued.observe(partial, 2)
    expect(continued.resolve('待機中', 2, 'blocked')).toBe(partial)
    continued.observe(message, 1)
    const alias = join(root, 'alias')
    symlinkSync(scratch, alias)
    expect(resolveArtifactSource(join(alias, 'proposal', 'after.png'), [scratch])).toBe(realpathSync(image))
    symlinkSync(foreign, join(scratch, 'escape'))
    expect(() => resolveArtifactSource(join(scratch, 'escape', 'data.txt'), [scratch])).toThrow('outside')
    expect(() => resolveArtifactSource(join(scratch, '.env'), [scratch])).toThrow('protected')
    expect(() => resolveArtifactSource(join(foreign, 'data.txt'), [scratch])).toThrow('outside')
    writeFileSync(image, 'changed image')
    expect(continued.resolve('待機中', 1, 'blocked')).toBe('待機中')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
