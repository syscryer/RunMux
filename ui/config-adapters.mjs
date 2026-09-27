import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const homeDir = process.env.USERPROFILE || process.env.HOME || "";

const supportedProviderKinds = new Set(["anthropic", "openai", "openai-compatible"]);
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const claudeModelPattern = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]*$/;

export function maskSecret(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  return `${value.slice(0, 6)}…(${value.length} 字符)`;
}

export class ConfigInputError extends Error {}

async function readJsonOrNull(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeWithBackup(filePath, text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    await copyFile(filePath, `${filePath}.bak-ui-${stamp}`);
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temporaryPath, text, "utf8");
  await rename(temporaryPath, filePath);
}

export const zcodeAdapter = {
  id: "zcode",
  label: "zcode",
  description: "zcode-app-cli 的用户配置，含自定义 provider 与默认模型。",
  supportsUpsert: true,
  configPath: process.env.RUNMUX_UI_ZCODE_CONFIG
    || (homeDir ? path.join(homeDir, ".zcode", "cli", "config.json") : ""),
  dbPath: process.env.RUNMUX_UI_ZCODE_DB
    || (homeDir ? path.join(homeDir, ".zcode", "cli", "db", "db.sqlite") : ""),

  async read() {
    const config = await readJsonOrNull(this.configPath);
    const providers = [];
    for (const [id, definition] of Object.entries(config?.provider ?? {})) {
      providers.push({
        id,
        name: definition?.name ?? id,
        kind: definition?.kind ?? null,
        baseURL: definition?.options?.baseURL ?? null,
        apiKeyMasked: maskSecret(definition?.options?.apiKey),
        apiKeySet: Boolean(definition?.options?.apiKey),
        models: Object.keys(definition?.models ?? {}).sort()
      });
    }
    providers.sort((a, b) => a.id.localeCompare(b.id));
    return {
      configPath: this.configPath || null,
      exists: Boolean(config),
      model: { main: config?.model?.main ?? null },
      providers,
      reasoningLevel: await readZcodeReasoningLevel(this.dbPath)
    };
  },

  resolveModelRef(config, ref) {
    const value = String(ref ?? "").trim();
    const separator = value.indexOf("/");
    if (separator <= 0 || separator === value.length - 1) {
      throw new ConfigInputError("模型引用格式必须是 provider/model，例如 commandcode/deepseek/deepseek-v4.1-flash。");
    }
    const providerId = value.slice(0, separator);
    const modelId = value.slice(separator + 1);
    const provider = config?.provider?.[providerId];
    if (!provider) {
      throw new ConfigInputError(`provider 不存在：${providerId}`);
    }
    if (!provider.models || !(modelId in provider.models)) {
      throw new ConfigInputError(`provider ${providerId} 下不存在模型：${modelId}`);
    }
    return { providerId, modelId };
  },

  async setModel(ref) {
    const config = (await readJsonOrNull(this.configPath)) ?? {};
    const { providerId, modelId } = this.resolveModelRef(config, ref);
    config.model = { ...(config.model ?? {}), main: `${providerId}/${modelId}` };
    await writeWithBackup(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
    return `${providerId}/${modelId}`;
  },

  async upsertProvider(input) {
    const id = String(input?.id ?? "").trim();
    if (!providerIdPattern.test(id)) {
      throw new ConfigInputError("provider id 只能包含字母、数字、点、下划线、连字符，且不能包含 /。");
    }
    const kind = String(input?.kind ?? "").trim();
    if (!supportedProviderKinds.has(kind)) {
      throw new ConfigInputError("kind 仅支持 anthropic、openai 或 openai-compatible。");
    }
    const baseURL = String(input?.baseURL ?? "").trim();
    if (!/^https?:\/\//i.test(baseURL)) {
      throw new ConfigInputError("baseURL 必须以 http:// 或 https:// 开头。");
    }
    const apiKey = String(input?.apiKey ?? "").trim();
    const config = (await readJsonOrNull(this.configPath)) ?? {};
    const existing = config.provider?.[id];
    const effectiveApiKey = apiKey || existing?.options?.apiKey;
    if (!effectiveApiKey) {
      throw new ConfigInputError("apiKey 不能为空（更新已有 provider 时留空表示保留原值）。");
    }
    const rawModels = Array.isArray(input?.models)
      ? input.models
      : String(input?.models ?? "").split(/[\r\n,]/);
    const models = rawModels.map((model) => String(model).trim()).filter(Boolean);
    if (!models.length) {
      throw new ConfigInputError("至少提供一个模型 id。");
    }

    config.provider = config.provider ?? {};
    const options = { ...(existing?.options ?? {}), apiKey: effectiveApiKey, baseURL };
    config.provider[id] = {
      ...existing,
      kind,
      name: String(input?.name ?? "").trim() || existing?.name || id,
      options,
      models: {
        ...(existing?.models ?? {}),
        ...Object.fromEntries(models.map((model) => [model, existing?.models?.[model] ?? { name: model }]))
      }
    };
    if (input?.setMain) {
      config.model = { ...(config.model ?? {}), main: `${id}/${models[0]}` };
    }
    await writeWithBackup(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
    return id;
  }
};

export const claudeAdapter = {
  id: "claude",
  label: "Claude Code",
  description: "Claude Code 的用户级 settings.json，默认模型与思考等级。",
  supportsUpsert: false,
  modelSuggestions: ["opus", "sonnet", "haiku", "opus[1m]", "sonnet[1m]", "default"],
  configPath: process.env.RUNMUX_UI_CLAUDE_SETTINGS
    || (homeDir ? path.join(homeDir, ".claude", "settings.json") : ""),

  async read() {
    const settings = await readJsonOrNull(this.configPath);
    const baseURL = settings?.env?.ANTHROPIC_BASE_URL;
    return {
      configPath: this.configPath || null,
      exists: Boolean(settings),
      model: { main: settings?.model ?? null },
      effortLevel: settings?.effortLevel ?? null,
      baseURL: baseURL ?? null,
      authConfigured: Boolean(settings?.env?.ANTHROPIC_AUTH_TOKEN || settings?.env?.ANTHROPIC_API_KEY),
      providers: []
    };
  },

  async setModel(ref) {
    const value = String(ref ?? "").trim();
    if (value && value !== "default" && !claudeModelPattern.test(value)) {
      throw new ConfigInputError("Claude Code 模型名只能包含字母、数字、点、下划线、连字符和 []。");
    }
    const settings = (await readJsonOrNull(this.configPath)) ?? {};
    if (!value || value === "default") {
      delete settings.model;
    } else {
      settings.model = value;
    }
    const ordered = Object.fromEntries(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)));
    await writeWithBackup(this.configPath, `${JSON.stringify(ordered, null, 2)}\n`);
    return value || "default";
  }
};

