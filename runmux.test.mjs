import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = path.dirname(fileURLToPath(import.meta.url));
const agentScript = path.join(repoDir, "runmux.mjs");

test("version reports the RunMux package version", async (t) => {
  const env = await setupHarness(t, {
    fakeResult: "OK",
    initialState: { version: 1, agents: {} }
  });

  const run = await runAgent(["--version"], env);

  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.stdout.trim(), "runmux 0.1.0");
});

test("doctor is a JSON-capable alias for health", async (t) => {
  const env = await setupHarness(t, {
    fakeResult: "OK",
    initialState: { version: 1, agents: {} }
  });

  const run = await runAgent(["doctor", "--json"], env);

  assert.equal(run.exitCode, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.checks.some((check) => check.name === "claude --version"), true);
});

test("once forces a fresh run without changing stored agent state", async (t) => {
  const env = await setupHarness(t, {
    fakeResult: "ONCE_OK",
    initialState: {
      version: 1,
      agents: {
        reviewer: {
          name: "reviewer",
          cwd: "D:\\old",
          sessionId: "old-session",
          permissionMode: "none",
          maxTurns: "6",
          allowedTools: "Read,Grep,Glob,LS",
          claudeCommand: "claude",
          yolo: false
        }
      }
    }
  });

  const run = await runAgent(["once", "reviewer", "hello once", "--cwd", env.workspace, "--claude", env.fakeScript], env);

  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /ONCE_OK/);

  const args = await readCapturedArgs(env.capturePath);
  assert.equal(args.includes("--resume"), false);
  assert.equal(args[args.indexOf("--name") + 1], "reviewer");
  assert.equal(args[args.indexOf("-p") + 1], "hello once");

  const state = JSON.parse(await readFile(env.statePath, "utf8"));
  assert.equal(state.agents.reviewer.sessionId, "old-session");
  assert.equal(state.agents.reviewer.cwd, "D:\\old");
});

test("smoke runs a fresh live probe without persisting a smoke agent", async (t) => {
  const env = await setupHarness(t, {
    fakeResult: "RUNMUX_SMOKE_OK\nREADME.md: 存在",
    initialState: { version: 1, agents: {} }
  });
  await writeFile(path.join(env.workspace, "README.md"), "# Smoke\n", "utf8");

  const run = await runAgent(["smoke", "--cwd", env.workspace, "--probe-file", "README.md", "--claude", env.fakeScript], env);

  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /\[OK\] smoke/);
  assert.match(run.stdout, /README\.md: 存在/);

  const args = await readCapturedArgs(env.capturePath);
  assert.equal(args.includes("--resume"), false);
  assert.equal(args[args.indexOf("--max-turns") + 1], "3");

  const state = JSON.parse(await readFile(env.statePath, "utf8"));
  assert.deepEqual(state.agents, {});
});

test("Windows runtime resolves the npm claude shim to its package-native command", async (t) => {
  const env = await setupHarness(t, {
    fakeResult: "RUNMUX_SMOKE_OK\nREADME.md: 存在",
    initialState: { version: 1, agents: {} }
  });
  await writeFile(path.join(env.workspace, "README.md"), "# Smoke\n", "utf8");

  const run = await runAgent(["smoke", "--cwd", env.workspace, "--probe-file", "README.md"], env);

  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /\[OK\] smoke/);
  const records = await readCapturedArgs(env.capturePath);
  assert.equal(records.includes("--version"), false);
});

test("Windows runtime repairs a stored bare claude command", async (t) => {
  const env = await setupHarness(t, {
    fakeResult: "STORED_DEFAULT_OK",
    initialState: {
      version: 1,
      agents: {
        reviewer: {
          name: "reviewer",
          cwd: "",
          sessionId: "old-session",
          runtime: "windows",
          permissionMode: "none",
          maxTurns: "6",
          allowedTools: "Read,Grep,Glob,LS",
          claudeCommand: "claude",
          yolo: false
        }
      }
    }
  });
  const state = JSON.parse(await readFile(env.statePath, "utf8"));
  state.agents.reviewer.cwd = env.workspace;
  await writeFile(env.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const run = await runAgent(["ask", "reviewer", "check stored command"], env);

  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /STORED_DEFAULT_OK/);
  const updatedState = JSON.parse(await readFile(env.statePath, "utf8"));
  assert.match(updatedState.agents.reviewer.claudeCommand, /claude-code[\\/]bin[\\/]claude\.mjs$/i);
});

