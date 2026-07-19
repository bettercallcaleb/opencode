import os from "node:os"
import { lookup } from "node:dns/promises"
import { createConnection } from "node:net"
import { connect as connectTLS } from "node:tls"
import { existsSync } from "node:fs"
import { enterpriseEndpointURL, assertEnterpriseRequestURL } from "@opencode-ai/core/provider/enterprise"
import type { DoctorCheck } from "./doctor-report"

export type ProbeLevel = "transport" | "api" | "sdk" | "full"
export type ProbeCategory =
  | "dns"
  | "tcp"
  | "tls"
  | "proxy"
  | "certificate"
  | "routing"
  | "redirect"
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "gateway"
  | "backend"
  | "content_type"
  | "json"
  | "schema"
  | "model"
  | "chat"
  | "streaming"
  | "sdk_compatibility"
  | "tool_call"
  | "timeout"
  | "unknown"

export type ProbeStage = {
  id: string
  status: "pass" | "fail" | "warning" | "skipped" | "info"
  timingMs?: number
  checks: DoctorCheck[]
  detail?: Record<string, unknown>
  categories?: ProbeCategory[]
}

export type SDKObservation = {
  resolutionFailure?: "provider" | "model"
  request?: {
    method: string
    url: string
    headerNames: string[]
    fields: string[]
    nestedFields: string[]
    fieldTypes: Record<string, string>
    bodyBytes: number
    bodySha256: string
  }
  response?: { status: number; contentType?: string; bodyBytes: number; bodySha256: string }
}

export type VllmProbeReport = {
  version: 1
  level: ProbeLevel
  target: { scheme: string; hostname: string; effectivePort: number; path: string }
  environment: ReturnType<typeof environmentReport>
  stages: ProbeStage[]
  summary: {
    status: "pass" | "fail"
    firstFailureStage?: string
    errorCategories: ProbeCategory[]
  }
}

type ProbeSocket = {
  destroy(): void
  setTimeout(milliseconds: number, callback: () => void): unknown
  once(event: "connect", callback: () => void): unknown
  once(event: "error", callback: (error: unknown) => void): unknown
}

type ProbeTlsSocket = Omit<ProbeSocket, "once"> & {
  once(event: "secureConnect", callback: () => void): unknown
  once(event: "error", callback: (error: unknown) => void): unknown
  getPeerCertificate(): {
    subject?: { CN?: string }
    issuer?: { CN?: string }
    valid_from?: string
    valid_to?: string
    fingerprint256?: string
  }
  getCipher(): { name: string }
  getProtocol(): string | null
}

