import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore, runQueuedJobs } from './job-runner.ts'
import { createSecurityAuditProgress } from './security-audit-progress.ts'

test('audit chunk updates use durable scheduled notifications and the current status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-progress-'))
  const store = new JobStore(join(root, 'jobs.sqlite'))
  const sent: string[] = [], ids: string[] = []
  store.enqueue({ chatId: 'C1', threadTs: '1.1', messageId: '1.2', userId: 'U1', repoPath: root, task: 'audit fixture', workflow: 'security-audit' })
  try {
    const stats = await runQueuedJobs({ store, pollMs: 1, stopWhenIdle: true, maxJobsPerSession: 1,
      notifier: { status: async () => {}, started: async () => {}, progress: async (_job, text, id) => { sent.push(text); ids.push(id!) } },
      executor: async (job, _signal, context) => {
        let now = context!.progressActivatedAtMs
        const progress = createSecurityAuditProgress(job, context!, () => {}, () => {}, () => now)
        try {
          progress.report('1/13 source review: 0/20')
          now += 600_000
          for (let i = 1; i <= 20; i++) progress.report(`1/13 source review: ${i}/20`)
          await Bun.sleep(30)
          now += 1_200_000
          progress.flush() // A long tool can keep sending its latest status without another chunk.
          await Bun.sleep(30)
        } finally { progress.close() }
        now += 3_600_000
        progress.flush()
        return { sessionId: 'fixture', result: 'fixture audit complete' }
      },
    })
    expect(stats.completed).toBe(1)
    expect(sent).toEqual(['1/13 source review: 1/20', '1/13 source review: 20/20'])
    expect(new Set(ids).size).toBe(2)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('delivery failures retry the same slot and supersede stale pending probes', () => {
  let now = 600_001, attempts = 0, warnings = 0
  const probes: Array<{ slot: number; clientMessageId: string }> = []
  const superseded: number[][] = [], delivered: string[] = []
  const progress = createSecurityAuditProgress({ id: 'job', attempts: 1 }, {
    progressActivatedAtMs: 1,
    beginProgressProbe: p => { probes.push(p); return true },
    supersedeProgressProbe: (old, next) => { superseded.push([old, next!]) },
    reportProgress: report => {
      attempts++
      if (attempts === 1) throw Error('fixture storage failure')
      if (attempts === 2) return false
      delivered.push(report.text); return true
    },
  }, () => {}, () => { warnings++ }, () => now)
  try {
    progress.report('first')
    progress.report('latest')
    expect(probes[0]).toEqual(probes[1])
    now = 1_800_001
    progress.flush()
    progress.flush()
    expect(delivered).toEqual(['latest'])
    expect(warnings).toBe(1)
    expect(superseded).toEqual([[0, 1]])
  } finally { progress.close() }
})
