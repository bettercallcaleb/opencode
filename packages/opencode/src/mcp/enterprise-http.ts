import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import http, { type IncomingMessage } from "node:http"
import https, { type RequestOptions } from "node:https"
import { isIP } from "node:net"
import { TLSSocket } from "node:tls"
import { isAdmittedEnterpriseMcpServer, type AdmittedEnterpriseMcpServer } from "./enterprise-policy"

export const EnterpriseMcpHttpErrorCodes = [
  "MCP_HTTP_URL_REJECTED",
  "MCP_HTTP_METHOD_REJECTED",
  "MCP_HTTP_REDIRECT_REJECTED",
  "MCP_HTTP_DNS_FAILED",
  "MCP_HTTP_DNS_ADDRESS_REJECTED",
  "MCP_HTTP_DNS_NO_ADMITTED_ADDRESS",
  "MCP_HTTP_CONNECT_FAILED",
  "MCP_HTTP_CONNECT_TIMEOUT",
  "MCP_HTTP_PROXY_REJECTED",
  "MCP_HTTP_TLS_UNTRUSTED",
  "MCP_HTTP_TLS_HOSTNAME_MISMATCH",
  "MCP_HTTP_TLS_EXPIRED",
  "MCP_HTTP_HEADER_REJECTED",
  "MCP_HTTP_SECRET_MISSING",
  "MCP_HTTP_SECRET_INVALID",
  "MCP_HTTP_REQUEST_TOO_LARGE",
  "MCP_HTTP_RESPONSE_TOO_LARGE",
  "MCP_HTTP_STREAM_FRAME_TOO_LARGE",
  "MCP_HTTP_TIMEOUT",
  "MCP_HTTP_ABORTED",
  "MCP_HTTP_STATUS_ERROR",
  "MCP_HTTP_INTERNAL_ERROR",
] as const

export type EnterpriseMcpHttpErrorCode = (typeof EnterpriseMcpHttpErrorCodes)[number]

export class EnterpriseMcpHttpError extends Error {
  override readonly name = "EnterpriseMcpHttpError"

  constructor(
    readonly code: EnterpriseMcpHttpErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type EnterpriseMcpHttpObservation = Readonly<{
  serverID: string
  method: string
  url: string
  requestHeaderNames: readonly string[]
  requestBytes: number
  requestSha256: string
  requestFields?: readonly string[]
  selectedAddress?: string
  selectedFamily?: 4 | 6
  responseStatus?: number
  responseHeaderNames?: readonly string[]
  responseBytes?: number
  responseSha256?: string
  elapsedMs: number
  errorCode?: EnterpriseMcpHttpErrorCode
  tls?: Readonly<{
    protocol?: string
    cipher?: string
    subjectCN?: string
    subjectAltName?: string
    issuerCN?: string
    validFrom?: string
    validTo?: string
    fingerprint256?: string
  }>
}>

export type EnterpriseMcpHttpRuntimeServices = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>
  resolve?: (hostname: string) => Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]>
  observe?: (observation: EnterpriseMcpHttpObservation) => void
}>

export type EnterpriseMcpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type Address = Readonly<{ address: string; family: 4 | 6 }>
type RequestBody = Readonly<{ bytes: Uint8Array; fields?: readonly string[] }>
type NetworkResponse = {
  status: number
  statusText: string
  headers: Headers
  source: AsyncIterable<Uint8Array> & { destroy(error?: Error): void }
  destroy(error?: Error): void
  tls?: EnterpriseMcpHttpObservation["tls"]
}

const methods = new Set(["POST", "GET", "DELETE"])
const proxyNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const
const forbiddenHeaders = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "proxy-authorization",
  "cookie",
  "set-cookie",
])
const transportHeaders = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  "user-agent",
])

