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
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, get, type IncomingMessage } from 'http'
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
  const body = Buffer.from('name,value\n日本語,1\n')
  const bom = Buffer.from([0xef, 0xbb, 0xbf])

  async function receiveHttp(
    target: ReturnType<typeof fixture>,
    bytes: Buffer,
    metadataSize: number,
    framing: 'length' | 'chunked',
    interrupt?: 'truncated' | 'abort',
  ) {
    const server = createServer(async (_request, response) => {
      response.writeHead(200, framing === 'length'
        ? { 'Content-Length': bytes.length + (interrupt === 'truncated' ? 3 : 0) }
        : { 'Transfer-Encoding': 'chunked' })
      for (const chunk of [bytes.subarray(0, 1), bytes.subarray(1, 2), bytes.subarray(2)]) {
        if (response.destroyed) return
        response.write(chunk)
        await Bun.sleep(5)
      }
      if (interrupt === 'truncated') response.socket?.end()
      else response.end()
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address() as { port: number }
    const controller = new AbortController()
    const temporary = join(target.message, 'FBOM123.txt.partial-test')
    const destination = join(target.message, 'FBOM123.txt')
    let descriptor: number | undefined
    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = get(`http://127.0.0.1:${address.port}/`, { signal: controller.signal }, resolve)
        request.on('error', reject)
      })
      descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      let received = 0
      for await (const chunk of response) {
        received += chunk.byteLength
        writeAllSync(descriptor, chunk)
        if (interrupt === 'abort') controller.abort()
      }
      verifyInboundDownloadBeforeRename(descriptor, received, metadataSize, response)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, destination)
      return loadCachedInboundAttachment({
        inboxDir: target.inbox, messageTs: '1900000000.000100', fileId: 'FBOM123', ordinal: 0,
      })!
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      rmSync(temporary, { force: true })
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }

  for (const framing of ['length', 'chunked'] as const) {
    test.each([
      ['BOM added', Buffer.concat([bom, body]), body.length],
      ['BOM removed', body, bom.length + body.length],
      ['BOM retained', Buffer.concat([bom, body]), bom.length + body.length],
      ['plain text', body, body.length],
      ['empty', Buffer.alloc(0), 0],
      ['binary', Buffer.from([0xff, 0xfe, 0, 0, 0x81, 0xff]), 6],
    ] as const)(`HTTP ${framing} preserves actual bytes and cache across restart: %s`, async (_label, bytes, metadataSize) => {
      const target = fixture()
      const downloaded = await receiveHttp(target, bytes, metadataSize, framing)
      expect(downloaded.size).toBe(bytes.length)
      expect(readFileSync(downloaded.path)).toEqual(bytes)
      expect(downloaded.digest).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(loadCachedInboundAttachment({
        inboxDir: target.inbox, messageTs: '1900000000.000100', fileId: 'FBOM123', ordinal: 0,
        manifest: JSON.parse(JSON.stringify(downloaded)),
      })).toEqual(downloaded)
    })
  }

  test.each([
    ['length', 'truncated'], ['chunked', 'truncated'],
    ['length', 'abort'], ['chunked', 'abort'],
  ] as const)('incomplete HTTP download is not published: %s/%s', async (framing, interrupt) => {
    const target = fixture()
    // Matching catalog size does not make a truncated HTTP representation valid.
    await expect(receiveHttp(target, body, body.length, framing, interrupt)).rejects.toThrow()
    expect(readdirSync(target.message)).toEqual([])
    expect(loadCachedInboundAttachment({
      inboxDir: target.inbox, messageTs: '1900000000.000100', fileId: 'FBOM123', ordinal: 0,
    })).toBeNull()
  })

  test('HTTP framing and complete response are checked even when catalog size matches', () => {
    const target = fixture()
    const path = join(target.message, 'file')
    writeFileSync(path, body, { mode: 0o600 })
    const descriptor = openSync(path, constants.O_RDONLY)
    const valid = { statusCode: 200, headers: { 'content-length': String(body.length) }, complete: true, aborted: false }
    try {
      for (const invalid of [
        { ...valid, statusCode: 206 },
        { ...valid, statusCode: 204 },
        { ...valid, complete: false },
        { ...valid, aborted: true },
        { ...valid, headers: { 'content-range': 'bytes 0-22/26' } },
        { ...valid, headers: { 'content-length': String(body.length + 3) } },
        { ...valid, headers: { 'content-length': String(body.length - 3) } },
        { ...valid, headers: { 'content-length': 'invalid' } },
        { ...valid, headers: { 'content-length': '-1' } },
        { ...valid, headers: { 'content-length': String(50 * 1024 * 1024 + 1) } },
        { ...valid, headers: { 'content-length': String(body.length), 'transfer-encoding': 'chunked' } },
        { ...valid, headers: { 'content-encoding': 'gzip' } },
        { ...valid, headers: { 'transfer-encoding': 'gzip, chunked' } },
      ]) {
        expect(() => verifyInboundDownloadBeforeRename(descriptor, body.length, body.length, invalid)).toThrow()
      }
      expect(() => verifyInboundDownloadBeforeRename(descriptor, body.length, 50 * 1024 * 1024 + 1, valid)).toThrow()
      expect(() => verifyInboundDownloadBeforeRename(descriptor, 50 * 1024 * 1024 + 1, undefined, valid)).toThrow()
      // Close-delimited responses retain the metadata check; no +/-3 exception.
      expect(() => verifyInboundDownloadBeforeRename(descriptor, body.length, body.length + 3, { ...valid, headers: {} })).toThrow()
      expect(verifyInboundDownloadBeforeRename(descriptor, body.length, body.length, { ...valid, headers: {} })).toHaveProperty('ino')
    } finally { closeSync(descriptor) }
  })

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
      path: realpathSync(path),
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
