export const ENTERPRISE_INFERENCE_ERROR = "Only the configured internal vLLM endpoint is allowed in enterprise mode"

export class EnterpriseInferencePolicyError extends Error {
  constructor() {
    super(ENTERPRISE_INFERENCE_ERROR)
    this.name = "EnterpriseInferencePolicyError"
  }
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
  if (input.npm !== "@ai-sdk/openai-compatible") return false
  if (!input.models || Object.keys(input.models).length === 0) return false
  const configured = normalizeEnterpriseBaseURL(input.baseURL)
  const allowed = normalizeEnterpriseBaseURL(input.allowedBaseURL)
  return configured !== undefined && configured === allowed
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
  const response = await transport(input, { ...init, redirect: "manual" })
  if (response.status >= 300 && response.status < 400) throw new EnterpriseInferencePolicyError()
  return response
}
