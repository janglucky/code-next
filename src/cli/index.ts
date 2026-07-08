#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { createOpenAIClient, resolveProviderConfig, type ProviderInput } from "../config/provider.js";
import { loadEnvFile } from "../config/env.js";
import { ReactCodeAgent } from "../core/react-code-agent.js";
import { createDefaultTools } from "../tools/workspace-tools.js";

type CliOptions = ProviderInput & {
  envFile?: string;
  help: boolean;
  interactive: boolean;
  maxSteps?: number;
  task: string;
};

function readMaxSteps(): number {
  const raw = process.env.AGENT_MAX_STEPS;
  if (!raw) {
    return 8;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  if (name === "APIConnectionTimeoutError" || message.toLowerCase().includes("timed out")) {
    return `${message}

The model request timed out. Useful fixes:
- Increase AGENT_REQUEST_TIMEOUT_MS, for example 300000.
- Increase AGENT_MAX_RETRIES, for example 3.
- For BYOK endpoints that do not support /v1/responses, set BYOK_API_MODE=chat.`;
  }

  return message;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    interactive: false,
    task: "",
  };
  const taskParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--interactive" || arg === "-i") {
      options.interactive = true;
      continue;
    }

    if (arg === "--no-reasoning") {
      options.reasoningEffort = null;
      continue;
    }

    if (arg === "--no-proxy") {
      options.proxyUrl = null;
      continue;
    }

    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.split("=", 2);
      const value = inlineValue ?? argv[index + 1];

      if (inlineValue === undefined) {
        index += 1;
      }

      assignOption(options, name, value);
      continue;
    }

    taskParts.push(arg);
  }

  options.task = taskParts.join(" ").trim();
  return options;
}

function assignOption(options: CliOptions, name: string, value: string | undefined) {
  if (!value) {
    throw new Error(`Missing value for ${name}`);
  }

  switch (name) {
    case "--api-mode":
      options.apiMode = value;
      return;
    case "--provider":
      options.provider = value;
      return;
    case "--proxy-url":
      options.proxyUrl = value;
      return;
    case "--api-key":
      options.apiKey = value;
      return;
    case "--base-url":
    case "--baseURL":
      options.baseURL = value;
      return;
    case "--model":
      options.model = value;
      return;
    case "--reasoning-effort":
      options.reasoningEffort = value;
      return;
    case "--max-steps":
      options.maxSteps = Number(value);
      if (!Number.isFinite(options.maxSteps) || options.maxSteps <= 0) {
        throw new Error("--max-steps must be a positive number");
      }
      return;
    case "--request-timeout-ms":
      options.requestTimeoutMs = Number(value);
      if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
        throw new Error("--request-timeout-ms must be a positive integer");
      }
      return;
    case "--max-retries":
      options.maxRetries = Number(value);
      if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
        throw new Error("--max-retries must be an integer >= 0");
      }
      return;
    case "--env-file":
      options.envFile = value;
      return;
    default:
      throw new Error(`Unknown option ${name}`);
  }
}

function printUsage() {
  console.log(`Usage:
  react-code-agent [options] ["your coding task"]
  npm run dev -- [options] ["your coding task"]

Run without a task to start interactive mode.

Options:
  --provider openai|byok       Provider mode. Defaults to openai.
  --api-mode responses|chat    API mode. OpenAI defaults to responses; BYOK defaults to chat.
  --api-key <key>              API key for one-off runs. Prefer env vars for daily use.
  --base-url <url>             Custom OpenAI-compatible base URL.
  --model <model>              Model name.
  --reasoning-effort <level>   none|minimal|low|medium|high|xhigh|off.
  --no-reasoning               Omit the reasoning field from Responses API calls.
  --max-steps <number>         Maximum ReAct loop steps.
  --request-timeout-ms <ms>    Request timeout for model API calls.
  --max-retries <number>       SDK retries for model API calls.
  --proxy-url <url>            Proxy URL for model API calls.
  --no-proxy                   Disable proxy for model API calls.
  --env-file <path>            Load env vars from a custom env file. Defaults to .env.
  -i, --interactive            Start interactive mode even when stdin is piped.
  -h, --help                   Show this help.

Environment:
  OPENAI_API_KEY               Default OpenAI API key.
  OPENAI_BASE_URL              Optional OpenAI-compatible base URL for openai mode.
  OPENAI_MODEL                 Default OpenAI model.
  OPENAI_API_MODE              responses or chat. Defaults to responses.
  OPENAI_REASONING_EFFORT      Reasoning effort for openai mode. Defaults to low.

  BYOK_API_KEY                 BYOK API key.
  BYOK_BASE_URL                BYOK OpenAI-compatible base URL.
  BYOK_MODEL                   BYOK model.
  BYOK_API_MODE                responses or chat. Defaults to chat.
  BYOK_REASONING_EFFORT        Reasoning effort for BYOK mode. Defaults to off.

  AGENT_REQUEST_TIMEOUT_MS     Shared model request timeout.
  AGENT_MAX_RETRIES            Shared model request retries.
  AGENT_PROXY_URL              Explicit proxy URL.
  AGENT_PROXY=off              Disable proxy even if proxy env vars exist.
`);
}

