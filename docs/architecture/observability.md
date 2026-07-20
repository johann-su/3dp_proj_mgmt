# Observability (OpenTelemetry, logging, metrics)

*Read before adding logging, error handling, or metrics. Update in the same PR
that changes this behaviour.*

(issue #63) Observability is opt-in OpenTelemetry — all three signals (traces,
metrics, logs) over one OTLP/HTTP (protobuf) endpoint: `src/instrumentation.ts`
registers `@vercel/otel` (automatic spans for every request, route handler and
outgoing fetch, plus a metric reader and log processor) **only when an OTLP
endpoint is configured** via the standard SDK env vars
(`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`;
`OTEL_SERVICE_NAME` overrides the default "print-vault"). The gate
(`otlpConfigured` in `src/lib/telemetry.ts`) exists because `@vercel/otel` is
*not* a no-op without configuration — it would install the SDK and POST every
trace to its `http://localhost:4318` default — and most self-hosters run no
collector; unset env = no telemetry, identical to `SLICER_URL`/`OPENSCAD_URL`
optionality. Point it at a collector's 4318 port (not gRPC 4317); the collector
fans signals out to the vendor backends (Prometheus/Loki/Tempo or similar) — the
app itself never speaks those protocols.

**Logging**: all server logging goes through the pino logger in
`src/lib/logger.ts` (`LOG_LEVEL` env, default "info") — never `console.*` —
which always writes JSON to stdout; with telemetry enabled,
`@opentelemetry/instrumentation-pino` stamps `trace_id`/`span_id` onto every
record and forwards it over OTLP, so log lines correlate with traces. Swallowed
operational errors (slicer/OpenSCAD calls, Onshape/Bambu routes, import jobs,
metrics counters, trash purge) go through `reportError(message, err)` in
`src/lib/telemetry.ts`, which logs via pino, bumps the `print_vault.errors`
counter, and records the exception on the active span — or on a standalone error
span when the request span already ended, as in `after()` background work — so
failures surface in the tracing backend; use it instead of a bare log call in
new catch-and-continue blocks.

**Metrics**: counters/histograms for slicer estimates, OpenSCAD renders and
collection-import designs live behind the `record*` helpers in
`src/lib/telemetry.ts` — instruments are created **lazily on first record**
because instrumentation.ts imports the module before `registerOTel()` installs
the global MeterProvider; creating one at module load would bind it to the no-op
meter forever. Follow that pattern (a helper in telemetry.ts, dot-named
`print_vault.*` instrument, low-cardinality attrs like `outcome`) when adding a
metric, and remember every helper must stay a free, non-throwing no-op on
deploys without a collector.
