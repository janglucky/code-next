#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createOpenAIClient, resolveProviderConfig, type ProviderInput } from "../config/provider.js";
import { loadEnvFile } from "../config/env.js";
import { ReactCodeAgent } from "../core/react-code-agent.js";
import type { AgentStepEvent, JsonObject } from "../core/types.js";
import { createDefaultTools } from "../tools/workspace-tools.js";

type RunRequest = ProviderInput & {
  task?: unknown;
  maxSteps?: unknown;
  workspaceRoot?: unknown;
};

type WebSettings = {
  workspaceRoot: string;
  workspaceRootConfigured: boolean;
};

type WebState = {
  conversations: unknown[];
  settings: WebSettings;
};

const DEFAULT_PORT = 3100;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const STATIC_ROOT = path.resolve(process.cwd(), "src/web");
const STATE_DIR = path.resolve(process.cwd(), ".code-agent");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const execFileAsync = promisify(execFile);

export type WebServerStartOptions = {
  host?: string;
  loadEnv?: boolean;
  port?: number;
};

export type StartedWebServer = {
  close: () => Promise<void>;
  port: number;
  url: string;
};

function readMaxSteps(value?: unknown): number {
  const raw = value ?? process.env.AGENT_MAX_STEPS;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 8;
}

function readPort(): number {
  const parsed = Number(process.env.WEB_PORT ?? process.env.PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function isLocalRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return !address || address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function defaultState(): WebState {
  return {
    conversations: [],
    settings: {
      workspaceRoot: process.cwd(),
      workspaceRootConfigured: false,
    },
  };
}

function normalizeState(value: unknown): WebState {
  const fallback = defaultState();

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fallback;
  }

  const candidate = value as Record<string, unknown>;
  const settings = typeof candidate.settings === "object" && candidate.settings !== null ? candidate.settings : {};
  const workspaceRootConfigured = (settings as Record<string, unknown>).workspaceRootConfigured === true;
  const workspaceRoot =
    workspaceRootConfigured &&
    typeof (settings as Record<string, unknown>).workspaceRoot === "string" &&
    ((settings as Record<string, unknown>).workspaceRoot as string).trim()
      ? path.resolve(process.cwd(), ((settings as Record<string, unknown>).workspaceRoot as string).trim())
      : fallback.settings.workspaceRoot;

  return {
    conversations: Array.isArray(candidate.conversations) ? candidate.conversations : [],
    settings: {
      workspaceRoot,
      workspaceRootConfigured,
    },
  };
}

async function readState(): Promise<WebState> {
  try {
    const content = await fs.readFile(STATE_FILE, "utf8");
    return normalizeState(JSON.parse(content) as unknown);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";

    if (code === "ENOENT") {
      return defaultState();
    }

    throw error;
  }
}

async function writeState(state: WebState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
}

async function resolveWorkspaceRoot(input: unknown): Promise<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("Workspace path is required.");
  }

  const workspaceRoot = path.resolve(process.cwd(), input.trim());
  const stat = await fs.stat(workspaceRoot);

  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${workspaceRoot}`);
  }

  return workspaceRoot;
}

async function resolveInitialDirectory(input: unknown): Promise<string> {
  if (typeof input !== "string" || !input.trim()) {
    return process.cwd();
  }

  const resolved = path.resolve(process.cwd(), input.trim());

  try {
    const stat = await fs.stat(resolved);
    return stat.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return process.cwd();
  }
}

async function commandExists(command: string): Promise<boolean> {
  const lookup = process.platform === "win32" ? "where" : "which";

  try {
    await execFileAsync(lookup, [command]);
    return true;
  } catch {
    return false;
  }
}

async function runDirectoryPicker(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      windowsHide: true,
    });
    const selectedPath = stdout.trim();
    return selectedPath ? path.resolve(selectedPath) : null;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? Number(error.code) : 1;
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "").trim() : "";

    if (code === 1 && !stderr) {
      return null;
    }

    throw new Error(stderr || formatError(error));
  }
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

async function selectDirectoryWithSystemDialog(initialPath: string): Promise<string | null> {
  if (process.platform === "darwin") {
    const escapedPath = escapeAppleScriptString(initialPath);
    const script = `POSIX path of (choose folder with prompt "选择工作空间目录" default location POSIX file "${escapedPath}")`;
    return await runDirectoryPicker("osascript", ["-e", script]);
  }

  if (process.platform === "win32") {
    const escapedPath = escapePowerShellString(initialPath);
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '选择工作空间目录'",
      `$dialog.SelectedPath = '${escapedPath}'`,
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
    ].join("; ");
    return await runDirectoryPicker("powershell.exe", ["-NoProfile", "-STA", "-Command", script]);
  }

  const initialWithSeparator = initialPath.endsWith(path.sep) ? initialPath : `${initialPath}${path.sep}`;
  const candidates: Array<{ command: string; args: string[] }> = [
    {
      command: "zenity",
      args: ["--file-selection", "--directory", "--title=选择工作空间目录", `--filename=${initialWithSeparator}`],
    },
    {
      command: "kdialog",
      args: ["--getexistingdirectory", initialPath, "选择工作空间目录"],
    },
    {
      command: "yad",
      args: ["--file-selection", "--directory", "--title=选择工作空间目录", `--filename=${initialWithSeparator}`],
    },
  ];

  for (const candidate of candidates) {
    if (await commandExists(candidate.command)) {
      return await runDirectoryPicker(candidate.command, candidate.args);
    }
  }

  throw new Error("当前系统未找到可用的目录选择器。Linux 请安装 zenity、kdialog 或 yad，或手动输入目录路径。");
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  if (name === "APIConnectionTimeoutError" || message.toLowerCase().includes("timed out")) {
    return `${message}

