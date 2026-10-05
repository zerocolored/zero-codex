# ベルミちゃん2号を別のMacで再開する

「**ベルミちゃん2号を再開して**」「2号を復活させて」「2号をこのMacに入れて」と依頼されたら、
このファイルを手順の正本として使う。一般的な新規セットアップ（[SETUP.md](../SETUP.md)）との
違いは **Slack Appを新規作成しない**ことだけで、それ以外はSETUP.mdへ委譲する。

2号は 2026-09-09 から 2026-10-05 まで MacBook Air で稼働し、そのMacを別の人が使うことになった
ため廃止された。旧PCのgatewayは停止・初期化済みで、**二重起動の心配はない**。したがって
AGENTS.mdの「新規Macでは新しいSlack Appを既定にする」の例外（＝旧PC停止済みの移行）にあたる。

## 固定値

新PCで同じ「2号」を名乗らせるのに要る値。秘密情報は含まない。

| | 値 |
|---|---|
| Slack App | `A0C0J884998` |
| Bot user | `@bellmichan2` / `U0C0L753R41` |
| instanceId | `618b2d08-dde2-42b2-99c0-8a70b8e846dc` |
| installationId | `5d64e47a-2ebb-44c7-9669-b595d3a6a233` |
| state dir | `~/.codex/zerokun` |
| 対象 project | `BellSalsesAI`（`zerocolored/skills` のcheckout。中に `bsb_back` / `bsb_front` / `meeting-app` が別repoでぶら下がる） |
| channels | `C0AHPJ8BCAX` `C0B69UHBP7Y` `C0BNENVB7EW` `C0C0ZJDRS4V`（全て `requireMention: true`） |
| allowFrom / writeAllowFrom | `U0A0DCGSJA0` `U06R9GU88RF` `U0AJNAV797S` |
| dmPolicy | `pairing` |
| 起動 | `zerochan start`（Herdrのpane） |
| 状態確認 | `zerochan status`（channel紐付け） / `zerokun-status`（gateway process） |

## 手順

1. SETUP.mdの手順をそのまま進める。ただし **Slack Appは新規作成せず、`A0C0J884998` を使い回す**。
2. tokenは旧PCから持ち越さない。Slack App管理画面で `xoxb-` / `xapp-` を**再発行**し、
   `bash zerokun/interactive-bootstrap.sh --slack-only` の非表示promptへ入れる。
   既存Appとの同一性チェックは通常どおり効かせる（別Appの2値なら保存せず停止する）。
3. `access.json` を上表の channels 4つ・allowFrom 3人で再設定する。
4. 対象projectを `BellSalsesAI` に紐付ける。
5. `zerochan start` → Slackで実応答まで確認する。`status=completed` は成功判定にしない。

## 旧PCから持ち込まないもの

`jobs.sqlite3` / `inbox` / `outbox` / `job-logs` / `final-output` / `advisor-*` / `~/.codex` 丸ごと /
`auth.json`。特に **`*.lock` と `*.lock.identity` は持ち込まない** —
lock identityは `ps -o lstart=` の出力文字列比較でロケール依存のため、書いた側と検証側の
ロケールが違うと `稼働中gatewayのlock identityを検証できません` で起動を拒否する。

## 引き継ぐ落とし穴

- **`status=completed` は成功ではない。** ジョブが最後まで走っただけで、中身が「ブロックされました」
  のことがある。最終回答を読むまで達成判定しない。
- **「〜を教えてください」で止まるのは仕様。** Slackの読み書き・環境変数経由の鍵・ブラウザの
  ログイン状態・自前のDNS解決の4領域だけがサンドボックスで塞がれている
  （`zerokun/codex-executor.ts`）。鍵は**リポジトリ内のファイルなら読める**ので `.env.keys` を
  置く対処は有効。コード読解・修正・PR作成は完走する。
- **「親メッセージを確認できず」は機能欠落ではない。** `message_id == thread_ts`
  （メンションされたメッセージ自身がスレッド1通目）で取得範囲に自分1通しか入らないだけ。
  スレッド文脈の注入は `server.ts` の `hydrateInitialThreadContext` で実装済み。**改修しない。**
- **自リポのPRを依頼すると固定文しか返らない**ことがあった。非公開ガードの `\bCodex\b` が
  `zero-codex` にマッチして回答を全消ししていた（zero-codex#26で修正済み）。再発したら
  `~/.codex/zerokun/final-output/<jobId>/*.final.txt` の生回答と突き合わせる。
- **稼働中に `bun test` を直接流さない。** `zerokun/setup.sh` の `pgrep` がシステム全体を見るため、
  同居する claude-channel-slack 側のbotを巻き込んで停止させる。`zerochan update` は隔離
  チェックアウト内で走るので安全。
- **テスト1回ごとに87%CPUで空回りする孤児が1体残る**（`zerokun/launcher.test.ts`）。
  重くなったら `pgrep -laf zerokun-codex-launcher`。

## 同じMacに claude-channel-slack も同居させる場合

両方とも素の名前が `zerokun` で衝突する。`~/.zshrc` の末尾に、両方のsetupブロックより後ろで
`bellmi` 系のラッパー（`bellmi` / `bellmi-restart` / `bellmi-status` / `bellmi-update`、
`alias bellmichan='zerochan'`）を置いて名前を分ける。`ZEROKUN_STATE_DIR` が zero-codex 向けに
globalへexportされるため、claude-channel-slack の `update.ts` を素で叩くと相手のstateを見る。
