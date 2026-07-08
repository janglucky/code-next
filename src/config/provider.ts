import OpenAI, { type ClientOptions } from "openai";
import { EnvHttpProxyAgent, ProxyAgent, fetch } from "undici";

export type ProviderMode = "openai" | "byok";
export type ApiMode = "responses" | "chat";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ProviderInput = {
  provider?: string;
  apiMode?: string;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxRetries?: number;
  proxyUrl?: string | null;
  reasoningEffort?: string | null;
  requestTimeoutMs?: number;
};

export type ModelProviderConfig = {
  provider: ProviderMode;
  apiMode: ApiMode;
  apiKey: string;
  baseURL?: string;
  model: string;
  maxRetries?: number;
  proxyEnabled: boolean;
  proxySource: "explicit" | "env" | "off";
  proxyUrl?: string;
  reasoningEffort: ReasoningEffort | null;
  requestTimeoutMs?: number;
};

const DEFAULT_MODEL = "gpt-5.5";
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const API_MODES = new Set(["responses", "chat"]);

export function resolveProviderConfig(input: ProviderInput, env: NodeJS.ProcessEnv): ModelProviderConfig {
  const provider = resolveProviderPreference(input.provider, env);

  if (provider === "byok") {
    return resolveByokConfig(input, env);
  }

  if (!hasOpenAIKey(input, env) && shouldFallbackToByok(input, env)) {
    return resolveByokConfig(input, env);
  }

  return resolveOpenAIConfig(input, env);
}

export function createOpenAIClient(config: ModelProviderConfig): OpenAI {
  const dispatcher = createProxyDispatcher(config);
  const options: ClientOptions = {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: config.maxRetries,
    timeout: config.requestTimeoutMs,
  };

  if (dispatcher) {
    Object.assign(options, {
      fetch,
      fetchOptions: { dispatcher },
    });
  }

  return new OpenAI(options);
}

function resolveProviderPreference(value: string | undefined, env: NodeJS.ProcessEnv): ProviderMode {
  const raw = (value ?? env.AGENT_PROVIDER)?.trim().toLowerCase();

  if (raw === undefined || raw.length === 0) {
    if (!hasEnvValue(env.OPENAI_API_KEY) && hasEnvValue(env.BYOK_API_KEY)) {
      return "byok";
    }

    return "openai";
  }

  if (raw !== "openai" && raw !== "byok") {
    throw new Error(`Unsupported provider "${raw}". Use "openai" or "byok".`);
  }

  return raw;
}

function hasOpenAIKey(input: ProviderInput, env: NodeJS.ProcessEnv): boolean {
  return hasEnvValue(input.apiKey) || hasEnvValue(env.OPENAI_API_KEY);
}

function shouldFallbackToByok(input: ProviderInput, env: NodeJS.ProcessEnv): boolean {
  const cliProvider = input.provider?.trim().toLowerCase();

  if (cliProvider === "openai") {
    return false;
  }

  return hasEnvValue(env.BYOK_API_KEY);
}

function resolveOpenAIConfig(input: ProviderInput, env: NodeJS.ProcessEnv): ModelProviderConfig {
  const apiKey = input.apiKey ?? env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(`Missing OPENAI_API_KEY.

Fix one of these:
1. OpenAI mode:
   OPENAI_API_KEY=sk-...

2. BYOK mode:
   AGENT_PROVIDER=byok
   BYOK_API_KEY=your_key
   BYOK_BASE_URL=https://api.example.com/v1
   BYOK_MODEL=your-model

The CLI loads .env from the current directory automatically.`);
  }

  return {
    provider: "openai",
    apiMode: parseApiMode(input.apiMode ?? env.OPENAI_API_MODE ?? env.AGENT_API_MODE ?? "responses"),
    apiKey,
    baseURL: normalizeOptional(input.baseURL ?? env.OPENAI_BASE_URL),
    model: input.model ?? env.OPENAI_MODEL ?? DEFAULT_MODEL,
    maxRetries: parseOptionalInteger(input.maxRetries ?? env.OPENAI_MAX_RETRIES ?? env.AGENT_MAX_RETRIES, "max retries", 0),
    ...resolveProxyConfig(input, env),
    reasoningEffort: parseReasoningEffort(input.reasoningEffort ?? env.OPENAI_REASONING_EFFORT ?? "low"),
    requestTimeoutMs: parseOptionalInteger(
      input.requestTimeoutMs ?? env.OPENAI_REQUEST_TIMEOUT_MS ?? env.AGENT_REQUEST_TIMEOUT_MS,
      "request timeout",
      1,
    ),
  };
}

