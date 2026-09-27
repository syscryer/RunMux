import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoDir = path.dirname(fileURLToPath(import.meta.url));

const root = await mkdtemp(path.join(os.tmpdir(), "runmux-ui-test-"));
const zcodeConfigPath = path.join(root, "zcode", "config.json");
const claudeSettingsPath = path.join(root, "claude", "settings.json");
const dshSettingsPath = path.join(root, "dsh", "settings.yaml");
const statePath = path.join(root, "agents.json");
const logDir = path.join(root, "logs");

process.env.RUNMUX_UI_ZCODE_CONFIG = zcodeConfigPath;
process.env.RUNMUX_UI_CLAUDE_SETTINGS = claudeSettingsPath;
process.env.RUNMUX_UI_DSH_SETTINGS = dshSettingsPath;
process.env.RUNMUX_UI_ZCODE_DB = path.join(root, "missing.sqlite");
process.env.RUNMUX_STATE_PATH = statePath;
process.env.RUNMUX_LOG_DIR = logDir;

const { startUiServer } = await import(pathToFileURL(path.join(repoDir, "ui", "ui-server.mjs")).href);
const { maskSecret, parseDshSettings, zcodeAdapter } = await import(
  pathToFileURL(path.join(repoDir, "ui", "config-adapters.mjs")).href
);

const sampleZcodeConfig = {
  mcp: { servers: { keep: { type: "stdio", command: "x" } } },
  provider: {
    commandcode: {
      kind: "openai-compatible",
      name: "CommandCode",
      options: { apiKey: "user_secret_key_1234567890", baseURL: "https://api.commandcode.ai/provider/v1" },
      models: { "deepseek/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash" } }
    }
  },
  model: { main: "commandcode/deepseek/deepseek-v4.1-flash" }
};

const sampleClaudeSettings = {
  effortLevel: "xhigh",
  env: { ANTHROPIC_AUTH_TOKEN: "token-value", ANTHROPIC_BASE_URL: "https://gw.example/claude" },
  model: "opus[1m]"
};

const sampleDshSettings = [
  "agent-default-model:",
  "  provider: devin",
  "  model: swe-2-max",
  "ui-onboarding:",
  "  welcomeNoticeVersion: 2026-08-13.1",
  "llm-pi-ai:",
  "  providers:",
  "    commandcode:",
  "      apiKeyEnv: COMMANDCODE_API_KEY",
  "      api: openai",
  "      baseURL: https://api.commandcode.ai/provider/v1",
  "      reasoning: high",
  "      models:",
  "        - id: deepseek/deepseek-v4.1-flash",
  "          name: deepseek/deepseek-v4.1-flash",
  "    devin:",
  "      apiKeyEnv: DEVIN_API_KEY",
  "      api: openai",
  "      baseURL: http://localhost:8080/v1",
  "      models:",
  "        - id: swe-2-max",
  "          name: SWE-2 Max",
  "        - id: glm-5-3-max",
  "          name: GLM-5.3 Max",
  ""
].join("\n");

await mkdir(path.dirname(zcodeConfigPath), { recursive: true });
await mkdir(path.dirname(claudeSettingsPath), { recursive: true });
await mkdir(path.dirname(dshSettingsPath), { recursive: true });
await mkdir(logDir, { recursive: true });
await writeFile(zcodeConfigPath, `${JSON.stringify(sampleZcodeConfig, null, 2)}\n`, "utf8");
await writeFile(claudeSettingsPath, `${JSON.stringify(sampleClaudeSettings, null, 2)}\n`, "utf8");
await writeFile(dshSettingsPath, sampleDshSettings, "utf8");
await writeFile(statePath, `${JSON.stringify({
  version: 1,
  agents: {
    reviewer: { name: "reviewer", provider: "zcode", sessionId: "sess-1", yolo: false, updatedAt: "2026-09-15T01:00:00Z" }
  }
}, null, 2)}\n`, "utf8");
await writeFile(path.join(logDir, "2026-09-15T01-00-00-000Z_reviewer.json"), `${JSON.stringify({
  provider: "zcode",
  args: ["--prompt", "只读分析", "--output-format", "json"],
  exitCode: 0,
  stdout: JSON.stringify({ sessionId: "sess-1", response: "RESULT_OK" })
}, null, 2)}\n`, "utf8");

