import { describe, expect, test } from 'bun:test'
import {
  buildLaunchServicesChromeCommand,
  isExpectedLaunchServicesChromeCommand,
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

describe('macOS LaunchServices browser isolation', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = '/private/tmp/zero browser/profile'
  const screenshot = '/private/tmp/zero browser/screenshot.png'

  test('launches a fresh app without the blocking wait/background modes', () => {
    const command = buildLaunchServicesChromeCommand({
      browserHome: '/Users/example',
      runRoot: '/private/tmp/zero browser',
      profile,
      stdoutPath: '/private/tmp/zero browser/browser.stdout',
      stderrPath: '/private/tmp/zero browser/browser.stderr',
      screenshotPath: screenshot,
      proxyPort: 45678,
      address: parseLocalPageAddress('http://127.0.0.1:8765/hello'),
    })
    expect(command.slice(0, 5)).toEqual([
      '/usr/bin/open', '-n', '-a', '/Applications/Google Chrome.app', '-i',
    ])
    expect(command).not.toContain('-W')
    expect(command).not.toContain('-g')
    expect(command).toContain('HOME=/Users/example')
    expect(command).toContain('TMPDIR=/private/tmp/zero browser')
    expect(command).toContain('--headless')
    expect(command).not.toContain('--headless=new')
    expect(command).toContain('--timeout=5000')
    expect(command).toContain(`--user-data-dir=${profile}`)
    expect(command).toContain(`--screenshot=${screenshot}`)
    expect(command).toContain('--proxy-server=http://127.0.0.1:45678')
    expect(command).toContain('--proxy-bypass-list=<-loopback>;127.0.0.1:8765')
    expect(command.at(-1)).toBe('http://127.0.0.1:8765/hello')
  })

  test('recognizes only the exact isolated Chrome root command', () => {
    const root = `${chrome} --headless --user-data-dir=${profile} --screenshot=${screenshot} http://127.0.0.1:8765/`
    expect(isExpectedLaunchServicesChromeCommand({
      command: root, chrome, profile, screenshot,
    })).toBe(true)
    for (const command of [
      `${root} --type=renderer`,
      root.replace('--headless ', '--headless=new '),
      root.replace(chrome, '/tmp/Google Chrome'),
      root.replace(profile, `${profile}-other`),
      root.replace(screenshot, `${screenshot}.other`),
    ]) {
      expect(isExpectedLaunchServicesChromeCommand({
        command, chrome, profile, screenshot,
      })).toBe(false)
    }
  })
})