export type DoctorProbeTestDependencies = {
  lookup(hostname: string): Promise<{ address: string; family: number }[]>
  tcpConnect(options: { host: string; port: number; family: number }): ProbeSocket
  tlsConnect(options: { host: string; port: number; servername: string; rejectUnauthorized: true }): ProbeTlsSocket
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

type ProbeInput = {
  level: ProbeLevel
  timeoutMs: number
  baseURL: string
  apiModelID: string
  apiKey?: string
  headers?: Record<string, string>
  toolCallSupported: boolean
  sdk?: (signal: AbortSignal) => Promise<{ text: string; observation: SDKObservation }>
  testDependencies?: Partial<DoctorProbeTestDependencies>
}

const defaultDependencies: DoctorProbeTestDependencies = {
  lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  tcpConnect: (options) => createConnection(options),
  tlsConnect: (options) => connectTLS(options),
  fetch: (input, init) => fetch(input, init),
}

const safeResponseHeaders = [
  "content-type",
  "content-length",
  "date",
  "server",
  "via",
  "x-request-id",
  "traceparent",
  "retry-after",
]

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function safeURL(value: string | URL) {
  const url = new URL(value)
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`
}

function effectivePort(url: URL) {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80))
}

function sanitizePreview(value: string, secrets: string[]) {
  return secrets
    .filter(Boolean)
    .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value.replace(/<[^>]*>/g, " "))
    .replace(/([?&][^\s=]+)=([^\s&]+)/g, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return "UNKNOWN"
  return String(error.code)
}

function errorCategory(code: string): ProbeCategory {
  if (code.includes("TIMEOUT")) return "timeout"
  if (["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(code)) return "dns"
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "tcp"
  if (code.includes("CERT") || code.includes("SELF_SIGNED")) return "certificate"
  return "unknown"
}

export function classifyDoctorProbeTlsError(error: unknown) {
  const code = errorCode(error)
  const check = /ALTNAME|HOSTNAME/.test(code)
    ? "TLS_HOSTNAME_MISMATCH"
    : code.includes("EXPIRED")
      ? "TLS_CERTIFICATE_EXPIRED"
      : code.includes("NOT_YET")
        ? "TLS_CERTIFICATE_NOT_YET_VALID"
        : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)
          ? "TLS_CERTIFICATE_UNTRUSTED"
          : code === "PROBE_TIMEOUT"
            ? "TLS_HANDSHAKE_TIMEOUT"
            : "TLS_HANDSHAKE_FAIL"
  return {
    code,
    check,
    category:
      check.includes("CERTIFICATE") || check === "TLS_HOSTNAME_MISMATCH"
        ? "certificate"
        : code === "PROBE_TIMEOUT"
          ? "timeout"
          : "tls",
  } as const
}

function environmentReport(baseURL: string, apiKey?: string, headers?: Record<string, string>) {
  const url = new URL(baseURL)
  const proxy = (name: string) => {
    const value = process.env[name]
    if (!value) return { set: false }
    if (name.toLowerCase() === "no_proxy") return { set: true }
    try {
      return { set: true, value: safeURL(value) }
    } catch {
      return { set: true, value: "invalid or non-URL value" }
    }
  }
  const certificate = (name: string) => {
    const value = process.env[name]
    return { set: Boolean(value), pathExists: value ? existsSync(value) : false }
  }
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    endpoint: {
      scheme: url.protocol.replace(":", ""),
      hostname: url.hostname,
      effectivePort: effectivePort(url),
      path: url.pathname,
    },
    proxies: Object.fromEntries(
      ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"].map(
        (name) => [name, proxy(name)],
      ),
    ),
    certificates: {
      NODE_EXTRA_CA_CERTS: certificate("NODE_EXTRA_CA_CERTS"),
      SSL_CERT_FILE: certificate("SSL_CERT_FILE"),
      SSL_CERT_DIR: certificate("SSL_CERT_DIR"),
    },
    authentication: {
      apiKey: !apiKey
        ? "missing"
        : /\$\{[^}]+\}|\{env:[^}]+\}/.test(apiKey)
          ? "configured through environment substitution"
          : "configured directly",
      authorizationHeader: Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization"),
      customHeaderNames: Object.keys(headers ?? {}).sort(),
    },
  }
}

function timeout<T>(operation: Promise<T>, milliseconds: number, cleanup?: () => void) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup?.()
      const error = new Error("operation timed out") as Error & { code: string }
      error.code = "PROBE_TIMEOUT"
      reject(error)
    }, milliseconds)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function dnsStage(hostname: string, timeoutMs: number, dependencies: DoctorProbeTestDependencies) {
  const started = performance.now()
  try {
    const addresses = await timeout(dependencies.lookup(hostname), timeoutMs)
    const unique = addresses.filter(
      (item, index) => addresses.findIndex((other) => other.address === item.address) === index,
    )
    const checks: DoctorCheck[] = [
      { code: "DNS_RESOLUTION_PASS", status: "pass", message: `Resolved ${hostname}.` },
      ...(unique.some((item) => item.family === 4)
        ? [{ code: "DNS_IPV4_FOUND", status: "pass" as const, message: "IPv4 addresses were returned." }]
        : []),
      ...(unique.some((item) => item.family === 6)
        ? [{ code: "DNS_IPV6_FOUND", status: "pass" as const, message: "IPv6 addresses were returned." }]
        : []),
    ]
    if (!unique.length) checks.push({ code: "DNS_NO_ADDRESSES", status: "fail", message: "DNS returned no addresses." })
    return {
      stage: {
        id: "dns",
        status: unique.length ? ("pass" as const) : ("fail" as const),
        timingMs: performance.now() - started,
        checks,
        detail: { addresses: unique },
        categories: unique.length ? [] : ["dns" as const],
      },
      addresses: unique,
    }
  } catch (error) {
    const code = errorCode(error)
    return {
      stage: {
        id: "dns",
        status: "fail" as const,
        timingMs: performance.now() - started,
        checks: [
          {
            code: code === "PROBE_TIMEOUT" ? "DNS_RESOLUTION_TIMEOUT" : "DNS_RESOLUTION_FAIL",
            status: "fail" as const,
            message: `DNS resolution failed (${code}).`,
            actual: code,
          },
        ],
        categories: [errorCategory(code)],
      },
      addresses: [] as { address: string; family: number }[],
    }
  }
}

async function tcpStage(
  addresses: { address: string; family: number }[],
  port: number,
  timeoutMs: number,
  dependencies: DoctorProbeTestDependencies,
) {
  if (!addresses.length)
    return {
      id: "tcp",
      status: "skipped" as const,
      checks: [
        {
          code: "TCP_CONNECT_FAIL",
          status: "info" as const,
          message: "TCP skipped because DNS returned no addresses.",
        },
      ],
      categories: ["dns" as const],
    }
  const started = performance.now()
  const attempts: { address: string; family: number; connected: boolean; elapsedMs: number; code?: string }[] = []
  for (const address of addresses) {
    const result = await new Promise<{
      address: string
      family: number
      connected: boolean
      elapsedMs: number
      code?: string
    }>((resolve) => {
      const attempt = performance.now()
      const socket = dependencies.tcpConnect({ host: address.address, port, family: address.family })
      const finish = (connected: boolean, code?: string) => {
        socket.destroy()
        resolve({ ...address, connected, elapsedMs: performance.now() - attempt, code })
      }
      socket.setTimeout(timeoutMs, () => finish(false, "PROBE_TIMEOUT"))
      socket.once("connect", () => finish(true))
      socket.once("error", (error) => finish(false, errorCode(error)))
    })
    attempts.push(result)
  }
  const passed = attempts.some((item) => item.connected)
  return {
    id: "tcp",
    status: passed ? ("pass" as const) : ("fail" as const),
    timingMs: performance.now() - started,
    checks: [
      ...attempts.map((item) => ({
        code: item.connected
          ? "TCP_CONNECT_PASS"
          : item.code === "PROBE_TIMEOUT"
            ? "TCP_CONNECT_TIMEOUT"
            : "TCP_CONNECT_FAIL",
        status: item.connected ? ("pass" as const) : ("fail" as const),
        message: `${item.address}:${port} ${item.connected ? "connected" : `failed (${item.code})`}.`,
        detail: {
          address: item.address,
          family: String(item.family),
          port: String(port),
          elapsedMs: String(Math.round(item.elapsedMs)),
        },
      })),
      ...(!passed
        ? [
            {
              code: "TCP_ALL_ADDRESSES_FAILED",
              status: "fail" as const,
              message: "All resolved addresses failed TCP connection.",
            },
          ]
        : []),
    ],
    detail: { attempts },
    categories: passed ? [] : ["tcp" as const],
  }
}

async function tlsStage(
  url: URL,
  addresses: { address: string; family: number }[],
  timeoutMs: number,
  tcpPassed: boolean,
  dependencies: DoctorProbeTestDependencies,
): Promise<ProbeStage> {
  if (url.protocol === "http:")
    return {
      id: "tls",
      status: "info",
      checks: [{ code: "TLS_NOT_APPLICABLE", status: "info", message: "TLS is not applicable to HTTP." }],
    }
  if (!addresses.length)
    return {
      id: "tls",
      status: "skipped",
      checks: [{ code: "TLS_HANDSHAKE_FAIL", status: "info", message: "TLS skipped because DNS failed." }],
      categories: ["dns"],
    }
  if (!tcpPassed)
    return {
      id: "tls",
      status: "skipped",
      checks: [{ code: "TLS_HANDSHAKE_FAIL", status: "info", message: "TLS skipped because TCP failed." }],
      categories: ["tcp"],
    }
  const started = performance.now()
  const socket = dependencies.tlsConnect({
    host: addresses[0].address,
    port: effectivePort(url),
    servername: url.hostname.replace(/^\[|\]$/g, ""),
    rejectUnauthorized: true,
  })
  try {
    await timeout(
      new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve)
        socket.once("error", reject)
      }),
      timeoutMs,
      () => socket.destroy(),
    )
    const certificate = socket.getPeerCertificate()
    const cipher = socket.getCipher()
    const protocol = socket.getProtocol()
    socket.destroy()
    return {
      id: "tls",
      status: "pass",
      timingMs: performance.now() - started,
      checks: [
        { code: "TLS_HANDSHAKE_PASS", status: "pass", message: "TLS handshake and certificate validation passed." },
      ],
      detail: {
        authorityNote: "Low-level Node TLS diagnostics may differ from Bun fetch; guarded Bun fetch is authoritative.",
        protocol,
        cipher: cipher.name,
        subjectCommonName: certificate.subject?.CN,
        issuerCommonName: certificate.issuer?.CN,
        validFrom: certificate.valid_from,
        validTo: certificate.valid_to,
        fingerprintSha256: certificate.fingerprint256,
        hostnameValidation: true,
        certificateTrust: true,
      },
    }
  } catch (error) {
    socket.destroy()
    const failure = classifyDoctorProbeTlsError(error)
    return {
      id: "tls",
      status: "fail",
      timingMs: performance.now() - started,
      checks: [
        {
          code: failure.check,
          status: "fail",
          message: `TLS handshake failed (${failure.code}).`,
          actual: failure.code,
        },
      ],
      detail: {
        authorityNote: "Low-level Node TLS diagnostics may differ from Bun fetch; guarded Bun fetch is authoritative.",
        hostname: url.hostname,
        address: addresses[0].address,
        hostnameValidation: failure.check === "TLS_HOSTNAME_MISMATCH" ? false : undefined,
        certificateTrust: failure.check === "TLS_HOSTNAME_MISMATCH" ? true : undefined,
      },
      categories: [failure.category],
    }
  }
}

function requestHeaders(input: ProbeInput) {
  const headers = new Headers(input.headers)
  headers.set("accept", "application/json")
  if (!headers.has("authorization") && input.apiKey) headers.set("authorization", `Bearer ${input.apiKey}`)
  return headers
}

function secretValues(input: ProbeInput) {
  return [input.apiKey, ...Object.values(input.headers ?? {})].filter((value): value is string => Boolean(value))
}

async function guardedFetch(input: ProbeInput, endpoint: string, init: RequestInit) {
  const url = enterpriseEndpointURL(input.baseURL, endpoint)
  assertEnterpriseRequestURL(url, input.baseURL)
  const started = performance.now()
  const controller = new AbortController()
  const response = await timeout(
    (input.testDependencies?.fetch ?? defaultDependencies.fetch)(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    }),
    input.timeoutMs,
    () => controller.abort(),
  )
  return { url, response, timingMs: performance.now() - started, abort: () => controller.abort() }
}

function readBody(result: { response: Response; abort: () => void }, timeoutMs: number) {
  return timeout(result.response.text(), timeoutMs, result.abort)
}

function redirectChecks(prefix: string, response: Response, requestURL: URL): DoctorCheck[] {
  if (response.status < 300 || response.status >= 400) return []
  const location = response.headers.get("location")
  let detail: Record<string, string> | undefined
  if (location) {
    try {
      const target = new URL(location, requestURL)
      detail = {
        location: safeURL(target),
        sameOrigin: String(target.origin === requestURL.origin),
        differentHostname: String(target.hostname !== requestURL.hostname),
        differentPort: String(effectivePort(target) !== effectivePort(requestURL)),
        differentScheme: String(target.protocol !== requestURL.protocol),
        loginLooking: String(/login|signin|sso|oauth/i.test(target.pathname)),
      }
    } catch {
      detail = { location: "invalid URL" }
    }
  }
  return [
    { code: `${prefix}_REDIRECT_REJECTED`, status: "fail", message: "Redirect was rejected and not followed.", detail },
    { code: "PROBE_REDIRECT_REJECTED", status: "fail", message: "Probe redirects are never followed." },
  ]
}

function responseMetadata(response: Response, body: string) {
  const authenticate = response.headers.get("www-authenticate")
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
    contentLength: response.headers.get("content-length") ?? undefined,
    responseHeaders: Object.fromEntries(
      safeResponseHeaders.flatMap((name) => (response.headers.has(name) ? [[name, response.headers.get(name)]] : [])),
    ),
    bodyBytes: Buffer.byteLength(body),
    bodySha256: hash(body),
    authenticationScheme: authenticate?.match(/^\s*([^\s,]+)/)?.[1],
  }
}

function requestMetadata(url: URL, method: string, headers: Headers) {
  return { url: safeURL(url), method, headerNames: [...headers.keys()].sort() }
}

function statusCategory(status: number): ProbeCategory {
  if (status === 401) return "authentication"
  if (status === 403) return "authorization"
  if (status === 404 || status === 405) return "routing"
  if (status === 429) return "rate_limit"
  if ([502, 503, 504].includes(status)) return "gateway"
  if (status >= 500) return "backend"
  return "unknown"
}

async function modelsStage(input: ProbeInput) {
  try {
    const result = await guardedFetch(input, "models", { method: "GET", headers: requestHeaders(input) })
    const body = await readBody(result, input.timeoutMs)
    const redirects = redirectChecks("MODELS", result.response, result.url)
    if (redirects.length)
      return {
        id: "models",
        status: "fail" as const,
        timingMs: result.timingMs,
        checks: redirects,
        detail: responseMetadata(result.response, body),
        categories: ["redirect" as const],
      }
    const statusCode =
      result.response.status === 401
        ? "MODELS_AUTH_UNAUTHORIZED"
        : result.response.status === 403
          ? "MODELS_AUTH_FORBIDDEN"
          : result.response.status === 404
            ? "MODELS_NOT_FOUND"
            : "MODELS_HTTP_STATUS_FAIL"
    if (!result.response.ok)
      return {
        id: "models",
        status: "warning" as const,
        timingMs: result.timingMs,
        checks: [
          {
            code: statusCode,
            status: "warning" as const,
            message: `Models endpoint returned HTTP ${result.response.status}.`,
          },
        ],
        detail: { ...responseMetadata(result.response, body), preview: sanitizePreview(body, secretValues(input)) },
        categories: [statusCategory(result.response.status)],
      }
    const contentType = result.response.headers.get("content-type") ?? ""
    if (!contentType.includes("json"))
      return {
        id: "models",
        status: "warning" as const,
        timingMs: result.timingMs,
        checks: [
          {
            code: "MODELS_CONTENT_TYPE_INVALID",
            status: "warning" as const,
            message: `Models response content type is ${contentType || "missing"}.`,
          },
        ],
        detail: responseMetadata(result.response, body),
        categories: ["content_type" as const],
      }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return {
        id: "models",
        status: "warning" as const,
        timingMs: result.timingMs,
        checks: [
          { code: "MODELS_JSON_INVALID", status: "warning" as const, message: "Models response is not valid JSON." },
        ],
        detail: responseMetadata(result.response, body),
        categories: ["json" as const],
      }
    }
    const data =
      parsed && typeof parsed === "object" && "data" in parsed && Array.isArray(parsed.data) ? parsed.data : undefined
    if (!data)
      return {
        id: "models",
        status: "warning" as const,
        timingMs: result.timingMs,
        checks: [
          {
            code: "MODELS_SCHEMA_INVALID",
            status: "warning" as const,
            message: "Models response has no OpenAI-compatible data array.",
          },
        ],
        detail: responseMetadata(result.response, body),
        categories: ["schema" as const],
      }
    const ids = data.flatMap((item) =>
      item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : [],
    )
    return {
      id: "models",
      status: "pass" as const,
      timingMs: result.timingMs,
      checks: [
        {
          code: "MODELS_HTTP_PASS",
          status: "pass" as const,
          message: "Models endpoint returned an OpenAI-compatible response.",
        },
        ...(ids.length
          ? []
          : [{ code: "MODELS_LIST_EMPTY", status: "warning" as const, message: "Models list is empty." }]),
        ids.includes(input.apiModelID)
          ? {
              code: "MODELS_CONFIGURED_MODEL_FOUND",
              status: "pass" as const,
              message: "Configured API model ID is present.",
            }
          : {
              code: "MODELS_CONFIGURED_MODEL_MISSING",
              status: "warning" as const,
              message: "Configured API model ID is absent from /models.",
            },
      ],
      detail: {
        ...responseMetadata(result.response, body),
        request: requestMetadata(result.url, "GET", requestHeaders(input)),
        modelIDs: ids,
      },
      categories: ids.includes(input.apiModelID) ? [] : ["model" as const],
    }
  } catch (error) {
    const code = errorCode(error)
    return {
      id: "models",
      status: "warning" as const,
      checks: [
        { code: "MODELS_HTTP_STATUS_FAIL", status: "warning" as const, message: `Models request failed (${code}).` },
      ],
      categories: [errorCategory(code)],
    }
  }
}

function minimalBody(input: ProbeInput, stream: boolean) {
  return {
    model: input.apiModelID,
    messages: [{ role: "user", content: "Reply with exactly: OPENCODE_DOCTOR_OK" }],
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    temperature: 0,
    max_tokens: 32,
  }
}

async function chatStage(input: ProbeInput): Promise<ProbeStage> {
  const request = JSON.stringify(minimalBody(input, false))
  try {
    const headers = requestHeaders(input)
    headers.set("content-type", "application/json")
    const result = await guardedFetch(input, "chat/completions", { method: "POST", headers, body: request })
    const body = await readBody(result, input.timeoutMs)
    const redirects = redirectChecks("CHAT", result.response, result.url)
    if (redirects.length)
      return {
        id: "chat",
        status: "fail",
        checks: redirects,
        detail: responseMetadata(result.response, body),
        categories: ["redirect"],
      }
    if (!result.response.ok) {
      const code =
        result.response.status === 401
          ? "CHAT_AUTH_UNAUTHORIZED"
          : result.response.status === 403
            ? "CHAT_AUTH_FORBIDDEN"
            : result.response.status === 404
              ? "CHAT_NOT_FOUND"
              : result.response.status === 405
                ? "CHAT_METHOD_NOT_ALLOWED"
                : result.response.status === 400 &&
                    /model.{0,80}(?:invalid|unsupported|not found|does not exist)/i.test(body)
                  ? "CHAT_MODEL_REJECTED"
                  : "CHAT_HTTP_STATUS_FAIL"
      return {
        id: "chat",
        status: "fail",
        timingMs: result.timingMs,
        checks: [{ code, status: "fail", message: `Raw chat returned HTTP ${result.response.status}.` }],
        detail: { ...responseMetadata(result.response, body), preview: sanitizePreview(body, secretValues(input)) },
        categories: [statusCategory(result.response.status), "chat"],
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return {
        id: "chat",
        status: "fail",
        checks: [{ code: "CHAT_JSON_INVALID", status: "fail", message: "Raw chat response is not JSON." }],
        detail: responseMetadata(result.response, body),
        categories: ["json", "chat"],
      }
    }
    const first =
      parsed && typeof parsed === "object" && "choices" in parsed && Array.isArray(parsed.choices)
        ? parsed.choices[0]
        : undefined
    const message =
      first && typeof first === "object" && "message" in first && first.message && typeof first.message === "object"
        ? first.message
        : undefined
    const content = message && "content" in message && typeof message.content === "string" ? message.content : ""
    if (!first)
      return {
        id: "chat",
        status: "fail",
        checks: [
          { code: "CHAT_SCHEMA_INVALID", status: "fail", message: "Raw chat response is not OpenAI-compatible." },
        ],
        detail: responseMetadata(result.response, body),
        categories: ["schema", "chat"],
      }
    return {
      id: "chat",
      status: content.includes("OPENCODE_DOCTOR_OK") ? "pass" : "fail",
      timingMs: result.timingMs,
      checks: [
        { code: "CHAT_HTTP_PASS", status: "pass", message: "Raw chat request succeeded." },
        content
          ? {
              code: content.includes("OPENCODE_DOCTOR_OK") ? "CHAT_SENTINEL_FOUND" : "CHAT_SENTINEL_MISSING",
              status: content.includes("OPENCODE_DOCTOR_OK") ? "pass" : "fail",
              message: content.includes("OPENCODE_DOCTOR_OK")
                ? "Expected sentinel was returned."
                : "Expected sentinel was not returned.",
            }
          : { code: "CHAT_RESPONSE_EMPTY", status: "fail", message: "Assistant response was empty." },
      ],
      detail: {
        ...responseMetadata(result.response, body),
        request: requestMetadata(result.url, "POST", headers),
        requestFields: Object.keys(minimalBody(input, false)),
        requestBytes: Buffer.byteLength(request),
        requestSha256: hash(request),
        responseModelID: parsed && typeof parsed === "object" && "model" in parsed ? parsed.model : undefined,
        finishReason: first && typeof first === "object" && "finish_reason" in first ? first.finish_reason : undefined,
        preview: sanitizePreview(content, secretValues(input)),
      },
      categories: content.includes("OPENCODE_DOCTOR_OK") ? [] : ["chat"],
    }
  } catch (error) {
    const code = errorCode(error)
    return {
      id: "chat",
      status: "fail",
      checks: [{ code: "CHAT_HTTP_STATUS_FAIL", status: "fail", message: `Raw chat request failed (${code}).` }],
      categories: [errorCategory(code), "chat"],
    }
  }
}

async function streamStage(input: ProbeInput): Promise<ProbeStage> {
  const request = JSON.stringify(minimalBody(input, true))
  let receivedEvent = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const headers = requestHeaders(input)
    headers.set("content-type", "application/json")
    const started = performance.now()
    const result = await guardedFetch(input, "chat/completions", { method: "POST", headers, body: request })
    const headersMs = performance.now() - started
    const redirects = redirectChecks("STREAM", result.response, result.url)
    if (redirects.length) return { id: "stream", status: "fail", checks: redirects, categories: ["redirect"] }
    if (!result.response.ok)
      return {
        id: "stream",
        status: "fail",
        checks: [
          {
            code: "STREAM_HTTP_STATUS_FAIL",
            status: "fail",
            message: `Streaming request returned HTTP ${result.response.status}.`,
          },
        ],
        categories: [statusCategory(result.response.status), "streaming"],
      }
    const contentType = result.response.headers.get("content-type") ?? ""
    reader = result.response.body?.getReader()
    if (!reader) throw new Error("stream response has no body")
    const decoder = new TextDecoder()
    let body = ""
    let firstEventMs: number | undefined
    while (true) {
      const chunk = await timeout(reader.read(), input.timeoutMs, result.abort)
      if (chunk.done) break
      body += decoder.decode(chunk.value, { stream: true })
      if (receivedEvent || !/(?:^|\r?\n)data:/.test(body)) continue
      receivedEvent = true
      firstEventMs = performance.now() - started
    }
    body += decoder.decode()
    reader.releaseLock()
    reader = undefined
    const allLines = body.split(/\r?\n/)
    const lines = allLines.filter((line) => line.startsWith("data:"))
    const malformedSse = allLines.filter(
      (line) => line && !line.startsWith(":") && !/^(?:data|event|id|retry):/.test(line),
    ).length
    let malformedJson = 0
    let jsonEvents = 0
    let content = ""
    let done = false
    let usage = false
    let finishReason: unknown
    for (const line of lines) {
      const data = line.slice(5).trim()
      if (data === "[DONE]") {
        done = true
        continue
      }
      try {
        const parsed: {
          choices?: { delta?: { content?: string }; finish_reason?: unknown }[]
          usage?: unknown
        } = JSON.parse(data)
        jsonEvents++
        content += parsed.choices?.[0]?.delta?.content ?? ""
        finishReason ??= parsed.choices?.[0]?.finish_reason
        if (parsed.usage) usage = true
      } catch {
        malformedJson++
      }
    }
    const failed =
      !contentType.includes("text/event-stream") || malformedSse > 0 || malformedJson > 0 || !content || !done
    return {
      id: "stream",
      status: failed ? "fail" : "pass",
      timingMs: performance.now() - started,
      checks: [
        { code: "STREAM_HTTP_PASS", status: "pass", message: "Streaming endpoint returned HTTP success." },
        ...(!contentType.includes("text/event-stream")
          ? [
              {
                code: "STREAM_CONTENT_TYPE_INVALID",
                status: "fail" as const,
                message: `Streaming content type is ${contentType || "missing"}.`,
              },
            ]
          : []),
        {
          code: content ? "STREAM_CONTENT_RECEIVED" : "STREAM_CONTENT_MISSING",
          status: content ? "pass" : "fail",
          message: content ? "Streaming assistant content was received." : "Streaming assistant content was missing.",
        },
        ...(malformedSse
          ? [
              {
                code: "STREAM_SSE_INVALID",
                status: "fail" as const,
                message: `${malformedSse} malformed SSE lines.`,
              },
            ]
          : []),
        ...(malformedJson
          ? [
              {
                code: "STREAM_JSON_EVENT_INVALID",
                status: "fail" as const,
                message: `${malformedJson} malformed JSON SSE events.`,
              },
            ]
          : []),
        {
          code: done ? "STREAM_DONE_RECEIVED" : "STREAM_DONE_MISSING",
          status: done ? "pass" : "fail",
          message: done ? "[DONE] was received." : "[DONE] was not received.",
        },
        {
          code: usage ? "STREAM_USAGE_RECEIVED" : "STREAM_USAGE_MISSING",
          status: usage ? "pass" : "warning",
          message: usage ? "Usage data was received." : "Usage data was not received.",
        },
      ],
      detail: {
        contentType,
        timeToHeadersMs: headersMs,
        timeToFirstEventMs: firstEventMs,
        eventCount: lines.length,
        jsonDataEventCount: jsonEvents,
        malformedSseLineCount: malformedSse,
        malformedJsonEventCount: malformedJson,
        finishReason,
        request: requestMetadata(result.url, "POST", headers),
        requestFields: Object.keys(minimalBody(input, true)),
        requestBytes: Buffer.byteLength(request),
        requestSha256: hash(request),
      },
      categories: failed ? ["streaming"] : [],
    }
  } catch (error) {
    if (reader) {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    const code = errorCode(error)
    return {
      id: "stream",
      status: "fail",
      checks: [
        {
          code: code === "PROBE_TIMEOUT" && !receivedEvent ? "STREAM_FIRST_EVENT_TIMEOUT" : "STREAM_HTTP_STATUS_FAIL",
          status: "fail",
          message: `Streaming request failed (${code}).`,
        },
      ],
      categories: [errorCategory(code), "streaming"],
    }
  }
}

async function sdkStage(input: ProbeInput, rawBody: Record<string, unknown>): Promise<ProbeStage> {
  if (!input.sdk)
    return {
      id: "sdk",
      status: "skipped",
      checks: [{ code: "SDK_REQUEST_NOT_SENT", status: "info", message: "SDK probe is unavailable." }],
    }
  try {
    const controller = new AbortController()
    const result = await timeout(input.sdk(controller.signal), input.timeoutMs, () => controller.abort())
    const sdkFields = result.observation.request?.fields ?? []
    const rawFields = Object.keys(rawBody)
    const rawTypes = Object.fromEntries(
      Object.entries(rawBody).map(([key, value]) => [key, Array.isArray(value) ? "array" : typeof value]),
    )
    const sdkTypes = result.observation.request?.fieldTypes ?? {}
    const fields = [...new Set(rawFields.concat(sdkFields))]
    const sentinel = result.text.includes("OPENCODE_SDK_OK")
    if (result.observation.resolutionFailure)
      return {
        id: "sdk",
        status: "fail",
        checks: [
          {
            code:
              result.observation.resolutionFailure === "model"
                ? "SDK_MODEL_RESOLUTION_FAIL"
                : "SDK_PROVIDER_RESOLUTION_FAIL",
            status: "fail",
            message: `Production SDK ${result.observation.resolutionFailure} resolution failed.`,
          },
          { code: "SDK_REQUEST_NOT_SENT", status: "fail", message: "No SDK request was sent." },
        ],
        detail: { observation: result.observation },
        categories: ["sdk_compatibility"],
      }
    return {
      id: "sdk",
      status: sentinel ? "pass" : "fail",
      checks: [
        { code: "SDK_PROVIDER_RESOLUTION_PASS", status: "pass", message: "Production provider resolved." },
        { code: "SDK_MODEL_RESOLUTION_PASS", status: "pass", message: "Production model resolved." },
        {
          code: result.observation.request ? "SDK_REQUEST_SENT" : "SDK_REQUEST_NOT_SENT",
          status: result.observation.request ? "pass" : "fail",
          message: result.observation.request
            ? "Production SDK request was sent."
            : "Production SDK request was not observed.",
        },
        {
          code: sentinel ? "SDK_RESPONSE_PASS" : "SDK_RESPONSE_FAIL",
          status: sentinel ? "pass" : "fail",
          message: sentinel
            ? "Production SDK response succeeded."
            : "Production SDK response failed compatibility validation.",
        },
        ...(result.observation.response && result.observation.response.status >= 400
          ? [
              {
                code: "SDK_HTTP_STATUS_FAIL",
                status: "fail" as const,
                message: `Production SDK endpoint returned HTTP ${result.observation.response.status}.`,
              },
            ]
          : []),
        ...(result.observation.response &&
        result.observation.response.status >= 300 &&
        result.observation.response.status < 400
          ? [
              {
                code: "SDK_REDIRECT_REJECTED",
                status: "fail" as const,
                message: "Production SDK redirect was rejected.",
              },
              {
                code: "PROBE_REDIRECT_REJECTED",
                status: "fail" as const,
                message: "Production SDK redirect was rejected.",
              },
            ]
          : []),
        {
          code: sentinel ? "SDK_SENTINEL_FOUND" : "SDK_SENTINEL_MISSING",
          status: sentinel ? "pass" : "fail",
          message: sentinel ? "Expected SDK sentinel was returned." : "Expected SDK sentinel was not returned.",
        },
      ],
      detail: {
        observation: result.observation,
        requestFieldComparison: {
          rawOnly: rawFields.filter((field) => !sdkFields.includes(field)),
          sdkOnly: sdkFields.filter((field) => !rawFields.includes(field)),
          differingTypes: fields.flatMap((field) =>
            rawTypes[field] && sdkTypes[field] && rawTypes[field] !== sdkTypes[field]
              ? [{ field, raw: rawTypes[field], sdk: sdkTypes[field] }]
              : [],
          ),
          nestedSDKFields: result.observation.request?.nestedFields ?? [],
          streamingFields: fields.filter((field) => field === "stream" || field === "stream_options"),
          toolFields: fields.filter(
            (field) => field === "tools" || field === "tool_choice" || field === "parallel_tool_calls",
          ),
          tokenLimitFields: fields.filter((field) =>
            ["max_tokens", "max_completion_tokens", "max_output_tokens"].includes(field),
          ),
          responseFormatFields: fields.filter((field) => field === "response_format"),
        },
      },
      categories: sentinel ? [] : ["sdk_compatibility"],
    }
  } catch (error) {
    return {
      id: "sdk",
      status: "fail",
      checks: [
        { code: "SDK_RESPONSE_FAIL", status: "fail", message: "Production SDK request failed." },
        { code: "SDK_SENTINEL_MISSING", status: "fail", message: "Expected SDK sentinel was not returned." },
      ],
      detail: {
        safeError:
          error instanceof Error ? sanitizePreview(`${error.name}: ${error.message}`, secretValues(input)) : "unknown",
      },
      categories: ["sdk_compatibility"],
    }
  }
}

async function toolStage(input: ProbeInput): Promise<ProbeStage> {
  if (!input.toolCallSupported)
    return {
      id: "tool",
      status: "skipped",
      checks: [
        {
          code: "TOOL_PROBE_SKIPPED_UNSUPPORTED",
          status: "info",
          message: "Configured model declares tool calling unsupported.",
        },
      ],
    }
  const body = JSON.stringify({
    model: input.apiModelID,
    messages: [{ role: "user", content: "Call the opencode_doctor_magic_number tool. Do not answer directly." }],
    tools: [
      {
        type: "function",
        function: {
          name: "opencode_doctor_magic_number",
          description: "Return the diagnostic number.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
    ],
    tool_choice: "required",
    stream: false,
    max_tokens: 64,
  })
  try {
    const headers = requestHeaders(input)
    headers.set("content-type", "application/json")
    const result = await guardedFetch(input, "chat/completions", { method: "POST", headers, body })
    const text = await readBody(result, input.timeoutMs)
    const redirects = redirectChecks("TOOL", result.response, result.url)
    if (redirects.length) return { id: "tool", status: "fail", checks: redirects, categories: ["redirect"] }
    if (!result.response.ok)
      return {
        id: "tool",
        status: "fail",
        checks: [
          {
            code: "TOOL_REQUEST_FAIL",
            status: "fail",
            message: `Tool request returned HTTP ${result.response.status}.`,
          },
        ],
        categories: ["tool_call"],
      }
    const parsed = JSON.parse(text)
    const call = parsed.choices?.[0]?.message?.tool_calls?.[0]
    const finishReason = parsed.choices?.[0]?.finish_reason
    const nameValid = call?.function?.name === "opencode_doctor_magic_number"
    let argumentsValid = false
    try {
      const args = JSON.parse(call?.function?.arguments ?? "")
      argumentsValid = args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0
    } catch {}
    const finishReasonValid = !finishReason || ["tool_calls", "function_call"].includes(finishReason)
    const passed = Boolean(call && nameValid && argumentsValid && finishReasonValid)
    return {
      id: "tool",
      status: passed ? "pass" : "fail",
      checks: [
        { code: "TOOL_REQUEST_PASS", status: "pass", message: "Tool request was accepted." },
        { code: "TOOL_SCHEMA_SERIALIZED", status: "pass", message: "Synthetic tool schema was serialized." },
        {
          code: call ? "TOOL_CALL_RECEIVED" : "TOOL_CALL_MISSING",
          status: call ? "pass" : "fail",
          message: call ? "A tool call was returned." : "No tool call was returned.",
        },
        {
          code: nameValid ? "TOOL_NAME_VALID" : "TOOL_NAME_INVALID",
          status: nameValid ? "pass" : "fail",
          message: nameValid ? "Tool name matched." : "Tool name did not match.",
        },
        {
          code: argumentsValid ? "TOOL_ARGUMENTS_VALID" : "TOOL_ARGUMENTS_INVALID",
          status: argumentsValid ? "pass" : "fail",
          message: argumentsValid ? "Tool arguments match the empty-object schema." : "Tool arguments are invalid.",
        },
        {
          code: finishReasonValid ? "TOOL_FINISH_REASON_VALID" : "TOOL_FINISH_REASON_INVALID",
          status: finishReasonValid ? "pass" : "fail",
          message: finishReasonValid ? "Finish reason is tool-compatible." : "Finish reason is not tool-compatible.",
        },
      ],
      detail: { finishReason },
      categories: passed ? [] : ["tool_call"],
    }
  } catch {
    return {
      id: "tool",
      status: "fail",
      checks: [{ code: "TOOL_REQUEST_FAIL", status: "fail", message: "Tool request failed." }],
      categories: ["tool_call"],
    }
  }
}

export async function runVllmProbe(input: ProbeInput): Promise<VllmProbeReport> {
  const url = new URL(input.baseURL)
  const stages: ProbeStage[] = []
  const dependencies = { ...defaultDependencies, ...input.testDependencies }
  if (input.level !== "sdk") {
    const dns = await dnsStage(url.hostname.replace(/^\[|\]$/g, ""), input.timeoutMs, dependencies)
    const tcp = await tcpStage(dns.addresses, effectivePort(url), input.timeoutMs, dependencies)
    stages.push(
      dns.stage,
      tcp,
      await tlsStage(url, dns.addresses, input.timeoutMs, tcp.status === "pass", dependencies),
    )
  }
  if (input.level === "api" || input.level === "full")
    stages.push(await modelsStage(input), await chatStage(input), await streamStage(input))
  if (input.level === "sdk" || input.level === "full") stages.push(await sdkStage(input, minimalBody(input, false)))
  if (input.level === "full") stages.push(await toolStage(input))
  const failed = stages.filter((stage) => stage.status === "fail")
  return {
    version: 1,
    level: input.level,
    target: {
      scheme: url.protocol.replace(":", ""),
      hostname: url.hostname,
      effectivePort: effectivePort(url),
      path: url.pathname,
    },
    environment: environmentReport(input.baseURL, input.apiKey, input.headers),
    stages,
    summary: {
      status: failed.length ? "fail" : "pass",
      firstFailureStage: failed[0]?.id,
      errorCategories: [...new Set(failed.flatMap((stage) => stage.categories ?? []))],
    },
  }
}

export function formatVllmProbe(report: VllmProbeReport) {
  const names: Record<string, string> = {
    dns: "DNS",
    tcp: "TCP",
    tls: "TLS",
    models: "Models API",
    chat: "Raw chat",
    stream: "Raw streaming",
    sdk: "Production SDK",
    tool: "Tool calling",
  }
  const lines = [
    "",
    "Active endpoint probe",
    "",
    "Target",
    `  ${report.target.scheme.toUpperCase()} ${report.target.hostname}:${report.target.effectivePort}${report.target.path}`,
  ]
  for (const stage of report.stages)
    lines.push(
      "",
      names[stage.id] ?? stage.id,
      ...stage.checks.map((check) => `  ${check.status.toUpperCase()} [${check.code}] ${check.message}`),
    )
  const failure = report.stages.find((stage) => stage.status === "fail")
  const chat = report.stages.find((stage) => stage.id === "chat")
  const sdk = report.stages.find((stage) => stage.id === "sdk")
  lines.push(
    "",
    "Likely root cause",
    chat?.status === "pass" && sdk?.status === "fail"
      ? "  Raw chat passed but the production SDK request failed. This indicates an SDK request compatibility difference."
      : failure
        ? `  First actionable failure: ${names[failure.id] ?? failure.id} (${failure.categories?.join(", ") || "unknown"}).`
        : "  All required probes passed.",
  )
  const comparison = sdk?.detail?.requestFieldComparison
  if (comparison && typeof comparison === "object") {
    const rawOnly = "rawOnly" in comparison && Array.isArray(comparison.rawOnly) ? comparison.rawOnly : []
    const sdkOnly = "sdkOnly" in comparison && Array.isArray(comparison.sdkOnly) ? comparison.sdkOnly : []
    lines.push(
      "",
      "Relevant request-field difference",
      `  Raw-only fields: ${rawOnly.join(", ") || "none"}`,
      `  SDK-only fields: ${sdkOnly.join(", ") || "none"}`,
    )
  }
  return lines.join("\n") + "\n"
}