export function createEnterpriseMcpFetch(
  admitted: AdmittedEnterpriseMcpServer,
  services: EnterpriseMcpHttpRuntimeServices = {},
): EnterpriseMcpFetch {
  requireAuthentic(admitted)
  return async (input, init) => {
    requireAuthentic(admitted)
    const started = performance.now()
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const observation = {
      serverID: admitted.id,
      method,
      url: safeUrl(admitted.url),
      requestHeaderNames: [] as string[],
      requestBytes: 0,
      requestSha256: sha256(new Uint8Array()),
    }
    try {
      rejectProxy(services.environment ?? process.env)
      const target = requireExactUrl(input, admitted.url)
      if (!methods.has(method)) throw failure("MCP_HTTP_METHOD_REJECTED", "Enterprise MCP request method is rejected.")
      const body = await requestBody(input, init)
      if (method !== "POST" && body.bytes.byteLength)
        throw failure("MCP_HTTP_METHOD_REJECTED", "Enterprise MCP GET and DELETE requests cannot have a body.")
      if (body.bytes.byteLength > admitted.limits.maxRequestBytes)
        throw failure("MCP_HTTP_REQUEST_TOO_LARGE", "Enterprise MCP request exceeds the managed byte limit.")
      observation.requestBytes = body.bytes.byteLength
      observation.requestSha256 = sha256(body.bytes)
      const headers = materializeHeaders(admitted, input, init, services.environment ?? process.env)
      observation.requestHeaderNames = [...headers.keys()].sort()
      const addresses = await resolveAddresses(admitted, services)

      let last: unknown
      for (const address of addresses) {
        try {
          const response = await requestAtAddress(admitted, target, method, headers, body, address, init?.signal)
          const base = {
            ...observation,
            requestFields: body.fields,
            selectedAddress: address.address,
            selectedFamily: address.family,
            responseStatus: response.status,
            responseHeaderNames: [...response.headers.keys()].sort(),
            elapsedMs: performance.now() - started,
            tls: response.tls,
          }
          if (response.status >= 300 && response.status < 400) {
            response.destroy()
            const location = sanitizeLocation(response.headers.get("location"))
            throw failure(
              "MCP_HTTP_REDIRECT_REJECTED",
              `Enterprise MCP redirect is rejected${location ? `: ${location}` : "."}`,
            )
          }
          const statusError = response.status >= 400 ? ("MCP_HTTP_STATUS_ERROR" as const) : undefined
          if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
            const stream = streamResponse(response, admitted, init?.signal, (result) =>
              observe(services, { ...base, ...result, errorCode: result.errorCode ?? statusError }),
            )
            return new Response(stream, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            })
          }
          const bytes = await finiteResponse(response, admitted, init?.signal)
          observe(services, {
            ...base,
            responseBytes: bytes.byteLength,
            responseSha256: sha256(bytes),
            elapsedMs: performance.now() - started,
            errorCode: statusError,
          })
          return new Response(bytes.byteLength ? bytes : null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        } catch (error) {
          last = error
          if (!retryable(error)) throw error
        }
      }
      throw classifyConnection(last)
    } catch (error) {
      const classified = classify(error)
      observe(services, { ...observation, elapsedMs: performance.now() - started, errorCode: classified.code })
      throw classified
    }
  }
}

function requireExactUrl(input: string | URL | Request, admitted: string) {
  const raw = input instanceof Request ? input.url : String(input)
  if (raw.startsWith("//")) throw failure("MCP_HTTP_URL_REJECTED", "Protocol-relative MCP URLs are rejected.")
  let actual: URL
  let expected: URL
  try {
    actual = new URL(raw)
    expected = new URL(admitted)
  } catch {
    throw failure("MCP_HTTP_URL_REJECTED", "Enterprise MCP request URL is invalid.")
  }
  if (actual.username || actual.password || actual.search || actual.hash)
    throw failure("MCP_HTTP_URL_REJECTED", "Enterprise MCP request URL contains prohibited components.")
  if (
    actual.protocol !== expected.protocol ||
    actual.hostname.toLowerCase() !== expected.hostname.toLowerCase() ||
    effectivePort(actual) !== effectivePort(expected) ||
    canonicalPath(actual.pathname) !== canonicalPath(expected.pathname)
  )
    throw failure("MCP_HTTP_URL_REJECTED", "Enterprise MCP request URL does not match the admitted endpoint.")
  return actual
}

function rejectProxy(environment: Readonly<Record<string, string | undefined>>) {
  if (proxyNames.some((name) => environment[name]?.trim()))
    throw failure("MCP_HTTP_PROXY_REJECTED", "Enterprise MCP proxy configuration is not admitted.")
}

