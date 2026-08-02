#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const homeDir = process.env.USERPROFILE || process.env.HOME || "";
const runMuxHome = process.env.RUNMUX_HOME || (homeDir ? path.join(homeDir, ".runmux") : __dirname);
const statePath = process.env.RUNMUX_STATE_PATH || path.join(runMuxHome, "agents.json");
const logDir = process.env.RUNMUX_LOG_DIR || path.join(runMuxHome, "logs");
const skillDir = homeDir ? path.join(homeDir, ".codex", "skills", "runmux") : "";
const skillCreatorScript = homeDir
  ? path.join(homeDir, ".codex", "skills", ".system", "skill-creator", "scripts", "quick_validate.py")
  : "";

const defaultAllowedToolsWindows = "Read,Grep,Glob,LS,Bash(rg *),Bash(Get-Content *),Bash(git diff *),Bash(git status *)";
const defaultAllowedToolsWsl = "Read,Grep,Glob,LS,Bash(rg *),Bash(cat *),Bash(head *),Bash(sed *),Bash(ls *),Bash(git diff *),Bash(git status *)";
const defaultAllowedTools = defaultAllowedToolsWindows;
const defaultPermissionMode = "none";
const defaultMaxTurns = "6";
const defaultTimeoutMs = 120000;
const supportedEffortLevels = new Set(["low", "medium", "high", "xhigh", "max"]);
const legacyDefaultAllowedTools = "Read,Grep,Glob,LS";
const legacyDefaultPermissionMode = "plan";
const readOnlyAppendSystemPromptWindows = [
  "只读分析模式：不要修改文件，不要创建文件，不要删除文件，不要提交 git。",
  "Bash 仅允许使用 rg、Get-Content、git diff、git status 进行只读检查。",
  "禁止运行编译、测试、安装依赖、格式化、数据库变更、网络写入或任何会改变工作区状态的命令。"
].join("\n");
const readOnlyAppendSystemPromptWsl = [
  "只读分析模式：不要修改文件，不要创建文件，不要删除文件，不要提交 git。",
  "Bash 仅允许使用 rg、cat、head、sed、ls、git diff、git status 进行只读检查。",
  "禁止运行编译、测试、安装依赖、格式化、数据库变更、网络写入或任何会改变工作区状态的命令。"
].join("\n");
const readOnlyAppendSystemPrompt = readOnlyAppendSystemPromptWindows;

const args = process.argv.slice(2);

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});

async function main() {
  const command = args.shift();

  switch (command) {
    case "ask":
      await ask(args);
      break;
    case "once":
    case "ask-once":
      await once(args);
      break;
    case "smoke":
      await smoke(args);
      break;
    case "repair":
      await repair(args);
      break;
    case "adversarial":
    case "challenge":
      await adversarial(args);
      break;
    case "quick-adversarial":
    case "quick-challenge":
      await quickAdversarial(args);
      break;
    case "diff-review":
      await diffReview(args);
      break;
    case "doctor":
    case "health":
      await health(args);
      break;
    case "transcript":
      await transcript(args);
      break;
    case "list":
      await listAgents();
      break;
    case "show":
      await showAgent(args);
      break;
    case "reset":
      await resetAgent(args);
      break;
    case "remove":
      await removeAgent(args);
      break;
    case "version":
    case "-v":
    case "--version":
      await printVersion();
      break;
    case "help":
    case "-h":
    case "--help":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`未知命令：${command}\n执行 help 查看用法。`);
  }
}

async function printVersion() {
  const manifest = JSON.parse(await readFile(path.join(__dirname, "package.json"), "utf8"));
  console.log(`runmux ${manifest.version}`);
}

async function ask(commandArgs) {
  const agentName = commandArgs.shift();
  if (!agentName) {
    throw new Error("缺少 agent 名称。示例：runmux ask reviewer \"分析当前项目\"");
  }

  const { values, rest } = parseOptions(commandArgs);
  const prompt = rest.join(" ").trim();
  if (!prompt) {
    throw new Error("缺少 prompt。示例：runmux ask reviewer \"分析当前项目\"");
  }

  const answer = await runAsk(agentName, prompt, values);
  printAskAnswer(answer, values);
}

async function once(commandArgs) {
  const agentName = commandArgs.shift();
  if (!agentName) {
    throw new Error("缺少 agent 名称。示例：runmux once reviewer \"只读分析当前问题\" --cwd <workspace>");
  }

  const { values, rest } = parseOptions(commandArgs);
  const prompt = rest.join(" ").trim();
  if (!prompt) {
    throw new Error("缺少 prompt。示例：runmux once reviewer \"只读分析当前问题\" --cwd <workspace>");
  }

  const answer = await runAsk(agentName, prompt, {
    ...values,
    fresh: true,
    persistState: false,
    ignorePreviousConfig: true,
    safe: values.yolo ? false : true
  });
  printAskAnswer(answer, values);
}

async function smoke(commandArgs) {
  const { values } = parseOptions(commandArgs);
  const cwd = path.resolve(values.cwd || process.cwd());
  if (!existsSync(cwd)) {
    throw new Error(`工作目录不存在：${cwd}`);
  }

  const probeFile = values.probeFile || "README.md";
  const expectedStatus = existsSync(path.join(cwd, probeFile)) ? "存在" : "不存在";
  const agentName = values.agent || "__smoke__";
  const prompt = `这是 Claude Code 子 agent 连通性 smoke 测试。请只做只读检查，不要修改文件。

请检查当前工作目录下的 ${probeFile} 是否存在，并严格只输出下面两行：
RUNMUX_SMOKE_OK
${probeFile}: ${expectedStatus}`;

  const answer = await runAsk(agentName, prompt, {
    ...values,
    cwd,
    fresh: true,
    safe: true,
    maxTurns: values.maxTurns ?? "3",
    persistState: false,
    ignorePreviousConfig: true
  });

  const expectedLine = `${probeFile}: ${expectedStatus}`;
  if (!answer.result.includes("RUNMUX_SMOKE_OK") || !answer.result.includes(expectedLine)) {
    throw new Error(`smoke 输出不符合预期。\n预期包含：RUNMUX_SMOKE_OK 和 ${expectedLine}\n实际输出：\n${answer.result}\n日志：${answer.logPath}`);
  }

  if (values.json) {
    console.log(JSON.stringify({
      ok: true,
      probeFile,
      expectedStatus,
      agent: summarizeAnswer(answer)
    }, null, 2));
    return;
  }

  if (values.stream) {
    console.error(`\n[runmux] smoke: ${expectedLine}`);
    console.error(`[runmux] smoke agent=${answer.agentName} session=${answer.sessionId || "未返回"} log=${answer.logPath}`);
    return;
  }

  console.log(`[OK] smoke: ${expectedLine}`);
  console.error(`\n[runmux] smoke agent=${answer.agentName} session=${answer.sessionId || "未返回"} log=${answer.logPath}`);
}

