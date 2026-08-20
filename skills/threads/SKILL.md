---
name: threads
description: |
  Dispatch Slack channel events to per-thread subagents for isolated, persistent conversations.
  Use whenever a <channel source="slack"> event arrives. Each unique Slack thread_ts gets its
  own subagent that persists across Claude Code session restarts. This keeps unrelated
  conversations from polluting each other's context.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(mkdir *)
  - Bash(cat *)
  - Agent
  - SendMessage
  - mcp__slack-channel__enqueue_job
  - mcp__slack-channel__request_update
  - mcp__slack-channel__reply
  - mcp__slack-channel__react
---

# /slack-channel:threads — Per-thread subagent dispatcher

## What this skill does

When a Slack message arrives as a `<channel source="slack" ...>` event, route it to a dedicated subagent scoped to that Slack thread. This gives each Slack conversation its own isolated context window and persistent memory across Claude Code session restarts.

**Why this matters:** Without per-thread dispatch, every Slack message lands in the same shared context. Unrelated threads pollute each other, long threads push short ones out of view, and Claude can mix up which conversation it's in. With this skill, each thread is its own continuous conversation with its own subagent.

## State file

Thread-to-agent mappings live in `~/.claude/channels/slack/threads.json`:

```json
{
  "1718400000.000100": {
    "agent_id": "agent-a3f2c1",
    "channel_id": "C0ASQSQCGCB",
    "adopted_from_ts": "1718499990.000300",
    "last_activity_ms": 1718500000000,
    "topic": "GA CCNS disaster recovery questions"
  }
}
```

`adopted_from_ts` is the `message_id` of the event that made this thread yours.
**Write it once, when you create the entry, and never update it.** The catch-up
poller reads a thread from there until its own first sweep lands, so that
adopting a thread does not replay the backlog people wrote in it beforehand. A
value that crept forward on later replies would step over anything posted
behind it in that window, and those messages would never be seen.

`last_activity_ms` is a wall clock stamped *after* a dispatch — update it every
time. It drives the poller's 48h active window, and is the starting point for
entries written before `adopted_from_ts` existed.

Neither field gates delivery. Once a thread has been polled the poller keeps
its own read position, and messages already handed to Claude are remembered
separately, so nothing here can cause a message to be dropped or repeated.

The file survives Claude Code restarts. Subagent context is stored separately by Claude Code itself (in `~/.claude/projects/*/subagents/`), so resuming a subagent by ID restores its full conversation history.

## Key value: thread_ts

Every Slack conversation has a `thread_ts` that identifies it uniquely within a channel. In the inbound `<channel>` tag:

- **Channel top-level message**: `thread_ts = message_id` (the message that starts a thread)
- **Thread reply**: `thread_ts = original thread's message_id`
- **DM**: `thread_ts = message_id` (DMs are conceptually each its own "thread")

Always use the exact `thread_ts` attribute from the event as the lookup key. Don't normalize, don't slice — it's a timestamp string like `1718400000.000100`.

## Channel-to-repo routing

To support running a single bot across multiple project channels (one bot, many repos), this skill also reads a **routing config** that maps `chat_id` → target repo. New subagents are dispatched with that repo as their working context.

Routing config: `~/.claude/channels/slack/routes.json`:

```json
{
  "C0ASQSQCGCB": {
    "repo_path": "/absolute/path/to/rfp-knowledge",
    "label": "RFP Knowledge"
  },
  "C0ARZ5AS550": {
    "repo_path": "/absolute/path/to/sdlc-transformation",
    "label": "SDLC Transformation"
  }
}
```

The routing config is optional. If a channel isn't listed (or `routes.json` doesn't exist), the subagent uses the dispatcher's current working directory as its context. DMs always use the dispatcher's cwd — DMs don't have project channels so they can't be routed.

Routing applies **only when spawning new subagents**. Existing subagents already know their target repo from their original prompt; follow-up messages in existing threads don't re-resolve routing.

## Dispatch algorithm

When a `<channel source="slack" chat_id="..." message_id="..." thread_ts="..." user="..." ...>` event arrives:

### Step 0: Immediately acknowledge receipt (before anything else)

As your VERY FIRST action — before loading state, spawning, or routing — post a brief one-line acknowledgment to the thread so the sender sees an instant response even when the actual work will take a while. This is the dispatcher's ONE allowed Slack message; every substantive reply still comes from the subagent.

- Tool: `reply` (slack-channel MCP), passing `chat_id` and `thread_ts` from the event.
- Keep it to one short line, in the sender's language. Japanese example: `🙌 承知しました！対応します、少々お待ちください。`
- Do this for EVERY inbound message — new thread AND follow-up — because a consolidated or busy subagent may not reach its own reply for many minutes. **A thread must never sit visibly unanswered.** (This step exists specifically because batching several threads into one subagent once left ~10 threads silent for ~30 min while that subagent worked; the immediate ack prevents that.)
- For a rapid burst of follow-ups in the SAME thread, a `react` (emoji) on the message is an acceptable lighter-weight ack to avoid stacking near-identical lines — but default to the one-line text reply.

Then proceed to Step 1.

### Step 1: Load thread state

Read `~/.claude/channels/slack/threads.json`. If the file doesn't exist, treat it as `{}`. Handle JSON parse errors by treating as `{}` and logging (don't crash — an empty mapping just means all threads are "new").

```
mkdir -p ~/.claude/channels/slack
```

### Step 2: Look up the thread

Check if `threads[thread_ts]` exists.

### Step 3a: New thread → resolve routing, then spawn a subagent

If no entry exists for this `thread_ts`:

1. **Resolve target repo:**
   - Read `~/.claude/channels/slack/routes.json` (treat as `{}` if missing or unparseable).
   - Look up `routes[chat_id]`. If found, use `repo_path` and `label`.
   - If not found, fall back to the dispatcher's current working directory. Set `label` to the basename of that directory.

2. Use the `Agent` tool to spawn a subagent with:
   - **subagent_type**: `general-purpose`
   - **description**: `Slack <label> thread <thread_ts short>` (e.g. `Slack RFP Knowledge thread 1718400000`)
   - **prompt**: The full subagent prompt template below (see "Subagent prompt template"), filled in with the resolved `repo_path` and `label`.

3. After the Agent tool returns, capture the `agentId` from the result. Claude Code exposes this when an agent is spawned.

4. Write the mapping to `threads.json`:

```json
{
  "<thread_ts>": {
    "agent_id": "<agentId>",
    "channel_id": "<chat_id from event>",
    "repo_path": "<repo_path resolved above>",
    "label": "<label>",
    "adopted_from_ts": "<message_id from event>",
    "last_activity_ms": <now>,
    "topic": "<first ~60 chars of the user's message>"
  }
}
```

Use atomic write: write to `threads.json.tmp`, then rename to `threads.json`. Always Read the file first before Write to preserve other threads' entries.

### Step 3b: Existing thread → resume the subagent

If `threads[thread_ts]` exists:

1. Use the `SendMessage` tool:
   - **to**: `<agent_id from threads.json>`
   - **message**: The inbound event, formatted per the "Follow-up message template" below.

2. Update `last_activity_ms` in `threads.json` to the current timestamp. Leave `adopted_from_ts` alone — it belongs to the adoption, not to this reply.

Claude Code automatically resumes stopped subagents when they receive a SendMessage. The subagent picks up with its full prior context intact.

### Step 4: Only the brief receipt-ack comes from the dispatcher

Apart from the one-line receipt acknowledgment in Step 0, the subagent is responsible for ALL substantive replies (results, PRs, questions, progress) via the `reply` tool. Don't do the actual work or post substantive answers from the main session — that would bypass the isolation and mix contexts. The dispatcher's entire Slack footprint is the Step 0 ack; everything else flows through the thread's subagent.

## Subagent prompt template

When spawning a new subagent for a Slack thread, use this prompt (fill in the values from the event and routing resolution):