const server = await startUiServer({ port: 0, open: false });
const baseUrl = server.url;

test.after(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

test("maskSecret never exposes the full secret", () => {
  assert.equal(maskSecret(""), null);
  assert.equal(maskSecret(null), null);
  const masked = maskSecret("user_Su7P4RJhp48KTsNXtEpxmz1Rqptu8qaEij4JA1m2");
  assert.match(masked, /^user_S…\(\d+ 字符\)$/);
  assert.equal(masked.includes("RJhp48KTsNX"), false);
});

test("zcode model ref validation rejects unknown providers and models", () => {
  assert.deepEqual(
    zcodeAdapter.resolveModelRef(sampleZcodeConfig, "commandcode/deepseek/deepseek-v4.1-flash"),
    { providerId: "commandcode", modelId: "deepseek/deepseek-v4.1-flash" }
  );
  assert.throws(() => zcodeAdapter.resolveModelRef(sampleZcodeConfig, "nope/model"), /provider 不存在/);
  assert.throws(() => zcodeAdapter.resolveModelRef(sampleZcodeConfig, "commandcode/other"), /不存在模型/);
  assert.throws(() => zcodeAdapter.resolveModelRef(sampleZcodeConfig, "plainref"), /格式/);
});

test("parseDshSettings extracts default model and provider catalogs", () => {
  const parsed = parseDshSettings(sampleDshSettings);
  assert.deepEqual(parsed.agentDefaultModel, { provider: "devin", model: "swe-2-max" });
  const devin = parsed.providers.find((provider) => provider.id === "devin");
  assert.equal(devin.baseURL, "http://localhost:8080/v1");
  assert.deepEqual(devin.models, ["swe-2-max", "glm-5-3-max"]);
  const commandcode = parsed.providers.find((provider) => provider.id === "commandcode");
  assert.equal(commandcode.reasoning, "high");
  assert.deepEqual(commandcode.models, ["deepseek/deepseek-v4.1-flash"]);
});

test("GET /api/providers lists all config adapters", async () => {
  const payload = await (await fetch(`${baseUrl}api/providers`)).json();
  assert.deepEqual(payload.providers.map((provider) => provider.id), ["zcode", "claude", "dsh"]);
  assert.equal(payload.providers.find((provider) => provider.id === "zcode").supportsUpsert, true);
  assert.equal(payload.providers.find((provider) => provider.id === "claude").supportsUpsert, false);
});

test("GET /api/model-config masks zcode keys and reports the current model", async () => {
  const response = await fetch(`${baseUrl}api/model-config?provider=zcode`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.model.main, "commandcode/deepseek/deepseek-v4.1-flash");
  const provider = payload.providers.find((entry) => entry.id === "commandcode");
  assert.equal(provider.apiKeyMasked.includes("user_secret_key_1234567890"), false);
  assert.match(provider.apiKeyMasked, /^user_s…\(\d+ 字符\)$/);
  assert.equal(provider.models.includes("deepseek/deepseek-v4.1-flash"), true);
});

test("POST /api/model rejects requests without the page token", async () => {
  const response = await fetch(`${baseUrl}api/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "zcode", model: "commandcode/deepseek/deepseek-v4.1-flash" })
  });
  assert.equal(response.status, 403);
});

test("requests with a disallowed Host header are rejected", async () => {
  const status = await new Promise((resolve, reject) => {
    const request = http.request(
      new URL("api/providers", baseUrl),
      { headers: { host: "evil.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      }
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 403);
});

test("switching the zcode model preserves unrelated config and creates a backup", async () => {
  const response = await fetch(`${baseUrl}api/model`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runmux-token": server.token },
    body: JSON.stringify({ provider: "zcode", model: "commandcode/deepseek/deepseek-v4.1-flash" })
  });
  assert.equal(response.status, 200);

  const saved = JSON.parse(await readFile(zcodeConfigPath, "utf8"));
  assert.equal(saved.model.main, "commandcode/deepseek/deepseek-v4.1-flash");
  assert.deepEqual(saved.mcp.servers.keep, { type: "stdio", command: "x" });
  const backups = (await readdir(path.dirname(zcodeConfigPath))).filter((file) => file.includes(".bak-ui-"));
  assert.equal(backups.length >= 1, true);
});

test("switching to an invalid zcode model ref fails without writing", async () => {
  const before = await readFile(zcodeConfigPath, "utf8");
  const response = await fetch(`${baseUrl}api/model`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runmux-token": server.token },
    body: JSON.stringify({ provider: "zcode", model: "commandcode/missing" })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /不存在模型/);
  assert.equal(await readFile(zcodeConfigPath, "utf8"), before);
});

test("adding a zcode provider updates the catalog and can set the main model", async () => {
  const response = await fetch(`${baseUrl}api/provider`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runmux-token": server.token },
    body: JSON.stringify({
      provider: "zcode",
      id: "newapi",
      kind: "openai-compatible",
      baseURL: "https://api.new.example/v1",
      apiKey: "sk-new-123456",
      models: "m-a\nm-b",
      setMain: true
    })
  });
  assert.equal(response.status, 200);
  const saved = JSON.parse(await readFile(zcodeConfigPath, "utf8"));
  assert.equal(saved.provider.newapi.kind, "openai-compatible");
  assert.equal(saved.provider.newapi.options.apiKey, "sk-new-123456");
  assert.deepEqual(Object.keys(saved.provider.newapi.models), ["m-a", "m-b"]);
  assert.equal(saved.model.main, "newapi/m-a");
});

test("updating a zcode provider without a new key keeps the old one", async () => {
  const response = await fetch(`${baseUrl}api/provider`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runmux-token": server.token },
    body: JSON.stringify({
      provider: "zcode",
      id: "newapi",
      kind: "openai-compatible",
      baseURL: "https://api.new.example/v2",
      apiKey: "",
      models: "m-a"
    })
  });
  assert.equal(response.status, 200);
  const saved = JSON.parse(await readFile(zcodeConfigPath, "utf8"));
  assert.equal(saved.provider.newapi.options.apiKey, "sk-new-123456");
  assert.equal(saved.provider.newapi.options.baseURL, "https://api.new.example/v2");
});

test("provider upsert validation rejects bad kinds, urls, ids, and empty models", async () => {
  for (const override of [
    { kind: "gemini" },
    { baseURL: "ftp://x" },
    { id: "bad/id" },
    { models: "  " }
  ]) {
    const response = await fetch(`${baseUrl}api/provider`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-runmux-token": server.token },
      body: JSON.stringify({
        provider: "zcode",
        id: "validid",
        kind: "openai-compatible",
        baseURL: "https://ok.example/v1",
        apiKey: "sk-x",
        models: "m",
        ...override
      })
    });
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(override)}`);
  }
});