function resolveByokConfig(input: ProviderInput, env: NodeJS.ProcessEnv): ModelProviderConfig {
  const apiKey = input.apiKey ?? env.BYOK_API_KEY ?? env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(`Missing BYOK_API_KEY.

Fix one of these:
1. Add BYOK settings to .env:
   AGENT_PROVIDER=byok
   BYOK_API_KEY=your_key
   BYOK_BASE_URL=https://api.example.com/v1
   BYOK_MODEL=your-model

2. Pass it once:
   npm run dev -- --provider byok --api-key your_key --base-url https://api.example.com/v1 --model your-model`);
  }

  return {
    provider: "byok",
    apiMode: parseApiMode(input.apiMode ?? env.BYOK_API_MODE ?? env.AGENT_API_MODE ?? "chat"),
    apiKey,
    baseURL: normalizeOptional(input.baseURL ?? env.BYOK_BASE_URL ?? env.OPENAI_BASE_URL),
    model: input.model ?? env.BYOK_MODEL ?? env.OPENAI_MODEL ?? DEFAULT_MODEL,
    maxRetries: parseOptionalInteger(input.maxRetries ?? env.BYOK_MAX_RETRIES ?? env.AGENT_MAX_RETRIES, "max retries", 0),
    ...resolveProxyConfig(input, env),
    reasoningEffort: parseReasoningEffort(input.reasoningEffort ?? env.BYOK_REASONING_EFFORT ?? null),
    requestTimeoutMs: parseOptionalInteger(
      input.requestTimeoutMs ?? env.BYOK_REQUEST_TIMEOUT_MS ?? env.AGENT_REQUEST_TIMEOUT_MS,
      "request timeout",
      1,
    ),
  };
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value.trim();
}

function hasEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function createProxyDispatcher(config: ModelProviderConfig): EnvHttpProxyAgent | ProxyAgent | undefined {
  if (!config.proxyEnabled) {
    return undefined;
  }

  if (config.proxyUrl) {
    return new ProxyAgent(config.proxyUrl);
  }

  return new EnvHttpProxyAgent();
}

function resolveProxyConfig(
  input: ProviderInput,
  env: NodeJS.ProcessEnv,
): Pick<ModelProviderConfig, "proxyEnabled" | "proxySource" | "proxyUrl"> {
  const proxyFlag = env.AGENT_PROXY?.trim().toLowerCase();

  if (proxyFlag === "off" || proxyFlag === "false" || input.proxyUrl === null) {
    return {
      proxyEnabled: false,
      proxySource: "off",
    };
  }

  const explicitProxyUrl = normalizeOptional(input.proxyUrl ?? env.AGENT_PROXY_URL);

  if (explicitProxyUrl) {
    return {
      proxyEnabled: true,
      proxySource: "explicit",
      proxyUrl: explicitProxyUrl,
    };
  }

  if (hasEnvProxy(env)) {
    return {
      proxyEnabled: true,
      proxySource: "env",
    };
  }

  return {
    proxyEnabled: false,
    proxySource: "off",
  };
}

function hasEnvProxy(env: NodeJS.ProcessEnv): boolean {
  return [
    env.HTTPS_PROXY,
    env.HTTP_PROXY,
    env.ALL_PROXY,
    env.https_proxy,
    env.http_proxy,
    env.all_proxy,
  ].some(hasEnvValue);
}

function parseApiMode(value: string): ApiMode {
  const normalized = value.trim().toLowerCase();

  if (!API_MODES.has(normalized)) {
    throw new Error(`Unsupported API mode "${value}". Use "responses" or "chat".`);
  }

  return normalized as ApiMode;
}

function parseOptionalInteger(value: number | string | undefined, name: string, min: number): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }

  return parsed;
}

function parseReasoningEffort(value: string | null): ReasoningEffort | null {
  const normalized = value?.trim().toLowerCase() ?? null;

  if (normalized === null || normalized.length === 0 || normalized === "off" || normalized === "false") {
    return null;
  }

  if (!REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${value}". Use one of: ${[...REASONING_EFFORTS].join(", ")}, or "off".`,
    );
  }

  return normalized as ReasoningEffort;
}
