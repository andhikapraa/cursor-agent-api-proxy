/** OpenAI-compatible endpoints backed by the local @cursor/sdk Agent runtime. */

import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { CursorAgentTransport } from "../cursor/transport.js";
import type {
  OpenAIChatChunk,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIToolCall,
} from "../types/openai.js";

const MODEL_ID = "claude-opus-5-5";
const PROXY_API_KEY = process.env.PROXY_API_KEY?.trim();
const transport = new CursorAgentTransport();

function isAuthorized(req: Request): boolean {
  if (!PROXY_API_KEY) return true;
  const auth = req.headers.authorization;
  return auth?.startsWith("Bearer ") === true && auth.slice(7).trim() === PROXY_API_KEY;
}

function contentText(content: OpenAIChatRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

function sessionKey(req: Request, body: OpenAIChatRequest): string {
  const header = req.header("x-cursor-session-id")?.trim();
  if (header) return `header:${header.slice(0, 256)}`;
  const seed = body.messages.find((message) => message.role === "user");
  const identity = body.user ?? req.ip ?? "anonymous";
  const digest = createHash("sha256").update(`${identity}\0${contentText(seed?.content ?? "")}`).digest("hex").slice(0, 32);
  return `default:${digest}`;
}

function writeSse(res: Response, payload: OpenAIChatChunk | "[DONE]"): void {
  if (!res.writableEnded) res.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

function chunk(
  requestId: string,
  model: string,
  delta: OpenAIChatChunk["choices"][number]["delta"],
  finishReason: OpenAIChatChunk["choices"][number]["finish_reason"] = null,
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function errorResponse(res: Response, status: number, message: string, type = "server_error"): void {
  if (!res.headersSent) res.status(status).json({ error: { message, type, code: null } });
}

export async function handleChatCompletions(req: Request, res: Response): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  try {
    if (!isAuthorized(req)) {
      errorResponse(res, 401, "Invalid proxy API key", "authentication_error");
      return;
    }
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      errorResponse(res, 400, "messages is required and must be a non-empty array", "invalid_request_error");
      return;
    }
    if (body.model && body.model !== MODEL_ID) {
      errorResponse(res, 400, `Unsupported Cursor model: ${body.model}`, "invalid_request_error");
      return;
    }

    const stream = body.stream === true;
    const model = MODEL_ID;
    const key = sessionKey(req, body);
    let sawRole = false;
    let text = "";
    let reasoning = "";
    const toolCalls: OpenAIToolCall[] = [];

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Request-Id", requestId);
      res.flushHeaders();
      res.write(":ok\n\n");
    }

    const result = await transport.execute(key, body, {
      onText: (delta) => {
        text += delta;
        if (stream) {
          writeSse(res, chunk(requestId, model, { ...(sawRole ? {} : { role: "assistant" }), content: delta }));
          sawRole = true;
        }
      },
      onReasoning: (delta) => {
        reasoning += delta;
        if (stream) writeSse(res, chunk(requestId, model, { reasoning_content: delta }));
      },
      onToolCall: (call) => {
        toolCalls.push(call);
        if (stream) {
          writeSse(res, chunk(requestId, model, {
            tool_calls: [{ index: toolCalls.length - 1, id: call.id, type: "function", function: call.function }],
          }));
        }
      },
    });

    if (stream) {
      writeSse(res, chunk(requestId, model, {}, result.status === "tool_calls" ? "tool_calls" : "stop"));
      writeSse(res, "[DONE]");
      if (!res.writableEnded) res.end();
      return;
    }

    const response: OpenAIChatResponse = {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: result.text || null,
          ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
        },
        finish_reason: result.status === "tool_calls" ? "tool_calls" : "stop",
      }],
      usage: {
        prompt_tokens: result.usage?.inputTokens ?? 0,
        completion_tokens: result.usage?.outputTokens ?? 0,
        total_tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      },
    };
    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[chat] id=${requestId} error=${message}`);
    if (res.headersSent) {
      if (!res.writableEnded) {
        writeSse(res, { id: `chatcmpl-${requestId}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        writeSse(res, "[DONE]");
        res.end();
      }
    } else {
      errorResponse(res, 500, message);
    }
  }
}

export function handleModels(_req: Request, res: Response): void {
  res.json({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "cursor", created: Math.floor(Date.now() / 1000) }] });
}

let cachedCliVersion: string | undefined;

export function setCachedCliVersion(version: string): void {
  cachedCliVersion = version;
}

export function handleHealth(_req: Request, res: Response): void {
  res.json({ status: "ok", provider: "cursor-agent-api-proxy", cli_version: cachedCliVersion ?? "unknown", timestamp: new Date().toISOString() });
}