async function requestBody(input: string | URL | Request, init?: RequestInit): Promise<RequestBody> {
  const value = init?.body
  if (value === undefined || value === null) {
    if (input instanceof Request && input.body) {
      try {
        const bytes = new Uint8Array(await input.arrayBuffer())
        return { bytes, fields: jsonRpcFields(bytes) }
      } catch {
        throw failure("MCP_HTTP_INTERNAL_ERROR", "Enterprise MCP Request body could not be consumed.")
      }
    }
    return { bytes: new Uint8Array() }
  }
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : value instanceof Blob
            ? new Uint8Array(await value.arrayBuffer())
            : undefined
  if (!bytes) throw failure("MCP_HTTP_REQUEST_TOO_LARGE", "Enterprise MCP request body type is unsupported.")
  return { bytes, fields: jsonRpcFields(bytes) }
}

function materializeHeaders(
  admitted: AdmittedEnterpriseMcpServer,
  input: string | URL | Request,
  init: RequestInit | undefined,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const supplied = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, name) => supplied.set(name, value))
  const allowed = new Set(admitted.headers.allowedNames)
  for (const name of supplied.keys()) {
    const normalized = name.toLowerCase()
    if (forbidden(normalized) || (!transportHeaders.has(normalized) && !allowed.has(normalized)))
      throw failure("MCP_HTTP_HEADER_REJECTED", `Enterprise MCP header ${safeHeaderName(normalized)} is rejected.`)
  }
  for (const secret of admitted.headers.secretReferences) {
    if (supplied.has(secret.header))
      throw failure(
        "MCP_HTTP_HEADER_REJECTED",
        `Enterprise MCP header ${safeHeaderName(secret.header)} has conflicting sources.`,
      )
    const value = environment[secret.name]
    if (!value?.trim()) throw failure("MCP_HTTP_SECRET_MISSING", "A required enterprise MCP secret is missing.")
    if (/[\r\n\u0000]/.test(value)) throw failure("MCP_HTTP_SECRET_INVALID", "An enterprise MCP secret is invalid.")
    if (secret.format === "Bearer" && /^Bearer\s/i.test(value))
      throw failure("MCP_HTTP_SECRET_INVALID", "An enterprise MCP Bearer secret contains a duplicate prefix.")
    supplied.set(secret.header, secret.format === "Bearer" ? `Bearer ${value}` : value)
  }
  return supplied
}

async function resolveAddresses(admitted: AdmittedEnterpriseMcpServer, services: EnterpriseMcpHttpRuntimeServices) {
  let resolved: readonly Address[]
  try {
    resolved = services.resolve
      ? await services.resolve(new URL(admitted.url).hostname)
      : await lookup(new URL(admitted.url).hostname, { all: true, verbatim: true }).then((items) =>
          items.flatMap((item) =>
            item.family === 4 || item.family === 6 ? [{ address: item.address, family: item.family }] : [],
          ),
        )
  } catch {
    throw failure("MCP_HTTP_DNS_FAILED", "Enterprise MCP DNS resolution failed.")
  }
  const unique = [...new Map(resolved.map((item) => [`${item.family}:${item.address}`, item])).values()].sort(
    (a, b) => a.family - b.family || a.address.localeCompare(b.address),
  )
  if (!unique.length) throw failure("MCP_HTTP_DNS_NO_ADMITTED_ADDRESS", "Enterprise MCP DNS returned no addresses.")
  const decisions = unique.map((item) => ({ item, admitted: addressAdmitted(item.address, admitted) }))
  const admittedAddresses = decisions.flatMap((item) => (item.admitted ? [item.item] : []))
  if (!admittedAddresses.length)
    throw failure("MCP_HTTP_DNS_ADDRESS_REJECTED", "Enterprise MCP DNS returned only denied addresses.")
  return admittedAddresses
}

