---
name: runmux
description: Use RunMux to delegate read-only analysis or explicitly authorized coding tasks to persistent or one-off Claude Code subagents, inspect sessions and transcripts, run diff or adversarial reviews, and use Windows or WSL runtimes. Trigger when a user asks to use RunMux, call Claude Code as a subagent, resume a named Claude session, or get an independent Claude review.
---

# RunMux

Use the installed `runmux` command. RunMux v0.1 uses Claude Code as its execution provider.

## Start

Verify the runtime before investigating failures:

```powershell
runmux health
```

Use `once` for isolated work that should not persist state:

```powershell
runmux once reviewer "只读分析当前改动，输出结论和依据" --cwd "D:\path\to\repo"
```

Use `ask` with a stable name when the session should continue:

```powershell
runmux ask reviewer "只读分析项目结构" --cwd "D:\path\to\repo"
runmux ask reviewer "继续，只看数据访问层"
```

Set provider reasoning effort per task with `--effort`:

```powershell
runmux once scout "定位相关代码" --cwd "D:\path\to\repo" --effort low
runmux adversarial review "完整审查当前方案" --cwd "D:\path\to\repo" --effort max
```

Accepted levels are `low`, `medium`, `high`, `xhigh`, and `max`. RunMux
validates and forwards the level; the active provider defines its semantics.

## Safety

- Default to RunMux read-only mode for research, reviews, and second opinions.
- Use `--yolo` only when the user explicitly authorizes Claude Code to modify files.
- Scope coding prompts tightly and include `Do not commit` unless the user requested a commit.
- Do not run Codex and Claude Code edits against the same files concurrently.
- After a coding run, inspect the diff and execute appropriate verification yourself.
- Use `--safe` to return a persisted agent to read-only mode.

## Reviews

Use focused built-in review workflows:

```powershell
runmux diff-review review "重点检查 Windows 兼容性" --cwd "D:\path\to\repo"
runmux quick-adversarial review "快速挑错当前方案" --cwd "D:\path\to\repo"
runmux adversarial review "对当前方案做完整对抗验证" --cwd "D:\path\to\repo"
```

Adversarial commands are read-only. Run any authorized coding task separately with `ask ... --yolo`, then review it.

## Runtime and State

Use `--runtime wsl` only when Claude Code should run inside WSL. Windows is the default and automatically resolves native and npm installations.

RunMux stores named sessions and logs under `~/.runmux`. Logs may contain prompts and model output; never publish them.

Use `runmux list`, `runmux show <name>`, and `runmux transcript <name>` for inspection. Use `reset` or `remove` only when the user intends to discard stored session state.
