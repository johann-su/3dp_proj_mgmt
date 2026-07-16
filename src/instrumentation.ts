import { registerOTel } from "@vercel/otel";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { otlpConfigured } from "@/lib/telemetry";

export function register() {
  // Opt-in via the standard OTel env vars (OTEL_EXPORTER_OTLP_ENDPOINT et
  // al.) — see otlpConfigured for why we gate instead of always registering.
  // OTEL_SERVICE_NAME overrides the default name; @vercel/otel reads it.
  if (!otlpConfigured()) return;
  registerOTel({
    serviceName: "print-vault",
    // Keep "auto" (the fetch instrumentation) and add the pino bridge: it
    // stamps trace_id/span_id onto every log line and forwards records from
    // src/lib/logger.ts to the logger provider below.
    instrumentations: ["auto", new PinoInstrumentation()],
    // Both exporters default to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`
    // resp. `/v1/logs` over http/protobuf — same collector, all signals.
    metricReaders: [
      new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
    ],
  });
}