function requestAtAddress(
  admitted: AdmittedEnterpriseMcpServer,
  target: URL,
  method: string,
  headers: Headers,
  body: RequestBody,
  address: Address,
  signal: AbortSignal | null | undefined,
) {
  return new Promise<NetworkResponse>((resolve, reject) => {
    if (signal?.aborted) return reject(failure("MCP_HTTP_ABORTED", "Enterprise MCP request was aborted."))
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    const options: RequestOptions = {
      protocol: target.protocol,
      hostname: address.address,
      family: address.family,
      port: String(effectivePort(target)),
      path: target.pathname,
      method,
      headers: { ...Object.fromEntries(headers), host: target.host },
      signal: controller.signal,
      maxHeaderSize: admitted.limits.maxHeaderBytes,
      agent: false,
    }
    const receive = (response: IncomingMessage) => {
      clearTimeout(connectTimer)
      clearTimeout(headerTimer)
      signal?.removeEventListener("abort", abort)
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item))
        else if (value !== undefined) responseHeaders.set(name, String(value))
      }
      resolve({
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? "",
        headers: responseHeaders,
        source: response,
        destroy: (error) => {
          response.destroy(error)
          response.socket.destroy(error)
        },
        tls: response.socket instanceof TLSSocket ? tlsMetadata(response.socket) : undefined,
      })
    }
    const request =
      target.protocol === "https:"
        ? https.request(
            { ...options, servername: target.hostname, rejectUnauthorized: true } as RequestOptions,
            receive,
          )
        : http.request(options, receive)
    const connectTimer = setTimeout(() => {
      request.destroy(failure("MCP_HTTP_CONNECT_TIMEOUT", "Enterprise MCP connection timed out."))
    }, admitted.limits.connectTimeoutMs)
    request.once("socket", (socket) => {
      if (socket.connecting) socket.once("connect", () => clearTimeout(connectTimer))
      else clearTimeout(connectTimer)
    })
    const headerTimer = setTimeout(() => {
      request.destroy()
      reject(failure("MCP_HTTP_TIMEOUT", "Enterprise MCP response headers timed out."))
    }, admitted.limits.responseHeaderTimeoutMs)
    request.once("error", (error) => {
      clearTimeout(connectTimer)
      clearTimeout(headerTimer)
      signal?.removeEventListener("abort", abort)
      reject(signal?.aborted ? failure("MCP_HTTP_ABORTED", "Enterprise MCP request was aborted.") : error)
    })
    if (body.bytes.byteLength) request.write(body.bytes)
    request.end()
  })
}

async function finiteResponse(
  response: NetworkResponse,
  admitted: AdmittedEnterpriseMcpServer,
  signal?: AbortSignal | null,
) {
  const chunks: Uint8Array[] = []
  let total = 0
  const deadline = setTimeout(
    () => response.source.destroy(failure("MCP_HTTP_TIMEOUT", "Enterprise MCP response timed out.")),
    admitted.limits.requestTimeoutMs,
  )
  const abort = () => response.source.destroy(failure("MCP_HTTP_ABORTED", "Enterprise MCP request was aborted."))
  signal?.addEventListener("abort", abort, { once: true })
  try {
    for await (const chunk of response.source) {
      if (signal?.aborted) throw failure("MCP_HTTP_ABORTED", "Enterprise MCP request was aborted.")
      total += chunk.byteLength
      if (total > admitted.limits.maxResponseBytes)
        throw failure("MCP_HTTP_RESPONSE_TOO_LARGE", "Enterprise MCP response exceeds the managed byte limit.")
      chunks.push(chunk)
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  } catch (error) {
    response.destroy(error instanceof Error ? error : undefined)
    throw error
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener("abort", abort)
  }
}

function streamResponse(
  response: NetworkResponse,
  admitted: AdmittedEnterpriseMcpServer,
  signal: AbortSignal | null | undefined,
  done: (
    result: Pick<EnterpriseMcpHttpObservation, "responseBytes" | "responseSha256" | "elapsedMs" | "errorCode">,
  ) => void,
) {
  const hash = createHash("sha256")
  let total = 0
  let frame = 0
  let line = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  const started = performance.now()
  const iterator = response.source[Symbol.asyncIterator]()
  const abort = () => response.destroy(failure("MCP_HTTP_ABORTED", "Enterprise MCP request was aborted."))
  signal?.addEventListener("abort", abort, { once: true })
  const wait = () => {
    timer = setTimeout(() => {
      const error = failure("MCP_HTTP_TIMEOUT", "Enterprise MCP event stream became inactive.")
      response.destroy(error)
    }, admitted.limits.streamInactivityTimeoutMs)
  }
  const finish = (
    result: Pick<EnterpriseMcpHttpObservation, "responseBytes" | "responseSha256" | "elapsedMs" | "errorCode">,
  ) => {
    if (finished) return
    finished = true
    done(result)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal?.aborted) throw failure("MCP_HTTP_ABORTED", "Enterprise MCP request was aborted.")
        wait()
        const next = await iterator.next()
        if (timer) clearTimeout(timer)
        if (next.done) {
          signal?.removeEventListener("abort", abort)
          controller.close()
          finish({ responseBytes: total, responseSha256: hash.digest("hex"), elapsedMs: performance.now() - started })
          return
        }
        total += next.value.byteLength
        hash.update(next.value)
        for (const byte of next.value) {
          frame++
          if (byte === 10) {
            if (line === 0) frame = 0
            line = 0
          } else if (byte !== 13) line++
          if (frame > admitted.limits.maxStreamFrameBytes) {
            throw failure("MCP_HTTP_STREAM_FRAME_TOO_LARGE", "Enterprise MCP event exceeds the managed frame limit.")
          }
        }
        controller.enqueue(next.value)
      } catch (error) {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        const classified = classify(error)
        response.destroy(classified)
        if (!finished) controller.error(classified)
        finish({ responseBytes: total, elapsedMs: performance.now() - started, errorCode: classified.code })
      }
    },
    cancel() {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      response.destroy()
      void iterator.return?.().catch(() => {})
      finish({ responseBytes: total, elapsedMs: performance.now() - started, errorCode: "MCP_HTTP_ABORTED" })
    },
  })
}