export const dshAdapter = {
  id: "dsh",
  label: "DeepSeek DSH",
  description: "DSH 的 settings.yaml，默认模型与 llm-pi-ai provider 模型表。",
  supportsUpsert: false,
  configPath: process.env.RUNMUX_UI_DSH_SETTINGS
    || (homeDir ? path.join(homeDir, ".dsh", "settings.yaml") : ""),

  async read() {
    if (!this.configPath || !existsSync(this.configPath)) {
      return { configPath: this.configPath || null, exists: false, model: { main: null }, providers: [] };
    }
    const text = await readFile(this.configPath, "utf8");
    const parsed = parseDshSettings(text);
    return {
      configPath: this.configPath,
      exists: true,
      model: parsed.agentDefaultModel ? { main: `${parsed.agentDefaultModel.provider}/${parsed.agentDefaultModel.model}` } : { main: null },
      providers: parsed.providers
    };
  },

  async setModel(ref) {
    const value = String(ref ?? "").trim();
    const separator = value.indexOf("/");
    if (separator <= 0 || separator === value.length - 1) {
      throw new ConfigInputError("模型引用格式必须是 provider/model，例如 devin/swe-2-max。");
    }
    const providerId = value.slice(0, separator);
    const modelId = value.slice(separator + 1);
    if (!this.configPath || !existsSync(this.configPath)) {
      throw new ConfigInputError("未找到 DSH settings.yaml。");
    }
    const text = await readFile(this.configPath, "utf8");
    const parsed = parseDshSettings(text);
    const provider = parsed.providers.find((entry) => entry.id === providerId);
    if (!provider) {
      throw new ConfigInputError(`provider 不存在：${providerId}`);
    }
    if (!provider.models.includes(modelId)) {
      throw new ConfigInputError(`provider ${providerId} 下不存在模型：${modelId}`);
    }
    const updated = replaceDshAgentDefaultModel(text, providerId, modelId);
    if (!updated) {
      throw new ConfigInputError("无法定位 agent-default-model 配置块，已取消写入。");
    }
    // DSH 配置以 LF 写回；换行风格对 YAML 语义无影响。
    await writeWithBackup(this.configPath, updated);
    return `${providerId}/${modelId}`;
  }
};

