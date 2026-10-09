# Linux (WSL2) で Codex を起動する仕組み

macOS では Codex を起動するたびに `/usr/bin/sandbox-exec` で包み、1 attempt ごとに作る
`allow` / `deny` の 2 つの tag file（`<state>/sandbox-obligations/<job>/<nonce>/`）のうち
`deny` だけを読めなくする Seatbelt profile を付けている。これは「サンドボックス」というより
**プロセスに刻む印**で、`sandbox_check()` を PID ごとに呼べば「この attempt の子孫か」を
kernel に答えさせられる。setsid して PID 1 へ再親付けされた子でも回収できるのはこのため
（`zerokun/seatbelt-fingerprint.ts` の `reapSeatbeltFingerprint`）。

Linux には `sandbox_check` が無く、Landlock は deny list を書けない。そこで
`zerokun/linux-sandbox-launcher.py` が検証の向きを変える。

## launcher が exec 前にやること

| 段階 | 何を | 何のため |
|---|---|---|
| 1 | `systemd-run --user --scope --unit zerokun-fp-<nonce>-<pid>` で自分を再 exec | **外から見る印**。cgroup 所属は fork / setsid / 再親付けで消えず、`cgroup.procs` を読めば kernel が子孫一覧を返す。reaper はこれで回収する |
| 2 | Landlock ruleset（扱う権限は `LANDLOCK_ACCESS_FS_MAKE_BLOCK` だけ）を attempt directory 配下だけ許可して `landlock_restrict_self` | **中から証明できる印**。子孫は解除できない。block device の作成は CAP_MKNOD 無しでは誰も使わないので workload に副作用が無い |
| 3 | attempt directory で `mknod(S_IFBLK)` → **EPERM**、その親で同じこと → **EACCES** を確認 | Landlock は capability 検査より先に答えるので、EPERM = 「Landlock は許可した（capability だけ無い）」、EACCES = 「obligation が拒否した」と区別できる。どちらか違えば exit 71 で止まる（fail-closed） |
| 4 | receipt を `<state>/sandbox-receipts/<job>/<nonce>/<pid>.json` に書く | 証拠。unit 名・cgroup path・Landlock ABI・両 probe の errno・PID |
| 5 | `execve` で本来のコマンドへ | 中継プロセスを残さない。`systemd-run --scope` も exec in place なので、spawn した PID がそのまま Codex の PID |

darwin の経路は一切変えていない（`sandboxedCommand()` が darwin で返す配列は従来 inline で
組んでいたものと同一）。

### なぜ「deny file を読めなくする」のをそのまま Landlock にしなかったか

Landlock は allow list しか書けない。「deny だけ読めない」を作るには READ_FILE を扱う権限にして
deny の **全祖先の兄弟**を 1 つずつ許可するしかなく、launcher 以降に祖先 directory へ新しく
作られた entry（`$HOME` 直下の新 directory、state 直下の新 directory、bwrap の tmpfs など）が
全部読めなくなる。印として必要なのは「kernel が強制し、子孫が外せず、attempt ごとに違う」こと
だけなので、副作用ゼロの MAKE_BLOCK を使っている。

## 適用される経路

- `readCodexAppServer`（config/read・thread 読み取りなどの短命 App Server）: macOS と同じ場所で
  `sandboxedCommand()` を通す
- `codex-supervisor.ts` の実ジョブ: macOS では直接の Codex プロセスを profile の外に置き、Codex 自身の
  sandbox policy（allow tag の read 許可）で tool command 側に印を付ける。Linux では Codex の
  sandbox に印を注入できないので、**gate の `/bin/sh` ごと launcher で包む**（tree 全体が scope に入る）

## 必要なもの（WSL2 Ubuntu 24.04 で実測）

- Landlock ABI 1 以上（WSL2 kernel 6.6 は ABI 3。`/sys/kernel/security` が空でも securityfs が
  mount されていないだけで、syscall は使える）
- `systemd --user` が動いていること（`systemd-run --user --scope` が bus に繋がる）。
  `XDG_RUNTIME_DIR` が環境に無ければ launcher が `/run/user/<uid>` を補い、exec 前に外す
- `/usr/bin/python3`（Ubuntu 標準の 3.12。追加 package 不要）
- `libc.so.6`（`process-lock.ts` / `process-generation.ts` が `flock` / `sysconf` を FFI で呼ぶ）