async function repair(commandArgs) {
  const agentName = commandArgs.shift();
  if (!agentName) {
    throw new Error("缺少 agent 名称。示例：runmux repair coder \"修复上次改坏的问题\"");
  }

  const { values, rest } = parseOptions(commandArgs);
  const userPrompt = rest.join(" ").trim();
  if (!userPrompt) {
    throw new Error("缺少 repair prompt。示例：runmux repair coder \"修复上次改坏的问题\"");
  }

  const state = await readState();
  const previous = state.agents[agentName];
  if (!previous?.sessionId) {
    throw new Error(`agent ${agentName} 没有可恢复的 session。请先用 ask 创建持续会话。`);
  }

  const cwd = path.resolve(values.cwd || previous.cwd || process.cwd());
  if (previous.cwd && values.cwd && path.resolve(previous.cwd) !== cwd) {
    throw new Error(`agent ${agentName} 已绑定到 ${previous.cwd}。repair 需要在同一工作目录中运行。`);
  }

  const [gitSnapshot, lastRunSummary] = await Promise.all([
    collectGitSnapshot(cwd),
    getLastRunSummary(agentName)
  ]);

  const prompt = `你是持续 coder 子 agent，现在需要返工修复上一次相关改动。优先基于当前工作区真实状态和当前 diff 判断问题，不要扩大修改范围。

用户要求：
${userPrompt}

上次运行摘要：
${lastRunSummary}

当前 git status --short：
${gitSnapshot.status}

当前 git diff --stat：
${gitSnapshot.diffStat}

约束：
1. 只处理和上次改动或用户描述直接相关的问题。
2. 如果当前 agent 处于只读模式，只输出修复方案和需要修改的文件，不要修改文件。
3. 如果当前 agent 处于 yolo 模式，可以修改文件，但不要提交 git。
4. 输出修复原因、改动文件、剩余风险和建议验证命令。`;

  const answer = await runAsk(agentName, prompt, {
    ...values,
    maxTurns: values.maxTurns ?? "12"
  });
  printAskAnswer(answer, values);
}

async function adversarial(commandArgs) {
  const baseName = commandArgs.shift();
  if (!baseName) {
    throw new Error("缺少对抗验证名称。示例：runmux adversarial review \"审查当前改动\"");
  }

  const { values, rest } = parseOptions(commandArgs);
  const prompt = rest.join(" ").trim();
  if (!prompt) {
    throw new Error("缺少对抗验证 prompt。示例：runmux adversarial review \"审查当前改动\"");
  }
  if (values.yolo) {
    throw new Error("adversarial 默认只读，不支持 --yolo。需要改代码时先用 ask coder --yolo，再用 adversarial 只读验证改动。");
  }

  const safeValues = {
    ...values,
    safe: true,
    yolo: false,
    maxTurns: values.maxTurns ?? defaultMaxTurns
  };

  const proposerName = `${baseName}-proposer`;
  const criticName = `${baseName}-critic`;
  const judgeName = `${baseName}-judge`;

  const proposerPrompt = `你是 proposer 子 agent。请针对下面任务给出可执行结论。默认只读，不修改文件。

任务：
${prompt}

输出要求：
1. 核心判断
2. 依据
3. 风险
4. 还需要验证的点`;

  console.error(`[runmux] adversarial step 1/3 proposer=${proposerName}`);
  const proposer = await runAsk(proposerName, proposerPrompt, safeValues);

  const criticPrompt = `你是 critic 对抗审查子 agent。请基于原始任务和 proposer 输出，专门找漏洞、反例、边界条件、遗漏风险和不符合项目规范的地方。只读，不修改文件。

原始任务：
${prompt}

proposer 输出：
${proposer.result}

输出要求：
1. 按严重程度列出问题
2. 每个问题说明依据或需要核验的位置
3. 明确哪些只是猜测
4. 不要重复 proposer 的结论`;

  console.error(`[runmux] adversarial step 2/3 critic=${criticName}`);
  const critic = await runAsk(criticName, criticPrompt, safeValues);

  const judgePrompt = `你是 judge 子 agent。请综合原始任务、proposer 输出和 critic 输出，给出最终裁决。只读，不修改文件。

原始任务：
${prompt}

proposer 输出：
${proposer.result}

critic 输出：
${critic.result}

输出要求：
1. 最终结论
2. 采纳 proposer 的哪些内容
3. 采纳 critic 的哪些问题
4. 需要修正或继续验证的事项
5. 建议下一步动作`;

  console.error(`[runmux] adversarial step 3/3 judge=${judgeName}`);
  const judge = await runAsk(judgeName, judgePrompt, safeValues);

  if (values.stream) {
    return;
  }

  if (values.json) {
    console.log(JSON.stringify({
      task: prompt,
      agents: {
        proposer: summarizeAnswer(proposer),
        critic: summarizeAnswer(critic),
        judge: summarizeAnswer(judge)
      }
    }, null, 2));
    return;
  }

  console.log(`# 对抗验证：${baseName}

## Proposer

${proposer.result}

## Critic

${critic.result}

## Judge

${judge.result}`);

  console.error(`\n[runmux] adversarial logs proposer=${proposer.logPath} critic=${critic.logPath} judge=${judge.logPath}`);
}

async function quickAdversarial(commandArgs) {
  const baseName = commandArgs.shift();
  if (!baseName) {
    throw new Error("缺少快速对抗验证名称。示例：runmux quick-adversarial review \"审查当前改动\"");
  }

  const { values, rest } = parseOptions(commandArgs);
  const prompt = rest.join(" ").trim();
  if (!prompt) {
    throw new Error("缺少快速对抗验证 prompt。示例：runmux quick-adversarial review \"审查当前改动\"");
  }
  if (values.yolo) {
    throw new Error("quick-adversarial 默认只读，不支持 --yolo。需要改代码时先用 ask coder --yolo，再用 quick-adversarial 只读验证改动。");
  }

  const role = values.role ?? "critic";
  if (!["critic", "judge"].includes(role)) {
    throw new Error("--role 仅支持 critic 或 judge。");
  }

  const safeValues = {
    ...values,
    safe: true,
    yolo: false,
    maxTurns: values.maxTurns ?? defaultMaxTurns
  };

  const agentName = `${baseName}-${role}`;
  const rolePrompt = role === "judge"
    ? `你是 judge 快速裁决子 agent。请对下面任务做只读裁决，给出最终结论、主要依据、必须修正的问题和下一步建议。不要修改文件。

任务：
${prompt}`
    : `你是 critic 快速对抗审查子 agent。请对下面任务做只读挑错，重点找漏洞、反例、边界条件、遗漏风险和不符合项目规范的地方。不要修改文件。

任务：
${prompt}

输出要求：
1. 按严重程度列出问题
2. 每个问题说明依据或需要核验的位置
3. 明确哪些只是猜测
4. 如果没有发现问题，直接说明剩余风险`;

  console.error(`[runmux] quick-adversarial role=${role} agent=${agentName}`);
  const answer = await runAsk(agentName, rolePrompt, safeValues);

  if (values.stream) {
    return;
  }

  if (values.json) {
    console.log(JSON.stringify({
      task: prompt,
      role,
      agent: summarizeAnswer(answer)
    }, null, 2));
    return;
  }

  console.log(`# 快速对抗验证：${baseName} (${role})

${answer.result}`);
  console.error(`\n[runmux] quick-adversarial log=${answer.logPath}`);
}

