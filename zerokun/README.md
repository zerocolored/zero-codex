# ゼロくん一式（Slack → ローカル Claude ボット）

このリポがゼロくんの実体。Slack 受信(bridge)・スレッド振り分け(threads)・起動スクリプト・
オーナー重厚モード(トリアージ + レベル別検証 + /dev)の配線・新マシンセットアップを全部含む。

## 新マシンは3手順

```bash
git clone <このリポ> ~/Desktop/Project/claude-channel-slack
bash ~/Desktop/Project/claude-channel-slack/zerokun/setup.sh
# → 表示される手動ステップ(トークン貼り付け等)をやって、新しいターミナルで: zerokun
```

## 構成

| 場所 | 役割 |
|---|---|
| `server.ts` / `gate.ts` | Slack bridge 本体(受信・許可判定) |
| `skills/threads/` | スレッドごとの担当AI振り分け |
| `claude-channel.sh` | 起動スクリプト(`zerokun` コマンドの実体)。オーナー重厚モードの読み込み配線込み |
| `zerokun/setup.sh` | 新マシンセットアップ(配線の再現) |
| `zerokun/templates/` | 設定ファイルの雛形(トークン等の秘密は含まない) |
| `~/.claude/channels/slack/` | 実際の設定・状態(トークン・許可リスト・スレッド対応表)。**git 管理外** |
| `~/.claude/channels/slack/owner/` | オーナーの CLAUDE.md + /dev スキル(ernie1358 の2リポを clone。更新は `git pull`) |

## 重厚モードの仕組み

起動時に `zerokun-triage.md`(トリアージ) + オーナー `CLAUDE.md`(レベル別モード) を連結し、
`--append-system-prompt-file` で**ゼロくんの Claude にだけ**注入する。
普通に `claude` と打って開くセッションには一切影響しない。

- トリアージ: ごく簡単な質問・軽微な UI 変更 → 単独即答 / それ以外 → レベル別多人数検証、実装は /dev
- レベル2以上は codex CLI が必要(`brew install` 等で導入し OpenAI アカウントでログイン)

## 運用の注意

- 停止は Ctrl-C か通常の kill。`kill -9` 禁止(plugin.lock が残って次回起動が無言で死ぬ)
- 二重起動は起動スクリプトがガードする(既存がいたら中止)
- 詳細な運用ドキュメントは Notion「AI管理 → ノートDB」の引継書を参照
