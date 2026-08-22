#!/usr/bin/env bash

zerokun_resolve_state_dir() {
  if [ -n "${ZEROKUN_STATE_DIR:-}" ]; then
    printf '%s\n' "$ZEROKUN_STATE_DIR"
  elif [ -n "${SLACK_STATE_DIR:-}" ]; then
    printf '%s\n' "$SLACK_STATE_DIR"
  elif [ -f "$HOME/.claude/channels/slack/jobs.sqlite3" ] \
    || [ -f "$HOME/.claude/channels/slack/.env" ] \
    || [ -f "$HOME/.claude/channels/slack/access.json" ]; then
    printf '%s\n' "$HOME/.claude/channels/slack"
  else
    printf '%s\n' "$HOME/.codex/zerokun"
  fi
}
