import { MCP_INSTRUCTIONS, MCP_TOOLS } from "@/lib/agent/catalog";
import { AgentToolError } from "@/lib/agent/tools";

export const MCP_SERVER_NAME = "toprock-crm";
export const MCP_SERVER_VERSION = "0.1.0";
export const MCP_SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;
export const MCP_DEFAULT_PROTOCOL = "2025-03-26";

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type McpToolCaller = (name: string, args: unknown) => Promise<unknown>;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export function negotiateProtocolVersion(requested: unknown) {
  if (typeof requested === "string" && (MCP_SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)) {
    return requested;
  }
  return MCP_DEFAULT_PROTOCOL;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.jsonrpc === "2.0" && typeof record.method === "string";
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function toolResult(payload: unknown, isError = false) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: typeof payload === "string" ? { text: payload } : payload,
    isError,
  };
}

function readToolCall(params: unknown) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw Object.assign(new Error("tools/call params must be an object."), { code: INVALID_PARAMS });
  }
  const record = params as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name) {
    throw Object.assign(new Error("tools/call requires params.name."), { code: INVALID_PARAMS });
  }
  return {
    name: record.name,
    args: record.arguments ?? {},
  };
}

export async function handleMcpMessage(
  message: JsonRpcRequest,
  callTool: McpToolCaller,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;

  try {
    switch (message.method) {
      case "initialize": {
        const params = (message.params ?? {}) as { protocolVersion?: unknown };
        return rpcResult(id, {
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION,
          },
          instructions: MCP_INSTRUCTIONS,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return isNotification ? null : rpcResult(id, {});
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: MCP_TOOLS });
      case "tools/call": {
        const { name, args } = readToolCall(message.params);
        try {
          const result = await callTool(name, args);
          return rpcResult(id, toolResult(result));
        } catch (error) {
          const messageText = error instanceof Error ? error.message : "Tool call failed.";
          const isUserError = error instanceof AgentToolError;
          if (isUserError) {
            return rpcResult(id, toolResult({ error: messageText }, true));
          }
          return rpcError(id, INTERNAL_ERROR, messageText);
        }
      }
      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "resources/templates/list":
        return rpcResult(id, { resourceTemplates: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });
      default:
        if (isNotification) {
          return null;
        }
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : INTERNAL_ERROR;
    const messageText = error instanceof Error ? error.message : "Internal error.";
    if (isNotification) {
      return null;
    }
    return rpcError(id, code, messageText);
  }
}

export async function handleMcpBody(body: unknown, callTool: McpToolCaller) {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { kind: "error" as const, status: 400, response: rpcError(null, INVALID_REQUEST, "Empty batch.") };
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      if (!isJsonRpcRequest(item)) {
        responses.push(rpcError(null, INVALID_REQUEST, "Invalid Request"));
        continue;
      }
      const response = await handleMcpMessage(item, callTool);
      if (response) {
        responses.push(response);
      }
    }
    if (responses.length === 0) {
      return { kind: "ack" as const, status: 202, response: null };
    }
    return { kind: "batch" as const, status: 200, response: responses };
  }

  if (!isJsonRpcRequest(body)) {
    return {
      kind: "error" as const,
      status: 400,
      response: rpcError(null, body == null ? PARSE_ERROR : INVALID_REQUEST, body == null ? "Parse error" : "Invalid Request"),
    };
  }

  const response = await handleMcpMessage(body, callTool);
  if (!response) {
    return { kind: "ack" as const, status: 202, response: null };
  }
  return { kind: "single" as const, status: 200, response };
}

export function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
