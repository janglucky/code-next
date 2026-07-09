# Build Notes

## Development

```bash
npm install
cp .env.example .env
npm run dev
```

One-off task:

```bash
npm run dev -- "your coding task"
```

Web UI:

```bash
npm run web
```

Open `http://localhost:3100`. The browser entry lives at `src/web/index.html`, and the local server entry lives at `src/web/server.ts`.

Desktop client:

```bash
npm run desktop
```

The desktop client uses Electron and reuses the `src/web` UI through an internal localhost server.
If the Electron binary download fails during install, run `npm run electron:rebuild` after network access is restored. If the npm downloader hangs, run `npm run electron:install` to install the binary with curl/unzip.

## TypeScript Build

```bash
npm run build
```

The compiled CLI entry is emitted to `dist/cli/index.js`.

## Linked CLI

```bash
npm link
react-code-agent "your coding task"
```

The CLI operates on the current working directory where `react-code-agent` is executed.

## Provider Configuration

Default OpenAI mode:

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-5.5"
react-code-agent "your coding task"
```

BYOK mode:

```bash
export BYOK_API_KEY="your_key"
export BYOK_BASE_URL="https://api.example.com/v1"
export BYOK_MODEL="your-model"
react-code-agent --provider byok "your coding task"
```

CLI flags override environment variables:

```bash
react-code-agent \
  --provider byok \
  --api-key "your_key" \
  --base-url "https://api.example.com/v1" \
  --model "your-model" \
  --no-reasoning \
  "your coding task"
```