test("repair resumes the existing agent and injects current workspace context", async (t) => {
  const env = await setupHarness(t, {
    fakeResult: "REPAIR_OK",
    gitMode: "nonrepo",
    initialState: {
      version: 1,
      agents: {
        coder: {
          name: "coder",
          cwd: "",
          sessionId: "old-session",
          permissionMode: "none",
          maxTurns: "6",
          allowedTools: "Read,Grep,Glob,LS",
          claudeCommand: "claude",
          yolo: false
        }
      }
    }
  });
  const state = JSON.parse(await readFile(env.statePath, "utf8"));
  state.agents.coder.cwd = env.workspace;
  await writeFile(env.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const run = await runAgent(["repair", "coder", "上次改坏了，请重改", "--cwd", env.workspace, "--claude", env.fakeScript], env);

  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /REPAIR_OK/);

  const args = await readCapturedArgs(env.capturePath);
  assert.equal(args[args.indexOf("--max-turns") + 1], "12");
  assert.equal(args[args.indexOf("--resume") + 1], "old-session");
  const prompt = args[args.indexOf("-p") + 1];
  assert.match(prompt, /上次改坏了，请重改/);
  assert.match(prompt, /当前 git status --short/);
  assert.match(prompt, /上次运行摘要/);
  assert.match(prompt, /当前目录不是 git 仓库/);
  assert.doesNotMatch(prompt, /usage: git diff/);

  const updatedState = JSON.parse(await readFile(env.statePath, "utf8"));
  assert.equal(updatedState.agents.coder.sessionId, "fake-session");
});

test("ask runs Claude through WSL runtime with explicit user and distro", async (t) => {
  const env = await setupHarness(t, {
    fakeResult: "WSL_OK",
    fakeWslPath: "/mnt/d/workspace",
    initialState: { version: 1, agents: {} }
  });

  const run = await runAgent([
    "ask",
    "wsl-reviewer",
    "hello wsl",
    "--cwd",
    env.workspace,
    "--runtime",
    "wsl",
    "--wsl-user",
    "mnl",
    "--wsl-distro",
    "Ubuntu",
    "--wsl-exe",
    env.fakeWslScript,
    "--wsl-claude",
    "claude",
    "--claude",
    env.fakeScript
  ], env);

  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /WSL_OK/);

  const records = await readCapturedRecords(env.capturePath);
  assert.equal(records.some((record) => record.kind === "wsl-probe-claude" && record.user === "mnl"), true);
  const wslPathRecord = records.find((record) => record.kind === "wslpath");
  assert.deepEqual(wslPathRecord, {
    kind: "wslpath",
    args: ["--distribution", "Ubuntu", "--user", "mnl", "--exec", "wslpath", "-u", env.workspace]
  });
  const runRecord = records.find((record) => record.kind === "wsl-run");
  assert.deepEqual(runRecord.args.slice(0, 10), [
    "--distribution",
    "Ubuntu",
    "--user",
    "mnl",
    "--cd",
    "/mnt/d/workspace",
    "--exec",
    "sh",
    "-lc",
    "exec '/home/mnl/.local/bin/claude' \"$@\""
  ]);
  assert.equal(runRecord.args.includes("--resume"), false);
  const allowedTools = runRecord.args[runRecord.args.indexOf("--allowedTools") + 1];
  assert.match(allowedTools, /Bash\(cat \*\)/);
  assert.match(allowedTools, /Bash\(ls \*\)/);
  assert.doesNotMatch(allowedTools, /Get-Content/);
  const appendPrompt = runRecord.args[runRecord.args.indexOf("--append-system-prompt") + 1];
  assert.match(appendPrompt, /cat、head、sed、ls/);
  assert.doesNotMatch(appendPrompt, /Get-Content/);

  const state = JSON.parse(await readFile(env.statePath, "utf8"));
  assert.equal(state.agents["wsl-reviewer"].runtime, "wsl");
  assert.equal(state.agents["wsl-reviewer"].wslUser, "mnl");
  assert.equal(state.agents["wsl-reviewer"].wslDistro, "Ubuntu");
  assert.equal(state.agents["wsl-reviewer"].wslExe, env.fakeWslScript);
  assert.equal(state.agents["wsl-reviewer"].claudeCommand, "claude");
  assert.equal(state.agents["wsl-reviewer"].cwd, env.workspace);
});

