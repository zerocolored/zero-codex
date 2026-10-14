import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import fixture from './fixtures/browser-dialog-transport.json'
import { browserDialogCompatibility } from './browser-dialog-compat.ts'

function transport(patched = true) {
  const original = `class Transport { ${fixture.methods.join('\n')} }; Transport`
  const result = browserDialogCompatibility(original)
  expect(result.applied).toBe(true)
  const Transport = runInNewContext(patched ? result.source : original, {
    It() {}, pt: () => false, uf: (promise: Promise<unknown>) => promise,
    lf: () => 1000, ta: () => 1000, PB: () => 'Page', cJ: () => ({}),
    EB: (_: unknown, prepare: () => unknown) => prepare(),
    hJ: (a: { tabId: number }, b: { tabId: number }) => a.tabId === b.tabId,
    lJ: () => false,
  })
  const t = new Transport()
  Object.assign(t, {
    attachedTabIds: new Set(), initializingTabIds: new Set(),
    tabAttachmentPromises: new Map(), jsDialogsByTabId: new Map(),
    events: [] as string[], open: false, accepted: 0, dismissed: 0,
    performanceSpan: { currentCommandAttrs: () => ({}), withSpan: (_: unknown, __: unknown, f: () => unknown) => f() },
    emit: () => {},
    attachedTabIdForCdpEvent: (target: { tabId: number }) => t.attachedTabIds.has(target.tabId) ? target.tabId : undefined,
    runTabAttachHandlers: async () => { t.events.push('handlers') },
    enableFocusEmulation: async () => {
      t.events.push('focus')
      if (t.open) throw new Error('Timed out: Emulation.setFocusEmulationEnabled')
    },
    forgetAttachedTab: (id: number) => {
      t.attachedTabIds.delete(id); t.tabAttachmentPromises.delete(id); t.jsDialogsByTabId.delete(id)
    },
    throwIfJsDialogBlocksMethod: (id: number, method: string) => {
      if (method !== 'Page.handleJavaScriptDialog' && t.jsDialogsByTabId.has(id)) throw new Error('dialog active')
    },
  })
  t.api = {
    attach: async () => { t.events.push('attach') },
    executeCdp: async (request: any) => {
      t.events.push(request.method)
      t.lastRequest = request
      if (request.method === 'Page.enable' && t.open) {
        t.jsDialogsByTabId.set(request.target.tabId, { id: 'dialog-1', target: request.target })
      }
      if (request.method === 'Input.dispatchMouseEvent') {
        t.open = true
        t.jsDialogsByTabId.set(request.target.tabId, { id: 'dialog-1', target: request.target })
        if (!request.preserveDebuggerOnTimeout) t.attachedTabIds.delete(request.target.tabId)
        throw new Error('Timed out: Input.dispatchMouseEvent')
      }
      if (request.method === 'Page.handleJavaScriptDialog') {
        expect(request.preserveDebuggerOnTimeout).toBe(true)
        if (!t.open) throw new Error('no dialog')
        t.open = false
        if (request.commandParams.accept) t.accepted++; else t.dismissed++
        t.deleteJsDialogForTarget(request.target)
      }
      return {}
    },
  }
  return t
}

describe('official Chrome dialog compatibility', () => {
  test('reproduces the original focus-before-dialog deadlock', async () => {
    const t = transport(false); t.open = true
    await expect(t.ensureAttachedTab(4)).rejects.toThrow('Emulation.setFocusEmulationEnabled')
    expect(t.events).toEqual(['attach', 'focus'])
  })
  test('click timeout preserves the attachment and never replays the click', async () => {
    const t = transport()
    await expect(t.executeTargetCdp({ tabId: 4 }, 'Input.dispatchMouseEvent', { type: 'mouseReleased' })).rejects.toThrow('Input.dispatchMouseEvent')
    expect(t.attachedTabIds.has(4)).toBe(true)
    await t.executeTargetCdp({ tabId: 4 }, 'Page.handleJavaScriptDialog', { accept: true })
    expect(t.accepted).toBe(1)
    expect(t.events.filter((v: string) => v === 'Input.dispatchMouseEvent')).toHaveLength(1)
    expect(t.events.filter((v: string) => v === 'focus')).toHaveLength(1)
  })
  test('ordinary commands keep normal focus and attachment handling', async () => {
    const t = transport()
    await t.executeTargetCdp({ tabId: 4 }, 'Runtime.evaluate', {})
    expect(t.events).toEqual(['attach', 'focus', 'handlers', 'Runtime.evaluate'])
    expect(t.lastRequest.preserveDebuggerOnTimeout).toBeUndefined()
  })
  test('a pending modal still blocks ordinary commands to its tab', async () => {
    const t = transport(); t.attachedTabIds.add(4); t.open = true
    t.jsDialogsByTabId.set(4, { id: 'dialog-1', target: { tabId: 4 } })
    await expect(t.executeTargetCdp({ tabId: 4 }, 'Runtime.evaluate', {})).rejects.toThrow('dialog active')
    expect(t.events).toEqual([])
  })
  test('keyboard-triggered dialogs also preserve the same connection', async () => {
    const t = transport()
    await t.executeTargetCdp({ tabId: 4 }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' })
    expect(t.lastRequest.preserveDebuggerOnTimeout).toBe(true)
  })
  test('unknown, partial, duplicate and already-fixed distributions stay unchanged', () => {
    const original = fixture.methods.join('\n')
    const once = browserDialogCompatibility(original)
    for (const source of ['', original.replace('timeoutMs:c', 'timeoutMs:other'), original + original, once.source]) {
      expect(browserDialogCompatibility(source)).toEqual({ source, applied: false })
    }
  })
  test('a distribution with a renamed CDP method variable is left intact', () => {
    const source = fixture.methods.join('\n').replace('method:n,commandParams:o??{}', 'method:renamedMethod,commandParams:o??{}')
    expect(browserDialogCompatibility(source)).toEqual({ source, applied: false })
  })
})
