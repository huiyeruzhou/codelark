---
name: condition-monitor
description: Use when a user asks to send one message to a specified CodeLark chat or Agent when an external condition becomes true. Creates a persistent, read-only Python condition monitor that stays silent while false, sends once when true, and then stops.
---

# Condition Monitor

Use this workflow for requests such as “when X is ready, notify chat Y” or “when condition X holds, send a message to Agent Y.” Do not use `/every` to make a model repeatedly inspect the condition, and do not recreate the removed `/auto` command.

## Gather the user contract

Collect these values before creating anything:

- Condition: infer a precise read-only assertion from the user's natural-language condition. Ask only if different interpretations would change the result.
- Interval: how often to poll.
- Target: the chat or Agent that should receive the notification.
- Delivery: ordinary Agent-lane input or a user-visible Feishu message.
- Content: exact notification text or card content.
- Feishu shape: text, post, or interactive card when delivery is user-visible.
- Mention: whether anyone must be @ mentioned. Keep `MENTION_USER_IDS` empty for no mention; otherwise list the exact user IDs and use the official representation for the selected Feishu `msg_type` in `MESSAGE_CONTENT`.

Ask the user for any missing choice that changes an external message. Do not force the user to write code; formulate the assertion yourself and keep it auditable.

## Resolve stable CodeLark targets

Use `codelark sessions --json` with compound filters. Resolve both the current conversation (monitor owner) and notification target to exactly one result. Copy each result's opaque `target` and `codelark_home`; never use a card number or construct an ID.

## Write the detector

Copy `scripts/condition_monitor_template.py` into a durable task directory such as `<owner-codelark-home>/condition-monitors/<name>.py`. Do not place a persistent monitor only in a disposable worktree or temporary directory. Fill its constants and implement `condition_is_met()`.

The assertion must be read-only. It may query APIs, files, processes, queues, or cluster state, but it must not create, restart, stop, resize, repair, or otherwise mutate the monitored resource. Use a domain-specific read skill when one exists.

The script protocol is fixed:

- `--describe`: output only `interval_seconds` and `timeout_seconds` JSON.
- `--check`: evaluate once without sending; exit 0 when true, 1 when false.
- `--tick`: evaluate once; exit 1 silently while false; when true, call `codelark send` with the stable monitor UUID as its idempotency key, return 0 only after successful delivery, and otherwise return 2.

For Agent delivery, configure `codelark send agent`. For a visible Feishu text/card, configure `codelark send message` with official `msg_type + content`. Keep `MENTION_USER_IDS` consistent with the user's explicit choice.

## Verify and register

Run the script with `--describe`, then `--check`. A false check is expected to exit 1 and print nothing. Do not run `--tick` against a true production condition as a dry run because it sends the real notification.

Register it:

```bash
codelark monitor create \
  --owner "<owner-target>" \
  --home "<owner-codelark-home>" \
  --script "/absolute/path/to/monitor.py" \
  --label "<short-readable-name>"
```

Record the returned stable task ID. CodeLark persists the task, restores running monitors after Bridge restart, runs each poll without a model turn, and marks it completed after the script sends successfully.

Inspect or cancel by stable identity:

```bash
codelark monitor list --home "<owner-codelark-home>" --json
codelark monitor cancel "<stable-task-id>" --home "<owner-codelark-home>"
```

Report the script path, stable task ID, interval, exact target, notification shape, mention choice, and dry-check result to the user.
