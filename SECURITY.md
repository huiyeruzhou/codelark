# Security

## Credential Storage

CodeLark credentials are stored in `~/.codelark/config.env` and the local runtime data under `~/.codelark/`.

This repository never stores secrets in source control.

## Log Redaction

Tokens and secrets should be masked in logs and workbench output. Only short tail fragments of secrets should ever be shown for confirmation or diagnosis.

## Operational Model

CodeLark is a local single-user bridge:

- The bridge runs on the user's machine
- The web workbench is local-only
- IM authentication is delegated to each IM platform
- Access control is enforced through configured allowlists and channel bindings

## Rotation Guidance

If a token is rotated or suspected to be exposed:

1. Revoke the old credential on the IM platform
2. Update the value in the local `codelark` workbench
3. Restart the bridge from the workbench
4. Review recent logs under `~/.codelark/logs/`

## Home Directory

Current builds read and write only `~/.codelark/`.
If a legacy home directory from older releases still exists on a machine, treat it as historical leftover data rather than an active runtime home.
