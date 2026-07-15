export function isRuntimeTelemetryEnabled(input: { enterpriseMode: boolean; configured: boolean }) {
  return input.configured && !input.enterpriseMode
}

export function runtimeEnterpriseMode() {
  if (typeof window !== "object") return false
  if (window.__OPENCODE__?.enterpriseMode === true) return true
  if (typeof document !== "object") return false
  return document.querySelector('meta[name="opencode-enterprise-mode"]')?.getAttribute("content") === "true"
}

export function initializeRuntimeTelemetry(configured: boolean, initialize: () => void) {
  if (!isRuntimeTelemetryEnabled({ enterpriseMode: runtimeEnterpriseMode(), configured })) return false
  initialize()
  return true
}

export function captureRuntimeException(error: unknown, capture: (error: unknown) => void) {
  if (runtimeEnterpriseMode()) return false
  capture(error)
  return true
}
