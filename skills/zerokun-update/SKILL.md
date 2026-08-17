---
name: zerokun-update
description: Slackからゼロくん本体・claude-config・claude-skillsの3リポを安全に更新し、テスト・setup・再起動まで依頼する。「ゼロくん更新して」「3リポを最新にして」「updateかけて」「claude-skillsを反映して」など、ゼロくん自身の更新を明示的に頼まれたときに使う。
---

# ゼロくん更新

1. Slackイベントの`chat_id`、`thread_ts`、`message_id`、`user_id`をそのまま使う。
2. `mcp__slack-channel__request_update`を正確に1回だけ呼ぶ。
3. `enqueue_job`を呼ばない。`zerokun-update`をBashで直接または同期実行しない。
4. ツールが受付・重複・完了・失敗をSlackへ通知するため、成功時は追加返信せず終了する。
5. ツール自体がエラーを返し、Slackにも失敗通知できなかった場合だけ、`reply`で短く失敗を伝える。

更新workerは現在のjobが終わるまで待ち、更新中の新規job開始を止める。3リポのfast-forward、全テスト、build、setup、tmux上のbot再起動後に、元のSlackスレッドへ結果を投稿する。
