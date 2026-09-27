# Changelog

All notable changes to RunMux will be documented in this file.

## Unreleased

- Add a local Web console (`runmux ui`) served on 127.0.0.1 with page-token CSRF protection: view and switch default models for zcode, Claude Code, and DSH through per-provider config adapters, guided zcode provider onboarding with automatic backups, and named agent status with recent run logs.
- Add a zcode provider adapter (`--provider zcode`) that runs headless `zcode --prompt` sessions with plan-mode safety defaults, yolo mapping, `--resume` session continuity, `--output-format json|stream-json` output, npm shim discovery, and `--zcode`/`RUNMUX_ZCODE` overrides.
- Add `--provider claude|zcode` selection with per-agent persistence, `RUNMUX_PROVIDER` default override, and provider-aware `health`, `smoke`, error labels, and `list` output.
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
