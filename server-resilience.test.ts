import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const server = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')

describe('Slack bridge resilience wiring', () => {
  test('Bot tokenとApp tokenのApp ID一致をSocket接続前に検証する', () => {
    const verify = server.lastIndexOf('await verifySlackAppTokenPair(')
    const start = server.lastIndexOf('await slackApp.start()')
    const approvals = server.lastIndexOf('setInterval(checkApprovals')
    const ready = server.lastIndexOf('writeGatewayReadiness(')
    expect(verify).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(start)
    expect(verify).toBeLessThan(approvals)
    expect(start).toBeLessThan(approvals)
    expect(start).toBeLessThan(ready)
  })

  test('Slack接続後にchannelとDMの起動時catch-upを一度開始する', () => {
    expect(server).toContain('async function catchupSweep()')
    expect(server).toContain("types: 'im'")
    expect(server).toContain('client.conversations.history')
    expect(server).toContain('planCatchupSweep(catchup.messages, durablyHandled')
    expect(server).toContain('const result = await gate(')
    expect(server).toContain('const handedOver = await deliver(')
    expect(server.indexOf('await slackApp.start()')).toBeLessThan(server.indexOf('void scheduleCatchupSweep()'))
    expect(server).toContain('CATCHUP_SWEEP_INTERVAL_MS')
    expect(server).toContain('async function channelHistory(')
    expect(server).toContain('async function channelCatchupMessages(')
    expect(server).toContain('const historyScan = await channelHistory(channel, oldest)')
    expect(server).not.toContain("join(STATE_DIR, 'catchup-parent-scan.json')")
    expect(server).not.toContain("join(STATE_DIR, 'poll-state.json')")
    expect(server).toContain('ZEROKUN_CATCHUP_PARENT_PAGES_PER_SWEEP, 1')
    expect(server).toContain('ZEROKUN_CATCHUP_HISTORY_PAGES_PER_SWEEP, 1')
    expect(server).toContain('readSlackReadCursor(scope, channel)')
    expect(server).toContain('restartCompletedSlackReadCursor(scope, channel, startedTs, overlappedOldest)')
    expect(server).toContain('fullHistoryParentCatchup(channel, oldest)')
    expect(server).toContain('outstandingScanReplies.size === 0')
    const fullScan = server.slice(
      server.indexOf('async function fullHistoryParentCatchup('),
      server.indexOf('async function channelThreadReplyPage('),
    )
    expect(fullScan).toContain("commitSlackReadCursorIfDurable(")
    expect(fullScan).toContain("'catchup-parent', channel")
    expect(server).toContain('catchupThreadParents(history, slackTsToMs(entry.cycleOldestTs))')
    expect(server).toContain('jobStore.stageSlackReplyScans(')
    expect(server).toContain('await channelThreadReplyPage(')
    expect(server).toContain('response.response_metadata?.next_cursor')
    const recentScan = server.slice(
      server.indexOf('async function channelHistory('),
      server.indexOf('async function fullHistoryParentCatchup('),
    )
    expect(recentScan).toContain("beginCatchupReadCycle('catchup-recent', channel, oldest)")
    expect(recentScan).toContain('oldest: entry.cycleOldestTs')
    expect(recentScan).toContain('latest,')
    expect(recentScan).toContain('inclusive: false')
    expect(recentScan).not.toContain('...(cursor ? { cursor } : {})')
    expect(recentScan).toContain("'catchup-recent', channel, nextCursor, complete")
    expect(fullScan).toContain('stageSlackReplyScans(')
  })

  test('全Slack read cursorをevent ledgerと同じSQLiteへcommitする', () => {
    expect(server).toContain("readSlackReadCursor('owned-thread', pollKey)")
    expect(server).toContain("commitSlackReadCursorIfDurable(")
    expect(server).toContain("'owned-thread', pollKey, plan.cursor")
    expect(server).toContain('requiredScanEventKeys')
    expect(server).toContain('catchup.commitParentScan(requiredScanEventKeys)')
    expect(server).toContain("deleteSlackReadCursorsExcept('owned-thread', livePollKeys)")
  })

  test('Slack quota超過後もDM・channel・threadをdurable round-robinで継続する', () => {
    expect(server).toContain("takeSlackMethodBudget('history')")
    expect(server).toContain("takeSlackMethodBudget('replies', lane)")
    expect(server).toContain("`${method}:${lane}`")
    expect(server).toContain('stageSlackDirectMessagePage(channels, nextCursor')
    expect(server).toContain('listPendingDirectMessageChannels()')
    expect(server).toContain('completePendingDirectMessageChannel(channelId)')
    expect(server).toContain('listSlackReplyScans(pageBudget + blocked.size)')
    expect(server).toContain('commitSlackReplyScanPageIfDurable(')
    expect(server).toContain('ZEROKUN_CATCHUP_REPLY_PAGES_PER_SWEEP, 20')
    expect(server).toContain("schedulerCursor('catchup-channels')")
    expect(server).toContain("schedulerCursor('owned-threads')")
  })

  test('plugin lockはPIDだけでなくserver.tsのprocess identityを照合する', () => {
    expect(server).toContain("from './plugin-lock.ts'")
    expect(server).toContain('claimPluginLock(LOCK_FILE, STATE_DIR)')
  })

  test('shutdown完了までsingleton lockを保持しSocket Mode consumerを重複させない', () => {
    const shutdown = server.slice(server.indexOf('function shutdown()'), server.indexOf('// ── Thread catch-up'))
    expect(shutdown).toContain('slackApp?.stop()')
    expect(shutdown).not.toContain('releaseProcessLock')
    expect(shutdown).not.toContain('jobStore.close()')
  })

  test('update journal中のcandidate gatewayは受信DBとdedupへeventを確定しない', () => {
    expect(server).toContain("const UPDATE_JOURNAL_FILE = join(STATE_DIR, 'update-transaction.json')")
    expect(server).toContain('if (updateTransactionPending(UPDATE_JOURNAL_FILE)) return Promise.resolve(false)')
    expect(server.match(/if \(updateTransactionPending\(UPDATE_JOURNAL_FILE\)\) return/g)?.length)
      .toBeGreaterThanOrEqual(3)
    expect(server.indexOf('if (updateTransactionPending(UPDATE_JOURNAL_FILE)) return Promise.resolve(false)'))
      .toBeLessThan(server.indexOf('rememberDelivered(key)'))
  })

  test('updater crash後はjournalをwrite barrierにしcandidate gatewayも終了する', () => {
    expect(server).toContain('updateTransactionPending(UPDATE_JOURNAL_FILE)')
    expect(server).toContain('updateIsRunning(UPDATE_LOCK_DIR)')
    expect(server).toContain('setInterval(stopOrphanedUpdateCandidate, 5_000)')
    expect(server).toContain('candidate gateway is exiting so watchdog can report recovery is required')
  })

  test('standalone gatewayは親stdinやppidの終了へ寿命を結び付けない', () => {
    expect(server).not.toContain("process.stdin.on('end', shutdown)")
    expect(server).not.toContain('const parentPid = process.ppid')
    expect(server).toContain("process.on('SIGTERM', shutdown)")
  })

  test('delivery成功はSQLite commit後にだけ記録する', () => {
    const enqueue = server.indexOf('const result = jobStore.enqueue({')
    const delivered = server.indexOf('rememberDelivered(key)', enqueue)
    expect(enqueue).toBeGreaterThan(-1)
    expect(delivered).toBeGreaterThan(enqueue)
  })

  test('再起動後のdedupは独立JSONを信頼せずSQLiteへ再stage可能にする', () => {
    expect(server).toContain('const delivered = new Set<string>()')
    expect(server).not.toContain('DELIVERED_FILE')
    expect(server).not.toContain('loadDeliveredKeys')
    expect(server).not.toContain('saveDeliveredKeys')
  })

  test('Slack reactionより先にawaitしたdurable handoffを完了する', () => {
    const mention = server.slice(
      server.indexOf("slackApp.event('app_mention'"),
      server.indexOf("slackApp.event('message'"),
    )
    const message = server.slice(
      server.indexOf("slackApp.event('message'"),
      server.indexOf("slackApp.event('member_joined_channel'"),
    )
    for (const handler of [mention, message]) {
      expect(handler.indexOf('const handedOver = await deliver(')).toBeGreaterThan(-1)
      expect(handler.indexOf('const handedOver = await deliver('))
        .toBeLessThan(handler.indexOf('client.reactions.add'))
    }
  })

  test('detached更新は回復可能なrequest file作成後にだけ永続ledgerへ確定する', () => {
    const request = server.indexOf('await enqueueUpdate(chatId, resolvedThreadTs, messageTs, userId)')
    const ledger = server.indexOf('jobStore.reserveUpdateRequest(key)', request)
    expect(request).toBeGreaterThan(-1)
    expect(ledger).toBeGreaterThan(request)
    expect(server).toContain('if (!jobStore.hasUpdateRequest(key))')
  })

  test('未route channelでは実行不能なonboard mentionではなく端末手順を案内する', () => {
    expect(server).toContain('zerokun-access channel add ${channelId}')
    expect(server).toContain('Messages in an unrouted channel are intentionally ignored')
    expect(server).not.toContain('<@${botUserId}> onboard')
    expect(server).toContain('requireRepoRoute(chatId, configured, process.cwd())')
    expect(server).not.toContain('realpathSync(configured ?? process.cwd())')

    const resolveBeforeUpdate = server.indexOf('const repoPath = resolveRepoPath(chatId, resolvedThreadTs)')
    const detachedUpdate = server.indexOf('if (writeEnabled && isExplicitUpdateRequest(text))')
    expect(resolveBeforeUpdate).toBeGreaterThan(-1)
    expect(resolveBeforeUpdate).toBeLessThan(detachedUpdate)
  })

  test('Slack添付はarrayBufferへ全量展開せずstream中にも50MB上限を強制する', () => {
    expect(server).toContain('for await (const value of response)')
    expect(server).toContain('response.destroy()')
    expect(server).toContain('received > MAX_ATTACHMENT_BYTES')
    expect(server).not.toContain('response.arrayBuffer()')
    expect(server).toContain("if (!/^\\d+\\.\\d+$/.test(messageTs))")
    expect(server).toContain("if (!/^F[A-Z0-9]+$/.test(fileId))")
  })

  test('Slack metadataを添付download前にSQLiteへ保存し、単一drainでFIFO retryする', () => {
    const stage = server.indexOf('jobStore.stageInboundDelivery({')
    const download = server.indexOf('await downloadInboundFiles(inbound.fileIds, inbound.messageId)')
    expect(stage).toBeGreaterThan(-1)
    expect(download).toBeGreaterThan(-1)
    expect(server).toContain('const inbound = jobStore.claimNextInboundDelivery()')
    expect(server).toContain('jobStore.deferInboundDelivery(')
    expect(server).toContain('jobStore.recoverInboundDeliveries()')
    expect(server).toContain('inbound drain crashed')
    expect(server).toContain('scheduleInboundDrain(INBOUND_RETRY_MS)')
    const startup = server.indexOf('const recoveredInbound = jobStore.recoverInboundDeliveries()')
    expect(startup).toBeGreaterThan(server.indexOf('const jobStore = new JobStore('))
    expect(startup).toBeLessThan(server.indexOf('scheduleInboundDrain()'))
  })

  test('破損legacy threadsはmigration完了扱いせず修復後の再起動で再試行できる', () => {
    const migration = server.slice(
      server.indexOf('function importLegacyThreads()'),
      server.indexOf('/** Thread ownership is durable'),
    )
    const invalidJson = migration.indexOf('legacy threads JSON is invalid')
    expect(invalidJson).toBeGreaterThan(-1)
    expect(migration.slice(invalidJson, migration.indexOf('const validation =', invalidJson)))
      .not.toContain('markMigrationApplied')
    expect(migration).toContain('if (content === null)')
    expect(migration).toContain('validateLegacyThreadMap(legacy)')
    expect(migration).toContain('validation.invalidKeys.length')
    expect(migration).toContain('requireLegacyThreadRepoRoute(')
    expect(migration).toContain('entry.repo_path,')
    expect(migration).toContain('if (failedEntries === 0)')
    expect(migration).toContain('will retry after restart')
  })
})
