import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { JsonObject, ToolDefinition, ToolResult } from "../core/types.js";

const DEFAULT_EXCLUDES = new Set([".code-agent", ".git", "node_modules", "dist"]);
const MAX_TOOL_OUTPUT_CHARS = 12_000;

export type WorkspaceToolsOptions = {
  onWorkspaceRootChange?: (workspaceRoot: string) => Promise<void> | void;
};

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function asText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function resolveExistingDirectory(workspaceRoot: string, inputPath: string): Promise<string> {
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(workspaceRoot, inputPath);
  const stat = await fs.stat(resolved);

  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${inputPath}`);
  }

  return resolved;
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const resolved = path.resolve(workspaceRoot, inputPath);
  const relative = path.relative(workspaceRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }

  return resolved;
}

function trimOutput(output: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (output.length <= maxChars) {
    return output;
  }

  return `${output.slice(0, maxChars)}\n... <truncated ${output.length - maxChars} chars>`;
}

function ok(output: string): ToolResult {
  return { ok: true, output };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, output: message };
}

async function walkFiles(root: string, dir: string, maxDepth: number, currentDepth = 0): Promise<string[]> {
  if (currentDepth > maxDepth) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (DEFAULT_EXCLUDES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(root, absolutePath) || ".";

    if (entry.isDirectory()) {
      files.push(`${relativePath}/`);
      files.push(...(await walkFiles(root, absolutePath, maxDepth, currentDepth + 1)));
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      resolve(fail(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(fail(error));
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      const output = trimOutput([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"));
      resolve({
        ok: code === 0,
        output: output || `Command exited with code ${code}`,
      });
    });
  });
}

export function createDefaultTools(initialWorkspaceRoot: string, options: WorkspaceToolsOptions = {}): ToolDefinition[] {
  let workspaceRoot = path.resolve(initialWorkspaceRoot);

  return [
    {
      name: "change_workdir",
      description:
        "Switch the current workspace directory. Later file and command tools run from this directory. The path may be absolute or relative to the current workspace.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
      },
      async run(input: JsonObject) {
        try {
          const nextWorkspaceRoot = await resolveExistingDirectory(workspaceRoot, asString(input.path, "path"));
          workspaceRoot = nextWorkspaceRoot;
          await options.onWorkspaceRootChange?.(workspaceRoot);
          return ok(`Workspace changed to ${workspaceRoot}`);
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      name: "list_files",
      description: "List files and directories under a workspace-relative directory.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", default: "." },
          maxDepth: { type: "number", default: 2 },
        },
      },
      async run(input: JsonObject) {
        try {
          const dir = typeof input.dir === "string" ? input.dir : ".";
          const maxDepth = Math.max(0, Math.min(6, asNumber(input.maxDepth, 2)));
          const absoluteDir = resolveWorkspacePath(workspaceRoot, dir);
          const files = await walkFiles(workspaceRoot, absoluteDir, maxDepth);
          return ok(files.length === 0 ? "<empty>" : files.slice(0, 250).join("\n"));
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file from a workspace-relative path.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          maxChars: { type: "number", default: 12000 },
        },
      },
      async run(input: JsonObject) {
        try {
          const filePath = resolveWorkspacePath(workspaceRoot, asString(input.path, "path"));
          const maxChars = Math.max(1_000, Math.min(50_000, asNumber(input.maxChars, 12_000)));
          const content = await fs.readFile(filePath, "utf8");
          return ok(trimOutput(content, maxChars));
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a UTF-8 text file at a workspace-relative path.",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
      },
      async run(input: JsonObject) {
        try {
          const relativePath = asString(input.path, "path");
          const content = asText(input.content, "content");
          const filePath = resolveWorkspacePath(workspaceRoot, relativePath);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, "utf8");
          return ok(`Wrote ${content.length} chars to ${relativePath}`);
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      name: "run_command",
      description: "Run a non-interactive command in the workspace using argv, not a shell.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          args: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          timeoutMs: { type: "number", default: 30000 },
        },
      },
      async run(input: JsonObject) {
        try {
          const command = asString(input.command, "command");
          const args = Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [];
          const timeoutMs = Math.max(1_000, Math.min(120_000, asNumber(input.timeoutMs, 30_000)));
          return await runProcess(command, args, workspaceRoot, timeoutMs);
        } catch (error) {
          return fail(error);
        }
      },
    },
  ];
}