async function diffReview(commandArgs) {
  const baseName = commandArgs.shift();
  if (!baseName) {
    throw new Error("缺少 diff-review 名称。示例：runmux diff-review review --cwd \"D:\\code\\project\"");
  }

  const { values, rest } = parseOptions(commandArgs);
  if (values.yolo) {
    throw new Error("diff-review 是只读审查命令，不支持 --yolo。");
  }

  const extraPrompt = rest.join(" ").trim();
  const safeValues = {
    ...values,
    safe: true,
    yolo: false,
    maxTurns: values.maxTurns ?? "8"
  };
  const agentName = `${baseName}-diff-review`;
  const reviewPrompt = `你是只读代码审查子 agent。请审查当前工作区改动，不要修改文件。

必须先用 git status --short 和 git diff --stat 获取改动概览。
如果改动很小，再读取 git diff；如果改动很多，只挑风险最高的文件读取 git diff -- <path>。
如需定位上下文，只能使用 rg 或 Get-Content。

重点检查：
1. 行为 bug、回归风险、边界条件
2. MyBatis/SQL 风险，尤其是复杂 SQL、参数绑定、返回类型
3. Windows 路径、UTF-8 编码、中文乱码风险
4. 项目规范，包括中文注释、不要提交 git、instanceId 返回 string
5. 新增代码文件是否需要提醒人工暂存
6. 缺少必要验证或测试的地方

输出要求：
1. 发现的问题优先，按严重程度排序
2. 每个问题给出文件和依据；不确定时明确说是猜测
3. 没有发现问题时，说明剩余风险和未验证项

用户补充：
${extraPrompt || "无"}`;

  console.error(`[runmux] diff-review agent=${agentName}`);
  const answer = await runAsk(agentName, reviewPrompt, safeValues);

  if (values.stream) {
    return;
  }

  if (values.json) {
    console.log(JSON.stringify({
      agent: summarizeAnswer(answer),
      extraPrompt
    }, null, 2));
    return;
  }

  console.log(`# Diff Review：${baseName}

${answer.result}`);
  console.error(`\n[runmux] diff-review log=${answer.logPath}`);
}

