# ブラウザでのヒアリング

Slackで「会議したいです」「今から声で相談したい」と依頼すると、既存の意味分類が meeting に振り分ける。会議機能の開発依頼・過去会議の要約は work のまま。進行中の開発タスクを上書きしない。会議URLは既存の永続通知outboxで配送する。

## 構成

- gateway: プロジェクトREADMEの要約と、その時点までのSlackスレッドのユーザー・アシスタント発言を取得。長い履歴は時系列の各区間を要約する。添付ファイルの内容は自動では読み込まない。
- meeting-web: 独立したBunサービス。単一プロセス＋永続volumeのSQLiteへ招待・文脈・録画チャンクを保存する。chunkとdigestは同一transactionで確定する。
- browser: WebRTCでGPT-Liveへ音声を送受信。Simliのアバター映像と共有画面をCanvasに合成し、マイク＋Simliから返る同期済みAI音声をWeb Audioで混合してMediaRecorderで録画する。OSのシステム音声収録には依存しない。
- gateway: 30秒ごとに録画を回収。チャンクのSHA-256とサイズを照合し、順番に一つの動画へ連結、fsync・rename後に受領通知する。端末停止中はサーバーに残る。

録画保存先はアプリのstate directory配下の meeting-recordings/会議UUID/。manifest.jsonに元のproject/channel/threadと録画のsegment UUID、MIME、digest一覧がある。同じproject・channel・threadの後続workerにだけ保存済みmanifestを案内する。録画の自動Slack添付は行わない。

## 音声APIと描画の根拠

2026-10-23に公式資料を確認し、GPT-Live 1（gpt-live-1）、POST /v1/live/sessions、JSONのsessionとtransportによるSDP交換を採用。恒久APIキーと初期コンテキストはサーバーだけに渡す。ブラウザはsession.startedを待ち、終了時はsession.closeとsession.closedを扱う。モデルはコードに固定し、勝手に別モデルへ切り替えない。

