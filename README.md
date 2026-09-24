# cursor-agent-api-proxy

[![npm version](https://img.shields.io/npm/v/cursor-agent-api-proxy)](https://www.npmjs.com/package/cursor-agent-api-proxy)
[![npm downloads](https://img.shields.io/npm/dm/cursor-agent-api-proxy)](https://www.npmjs.com/package/cursor-agent-api-proxy)
[![license](https://img.shields.io/npm/l/cursor-agent-api-proxy)](./LICENSE)

[中文文档](./README.zh-CN.md)

OpenAI-compatible API proxy for the Cursor CLI. Lets any OpenAI client use your Cursor subscription.

## Prerequisites

- Node.js 20+
- Active [Cursor](https://cursor.com) subscription (Pro / Business)

## Install

**1. Install the Cursor CLI and log in:**

```bash
# macOS / Linux
curl https://cursor.com/install -fsS | bash

# Windows PowerShell
irm 'https://cursor.com/install?win32=true' | iex
```

```bash
agent login          # opens browser, sign in with your Cursor account
agent --list-models  # verify it works
```

> **Headless?** Skip `agent login`, generate a key at [cursor.com/settings](https://cursor.com/settings) and `export CURSOR_API_KEY=<key>`.

**2. Install and start the proxy:**

```bash
npm install -g cursor-agent-api-proxy
cursor-agent-api          # starts in background on http://localhost:4646
cursor-agent-api status   # check if running
```

**3. Verify:**

```bash
curl http://localhost:4646/health
```

**Other commands:**

```bash
cursor-agent-api stop           # stop
cursor-agent-api restart        # restart
cursor-agent-api start 8080     # start on a custom port
cursor-agent-api run            # run in foreground (for debugging)
```

Logs: `~/.cursor-agent-api/server.log`

## Use with OpenClaw

### First-time setup (onboarding wizard)

If you haven't set up [OpenClaw](https://docs.openclaw.ai) yet, run the onboarding wizard:

```bash
openclaw onboard
```

When the wizard asks you to configure **Model/Auth**:

1. Provider type → choose **Custom Provider** (OpenAI-compatible)
2. Base URL → `http://localhost:4646/v1`
3. API Key → type `not-needed` (if you ran `agent login`)
4. Default model → `auto` (or any model from `agent --list-models`)

### Existing setup (edit config)

Already have OpenClaw running? Edit the config file directly:

```json5
{
  env: {
    // "not-needed" = already logged in via agent login
    // or set your Cursor API Key here to forward it per-request
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:4646/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/auto" },
    },
  },
}
```

## Models

The proxy intentionally exposes only these canonical model IDs:

```text
claude-opus-5-5
claude-opus-5-5-fast
composer-2.5
composer-2.5-fast
grok-4.6
grok-4.6-fast
grok-4.7
grok-4.7-fast
```

`claude-opus-5-5` defaults to Cursor's 1M context, high-effort, normal-speed
variant. `claude-opus-5-5-fast` selects the 1M high-effort Fast variant.
`auto` uses the normal Opus 5.5 default. Models outside this whitelist are
rejected instead of silently routing to a fallback.

OpenAI-compatible clients may optionally send `reasoning_effort` or
`reasoning.effort` with an Opus request. The model ID remains canonical while
the proxy changes only Cursor's effort setting and preserves the 1M context.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List models |
| `/v1/chat/completions` | POST | Chat completion (supports `stream: true`) |

## Configuration

| Env Variable | Default | Description |
|--------------|---------|-------------|
| `PORT` | `4646` | Listen port (or `cursor-agent-api start 8080`) |
| `CURSOR_API_KEY` | - | Alternative Cursor authentication to `agent login` |
| `PROXY_API_KEY` | - | Incoming API key for `/v1/chat/completions`; required outside a trusted private network |

`PROXY_API_KEY` authenticates clients to the proxy. It is separate from
`CURSOR_API_KEY`, which authenticates the proxy to Cursor. For hosted
deployments, configure both through secret storage and never commit them.

## Auto-start (boot)

To start the proxy automatically on system boot:

```bash
cursor-agent-api install    # register as system service
cursor-agent-api uninstall  # remove
```

- macOS → LaunchAgent
- Windows → Task Scheduler
- Linux → systemd user service

## Other Clients

<details>
<summary>Python (openai SDK)</summary>

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4646/v1",
    api_key="not-needed",
)

resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

</details>

<details>
<summary>Continue.dev</summary>

```json
{
  "models": [{
    "title": "Cursor",
    "provider": "openai",
    "model": "auto",
    "apiBase": "http://localhost:4646/v1",
    "apiKey": "not-needed"
  }]
}
```

</details>

<details>
<summary>curl</summary>

```bash
curl -X POST http://localhost:4646/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

</details>

## How it Works

```
Client  →  POST /v1/chat/completions (OpenAI format)
        →  cursor-agent-api-proxy
        →  spawn agent CLI (stream-json)
        →  Cursor subscription
        →  AI response → OpenAI format → Client
```

## Contributing

```bash
git clone https://github.com/tageecc/cursor-agent-api-proxy.git
cd cursor-agent-api-proxy
pnpm install && pnpm run build
pnpm start
```

## License

MIT
