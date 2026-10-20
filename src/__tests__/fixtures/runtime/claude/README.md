# Claude terminal fixtures

`mature-input-no-hints.txt` is a `tmux capture-pane -p -S -80`
capture from Claude Code 2.1.175 after three turns against a local mock Anthropic
API (2026-10-20), with the trailing empty line removed. The 95-line mock replies scroll the welcome banner out of the
capture. A custom status line replaces shortcut hints. The empty input row
contains a non-breaking space, as emitted by the real CLI.

This reproduces Bridge cold takeover of a surviving terminal: the old readiness
predicate rejects this screen although Claude can accept and answer input.