async function readZcodeReasoningLevel(dbPath) {
  try {
    if (!dbPath || !existsSync(dbPath)) {
      return null;
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "select value from local_setting where scope = ? and scope_id = ? and namespace = ? and key = ?"
        )
        .get("user", "default", "model", "reasoningLevel");
      const parsed = row ? JSON.parse(row.value) : null;
      return typeof parsed?.level === "string" ? parsed.level : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function parseDshSettings(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const result = { agentDefaultModel: null, providers: [] };

  let index = lines.findIndex((line) => /^agent-default-model:\s*(#.*)?$/m.test(line));
  if (index >= 0) {
    const block = {};
    for (let i = index + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/^[ \t]/.test(line)) {
        break;
      }
      const providerMatch = line.match(/^[ \t]+provider:[ \t]*(.+?)[ \t]*(?:#.*)?$/);
      const modelMatch = line.match(/^[ \t]+model:[ \t]*(.+?)[ \t]*(?:#.*)?$/);
      if (providerMatch) {
        block.provider = unquote(providerMatch[1]);
      }
      if (modelMatch) {
        block.model = unquote(modelMatch[1]);
      }
    }
    if (block.provider && block.model) {
      result.agentDefaultModel = block;
    }
  }

  index = lines.findIndex((line) => /^[ \t]*providers:[ \t]*$/.test(line));
  if (index >= 0) {
    const providerIndent = indentOf(lines[index]);
    let current = null;
    for (let i = index + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*$/.test(line)) {
        continue;
      }
      const lineIndent = indentOf(line);
      if (lineIndent <= providerIndent) {
        break;
      }
      const idMatch = line.match(/^[ \t]+([A-Za-z0-9][A-Za-z0-9._-]*):[ \t]*(?:#.*)?$/);
      if (idMatch && lineIndent === providerIndent + 2) {
        current = { id: idMatch[1], baseURL: null, reasoning: null, apiKeyEnv: null, models: [] };
        result.providers.push(current);
        continue;
      }
      if (!current) {
        continue;
      }
      const baseURLMatch = line.match(/^[ \t]+baseURL:[ \t]*(.+?)[ \t]*(?:#.*)?$/);
      if (baseURLMatch) {
        current.baseURL = unquote(baseURLMatch[1]);
      }
      const apiKeyEnvMatch = line.match(/^[ \t]+apiKeyEnv:[ \t]*(.+?)[ \t]*(?:#.*)?$/);
      if (apiKeyEnvMatch) {
        current.apiKeyEnv = unquote(apiKeyEnvMatch[1]);
      }
      const reasoningMatch = line.match(/^[ \t]+reasoning:[ \t]*(.+?)[ \t]*(?:#.*)?$/);
      if (reasoningMatch) {
        current.reasoning = unquote(reasoningMatch[1]);
      }
      const modelMatch = line.match(/^[ \t]+-[ \t]+id:[ \t]*['"]?([^'"\s#]+)['"]?/);
      if (modelMatch) {
        current.models.push(modelMatch[1]);
      }
    }
  }

  return result;
}

function replaceDshAgentDefaultModel(text, providerId, modelId) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex((line) => /^agent-default-model:\s*(#.*)?$/m.test(line));
  if (index < 0) {
    return null;
  }
  let replacedProvider = false;
  let replacedModel = false;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^[ \t]/.test(line)) {
      break;
    }
    if (!replacedProvider && /^[ \t]+provider:/.test(line)) {
      lines[i] = line.replace(/^(.*?provider:[ \t]*).+?([ \t]*(?:#.*)?)$/, `$1${providerId}$2`);
      replacedProvider = true;
    } else if (!replacedModel && /^[ \t]+model:/.test(line)) {
      lines[i] = line.replace(/^(.*?model:[ \t]*).+?([ \t]*(?:#.*)?)$/, `$1${modelId}$2`);
      replacedModel = true;
    }
  }
  if (!replacedProvider || !replacedModel) {
    return null;
  }
  return lines.join("\n");
}

function indentOf(line) {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

function unquote(value) {
  const trimmed = String(value ?? "").trim();
  if (/^'.*'$/.test(trimmed) || /^".*"$/.test(trimmed)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export const configAdapters = [zcodeAdapter, claudeAdapter, dshAdapter];

export function findConfigAdapter(providerId) {
  const adapter = configAdapters.find((entry) => entry.id === providerId);
  if (!adapter) {
    throw new ConfigInputError(`不支持的 provider：${providerId}。当前支持 ${configAdapters.map((entry) => entry.id).join("、")}。`);
  }
  return adapter;
}
