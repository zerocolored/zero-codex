# App Serverイベント順序と長時間ログ

## #244の停止

失敗記録の直接原因は `App Server started an item before turn/started`。
旧処理はactive turnが見つからないitem開始を一律にprotocol errorとし、
通知の先行・開始未観測・終了後の遅延を区別せずジョブ全体を停止していた。
当該stdoutは20MiBの保存上限で途切れており、実際にどの順序だったかは確定できない。

## 回復契約

- 未開始turnのitem開始・完了はthread/turn単位で隔離する。itemからturnを生成しない。
- 正式なturn開始を通知した後に、同じturnの保留itemだけを順に反映する。
- 開始通知が来ない子turnがあっても親の処理は続行する。
- 終了したturnの遅延itemは最終回答・権限証拠・進捗callbackを更新しない。
- 保留は最大256件・JSON文字数1Mi相当で有界化する。上限超過で通常ジョブは止めない。
  証拠欠落後は厳格なpermission probeの成功証明には使用しない。
- 開始未観測のままterminalを受けた場合、保留回答を採用せずterminalの公式結果を使う。

## 保存ログ

既存stdoutは先頭最大20MiB。同じパスに以下を追加する（owner-only）。

- `.tail-0.log` / `.tail-1.log`: 各最大1MiBの循環segment。直近1〜2MiBを保持する。
- `.tail.json`: 終了時の総byte数、先頭切捨て有無、最新segment、各segmentの開始byte位置。

`segmentStartBytes`の昇順にsegmentを読む。segment境界はUTF-8文字やJSON行の途中に
なり得るため、byte列として結合してから完全な行を診断に用いる。
protocol解析が停止した後もpipeを排出し、受けた出力のtail保存を継続する。
worker自体の強制終了では最終indexが未保存の場合がある。tailを完全履歴と見なさない。
ジョブ保存期限でtailも削除する。他ジョブのログは削除しない。

## 検証

`bun test zerokun/codex-app-server-session.test.ts zerokun/diagnostic-tail.test.ts`
で通知順序、親子分離、terminal不変、保留上限、byte境界、保持期限を検証する。

`bun test zerokun/codex-app-server-executor.test.ts --test-name-pattern job244`
は実executorにfixture App Serverを接続し、先行item・終了後item開始・21MiB超の出力を
組み合わせ、process1回で正しい最終回答へ到達しtailが残ることを検証する。
実際の#244の業務処理を再実行するテストではない。
