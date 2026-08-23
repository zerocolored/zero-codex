# Access Control Reference

Zero-kun for Codex は「メッセージを受け取れる人」と「repository を変更できる人」を分離します。
pairing や channel opt-in だけでは書込み権限は付きません。

設定ファイルは既定で `~/.codex/zerokun/access.json` にあります。旧版の
`~/.claude/channels/slack` は自動選択しません。別PCのClaude版と比較する場合は新しい
Slack AppとCodex stateを使い、旧token・access・routesをコピーしないでください。
同一PCのin-place cutover時だけ`ZEROKUN_LEGACY_CUTOVER=1`と
`ZEROKUN_STATE_DIR`の両方で旧stateを明示します。

## 管理コマンド

```text
zerokun-access status
zerokun-access pair <code>
zerokun-access allow|deny <user-id>
zerokun-access write allow|deny <user-id>
zerokun-access policy pairing|allowlist|disabled
zerokun-access channel add|rm <channel-id>
zerokun-access channel allow|deny <channel-id> <user-or-bot-id>
```

Slack の ID は display name ではなく `U...` / `W...`（人）、`B...`（bot）、
`C...` / `G...`（channel）を指定します。

## DM policy

### `pairing`（既定）

未登録の人が DM すると、6桁の pairing code を1件発行します。端末で完全な code を指定します。

```bash
zerokun-access pair a1b2c3
```

- code は1時間で失効します。
- pending は最大3件です。
- 同じ利用者への code 表示は2回までです。
- code を省略して最新 pending を自動承認する動作はありません。
- pairing は `allowFrom` だけを更新し、`writeAllowFrom` は更新しません。

### `allowlist`

`allowFrom` または channel の `allowFrom` にいる人だけ DM を利用できます。新しい pairing
code は発行しません。

### `disabled`

すべての DM を拒否します。channel の opt-in は影響を受けません。

```bash
zerokun-access policy pairing
zerokun-access policy allowlist
zerokun-access policy disabled
```

## DM の受信許可

```bash
zerokun-access allow U0123456789
zerokun-access deny U0123456789
```

channel の `allowFrom` にいる人も DM の受信許可集合へ入ります。つまり channel で信頼した人を
別の DM list に二重登録する必要はありません。空の channel allowlist は「その channel の人を
全員 DM 許可する」という意味にはなりません。bot ID は DM 許可集合から常に除外します。

## Repository write

```bash
zerokun-access write allow U0123456789
zerokun-access write deny U0123456789
```

- `writeAllowFrom` にいない sender: minimal runtimeから組み立てたnamed profileでrepository readと
  job専用outbox writeだけを許可します。調査と回答だけです。
- `writeAllowFrom` にいる sender: minimal runtimeから組み立てたnamed profileでrepositoryと`.git`の
  write、request に必要な network accessを許可します。
- job の権限は enqueue 時点で固定します。queue 待ちの途中で設定を変えても、既存 job の権限は
  変わりません。
- commit、push、deploy、PR は write 許可だけでは自動実行されず、Slack request が求めた範囲に
  限られます。
- HOMEのcredential/configはCodexへ公開しません。commitにはrepository localのuser設定が必要で、
  push・deploy・PRはHOME外で安全に利用できる認証がない環境ではblockerとして報告されます。
- 通常cloneに加え、Git自身の登録情報・back pointer・gitlink・`core.worktree`が一致する正規の
  linked worktree/submoduleを利用できます。任意pathを指す偽の`.git` pointerは拒否します。

## Channel policy

```bash
zerokun-access channel add C0123456789
zerokun-access channel rm C0123456789
zerokun-access channel allow C0123456789 U0123456789
zerokun-access channel deny C0123456789 U0123456789
```

channel を `add` すると次の既定値になります。

```json
{
  "requireMention": true,
  "allowFrom": []
}
```

- `requireMention: true`: 新しい channel message は bot の `@mention` が必要です。いったん
  Zero-kun が採用した thread の未メンション follow-up は poller が回収します。
- 人の `allowFrom: []`: opt-in 済み channel 内の人を許可します。
- 人の populated `allowFrom`: listed user だけを許可します。
- bot は default-deny です。投稿を受ける bot ID を明示的に `channel allow` してください。
- channel の追加と repository route の追加は別です。`routes.json` も設定してください。

`requireMention` の切替は現在 CLI にないため、端末で `access.json` を編集します。gateway は
各イベント時に再読込するため再起動は不要です。

## 設定 schema

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["U0123456789"],
  "writeAllowFrom": [],
  "channels": {
    "C0123456789": {
      "requireMention": true,
      "allowFrom": ["U0123456789"]
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