test("claude settings expose model and effort without leaking tokens", async () => {
  const payload = await (await fetch(`${baseUrl}api/model-config?provider=claude`)).json();
  assert.equal(payload.model.main, "opus[1m]");
  assert.equal(payload.effortLevel, "xhigh");
  assert.equal(payload.baseURL, "https://gw.example/claude");
  assert.equal(payload.authConfigured, true);
  assert.equal(JSON.stringify(payload).includes("token-value"), false);
});

test("switching the claude model preserves env and supports reset", async () => {
  const switchResponse = await fetch(`${baseUrl}api/model`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runmux-token": server.token },
    body: JSON.stringify({ provider: "claude", model: "sonnet[1m]" })
  });
  assert.equal(switchResponse.status, 200);
  let saved = JSON.parse(await readFile(claudeSettingsPath, "utf8"));
  assert.equal(saved.model, "sonnet[1m]");
  assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, "token-value");

  const resetResponse = await fetch(`${baseUrl}api/model`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runmux-token": server.token },
    body: JSON.stringify({ provider: "claude", model: "default" })
  });
  assert.equal(resetResponse.status, 200);
  saved = JSON.parse(await readFile(claudeSettingsPath, "utf8"));
  assert.equal("model" in saved, false);
});

test("claude rejects model names with unexpected characters", async () => {
  const response = await fetch(`${baseUrl}api/model`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runmux-token": server.token },
    body: JSON.stringify({ provider: "claude", model: "bad model!" })
  });
  assert.equal(response.status, 400);
});

