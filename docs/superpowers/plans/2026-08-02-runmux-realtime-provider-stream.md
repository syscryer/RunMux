# RunMux Real-Time Provider Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `--stream` mode that forwards Claude Code native JSONL events to a parent agent as soon as they arrive.

**Architecture:** Keep the existing single-file CLI structure. Option parsing selects provider-native streaming arguments, `runProcess` exposes chunk callbacks while retaining buffered output, and a JSONL-aware payload parser recovers the final result for existing state and log behavior.

**Tech Stack:** Node.js 22 ESM, built-in `child_process`, built-in `node:test`, PowerShell test harness, Claude Code CLI.

**Implementation order:** The user explicitly requested implementation before tests, overriding the repository workflow's normal TDD order for this feature.

---

## File Map

- Modify `runmux.mjs`: CLI option, Claude invocation, live forwarding, final event extraction, state/log compatibility, help text.
- Modify `runmux.test.mjs`: fake provider stream behavior, live-arrival harness, option/state/error/WSL regression coverage.
- Modify `README.md`: machine-consumption contract and examples.
- Modify `CHANGELOG.md`: record the new opt-in stream mode.
- Modify `skills/runmux/SKILL.md`: teach installed consumers when and how to use `--stream`.

### Task 1: Implement the provider-native stream path

**Files:**
- Modify: `runmux.mjs`

- [ ] **Step 1: Parse and validate the stream option**

Add `stream` to the boolean option names and normalized names. Validate after parsing:

```js
function validateOutputOptions(values) {
  if (values.stream && values.json) {
    throw new Error("--stream 与 --json 不能同时使用。");
  }
}
```

Call this from `parseOptions` before returning so invalid combinations fail before runtime discovery or provider invocation.

- [ ] **Step 2: Select Claude output arguments**

Replace the fixed output-format portion of `claudeArgs` with:

```js
function getClaudeOutputArgs(stream) {
  return stream
    ? ["--output-format", "stream-json", "--include-partial-messages", "--forward-subagent-text"]
    : ["--output-format", "json"];
}

const claudeArgs = ["-p", prompt, ...getClaudeOutputArgs(values.stream), "--max-turns", maxTurns];
```

- [ ] **Step 3: Forward process chunks while retaining buffers**

Extend `runProcess` options with optional callbacks and invoke them with the exact `Buffer` received:

```js
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
  options.onStdout?.(chunk);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
  options.onStderr?.(chunk);
});
```

Pass callbacks only in stream mode:

```js
const processOptions = values.stream
  ? {
      timeoutMs,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk)
    }
  : { timeoutMs };
```

- [ ] **Step 4: Parse one JSON object or a JSONL final event**

Replace single-object parsing at run completion and transcript loading with a shared parser:

```js
function parseProviderPayload(text, stream = false) {
  if (!stream) {
    return parseJsonOrNull(text);
  }
  const payloads = String(text || "")
    .split(/\r?\n/)
    .map(parseJsonOrNull)
    .filter(Boolean);
  return payloads.findLast((payload) => payload.type === "result") || null;
}
```

For historical logs, detect stream mode from the stored invocation's `--output-format stream-json` pair and call the parser accordingly.

- [ ] **Step 5: Preserve stdout purity at completion**

Have `printAskAnswer` skip payload/result printing when `values.stream` is true, while keeping RunMux's agent/session/log summary on stderr. Add `stream: Boolean(values.stream)` to run logs so future readers do not rely only on argument inspection.

- [ ] **Step 6: Check syntax**

Run:

```powershell
npm run check
```

Expected: exit code 0 with no syntax error.

### Task 2: Add automated regression coverage

**Files:**
- Modify: `runmux.test.mjs`

- [ ] **Step 1: Extend the fake Claude provider**

Allow the harness to emit configurable JSONL records with a delay between the first and final record. The final fixture must use Claude-compatible fields:

```js
{
  type: "result",
  subtype: "success",
  session_id: "fake-session",
  result: "STREAM_OK",
  total_cost_usd: 0.01
}
```

- [ ] **Step 2: Prove output arrives before process completion**

Spawn RunMux directly, resolve a promise on its first stdout `data` event, and assert the child has not emitted `close` yet. Then await completion and compare stdout against the exact fixture JSONL bytes.

- [ ] **Step 3: Cover invocation, state, and output validation**

Add tests that assert:

```js
assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
assert.equal(args.includes("--include-partial-messages"), true);
assert.equal(args.includes("--forward-subagent-text"), true);
assert.equal(run.stdout, expectedJsonl);
assert.equal(state.agents.reviewer.sessionId, "fake-session");
assert.equal(state.agents.reviewer.lastCostUsd, 0.01);
```

Also assert `once --stream` does not persist state and `--stream --json` fails before the capture file is created.

- [ ] **Step 4: Cover malformed/incomplete/failing streams and WSL**

Verify malformed intermediate lines still reach stdout, a successful exit without a `result` event fails without changing prior state, a non-zero provider exit preserves emitted stdout, and the WSL fake receives `stream-json` arguments.

- [ ] **Step 5: Run the full suite**

Run:

```powershell
npm test
```

Expected: all existing and new tests pass with exit code 0.

### Task 3: Document and validate the public contract

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `skills/runmux/SKILL.md`

- [ ] **Step 1: Document machine consumption**

Add this usage shape to README and the bundled skill:

```powershell
runmux ask reviewer "分析项目并持续报告进度" --cwd "D:\code\project" --stream
```

State that stdout is provider-native JSONL, stderr contains diagnostics, consumers must select a parser by agent/provider type, and `--json` cannot be combined with `--stream`.

- [ ] **Step 2: Record the change**

Add an Unreleased changelog entry describing opt-in real-time native provider event forwarding with unchanged default behavior.

- [ ] **Step 3: Run package verification**

Run:

```powershell
npm run check
npm test
npm run pack:dry
```

Expected: every command exits 0, and the dry-run package includes `runmux.mjs`, README, and `skills/runmux/SKILL.md`.

### Task 4: Verify a live Claude Code stream

**Files:**
- No file changes.

- [ ] **Step 1: Check runtime compatibility**

Run:

```powershell
runmux health --json
```

Expected: Claude Code is available and the required stream flags appear in health checks.

- [ ] **Step 2: Run a bounded live stream**

Invoke:

```powershell
runmux once stream-smoke "只输出 RUNMUX_STREAM_OK" --cwd "D:\ai_proj\RunMux" --stream --max-turns 1 --timeout-ms 120000
```

Observe at least one JSONL event before process exit and a final `type: result` event containing `RUNMUX_STREAM_OK`. Confirm RunMux writes its summary only to stderr.

- [ ] **Step 3: Inspect repository state**

Run `git diff --check` and `git status --short`. Expected: no whitespace errors and only the planned source, test, documentation, and plan files are modified.