test("WSL runtime auto-detects a Linux user with Claude available", async (t) => {
  const env = await setupHarness(t, {
    fakeResult: "WSL_AUTO_OK",
    fakeWslPath: "/mnt/x/project",
    initialState: { version: 1, agents: {} }
  });

  const run = await runAgent([
    "ask",
    "wsl-auto",
    "hello auto",
    "--cwd",
    env.workspace,
    "--runtime",
    "wsl",
    "--wsl-exe",
    env.fakeWslScript,
    "--claude",
    env.fakeScript
  ], env);

  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /WSL_AUTO_OK/);

  const records = await readCapturedRecords(env.capturePath);
  assert.equal(records.some((record) => record.kind === "wsl-probe-users"), true);
  assert.equal(records.some((record) => record.kind === "wsl-probe-claude" && record.user === "mnl"), true);
  const wslPathRecord = records.find((record) => record.kind === "wslpath");
  assert.deepEqual(wslPathRecord, {
    kind: "wslpath",
    args: ["--user", "mnl", "--exec", "wslpath", "-u", env.workspace]
  });
  const runRecord = records.find((record) => record.kind === "wsl-run");
  assert.deepEqual(runRecord.args.slice(0, 8), [
    "--user",
    "mnl",
    "--cd",
    "/mnt/x/project",
    "--exec",
    "sh",
    "-lc",
    "exec '/home/mnl/.local/bin/claude' \"$@\""
  ]);

  const state = JSON.parse(await readFile(env.statePath, "utf8"));
  assert.equal(state.agents["wsl-auto"].runtime, "wsl");
  assert.equal(state.agents["wsl-auto"].wslUser, "mnl");
  assert.equal(state.agents["wsl-auto"].wslDistro, undefined);
});

test("WSL runtime replaces stale Windows default tools from existing agent state", async (t) => {
  const windowsDefaultTools = "Read,Grep,Glob,LS,Bash(rg *),Bash(Get-Content *),Bash(git diff *),Bash(git status *)";
  const env = await setupHarness(t, {
    fakeResult: "WSL_STALE_OK",
    fakeWslPath: "/mnt/stale/workspace",
    initialState: {
      version: 1,
      agents: {
        "wsl-stale": {
          name: "wsl-stale",
          cwd: "",
          sessionId: "old-wsl-session",
          runtime: "wsl",
          permissionMode: "none",
          maxTurns: "6",
          allowedTools: windowsDefaultTools,
          claudeCommand: "claude",
          wslUser: "mnl",
          wslExe: "",
          wslClaude: "claude",
          yolo: false
        }
      }
    }
  });
  const state = JSON.parse(await readFile(env.statePath, "utf8"));
  state.agents["wsl-stale"].cwd = env.workspace;
  state.agents["wsl-stale"].wslExe = env.fakeWslScript;
  await writeFile(env.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const run = await runAgent(["ask", "wsl-stale", "hello stale"], env);

  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /WSL_STALE_OK/);

  const records = await readCapturedRecords(env.capturePath);
  const runRecord = records.find((record) => record.kind === "wsl-run");
  const allowedTools = runRecord.args[runRecord.args.indexOf("--allowedTools") + 1];
  assert.match(allowedTools, /Bash\(cat \*\)/);
  assert.doesNotMatch(allowedTools, /Get-Content/);
  assert.equal(runRecord.args[runRecord.args.indexOf("--resume") + 1], "old-wsl-session");
});

async function setupHarness(t, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), "runmux-test-"));
  const workspace = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  const statePath = path.join(root, "agents.json");
  const logDir = path.join(root, "logs");
  const capturePath = path.join(root, "claude-args.jsonl");

  await mkdir(workspace, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(options.initialState, null, 2)}\n`, "utf8");

  const fakeScript = path.join(binDir, "fake-claude.mjs");
  const fakeWslScript = path.join(binDir, "fake-wsl.mjs");
  const fakeCmd = path.join(binDir, "claude.cmd");
  const fakeClaudePackageDir = path.join(
    binDir,
    "node_modules",
    "@anthropic-ai",
    "claude-code"
  );
  const fakePackageCommand = path.join(fakeClaudePackageDir, "bin", "claude.mjs");
  const fakeGitScript = path.join(binDir, "git.cmd");
  const fakeGitUnixScript = path.join(binDir, "git");
  await mkdir(path.dirname(fakePackageCommand), { recursive: true });
  await writeFile(fakeScript, `
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.CLAUDE_CAPTURE_PATH, JSON.stringify(args) + "\\n");

if (args.includes("--version")) {
  console.log("2.1.146 (Claude Code)");
  process.exit(0);
}

if (args.includes("--help")) {
  console.log("-p --output-format --name --resume --dangerously-skip-permissions --allowedTools --append-system-prompt --mcp-config --model");
  process.exit(0);
}

