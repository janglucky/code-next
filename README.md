# TypeScript ReAct Code Agent

一个最小可运行的代码 Agent 示例，包含：

- ReAct 循环：`Thought -> Action -> Observation -> Final`
- 系统 prompt：约束模型每次只输出一个 JSON 决策
- 工具层：列文件、读文件、写文件、运行命令
- OpenAI Responses API 调用逻辑

## 运行

```bash
npm install
export OPENAI_API_KEY="your_api_key"
npm run dev
```

启动后会进入交互模式：

```text
agent> 创建一个 hello.ts，并运行 TypeScript 编译检查
agent> /exit
```

也可以直接执行一次性任务：

```bash
npm run dev -- "创建一个 hello.ts，并运行 TypeScript 编译检查"
```

也可以构建后作为 CLI 运行：

```bash
npm run build
npm link
react-code-agent
```

可选环境变量：

```bash
export OPENAI_MODEL="gpt-5.5"
export AGENT_MAX_STEPS="8"
```

## OpenAI 与 BYOK

默认模式走官方 OpenAI 接口：

```bash
export OPENAI_API_KEY="sk-..."
npm run dev -- "查看当前目录并总结项目结构"
```

BYOK 模式支持自带 key，也可以配置 OpenAI-compatible base URL：

```bash
export BYOK_API_KEY="your_key"
export BYOK_BASE_URL="https://api.example.com/v1"
export BYOK_MODEL="your-model"
npm run dev -- --provider byok "查看当前目录并总结项目结构"
```

也可以临时通过 CLI 参数传入：

```bash
npm run dev -- --provider byok --api-key "your_key" --base-url "https://api.example.com/v1" --model "your-model" "执行一个代码任务"
```

BYOK 的 endpoint 需要兼容 OpenAI Responses API。若自定义 endpoint 不支持 `reasoning` 参数，可使用 `--no-reasoning` 或 `BYOK_REASONING_EFFORT=off`。

Provider 会按 OpenAI 优先解析：有 `OPENAI_API_KEY` 时使用 OpenAI；如果没有配置 `OPENAI_API_KEY`，但配置了 `BYOK_API_KEY`，会自动降级到 BYOK。只有显式传 `--provider openai` 时才会强制要求 OpenAI key。

BYOK 默认使用更通用的 Chat Completions API：

```env
BYOK_API_MODE=chat
AGENT_REQUEST_TIMEOUT_MS=300000
AGENT_MAX_RETRIES=2
```

如果你的 BYOK endpoint 支持 Responses API，也可以设置：

```env
BYOK_API_MODE=responses
```

如果你需要走代理，建议显式配置：

```env
AGENT_PROXY_URL=http://127.0.0.1:7890
```

如果不设置 `AGENT_PROXY_URL`，CLI 会尝试使用环境里的 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`。如果想禁用代理：

```env
AGENT_PROXY=off
```

也可以基于 `.env.example` 创建本地 `.env` 管理配置：

```bash
cp .env.example .env
npm run dev -- "查看当前目录并总结项目结构"
```

CLI 启动时会自动读取当前工作目录下的 `.env`。如果想使用其他文件：

```bash
npm run dev -- --env-file .env.local "查看当前目录并总结项目结构"
```

交互模式支持这些内置命令：

```text
/help
/config
/clear
/exit
```

## 代码入口

- `src/cli/index.ts`：CLI 参数、日志输出、启动入口
- `src/core/react-code-agent.ts`：ReAct 主循环、调度逻辑、API 调用、模型输出解析
- `src/core/prompt.ts`：系统 prompt 与工具描述拼装
- `src/core/types.ts`：Agent、工具、事件类型
- `src/tools/workspace-tools.ts`：本地代码工具实现

## 目录结构

```text
.
├── docs/                 # 构建和使用文档
├── scripts/              # 本地构建/检查脚本
├── src/
│   ├── cli/              # CLI 入口层
│   ├── config/           # Provider / BYOK 配置解析
│   ├── core/             # Agent 核心调度层
│   └── tools/            # 工具适配层
├── package.json          # npm 脚本和 CLI bin 配置
└── tsconfig.json         # TypeScript 构建配置
```
