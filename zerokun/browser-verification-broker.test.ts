import { describe, expect, test } from 'bun:test'
import {
  parseLocalPageAddress,
  parsePngDimensions,
} from './browser-verification-broker.ts'

describe('local browser verifier input contract', () => {
  test('accepts only explicit high localhost HTTP ports', () => {
    expect(parseLocalPageAddress('http://127.0.0.1:8765/hello?mode=test')).toMatchObject({
      origin: 'http://127.0.0.1:8765',
      port: 8765,
    })
    expect(parseLocalPageAddress('http://localhost:3000/').origin)
      .toBe('http://localhost:3000')
  })

  test.each([
    'https://127.0.0.1:8765/',
    'http://example.com:8765/',
    'http://127.0.0.1/',
    'http://127.0.0.1:80/',
    'http://user:pass@127.0.0.1:8765/',
    'http://127.0.0.1:8765/#secret',
    'http://127.0.0.1:8765/?token=abcdefghijklmnop',
    'file:///tmp/index.html',
    'data:text/html,hello',
  ])('rejects unsafe address %s', value => {
    expect(() => parseLocalPageAddress(value)).toThrow()
  })
})

describe('local browser screenshot evidence', () => {
  test('reads bounded IHDR dimensions', () => {
    const png = Buffer.alloc(33)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0)
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(1280, 16)
    png.writeUInt32BE(720, 20)
    expect(parsePngDimensions(png)).toEqual({ width: 1280, height: 720 })
  })

  test('rejects non-PNG and impossible dimensions', () => {
    expect(() => parsePngDimensions(Buffer.from('not a png'))).toThrow()
    const png = Buffer.alloc(33)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0)
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(0, 16)
    png.writeUInt32BE(720, 20)
    expect(() => parsePngDimensions(png)).toThrow()
  })
})