console.log(JSON.stringify({
  result: process.env.CLAUDE_FAKE_RESULT || "OK",
  session_id: "fake-session",
  total_cost_usd: 0
}));
`, "utf8");
  await writeFile(fakePackageCommand, await readFile(fakeScript, "utf8"), "utf8");
  await writeFile(
    path.join(fakeClaudePackageDir, "package.json"),
    `${JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "bin/claude.mjs" } }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(fakeWslScript, `
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const userIndex = args.indexOf("--user");
const user = userIndex >= 0 ? args[userIndex + 1] : null;
const shellCommand = args.at(-1) || "";
if (args.includes("wslpath")) {
  appendFileSync(process.env.CLAUDE_CAPTURE_PATH, JSON.stringify({ kind: "wslpath", args }) + "\\n");
  console.log(process.env.CLAUDE_FAKE_WSL_PATH || "/mnt/fake/workspace");
  process.exit(0);
}

if (shellCommand.includes("getent passwd")) {
  appendFileSync(process.env.CLAUDE_CAPTURE_PATH, JSON.stringify({ kind: "wsl-probe-users", args }) + "\\n");
  if (shellCommand.includes("home")) {
    console.log("claudeuser\\nmnl");
  } else {
    console.log("claudeuser");
  }
  process.exit(0);
}

if (shellCommand.includes("command -v 'claude'") || shellCommand.includes("command -v claude")) {
  appendFileSync(process.env.CLAUDE_CAPTURE_PATH, JSON.stringify({ kind: "wsl-probe-claude", user, args }) + "\\n");
  if (user === "mnl") {
    console.log("/home/mnl/.local/bin/claude\\nmnl");
    process.exit(0);
  }
  process.exit(1);
}

appendFileSync(process.env.CLAUDE_CAPTURE_PATH, JSON.stringify({ kind: "wsl-run", args }) + "\\n");
console.log(JSON.stringify({
  result: process.env.CLAUDE_FAKE_RESULT || "OK",
  session_id: "fake-wsl-session",
  total_cost_usd: 0
}));
`, "utf8");
  await writeFile(fakeCmd, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, "utf8");
  await writeFile(fakeGitScript, `@echo off\r\nif "%GIT_FAKE_MODE%"=="nonrepo" (\r\n  if "%1"=="rev-parse" exit /b 1\r\n  echo SHOULD_NOT_BE_USED\r\n  exit /b 1\r\n)\r\nif "%1"=="rev-parse" (\r\n  echo true\r\n  exit /b 0\r\n)\r\nif "%1"=="status" (\r\n  echo M index.html\r\n  exit /b 0\r\n)\r\nif "%1"=="diff" (\r\n  echo index.html ^| 5 +++--\r\n  exit /b 0\r\n)\r\necho UNKNOWN_GIT_CALL\r\nexit /b 1\r\n`, "utf8");
  await writeFile(fakeGitUnixScript, `#!/usr/bin/env node
const [command] = process.argv.slice(2);
if (process.env.GIT_FAKE_MODE === "nonrepo") {
  if (command === "rev-parse") process.exit(1);
  console.log("SHOULD_NOT_BE_USED");
  process.exit(1);
}
if (command === "rev-parse") {
  console.log("true");
  process.exit(0);
}
if (command === "status") {
  console.log("M index.html");
  process.exit(0);
}
if (command === "diff") {
  console.log("index.html | 5 +++--");
  process.exit(0);
}
console.log("UNKNOWN_GIT_CALL");
process.exit(1);
`, "utf8");
  await chmod(fakeGitUnixScript, 0o755);

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return {
    workspace,
    statePath,
    logDir,
    capturePath,
    fakeScript,
    fakeWslScript,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      GIT_CEILING_DIRECTORIES: root,
      CLAUDE_CAPTURE_PATH: capturePath,
      CLAUDE_FAKE_RESULT: options.fakeResult,
      CLAUDE_FAKE_WSL_PATH: options.fakeWslPath || "/mnt/fake/workspace",
      GIT_FAKE_MODE: options.gitMode || "repo",
      RUNMUX_STATE_PATH: statePath,
      RUNMUX_LOG_DIR: logDir
    }
  };
}

async function runAgent(args, harness) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agentScript, ...args], {
      cwd: repoDir,
      env: harness.env,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function readCapturedArgs(capturePath) {
  const lines = (await readFile(capturePath, "utf8")).trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1));
}

async function readCapturedRecords(capturePath) {
  const text = (await readFile(capturePath, "utf8")).trim();
  return text ? text.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}
