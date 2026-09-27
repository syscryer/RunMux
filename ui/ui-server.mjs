import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ConfigInputError, configAdapters, findConfigAdapter } from "./config-adapters.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiHtmlPath = path.join(__dirname, "ui.html");

const homeDir = process.env.USERPROFILE || process.env.HOME || "";
const runMuxHome = process.env.RUNMUX_HOME || (homeDir ? path.join(homeDir, ".runmux") : "");
const statePath = process.env.RUNMUX_STATE_PATH || path.join(runMuxHome, "agents.json");
const logDir = process.env.RUNMUX_LOG_DIR || path.join(runMuxHome, "logs");

const agentNamePattern = /^[A-Za-z0-9._-]+$/;
const maxBodyBytes = 1024 * 1024;
const defaultUiPort = 8788;
const listenAttempts = 6;

export async function startUiServer(options = {}) {
  const port = options.port ?? defaultUiPort;
  const token = randomBytes(16).toString("hex");
  const server = createServer((req, res) => {
    handleRequest(req, res, token).catch((error) => {
      sendJson(res, 500, { error: error?.message || String(error) });
    });
  });

  const actualPort = await new Promise((resolve, reject) => {
    const tryListen = (attempt) => {
      server.once("error", (error) => {
        if (error?.code === "EADDRINUSE" && attempt < listenAttempts) {
          tryListen(attempt + 1);
        } else {
          reject(error);
        }
      });
      server.listen(port === 0 ? 0 : port + attempt, "127.0.0.1", () => {
        resolve(server.address().port);
      });
    };
    tryListen(0);
  });

  const url = `http://127.0.0.1:${actualPort}/`;
  if (options.open !== false) {
    openBrowser(url);
  }
  return {
    url,
    port: actualPort,
    token,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function handleRequest(req, res, token) {
  if (!isAllowedHost(req)) {
    return sendJson(res, 403, { error: "拒绝访问：Host 头不允许。" });
  }

  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/") {
    return sendHtml(res);
  }
  if (req.method === "GET" && url.pathname === "/api/token") {
    return sendJson(res, 200, { token });
  }
  if (req.method === "GET" && url.pathname === "/api/providers") {
    return sendJson(res, 200, {
      providers: configAdapters.map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        description: adapter.description,
        supportsUpsert: adapter.supportsUpsert,
        modelSuggestions: adapter.modelSuggestions ?? null
      }))
    });
  }
  if (req.method === "GET" && url.pathname === "/api/agents") {
    return sendJson(res, 200, await agentsPayload());
  }
  if (req.method === "GET" && url.pathname === "/api/logs") {
    const agent = String(url.searchParams.get("agent") || "").trim();
    if (!agentNamePattern.test(agent)) {
      return sendJson(res, 400, { error: "agent 名称非法。" });
    }
    const limit = clampInteger(url.searchParams.get("limit"), 1, 20, 5);
    return sendJson(res, 200, { agent, entries: await readLogEntries(agent, limit) });
  }
  if (req.method === "GET" && url.pathname === "/api/model-config") {
    try {
      const adapter = findConfigAdapter(String(url.searchParams.get("provider") || ""));
      return sendJson(res, 200, {
        provider: adapter.id,
        label: adapter.label,
        supportsUpsert: adapter.supportsUpsert,
        modelSuggestions: adapter.modelSuggestions ?? null,
        ...(await adapter.read())
      });
    } catch (error) {
      return sendInputError(res, error);
    }
  }

  if (req.method === "POST" && (url.pathname === "/api/model" || url.pathname === "/api/provider")) {
    if (req.headers["x-runmux-token"] !== token) {
      return sendJson(res, 403, { error: "令牌校验失败，请刷新页面后重试。" });
    }
    try {
      const body = await readJsonBody(req);
      const adapter = findConfigAdapter(String(body?.provider || ""));
      if (url.pathname === "/api/model") {
        await adapter.setModel(body.model);
      } else {
        if (!adapter.supportsUpsert) {
          return sendJson(res, 400, { error: `provider ${adapter.id} 不支持在此新增模型来源。` });
        }
        await adapter.upsertProvider(body);
      }
      return sendJson(res, 200, {
        provider: adapter.id,
        label: adapter.label,
        supportsUpsert: adapter.supportsUpsert,
        modelSuggestions: adapter.modelSuggestions ?? null,
        ...(await adapter.read())
      });
    } catch (error) {
      return sendInputError(res, error);
    }
  }

  return sendJson(res, 404, { error: "未找到。" });
}

