# RunMux

[![CI](https://github.com/syscryer/RunMux/actions/workflows/ci.yml/badge.svg)](https://github.com/syscryer/RunMux/actions/workflows/ci.yml)

RunMux is a local runtime and session multiplexer for AI coding agents. It gives an agent, script, or developer a stable CLI for starting Claude Code tasks, resuming named sessions, running one-off reviews, and keeping execution logs outside the target workspace.

RunMux v0.1 ships with a Claude Code adapter. The CLI and state model are designed to support more providers later, but Codex and OpenCode execution adapters are not implemented yet.

## Features

- Named, persistent Claude Code sessions
- Safe read-only defaults with a narrow tool allowlist
- Explicit `--yolo` mode for authorized code changes
- Stateless `once` and verified `smoke` runs
- Repair prompts with current Git context
- Focused diff review and adversarial review workflows
- Native Windows Claude Code discovery, including npm shims
- WSL execution with automatic user and path detection
- Provider reasoning effort control with `--effort`
- Human-readable output plus `--json` for automation
- Real-time provider-native JSONL output with `--stream`
- Local state and logs under `~/.runmux`

## Requirements

- Node.js 22 or newer
- Claude Code installed and authenticated
- Windows PowerShell for `runmux.ps1`; the Node CLI works directly on other platforms
- WSL only when using `--runtime wsl`

## Install

From GitHub:

```bash
npm install --global https://github.com/syscryer/RunMux.git
runmux health
```

For local development:

```bash
git clone https://github.com/syscryer/RunMux.git
cd RunMux
npm install
npm link
runmux health
```

On Windows, the repository also includes direct wrappers:

```powershell
.\runmux.ps1 health
.\runmux.cmd health
```

## Quick Start

Run a one-off read-only review without persisting an agent:

```bash
runmux once reviewer "Read the current diff and identify likely regressions." --cwd /path/to/project
```

Create or resume a named read-only session:

```bash
runmux ask reviewer "Analyze the current project structure." --cwd /path/to/project
runmux ask reviewer "Continue, focusing on the database layer."
```

Authorize a tightly scoped coding task:

```bash
runmux ask coder "Fix the failing parser test. Do not commit." --cwd /path/to/project --yolo
runmux ask coder "Return to read-only analysis." --safe
```

Use WSL from Windows:

```powershell
runmux ask reviewer "Review the current changes." --cwd "D:\code\project" --runtime wsl
```

Set the reasoning effort for a task:

```bash
runmux once scout "Find the relevant code paths." --cwd /path/to/project --effort low
runmux adversarial review "Challenge the proposed design." --cwd /path/to/project --effort max
```

RunMux accepts `low`, `medium`, `high`, `xhigh`, and `max`. It validates the
value and forwards it to the active provider adapter without redefining what
the level means. In v0.1, the Claude Code adapter passes it through as
`claude --effort <level>`.

## Execution Limits

Regular `ask`, `once`, `quick-adversarial`, and `adversarial` runs default to
20 turns. Specialized defaults remain smaller: `repair` uses 12,
`diff-review` uses 8, and `smoke` uses 3. The RunMux process timeout defaults
to 600000 milliseconds (10 minutes).

Disable either limit with `0`, `none`, or `unlimited`:

```powershell
runmux ask long-task "完成完整分析并持续报告进度" --cwd "D:\code\project" --max-turns none --timeout-ms none --stream
```

For unlimited turns, RunMux omits the provider's turn-limit argument. A zero
timeout disables RunMux's process timer. Named `ask` agents persist both
settings; `once` remains ephemeral. Existing named agents that stored the old
default of 6 turns are upgraded to 20 on their next successful run. Pass an
explicit positive number to restore a bounded limit.

## Commands

| Command | Purpose |
| --- | --- |
| `health`, `doctor` | Verify Node, Claude Code, flags, state, and the companion skill |
| `smoke` | Make a real read-only Claude call and verify the response |
| `once`, `ask-once` | Run a fresh task without persisting agent state |
| `ask` | Create or resume a named session |
| `repair` | Resume a session with recent log and Git context |
| `diff-review` | Perform a focused read-only review of current changes |
| `quick-adversarial` | Run one critic or judge pass |
| `adversarial` | Run proposer, critic, and judge passes |
| `list`, `show` | Inspect stored agents |
| `reset`, `remove` | Clear a session or remove an agent record |
| `transcript` | Read prior local logs without calling Claude |

Run `runmux --help` for all flags and examples.

## Automation

Add `--json` after a command when structured output is available:

```bash
runmux health --json
runmux show reviewer --json
runmux once reviewer "Summarize the module boundaries." --cwd /path/to/project --json
```

Diagnostics go to stderr where practical. Command failures return a non-zero exit code.

For a parent agent such as CodeM that needs progress before the child exits,
use `--stream`:

```powershell
runmux ask reviewer "分析项目并持续报告进度" --cwd "D:\code\project" --stream
```

In stream mode, stdout is the active provider's native JSONL stream and RunMux
diagnostics remain on stderr. RunMux does not wrap or normalize events, so the
caller must select a parser using the agent/provider type. The current Claude
Code adapter enables `stream-json`, verbose events, partial messages, and
forwarded subagent text. `--stream` cannot be combined with `--json`; commands
without `--stream` keep their existing final-output behavior.

## State and Environment

RunMux stores runtime data outside source repositories:

```text
~/.runmux/agents.json
~/.runmux/logs/
```

Supported overrides:

| Variable | Purpose |
| --- | --- |
| `RUNMUX_HOME` | Override the RunMux data directory |
| `RUNMUX_STATE_PATH` | Override the agent state file |
| `RUNMUX_LOG_DIR` | Override the log directory |
| `RUNMUX_RUNTIME` | Default runtime: `windows` or `wsl` |
| `RUNMUX_CLAUDE` | Explicit native Claude Code command |
| `RUNMUX_WSL_USER` | Explicit WSL user |
| `RUNMUX_WSL_DISTRO` | Explicit WSL distribution |
| `RUNMUX_WSL_EXE` | Explicit `wsl.exe` path |
| `RUNMUX_WSL_CLAUDE` | Claude Code command inside WSL |

Logs can contain prompts and model output. Keep `~/.runmux` private and never commit it.

## Companion Skill

The repository includes a Codex-compatible skill at `skills/runmux`.

```powershell
Copy-Item -Recurse -Force .\skills\runmux "$env:USERPROFILE\.codex\skills\runmux"
```

After installation, a future Codex task can invoke `$runmux` to use the CLI with the intended safety ordering.

## CodeM Integration

CodeM or another agent host can call RunMux as a subprocess and consume
`--stream` stdout while the child is running. Route stderr separately, parse
stdout according to the configured agent/provider type, and use the process
exit status as the final success signal. Use `--json` when only one final
object is needed, `once` for isolated tasks, and `ask` with a stable agent name
when session reuse matters.

RunMux does not store API keys. Claude Code authentication remains owned by the installed Claude Code runtime.

## Development

```bash
npm install
npm run check
npm test
npm run pack:dry
```

## License

MIT. See [LICENSE](LICENSE).
