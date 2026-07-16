import { test } from "node:test";
import assert from "node:assert/strict";
import { otlpConfigured, reportError } from "@/lib/telemetry";

// Telemetry is opt-in: a deploy without a collector must get zero telemetry,
// not failing exports to @vercel/otel's localhost default.
test("otlpConfigured is false when no OTLP endpoint env var is set", () => {
  assert.equal(otlpConfigured({}), false);
  assert.equal(otlpConfigured({ OTEL_SERVICE_NAME: "print-vault" }), false);
  // Set-but-empty (compose's `${VAR:-}` pattern) must not count as configured.
  assert.equal(otlpConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }), false);
  assert.equal(otlpConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " }), false);
});

test("otlpConfigured accepts either the generic or the traces-specific endpoint", () => {
  assert.equal(
    otlpConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://alloy:4318" }),
    true,
  );
  assert.equal(
    otlpConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://alloy:4318/v1/traces" }),
    true,
  );
});

// reportError runs in catch blocks on every deploy, including the majority
// with telemetry disabled — it must never throw, whatever it's handed.
test("reportError is safe without a registered OTel SDK", () => {
  reportError("plain message");
  reportError("with an Error", new Error("boom"));
  reportError("with a non-Error throw", "string reason");
});
