import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleMcpMessage,
  handleMcpPayload,
  ImageResult,
  InvalidParamsError,
  LATEST_PROTOCOL_VERSION,
  optionalInt,
  optionalString,
  optionalStringArray,
  requireUuid,
  ToolError,
  type McpDispatchOptions,
  type McpTool,
} from "@/lib/mcp/protocol";

const MODEL_ID = "11111111-2222-3333-4444-555555555555";

function options(tools: McpTool[] = [], onError?: McpDispatchOptions["onError"]) {
  return {
    tools,
    serverInfo: { name: "print-vault", title: "Print Vault", version: "0.1.0" },
    onError,
  };
}

function tool(run: McpTool["run"]): McpTool {
  return {
    name: "get_thing",
    title: "Get thing",
    description: "Gets a thing",
    inputSchema: { type: "object", properties: {} },
    run,
  };
}

function call(args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_thing", arguments: args },
  };
}

// A client speaking an older dialect keeps it; anything unrecognized is
// answered with ours so the client can decide whether it can live with it.
test("initialize echoes a supported protocol version and falls back otherwise", async () => {
  const known = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    options(),
  );
  assert.equal((known as { result: { protocolVersion: string } }).result.protocolVersion, "2024-11-05");

  const unknown = await handleMcpMessage(
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    options(),
  );
  assert.equal(
    (unknown as { result: { protocolVersion: string } }).result.protocolVersion,
    LATEST_PROTOCOL_VERSION,
  );
});

// Notifications (no id) must be acknowledged by the transport, never answered
// — `notifications/initialized` arrives right after every handshake.
test("notifications produce no response", async () => {
  assert.equal(
    await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, options()),
    null,
  );
  assert.equal(await handleMcpPayload([{ jsonrpc: "2.0", method: "ping" }], options()), null);
});

test("tools/list advertises each tool's schema", async () => {
  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    options([tool(async () => ({ ok: true }))]),
  );
  const { tools } = (response as { result: { tools: { name: string }[] } }).result;
  assert.deepEqual(
    tools.map((t) => t.name),
    ["get_thing"],
  );
});

// The payload goes out twice — as text for clients that only render content,
// and as structuredContent for those that can pass JSON to the model.
test("a tool result is returned as both text and structured content", async () => {
  const response = await handleMcpMessage(
    call(),
    options([tool(async () => ({ modelId: MODEL_ID }))]),
  );
  const result = (response as { result: { content: { text: string }[]; structuredContent: unknown } })
    .result;
  assert.deepEqual(result.structuredContent, { modelId: MODEL_ID });
  assert.deepEqual(JSON.parse(result.content[0].text), { modelId: MODEL_ID });
});

// A manual's wiring diagrams are pictures, and a link to them is not reliably
// fetchable by the client, so get_document_images sends the pixels back in the
// result itself. They ride as extra content blocks after the JSON.
test("a tool can return images alongside its JSON payload", async () => {
  const response = await handleMcpMessage(
    call(),
    options([
      tool(async () =>
        new ImageResult({ page: 17 }, [{ data: "aGVsbG8=", mimeType: "image/webp" }]),
      ),
    ]),
  );
  const result = (
    response as {
      result: {
        content: { type: string; text?: string; data?: string; mimeType?: string }[];
        structuredContent: unknown;
      };
    }
  ).result;

  assert.deepEqual(
    result.content.map((c) => c.type),
    ["text", "image"],
  );
  assert.deepEqual(result.content[1], {
    type: "image",
    data: "aGVsbG8=",
    mimeType: "image/webp",
  });
  // structuredContent stays pure JSON: a base64 blob in there would reach the
  // model as characters to read rather than as an image to look at.
  assert.deepEqual(result.structuredContent, { page: 17 });
});

// "No such model" is something the model can act on, so it comes back as a
// tool result with isError — not a protocol error that ends the exchange.
test("ToolError becomes an isError result, keeping the message", async () => {
  const response = await handleMcpMessage(
    call(),
    options([
      tool(async () => {
        throw new ToolError("No model with id 123");
      }),
    ]),
  );
  const result = (response as { result: { content: { text: string }[]; isError: boolean } }).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No model with id/);
});

// Bad arguments are the caller's protocol fault, so they get -32602 instead.
test("InvalidParamsError becomes a JSON-RPC invalid-params error", async () => {
  const response = await handleMcpMessage(
    call(),
    options([
      tool(async () => {
        throw new InvalidParamsError('"modelId" must be a model id');
      }),
    ]),
  );
  assert.equal((response as { error: { code: number } }).error.code, -32602);
});

// An unexpected failure must not leak internals to the model, but must still
// reach the error reporter.
test("an unexpected tool failure is reported and answered generically", async () => {
  const reported: string[] = [];
  const response = await handleMcpMessage(
    call(),
    options(
      [
        tool(async () => {
          throw new Error("connection terminated: password authentication failed");
        }),
      ],
      (message) => reported.push(message),
    ),
  );
  const result = (response as { result: { content: { text: string }[]; isError: boolean } }).result;
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /password/);
  assert.equal(reported.length, 1);
});

test("calling an unknown tool is a method-not-found error", async () => {
  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } },
    options(),
  );
  assert.equal((response as { error: { code: number } }).error.code, -32601);
});

// Older clients may batch; each request in the batch gets its own response.
test("a batch is answered with one response per request", async () => {
  const response = await handleMcpPayload(
    [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ],
    options(),
  );
  assert.deepEqual((response as { id: number }[]).map((r) => r.id), [1, 2]);
});

test("requireUuid rejects anything that isn't a model id", () => {
  assert.equal(requireUuid({ modelId: MODEL_ID }, "modelId"), MODEL_ID);
  assert.throws(() => requireUuid({ modelId: "the talon drone" }, "modelId"), InvalidParamsError);
  assert.throws(() => requireUuid({}, "modelId"), InvalidParamsError);
});

// Models routinely send a bare string where a list is asked for; blank entries
// would otherwise become a tag filter that matches nothing.
test("optionalStringArray accepts a lone string and drops blanks", () => {
  assert.deepEqual(optionalStringArray({ tags: "drone" }, "tags"), ["drone"]);
  assert.deepEqual(optionalStringArray({ tags: ["drone", " ", "fpv "] }, "tags"), [
    "drone",
    "fpv",
  ]);
  assert.deepEqual(optionalStringArray({}, "tags"), []);
});

test("optionalString treats blank as absent", () => {
  assert.equal(optionalString({ query: "  talon " }, "query"), "talon");
  assert.equal(optionalString({ query: "   " }, "query"), undefined);
});

// An over-large limit is a clear intent ("as many as possible"), so it is
// clamped rather than rejected.
test("optionalInt clamps to its range and falls back when absent", () => {
  const range = { min: 1, max: 50, fallback: 20 };
  assert.equal(optionalInt({ limit: 500 }, "limit", range), 50);
  assert.equal(optionalInt({ limit: 0 }, "limit", range), 1);
  assert.equal(optionalInt({}, "limit", range), 20);
  assert.throws(() => optionalInt({ limit: "many" }, "limit", range), InvalidParamsError);
});
