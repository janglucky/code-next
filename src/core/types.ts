export type JsonObject = Record<string, unknown>;

export type AgentMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ToolResult = {
  ok: boolean;
  output: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonObject;
  run: (input: JsonObject) => Promise<ToolResult>;
};

export type AgentAction = {
  tool: string;
  input: JsonObject;
};

export type AgentDecision = {
  thought: string;
  action: AgentAction | null;
  final: string | null;
};

export type AgentStepEvent =
  | {
      type: "model";
      step: number;
      decision: AgentDecision;
    }
  | {
      type: "tool";
      step: number;
      tool: string;
      result: ToolResult;
    };
