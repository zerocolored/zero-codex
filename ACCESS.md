# Access Control Reference

設定済みチャンネルでは、人間の参加者全員が個別登録なしで利用・repository変更を依頼できます。
DMだけは受信許可と書込み許可を分離し、pairingだけでは書込み権限は付きません。

設定ファイルは既定で `~/.codex/zerokun/access.json` にあります。旧版の
`~/.claude/channels/slack` は自動選択しません。旧PCのgatewayを停止する移行では既存Slack Appのtokenだけを
新stateへ安全に移せますが、access・queueはコピーせず新PCで設定し直します。複数PCを同時稼働する場合は
PCごとに別のSlack AppとCodex stateを使います。fresh stateにはApp別の履歴下限が保存され、移行前の
Slack依頼を空のdedup ledgerで再実行しないようにします。
同一PCのin-place cutover時だけ`ZEROKUN_LEGACY_CUTOVER=1`と
`ZEROKUN_STATE_DIR`の両方で旧stateを明示します。

## 管理コマンド

```text
zerochan-access status
zerochan-access pair <code>
zerochan-access allow|deny <user-id>
zerochan-access write allow|deny <user-id>
zerochan-access policy pairing|allowlist|disabled
```

Slack user IDはdisplay nameではなく `U...` / `W...` を指定します。

## DM policy

### `pairing`（既定）

未登録の人が DM すると、6桁の pairing code を1件発行します。端末で完全な code を指定します。

```bash
zerochan-access pair a1b2c3
```

- code は1時間で失効します。
- pending は最大3件です。
- 同じ利用者への code 表示は2回までです。
- code を省略して最新 pending を自動承認する動作はありません。
- pairing は `allowFrom` だけを更新し、`writeAllowFrom` は更新しません。

### `allowlist`

`allowFrom` にいる人だけDMを利用できます。新しいpairing codeは発行しません。

### `disabled`

すべてのDMを拒否します。channelでの利用には影響しません。

```bash
zerochan-access policy pairing
zerochan-access policy allowlist
zerochan-access policy disabled
```

## DM の受信許可

```bash
zerochan-access allow U0123456789
zerochan-access deny U0123456789
```

旧版のchannel allowlistにいた人は、移行時にDMの`allowFrom`へ一度だけ引き継ぎます。
以後のchannel参加者はDM許可へ自動追加されず、DMはpairingまたはこのコマンドで管理します。

## Repository write（チャンネルは参加者全員、DMだけ個別設定）

```bash
zerochan-access write allow U0123456789
zerochan-access write deny U0123456789
```

- チャンネルの人間の参加者: 個別登録なしでrepositoryと`.git`のwrite、依頼に必要なnetworkを許可します。
- DMで`writeAllowFrom` にいない sender: minimal runtimeから組み立てたnamed profileでrepository readと
  job専用outbox writeだけを許可します。調査と回答だけです。
- DMで`writeAllowFrom` にいる sender: minimal runtimeから組み立てたnamed profileでrepositoryと`.git`の
  write、request に必要な network accessを許可します。
- job の権限は enqueue 時点で固定します。queue 待ちの途中で設定を変えても、既存 job の権限は
  変わりません。導入前のread-only jobも自動昇格せず、完了または中止後の新しい依頼から適用します。
- 実行中の同じSlack threadへの返信はsenderが変わっても会話割り込みです。active jobの権限は途中で
  変更せず、そのthreadへの参加をactive jobの操作委任とみなします。現在turnを安全な境界で一時停止し、
  fresh read-only turnで先に回答した後、更新依頼だけをSlack配送確認後にactive write jobへ反映します。
  別threadは独立FIFOで、新jobはチャンネルならwrite可、DMならsenderの許可から判定します。
  完全一致の`中止`も同じthread-scoped操作として受け付けます。
- commit、push、deploy、PR は write 許可だけでは自動実行されず、Slack request が求めた範囲に
  限られます。
- HOMEのcredential/configはCodexへ公開しません。commitには固定の実行用identityを使い、
  認証付きGitHub操作はrepository限定broker、Cloud Logging検索はproject限定brokerへ渡します。
  ホストの認証が使える限り、scratch HOMEに認証がないことだけではblockしません。
- 通常cloneに加え、Git自身の登録情報・back pointer・gitlink・`core.worktree`が一致する正規の
  linked worktree/submoduleを利用できます。任意pathを指す偽の`.git` pointerは拒否します。

## Channel policy

利用するSlack Appをchannelへ招待し、対象projectで
`zerochan set slack-channel <channel-id>`を実行すると、そのchannelの人は誰でも利用できます。
利用者allowlistはありません。bot投稿とSlack user IDでないsenderは常に無視します。

- 新しいchannel依頼は、そのSlack Appへのメンションが必要です。
- いったんそのAppが採用したthreadの人による返信は、senderが変わってもメンション不要です。
- 実行中の同じthreadへの返信は安全に一時停止して先に回答し、別threadは独立したFIFO jobになります。
- 招待・最初のlive mentionでchannelを内部記録し、再起動後の履歴回収に使います。
- 新しいthreadはproject-localの`.zerochan/config.json`で紐付けたprojectへ固定されます。
  `zerochan unset slack-channel <channel-id>`で解除でき、同じchannelを2つのprojectへ重複登録は
  できません。既存threadの固定先は解除後も変わらず、`routes.json`は不要です。

## 設定 schema

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["U0123456789"],
  "writeAllowFrom": [],
  "channels": {
    "C0123456789": {
      "requireMention": true
    }
  },
  "pending": {},
  "ackReaction": "eyes",
  "doneReaction": "white_check_mark",
  "textChunkLimit": 3900,
  "chunkMode": "length"
}
```

`ackReaction` は受信時の reaction です。`doneReaction`、`textChunkLimit`、`chunkMode` は
旧設定との互換性のため読込みますが、Codex 版の完了通知は runner が安全な固定上限で投稿します。

## セキュリティ上の注意

- Access の変更はローカル端末だけで行います。Slack 本文から access file を変更しません。
- gateway と管理CLIの更新は共通のcross-process lock内で最新`access.json`を再読込するため、
  pairing追加とwrite revokeが競合しても古い権限を復活させません。
- `access.json`、`.env`、SQLite DB は mode 0600、state directory は mode 0700 を使います。
- Codex 子プロセスには Slack token、GitHub/AWS等の任意環境変数、state path変数を渡しません。
- HOME/state/shared tempをsandboxでdenyし、repository、当該jobの添付、scratch、outboxだけを
  pathごとに再許可します。
- 添付ファイルは認可後に gateway が state の `inbox/` へ保存し、そのjobに記録したfileだけを
  Codex profileへread許可します。
- 成果物 upload は50MBまでで、job専用 `outbox/<job-id>/` 直下の空でないregular fileだけを許可します。
  symlinkによるoutbox外へのescape、device、FIFO、他jobのfileは拒否します。
- 成果物のfile形式は制限しません。送信byte列の明白な平文credentialだけをbest-effortで検出して省略し、
  archive展開・復号・OCRは行わないため、社内利用でも成果物へ秘密を含めない運用を前提とします。