function printInteractiveHelp() {
  console.log(`Commands:
  /help      Show interactive commands.
  /config    Show current provider and runtime config.
  /clear     Clear the terminal.
  /exit      Exit interactive mode.

Type any other line as a coding task.`);
}

function formatProviderSummary(providerConfig: ReturnType<typeof resolveProviderConfig>, maxSteps: number): string {
  return `Provider: ${providerConfig.provider} | apiMode: ${providerConfig.apiMode} | model: ${providerConfig.model} | baseURL: ${
    providerConfig.baseURL ?? "default"
  } | maxSteps: ${maxSteps} | timeoutMs: ${providerConfig.requestTimeoutMs ?? "default"} | retries: ${
    providerConfig.maxRetries ?? "default"
  } | proxy: ${providerConfig.proxySource}`;
}

async function readPipedTask(): Promise<string> {
  let content = "";
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    content += chunk;
  }

  return content.trim();
}

async function runTask(agent: ReactCodeAgent, task: string) {
  const result = await agent.run(task);
  console.log(`\nFinal (${result.steps} steps):\n${result.final}`);
}

async function runInteractive(agent: ReactCodeAgent, providerSummary: string) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "agent> ",
  });

  console.log("Interactive mode. Type a task and press Enter. Type /help for commands.");
  console.log(providerSummary);

  rl.on("SIGINT", () => {
    console.log("\nType /exit to quit.");
    rl.prompt();
  });

  try {
    rl.prompt();

    for await (const line of rl) {
      const task = line.trim();

      if (!task) {
        rl.prompt();
        continue;
      }

      if (task === "/exit" || task === "/quit") {
        break;
      }

      if (task === "/help") {
        printInteractiveHelp();
        rl.prompt();
        continue;
      }

      if (task === "/clear") {
        console.clear();
        rl.prompt();
        continue;
      }

      if (task === "/config") {
        console.log(providerSummary);
        rl.prompt();
        continue;
      }

      try {
        await runTask(agent, task);
      } catch (error) {
        console.error(formatError(error));
      }

      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  loadEnvFile(options.envFile);

  if (!options.task && !options.interactive && !process.stdin.isTTY) {
    options.task = await readPipedTask();
  }

  const providerConfig = resolveProviderConfig(options, process.env);
  const maxSteps = options.maxSteps ?? readMaxSteps();

  const agent = new ReactCodeAgent({
    apiMode: providerConfig.apiMode,
    client: createOpenAIClient(providerConfig),
    model: providerConfig.model,
    maxSteps,
    reasoningEffort: providerConfig.reasoningEffort,
    tools: createDefaultTools(process.cwd()),
    onStep(event) {
      if (event.type === "model") {
        console.log(`\n[step ${event.step}] thought: ${event.decision.thought}`);
        if (event.decision.action) {
          console.log(`[step ${event.step}] action: ${event.decision.action.tool}`);
          console.log(JSON.stringify(event.decision.action.input, null, 2));
        }
        return;
      }

      console.log(`[step ${event.step}] observation from ${event.tool}: ${event.result.ok ? "ok" : "failed"}`);
      console.log(event.result.output);
    },
  });

  const providerSummary = formatProviderSummary(providerConfig, maxSteps);

  if (!options.task || options.interactive) {
    await runInteractive(agent, providerSummary);
    return;
  }

  console.log(providerSummary);
  await runTask(agent, options.task);
}

main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
