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
`/proc/sys/kernel/random/boot_id` から読む。macOS の `libproc` と同じ型を返す。

## 既知の制限

- **`zerochan start` は未配線。** `herdr-runtime.ts` は `HERDR_ENV=1` に加えて unix socket の
  `HERDR_SOCKET_PATH` と `herdr current-pane` を要求する。Windows 機の herdr は
  `x86_64-pc-windows-msvc` build（`herdr.exe`）で WSL 内の Linux build ではないため、この条件を
  満たせない。WSL 内に Linux 版 herdr を入れて pane から起動する配線が別途必要
- cgroup は同一 uid の process なら `cgroup.procs` へ自分を書いて抜けられる（delegated subtree 内）。
  macOS の Seatbelt profile ほど敵対的な脱出には強くない。目的は「うっかり setsid した子」の回収で、
  その範囲では kernel が一覧を返すので十分
- `PR_SET_NO_NEW_PRIVS` を立てるので、Codex tree の中では setuid binary（`sudo` など）が効かない
- `-I` で起動する Python は、呼び出し側が locale を一切渡さない場合だけ `LC_CTYPE=C.UTF-8` を
  環境に足す（Python 自身の locale coercion）。通常は `LANG` が渡るので起きない
- WSL2 は realtime clock が後ろへ飛ぶことがある（`dmesg` に `Time jumped backwards` が出る）。
  `Date.now()` で経過時間を測るテスト（`process-lock.test.ts` の「停止した guard owner」）が
  その瞬間に当たると短く測れて落ちる。monotonic な `performance.now()` 側は 5000ms を正しく待っている
