#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createOpenAIClient, resolveProviderConfig, type ProviderInput } from "../config/provider.js";
import { loadEnvFile } from "../config/env.js";
import { ReactCodeAgent } from "../core/react-code-agent.js";
import type { AgentStepEvent, JsonObject } from "../core/types.js";
import { createDefaultTools } from "../tools/workspace-tools.js";

type RunRequest = ProviderInput & {
  task?: unknown;
  maxSteps?: unknown;
};

const DEFAULT_PORT = 3100;
const MAX_BODY_BYTES = 64 * 1024;
const STATIC_ROOT = path.resolve(process.cwd(), "src/web");

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

async function readJsonBody(req: IncomingMessage): Promise<RunRequest> {
  const raw = await readBody(req);

  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }

  return parsed as RunRequest;
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
    body = await readJsonBody(req);
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
      workspace: process.cwd(),
    });

    const agent = new ReactCodeAgent({
      apiMode: providerConfig.apiMode,
      client: createOpenAIClient(providerConfig),
      model: providerConfig.model,
      maxSteps,
      reasoningEffort: providerConfig.reasoningEffort,
      tools: createDefaultTools(process.cwd()),
      onStep(event) {
        if (!closed) {
          writeEvent(res, serializeStep(event));
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

function handleStatus(res: ServerResponse) {
  try {
    const providerConfig = resolveProviderConfig({}, process.env);

    sendJson(res, 200, {
      ok: true,
      provider: providerConfig.provider,
      apiMode: providerConfig.apiMode,
      model: providerConfig.model,
      proxy: providerConfig.proxySource,
      maxSteps: readMaxSteps(),
      workspace: path.basename(process.cwd()),
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
        handleStatus(res);
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
