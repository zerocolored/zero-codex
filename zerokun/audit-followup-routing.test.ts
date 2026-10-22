import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore } from './job-runner.ts'
import { classifyFleetRequest, fleetRoutingContext, separateSecurityWorkflow } from './fleet-query.ts'
import { isSlackInterruptCommand, normalizeSlackInboundText } from './live-control.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const followup = 'この中で流出により、ローテーションなどをしないといけないものだけリストアップして'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'audit-followup-')); roots.push(root)
  const store = new JobStore(join(root, 'jobs.sqlite3'))
  const base = { chatId: 'C1', threadTs: '1.1', userId: 'U1', repoPath: root, writeEnabled: true }
  return { root, store, base }
}

test.each([undefined, JSON.stringify({ messages: [{ role: 'assistant', text: '既存の検査結果を添付しました。' }] })])(
  'routing includes completed audit state with or without a Slack snapshot', async snapshot => {
    const { store, base } = fixture()
    try {
      const prior = store.enqueue({ ...base, messageId: '1.1', task: 'セキュリティ検査して', workflow: 'security-audit' }).job
      store.claimNext('audit'); store.complete(prior.id, 'audit-session', '検査結果')
      store.enqueue({ ...base, messageId: '1.2', threadTs: 'other', task: 'OTHER_THREAD_PRIVATE' })
      store.enqueue({ ...base, messageId: '1.3', repoPath: '/other', task: 'OTHER_REPO_PRIVATE' })
      store.enqueue({ ...base, messageId: '1.4', chatId: 'OTHER', task: 'OTHER_CHAT_PRIVATE' })
      const context = fleetRoutingContext(snapshot, store.fleetTriageContext(base.chatId, base.threadTs, base.repoPath))
      const parsed = JSON.parse(context)
      expect(parsed.threadHistory.recentTasks).toEqual([{ task: 'セキュリティ検査して', workflow: 'security-audit', status: 'completed', terminalOutcome: 'completed' }])
      expect(parsed.recentConversation).toBe(snapshot ?? null)
      expect(context).not.toContain('PRIVATE')
      const route = await classifyFleetRequest(followup, context, async (prompt, _schema, options) => {
        expect(prompt).toContain('completed'); expect(prompt).toContain(followup)
        expect(options?.independent).toBe(true)
        return JSON.stringify({ route: 'work' })
      })
      const notesBefore = store.pendingStatusNotifications().length
      const next = store.enqueue({ ...base, messageId: '1.5', task: followup, workflow: route === 'security-audit' ? route : 'work' }).job
      expect(next.workflow).toBe('work')
      expect(store.previousSecurityAudit(next)).toBe(prior.id)
      expect(store.pendingStatusNotifications()).toHaveLength(notesBefore)
    } finally { store.close() }
  },
)

test('large Unicode and escaped history stays structured and retains workflow state within model budget', async () => {
  const { store, base } = fixture()
  try {
    for (let i = 0; i < 4; i++) {
      store.enqueue({ ...base, messageId: `1.${i + 1}`, task: '\u0000日😀"\\'.repeat(10000), workflow: 'security-audit' })
    }
    const context = fleetRoutingContext('old conversation'.repeat(10000) + 'RECENT_REPORT', store.fleetTriageContext(base.chatId, base.threadTs, base.repoPath))
    const parsed = JSON.parse(context)
    expect(parsed.threadHistory.recentTasks).toHaveLength(4)
    expect(parsed.threadHistory.recentTasks.every((row: any) => row.workflow === 'security-audit' && row.status === 'queued')).toBe(true)
    expect(parsed.recentConversation.endsWith('RECENT_REPORT')).toBe(true)
    await classifyFleetRequest('日😀"\\'.repeat(10000), context, async prompt => {
      expect(Buffer.byteLength(prompt)).toBeLessThan(100000)
      expect(prompt).toContain('threadHistory')
      return '{"route":"work"}'
    })
  } finally { store.close() }
})

test('setup wait accepts exact cancellation and then ordinary report discussion can run', () => {
  const { store, base } = fixture()
  try {
    const report = store.enqueue({ ...base, messageId: '1.1', task: '検査して', workflow: 'security-audit' }).job
    store.claimNext('first'); store.complete(report.id, 'audit-session', '検査結果')
    const mistaken = store.enqueue({ ...base, messageId: '1.2', task: followup, workflow: 'security-audit' }).job
    store.claimNext('mistaken'); store.parkAuditSetup(mistaken.id, '設定を教えてください', 1)
    const target = store.liveControlTarget(base.chatId, base.threadTs)!
    expect(target.jobId).toBe(mistaken.id)
    const ordinary = store.enqueue({ ...base, messageId: '1.4', task: '既存レポートの項目だけ説明して', workflow: 'work' }).job
    expect(store.claimNext('still-waiting')).toBeNull()
    const text = normalizeSlackInboundText('<@UZERO> 中止', 'UZERO', false)
    expect(isSlackInterruptCommand(text)).toBe(true)
    expect(separateSecurityWorkflow('work', 'security-audit', true)).toBe(false)
    expect(store.stageLiveControl(target, { ...base, messageId: '1.3', task: text, kind: 'interrupt' })).toBe('staged')
    const cancel = store.claimNext('cancel')!
    expect(cancel.id).toBe(mistaken.id); expect(cancel.cancelRequestedAt).not.toBeNull()
    store.cancel(cancel.id)
    expect(store.auditSetupWaiting(mistaken.id)).toBe(false)
    const resumed = store.claimNext('normal')!
    expect(resumed.id).toBe(ordinary.id); expect(resumed.workflow).toBe('work')
    expect(store.previousSecurityAudit(resumed)).toBe(report.id)
    expect(JSON.parse(store.fleetTriageContext(base.chatId, base.threadTs, base.repoPath)).recentTasks.some((row: any) => row.terminalOutcome === 'cancelled')).toBe(true)
  } finally { store.close() }
})

test('explicit new audit remains a separate scanner job after a completed report', async () => {
  const { store, base } = fixture()
  try {
    const prior = store.enqueue({ ...base, messageId: '1.1', task: '検査して', workflow: 'security-audit' }).job
    store.claimNext('first'); store.complete(prior.id, 'audit-session', '検査結果')
    const route = await classifyFleetRequest('最新コードを再スキャンして', fleetRoutingContext(undefined, store.fleetTriageContext(base.chatId, base.threadTs, base.repoPath)), async () => '{"route":"security-audit"}')
    expect(separateSecurityWorkflow(route, 'work', false)).toBe(true)
    const next = store.enqueue({ ...base, messageId: '1.2', task: '最新コードを再スキャンして', workflow: route === 'security-audit' ? route : 'work' }).job
    expect(store.claimNext('scan')?.workflow).toBe('security-audit')
    expect(next.id).not.toBe(prior.id)
  } finally { store.close() }
})
