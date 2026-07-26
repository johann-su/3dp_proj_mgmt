// The wire side of the MCP server (issue #96): JSON-RPC 2.0 dispatch for MCP's
// Streamable HTTP transport, plus the argument readers every tool validates
// with. Deliberately hand-written and dependency-free — this server offers
// nothing but tools over plain request/response JSON, which is a few hundred
// lines of the transport, and keeping it here means it stays unit-testable
// (see protocol.test.ts) instead of hiding behind an SDK adapter.
//
// What the transport does and doesn't do:
//   * POST only. A server that never pushes messages to the client MUST answer
//     GET (the SSE stream) with 405, which the route does.
//   * The response is a single `application/json` JSON-RPC response, the mode
//     the spec allows in place of an event stream.
//   * Stateless: no `Mcp-Session-Id` is issued, so every request stands alone
//     and nothing has to survive between them (a self-hosted app has no shared
//     store to keep sessions in, and read-only tools need none).
//   * Notifications (no `id`) get an empty 202, per the spec.
//
// The DB-backed tools live in tools.ts; nothing here knows about them.

// Versions this server can speak, newest first. `initialize` echoes the
// client's version when it is one of these — an older client keeps its dialect
// — and otherwise answers with the newest, letting the client decide.
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// JSON-RPC error codes used here (the standard set; MCP adds no others).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export type JsonRpcId = string | number | null;

export type McpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpTool = {
  name: string;
  /** Human-readable name for client UIs. */
  title: string;
  /** Shown to the model — say what the tool answers, not how it works. */
  description: string;
  /** JSON Schema for `arguments`; the model builds calls from it. */
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  run: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export type McpServerInfo = { name: string; title: string; version: string };

export type McpDispatchOptions = {
  tools: McpTool[];
  serverInfo: McpServerInfo;
  /** Prepended to the client's context once, at initialize. */
  instructions?: string;
  /** Called for failures that aren't the caller's fault, for logging. */
  onError?: (message: string, err: unknown) => void;
};

/**
 * A failure the calling model should see and can act on ("no such model").
 * Reported as a tool result with `isError`, not a protocol error, so the
 * conversation continues.
 */
export class ToolError extends Error {}

/** Malformed arguments — a protocol-level fault, answered with -32602. */
export class InvalidParamsError extends Error {}

// --- Argument readers ------------------------------------------------------
//
// Tool arguments arrive as whatever JSON the model produced, so each reader
// states the contract and rejects the rest. They throw InvalidParamsError,
// which the dispatcher turns into -32602.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new InvalidParamsError(
      `"${name}" must be a model id (UUID) — use search_models to find one`,
    );
  }
  return value;
}

export function optionalString(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new InvalidParamsError(`"${name}" must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Tolerates a bare string where the schema asks for a list — models do that. */
export function optionalStringArray(
  args: Record<string, unknown>,
  name: string,
): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      throw new InvalidParamsError(`"${name}" must be a list of strings`);
    }
    const trimmed = entry.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/** Clamps rather than rejects an out-of-range count: the intent is still clear. */
export function optionalInt(
  args: Record<string, unknown>,
  name: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new InvalidParamsError(`"${name}" must be a number`);
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

// --- Dispatch --------------------------------------------------------------

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Tool payloads travel twice: as text (every client shows it to the model) and
// as `structuredContent` (clients that can hand the model real JSON). Both are
// the same object, so neither kind of client sees less.
function toolResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function toolFailure(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function negotiateVersion(requested: unknown): string {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(
    requested as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
  )
    ? (requested as string)
    : LATEST_PROTOCOL_VERSION;
}

async function callTool(
  params: Record<string, unknown>,
  options: McpDispatchOptions,
): Promise<{ result: unknown } | { code: number; message: string }> {
  const name = params.name;
  const tool = options.tools.find((t) => t.name === name);
  if (!tool) {
    return { code: METHOD_NOT_FOUND, message: `Unknown tool: ${String(name)}` };
  }
  const rawArgs = params.arguments;
  if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
    return { code: INVALID_PARAMS, message: "arguments must be an object" };
  }

  try {
    return { result: toolResult(await tool.run((rawArgs ?? {}) as Record<string, unknown>)) };
  } catch (err) {
    if (err instanceof InvalidParamsError) {
      return { code: INVALID_PARAMS, message: err.message };
    }
    if (err instanceof ToolError) {
      return { result: toolFailure(err.message) };
    }
    // A bug or an outage — tell the model something went wrong without
    // handing it a stack trace, and report it where errors are collected.
    options.onError?.(`[mcp] tool ${tool.name} failed`, err);
    return {
      result: toolFailure(`The ${tool.name} tool failed unexpectedly. Try again later.`),
    };
  }
}

/**
 * Handles one JSON-RPC message. Returns the response, or null when the message
 * was a notification (nothing to answer).
 */
export async function handleMcpMessage(
  message: unknown,
  options: McpDispatchOptions,
): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return fail(null, INVALID_REQUEST, "Expected a JSON-RPC object");
  }
  const { jsonrpc, method, id, params } = message as Record<string, unknown>;
  const responseId = (typeof id === "string" || typeof id === "number" ? id : null);
  // A message without an id is a notification: acknowledged by the transport
  // (202), never answered — including the `notifications/initialized` every
  // client sends right after the handshake.
  const isNotification = id === undefined || id === null;

  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return isNotification ? null : fail(responseId, INVALID_REQUEST, "Invalid JSON-RPC request");
  }
  if (isNotification) return null;

  const args = (typeof params === "object" && params !== null && !Array.isArray(params)
    ? params
    : {}) as Record<string, unknown>;

  switch (method) {
    case "initialize":
      return ok(responseId, {
        protocolVersion: negotiateVersion(args.protocolVersion),
        // Tools only: no resources, prompts, sampling or logging — the catalog
        // is exposed as calls, not as a browsable resource tree.
        capabilities: { tools: { listChanged: false } },
        serverInfo: options.serverInfo,
        ...(options.instructions ? { instructions: options.instructions } : {}),
      });
    case "ping":
      return ok(responseId, {});
    case "tools/list":
      return ok(responseId, {
        tools: options.tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      });
    case "tools/call": {
      const outcome = await callTool(args, options);
      return "result" in outcome
        ? ok(responseId, outcome.result)
        : fail(responseId, outcome.code, outcome.message);
    }
    default:
      return fail(responseId, METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

/**
 * Handles a whole request body — one message, or the JSON-RPC batch older
 * clients may send. Returns null when there is nothing to answer (a body of
 * notifications only), which the route turns into 202 Accepted.
 */
export async function handleMcpPayload(
  payload: unknown,
  options: McpDispatchOptions,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return fail(null, INVALID_REQUEST, "Empty batch");
    }
    const responses = (
      await Promise.all(payload.map((message) => handleMcpMessage(message, options)))
    ).filter((response) => response !== null);
    return responses.length > 0 ? responses : null;
  }
  return handleMcpMessage(payload, options);
}

/** The response body for a request whose JSON couldn't be parsed at all. */
export function parseErrorResponse() {
  return fail(null, PARSE_ERROR, "Invalid JSON");
}