- [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc)
- [GPT-Live 1](https://developers.openai.com/api/docs/models/gpt-live-1)
- [Create Live session](https://developers.openai.com/api/reference/resources/live/methods/create)
- [Web Audio visualization](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Visualizations_with_Web_Audio_API)
- [Voice orb reference](https://github.com/OrbitingBucket/voice-orb-visualizer)

承認済みの明色UI。タイトルと録画中マーク、動き停止ボタンは設けず、表示領域を広くし、共有中のアバターは右上。下部にスピーカーミュート・マイクオフ・画面共有、右端に終了。入室後は現地時刻に合う挨拶と「タスクの内容について聞かせていただけますか？」から始める。Live公式のstartup inputとsession.started後のcommentary appendを使う。実際の発話は実APIで検証する。

Simli 3.1.0のP2P SDKをローカルbundleとして配信。恒久キーはサーバーのみ。ブラウザには会議のsegmentに紐付くsession tokenとICE情報だけを渡す。Liveの受信音声をAudioWorkletで16kHz PCM16へ変換してSimliへ渡し、返ってくる音声と顔映像を再生・録画する。Liveの元音声を重複再生しない。Simli FACE_IDを設定で差し替え可能。J3生成中は承認済みの既製顔IDを利用する。

共有開始時と15秒ごとに最大1280pxのJPEGをOpenAI Responses（gpt-6-luna）へ送り、短い視覚要約をLiveへ渡す。Live自体は画像を受け取らない。画面共有停止後に返ってきた結果は破棄する。共有画像の読み取り失敗時は音声を維持する。動画の全フレームをAIが理解する保証ではない。

参照: [Liveの挨拶](https://developers.openai.com/api/docs/guides/live-conversations#greet-before-the-caller-speaks)、[視覚コンテキスト](https://developers.openai.com/api/docs/guides/live-delegation#add-images-and-visual-context)、[Simli SDK](https://docs.simli.com/api-reference/javascript)。

## 配備

既存のfleet-webとは独立。repository内に既設Railwayサービスの識別情報はないため、既存サービスへ誤って上書きせず、専用サービスを使用する。

1. Railwayでこのrepositoryのmeeting-web/Dockerfileを使用し、設定ファイルをmeeting-web/railway.jsonに指定。
2. 永続volumeを /data にマウント。replicaは1。複数replicaや一時filesystemでの運用は不可。
3. HTTPSのドメインを発行し、MEETING_ORIGINにそのorigin（末尾スラッシュなし）を指定。
4. サーバーのsecretへOpenAIプロジェクトのOPENAI_API_KEY、SIMLI_API_KEY、SIMLI_FACE_IDと、32 bytes以上の乱数から作ったMEETING_ADMIN_TOKENを登録。これらをGit、ログ、Slack本文へ記載しない。
5. 各gatewayのstate directoryのmeeting.jsonへ origin と adminToken をowner-only (0600)で登録する。adminTokenは上記サービス専用値。Slack token、fleet credential、Codex subscriptionの認証を代用しない。
6. gateway更新後、会議依頼から録画回収まで実通話で確認する。healthが200でも、voiceConfiguredだけではAPI認証・課金権限・実音声接続を証明しない。

開発時のみMEETING_LOCAL_DEVELOPMENT=1とhttp://127.0.0.1:ポートのoriginを使用できる。本番のHTTPや任意のredirect先へ秘密を送らない。準備したデプロイ設定だけでは公開済みとは扱わない。

## 操作・保存の境界

- 招待は24時間有効。room ID自体には権限がない。URL fragmentの招待capabilityはHTTPリクエスト・referrerへ載らない。最初に参加したブラウザのランダム秘密へ紐付ける。一対一の会議で、URLを持つ別ブラウザの割り込みを防ぐ。別端末で参加する場合は新しい会議を依頼する。
- 公開ページのGET・Slack unfurlは招待を消費しない。招待保持者には参加と録画送信だけを許可し、サーバーの録画download・一覧は管理者だけ。
- 入室前に録画とOpenAIへの送信に同意。マイク拒否時は再試行可能。共有拒否時は音声会議を続けられる。マイクオフはAIへの送信と録画側マイクの両方へ反映。スピーカーミュートは利用者への再生だけを止め、録画のAI音声は保持。
- 会議画面と共有画面は録画する。共有画像は上記の視覚モデルを経由して会話へ反映する。
- 720p、約1.5Mbps、最長2時間、1会議2GiB。Chrome/EdgeのWebM対応を検出する（既存MP4録画の回収互換は維持）。共有ボタンはgetDisplayMedia非対応なら無効にする。
- 通信断では録画をIndexedDBに保持して再送。同じseqとdigestは冪等ACK。違うbytesの上書き、欠落した録画の完了扱いは拒否する。
- 終了後はサーバー保存済みと端末保存済みを区別する。再読込時は未完了録画を保存し直せる。端末が停止中でもサーバー保存を失敗と表示しない。
- タブ強制終了・ブラウザのデータ消去・OS停止時の未記録末尾は保証できない。取得済みチャンクは保持し、完了した録画と区別する。ブラウザ保存失敗時はダウンロードで退避可能。
- 現時点では自動削除しない。サーバーvolumeと端末の容量・バックアップを運用対象とする。公開前に実音声・映像再生と端末回収を検証する。

## 検証

`bun test meeting-web/service.test.ts zerokun/meeting-routing.test.ts zerokun/fleet-query.test.ts zerokun/audit-followup-routing.test.ts`

認可、リンク展開、重複依頼、初期文脈、モデル契約、順序逆転再送、欠落・改変拒否、DB再起動、local digest照合、既存route移行、作業タスク保持、同一スレッド限定の後続参照を検証。APIは合成応答であり実OpenAI接続の証拠とはしない。

開発用SDKビルド: `bun meeting-web/build.ts`。生成されるpublic/simli.jsはGit対象外。Docker build時にも生成する。
接続のdisconnectedは15秒待ち、connectedに戻れば同じ会話を継続。Liveの非致命errorは即終了しない。セッション作成前の失敗や明確な4xx拒否は録画を始めず再試行可能。結果不明のタイムアウトは重複課金を避けて自動再送しない。

映像の接続失敗・切断は音声のみへ退避し、会話と双方音声の録画を続ける。SDKの接続待ちは25秒で打ち切る。Liveの明確な拒否後は閉じたSimli tokenを捨て、再入室時に再発行する。ページ破棄時は音声切断だけを要求し、未送信録画の追記を妨げない。録画0件の失敗セッションも終了でき、端末にはmanifestのみを保存する（空の動画は作らない）。