```
You are a dedicated Slack thread handler for the slack-channel plugin.

## Your project context

- **Project:** <label>  (e.g. "RFP Knowledge", "SDLC Transformation")
- **Repo path:** <repo_path>  (absolute filesystem path)

**First action — IMPORTANT:** Read `<repo_path>/CLAUDE.md`. That file defines this
project's workflows, conventions, and domain rules. Every piece of work you do
in this thread should be grounded in what that file tells you. If CLAUDE.md
references other files (index, templates, library, etc.), know where they are
and Read them as needed.

For all file operations, use absolute paths rooted at `<repo_path>`. If you run
Bash commands, prefix with `cd <repo_path> && ...` or use `--cwd <repo_path>`
where the tool supports it. The parent Claude Code session's cwd may differ
from your project context — don't rely on relative paths or `pwd`.

## Your scope

You handle exactly ONE Slack thread. Every message you'll receive in this session
comes from the same `thread_ts`. Keep your responses relevant to this thread only.

## Route conflict-prone work through the global serial queue

Classify every inbound message before doing substantive work:

- If the sender explicitly asks to update Zero-kun itself or the three managed
  repositories, invoke `/zerokun-update`. `enqueue_job`を呼ばない。The dedicated
  maintenance worker must own this operation so the current job never waits for itself.
- Keep greetings, explanations, status questions, and quick read-only checks in this
  thread subagent.
- **Call `enqueue_job` exactly once** for a deep or multi-step investigation, or when
  the sender requests changes to code, settings, or documentation; tests/builds;
  commit/push; deployment; or PR work. The SQLite runner owns the task after enqueue.
  **Do not also investigate, edit files, run commands, or delegate the same task from
  this thread subagent.**

Pass the exact inbound values to `enqueue_job`:

- `chat_id`: Slack `chat_id`
- `thread_ts`: Slack `thread_ts`
- `message_id`: Slack `message_id` (for a follow-up, use its Timestamp)
- `user_id`: Slack `user` / `user_id`
- `repo_path`: the absolute routed project path above
- `task`: the sender's complete request, preserving requirements and links

**Never tell the worker to post to Slack in `task`.** Preserve the sender's requirements,
but drop or rewrite any instruction that makes the worker deliver its own result to a
channel or thread ("Slack に報告して", "reply in the thread", "post the CSV here"). The
worker runs in a separate process that has no bot identity; Zero-kun posts the worker's
final response under the bot after it exits. A `task` that orders a Slack post pushes the
worker to reach for whatever Slack tool it can find — which is how a job report came to be
published under the owner's own Slack account instead of the bot's (found 2026-08-17; the
same mistake had happened before). Ask for artifacts as local absolute paths instead.

Zero-kun auto-posts the worker's final report under the bot, but that notification is text
only — it carries no files. So when a worker reports a path to a CSV, screenshot, or any
other artifact, relay it yourself from this thread subagent with `reply`'s `files` array,
which uploads under the bot token.

The worker also cannot reach the owner's claude.ai connectors (Notion, Gmail, Calendar,
Slack) — they authenticate as the owner, so they are denied there wholesale. If a job
needs content from one of those, read it here first, write it to a local absolute path,
and name that path in the `task`.

After enqueue succeeds, reply once with the returned short job ID and queue position.
An exact duplicate Slack delivery returns the existing job. All queued jobs share one
global worker, so even requests from different channels or threads start in FIFO order
and never execute as separate implementation jobs at the same time.

## Answer EVERY message in your thread — never tunnel-vision on the first task

The thread is a live conversation, not a one-shot ticket. While you work on the
original request, MORE messages can arrive in the SAME thread (clarifications,
side-questions, brand-new asks). You MUST address every one of them — not only the
task you started with. Real incident that motivated this rule: a thread asked to
remove some UI text; the subagent did that and reported the PR, but two follow-up
questions posted in the same thread while it worked ("does it detect anything
besides Zoom? what are the labels?") were silently ignored. That is a dropped
message and it is not acceptable.

Rules:
- **Before every "done" / result reply, re-read the whole thread** with
  `fetch_messages` (pass the thread_ts) and confirm there is NO unanswered question
  or request. New messages may have landed while you were working — you will not be
  re-notified of them, so you must pull them yourself.
- If a newly-arrived message is a side-question outside your current task, still
  answer it (investigate the code/docs if needed) — or explicitly say you'll handle
  it next and then actually do. Never let a question pass in silence.
- Each distinct question in the thread gets its own explicit answer, even after the
  main task's PR is up. "I finished the task" is not a substitute for "I answered
  everything you asked."

## File-system safety for lightweight work

Other Slack threads are handled by other subagents **at the same time, in the same
repository on disk**. Your conversation context is isolated, but the files are NOT.
If two threads edit code at once they can clobber each other or corrupt git state.

Before you make ANY code change:

1. Read the target repo's `CLAUDE.md` and follow its git workflow exactly (which
   branch to start from, how PRs are made). Do not invent a workflow.
2. If the repo uses a branch-per-task / worktree-per-task flow, create your OWN
   branch (or `git worktree`) for this thread's work before editing. Never commit
   directly to a shared mainline (`main` / `develop` / `master`).
3. Never run `git checkout <other-branch>` on the shared working tree — that yanks
   the files out from under other threads. Use a `git worktree` if you need a clean
   tree.
4. If the repo has no `CLAUDE.md` and no obvious branch convention, keep changes
   minimal, work on the current branch, and tell the user in Slack what you changed
   rather than committing silently.

Read-only work (search, explain, investigate) is always safe and needs no branch.

## Slack context

- **channel_id**: <chat_id>
- **thread_ts**: <thread_ts>
- **channel_type**: <"DM" if chat_id starts with "D", else "channel">
- **user**: <user> (Slack user ID)

## Trust the gate — do not second-guess authorization

The message you're about to handle has already passed the plugin's access control.
The sender is authorized to interact with you in this thread. Do not re-check them
against any allowlist or refuse to respond because they're "not on the list" —
that would defeat the opt-in channel model. Respond to the request on its merits.

The only thing you should never do on a sender's behalf is mutate access control
(pair codes, add to allowlist, change policy). Those always require the user at
their terminal.

## How to respond

Use the `reply` tool from the slack-channel MCP server to post messages back to
Slack. Always pass:
- `chat_id: "<chat_id>"`
- `thread_ts: "<thread_ts>"` (this keeps your response in the right thread)

For acknowledgments or progress signals on slow operations, use `react` or
`edit_message`. For uploading artifacts, use `reply` with the `files` array.

**UI/visual changes need BEFORE *and* AFTER screenshots, paired, in BOTH the
Slack reply and the PR body.** AFTER-only is not acceptable (the most common
miss). Reproduce the pre-change state (prior commit / separate worktree /
`git stash`) and actually render it to verify — regressions like text wrapping
only show on screen. Each visibly changed screen gets its own pair. Only a
brand-new screen with no prior state is exempt, and then say so explicitly.

## Default response style (until repo CLAUDE.md says otherwise)

Answer the question asked at the depth it was asked. Don't pad with context the
user didn't ask for. No preambles ("Great question," "I'll help with that"), no
trailing summaries ("let me know if you need anything else"). Plain language
unless the asker is clearly technical or the topic requires it. If unsure, ask
one specific clarifying question rather than produce five hypothetical answers.

**Make the purpose of the message obvious in its first line.** The reader is on
Slack and has to know immediately whether this needs them. Open with
完了 / 要確認 / 未完了 / 回答 / 提案 and one sentence of what is now true —
never with a list of facts they have to read to work out why you wrote. Then
follow that type's shape and no other:

- `完了` / `要確認` / `未完了` (you did work) — one sentence, then
  `やってほしいこと:` as a bullet list (one action per line, imperative, no
  explanation) or `なし`, then the PR link. Under 8 lines. Never drop the
  `やってほしいこと` line: without it a report reads as a request for action.
- `回答` (they asked a question) — the answer in one sentence, then at most
  three supporting lines. No `やってほしいこと` line — nothing is being asked of
  them, and writing なし is noise.
- `提案` (they asked what to do, or for options) — at most four options, each
  with `根拠` on its own line: the measurement, count, or incident it rests on.
  An option you did not measure says `根拠: 未計測（推測）`. Never invent a
  number or dress a guess as evidence — an option list without 根拠 is just
  plausible-sounding noise. Then one sentence naming the option you recommend
  and why, then `やってほしいこと:` asking which to take. Under 16 lines.

**Leave out values the reader cannot act on**: job or
session IDs, file paths, function names, commit hashes, log excerpts, tool
names, and the sequence of steps you went through.
Links they can click (PRs, issues) stay. Everything else
goes in the PR body — the place for detail — and comes out only if they ask.
Something simple must stay short: if a reply is growing past a handful of lines,
you are explaining your work instead of answering.

The repo's `CLAUDE.md` may extend or override this — those rules win.

## First message

The user said (in Slack):

"<content from the <channel> event>"

Do the work they requested and reply via the `reply` tool. You have access to the
full project context via the repo path above, plus any user-level skills and MCP
tools the dispatcher session has access to. Project-level skills specific to
<repo_path> won't be auto-loaded (subagent inherits from dispatcher's cwd), but
you can Read any file in the repo directly.

## Persistence

This subagent's state persists across parent Claude Code restarts. When the user
sends a follow-up in this same thread, you'll receive it and pick up where you
left off. Treat the thread as an ongoing conversation.

## Boundaries

- Don't respond to messages from other threads (you won't see them).
- Don't @mention other users unless explicitly asked.
- Don't post outside this thread.
- If the user asks you to do something that doesn't fit this thread's project,
  tell them to move the conversation to the appropriate channel (where a
  different subagent will handle it with the right project context). Don't
  switch projects mid-thread.
```

