# Configuration

## Provider Modes

The CLI supports two provider modes:

- `openai`: default mode, using the official OpenAI client configuration.
- `byok`: bring your own key, optionally with an OpenAI-compatible `baseURL`.

Provider resolution is OpenAI-first by default:

1. If `OPENAI_API_KEY` is set, the CLI uses OpenAI mode.
2. If `OPENAI_API_KEY` is missing and `BYOK_API_KEY` is set, the CLI falls back to BYOK mode.
3. If you explicitly pass `--provider openai`, the CLI will not fall back and will require `OPENAI_API_KEY`.
4. If you explicitly pass `--provider byok`, the CLI requires BYOK settings.

## Environment Variables

The CLI automatically loads `.env` from the current working directory before resolving provider configuration. Existing shell environment variables are not overwritten.

You can specify another env file:

```bash
react-code-agent --env-file .env.local "your coding task"
```

OpenAI mode:

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_API_MODE=responses
OPENAI_REASONING_EFFORT=low
```

BYOK mode:

```bash
AGENT_PROVIDER=byok
BYOK_API_KEY=your_key
BYOK_BASE_URL=https://api.example.com/v1
BYOK_MODEL=your-model
BYOK_API_MODE=chat
BYOK_REASONING_EFFORT=off
```

Runtime tuning:

```bash
AGENT_REQUEST_TIMEOUT_MS=300000
AGENT_MAX_RETRIES=2
```

Proxy:

```bash
AGENT_PROXY_URL=http://127.0.0.1:7890
```

If `AGENT_PROXY_URL` is empty, the CLI will use `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` when present. To disable proxy detection:

```bash
AGENT_PROXY=off
```

## CLI Flags

Run without a task to enter interactive mode:

```bash
react-code-agent
```

Run a one-off task:

```bash
react-code-agent \
  --provider byok \
  --api-mode chat \
  --api-key "your_key" \
  --base-url "https://api.example.com/v1" \
  --model "your-model" \
  --env-file ".env.local" \
  --request-timeout-ms 300000 \
  --max-retries 2 \
  --proxy-url "http://127.0.0.1:7890" \
  --no-reasoning \
  "your coding task"
```

`--api-key` is useful for quick testing, but environment variables are safer for regular use because shell history may retain CLI arguments.

Interactive commands:

```text
/help
/config
/clear
/exit
```

## Compatibility

OpenAI mode defaults to the Responses API. BYOK mode defaults to Chat Completions because many OpenAI-compatible endpoints expose `/v1/chat/completions` but not `/v1/responses`.

If your BYOK endpoint supports Responses API, set `BYOK_API_MODE=responses`. If a compatible endpoint rejects the `reasoning` field, set `BYOK_REASONING_EFFORT=off` or pass `--no-reasoning`.