process の世代（boot id + 起動時刻）は `/proc/<pid>/stat` と
`/proc/sys/kernel/random/boot_id` から読む。macOS の `libproc` と同じ型を返すが、
`startSec` / `startUsec` は **boot からの経過**（起動 tick ÷ `CLK_TCK`）で epoch ではない。
`/proc/stat` の `btime` を足して epoch にすると、WSL2 の realtime clock が後ろへ飛ぶたびに
`btime` も動き、executor と supervisor で読んだ値がずれて generation 照合が全件落ちる
（2026-10-08 に実測。`dmesg` に `Time jumped backwards` が 30 秒前後ごとに出る機体）。

## Herdr（`zerochan start` の前提）

`herdr-runtime.ts` は `HERDR_ENV=1` に加えて unix socket の `HERDR_SOCKET_PATH` と
`herdr pane current --current` を要求する。Windows 側の `herdr.exe` は使えない（unix socket が無い）
ので、**WSL の中に Linux 版 Herdr を入れ、headless server を常駐させる**。

```bash
# 1. 公式 installer（macOS の bootstrap と同じ入口。linux-x86_64 / linux-aarch64 を配布）
curl -fsSL https://herdr.dev/install.sh | HERDR_INSTALL_DIR="$HOME/.local/bin" sh
# 2. headless server を systemd --user で常駐（WSL2 では誰も TUI を開かないため）
install -D -m 0644 zerokun/linux/herdr-server.service ~/.config/systemd/user/herdr-server.service
systemctl --user daemon-reload
systemctl --user enable --now herdr-server.service
loginctl enable-linger "$USER"     # ログインシェルが無くても user service を起こす
# 3. 確認
herdr status server                 # status: running / socket: ~/.config/herdr/herdr.sock
```

実測（2026-10-09, Ubuntu 24.04 / herdr 0.9.3 linux-x86_64）:

- `zerokun_require_herdr_version`（最低 0.8.2 + workspace/tab/pane/agent API の probe）が通る
- socket は `srw-------` の owner-only で `requireOwnedNode` の条件を満たす
- `herdr workspace create --cwd … --label … --focus` → `w1` / `w1:t1` / `w1:p1` / `term_…` を返し、
  その pane の shell には `HERDR_ENV=1` `HERDR_SOCKET_PATH` `HERDR_PANE_ID` 等が入る
- pane 内で `bun zerokun/herdr-runtime.ts runtime-id` が 64 桁の fingerprint を返す（= 起動 identity の
  固定・再検証が WSL でも機能する）

server が止まっていると herdr CLI は exit 0 のまま `{"error":{"code":"server_not_running",…}}` を返す。
`herdr-start.ts` はこの封筒をそのまま message に出し、Linux では `systemctl --user start herdr-server`
を添える。

## Codex（official standalone）

`codex-channel.sh` は Herdr 検査の後に `zerokun/standalone-codex.ts version` で **公式 installer が置く
standalone だけ**を採用する（PATH / npm / `ZEROKUN_CODEX_BIN` は信頼境界の外）。公式 installer は
Linux でも同じ 2-link layout を作る。

```bash
# chatgpt.com/codex/install.sh は linux-x86_64 / aarch64 に musl build を配る
curl -fsSL https://chatgpt.com/codex/install.sh -o /tmp/codex-install.sh
CODEX_NON_INTERACTIVE=true sh /tmp/codex-install.sh     # npm 版が居ても消さない（PATH 順の警告だけ）
#   ~/.local/bin/codex -> ~/.codex/packages/standalone/current/bin/codex
#   ~/.codex/packages/standalone/releases/<version>-x86_64-unknown-linux-musl/codex-package.json
bun --config=/dev/null --no-env-file zerokun/standalone-codex.ts version   # 例: 0.162.0
codex login   # ChatGPT ログイン（人の作業）
```

`officialStandaloneTarget()` が Linux で `<arch>-unknown-linux-musl` を返し、release directory 名・manifest の
`target`・ELF header を照合する（macOS の Mach-O 照合と同じ厳しさ。`bootstrap-macos.sh` の python 検査は
macOS 専用のまま）。

実測（2026-10-09, codex 0.162.0）: `zerokun_require_codex_version` が通り、
`codex-executor.ts verify-system-config` が `system config, App Server history, and managed Codex permissions
are compatible` を返す。この probe（`codex-app-server-capability.ts`）と advisor broker の Grok / Claude 起動も
inline の `sandbox-exec` ではなく `sandboxedCommandForTags()` を通るので、Linux では launcher で包まれる。

