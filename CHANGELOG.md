# Changelog

All notable changes to RunMux will be documented in this file.

## Unreleased

- Add unlimited `--max-turns` and `--timeout-ms` values (`0`, `none`, or `unlimited`), raise regular defaults to 20 turns and 10 minutes, and persist both limits for named agents.
- Add opt-in `--stream` forwarding for provider-native real-time JSONL events while preserving existing default output.
- Add provider-neutral `--effort low|medium|high|xhigh|max` validation and pass-through.

## 0.1.0 - 2026-07-30

- Publish the first open-source RunMux release.
- Add persistent, one-off, repair, diff review, and adversarial Claude Code workflows.
- Add safe read-only defaults and explicit authorized write mode.
- Support native Windows and WSL runtimes.
- Resolve Windows npm Claude Code shims to directly spawnable binaries.
- Store agent state and logs under `~/.runmux`.
- Include a Codex companion skill.
