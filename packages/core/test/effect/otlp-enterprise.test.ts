import { expect, spyOn, test } from "bun:test"
import { Layer } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { Flag } from "../../src/flag/flag"
import { loggers, tracingLayer } from "../../src/observability/otlp"

test("enterprise mode disables OTLP factories at invocation time", async () => {
  const original = {
    enterprise: Flag.OPENCODE_ENTERPRISE_MODE,
    endpoint: Flag.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: Flag.OTEL_EXPORTER_OTLP_HEADERS,
  }
  const make = spyOn(OtlpLogger, "make")
  try {
    Flag.OTEL_EXPORTER_OTLP_ENDPOINT = "https://telemetry.example.com"
    Flag.OTEL_EXPORTER_OTLP_HEADERS = "authorization=secret"
    Flag.OPENCODE_ENTERPRISE_MODE = true

    expect(loggers()).toEqual([])
    expect(await tracingLayer()).toBe(Layer.empty)
    expect(make).not.toHaveBeenCalled()

    Flag.OPENCODE_ENTERPRISE_MODE = false
    expect(loggers()).toHaveLength(1)
    expect(make).toHaveBeenCalledTimes(1)

    Flag.OPENCODE_ENTERPRISE_MODE = true
    expect(loggers()).toEqual([])
    expect(make).toHaveBeenCalledTimes(1)
  } finally {
    Flag.OPENCODE_ENTERPRISE_MODE = original.enterprise
    Flag.OTEL_EXPORTER_OTLP_ENDPOINT = original.endpoint
    Flag.OTEL_EXPORTER_OTLP_HEADERS = original.headers
    make.mockRestore()
  }
})