## Grok CLI / Slack token / setup.sh / `zerochan start`

`zerokun/setup.sh` は Grok reviewer（公式 Grok CLI `~/.grok/bin/grok` 前提）と fifth-advisor helper を
要求する。公式 installer は Linux も配っている。

```bash
curl -fsSL https://x.ai/cli/install.sh -o /tmp/grok-install.sh && bash /tmp/grok-install.sh
#   ~/.grok/bin/grok -> ../downloads/grok-linux-x86_64（~/.bashrc に PATH 追記）
bash zerokun/linux/register-slack-tokens.sh      # xapp- / xoxb- を非表示入力で <state>/.env へ
bash zerokun/setup.sh                            # Linux では watchdog を systemd --user timer、管理ブロックを ~/.bashrc へ
cd <対象project> && zerochan start               # Herdr 外から実行すると専用 workspace を作って起動する
zerochan status                                  # ▶ Zeroちゃん: 稼働中 (PID …)
```

shell entrypoint の macOS 専用部分は `zerokun/stat-compat.sh` で吸収した:

| 箇所 | macOS | Linux |
|---|---|---|
| 所有者・link 数・権限・種別（`state-dir.sh` / `setup.sh` / `codex-channel.sh` / `codex-version.sh` / `watchdog.sh`） | `/usr/bin/stat -f '%u' '%l' '%Lp' '%HT'` | `stat -c '%u' '%h' '%a' '%F'`（`zerokun_stat_*` / `watchdog_stat_*`） |
| watchdog の常駐（60 秒間隔） | launchd plist（`~/Library/LaunchAgents`） | `~/.config/systemd/user/<label>.service` + `.timer`（`OnUnitActiveSec=60`）。`update.ts --setup-supervisor` 配下は環境が最小なので `XDG_RUNTIME_DIR=/run/user/<uid>` を明示して `systemctl --user` |
| 管理ブロック（PATH / `ZEROKUN_STATE_DIR` / alias） | `~/.zshrc` | `$SHELL` が bash なら `~/.bashrc` |
| gateway の exec | `caffeinate -dimsu bun server.ts` | `bun server.ts`（caffeinate は macOS 専用。exec が失敗すると gateway が立たず `起動確認がtimeout` になる） |

実測（2026-10-09, WSL2 Ubuntu 24.04）: `setup.sh` が最後まで通り（Slack identity 検証・Codex・Grok reviewer・
runner/CLI 設置・watchdog timer 登録）、`zerochan start` が Herdr workspace `Zeroちゃん <project>` を作って
gateway / runner / recovery launcher を起動、pane に `slack channel: connected (U…) app=A…`、
`gateway-ready.json` に `connectedAt` が書かれ `zerochan status` が `稼働中` を返した。
`launcher.test.ts`（26 件）と `watchdog.test.ts`（8 件）の Linux 失敗はこの変更で 0 になった。

## 既知の制限

- `zerochan update`（自己更新）は Linux で未実測。`verify.sh` / `interactive-bootstrap.sh` /
  `bootstrap-macos.sh` には `stat -f` が残るが、いずれも macOS 専用の経路
- Slack の DM は pairing（`zerochan-access pair <code>`）、チャンネルは `zerochan set slack-channel <ID>` が
  macOS と同じく必要
- Herdr の headless server と watchdog timer は systemd --user に依存する。WSL2 が落ちると全部止まり、
  `loginctl enable-linger` 済みでも WSL 自体の起動は Windows 側のきっかけが要る
- cgroup は同一 uid の process なら `cgroup.procs` へ自分を書いて抜けられる（delegated subtree 内）。
  macOS の Seatbelt profile ほど敵対的な脱出には強くない。目的は「うっかり setsid した子」の回収で、
  その範囲では kernel が一覧を返すので十分
- `PR_SET_NO_NEW_PRIVS` を立てるので、Codex tree の中では setuid binary（`sudo` など）が効かない
- `-I` で起動する Python は、呼び出し側が locale を一切渡さない場合だけ `LC_CTYPE=C.UTF-8` を
  環境に足す（Python 自身の locale coercion）。通常は `LANG` が渡るので起きない
- WSL2 は realtime clock が後ろへ飛ぶことがある（`dmesg` に `Time jumped backwards` が出る）。
  `Date.now()` で経過時間を測るテスト（`process-lock.test.ts` の「停止した guard owner」）が
  その瞬間に当たると短く測れて落ちる。monotonic な `performance.now()` 側は 5000ms を正しく待っている
