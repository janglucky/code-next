import OpenAI from "openai";
import { buildSystemPrompt } from "./prompt.js";
import type { AgentDecision, AgentMessage, AgentStepEvent, JsonObject, ToolDefinition } from "./types.js";
import type { ApiMode, ReasoningEffort } from "../config/provider.js";

export type ReactCodeAgentOptions = {
  apiMode?: ApiMode;
  client?: OpenAI;
  model?: string;
  maxSteps?: number;
  reasoningEffort?: ReasoningEffort | null;
  tools: ToolDefinition[];
  onStep?: (event: AgentStepEvent) => void;
};

export type AgentRunResult = {
  final: string;
  steps: number;
};

export class ReactCodeAgent {
  private readonly apiMode: ApiMode;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxSteps: number;
  private readonly reasoningEffort: ReasoningEffort | null;
  private readonly tools: Map<string, ToolDefinition>;
  private readonly systemPrompt: string;
  private readonly onStep?: (event: AgentStepEvent) => void;

  constructor(options: ReactCodeAgentOptions) {
    this.apiMode = options.apiMode ?? "responses";
    this.client = options.client ?? new OpenAI();
    this.model = options.model ?? "gpt-5.5";
    this.maxSteps = options.maxSteps ?? 8;
    this.reasoningEffort = options.reasoningEffort === undefined ? "low" : options.reasoningEffort;
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.systemPrompt = buildSystemPrompt(options.tools);
    this.onStep = options.onStep;
  }

  async run(task: string): Promise<AgentRunResult> {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: `User task:\n${task}`,
      },
    ];

    for (let step = 1; step <= this.maxSteps; step += 1) {
      const decision = await this.callModel(messages);
      this.onStep?.({ type: "model", step, decision });

      messages.push({
        role: "assistant",
        content: JSON.stringify(decision),
      });

      if (decision.final) {
        return { final: decision.final, steps: step };
      }

      if (!decision.action) {
        messages.push({
          role: "user",
          content: "Observation: Missing action and final answer. Return a valid action or final.",
        });
        continue;
      }

      const tool = this.tools.get(decision.action.tool);
      if (!tool) {
        messages.push({
          role: "user",
          content: `Observation: Unknown tool "${decision.action.tool}". Available tools: ${[
            ...this.tools.keys(),
          ].join(", ")}`,
        });
        continue;
      }

      const result = await tool.run(decision.action.input);
      this.onStep?.({ type: "tool", step, tool: tool.name, result });

      messages.push({
        role: "user",
        content: [
          `Observation from ${tool.name}:`,
          JSON.stringify(
            {
              ok: result.ok,
              output: result.output,
            },
            null,
            2,
          ),
        ].join("\n"),
      });
    }

    return {
      final: `Stopped after ${this.maxSteps} steps before the agent reached a final answer.`,
      steps: this.maxSteps,
    };
  }

  private async callModel(messages: AgentMessage[]): Promise<AgentDecision> {
    if (this.apiMode === "chat") {
      return this.callChatCompletions(messages);
    }

    return this.callResponses(messages);
  }

  private async callResponses(messages: AgentMessage[]): Promise<AgentDecision> {
    const response = await this.client.responses.create({
      model: this.model,
      ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort } } : {}),
      input: [
        {
          role: "developer",
          content: this.systemPrompt,
        },
        ...messages,
      ],
    });

    return parseDecision(response.output_text);
  }

  private async callChatCompletions(messages: AgentMessage[]): Promise<AgentDecision> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: this.systemPrompt,
        },
        ...messages,
      ],
    });
    const content = response.choices[0]?.message.content;

    if (!content) {
      throw new Error("Chat completion response did not include message content.");
    }

    return parseDecision(content);
  }
}

function parseDecision(text: string): AgentDecision {
  const jsonText = extractJsonObject(text);
  const parsed = JSON.parse(jsonText) as Partial<AgentDecision>;

  if (typeof parsed.thought !== "string") {
    throw new Error(`Model response is missing string field "thought": ${text}`);
  }

  const final = typeof parsed.final === "string" ? parsed.final : null;
  const action = parseAction(parsed.action);

  if (!final && !action) {
    throw new Error(`Model response must include either "action" or "final": ${text}`);
  }

  return {
    thought: parsed.thought,
    action,
    final,
  };
}

function parseAction(value: unknown): AgentDecision["action"] {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('"action" must be an object or null');
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.tool !== "string") {
    throw new Error('"action.tool" must be a string');
  }

  const input = candidate.input;
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
    throw new Error('"action.input" must be an object');
  }

  return {
    tool: candidate.tool,
    input: (input ?? {}) as JsonObject,
  };
}

function extractJsonObject(text: string): string {
  const withoutFence = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Model response did not contain a JSON object: ${text}`);
  }

  return withoutFence.slice(start, end + 1);
}
