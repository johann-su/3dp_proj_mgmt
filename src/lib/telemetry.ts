import {
  metrics,
  SpanStatusCode,
  trace,
  type Counter,
  type Histogram,
} from "@opentelemetry/api";
import { logger } from "@/lib/logger";

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
  const exception =
    err instanceof Error ? err : new Error(err === undefined ? message : String(err));
  if (err === undefined) logger.error(message);
  else logger.error({ err: exception }, message);
  instruments().reportedErrors.add(1);

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

// --- Metrics -----------------------------------------------------------
//
// Instruments must be created lazily: instrumentation.ts imports this module
// *before* registerOTel() installs the global MeterProvider, so creating them
// at module load would bind them to the no-op meter forever. First use only
// happens inside request handling / after() work, which Next guarantees runs
// after register(). With telemetry disabled the no-op meter makes every
// record call free, mirroring the tracer above.

// Seconds-based buckets for service calls that range from sub-second STL
// previews to multi-minute slices — the SDK default boundaries are tuned for
// milliseconds and would lump everything into the first bucket.
const DURATION_BUCKETS_SECONDS = [0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900];

type Instruments = {
  sliceEstimates: Counter;
  sliceDuration: Histogram;
  openscadRenders: Counter;
  openscadDuration: Histogram;
  importedDesigns: Counter;
  reportedErrors: Counter;
};

let cachedInstruments: Instruments | null = null;

function instruments(): Instruments {
  if (!cachedInstruments) {
    const meter = metrics.getMeter("print-vault");
    const durationAdvice = {
      advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
    };
    cachedInstruments = {
      sliceEstimates: meter.createCounter("print_vault.slicer.estimates", {
        unit: "{file}",
        description:
          "Slice-estimate outcomes per model file (embedded predictions, slicer service results, failures)",
      }),
      sliceDuration: meter.createHistogram("print_vault.slicer.duration", {
        unit: "s",
        description: "Duration of slicer-service estimate calls",
        ...durationAdvice,
      }),
      openscadRenders: meter.createCounter("print_vault.openscad.renders", {
        unit: "{render}",
        description: "OpenSCAD service render outcomes",
      }),
      openscadDuration: meter.createHistogram("print_vault.openscad.duration", {
        unit: "s",
        description: "Duration of OpenSCAD service render calls",
        ...durationAdvice,
      }),
      importedDesigns: meter.createCounter("print_vault.import.designs", {
        unit: "{design}",
        description: "Per-design outcomes of MakerWorld collection import jobs",
      }),
      reportedErrors: meter.createCounter("print_vault.errors", {
        unit: "{error}",
        description: "Swallowed operational errors reported via reportError",
      }),
    };
  }
  return cachedInstruments;
}

/**
 * Outcome of estimating one model file:
 * - "embedded"     predictions read from the file's own slice_info.config
 * - "sliced"       the slicer service sliced it with a generic profile
 * - "failed"       the file itself can't be sliced (too large / rejected 4xx)
 * - "error"        the service errored (5xx)
 * - "unreachable"  the service couldn't be reached (stays pending)
 */
export type SliceOutcome = "embedded" | "sliced" | "failed" | "error" | "unreachable";

export function recordSliceEstimate(
  outcome: SliceOutcome,
  durationSeconds?: number,
): void {
  const i = instruments();
  i.sliceEstimates.add(1, { outcome });
  if (durationSeconds !== undefined) {
    i.sliceDuration.record(durationSeconds, { outcome });
  }
}

/** "rejected" = the .scad source was refused (4xx), "error" = service 5xx. */
export type RenderOutcome = "ok" | "rejected" | "error" | "unreachable";

export function recordOpenscadRender(
  format: "3mf" | "stl",
  outcome: RenderOutcome,
  durationSeconds: number,
): void {
  const i = instruments();
  i.openscadRenders.add(1, { format, outcome });
  i.openscadDuration.record(durationSeconds, { format, outcome });
}

/** Per-design outcome inside a MakerWorld collection import job. */
export function recordImportedDesign(
  outcome: "created" | "skipped" | "failed",
): void {
  instruments().importedDesigns.add(1, { outcome });
}