test("claude does not accept provider upserts", async () => {
  const response = await fetch(`${baseUrl}api/provider`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runmux-token": server.token },
    body: JSON.stringify({ provider: "claude", id: "x", kind: "openai", baseURL: "https://x", apiKey: "k", models: ["m"] })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /不支持在此新增/);
});

test("dsh settings expose the default model and the provider catalog", async () => {
  const payload = await (await fetch(`${baseUrl}api/model-config?provider=dsh`)).json();
  assert.equal(payload.model.main, "devin/swe-2-max");
  const devin = payload.providers.find((entry) => entry.id === "devin");
  assert.deepEqual(devin.models, ["swe-2-max", "glm-5-3-max"]);
});

test("switching the dsh default model only rewrites the target lines", async () => {
  const response = await fetch(`${baseUrl}api/model`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runmux-token": server.token },
    body: JSON.stringify({ provider: "dsh", model: "devin/glm-5-3-max" })
  });
  assert.equal(response.status, 200);
  const text = await readFile(dshSettingsPath, "utf8");
  assert.match(text, /provider: devin/);
  assert.match(text, /model: glm-5-3-max/);
  assert.doesNotMatch(text, /model: swe-2-max\n/);
  assert.match(text, /welcomeNoticeVersion: 2026-08-13\.1/);
  assert.match(text, /baseURL: https:\/\/api\.commandcode\.ai\/provider\/v1/);

  const parsed = parseDshSettings(text);
  assert.deepEqual(parsed.agentDefaultModel, { provider: "devin", model: "glm-5-3-max" });
  assert.equal(parsed.providers.length, 2);
});

test("dsh rejects unknown provider or model refs", async () => {
  for (const ref of ["nobody/model", "devin/nope"]) {
    const response = await fetch(`${baseUrl}api/model`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-runmux-token": server.token },
      body: JSON.stringify({ provider: "dsh", model: ref })
    });
    assert.equal(response.status, 400, ref);
  }
});

test("unknown config providers are rejected", async () => {
  const response = await fetch(`${baseUrl}api/model-config?provider=kimi`);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /不支持的 provider/);
});

test("agents endpoint returns stored named agents", async () => {
  const payload = await (await fetch(`${baseUrl}api/agents`)).json();
  assert.equal(payload.agents.length, 1);
  assert.equal(payload.agents[0].name, "reviewer");
  assert.equal(payload.agents[0].provider, "zcode");
});

test("logs endpoint parses prompts and results from run logs", async () => {
  const response = await fetch(`${baseUrl}api/logs?agent=reviewer&limit=5`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.entries.length, 1);
  const entry = payload.entries[0];
  assert.equal(entry.prompt, "只读分析");
  assert.equal(entry.result, "RESULT_OK");
  assert.equal(entry.sessionId, "sess-1");
});

test("logs endpoint rejects malformed agent names", async () => {
  const response = await fetch(`${baseUrl}api/logs?agent=${encodeURIComponent("..%2Fevil")}`);
  assert.equal(response.status, 400);
});

test("the ui page is served as html", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  assert.match(html, /RunMux 控制台/);
  assert.equal(existsSync(path.join(repoDir, "ui", "ui.html")), true);
});
