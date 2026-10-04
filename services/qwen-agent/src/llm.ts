/**
 * Qwen 3.8 Max access via the DashScope OpenAI-compatible endpoint.
 *
 * Live mode posts to {QWEN_BASE_URL}/chat/completions with tool definitions.
 * Mock mode (no QWEN_API_KEY, or QWEN_MOCK=1) replays a scripted conversation
 * so the demo is reproducible offline — the agent loop itself is identical.
 */
import type { ChatMessage, ToolSpec } from "./types.js";

export interface LlmClient {
  readonly mode: "live" | "mock";
  readonly model: string;
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage>;
}

export class QwenClient implements LlmClient {
  readonly mode = "live" as const;

  constructor(
    readonly model: string,
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages, tools, tool_choice: "auto" }),
    });
    if (!res.ok) {
      throw new Error(`Qwen API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: Partial<ChatMessage> }[];
    };
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error("Qwen API returned no message");
    return {
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.tool_calls,
    };
  }
}

/**
 * Replays queued assistant turns regardless of input — used to record the demo
 * scenarios deterministically (and for CI without network access).
 */
export class ScriptedMock implements LlmClient {
  readonly mode = "mock" as const;
  private turns: ChatMessage[] = [];

  constructor(readonly model: string, scripted: ChatMessage[]) {
    this.turns = [...scripted];
  }

  async chat(_messages?: ChatMessage[], _tools?: ToolSpec[]): Promise<ChatMessage> {
    const next = this.turns.shift();
    if (!next) {
      return { role: "assistant", content: "No further actions; task complete." };
    }
    return next;
  }
}

export function createLlm(mode: "live" | "mock", model: string, baseUrl: string, apiKey?: string, scripted?: ChatMessage[]): LlmClient {
  if (mode === "mock") return new ScriptedMock(model, scripted ?? []);
  if (!apiKey) throw new Error("live Qwen mode requires QWEN_API_KEY");
  return new QwenClient(model, baseUrl, apiKey);
}

export function toolCall(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

export function thought(text: string, calls?: ChatMessage["tool_calls"]): ChatMessage {
  return { role: "assistant", content: text, tool_calls: calls };
}