function addressAdmitted(address: string, admitted: AdmittedEnterpriseMcpServer) {
  const family = isIP(address)
  if (!family || unspecified(address) || multicast(address) || broadcast(address)) return false
  if (admitted.dns.denyLoopback && loopback(address)) return false
  if (admitted.dns.denyLinkLocal && linkLocal(address)) return false
  return admitted.dns.allowedCidrs.some((cidr) => withinCidr(address, cidr))
}

function withinCidr(address: string, cidr: string) {
  const [network, rawPrefix] = cidr.split("/")
  if (!network || rawPrefix === undefined || isIP(address) !== isIP(network)) return false
  const bits = isIP(address) === 4 ? 32 : 128
  const prefix = Number(rawPrefix)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false
  const shift = BigInt(bits - prefix)
  return parseAddress(address) >> shift === parseAddress(network) >> shift
}

function parseAddress(address: string) {
  if (isIP(address) === 4) return address.split(".").reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n)
  const [left = "", right = ""] = address.toLowerCase().split("::")
  const expand = (part: string) =>
    (part ? part.split(":") : []).flatMap((item) => {
      if (!item.includes(".")) return [Number.parseInt(item, 16)]
      const value = item.split(".").map(Number)
      return [(value[0] << 8) | value[1], (value[2] << 8) | value[3]]
    })
  const before = expand(left)
  const after = expand(right)
  const parts = address.includes("::")
    ? [...before, ...Array(8 - before.length - after.length).fill(0), ...after]
    : before
  return parts.reduce((value, part) => (value << 16n) | BigInt(part), 0n)
}

function retryable(error: unknown) {
  if (error instanceof EnterpriseMcpHttpError) return false
  return ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"].includes(nodeCode(error))
}

function classifyConnection(error: unknown) {
  const code = nodeCode(error)
  if (code === "ETIMEDOUT") return failure("MCP_HTTP_CONNECT_TIMEOUT", "Enterprise MCP connection timed out.")
  const tls = classifyEnterpriseMcpTlsError(error)
  if (tls)
    return failure(
      tls,
      tls === "MCP_HTTP_TLS_HOSTNAME_MISMATCH"
        ? "Enterprise MCP TLS hostname validation failed."
        : tls === "MCP_HTTP_TLS_EXPIRED"
          ? "Enterprise MCP TLS certificate validity failed."
          : "Enterprise MCP TLS certificate is untrusted.",
    )
  return failure("MCP_HTTP_CONNECT_FAILED", `Enterprise MCP connection failed (${code}).`)
}

