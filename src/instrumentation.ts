import { registerOTel } from "@vercel/otel";
import { otlpConfigured } from "@/lib/telemetry";

export function register() {
  // Opt-in via the standard OTel env vars (OTEL_EXPORTER_OTLP_ENDPOINT et
  // al.) — see otlpConfigured for why we gate instead of always registering.
  // OTEL_SERVICE_NAME overrides the default name; @vercel/otel reads it.
  if (!otlpConfigured()) return;
  registerOTel({ serviceName: "print-vault" });
}
