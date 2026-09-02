# zero-codex working instructions

## 新しいMacのセットアップ依頼

ユーザーがこのcloneで「セットアップして」「新しいMacへ入れて」などと依頼した場合は、
repository直下の`SETUP.md`を最初から最後まで読み、そこを唯一の手順正本として利用可能確認まで進める。
READMEの断片的な旧手順だけで完了判定しない。

- 技術的な選択をユーザーへ質問しない。状態を診断し、再実行可能な既存bootstrapを使う。
- 別PCが同時に動く可能性がある新規Macでは、そのMac専用の新しいSlack Appを既定にする。
  既存App/tokenを再利用するのは、ユーザーが旧PCのgatewayを停止して移行すると明示した場合だけにする。
- clone rootから`bash zerokun/bootstrap-macos.sh --doctor`を実行後、Codexのtool用PTYへ秘密を
  入力させず、`bash zerokun/interactive-bootstrap.sh --with-slack --repo-dir "$PWD"`を実行する。
  このBun不要のlauncherがユーザーから直接操作できる可視Terminalを開き、
  bootstrapの終了receiptまで待つ。対象projectが依頼や環境から一意に分かる場合だけ
  `--project-dir`も付ける。
- macOSのinstall dialog、Codex／Grok／Claude Code／GitHubのlogin、Slack workspaceの承認、
  MFA・CAPTCHA・管理者承認は人の操作を待つ。完了後は同じbootstrapを再実行し、自動的に続きから進める。
- Claude Code CLI自体はbootstrapがAnthropic公式native installerで導入する。未loginなら、導入済み
  `claude`を可視TerminalまたはHerdrでユーザー本人が起動してsubscription loginするのだけを待つ。
- `xapp-`／`xoxb-` tokenをchat、Codexのtool入力、command argv、環境変数、通常logへ貼らせない。
  ユーザー本人がbootstrapの表示されない端末promptへ直接貼り、既存の同一App照合とmode 0600保存を使う。
- Slack App作成、project/channel紐付け、対象projectでの`zerochan start`、gateway状態、queue状態、
  Slack上の実応答まで確認する。単にbootstrapが終了しただけでは完了にしない。
- `zerochan start`をHerdr外から実行した場合は、launcherが対象project専用のHerdr workspaceを作って
  同じcommandをそのroot paneへ引き継ぐ。Codexは手動exportや曖昧なpane選択を要求せず、稼働確認まで待つ。
- `zerochan status`は現在projectのchannel紐付け確認、`zerokun-status`はgateway process確認である。
  両者を取り違えない。
- Slackへの接続テストはZeroちゃん自身の通常経路だけを使う。tokenを読んでSlack APIを直接呼ばない。
- 人にしか解消できない画面がある場合は、その1操作だけを具体的に示して待ち、確認後は残りを最後まで再開する。
