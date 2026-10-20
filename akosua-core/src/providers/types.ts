export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for parameters. Descriptions here are a control surface:
   * they teach the model correct + safe use (nanoclaude lesson). */
  parameters: Record<string, unknown>;
}

export interface ToolCall { id: string; name: string; arguments: string; }

export interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string; // for role=tool results
  name?: string;       // tool name for role=tool
}

export interface TokenUsage { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "toolCall"; call: ToolCall }
  | { type: "done"; stopReason: string; usage?: TokenUsage; responseModel?: string };

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface ModelProvider {
  readonly id: "anthropic" | "openai";
  complete(req: CompletionRequest): AsyncIterable<StreamEvent>;
}

/** Injectable fetch so tests never hit the network. */
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; text(): Promise<string>;
  body?: AsyncIterable<Uint8Array> | null;
  json(): Promise<unknown>;
}>;