export function classifyEnterpriseMcpTlsError(error: unknown) {
  const code = nodeCode(error)
  if (/ALTNAME|HOSTNAME/.test(code)) return "MCP_HTTP_TLS_HOSTNAME_MISMATCH" as const
  if (/EXPIRED|NOT_YET_VALID/.test(code)) return "MCP_HTTP_TLS_EXPIRED" as const
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) return "MCP_HTTP_TLS_UNTRUSTED" as const
}

function classify(error: unknown) {
  if (error instanceof EnterpriseMcpHttpError) return error
  if (classifyEnterpriseMcpTlsError(error) || nodeCode(error) !== "UNKNOWN") return classifyConnection(error)
  return failure("MCP_HTTP_INTERNAL_ERROR", "Enterprise MCP HTTP executor failed internally.")
}
function unspecified(address: string) {
  return parseAddress(address) === 0n
}
function loopback(address: string) {
  return isIP(address) === 4 ? withinCidr(address, "127.0.0.0/8") : address === "::1"
}
function linkLocal(address: string) {
  return withinCidr(address, isIP(address) === 4 ? "169.254.0.0/16" : "fe80::/10")
}
function multicast(address: string) {
  return withinCidr(address, isIP(address) === 4 ? "224.0.0.0/4" : "ff00::/8")
}
function broadcast(address: string) {
  return address === "255.255.255.255"
}
function tlsMetadata(socket: TLSSocket) {
  const certificate = socket.getPeerCertificate()
  return {
    protocol: socket.getProtocol() ?? undefined,
    cipher: socket.getCipher()?.name,
    subjectCN: scalar(certificate.subject?.CN),
    subjectAltName: certificate.subjectaltname?.slice(0, 512),
    issuerCN: scalar(certificate.issuer?.CN),
    validFrom: certificate.valid_from,
    validTo: certificate.valid_to,
    fingerprint256: certificate.fingerprint256,
  }
}
function sanitizeLocation(value: string | null) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.hostname}${url.port ? `:${effectivePort(url)}` : ""}${url.pathname}`
  } catch {
    return "invalid-location"
  }
}
function jsonRpcFields(bytes: Uint8Array) {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : undefined
  } catch {
    return undefined
  }
}
function forbidden(name: string) {
  return name.startsWith(":") || forbiddenHeaders.has(name)
}
function safeHeaderName(name: string) {
  return name.replace(/[^!#$%&'*+.^_`|~0-9A-Za-z-]/g, "?").slice(0, 128)
}
function safeUrl(value: string) {
  const url = new URL(value)
  return `${url.protocol}//${url.hostname}${url.port ? `:${effectivePort(url)}` : ""}${url.pathname}`
}
function canonicalPath(path: string) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}
function effectivePort(url: URL) {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80))
}
function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}
function nodeCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN"
}
function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join(", ").slice(0, 512) : value?.slice(0, 512)
}
function failure(code: EnterpriseMcpHttpErrorCode, message: string) {
  return new EnterpriseMcpHttpError(code, message)
}

function requireAuthentic(admitted: AdmittedEnterpriseMcpServer) {
  if (!isAdmittedEnterpriseMcpServer(admitted))
    throw failure("MCP_HTTP_INTERNAL_ERROR", "Enterprise MCP admitted-server authenticity check failed.")
}

function observe(services: EnterpriseMcpHttpRuntimeServices, observation: EnterpriseMcpHttpObservation) {
  if (!services.observe) return
  const safe = Object.freeze({
    ...observation,
    requestHeaderNames: Object.freeze([...observation.requestHeaderNames]),
    requestFields: observation.requestFields ? Object.freeze([...observation.requestFields]) : undefined,
    responseHeaderNames: observation.responseHeaderNames
      ? Object.freeze([...observation.responseHeaderNames])
      : undefined,
    tls: observation.tls ? Object.freeze({ ...observation.tls }) : undefined,
  })
  try {
    services.observe(safe)
  } catch {}
}
