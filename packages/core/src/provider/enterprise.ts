import { AsyncLocalStorage } from "node:async_hooks"

export const ENTERPRISE_INFERENCE_ERROR = "Only the configured internal vLLM endpoint is allowed in enterprise mode"

export class EnterpriseInferencePolicyError extends Error {
  constructor() {
    super(ENTERPRISE_INFERENCE_ERROR)
    this.name = "EnterpriseInferencePolicyError"
  }
}

export function enterpriseEndpointURL(baseURL: string, endpoint: string) {
  const base = parseEnterpriseVllmBaseURL(baseURL)
  if (!base) throw new EnterpriseInferencePolicyError()
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`
  return url
}

export type EnterpriseInferenceObserver = {
  request?: (input: string | URL | Request, init: RequestInit | undefined) => void | Promise<void>
  response?: (response: unknown) => void | Promise<void>
}

const observerStorage = new AsyncLocalStorage<EnterpriseInferenceObserver>()

export function withEnterpriseInferenceObserver<T>(observer: EnterpriseInferenceObserver, callback: () => Promise<T>) {
  return observerStorage.run(observer, callback)
}

export type EnterpriseProviderPolicyCheck = {
  code: string
  status: "pass" | "fail" | "warning" | "info"
  message: string
  actual?: string
  expected?: string
  detail?: Record<string, string>
}

export type EnterpriseProviderPolicyDiagnostic = {
  allowed: boolean
  checks: EnterpriseProviderPolicyCheck[]
}

const unresolved = /\$\{[^}]+\}|\{env:[^}]+\}/

function safeURL(value: string | undefined) {
  if (!value) return "missing"
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`
  } catch {
    return "invalid URL"
  }
}

function effectivePort(url: URL) {
  return url.port || (url.protocol === "http:" ? "80" : url.protocol === "https:" ? "443" : "")
}

function diagnoseURL(value: string | undefined, subject: "PROVIDER" | "ENTERPRISE") {
  const checks: EnterpriseProviderPolicyCheck[] = []
  const prefix = subject === "PROVIDER" ? "PROVIDER_BASE_URL" : "ENTERPRISE_BASE_URL"
  if (!value) {
    checks.push({
      code: `${prefix}_MISSING`,
      status: "fail",
      message: `${subject === "PROVIDER" ? "Provider" : "Enterprise"} base URL is missing.`,
    })
    return { checks }
  }
  checks.push({
    code: `${prefix}_PRESENT`,
    status: "pass",
    message: `${subject === "PROVIDER" ? "Provider" : "Enterprise"} base URL is configured.`,
    actual: safeURL(value),
  })
  if (unresolved.test(value)) {
    checks.push({
      code: subject === "PROVIDER" ? "PROVIDER_BASE_URL_UNRESOLVED" : `${prefix}_INVALID`,
      status: "fail",
      message: "Base URL contains an unresolved environment placeholder.",
      actual: "unresolved placeholder",
    })
    return { checks }
  }
  if (value.startsWith("//")) {
    checks.push({
      code: `${prefix}_INVALID`,
      status: "fail",
      message: "Protocol-relative base URLs are not allowed.",
      actual: "protocol-relative URL",
    })
    return { checks }
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    checks.push({ code: `${prefix}_INVALID`, status: "fail", message: "Base URL is malformed.", actual: "invalid URL" })
    return { checks }
  }
  if (url.username || url.password)
    checks.push({
      code: subject === "PROVIDER" ? "PROVIDER_BASE_URL_CREDENTIALS_REJECTED" : `${prefix}_INVALID`,
      status: "fail",
      message: "Credentials in a base URL are not allowed.",
      actual: safeURL(value),
    })
  if (url.search)
    checks.push({
      code: subject === "PROVIDER" ? "PROVIDER_BASE_URL_QUERY_REJECTED" : `${prefix}_INVALID`,
      status: "fail",
      message: "Query parameters in a base URL are not allowed.",
      actual: `${safeURL(value)}?…`,
    })
  if (url.hash)
    checks.push({
      code: subject === "PROVIDER" ? "PROVIDER_BASE_URL_HASH_REJECTED" : `${prefix}_INVALID`,
      status: "fail",
      message: "Fragments in a base URL are not allowed.",
      actual: `${safeURL(value)}#…`,
    })
  if (url.protocol !== "http:" && url.protocol !== "https:")
    checks.push({
      code: subject === "PROVIDER" ? "PROVIDER_BASE_URL_SCHEME_REJECTED" : `${prefix}_INVALID`,
      status: "fail",
      message: "Only HTTP and HTTPS base URLs are allowed.",
      actual: url.protocol,
    })
  if (checks.some((check) => check.status === "fail")) return { checks }
  checks.push({ code: `${prefix}_VALID`, status: "pass", message: "Base URL is valid.", actual: safeURL(value) })
  return { checks, url }
}

export function diagnoseEnterpriseBaseURL(value: string | undefined) {
  return diagnoseURL(value, "ENTERPRISE").checks
}