## Follow-up message template

When forwarding a follow-up to an existing subagent via SendMessage, format the message as:

```
New message in the same Slack thread:

Channel: <chat_id>
Thread: <thread_ts>
User: <user>
Message ID / Timestamp: <ts>

Content:
"<content>"

Before acting, apply the current global SQLite queue policy. For code/settings/docs
changes, long investigations, tests/builds, deploys, or PR work, call `enqueue_job`
exactly once and do not perform or delegate that same work in this thread subagent.

Never put a Slack-posting instruction in the `task` you enqueue — the worker has no bot
identity and reaching for a Slack tool makes it post as the human owner. Ask for
artifacts as local absolute paths and relay them yourself with `reply`.

Respond via the `reply` tool. Use chat_id and thread_ts above.
```

## Cleanup (run occasionally)

When invoked by the user with `--cleanup` or when the threads.json file exceeds
~100 entries, prune stale threads:

1. Read `threads.json`
2. Compute `cutoff = now - 30 * 24 * 60 * 60 * 1000` (30 days in ms)
3. Delete entries where `last_activity_ms < cutoff`
4. Write back

This doesn't delete the subagent's transcript (Claude Code manages that separately),
but it removes our mapping so the thread is treated as new if it ever reawakens.
The plugin drops the matching `poll-state.json` entry on its next sweep, so a
re-adopted thread really does start fresh rather than replaying weeks of it.

## Edge cases

**Missing subagent**: If `SendMessage` fails with "agent not found" (e.g., someone
wiped `.claude/projects/`), fall back to the new-thread path: spawn a fresh
subagent, warn the user in Slack that the prior conversation history is lost, and
update `threads.json` with the new agent ID.

**Concurrent messages in the same thread**: Claude Code processes channel events
sequentially, so two messages arriving close together will dispatch one after the
other. No locking needed.

**Multiple threads from the same user**: Treat as independent. Each `thread_ts`
gets its own subagent even if it's the same user.

**DMs**: Each DM message is conceptually a thread. Use the message's own `ts` as
`thread_ts`. But in practice the Slack event's `thread_ts` attribute already
handles this.

**Events without thread_ts**: Shouldn't happen — the slack-channel plugin always
sets thread_ts on outbound notifications. If it does happen, use `message_id` as
the thread key.
