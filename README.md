# Slack Channel Plugin for Claude Code

Bridge your Slack workspace into a running Claude Code session. DMs and @mentions arrive in your session as channel events, and Claude replies back through Slack using bot messages, reactions, edits, and file uploads. Built for real conversation: each Slack thread gets its own isolated subagent with persistent memory, so parallel conversations don't bleed into each other and you can pick up threads days later with full context intact.

---

## Highlights

- **Per-thread subagent dispatch** — every unique Slack `thread_ts` spawns a dedicated subagent with its own context window. Parallel conversations stay independent; Claude never mixes up which thread it's in.
- **Persistence across restarts** — thread state is stored on disk (`~/.claude/channels/slack/threads.json` + Claude Code's built-in subagent storage). Close your terminal, come back tomorrow, reply in a thread — the subagent wakes up with full memory of the prior conversation.
- **Full Claude Code capability inside Slack** — subagents inherit every tool, skill, MCP server, and CLAUDE.md context from the parent session. Unlike a restricted Agent SDK bot, you get Read/Write/Edit/Bash/WebSearch/WebFetch and everything else natively.
- **Three-tier access control** — DM pairing with code exchange, explicit allowlists, per-channel opt-in policies. Nothing responds until you authorize it.
- **Permission relay** — if Claude needs tool approval while you're away, you can approve/deny from Slack via Block Kit buttons or text (`yes <code>` / `no <code>`).
- **Anti-prompt-injection design** — skills refuse to mutate access control based on channel messages; only the terminal user can pair, allow, or change policy.

---

## How it works

```
                Slack workspace
                       │
             Socket Mode WebSocket
                       │
                       ▼
              slack-channel plugin
         (Bun + @slack/bolt + MCP SDK)
                       │
         gate() access control → accept/drop/pair
                       │
       ┌───────────────┴────────────────┐
       │                                │
  notifications/                 reply / react /
  claude/channel      ◄──────    edit_message
       │                                │
       ▼                                │
      ┌────────────────────────────┐    │
      │ Running Claude Code session│    │
      │                            │    │
      │ /slack-channel:threads     │    │
      │  dispatches event to       │    │
      │  per-thread subagent       │    │
      │                            │    │
      │  ┌──────────┐ ┌──────────┐ │    │
      │  │ Thread A │ │ Thread B │ │    │
      │  │ subagent │ │ subagent │ │────┘
      │  └──────────┘ └──────────┘ │
      │                            │
      │ Each: isolated context,    │
      │ project CLAUDE.md, all     │
      │ tools/MCPs, persists       │
      │ across session restarts    │
      └────────────────────────────┘
```

1. A message arrives in Slack (DM or @mention in an opted-in channel).
2. The plugin's `gate()` checks it against access policy. If authorized, it delivers a `<channel source="slack" thread_ts="..." ...>` notification to the running Claude Code session.
3. Claude invokes the `/slack-channel:threads` skill, which looks up the `thread_ts` in a mapping file. If it's a new thread, a fresh subagent is spawned via the `Agent` tool; if it's a follow-up, `SendMessage` resumes the existing subagent.
4. The subagent does the work and calls the `reply` tool (or `react` / `edit_message`) to respond back to Slack in the original thread.

---

## Prerequisites

- [Bun](https://bun.sh) (runtime)
- Claude Code v2.1.80 or later
- `claude.ai` login (required for channels — API-key-only sessions aren't supported)
- A Slack workspace where you can create apps
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` set in your environment (enables the `Agent` and `SendMessage` tools that power thread dispatch)

**Enterprise note:** On Team and Enterprise Claude plans, an admin must enable channels in the admin console (Claude Code → Channels → "Allow channel notifications"). Pro/Max personal accounts don't need this.

---

## Slack App Setup

### Manifestから作る（推奨）

ゼロくん用の権限・Event Subscription・Socket Modeを再現する
[`zerokun/templates/slack-app-manifest.yaml`](zerokun/templates/slack-app-manifest.yaml)を用意済み。
**Create New App → From a manifest** で貼り付ければ、以下の手設定の大半は不要。
App-Level Tokenの`connections:write`とWorkspaceへのInstallだけはSlack画面で行う。

`zerokun/bootstrap-macos.sh`でセットアップする場合は、manifestのコピーと作成画面の起動もスクリプトが行う。

### 1. Create the app

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**.
2. Give it a name (e.g. "Claude") and pick your workspace.

### 2. Enable Socket Mode

1. In the sidebar go to **Settings → Socket Mode** and toggle it **On**.
2. Create an **App-Level Token** when prompted:
   - Name it anything (e.g. "socket-token")
   - Add the scope `connections:write`
   - Click **Generate** and copy the token — it starts with `xapp-`

### 3. Subscribe to events

1. Go to **Features → Event Subscriptions** and toggle **Enable Events** on.
2. Under **Subscribe to bot events** add:
   - `app_mention`
   - `message.im`
   - `message.channels`

### 4. Enable the Messages tab

1. Go to **Features → App Home**.
2. Toggle **Messages Tab** on.
3. Check **Allow users to send Slash commands and messages from the messages tab**.

### 5. Set bot token scopes

Go to **Features → OAuth & Permissions → Scopes → Bot Token Scopes** and add:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Receive @mentions |
| `channels:history` | Read channel messages |
| `channels:read` | Look up channel info |
| `chat:write` | Post messages |
| `files:read` | Download shared files |
| `files:write` | Upload file attachments |
| `groups:history` | Read private channel messages |
| `im:history` | Read DM messages |
| `im:read` | Look up DM info |
| `im:write` | Open DMs to users |
| `reactions:write` | Add emoji reactions |
| `users:read` | Resolve user names |

### 6. Install to workspace

1. Go to **OAuth & Permissions → Install to Workspace**.
2. Authorize the requested permissions.
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`).
4. You already have the App-Level Token from step 2 (starts with `xapp-`).

---

## Plugin Installation

### Development (clone and load locally)

```bash
git clone https://github.com/retrodigio/claude-channel-slack ~/dev/claude-channel-slack
cd ~/dev/claude-channel-slack
bun install
```

Add the server to your user-level MCP config at `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "slack-channel": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "--cwd", "/absolute/path/to/claude-channel-slack", "--silent", "start"]
    }
  }
}
```

> **Heads up on naming:** the server key must be something other than `slack`. Claude Code and the `claude-plugins-official` marketplace both ship an MCP server named `slack`; if you use that name here, deduplication may route events to the wrong transport. `slack-channel` is recommended.

Start Claude Code with the channel enabled:

```bash
claude --dangerously-load-development-channels server:slack-channel
```

You should see **"Listening for channel messages from: server:slack-channel"** in the startup banner, and `slack-channel · ✓ connected` under User MCPs in `/mcp`.

### Configure tokens

With Claude Code running, save your Slack tokens:

```
/slack-channel:configure <xoxb-bot-token> <xapp-app-token>
```

Tokens are written to `~/.claude/channels/slack/.env` with permissions `600`. The server reads this file at startup — restart Claude Code after saving tokens for the first time.

---

## Quick Start

### Pair your Slack account

1. Open a DM with your bot in Slack and send any message.
2. The bot replies with a pairing command — copy it.
3. Run it in Claude Code:
   ```
   /slack-channel:access pair <code>
   ```
4. Lock down DM access to approved users only:
   ```
   /slack-channel:access policy allowlist
   ```

### Enable a channel

To let Claude respond to @mentions in a channel:

```
/slack-channel:access channel add <channel-id>
```

Find the channel ID by right-clicking the channel name in Slack → **View channel details** → scroll to bottom for "Channel ID" (starts with `C` for public or `G` for private).

By default, an opted-in channel requires an explicit @mention of the bot, and anyone in the channel can trigger a response via @mention. To restrict further:

```
/slack-channel:access channel add <channel-id> --allow U01ABC,U02DEF
```

### Start talking

- In a DM: just type. The bot acknowledges with :eyes:, dispatches a subagent, and replies in the same DM.
- In a channel: @mention the bot. Each top-level @mention starts a new thread with its own subagent; follow-ups in that thread route to the same subagent.

---

## Per-Thread Subagents

Every Slack `thread_ts` gets a dedicated subagent. State is tracked in `~/.claude/channels/slack/threads.json`:

```json
{
  "1718400000.000100": {
    "agent_id": "agent-a3f2c1",
    "channel_id": "C0ASQSQCGCB",
    "repo_path": "/Users/you/projects/rfp-knowledge",
    "label": "RFP Knowledge",
    "started_at": "2026-04-17T17:04:35Z",
    "last_activity_ms": 1718500000000,
    "topic": "GA CCNS disaster recovery questions"
  }
}
```

**New thread:** dispatcher resolves routing (see next section), spawns a subagent via the `Agent` tool, saves the mapping.
**Follow-up:** dispatcher looks up the `agent_id` and uses `SendMessage` to resume the subagent. Claude Code auto-resumes stopped subagents from their on-disk transcripts, so the subagent wakes up with full prior context.
**Persistence:** the mapping file survives session restarts, and Claude Code stores subagent transcripts at `~/.claude/projects/*/subagents/*.jsonl` independently.

**When the parent session is offline:** Slack events queue briefly at Slack and then drop. For 24/7 coverage, run `claude --dangerously-load-development-channels server:slack-channel` inside a persistent terminal (tmux, screen, or a dedicated machine). Conversation state is preserved across restarts, but inbound events require a live session.

---

## Dispatcher Orchestrator (recommended)

For any non-trivial deployment, run the dispatcher session from a dedicated folder with its own CLAUDE.md that defines the orchestrator's role. This gives you:

- Stable, role-aware starting context every session (dispatcher vs project-worker personas are kept separate)
- Dedicated home for DM behavior, health checks, and runbooks
- A place to persist orchestrator-specific memory and learnings
- Cleaner separation of concerns: plugin (transport) → orchestrator (policy, routing, DM UX) → projects (domain knowledge)

A starter template is included at [`templates/orchestrator/`](templates/orchestrator/). Copy it to your own location:

```bash
cp -r templates/orchestrator ~/your/path/claude-slack-orchestrator
cd ~/your/path/claude-slack-orchestrator
git init
# customize CLAUDE.md, reference/projects.md, reference/slack-workspace.md
```

Then run the dispatcher from there:

```bash
cd ~/your/path/claude-slack-orchestrator
claude --dangerously-load-development-channels server:slack-channel
```

The template README explains the structure in detail.

---

## One Bot, Many Projects — Channel-to-Repo Routing

A single Slack app can serve many repos. Map channels to repo paths in `~/.claude/channels/slack/routes.json`, invite the bot to each channel, and run one dispatcher session that routes each channel's threads to subagents grounded in the correct project context.

### Setup

1. Create `~/.claude/channels/slack/routes.json`:

```json
{
  "C0ASQSQCGCB": {
    "repo_path": "/Users/you/projects/rfp-knowledge",
    "label": "RFP Knowledge"
  },
  "C0ARZ5AS550": {
    "repo_path": "/Users/you/projects/sdlc-transformation",
    "label": "SDLC Transformation"
  }
}
```

See [`routes.example.json`](routes.example.json) for the template.

2. Opt each channel in via `/slack-channel:access`:
```
/slack-channel:access channel add C0ASQSQCGCB
/slack-channel:access channel add C0ARZ5AS550
```

3. Invite the bot to each Slack channel: `/invite @YourBot` in Slack.

4. Start one dispatcher session (cwd doesn't matter much — subagents run in their routed repos regardless):

```bash
claude --dangerously-load-development-channels server:slack-channel
```

### How it works

When a new thread arrives:
- Dispatcher looks up `chat_id` in `routes.json`
- Subagent is spawned with the target `repo_path` baked into its prompt
- First thing the subagent does is `Read <repo_path>/CLAUDE.md` to load project workflows
- All file operations use absolute paths rooted at the target repo

Follow-ups in an existing thread resume the same subagent — routing is resolved once per thread, at creation.

DMs and unmapped channels fall back to the dispatcher session's cwd as project context.

### What about project-level skills?

The subagent inherits skills and MCP servers from the dispatcher session — so **global skills** (`~/.claude/skills/`, user-scoped plugins) and the dispatcher's cwd repo's skills are available to every subagent. Project-level skills from OTHER routed repos are not auto-loaded (Claude Code only loads skills from one cwd at a time). For knowledge-base-style projects where CLAUDE.md + repo files are the main context, this works well. If you need skills available across projects, put them at the user level (`~/.claude/skills/<name>/`).

### Alternative: per-repo bots

If you want full project-level skill isolation or separate bot identities, you can run **one bot per repo** instead. Each gets its own `SLACK_STATE_DIR`, tokens, and MCP entry:

```json
{
  "slack-channel-project-a": {
    "type": "stdio",
    "command": "bun",
    "args": ["run", "--cwd", "/path/to/plugin", "--silent", "start"],
    "env": { "SLACK_STATE_DIR": "/Users/you/.claude/channels/slack-project-a" }
  },
  "slack-channel-project-b": {
    "type": "stdio",
    "command": "bun",
    "args": ["run", "--cwd", "/path/to/plugin", "--silent", "start"],
    "env": { "SLACK_STATE_DIR": "/Users/you/.claude/channels/slack-project-b" }
  }
}
```

Then start each project's session with its own server name (`--channels server:slack-channel-project-a`). More operational overhead (N Slack apps, N tokens, N sessions to keep running), but complete isolation.

---

## Access Control

### Three-tier gate

1. **DM policy** — `pairing` (default), `allowlist`, or `disabled`. Controls who can DM the bot.
2. **Channel policies** — per-channel opt-in map keyed by channel ID. Optionally require @mentions and/or restrict to specific users.
3. **Outbound gate** — the `reply` / `react` / `edit_message` / `fetch_messages` tools only target channels and DMs that the inbound gate would accept. Prevents Claude from being tricked into posting to arbitrary channels.

### Trust the gate

If a `<channel source="slack">` event reaches Claude, access control has already approved it. Claude is instructed not to re-check the sender against any allowlist or refuse to respond. Channel mentions go through channel policy, NOT the DM allowlist. The only thing Claude refuses on behalf of a channel message is access-control mutations — those always require the terminal.

### /slack-channel:access commands

```
/slack-channel:access                           # show status
/slack-channel:access pair <code>               # approve a pending DM pairing
/slack-channel:access deny <code>               # reject a pending pairing
/slack-channel:access allow <userId>            # add to DM allowlist
/slack-channel:access remove <userId>           # remove from DM allowlist
/slack-channel:access policy <mode>             # pairing | allowlist | disabled
/slack-channel:access channel add <channelId>   # opt in a channel (with optional --no-mention, --allow)
/slack-channel:access channel rm <channelId>    # opt out a channel
/slack-channel:access set <key> <value>         # tune ackReaction, textChunkLimit, chunkMode, etc.
```

See [ACCESS.md](ACCESS.md) for the complete access model, `access.json` schema, and security notes.

---

## Permission Relay

When Claude needs a tool approval while you're away from the terminal, the plugin can relay the prompt to Slack. Allowlisted DM users receive a Block Kit message with **Allow** / **Deny** / **See more** buttons, or can reply with a text code (`yes xxxxx` / `no xxxxx`). Permission approvals are scoped to the DM allowlist only — channel members don't get them, because they haven't been explicitly paired.

Powered by the `claude/channel/permission` MCP capability.

---

## MCP Tool Reference

Tools the plugin exposes to the Claude Code session and its subagents:

| Tool | Description |
|---|---|
| `reply` | Post a message (or file) to a channel/DM, optionally threaded via `thread_ts`. Splits long text at `textChunkLimit`. |
| `react` | Add an emoji reaction to a message. |
| `edit_message` | Edit a previously sent bot message — useful for progress updates on long tasks. |
| `download_attachment` | Download a Slack file to `~/.claude/channels/slack/inbox/` and return the path. |
| `fetch_messages` | Pull channel or thread history via `conversations.history` / `conversations.replies`. |

All tools validate the target against access policy before acting.

---

## File Layout

```
claude-channel-slack/
├── .claude-plugin/plugin.json    # plugin manifest
├── .mcp.json                     # MCP launch config (plugin-install style)
├── server.ts                     # entire server: Slack + MCP + gate + tools
├── skills/
│   ├── access/SKILL.md           # /slack-channel:access
│   ├── configure/SKILL.md        # /slack-channel:configure
│   └── threads/SKILL.md          # /slack-channel:threads (per-thread dispatch)
├── package.json
├── README.md
├── ACCESS.md                     # full access-control reference
└── LICENSE
```

Runtime state:

```
~/.claude/channels/slack/
├── .env                # SLACK_BOT_TOKEN + SLACK_APP_TOKEN (chmod 600)
├── access.json         # access policy + per-channel config
├── threads.json        # thread_ts → subagent mapping
├── inbox/              # downloaded Slack file attachments
└── approved/           # one-shot pairing confirmations (server polls every 5s)
```

---

## Security Model

- **Stdio-only MCP transport** — the server runs as a local subprocess; no network listener.
- **Token files are chmod 600** — the `.env` gets permissions locked at boot.
- **`assertSendable()`** — the `reply` tool refuses to upload files from the plugin's own state directory, blocking exfiltration of `.env` or `access.json` via tool abuse.
- **Filename sanitization** — uploader-controlled filenames are scrubbed of `[]<>;\r\n` before appearing in `<channel>` tag attributes, preventing tag-structure injection.
- **Pairing never auto-picks** — even with a single pending code, `/slack-channel:access pair` requires the explicit code. Prevents an attacker from seeding one pending entry and getting it auto-approved via prompt injection.
- **Permission relay is DM-only** — approval buttons never go to channel members, only to users on the DM allowlist.
- **Orphan watchdog** — the server exits cleanly if its parent Claude Code process dies, preventing zombies that hold the Socket Mode token hostage.

---

## Common Issues

**"1 MCP server failed" with no details**
Start Claude Code with `--debug` and check the log path it prints. Look for `slack-channel:` lines in the log to see startup errors. Common causes: missing tokens, wrong working directory in the MCP config, or a conflicting MCP server named `slack`.

**Bot doesn't respond to DMs**
Check `/mcp` shows `slack-channel · ✓ connected`. Verify the Slack app has Messages Tab enabled (App Home), `message.im` event subscribed, and you've restarted Slack after the app install (Slack caches the disabled state aggressively).

**Messages in channel drop silently**
The channel isn't opted in. Run `/slack-channel:access channel add <channelId>` to allow @mentions in that channel.

**Thread subagent has no memory of prior conversation**
Check `~/.claude/channels/slack/threads.json` has an entry for that `thread_ts`. If missing, the dispatcher will spawn a fresh agent. If present but the agent transcript is missing (rare — would happen if `~/.claude/projects/` was cleared), the dispatcher falls back to a new subagent and posts a notice in the thread.

**"Blocked by org policy" on Team/Enterprise**
An admin needs to toggle **Allow channel notifications** in claude.ai → Admin settings → Claude Code → Channels.

---

## License

Apache-2.0 — see [LICENSE](LICENSE).