export function diagnoseEnterpriseProviderPolicy(input: {
  npm: string | undefined
  baseURL: string | undefined
  models: Record<string, unknown> | undefined
  allowedBaseURL: string | undefined
}): EnterpriseProviderPolicyDiagnostic {
  const checks: EnterpriseProviderPolicyCheck[] = []
  checks.push(
    input.npm === "@ai-sdk/openai-compatible"
      ? {
          code: "PROVIDER_NPM_VALID",
          status: "pass",
          message: "Provider package is OpenAI-compatible.",
          actual: input.npm,
        }
      : input.npm
        ? {
            code: "PROVIDER_NPM_MISMATCH",
            status: "fail",
            message: "Provider package is not allowed in enterprise mode.",
            actual: input.npm,
            expected: "@ai-sdk/openai-compatible",
          }
        : {
            code: "PROVIDER_NPM_MISSING",
            status: "fail",
            message: "Provider package is missing.",
            expected: "@ai-sdk/openai-compatible",
          },
  )
  checks.push(
    input.models && Object.keys(input.models).length > 0
      ? {
          code: "PROVIDER_MODELS_PRESENT",
          status: "pass",
          message: "Provider has explicit models.",
          actual: String(Object.keys(input.models).length),
        }
      : { code: "PROVIDER_MODELS_EMPTY", status: "fail", message: "Provider must declare at least one model." },
  )
  const configured = diagnoseURL(input.baseURL, "PROVIDER")
  const allowed = diagnoseURL(input.allowedBaseURL, "ENTERPRISE")
  checks.push(...configured.checks, ...allowed.checks)
  if (configured.url && allowed.url) {
    const comparisons = [
      [
        "BASE_URL_SCHEME_MISMATCH",
        "protocol",
        configured.url.protocol.toLowerCase(),
        allowed.url.protocol.toLowerCase(),
      ],
      ["BASE_URL_HOST_MISMATCH", "hostname", configured.url.hostname.toLowerCase(), allowed.url.hostname.toLowerCase()],
      ["BASE_URL_PORT_MISMATCH", "effective port", effectivePort(configured.url), effectivePort(allowed.url)],
      [
        "BASE_URL_PATH_MISMATCH",
        "path",
        configured.url.pathname.replace(/\/+$/, ""),
        allowed.url.pathname.replace(/\/+$/, ""),
      ],
    ] as const
    const mismatches = comparisons.filter((item) => item[2] !== item[3])
    checks.push(
      ...mismatches.map(([code, component, actual, expected]) => ({
        code,
        status: "fail" as const,
        message: `Base URL ${component} does not match.`,
        actual,
        expected,
      })),
    )
    if (mismatches.length === 0)
      checks.push({
        code: "BASE_URL_MATCH",
        status: "pass",
        message: "Provider base URL matches the enterprise base URL.",
        actual: safeURL(input.baseURL),
      })
  }
  return { allowed: !checks.some((check) => check.status === "fail"), checks }
}

export function parseEnterpriseVllmBaseURL(value: string | undefined) {
  if (!value) return
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    if (url.username || url.password) return
    if (url.search || url.hash) return
    return url
  } catch {
    return
  }
}

export function normalizeEnterpriseBaseURL(value: string | undefined) {
  const url = parseEnterpriseVllmBaseURL(value)
  if (!url) return
  return url.href.replace(/\/+$/, "")
}

export function isEnterpriseProviderAllowed(input: {
  npm: string | undefined
  baseURL: string | undefined
  models: Record<string, unknown> | undefined
  allowedBaseURL: string | undefined
}) {
  return diagnoseEnterpriseProviderPolicy(input).allowed
}

export function assertEnterpriseRequestURL(input: string | URL | Request, allowedBaseURL: string | undefined) {
  const allowed = parseEnterpriseVllmBaseURL(allowedBaseURL)
  if (!allowed) throw new EnterpriseInferencePolicyError()

  const raw = input instanceof Request ? input.url : input.toString()
  if (raw.startsWith("//")) throw new EnterpriseInferencePolicyError()

  let request: URL
  try {
    request = new URL(raw)
  } catch {
    throw new EnterpriseInferencePolicyError()
  }

  if (request.protocol !== allowed.protocol || request.hostname !== allowed.hostname || request.port !== allowed.port)
    throw new EnterpriseInferencePolicyError()
  if (request.username || request.password) throw new EnterpriseInferencePolicyError()

  let path: string
  try {
    path = decodeURIComponent(request.pathname)
  } catch {
    throw new EnterpriseInferencePolicyError()
  }
  if (path.split("/").includes("..")) throw new EnterpriseInferencePolicyError()

  const basePath = allowed.pathname.replace(/\/+$/, "")
  if (path !== basePath && !path.startsWith(`${basePath}/`)) throw new EnterpriseInferencePolicyError()
  return request
}

export async function enterpriseInferenceFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  allowedBaseURL: string | undefined,
  transport: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  assertEnterpriseRequestURL(input, allowedBaseURL)
  const observer = observerStorage.getStore()
  await observer?.request?.(input, init)
  const response = await transport(input, { ...init, redirect: "manual" })
  await observer?.response?.(response.clone())
  if (response.status >= 300 && response.status < 400) throw new EnterpriseInferencePolicyError()
  return response
}
