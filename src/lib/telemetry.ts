import { SpanStatusCode, trace } from "@opentelemetry/api";

// Proxies to whatever TracerProvider instrumentation.ts registers later;
// without one every span call below is a free no-op.
const tracer = trace.getTracer("print-vault");

/**
 * Telemetry is opt-in: instrumentation.ts only registers the OTel SDK when an
 * OTLP endpoint is configured through the standard SDK env vars. Without this
 * gate @vercel/otel would still install itself and try to export every trace
 * to its default endpoint (http://localhost:4318) — silent failing POSTs on
 * every self-hosted deploy that doesn't run a collector.
 */
export function otlpConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(
    env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim(),
  );
}

/**
 * Log a swallowed error and record it on the trace, so operational failures
 * (slicer/OpenSCAD calls, integration APIs, background jobs) surface in the
 * tracing backend instead of only in container logs. Attaches to the active
 * request span when one is still recording; background work whose request
 * span already ended (`after()` jobs) gets a standalone error span. Safe to
 * call with telemetry disabled — the span operations no-op.
 */
export function reportError(message: string, err?: unknown): void {
  if (err === undefined) console.error(message);
  else console.error(message, err);

  const exception =
    err instanceof Error ? err : new Error(err === undefined ? message : String(err));
  const active = trace.getActiveSpan();
  if (active?.isRecording()) {
    active.recordException(exception);
    active.setStatus({ code: SpanStatusCode.ERROR, message });
    return;
  }
  const span = tracer.startSpan("error");
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.end();
}
