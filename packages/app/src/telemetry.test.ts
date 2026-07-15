import { expect, mock, test } from "bun:test"
import {
  captureRuntimeException,
  initializeRuntimeTelemetry,
  isRuntimeTelemetryEnabled,
  runtimeEnterpriseMode,
} from "./telemetry"

test("runtime telemetry policy cannot be overridden by configuration", () => {
  expect(isRuntimeTelemetryEnabled({ enterpriseMode: true, configured: true })).toBe(false)
  expect(isRuntimeTelemetryEnabled({ enterpriseMode: false, configured: true })).toBe(true)
  expect(isRuntimeTelemetryEnabled({ enterpriseMode: false, configured: false })).toBe(false)
})

test("enterprise bootstrap prevents initialization and manual capture", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const initialize = mock(() => {})
  const capture = mock(() => {})
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __OPENCODE__: { enterpriseMode: true } },
    })
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { querySelector: () => null },
    })
    expect(runtimeEnterpriseMode()).toBe(true)
    expect(initializeRuntimeTelemetry(true, initialize)).toBe(false)
    expect(captureRuntimeException(new Error("test"), capture)).toBe(false)
    expect(initialize).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else delete (globalThis as { window?: unknown }).window
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
    else delete (globalThis as { document?: unknown }).document
  }
})

test("non-enterprise configured telemetry remains reachable", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const initialize = mock(() => {})
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} })
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { querySelector: () => null },
    })
    expect(initializeRuntimeTelemetry(true, initialize)).toBe(true)
    expect(initialize).toHaveBeenCalledTimes(1)
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else delete (globalThis as { window?: unknown }).window
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
    else delete (globalThis as { document?: unknown }).document
  }
})