async function health(commandArgs) {
  const { values } = parseOptions(commandArgs);
  const checks = [];

  checks.push(okCheck("Node", process.version));
  checks.push(existsSync(__filename) ? okCheck("wrapper", __filename) : failCheck("wrapper", `文件不存在：${__filename}`));
  checks.push(existsSync(path.join(__dirname, "runmux.ps1"))
    ? okCheck("powershell wrapper", path.join(__dirname, "runmux.ps1"))
    : failCheck("powershell wrapper", "runmux.ps1 不存在"));

  try {
    await readState();
    checks.push(okCheck("agents.json", existsSync(statePath) ? "可解析" : "不存在，将按空状态创建"));
  } catch (error) {
    checks.push(failCheck("agents.json", error?.message || String(error)));
  }

  const healthRuntime = values.runtime ?? process.env.RUNMUX_RUNTIME ?? "windows";
  const healthRuntimeConfig = await resolveRuntimeConfig(healthRuntime, values, null, __dirname);
  checks.push(okCheck("runtime", healthRuntimeConfig.runtime === "wsl"
    ? `wsl user=${healthRuntimeConfig.wslUser || "default"} distro=${healthRuntimeConfig.wslDistro || "default"}`
    : "windows"));

  const versionInvocation = buildClaudeInvocation(healthRuntimeConfig, ["--version"]);
  const claudeVersion = await runProcess(versionInvocation.command, versionInvocation.args, versionInvocation.cwd);
  checks.push(claudeVersion.exitCode === 0
    ? okCheck("claude --version", (claudeVersion.stdout || claudeVersion.stderr).trim())
    : failCheck("claude --version", claudeVersion.stderr.trim() || "无法执行 claude"));

  const helpInvocation = buildClaudeInvocation(healthRuntimeConfig, ["--help"]);
  const claudeHelp = await runProcess(helpInvocation.command, helpInvocation.args, helpInvocation.cwd);
  if (claudeHelp.exitCode === 0) {
    const helpText = `${claudeHelp.stdout}\n${claudeHelp.stderr}`;
    const requiredFlags = [
      "-p",
      "--output-format",
      "--verbose",
      "--include-partial-messages",
      "--forward-subagent-text",
      "--name",
      "--resume",
      "--dangerously-skip-permissions",
      "--allowedTools",
      "--append-system-prompt",
      "--mcp-config",
      "--model",
      "--effort"
    ];
    const missing = requiredFlags.filter((flag) => !helpText.includes(flag));
    checks.push(missing.length
      ? failCheck("claude flags", `缺少参数：${missing.join(", ")}`)
      : okCheck("claude flags", "当前 wrapper 需要的参数可用"));
  } else {
    checks.push(failCheck("claude --help", claudeHelp.stderr.trim() || "无法读取 help"));
  }

  if (skillDir && existsSync(path.join(skillDir, "SKILL.md"))) {
    checks.push(okCheck("skill", path.join(skillDir, "SKILL.md")));
    if (existsSync(skillCreatorScript)) {
      const validate = await runProcess("python", [skillCreatorScript, skillDir], __dirname, {
        env: { PYTHONUTF8: "1" }
      });
      checks.push(validate.exitCode === 0
        ? okCheck("skill validate", "Skill is valid")
        : failCheck("skill validate", validate.stderr.trim() || validate.stdout.trim()));
    } else {
      checks.push(warnCheck("skill validate", "未找到 quick_validate.py，跳过"));
    }
  } else {
    checks.push(warnCheck("skill", "未找到 runmux skill；wrapper 仍可直接使用"));
  }

  const failed = checks.some((item) => item.status === "fail");
  if (values.json) {
    console.log(JSON.stringify({ ok: !failed, checks }, null, 2));
  } else {
    for (const check of checks) {
      console.log(`${formatStatus(check.status)} ${check.name}: ${check.detail}`);
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

async function transcript(commandArgs) {
  const target = commandArgs.shift();
  if (!target) {
    throw new Error("缺少 transcript 目标。示例：runmux transcript review --last 3");
  }

  const { values } = parseOptions(commandArgs);
  const last = Number.parseInt(values.last ?? "5", 10);
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error("--last 必须是正整数。");
  }

  const entries = await readLogEntries(target);
  const selected = entries.slice(-last);
  if (!selected.length) {
    console.log(`没有找到匹配日志：${target}`);
    return;
  }

  if (values.json) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }

  console.log(`# Transcript：${target}`);
  for (const entry of selected) {
    console.log(`
## ${entry.agent} ${entry.startedAt}

cwd: ${entry.cwd}
exitCode: ${entry.exitCode}

### Prompt

${entry.prompt || "未找到 prompt"}

### Result

${entry.result || "未找到 result"}`);

    if (entry.stderr) {
      console.log(`
### Stderr

${entry.stderr}`);
    }
  }
}

async function runAsk(agentName, prompt, values) {
  const state = await readState();
  const previous = state.agents[agentName];
  const cwd = path.resolve(values.cwd || previous?.cwd || process.cwd());
  if (!existsSync(cwd)) {
    throw new Error(`工作目录不存在：${cwd}`);
  }

  if (previous?.cwd && values.cwd && path.resolve(previous.cwd) !== cwd && !values.fresh) {
    throw new Error(`agent ${agentName} 已绑定到 ${previous.cwd}。如需切换目录，请先执行 reset 或使用 --fresh。`);
  }

  const previousConfig = values.ignorePreviousConfig ? null : previous;
  const previousPermissionMode = previousConfig?.permissionMode === legacyDefaultPermissionMode
    ? defaultPermissionMode
    : previousConfig?.permissionMode;
  const permissionMode = values.mode ?? previousPermissionMode ?? defaultPermissionMode;
  const yolo = values.safe ? false : Boolean(values.yolo ?? previousConfig?.yolo ?? false);
  const maxTurns = String(values.maxTurns ?? previousConfig?.maxTurns ?? defaultMaxTurns);
  const runtime = values.runtime ?? previousConfig?.runtime ?? process.env.RUNMUX_RUNTIME ?? "windows";
  const runtimeDefaultAllowedTools = getDefaultAllowedTools(runtime);
  const canReusePreviousTools = !previousConfig?.runtime || previousConfig.runtime === runtime;
  const previousAllowedTools = !canReusePreviousTools
    ? undefined
    : normalizeStoredAllowedTools(previousConfig?.allowedTools, runtime, runtimeDefaultAllowedTools);
  const storedAllowedTools = values.tools ?? previousAllowedTools ?? runtimeDefaultAllowedTools;
  const cliAllowedTools = yolo && values.tools === undefined ? "none" : storedAllowedTools;
  const disallowedTools = values.disallowedTools ?? previousConfig?.disallowedTools;
  const effort = values.effort === undefined ? undefined : parseEffort(values.effort);
  const runtimeConfig = await resolveRuntimeConfig(runtime, values, previousConfig, cwd);
  const shouldResume = previous?.sessionId && !values.fresh;
  const timeoutMs = parsePositiveInteger(values.timeoutMs ?? defaultTimeoutMs, "timeout-ms");

  const claudeArgs = ["-p", prompt, ...getClaudeOutputArgs(values.stream), "--max-turns", maxTurns];

  claudeArgs.push("--name", agentName);
  if (shouldResume) {
    claudeArgs.push("--resume", previous.sessionId);
  }
  if (yolo) {
    claudeArgs.push("--dangerously-skip-permissions");
  } else if (permissionMode && permissionMode !== "none") {
    claudeArgs.push("--permission-mode", permissionMode);
  }
  if (cliAllowedTools && cliAllowedTools !== "none") {
    claudeArgs.push("--allowedTools", cliAllowedTools);
  }
  if (disallowedTools) {
    claudeArgs.push("--disallowedTools", disallowedTools);
  }
  if (values.mcpConfig) {
    claudeArgs.push("--mcp-config", path.resolve(values.mcpConfig));
  }
  if (values.systemPrompt) {
    claudeArgs.push("--system-prompt", values.systemPrompt);
  }
  if (values.appendSystemPrompt || !yolo) {
    const appendPrompt = [!yolo ? getReadOnlyAppendSystemPrompt(runtimeConfig.runtime) : "", values.appendSystemPrompt || ""]
      .filter(Boolean)
      .join("\n\n");
    claudeArgs.push("--append-system-prompt", appendPrompt);
  }
  if (values.model) {
    claudeArgs.push("--model", values.model);
  }
  if (effort) {
    claudeArgs.push("--effort", effort);
  }

  await mkdir(logDir, { recursive: true });
  const startedAt = new Date();
  const invocation = buildClaudeInvocation(runtimeConfig, claudeArgs);
  const run = await runProcess(invocation.command, invocation.args, invocation.cwd, values.stream
    ? {
        timeoutMs,
        onStdout: (chunk) => process.stdout.write(chunk),
        onStderr: (chunk) => process.stderr.write(chunk)
      }
    : { timeoutMs });
  const logPath = await writeRunLog(agentName, startedAt, {
    command: invocation.command,
    args: maskArgs(invocation.args),
    cwd: invocation.cwd,
    workspaceCwd: cwd,
    runtime: runtimeConfig.runtime,
    stream: Boolean(values.stream),
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr
  });

  const payload = parseProviderPayload(run.stdout, values.stream);

  if (run.exitCode !== 0) {
    const stderrDetail = values.stream ? "" : `\n${run.stderr.trim()}`;
    throw new Error(`Claude Code 执行失败，退出码 ${run.exitCode}。\n日志：${logPath}${stderrDetail}`);
  }

  if (!payload) {
    throw new Error(`Claude Code 没有返回可解析 JSON。\n日志：${logPath}`);
  }

  const sessionId = extractSessionId(payload) || previous?.sessionId;
  if (values.persistState !== false) {
    state.agents[agentName] = {
      name: agentName,
      cwd,
      sessionId,
      runtime: runtimeConfig.runtime,
      permissionMode,
      maxTurns,
      allowedTools: storedAllowedTools,
      disallowedTools,
      claudeCommand: runtimeConfig.claudeCommand,
      wslUser: runtimeConfig.wslUser,
      wslDistro: runtimeConfig.wslDistro,
      wslExe: runtimeConfig.wslExe,
      wslClaude: runtimeConfig.wslClaude,
      wslClaudePath: runtimeConfig.wslClaudePath,
      yolo,
      createdAt: previous?.createdAt || startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      lastLog: logPath,
      lastCostUsd: payload.total_cost_usd ?? payload.totalCostUsd ?? previous?.lastCostUsd ?? null
    };
    await writeState(state);
  }

  return {
    agentName,
    payload,
    result: extractResult(payload) || JSON.stringify(payload, null, 2),
    sessionId,
    logPath,
    yolo
  };
}

function printAskAnswer(answer, values) {
  if (values.stream) {
    if (answer.yolo) {
      console.error("\n[runmux] YOLO 已启用：Claude Code 可以跳过权限确认并修改文件。");
    }
    console.error(`\n[runmux] agent=${answer.agentName} session=${answer.sessionId || "未返回"} log=${answer.logPath}`);
    return;
  }

  if (values.json) {
    console.log(JSON.stringify(answer.payload, null, 2));
    return;
  }

  console.log(answer.result);

  if (answer.yolo) {
    console.error("\n[runmux] YOLO 已启用：Claude Code 可以跳过权限确认并修改文件。");
  }
  console.error(`\n[runmux] agent=${answer.agentName} session=${answer.sessionId || "未返回"} log=${answer.logPath}`);
}

function summarizeAnswer(answer) {
  return {
    agent: answer.agentName,
    sessionId: answer.sessionId,
    logPath: answer.logPath,
    result: answer.result
  };
}

async function listAgents() {
  const state = await readState();
  const rows = Object.values(state.agents);
  if (!rows.length) {
    console.log("暂无 agent。");
    return;
  }

  for (const item of rows) {
    console.log(`${item.name}\t${item.sessionId || "-"}\t${item.permissionMode || "-"}\t${item.cwd}\t${item.updatedAt || "-"}`);
  }
}

async function showAgent(commandArgs) {
  const name = commandArgs.shift();
  if (!name) {
    throw new Error("缺少 agent 名称。");
  }
  const state = await readState();
  const agent = state.agents[name];
  if (!agent) {
    throw new Error(`agent 不存在：${name}`);
  }
  console.log(JSON.stringify(agent, null, 2));
}

async function resetAgent(commandArgs) {
  const name = commandArgs.shift();
  if (!name) {
    throw new Error("缺少 agent 名称。");
  }
  const state = await readState();
  const agent = state.agents[name];
  if (!agent) {
    throw new Error(`agent 不存在：${name}`);
  }
  delete agent.sessionId;
  agent.updatedAt = new Date().toISOString();
  await writeState(state);
  console.log(`已重置 agent 会话：${name}`);
}

async function removeAgent(commandArgs) {
  const name = commandArgs.shift();
  if (!name) {
    throw new Error("缺少 agent 名称。");
  }
  const state = await readState();
  if (!state.agents[name]) {
    throw new Error(`agent 不存在：${name}`);
  }
  delete state.agents[name];
  await writeState(state);
  console.log(`已删除 agent：${name}`);
}

async function collectGitSnapshot(cwd) {
  const repoCheck = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== "true") {
    return {
      status: "(当前目录不是 git 仓库)",
      diffStat: "(当前目录不是 git 仓库)"
    };
  }

  const status = await runProcess("git", ["status", "--short"], cwd);
  const diffStat = await runProcess("git", ["diff", "--stat"], cwd);

  return {
    status: formatCommandSnapshot(status),
    diffStat: formatCommandSnapshot(diffStat)
  };
}

