---
name: runmux
description: Use RunMux to delegate read-only analysis or explicitly authorized coding tasks to persistent or one-off Claude Code or zcode subagents, inspect sessions and transcripts, run diff or adversarial reviews, and use Windows or WSL runtimes. Trigger when a user asks to use RunMux, call Claude Code or zcode as a subagent, resume a named subagent session, or get an independent review.
---

# RunMux

Use the installed `runmux` command. RunMux v0.1 supports two execution
providers: Claude Code (CC, the default) and zcode (selected with
`--provider zcode`). Treat the provider as a worker supporting the main agent,
not as the owner of the entire task.

## Delegation Contract

Keep these responsibilities in the main agent, whether it is Codex or another
capable orchestrator:

- Define requirement boundaries, cross-layer contracts, data flow, tradeoffs,
  failure behavior, privacy boundaries, and acceptance criteria.
- Decide the architecture before delegating implementation.
- Split work into explicit, independently verifiable slices.
- Review CC output against the real code, inspect every diff, and run the
  relevant verification before accepting it.

Delegate concrete worker tasks such as collecting protocol samples, locating
code paths, challenging a proposed design, adding specified tests, or
implementing one named module against an already-defined contract. CC may
contribute local analysis and alternatives, but do not hand it the entire
requirement, architecture, implementation, and acceptance workflow as one
open-ended task. Do not ask CC to approve its own work.

Every CC prompt must state the exact scope, files or module boundary, required
behavior, forbidden changes, and verification criteria. CC conclusions and
code are evidence, not accepted results, until the main agent independently
verifies them.

## Invocation Policy

Use these flags for every Claude Code worker invocation:

```text
--effort max --stream --max-turns none --timeout-ms none
```

This keeps reasoning effort high, exposes progress to the main agent, and
avoids RunMux stopping a legitimate long-running task. Apply a finite boundary
only when the user explicitly requests one.

For zcode workers, omit `--effort` and `--max-turns` (zcode owns its reasoning
level and has no per-run turn limit; RunMux would print stderr notes instead of
forwarding them) and keep `--stream --timeout-ms none`:

```text
--provider zcode --stream --timeout-ms none
```

## Start

Verify the runtime before investigating failures:

```powershell
runmux health                 # Claude Code (default)
runmux health --provider zcode
```

Use `once` for isolated work that should not persist state:

```powershell
runmux once protocol-scout "只读采集指定协议样本；不要设计方案，不要修改文件；输出证据和文件位置" --cwd "D:\path\to\repo" --effort max --stream --max-turns none --timeout-ms none
```

Use `ask` with a stable name when the session should continue:

```powershell
runmux ask module-worker "只实现已定义的 changes[] 生成模块；不得修改数据库结构；不要提交；按给定验收项自测" --cwd "D:\path\to\repo" --yolo --effort max --stream --max-turns none --timeout-ms none
runmux ask module-worker "继续处理同一模块，只修复主 Agent 指出的测试失败" --effort max --stream --max-turns none --timeout-ms none
```

The same delegation pattern works with zcode workers; the provider is
remembered per named agent:

```powershell
runmux once zscout "只读采集指定协议样本；不要设计方案，不要修改文件；输出证据和文件位置" --cwd "D:\path\to\repo" --provider zcode --stream --timeout-ms none
runmux ask zworker "只实现已定义的 changes[] 生成模块；不得修改数据库结构；不要提交；按给定验收项自测" --cwd "D:\path\to\repo" --provider zcode --yolo --stream --timeout-ms none
```

With `--stream`, stdout is the provider's unmodified JSONL event stream and
RunMux diagnostics use stderr. Select the event parser by agent/provider type.
Do not combine `--stream` with `--json`.

## Safety

- Default to RunMux read-only mode for research, reviews, and second opinions.
- Use `--yolo` only when the user explicitly authorizes the provider to modify files. For zcode this maps to `--mode yolo`; the safe default maps to read-only `--mode plan`.
- Scope coding prompts tightly and include `Do not commit` unless the user requested a commit.
- Do not run main-agent and worker edits against the same files concurrently.
- Never accept a worker's self-reported success as verification.
- After every coding run, inspect the diff and execute appropriate verification yourself.
- Use `--safe` to return a persisted agent to read-only mode.

## Reviews

Use focused built-in review workflows:

```powershell
runmux diff-review review "只审查当前 diff 的 Windows 兼容性，不提出新架构" --cwd "D:\path\to\repo" --effort max --stream --max-turns none --timeout-ms none
runmux quick-adversarial review "只按既定验收标准挑错当前实现" --cwd "D:\path\to\repo" --effort max --stream --max-turns none --timeout-ms none
runmux adversarial review "对已确定方案做完整对抗验证，不重新定义需求" --cwd "D:\path\to\repo" --effort max --stream --max-turns none --timeout-ms none
```

Adversarial commands are read-only. Run any authorized coding task separately with `ask ... --yolo`, then review it.

## Runtime and State

Use `--runtime wsl` only when Claude Code should run inside WSL. Windows is the default and automatically resolves native and npm installations. The zcode provider supports the Windows runtime only.

RunMux stores named sessions and logs under `~/.runmux`. Logs may contain prompts and model output; never publish them.

Use `runmux list`, `runmux show <name>`, and `runmux transcript <name>` for inspection. Use `reset` or `remove` only when the user intends to discard stored session state.
