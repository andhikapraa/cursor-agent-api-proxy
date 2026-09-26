# cursor-agent-api-proxy

[![npm version](https://img.shields.io/npm/v/cursor-agent-api-proxy)](https://www.npmjs.com/package/cursor-agent-api-proxy)
[![npm downloads](https://img.shields.io/npm/dm/cursor-agent-api-proxy)](https://www.npmjs.com/package/cursor-agent-api-proxy)
[![license](https://img.shields.io/npm/l/cursor-agent-api-proxy)](./LICENSE)

[中文文档](./README.zh-CN.md)

OpenAI-compatible API proxy for the local `@cursor/sdk` Agent runtime. Lets any OpenAI client use your Cursor subscription.

## Prerequisites

- Node.js 22+
- Active [Cursor](https://cursor.com) subscription (Pro / Business)
- Cursor user API key from [Cursor settings](https://cursor.com/settings)

The proxy uses Cursor's direct local Agent SDK and AgentService transport. It
does not require a separately installed Cursor CLI or an interactive `agent
login` session.

## Install

**1. Configure Cursor authentication:**

```bash
export CURSOR_API_KEY=crsr_...
```

**2. Install and start the proxy:**

```bash
npm install -g cursor-agent-api-proxy
cursor-agent-api run
```

**3. Verify:**

```bash
curl http://localhost:4646/health
```

The container deployment should provide `CURSOR_API_KEY` and `PROXY_API_KEY`
through secret storage rather than putting either key in a command or file.

## Use with OpenClaw

### First-time setup (onboarding wizard)

If you haven't set up [OpenClaw](https://docs.openclaw.ai) yet, run the onboarding wizard:

```bash
openclaw onboard
```

When the wizard asks you to configure **Model/Auth**:

2. Base URL → `http://localhost:4646/v1`
3. API Key → your `PROXY_API_KEY`
4. Default model → `claude-opus-5-5`
4. Default model → `auto` (or any model from `agent --list-models`)

### Existing setup (edit config)

Already have OpenClaw running? Edit the config file directly:

```json5
{
  env: {
    OPENAI_API_KEY: "<PROXY_API_KEY>",
    OPENAI_BASE_URL: "http://localhost:4646/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-opus-5-5" },
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
| `/v1/models` | GET | List the canonical `claude-opus-5-5` model |
| `/v1/chat/completions` | POST | Chat completion (streaming, reasoning, and client tool calls) |

### Tool calls and session continuation

Send OpenAI `tools` in a chat request. The proxy registers those functions as
Cursor SDK custom tools and returns normal OpenAI `tool_calls`; it does not
execute client tools. The caller must send the matching `role: "tool"` result
in a later request so the paused SDK run can continue.

For reliable correlation, set `x-cursor-session-id` to a stable conversation
identifier on every request in the turn. Without that header, the proxy uses a
deterministic key derived from the authenticated caller (or request IP) and
the first user message. This fallback is intended for simple one-conversation
clients; concurrent conversations with the same identity and first prompt
must use the explicit header to avoid sharing in-memory session state.

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
