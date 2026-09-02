import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const server = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
const gateSource = readFileSync(join(import.meta.dir, 'gate.ts'), 'utf8')
const threadIntentSource = readFileSync(
  join(import.meta.dir, 'zerokun', 'slack-thread-intent.ts'),
  'utf8',
)

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
    expect(server).toContain('jobStore.slackCatchupFloor(appId)')
    expect(server).toContain('jobStore.listSlackChannelRoutes(appId).map(route => [route.channelId, route.configuredAt])')
    expect(server).toContain('const channelOldestMs = resolveCatchupOldestMs(oldestMs, routeFloors.get(channelId))')
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
    expect(server).toContain('listPendingDirectMessageChannels(appId)')
    expect(server).toContain('completePendingDirectMessageChannel(channelId)')
    expect(server).toContain('listDueSlackReplyScans(appId, pageBudget + blocked.size)')
    expect(server).toContain('commitSlackReplyScanPageIfDurable(')
    expect(server).toContain('ZEROKUN_CATCHUP_REPLY_PAGES_PER_SWEEP, 20')
    expect(server).toContain("schedulerCursor('catchup-channels')")
    expect(server).toContain("schedulerCursor('owned-threads')")
  })

  test('取得不能DMだけをdurable backoffし、復旧可能性と人間向けログを保つ', () => {
    expect(server).toContain('recordSlackDirectMessageHistoryFailure(')
    expect(server).toContain('slackDirectMessageHistoryIsDeferred(appId, channelId, now)')
    expect(server).toContain('clearSlackDirectMessageHistoryFailure(currentSlackAppId(), channelId)')
    expect(server).toContain("slackDirectMessageFailureDisposition(channelId, err) === 'backoff'")
    expect(server).toContain('取得できない過去のDMは24時間後に再確認します')
    expect(server).toContain('設定チャンネルには影響しません')
    expect(server).toContain('refreshSlackDirectMessageAvailability(() => (')
    expect(server).toContain('受信処理は継続します')
    expect(server).not.toContain('catch-up sweep delivered=${deliveredCount}')
    const replyScan = server.slice(
      server.indexOf('async function processPendingReplyScanPages('),
      server.indexOf('/** Socket Mode停止中'),
    )
    expect(replyScan).not.toContain('completePendingDirectMessageChannel(scan.channelId)')
  })

  test('取得不能owned threadは新しいactivityまでpollを休止する', () => {
    const pollerStart = server.indexOf('async function pollThreads()')
    const poller = server.slice(
      pollerStart,
      server.indexOf('  void pollThreads()', pollerStart),
    )
    expect(poller).toContain("slackReplyScanFailureDisposition(err) === 'discard'")
    expect(poller).toContain('suspendUnavailableSlackThreadPoll({')
    expect(poller).toContain('observedLastActivityMs: lastActivity')
    expect(poller).toContain('unavailable thread polling paused until new activity')
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

  test('access lockを解放できなければgatewayを継続せず再起動へ渡す', () => {
    expect(server).toContain('error instanceof AccessLockReleaseError')
    expect(server).toContain('fatal access lock release failure')
    const handler = server.slice(
      server.indexOf('if (error instanceof AccessLockReleaseError)'),
      server.indexOf('let slackApp:'),
    )
    expect(handler).toContain('shutdown()')
  })

  test('update journal中のcandidate gatewayは受信DBとdedupへeventを確定しない', () => {
    const deliver = server.slice(
      server.indexOf('function deliver('),
      server.indexOf('// Handle @mentions'),
    )
    expect(server).toContain("const UPDATE_JOURNAL_FILE = join(STATE_DIR, 'update-transaction.json')")
    expect(server).toContain('if (updateTransactionPending(UPDATE_JOURNAL_FILE)) return Promise.resolve(false)')
    expect(server.match(/if \(updateTransactionPending\(UPDATE_JOURNAL_FILE\)\) return/g)?.length)
      .toBeGreaterThanOrEqual(3)
    expect(deliver.indexOf('if (updateTransactionPending(UPDATE_JOURNAL_FILE)) return Promise.resolve(false)'))
      .toBeLessThan(deliver.indexOf('rememberDelivered(key)'))
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
    const enqueue = server.indexOf('jobStore.enqueue({')
    const committed = server.indexOf(
      'jobStore.completeInboundDelivery(inbound.idempotencyKey)',
      enqueue,
    )
    const delivered = server.indexOf('rememberDelivered(key)', enqueue)
    expect(enqueue).toBeGreaterThan(-1)
    expect(committed).toBeGreaterThan(enqueue)
    expect(delivered).toBeGreaterThan(committed)
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
      const handoff = handler.indexOf('const handedOver = await deliver(')
      const acknowledgement = handler.indexOf('await acknowledgeSlackDelivery(')
      expect(handoff).toBeGreaterThan(-1)
      expect(acknowledgement).toBeGreaterThan(handoff)
    }
  })

  test('LLMで宛先確定したactive threadだけが別humanの受信gateを越える', () => {
    expect(server).toContain('function activeThreadAuthorityTarget(')
    expect(server).toContain('const liveTarget = jobStore.liveControlTarget(channelId, threadTs)')
    expect(server).toContain('jobStore.interruptControlTarget(channelId, threadTs)')
    expect(server).toContain('canUseActiveThreadAuthority({')
    expect(server).toContain('activeThreadAuthority && !isBot')
    expect(server).toContain('access.channels[channelId], senderId, isMention, isBot, activeThreadAuthority')
    const message = server.slice(
      server.indexOf("slackApp.event('message'"),
      server.indexOf("slackApp.event('member_joined_channel'"),
    )
    expect(message.indexOf('const admission = await admitSlackChannelThreadReply({'))
      .toBeLessThan(message.indexOf('const threadAuthorityTarget = activeThreadAuthorityTarget('))
    expect(message.indexOf('const threadAuthorityTarget = activeThreadAuthorityTarget('))
      .toBeLessThan(message.indexOf('const result = await gate('))
    expect(message).toContain('threadAuthorityTarget !== null')
    expect(message).toContain('? { target: threadAuthorityTarget }')
  })

  test('無関係判定は全入口でreaction・queue・controlより前に完全終了する', () => {
    expect(server).not.toContain('classifyThreadReply')
    expect(gateSource).not.toContain('classifyThreadReply')
    const admission = server.slice(
      server.indexOf('async function admitSlackChannelThreadReply('),
      server.indexOf('function resolveRepoPath('),
    )
    expect(admission).not.toContain('reactions.add')
    expect(admission).not.toContain('chat.postMessage')
    expect(admission).not.toContain('stageInboundDeliveryForControl')
    expect(admission).not.toContain('stageInboundDeliveryAndAdoptSlackThread')
    expect(admission).not.toContain('enqueueUpdate(')

    const mention = server.slice(
      server.indexOf("slackApp.event('app_mention'"),
      server.indexOf("slackApp.event('message'"),
    )
    const message = server.slice(
      server.indexOf("slackApp.event('message'"),
      server.indexOf("slackApp.event('member_joined_channel'"),
    )
    for (const handler of [mention, message]) {
      const llm = handler.indexOf('await admitSlackChannelThreadReply({')
      const stop = handler.indexOf("if (admission !== 'addressed') return", llm)
      expect(llm).toBeGreaterThan(-1)
      expect(stop).toBeGreaterThan(llm)
      expect(stop).toBeLessThan(handler.indexOf('activeThreadAuthorityTarget(', stop))
      expect(stop).toBeLessThan(handler.indexOf('const handedOver = await deliver(', stop))
      expect(stop).toBeLessThan(handler.indexOf('await acknowledgeSlackDelivery(', stop))
    }

    const recovery = server.slice(
      server.indexOf('async function processPendingReplyScanPages('),
      server.indexOf('async function catchupSweep()'),
    )
    expect(recovery).toContain('await admitSlackChannelThreadReply({')
    expect(recovery).toContain("admission === 'ignored' || admission === 'handled'")
    const poll = server.slice(
      server.indexOf('async function pollThreads()'),
      server.indexOf("process.on('SIGTERM'"),
    )
    expect(poll).toContain('await admitSlackChannelThreadReply({')
    expect(poll).toContain("admission === 'ignored' || admission === 'handled'")
  })

  test('catch-upも表示名に依存しないpairing文とdurable handoff後のeyes経路を使う', () => {
    const catchup = server.slice(
      server.indexOf('async function catchupSweep()'),
      server.indexOf('async function pollThreads()'),
    )
    expect(catchup).toContain('ペアリングの承認待ちです')
    expect(catchup).toContain('私とのペアリングが必要です')
    expect(catchup).not.toContain('Zeroちゃんとのペアリング')
    expect(catchup).not.toContain('Still pending')
    expect(catchup).not.toContain('Pairing required')
    expect(catchup).toContain('activeThreadAuthorityTarget(')
    expect(catchup).toContain('await admitSlackChannelThreadReply({')
    expect(catchup).toContain('? { target: threadAuthorityTarget }')
    expect(catchup).toContain('await acknowledgeSlackDelivery(')
    expect(server).toContain("const reaction = access.ackReaction ?? 'eyes'")
  })

  test('owned threadのlive返信は正規表現でなくdurable LLM gateを先に通す', () => {
    const message = server.slice(
      server.indexOf("slackApp.event('message'"),
      server.indexOf("slackApp.event('member_joined_channel'"),
    )
    const owned = message.indexOf("const ownedThread = typeof threadTs === 'string'")
    const audience = message.indexOf('const admission = await admitSlackChannelThreadReply({', owned)
    const addressed = message.indexOf('|| ownedThread', audience)
    const gate = message.indexOf('const result = await gate(', addressed)
    expect(owned).toBeGreaterThan(-1)
    expect(audience).toBeGreaterThan(owned)
    expect(addressed).toBeGreaterThan(audience)
    expect(gate).toBeGreaterThan(addressed)
    expect(message).not.toContain('classifyThreadReply(')
    const contextReader = server.slice(
      server.indexOf('async function readSlackThreadIntentContext('),
      server.indexOf('/**\n * LLM admission'),
    )
    expect(contextReader).toContain("takeSlackMethodBudget('replies', lane)")
    expect(contextReader).toContain('const oldestMs = slackTsToMs(threadTs)')
  })

  test('候補を文脈取得より先に保存し、部分pageをsnapshotへ固定しない', () => {
    const admission = server.slice(
      server.indexOf('async function admitSlackChannelThreadReply('),
      server.indexOf('function settleAddressedThreadReplyWithoutDelivery('),
    )
    expect(admission.indexOf('jobStore.stageSlackThreadReplyCandidate({'))
      .toBeLessThan(admission.indexOf('await readSlackThreadIntentContext('))
    expect(admission).toContain('jobStore.prepareSlackThreadReplyIntent(key, {')
    expect(admission).not.toContain('contextMessages?:')
    expect(server).not.toContain('contextMessages: response.messages')
    expect(server).not.toContain('contextMessages: catchup.messages')
    expect(server).not.toContain('contextMessages: replies')
  })

  test('未所有・mentionなしの雑談はLLMへ送らず、picked-up返信だけを意味判定する', () => {
    const admission = server.slice(
      server.indexOf('async function admitSlackChannelThreadReply('),
      server.indexOf('function settleAddressedThreadReplyWithoutDelivery('),
    )
    const structural = admission.indexOf('const structurallyPickedUp =')
    const stage = admission.indexOf('jobStore.stageSlackThreadReplyCandidate({')
    expect(structural).toBeGreaterThan(-1)
    expect(structural).toBeLessThan(stage)
    expect(admission).toContain('jobStore.getThread(input.channelId, input.threadTs) !== null')
    expect(admission).toContain('mentionsBot(input.text, botUserId)')
    expect(admission).toContain("if (!structurallyPickedUp) return 'ignored'")
  })

  test('classifier障害はraw入力から自動drainし、dropもdurable完了にする', () => {
    expect(server).toContain('async function drainSlackThreadReplyIntents()')
    expect(server).toContain('jobStore.listDueSlackThreadReplyIntents(Date.now(), 16)')
    expect(server).toContain('await replayDueSlackThreadReplyIntent(intent)')
    expect(server).toContain('setInterval(() => { void drainSlackThreadReplyIntents() }')
    expect(server).toContain('settleAddressedThreadReplyWithoutDelivery(')
    expect(server).toContain('jobStore.recordDeliveryTombstone(key)')
    expect(server).toContain('candidateText: input.text')
    expect(server).toContain('fileIds: input.fileIds')
  })

  test('分類用Codexは読取toolを無効化し、Slack本文をJSON string dataとして渡す', () => {
    for (const feature of ['shell_tool', 'unified_exec', 'js_repl', 'view_image']) {
      expect(threadIntentSource).toContain(`'--disable', '${feature}'`)
    }
    expect(threadIntentSource).toContain('JSON.stringify(snapshotJson)')
    expect(threadIntentSource).not.toContain("'<untrusted_slack_thread_json>'")
  })

  test('owned threadのpoll回収もbot mention除去後に中止判定へ渡す', () => {
    const poller = server.slice(
      server.indexOf('async function pollThreads()'),
      server.indexOf("process.on('SIGTERM'"),
    )
    expect(poller).toContain(
      "normalizeSlackInboundText(r.text ?? '', botUserId, channelId.startsWith('D'))",
    )
  })

  test('detached更新は回復可能なrequest file作成後にだけ永続ledgerへ確定する', () => {
    const request = server.indexOf(
      'await enqueueUpdate(chatId, resolvedThreadTs, messageTs, userId)',
    )
    const ledger = server.indexOf('jobStore.reserveUpdateRequest(key)', request)
    expect(request).toBeGreaterThan(-1)
    expect(ledger).toBeGreaterThan(request)
    expect(server).toContain('if (!jobStore.hasUpdateRequest(key))')
  })

  test('参加channelを自動記録し、channel routeへ最初のthreadを原子的に固定する', () => {
    expect(server).toContain('rememberChannel(channelId, ACCESS_FILE)')
    expect(server).toContain('const admission = await admitSlackChannelThreadReply({')
    expect(server).toContain("if (admission !== 'addressed') return")
    expect(server).toContain('このチャンネルで私を利用できます。')
    expect(server).toContain('新しい依頼は私をメンションしてください。')
    expect(server).not.toContain('@Zeroちゃん')
    expect(server).not.toContain('zerokun-access')
    expect(server).not.toContain('ROUTES_FILE')
    expect(server).not.toContain('configuredRepoPath(')
    expect(server).toContain('jobStore.resolveOrAdoptSlackThreadRoute({')
    expect(server).toContain('jobStore.resolveSlackThreadRoute({')
    expect(server).toContain('jobStore.stageInboundDeliveryAndAdoptSlackThread(inbound, {')
    expect(server).toContain('defaultRepoPath: process.cwd()')
    expect(server).toContain('projectDir: process.cwd()')
    expect(server).toContain('err instanceof SlackProjectUnavailableError')

    const detachedUpdate = server.indexOf('if (writeEnabled && isExplicitUpdateRequest(text))')
    const updatePin = server.indexOf(
      'resolveRepoPath(chatId, resolvedThreadTs, messageTs)', detachedUpdate,
    )
    expect(updatePin).toBeGreaterThan(detachedUpdate)
    expect(server.indexOf(
      'repoPath = resolveUnclaimedRepoPath(chatId, resolvedThreadTs)',
      detachedUpdate,
    )).toBeGreaterThan(updatePin)
    const importLegacy = server.lastIndexOf('importLegacyThreads()', server.indexOf('await slackApp.start()'))
    expect(importLegacy).toBeGreaterThan(-1)
    expect(importLegacy).toBeLessThan(server.indexOf('await slackApp.start()'))
  })

  test('channel自動記録でもaccess lock解放失敗はgatewayを停止する', () => {
    const joinedHandler = server.slice(
      server.indexOf("slackApp.event('member_joined_channel'"),
      server.indexOf('// Lifecycle — clean shutdown'),
    )
    expect(joinedHandler).toContain('err instanceof AccessLockReleaseError')
    expect(joinedHandler).toContain('fatal access lock release failure')
    expect(joinedHandler).toContain('shutdown()')
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
    const stage = server.indexOf('const inbound: InboundDeliveryInput = {')
    const download = server.indexOf('attachments = await downloadInboundFiles(')
    expect(stage).toBeGreaterThan(-1)
    expect(download).toBeGreaterThan(-1)
    const deliverBody = server.slice(server.indexOf('function deliver('), server.indexOf('// Handle @mentions'))
    expect(deliverBody.indexOf('const inbound: InboundDeliveryInput = {'))
      .toBeLessThan(deliverBody.indexOf('scheduleInboundDrain()'))
    expect(server).toContain('jobStore.stageInboundDeliveryForControl(')
    expect(server).toContain('jobStore.stageInboundDeliveryAndAdoptSlackThread(inbound, {')
    expect(server).toContain('const claimedInbound = jobStore.claimNextInboundDelivery()')
    expect(server).toContain('jobStore.deferInboundDelivery(')
    expect(server).toContain('jobStore.releaseInboundDelivery(')
    expect(server).toContain('preemptInboundDownloadForLiveControl(inbound)')
    expect(server).toContain('loadCachedInboundAttachment({')
    expect(server).toContain('jobStore.recordInboundDownloadedFile(')
    expect(server).toContain('jobStore.recoverInboundDeliveries()')
    expect(server).toContain('inbound drain crashed')
    expect(server).toContain('scheduleInboundDrain(INBOUND_RETRY_MS)')
    const startup = server.indexOf('const recoveredInbound = jobStore.recoverInboundDeliveries()')
    expect(startup).toBeGreaterThan(server.indexOf('const jobStore = new JobStore('))
    expect(startup).toBeLessThan(server.indexOf('scheduleInboundDrain()'))
  })

  test('未所有threadの途中mentionはrootからdurableにhydrateしlive/catch-upで同じ条件を使う', () => {
    expect(server).toContain('inbound = await hydrateInitialThreadContext(')
    expect(server).toContain('channel: inbound.chatId')
    expect(server).toContain('ts: inbound.threadTs')
    expect(server).toContain('latest: inbound.messageId')
    expect(server).toContain('inclusive: true')
    expect(server).toContain('jobStore.finalizeInboundThreadBootstrap(')
    expect(server).toContain('planInitialSlackThreadContext({')
    expect(server).toContain('slackInitialThreadContextFailureDisposition(error)')
    expect(server).toContain('appId: slackAppId!')
    expect(server).toContain('expectedRepoPath,')
    expect(server).toContain('jobStore.deferInboundDeliveryWithoutAttempt(')
    expect(server).toContain('error instanceof SlackInitialThreadContextTransientError')
    expect(server).toContain('will retry initial context read')
    expect(server).toContain('Boolean(event.thread_ts) && mentionsBot(event.text ?? \'\', botUserId)')
    expect(server).toContain("!isDM && typeof threadTs === 'string' && mentionsBot(text, botUserId)")
    expect(server.match(/resolvedThreadTs !== message\.ts && mentionsBot\(text, botUserId\)/g))
      .toHaveLength(2)
    expect(server.match(/resolveIsMention\(isDM, text, botUserId\) \|\| ownedThread/g))
      .toHaveLength(3)
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