The model request timed out. Try increasing AGENT_REQUEST_TIMEOUT_MS or AGENT_MAX_RETRIES.`;
  }

  return message;
}

function sendJson(res: ServerResponse, statusCode: number, payload: JsonObject) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function writeEvent(res: ServerResponse, payload: JsonObject) {
  res.write(`${JSON.stringify(payload)}\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;

    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  const raw = await readBody(req);

  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }

  return parsed as JsonObject;
}

function buildProviderInput(body: RunRequest): ProviderInput {
  return {
    apiMode: body.apiMode,
    apiKey: body.apiKey,
    baseURL: body.baseURL,
    maxRetries: body.maxRetries,
    model: body.model,
    provider: body.provider,
    proxyUrl: body.proxyUrl,
    reasoningEffort: body.reasoningEffort,
    requestTimeoutMs: body.requestTimeoutMs,
  };
}

function serializeStep(event: AgentStepEvent): JsonObject {
  if (event.type === "model") {
    return {
      type: "model",
      step: event.step,
      thought: event.decision.thought,
      action: event.decision.action,
    };
  }

  return {
    type: "tool",
    step: event.step,
    tool: event.tool,
    ok: event.result.ok,
    output: event.result.output,
  };
}

async function handleRun(req: IncomingMessage, res: ServerResponse) {
  let body: RunRequest;

  try {
    body = (await readJsonBody(req)) as RunRequest;
  } catch (error) {
    sendJson(res, 400, { ok: false, error: formatError(error) });
    return;
  }

  const task = typeof body.task === "string" ? body.task.trim() : "";

  if (!task) {
    sendJson(res, 400, { ok: false, error: "Task is required." });
    return;
  }

  try {
    const state = await readState();
    const requestedWorkspaceRoot =
      typeof body.workspaceRoot === "string" && body.workspaceRoot.trim() ? body.workspaceRoot : state.settings.workspaceRoot;
    const workspaceRoot = await resolveWorkspaceRoot(requestedWorkspaceRoot);
    let currentWorkspaceRoot = workspaceRoot;
    const providerConfig = resolveProviderConfig(buildProviderInput(body), process.env);
    const maxSteps = readMaxSteps(body.maxSteps);
    let closed = false;

    req.on("close", () => {
      closed = true;
    });

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    writeEvent(res, {
      type: "config",
      provider: providerConfig.provider,
      apiMode: providerConfig.apiMode,
      model: providerConfig.model,
      maxSteps,
      workspace: path.basename(workspaceRoot),
      workspaceRoot,
    });

    const agent = new ReactCodeAgent({
      apiMode: providerConfig.apiMode,
      client: createOpenAIClient(providerConfig),
      model: providerConfig.model,
      maxSteps,
      reasoningEffort: providerConfig.reasoningEffort,
      tools: createDefaultTools(workspaceRoot, {
        onWorkspaceRootChange(nextWorkspaceRoot) {
          currentWorkspaceRoot = nextWorkspaceRoot;
        },
      }),
      onStep(event) {
        if (!closed) {
          const payload = serializeStep(event);

          if (event.type === "tool" && event.tool === "change_workdir" && event.result.ok) {
            payload.workspaceRoot = currentWorkspaceRoot;
          }

          writeEvent(res, payload);
        }
      },
    });

    const result = await agent.run(task);

    if (!closed) {
      writeEvent(res, {
        type: "final",
        final: result.final,
        steps: result.steps,
      });
      res.end();
    }
  } catch (error) {
    if (res.headersSent) {
      writeEvent(res, { type: "error", error: formatError(error) });
      res.end();
      return;
    }

    sendJson(res, 500, { ok: false, error: formatError(error) });
  }
}

function getContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function resolveStaticPath(urlPath: string): string | null {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(safePath);
  const filePath = path.resolve(STATIC_ROOT, `.${decoded}`);
  const relative = path.relative(STATIC_ROOT, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return filePath;
}

async function handleStatic(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  const filePath = resolveStaticPath(urlPath);

  if (!filePath) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": getContentType(filePath),
      "cache-control": "no-cache",
    });
    res.end(content);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";

    if (code === "ENOENT" || code === "EISDIR") {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    sendJson(res, 500, { ok: false, error: formatError(error) });
  }
}

async function handleState(res: ServerResponse) {
  try {
    const state = await readState();

    sendJson(res, 200, {
      ok: true,
      conversations: state.conversations,
      settings: state.settings,
      defaults: {
        workspaceRoot: process.cwd(),
      },
      stateFile: STATE_FILE,
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: formatError(error) });
  }
}

async function handleSaveConversations(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readJsonBody(req);
    const conversations = Array.isArray(body.conversations) ? body.conversations : null;

    if (!conversations) {
      sendJson(res, 400, { ok: false, error: "conversations must be an array." });
      return;
    }

    const state = await readState();
    state.conversations = conversations.slice(0, 80);
    await writeState(state);
    sendJson(res, 200, { ok: true, conversations: state.conversations });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: formatError(error) });
  }
}

async function handleSaveSettings(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readJsonBody(req);
    const workspaceRoot = await resolveWorkspaceRoot(body.workspaceRoot);
    const state = await readState();

    state.settings.workspaceRoot = workspaceRoot;
    state.settings.workspaceRootConfigured = true;
    await writeState(state);

    sendJson(res, 200, {
      ok: true,
      settings: state.settings,
      workspace: {
        name: path.basename(workspaceRoot),
        root: workspaceRoot,
      },
    });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: formatError(error) });
  }
}

async function handleSelectDirectory(req: IncomingMessage, res: ServerResponse) {
  if (!isLocalRequest(req)) {
    sendJson(res, 403, { ok: false, error: "Directory picker is only available from localhost." });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const initialPath = await resolveInitialDirectory(body.initialPath);
    const selectedPath = await selectDirectoryWithSystemDialog(initialPath);

    if (!selectedPath) {
      sendJson(res, 200, { ok: true, canceled: true });
      return;
    }

    const workspaceRoot = await resolveWorkspaceRoot(selectedPath);
    sendJson(res, 200, {
      ok: true,
      canceled: false,
      path: workspaceRoot,
    });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: formatError(error) });
  }
}

async function handleStatus(res: ServerResponse) {
  try {
    const state = await readState();
    const workspaceRoot = await resolveWorkspaceRoot(state.settings.workspaceRoot);
    const providerConfig = resolveProviderConfig({}, process.env);

    sendJson(res, 200, {
      ok: true,
      provider: providerConfig.provider,
      apiMode: providerConfig.apiMode,
      model: providerConfig.model,
      proxy: providerConfig.proxySource,
      maxSteps: readMaxSteps(),
      workspace: path.basename(workspaceRoot),
      workspaceRoot,
    });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      error: formatError(error),
    });
  }
}

export function createApp() {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/api/status") {
        await handleStatus(res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        await handleState(res);
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/conversations") {
        await handleSaveConversations(req, res);
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/settings") {
        await handleSaveSettings(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/select-directory") {
        await handleSelectDirectory(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/run") {
        await handleRun(req, res);
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      await handleStatic(req, res, url.pathname);
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: formatError(error) });
        return;
      }

      res.end();
    });
  });
}

export async function startWebServer(options: WebServerStartOptions = {}): Promise<StartedWebServer> {
  if (options.loadEnv ?? true) {
    loadEnvFile(process.env.AGENT_ENV_FILE);
  }

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? readPort();
  const server = createApp();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? (address as AddressInfo).port : port;

  return {
    port: resolvedPort,
    url: `http://${host}:${resolvedPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}

async function main() {
  const started = await startWebServer();
  console.log(`Code Agent web UI: ${started.url.replace("127.0.0.1", "localhost")}`);
}

function isDirectRun(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}