function sendInputError(res, error) {
  if (error instanceof ConfigInputError) {
    return sendJson(res, 400, { error: error.message });
  }
  throw error;
}

function isAllowedHost(req) {
  const host = String(req.headers.host || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || /^localhost:\d+$/.test(host) || /^127\.0\.0\.1:\d+$/.test(host);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("请求体过大。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体必须是 JSON。"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function sendHtml(res) {
  let html;
  try {
    html = await readFile(uiHtmlPath, "utf8");
  } catch {
    sendJson(res, 500, { error: `页面文件不存在：${uiHtmlPath}` });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
}

async function agentsPayload() {
  let agents = [];
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    agents = Object.values(state.agents ?? {});
  } catch {
    agents = [];
  }
  agents.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return { statePath, agents };
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

function parseProviderPayload(text, stream) {
  if (!stream) {
    return parseJsonOrNull(text);
  }
  const payloads = String(text || "")
    .split(/\r?\n/)
    .map(parseJsonOrNull)
    .filter(Boolean);
  return payloads.findLast((payload) => payload.type === "result") || null;
}

function extractResult(payload) {
  if (typeof payload?.result === "string") {
    return payload.result;
  }
  if (typeof payload?.response === "string") {
    return payload.response;
  }
  return null;
}

function extractSessionId(payload) {
  return payload?.session_id || payload?.sessionId || null;
}

function extractPromptFromArgs(commandArgs) {
  const index = commandArgs.findIndex((item) => item === "-p" || item === "--print" || item === "--prompt");
  if (index === -1) {
    return "";
  }
  return commandArgs[index + 1] || "";
}

function isStreamLog(log) {
  if (typeof log.stream === "boolean") {
    return log.stream;
  }
  const outputFormatIndex = (log.args || []).findIndex((arg) => arg === "--output-format");
  return outputFormatIndex !== -1 && log.args[outputFormatIndex + 1] === "stream-json";
}

function startedAtFromLogFile(file) {
  const withoutExt = file.replace(/\.json$/i, "");
  const index = withoutExt.indexOf("_");
  const stamp = index === -1 ? withoutExt : withoutExt.slice(0, index);
  return stamp
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z")
    .replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
}

async function readLogEntries(agent, limit) {
  if (!existsSync(logDir)) {
    return [];
  }
  const files = (await readdir(logDir))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .slice(-200);
  const entries = [];
  for (const file of files) {
    const withoutExt = file.replace(/\.json$/i, "");
    const index = withoutExt.indexOf("_");
    const agentName = index === -1 ? withoutExt : withoutExt.slice(index + 1);
    if (agentName !== agent && !agentName.startsWith(`${agent}-`)) {
      continue;
    }
    let log;
    try {
      log = JSON.parse(await readFile(path.join(logDir, file), "utf8"));
    } catch {
      continue;
    }
    const payload = parseProviderPayload(log.stdout, isStreamLog(log));
    entries.push({
      file: path.join(logDir, file),
      startedAt: startedAtFromLogFile(file),
      agent: agentName,
      provider: log.provider ?? null,
      exitCode: log.exitCode,
      prompt: extractPromptFromArgs(log.args || []),
      result: payload ? extractResult(payload) : String(log.stdout || "").trim().slice(0, 500),
      sessionId: payload ? extractSessionId(payload) : null
    });
  }
  return entries.slice(-limit);
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // 打开浏览器失败不影响服务本身。
  }
}
