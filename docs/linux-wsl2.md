# Linux / WSL2 updater compatibility

PR #198 の updater 差分を main に取り込んだ記録です。以下の WSL2 実測は PR 作者による develop 系列での記録（2026-10-09）であり、main の Linux 起動全経路の動作確認を意味しません。今回の統合検証環境は macOS です。

## `zerochan update`（自己更新）

実測（2026-10-09, WSL2）: `ZEROKUN_UPDATE_BRANCH=<branch> zerochan update` が候補検証 → release 配置 →
gateway 差し替え（`Herdr pane: w6:p2`、`zerokun: updated`）まで通り、`gateway-ready.json` の `release` が
新 SHA になった。macOS との違いは候補検証の sandbox（`codex sandbox`）にある:

| 箇所 | macOS（Seatbelt） | Linux（bubblewrap, codex-cli 0.162.0 実測） |
|---|---|---|
| Unix socket | `--allow-unix-socket <candidate tmp>` | flag が無い（渡すと `unexpected argument` で exit 1）。network proxy 下では seccomp が bind を拒むので `network.dangerously_allow_all_unix_sockets=true` を候補 sandbox だけに足す（`network.unix_sockets` は connect の exact path のみ） |
| filesystem rule | home / live repo / state を全部 deny、bun を read | deny 配下の deny は bubblewrap が `Can't mkdir parents` で落ち、deny 配下の read は見えない。入れ子の deny は落とし、bun と bundled `codex-resources/bwrap` を trusted-bin へ stage する（`linuxCandidateFilesystemRules` / `stageLinuxCandidateTools`）。deny 配下の write（release checkout）は通る |
| sandbox 内の証拠 | Codex が `CODEX_SANDBOX=seatbelt` を立てる | 何も立たない。updater が `ZERO_CODEX_CANDIDATE_SANDBOX_DENIED=<live repo>/zerokun/verify.sh` を渡し、その不在を `verify.sh` / `project-git.ts` の候補経路選択に使う。環境変数だけは隔離の証明にならず、安全境界は updater が起動する sandbox にある |
| uid | そのまま | system binary の owner が nobody（65534）に写る。owner 検査に `/usr/bin/true` を使う fixture は落ちるので `process.execPath` に |
| inode | — | 空いた inode 番号を即再利用する。添付 cache の identity に size も持つ |
| network | proxy 経由 | proxy 無しだと外へ出られない（`features.network_proxy=true` 必須） |

更新元は `main` 固定。端末の `ZEROKUN_UPDATE_BRANCH` だけが例外で、インスタンス別更新（`prepareIndependentRelease`）でも効く（state の `.env` からは落ちる）。

