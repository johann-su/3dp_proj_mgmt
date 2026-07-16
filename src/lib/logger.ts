// Structured logger for all server-side logging (use this, not console.*).
// Always writes JSON lines to stdout — container logs stay the baseline sink.
// When telemetry is enabled, @opentelemetry/instrumentation-pino (registered
// in src/instrumentation.ts) additionally stamps trace_id/span_id onto every
// record and forwards it over OTLP, so log lines land in the logging backend
// correlated with their trace. Pipe dev output through `npx pino-pretty` for
// human-readable logs.

import pino from "pino";

const LEVELS = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

// A typo'd LOG_LEVEL must not crash the server at boot (pino throws on
// unknown levels) — fall back to "info" instead.
const envLevel = process.env.LOG_LEVEL?.trim().toLowerCase();

export const logger = pino({
  level: envLevel && LEVELS.has(envLevel) ? envLevel : "info",
  // Emit the level as its label ("error"), not pino's numeric default (50):
  // log scrapers (Loki et al.) only auto-detect severity from a string field.
  formatters: { level: (label) => ({ level: label }) },
});