function formatCommandSnapshot(result) {
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return detail ? `[不可用] ${detail}` : "[不可用]";
  }
  return result.stdout.trim() || "(无)";
}

async function getLastRunSummary(agentName) {
  const entries = (await readLogEntries(agentName))
    .filter((entry) => entry.agent === agentName);
  const last = entries.at(-1);
  if (!last) {
    return "(无历史日志)";
  }

  return [
    `时间：${last.startedAt}`,
    `日志：${last.file}`,
    `退出码：${last.exitCode}`,
    `结果：${truncateText(last.result || "(无输出)", 1200)}`
  ].join("\n");
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...(已截断)`;
}

function parseOptions(rawArgs) {
  const values = {};
  const rest = [];

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = normalizeOptionName(rawKey);
    const booleanKeys = new Set(["fresh", "json", "stream", "yolo", "safe"]);

    if (booleanKeys.has(key)) {
      values[key] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }

    const value = inlineValue ?? rawArgs[++i];
    if (value === undefined) {
      throw new Error(`选项缺少值：--${rawKey}`);
    }
    values[key] = value;
  }

  validateOutputOptions(values);
  return { values, rest };
}

function validateOutputOptions(values) {
  if (values.stream && values.json) {
    throw new Error("--stream 与 --json 不能同时使用。");
  }
}

function normalizeOptionName(name) {
  const map = {
    cwd: "cwd",
    mode: "mode",
    "max-turns": "maxTurns",
    tools: "tools",
    "allowed-tools": "tools",
    "disallowed-tools": "disallowedTools",
    claude: "claude",
    runtime: "runtime",
    "wsl-user": "wslUser",
    "wsl-distro": "wslDistro",
    "wsl-exe": "wslExe",
    "wsl-claude": "wslClaude",
    "mcp-config": "mcpConfig",
    system: "systemPrompt",
    "system-prompt": "systemPrompt",
    "append-system": "appendSystemPrompt",
    "append-system-prompt": "appendSystemPrompt",
    model: "model",
    effort: "effort",
    role: "role",
    agent: "agent",
    "probe-file": "probeFile",
    last: "last",
    "timeout-ms": "timeoutMs",
    fresh: "fresh",
    json: "json",
    stream: "stream",
    yolo: "yolo",
    safe: "safe"
  };
  return map[name] || name;
}

function okCheck(name, detail) {
  return { status: "ok", name, detail };
}

function warnCheck(name, detail) {
  return { status: "warn", name, detail };
}

function failCheck(name, detail) {
  return { status: "fail", name, detail };
}

function formatStatus(status) {
  if (status === "ok") {
    return "[OK]";
  }
  if (status === "warn") {
    return "[WARN]";
  }
  return "[FAIL]";
}

function getDefaultAllowedTools(runtime) {
  return runtime === "wsl" ? defaultAllowedToolsWsl : defaultAllowedToolsWindows;
}

function getReadOnlyAppendSystemPrompt(runtime) {
  return runtime === "wsl" ? readOnlyAppendSystemPromptWsl : readOnlyAppendSystemPromptWindows;
}

function normalizeStoredAllowedTools(allowedTools, runtime, runtimeDefaultAllowedTools) {
  if (!allowedTools) {
    return undefined;
  }
  if (allowedTools === legacyDefaultAllowedTools) {
    return runtimeDefaultAllowedTools;
  }
  if (runtime === "wsl" && allowedTools === defaultAllowedToolsWindows) {
    return runtimeDefaultAllowedTools;
  }
  return allowedTools;
}

async function resolveWindowsClaudeCommand(requestedCommand, includeDefaults) {
  const requested = String(requestedCommand || "claude").trim() || "claude";
  const candidates = collectWindowsCommandCandidates(requested);
  if (includeDefaults) {
    candidates.push(...defaultWindowsClaudeCommandCandidates());
  }

  for (const candidate of uniquePaths(candidates)) {
    const spawnable = await resolveWindowsSpawnableClaudeCommand(candidate);
    if (spawnable && await commandReportsVersion(spawnable)) {
      return spawnable;
    }
  }

  throw new Error(
    `Windows 中未找到可直接启动的 Claude Code。请确认已安装 Claude Code，或使用 --claude 指定原生可执行文件。`
  );
}

function collectWindowsCommandCandidates(command) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\") || path.extname(command)) {
    return [command];
  }

  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  const directories = (process.env.PATH || "")
    .split(path.delimiter)
    .map((directory) => directory.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const candidates = [];
  for (const directory of directories) {
    for (const extension of extensions) {
      candidates.push(path.join(directory, `${command}${extension.toLowerCase()}`));
      candidates.push(path.join(directory, `${command}${extension.toUpperCase()}`));
    }
  }
  return candidates;
}

function defaultWindowsClaudeCommandCandidates() {
  const candidates = [];
  if (homeDir) {
    candidates.push(path.join(homeDir, ".local", "bin", "claude.exe"));
  }
  const appData = process.env.APPDATA || (homeDir ? path.join(homeDir, "AppData", "Roaming") : "");
  if (appData) {
    candidates.push(path.join(appData, "npm", "claude.cmd"));
    candidates.push(
      path.join(
        appData,
        "npm",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe"
      )
    );
  }
  return candidates;
}

function uniquePaths(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function resolveWindowsSpawnableClaudeCommand(candidate) {
  if (!existsSync(candidate)) {
    return null;
  }

  const extension = path.extname(candidate).toLowerCase();
  if ([".exe", ".com", ".js", ".mjs", ".cjs"].includes(extension)) {
    return candidate;
  }
  if (![".cmd", ".bat"].includes(extension)) {
    return null;
  }

  const packageDirectory = path.join(
    path.dirname(candidate),
    "node_modules",
    "@anthropic-ai",
    "claude-code"
  );
  try {
    const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
    const binEntry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.claude;
    if (typeof binEntry !== "string" || !binEntry.trim()) {
      return null;
    }
    const packageCommand = path.resolve(packageDirectory, binEntry);
    const packageExtension = path.extname(packageCommand).toLowerCase();
    return existsSync(packageCommand) && [".exe", ".com", ".js", ".mjs", ".cjs"].includes(packageExtension)
      ? packageCommand
      : null;
  } catch {
    return null;
  }
}

async function commandReportsVersion(command) {
  try {
    const result = await runProcess(command, ["--version"], __dirname, { timeoutMs: 3000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function resolveRuntimeConfig(runtime, values, previousConfig, cwd) {
  if (runtime !== "windows" && runtime !== "wsl") {
    throw new Error(`不支持的 runtime：${runtime}。可用值：windows, wsl`);
  }

  if (runtime === "windows") {
    const explicitClaudeCommand = values.claude ?? process.env.RUNMUX_CLAUDE;
    const requestedClaudeCommand = explicitClaudeCommand ?? previousConfig?.claudeCommand ?? "claude";
    const claudeCommand = await resolveWindowsClaudeCommand(
      requestedClaudeCommand,
      explicitClaudeCommand === undefined
    );
    return {
      runtime: "windows",
      claudeCommand,
      command: claudeCommand,
      cwd
    };
  }

  const wslExe = values.wslExe ?? previousConfig?.wslExe ?? process.env.RUNMUX_WSL_EXE ?? "wsl.exe";
  const wslDistro = values.wslDistro ?? previousConfig?.wslDistro ?? process.env.RUNMUX_WSL_DISTRO;
  const explicitWslUser = values.wslUser ?? previousConfig?.wslUser ?? process.env.RUNMUX_WSL_USER;
  const wslClaude = values.wslClaude ?? previousConfig?.wslClaude ?? process.env.RUNMUX_WSL_CLAUDE ?? "claude";
  const detected = explicitWslUser
    ? await requireWslClaudeForUser({ wslExe, wslDistro, wslUser: explicitWslUser, wslClaude })
    : await detectWslClaudeUser({ wslExe, wslDistro, wslClaude });
  const wslUser = explicitWslUser ?? detected.user;
  const wslCwd = await toWslPath(cwd, { wslExe, wslDistro, wslUser });

  return {
    runtime: "wsl",
    claudeCommand: wslClaude,
    command: wslExe,
    cwd,
    wslCwd,
    wslUser,
    wslDistro,
    wslExe,
    wslClaude,
    wslClaudePath: detected.commandPath || wslClaude
  };
}

function buildClaudeInvocation(runtimeConfig, claudeArgs) {
  if (runtimeConfig.runtime === "windows") {
    return {
      command: runtimeConfig.command,
      args: claudeArgs,
      cwd: runtimeConfig.cwd
    };
  }

  return {
    command: runtimeConfig.wslExe,
    args: [
      ...buildWslBaseArgs(runtimeConfig.wslDistro, runtimeConfig.wslUser),
      "--cd",
      runtimeConfig.wslCwd,
      "--exec",
      "sh",
      "-lc",
      `exec ${shellQuote(runtimeConfig.wslClaudePath || runtimeConfig.wslClaude)} "$@"`,
      "runmux",
      ...claudeArgs
    ],
    cwd: runtimeConfig.cwd
  };
}

async function detectWslClaudeUser({ wslExe, wslDistro, wslClaude }) {
  const defaultProbe = await probeWslClaude({ wslExe, wslDistro, wslUser: undefined, wslClaude });
  if (defaultProbe.ok) {
    return { user: undefined, detectedUser: defaultProbe.user, commandPath: defaultProbe.commandPath };
  }

  const users = await listWslUsers({ wslExe, wslDistro });
  for (const user of users) {
    const probe = await probeWslClaude({ wslExe, wslDistro, wslUser: user, wslClaude });
    if (probe.ok) {
      return { user, detectedUser: probe.user || user, commandPath: probe.commandPath };
    }
  }

  throw new Error(`WSL 中没有自动找到可执行的 ${wslClaude}。请确认 Claude Code 已安装，或传入 --wsl-user / --wsl-claude。`);
}

async function requireWslClaudeForUser({ wslExe, wslDistro, wslUser, wslClaude }) {
  const probe = await probeWslClaude({ wslExe, wslDistro, wslUser, wslClaude });
  if (!probe.ok) {
    throw new Error(`WSL 用户 ${wslUser} 中没有找到可执行的 ${wslClaude}。请确认 Claude Code 已安装，或传入 --wsl-claude。`);
  }
  return { user: wslUser, detectedUser: probe.user || wslUser, commandPath: probe.commandPath };
}

async function probeWslClaude({ wslExe, wslDistro, wslUser, wslClaude }) {
  const probeScript = `if command -v ${shellQuote(wslClaude)} >/dev/null 2>&1; then command -v ${shellQuote(wslClaude)}; whoami; fi`;
  const run = await runProcess(wslExe, [
    ...buildWslBaseArgs(wslDistro, wslUser),
    "--exec",
    "sh",
    "-lc",
    probeScript
  ], __dirname, { timeoutMs: 15000 });

  if (run.exitCode !== 0 || !run.stdout.trim()) {
    return { ok: false };
  }

  const lines = run.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { ok: true, commandPath: lines[0], user: lines[1] };
}

async function listWslUsers({ wslExe, wslDistro }) {
  const listScript = "getent passwd | awk -F: '($3 >= 1000 && $3 < 60000) || $6 ~ /^\\/home\\// { print $1 }'";
  const run = await runProcess(wslExe, [
    ...buildWslBaseArgs(wslDistro, undefined),
    "--exec",
    "sh",
    "-lc",
    listScript
  ], __dirname, { timeoutMs: 15000 });

  if (run.exitCode !== 0) {
    throw new Error(`无法读取 WSL 用户列表：${run.stderr.trim() || run.stdout.trim()}`);
  }

  return [...new Set(run.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

async function toWslPath(winPath, { wslExe, wslDistro, wslUser }) {
  const run = await runProcess(wslExe, [
    ...buildWslBaseArgs(wslDistro, wslUser),
    "--exec",
    "wslpath",
    "-u",
    winPath
  ], __dirname, { timeoutMs: 15000 });

  if (run.exitCode !== 0 || !run.stdout.trim()) {
    throw new Error(`无法把 Windows 路径转换为 WSL 路径：${winPath}\n${run.stderr.trim() || run.stdout.trim()}`);
  }

  return run.stdout.trim().split(/\r?\n/)[0];
}

function buildWslBaseArgs(wslDistro, wslUser) {
  const args = [];
  if (wslDistro) {
    args.push("--distribution", wslDistro);
  }
  if (wslUser) {
    args.push("--user", wslUser);
  }
  return args;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runProcess(command, commandArgs, cwd, options = {}) {
  return await new Promise((resolve, reject) => {
    const invocation = resolveProcessInvocation(command, commandArgs);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      windowsHide: true,
      shell: invocation.shell,
      env: { ...process.env, ...(options.env || {}) }
    });

    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let settled = false;
    const timeoutMs = options.timeoutMs;
    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          stderr += `\nProcess timed out after ${timeoutMs}ms`;
          child.kill("SIGTERM");
        }, timeoutMs)
      : null;

    if (child.stdin) {
      child.stdin.end();
    }
    child.stdout.on("data", (chunk) => {
      stdout += stdoutDecoder.write(chunk);
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += stderrDecoder.write(chunk);
      options.onStderr?.(chunk);
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      settled = true;
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (timer) {
        clearTimeout(timer);
      }
      settled = true;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function resolveProcessInvocation(command, commandArgs) {
  if (/\.(mjs|cjs|js)$/i.test(command)) {
    return {
      command: process.execPath,
      args: [command, ...commandArgs],
      shell: false
    };
  }

  return {
    command,
    args: commandArgs,
    shell: false
  };
}

async function readState() {
  if (!existsSync(statePath)) {
    return { version: 1, agents: {} };
  }
  const text = await readFile(statePath, "utf8");
  const state = JSON.parse(text);
  state.version ??= 1;
  state.agents ??= {};
  return state;
}

async function writeState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function writeRunLog(agentName, startedAt, content) {
  const safeAgentName = agentName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `${stamp}_${safeAgentName}.json`);
  await writeFile(logPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  return logPath;
}

function extractSessionId(payload) {
  return payload.session_id || payload.sessionId || payload.session?.id || null;
}

async function readLogEntries(target) {
  if (!existsSync(logDir)) {
    return [];
  }

  const files = (await readdir(logDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const entries = [];

  for (const file of files) {
    const agent = agentNameFromLogFile(file);
    if (!agentMatchesTarget(agent, target)) {
      continue;
    }

    const logPath = path.join(logDir, file);
    let log;
    try {
      log = JSON.parse(await readFile(logPath, "utf8"));
    } catch {
      continue;
    }

    const payload = parseProviderPayload(log.stdout, isStreamLog(log));
    entries.push({
      file: logPath,
      startedAt: startedAtFromLogFile(file),
      agent,
      cwd: log.cwd || "",
      exitCode: log.exitCode,
      prompt: extractPromptFromArgs(log.args || []),
      result: payload ? extractResult(payload) : (log.stdout || "").trim(),
      stderr: (log.stderr || "").trim(),
      sessionId: payload ? extractSessionId(payload) : null,
      totalCostUsd: payload?.total_cost_usd ?? payload?.totalCostUsd ?? null
    });
  }

  return entries;
}

function agentNameFromLogFile(file) {
  const withoutExt = file.replace(/\.json$/i, "");
  const index = withoutExt.indexOf("_");
  return index === -1 ? withoutExt : withoutExt.slice(index + 1);
}

function startedAtFromLogFile(file) {
  const withoutExt = file.replace(/\.json$/i, "");
  const index = withoutExt.indexOf("_");
  const stamp = index === -1 ? withoutExt : withoutExt.slice(0, index);
  return stamp
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z")
    .replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
}

function agentMatchesTarget(agent, target) {
  return agent === target || agent.startsWith(`${target}-`);
}

function extractPromptFromArgs(commandArgs) {
  const index = commandArgs.findIndex((item) => item === "-p" || item === "--print");
  if (index === -1) {
    return "";
  }
  return commandArgs[index + 1] || "";
}

function parseJsonOrNull(text) {
  if (!text || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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

function isStreamLog(log) {
  if (typeof log.stream === "boolean") {
    return log.stream;
  }
  const outputFormatIndex = (log.args || []).findIndex((arg) => arg === "--output-format");
  return outputFormatIndex !== -1 && log.args[outputFormatIndex + 1] === "stream-json";
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} 必须是正整数。`);
  }
  return parsed;
}

