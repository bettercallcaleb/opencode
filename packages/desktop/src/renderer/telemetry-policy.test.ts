import { expect, mock, test } from "bun:test"
import { initializeRuntimeTelemetry } from "../../../app/src/telemetry"

test("desktop runtime enterprise initialization blocks configured Sentry", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const initialize = mock(() => {})
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __OPENCODE__: { enterpriseMode: true } },
    })
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { querySelector: () => null },
    })
    expect(initializeRuntimeTelemetry(true, initialize)).toBe(false)
    expect(initialize).not.toHaveBeenCalled()

    window.__OPENCODE__!.enterpriseMode = false
    expect(initializeRuntimeTelemetry(true, initialize)).toBe(true)
    expect(initialize).toHaveBeenCalledTimes(1)
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else delete (globalThis as { window?: unknown }).window
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
    else delete (globalThis as { document?: unknown }).document
  }
})
