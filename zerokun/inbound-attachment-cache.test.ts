import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import {
  chmodSync,
  closeSync,
  constants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadCachedInboundAttachment,
  removeRenamedInboundAttachment,
  verifyInboundDownloadBeforeRename,
  writeAllSync,
} from './inbound-attachment-cache.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; inbox: string; message: string } {
  const root = mkdtempSync(join(tmpdir(), 'zero-inbound-cache-'))
  roots.push(root)
  chmodSync(root, 0o700)
  const inbox = join(root, 'inbox')
  const message = join(inbox, '1900000000.000100')
  mkdirSync(message, { recursive: true, mode: 0o700 })
  return { root, inbox, message }
}

describe('durable inbound attachment cache', () => {
  test('short writeを最後まで再試行しSlack metadataのsizeとrename前に照合する', () => {
    const { message } = fixture()
    const temporary = join(message, 'FWRITE123.bin.partial-test')
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    const content = Buffer.from('partial writes still complete')
    writeAllSync(descriptor, content, (fd, buffer, offset, length) => (
      writeSync(fd, buffer, offset, Math.min(3, length))
    ))
    const identity = verifyInboundDownloadBeforeRename(
      descriptor,
      content.byteLength,
      content.byteLength,
    )
    expect(identity.dev).toBeNumber()
    expect(identity.ino).toBeNumber()
    closeSync(descriptor)
    expect(readFileSync(temporary)).toEqual(content)

    const mismatch = join(message, 'FMISMATCH.bin.partial-test')
    const mismatchDescriptor = openSync(
      mismatch,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    writeSync(mismatchDescriptor, Buffer.from('short'))
    expect(() => verifyInboundDownloadBeforeRename(mismatchDescriptor, 5, 6))
      .toThrow('size does not match Slack metadata')
    closeSync(mismatchDescriptor)
  })

  test('rename後verification失敗ではexact inodeだけを削除する', () => {
    const { message } = fixture()
    const temporary = join(message, 'FREMOVE123.bin.partial-test')
    const destination = join(message, 'FREMOVE123.bin')
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    writeSync(descriptor, Buffer.from('completed'))
    const identity = verifyInboundDownloadBeforeRename(descriptor, 9, 9)
    closeSync(descriptor)
    renameSync(temporary, destination)
    expect(removeRenamedInboundAttachment(destination, identity)).toBe(true)
    expect(() => readFileSync(destination)).toThrow()

    writeFileSync(destination, 'replacement', { mode: 0o600 })
    expect(removeRenamedInboundAttachment(destination, identity)).toBe(false)
    expect(readFileSync(destination, 'utf8')).toBe('replacement')
  })

  test('rename済みfileをmanifestなしでadoptし再起動後はdigest一致で再利用する', () => {
    const { inbox, message } = fixture()
    const path = join(message, 'FABC123.txt')
    writeFileSync(path, 'completed attachment', { mode: 0o600 })
    const adopted = loadCachedInboundAttachment({
      inboxDir: inbox,
      messageTs: '1900000000.000100',
      fileId: 'FABC123',
      ordinal: 0,
    })!
    expect(adopted).toEqual({
      fileId: 'FABC123',
      ordinal: 0,
      path,
      size: Buffer.byteLength('completed attachment'),
      digest: createHash('sha256').update('completed attachment').digest('hex'),
    })
    expect(loadCachedInboundAttachment({
      inboxDir: inbox,
      messageTs: '1900000000.000100',
      fileId: 'FABC123',
      ordinal: 0,
      manifest: adopted,
    })).toEqual(adopted)
  })

  test('manifest後の改変・hardlink・symlink・partialを再利用しない', () => {
    const { root, inbox, message } = fixture()
    const path = join(message, 'FSAFE123.bin')
    writeFileSync(path, 'safe', { mode: 0o600 })
    const manifest = loadCachedInboundAttachment({
      inboxDir: inbox,
      messageTs: '1900000000.000100',
      fileId: 'FSAFE123',
      ordinal: 0,
    })!
    writeFileSync(path, 'evil', { mode: 0o600 })
    expect(() => loadCachedInboundAttachment({
      inboxDir: inbox,
      messageTs: '1900000000.000100',
      fileId: 'FSAFE123',
      ordinal: 0,
      manifest,
    })).toThrow('does not match its manifest')

    const hardlink = join(message, 'FHARD123.bin')
    linkSync(path, hardlink)
    expect(() => loadCachedInboundAttachment({
      inboxDir: inbox,
      messageTs: '1900000000.000100',
      fileId: 'FHARD123',
      ordinal: 1,
    })).toThrow('metadata is unsafe')

    const symlink = join(message, 'FSYM123.bin')
    symlinkSync(join(root, 'outside'), symlink)
    expect(() => loadCachedInboundAttachment({
      inboxDir: inbox,
      messageTs: '1900000000.000100',
      fileId: 'FSYM123',
      ordinal: 2,
    })).toThrow('cannot be opened safely')

    writeFileSync(join(message, 'FPART123.bin.partial-1'), 'partial', { mode: 0o600 })
    expect(loadCachedInboundAttachment({
      inboxDir: inbox,
      messageTs: '1900000000.000100',
      fileId: 'FPART123',
      ordinal: 3,
    })).toBeNull()
  })
})
