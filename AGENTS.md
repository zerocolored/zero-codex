# zero-codex working instructions

## タスク開始前の最新コード確認・取り込み（必須）

- 読み取り専用を含む開始・再開時に、remote、branch、upstream、worktree、未コミット変更を確認し、作業branchと統合branchをfetchしてSHAとahead/behindを比較する。
- ホストはfetch・比較の結果を主担当へ渡す。書込み可能な利用者の調査依頼もあるため、権限だけでcheckoutを変更しない。
- 主担当は実装前に、cleanかつfast-forward可能な作業branchを、remoteとbranchを明示した`git pull --ff-only`で更新する。fetchだけで作業ファイルが最新になったとは扱わない。
- 新規作業はfetch済みの統合先（このrepositoryはmain）から専用branch/worktreeで始める。継続は既存の作業branch/worktreeを引き継ぎ、無関係な統合branch更新を自動で強制しない。managed workspaceでは指定された物理rootを維持する。
- 未コミット変更、履歴分岐、upstream未設定・削除、競合、通信失敗は保持して報告し、調査や認可済みの競合解消は継続できる。古いcheckoutで未確認の実装を始めない。自動stash、reset、force-push、推測した別branchのpullは禁止する。
- 読み取り専用ではcheckoutを変更せず、取得済みrevisionを調べて対象SHAと制約を報告する。remoteなし・非Gitを最新版取得済みと報告しない。

## push前の最新コード取り込み（必須）

- pushする前に、remote、対象branchとupstream、worktree、未コミット変更を確認し、
  remoteとbranchを明示した`git pull`で最新コードをローカルへ取り込む。
  `git fetch`だけで済ませたり、remote-tracking refの更新をローカルの更新として報告したりしない。
- 既存の作業branchはそのremote branchからpullし、`main`の更新もfetchして作業branchへ取り込む。
  新規branchの初回pushではremote側に同名branchがまだないため、先に元cloneの`main`で
  `git pull --ff-only origin main`を実行し、その最新commitを作業branchへ反映する。
- 別worktreeで作業した場合も、元cloneの`main`を古いまま放置しない。
  push前とPRのマージ後に元cloneで`git pull --ff-only origin main`を実行し、
  作業branchのpush状態と元cloneの同期状態をそれぞれ確認する。
- pullで競合や履歴分岐が生じた場合は、ローカル・リモート双方の変更を保持して統合し、
  影響箇所を再検証してからpushする。無関係な変更を含めず、自動stash、reset、force-pushは行わない。
  未コミット変更や認証・通信の問題で安全に同期できない場合はpushを止め、理由と未同期の状態を報告する。
- push直前にリモートがさらに進んでいれば再度取り込み、必要な検証を行う。
  完了報告ではpullしたbranchとcommit、push結果、元cloneとremoteのahead／behindを明記する。

## 新しいMacのセットアップ依頼

ユーザーがこのcloneで「セットアップして」「新しいMacへ入れて」などと依頼した場合は、
repository直下の`SETUP.md`を最初から最後まで読み、そこを唯一の手順正本として利用可能確認まで進める。
READMEの断片的な旧手順だけで完了判定しない。

- 技術的な選択をユーザーへ質問しない。状態を診断し、再実行可能な既存bootstrapを使う。
- 別PCが同時に動く可能性がある新規Macでは、そのMac専用の新しいSlack Appを既定にする。
  既存App/tokenを再利用するのは、ユーザーが旧PCのgatewayを停止して移行すると明示した場合だけにする。
- clone rootから`bash zerokun/bootstrap-macos.sh --doctor`を実行後、Codexのtool用PTYへ秘密を
  入力させず、`bash zerokun/interactive-bootstrap.sh --repo-dir "$PWD"`で基本導入を実行する。
  このBun不要のlauncherがユーザーから直接操作できる可視Terminalを開き、
  bootstrapの終了receiptまで待つ。対象projectが依頼や環境から一意に分かる場合だけ
  `--project-dir`も付ける。
- Slack Appの作成・manifest設定・通常のworkspace install・channel招待はAIがブラウザで代行する。
  手順をユーザーへ渡して作成を任せない。作成済みAppを確認し、中断後も重複作成せず続行する。
- macOSのinstall dialog、Codex／Grok／Claude Code／GitHub／Slackの本人login、
  MFA・CAPTCHA・管理者本人による承認は必要な本人操作だけを依頼する。完了後はAIが続きから進める。
  ブラウザ操作経路が利用不能なら接続・許可の復旧だけを依頼し、App作成全体を人へ差し戻さない。
- Claude Code CLI自体はbootstrapがAnthropic公式native installerで導入する。未loginなら、導入済み
  `claude`を可視TerminalまたはHerdrでユーザー本人が起動してsubscription loginするのだけを待つ。
- トークン取得・登録もAIが代行し、本人のコピー・貼り付けを通常手順にしない。
  Slack画面のコピー操作から可視Terminalの`zerochan set slack-app`の非表示promptへ転送する。
  既存一覧では新規なら`n`、登録済みなら番号を選ぶ。新規入力順はBot Token（xoxb）→App-Level Token（xapp）。
  既存bootstrapの入力順は逆なので、常に現在のpromptラベルを確認する。
  token本文をchat、ツール引数・出力、command argv、環境変数、通常logへ載せず、秘密表示の
  screenshot／DOM全文取得を避ける。既存の同一App照合とmode 0600保存を使い、直接.envを編集しない。
  秘密を露出せずUIで転送できる経路がない場合だけ、別経路を確認して具体的な不足を報告する。
  自動登録したと偽らず、本人操作への切替は理由と必要最小限の操作を明示する。
- Slack App作成、project/channel紐付け、対象projectでの`zerochan start`、gateway状態、queue状態、
  Slack上の実応答まで確認する。単にbootstrapが終了しただけでは完了にしない。
- `zerochan start`をHerdr外から実行した場合は、launcherが対象project専用のHerdr workspaceを作って
  同じcommandをそのroot paneへ引き継ぐ。Codexは手動exportや曖昧なpane選択を要求せず、稼働確認まで待つ。
- `zerochan status`は現在projectのchannel紐付け確認、`zerokun-status`はgateway process確認である。
  両者を取り違えない。
- Slackへの接続テストはZeroちゃん自身の通常経路だけを使う。tokenを読んでSlack APIを直接呼ばない。
- 人にしか解消できない画面がある場合は、その1操作だけを具体的に示して待ち、確認後は残りを最後まで再開する。