function parseEffort(value) {
  const normalized = String(value).toLowerCase();
  if (!supportedEffortLevels.has(normalized)) {
    throw new Error("--effort 仅支持 low、medium、high、xhigh 或 max。");
  }
  return normalized;
}

function getClaudeOutputArgs(stream) {
  return stream
    ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages", "--forward-subagent-text"]
    : ["--output-format", "json"];
}

function extractResult(payload) {
  if (typeof payload.result === "string") {
    return payload.result;
  }
  if (typeof payload.response === "string") {
    return payload.response;
  }
  if (typeof payload.message?.content === "string") {
    return payload.message.content;
  }
  if (Array.isArray(payload.message?.content)) {
    return payload.message.content
      .map((block) => block?.text)
      .filter(Boolean)
      .join("");
  }
  return null;
}

function maskArgs(commandArgs) {
  return commandArgs.map((item, index) => {
    const previous = commandArgs[index - 1];
    if (previous === "--append-system-prompt" || previous === "--system-prompt") {
      return item;
    }
    return item;
  });
}

function printHelp() {
  console.log(`RunMux - AI coding agent runtime and session multiplexer

用法：
  runmux ask <agent> <prompt> [选项]
  runmux once <agent> <prompt> [选项]
  runmux ask-once <agent> <prompt> [选项]
  runmux smoke [选项]
  runmux repair <agent> <prompt> [选项]
  runmux adversarial <name> <prompt> [选项]
  runmux challenge <name> <prompt> [选项]
  runmux quick-adversarial <name> <prompt> [选项]
  runmux quick-challenge <name> <prompt> [选项]
  runmux diff-review <name> [补充说明] [选项]
  runmux doctor [选项]
  runmux health [选项]
  runmux transcript <agent|prefix> [选项]
  runmux list
  runmux show <agent>
  runmux reset <agent>
  runmux remove <agent>
  runmux --version

常用示例：
  .\\runmux.ps1 ask reviewer "只读分析当前项目结构" --cwd "D:\\code\\project"
  .\\runmux.ps1 ask reviewer "只读分析当前项目结构" --cwd "D:\\code\\project" --runtime wsl
  .\\runmux.ps1 ask reviewer "继续刚才的分析，只看 mapper SQL"
  .\\runmux.ps1 once reviewer "一次性只读分析当前问题" --cwd "D:\\code\\project"
  .\\runmux.ps1 smoke --cwd "D:\\code\\project" --probe-file README.md
  .\\runmux.ps1 repair coder "上次改动导致接口报错，请基于当前 diff 返工"
  .\\runmux.ps1 ask coder "按需求修改代码，并说明改了哪些文件" --cwd "D:\\code\\project" --yolo
  .\\runmux.ps1 adversarial sql-review "对当前改动做对抗验证，重点看 SQL 风险" --cwd "D:\\code\\project"
  .\\runmux.ps1 quick-adversarial sql-review "快速挑错当前改动，重点看 SQL 风险" --cwd "D:\\code\\project"
  .\\runmux.ps1 diff-review review "重点看 SQL 和编码问题" --cwd "D:\\code\\project"
  .\\runmux.ps1 transcript review --last 3
  .\\runmux.ps1 health
  .\\runmux.ps1 list

adversarial 流程：
  自动运行 <name>-proposer、<name>-critic、<name>-judge 三个只读 agent。
  proposer 给结论，critic 专门挑错，judge 汇总裁决。
  adversarial 不支持 --yolo；要改代码请先 ask coder --yolo，再 adversarial 只读验证。

quick-adversarial 流程：
  默认只运行 <name>-critic 一段式快速挑错。
  可加 --role judge 改为 <name>-judge 快速裁决。
  quick-adversarial 不支持 --yolo。

diff-review 流程：
  只读审查当前 git status 和 git diff。
  默认 max-turns 8，重点检查 bug、SQL、编码、Windows 和项目规范问题。

transcript 流程：
  从 logs 读取历史对话，不调用 Claude。
  目标可用 agent 名，也可用 adversarial 的基名匹配 <name>-proposer / critic / judge。

once / ask-once：
  一次性运行，不恢复旧 session，不写入 agents.json，默认不继承旧 agent 的 yolo 或工具配置。

smoke：
  真实调用 Claude 做只读探测，并校验固定输出；不写入 agents.json，只保留运行日志。

repair：
  复用已有 agent session，并把上次运行摘要、当前 git status --short 和 git diff --stat 注入 prompt，用于让持续 coder 返工。

ask 选项：
  --cwd <path>                 首次创建 agent 时绑定工作目录
  --fresh                      不恢复旧 session，重新开始一轮
  --yolo                       开启改代码模式，跳过 Claude Code 权限确认，并对该 agent 持久生效
  --safe                       关闭该 agent 的 yolo 状态，本次回到安全模式
  --mode <mode>                默认 none，不设置 permission-mode
  --max-turns <n>              默认 6
  --tools <list>               默认 Read,Grep,Glob,LS 和只读 Bash 白名单；传 none 可不设置 allowedTools
  --disallowed-tools <list>    追加禁用工具
  --runtime <windows|wsl>       选择 Claude Code 运行位置，默认 windows
  --wsl-user <user>             WSL 用户；不传时自动探测装有 claude 的普通用户
  --wsl-distro <name>           WSL 发行版；不传时使用 wsl.exe 默认发行版
  --wsl-exe <path>              wsl.exe 路径；默认从 PATH 查找
  --wsl-claude <command>        WSL 内 Claude Code 命令，默认 claude
  --mcp-config <path>          指定 MCP 配置
  --system <text>              设置 system prompt
  --append-system <text>       追加 system prompt
  --model <name>               指定 Claude Code 模型
  --effort <level>             指定思考等级：low、medium、high、xhigh 或 max
  --agent <name>               smoke 使用的临时 agent 名，默认 __smoke__
  --probe-file <path>          smoke 检查的工作区文件，默认 README.md
  --role <critic|judge>        quick-adversarial 使用，默认 critic
  --last <n>                   transcript 使用，默认 5
  --timeout-ms <n>             Claude 调用超时时间，默认 120000
  --claude <path>              指定 claude 可执行文件
  --json                       输出完整 JSON
  --stream                     实时透传 Agent 原始 JSONL 事件；不能与 --json 同时使用
`);
}
