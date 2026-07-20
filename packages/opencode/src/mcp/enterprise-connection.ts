import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js"
import { createEnterpriseMcpFetch, EnterpriseMcpHttpError } from "./enterprise-http"
import type { AdmittedEnterpriseMcpServer } from "./enterprise-policy"
import { z } from "zod/v4"

export type EnterpriseMcpConnection = Readonly<{ close: () => Promise<void> }>
const EnterpriseToolPage = z.object({ tools: z.array(z.unknown()), nextCursor: z.string().optional() })
type EnterpriseToolPage = { tools: unknown[]; nextCursor?: string }
const enterpriseClients = new WeakMap<
  EnterpriseMcpConnection,
  { client: Client; admitted: AdmittedEnterpriseMcpServer }
>()

export async function listEnterpriseMcpTools(
  connection: EnterpriseMcpConnection,
  admitted: AdmittedEnterpriseMcpServer,
  cursor: string | undefined,
  timeout: number,
  signal?: AbortSignal,
): Promise<EnterpriseToolPage> {
  const owner = enterpriseClients.get(connection)
  if (!owner || owner.admitted !== admitted)
    throw new Error("[MCP_TOOL_CATALOG_DISCOVERY_FAILED] Enterprise connection is unavailable.")
  if (!owner.client.getServerCapabilities()?.tools)
    throw new Error("[MCP_TOOL_CATALOG_DISCOVERY_FAILED] Server did not advertise tool discovery.")
  const result: unknown = await owner.client.request(
    { method: "tools/list", params: cursor === undefined ? undefined : { cursor } },
    EnterpriseToolPage as unknown as AnySchema,
    { signal, timeout },
  )
  if (!result || typeof result !== "object" || !("tools" in result) || !Array.isArray(result.tools))
    throw new Error("Invalid managed tool catalog page.")
  return {
    tools: result.tools,
    nextCursor: "nextCursor" in result && typeof result.nextCursor === "string" ? result.nextCursor : undefined,
  }
}

export async function closeEnterpriseMcpConnections(connections: readonly EnterpriseMcpConnection[]) {
  await Promise.allSettled(connections.map((connection) => connection.close()))
}

export async function connectEnterpriseMcp(
  admitted: AdmittedEnterpriseMcpServer,
  onclose?: () => void,
  signal?: AbortSignal,
  hooks: Readonly<{ afterInitialize?: () => Promise<void> }> = {},
): Promise<EnterpriseMcpConnection> {
  const controller = new AbortController()
  const guardedFetch = createEnterpriseMcpFetch(admitted)
  const transport = new StreamableHTTPClientTransport(new URL(admitted.url), {
    fetch: (input, init) =>
      guardedFetch(input, {
        ...init,
        signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
      }),
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  })
  const client = new Client({ name: "opencode-enterprise", version: InstallationVersion }, { capabilities: {} })
  let closing = false
  let connection: EnterpriseMcpConnection | undefined
  const close = () => {
    closing = true
    signal?.removeEventListener("abort", abort)
    controller.abort()
    if (connection) enterpriseClients.delete(connection)
    return Promise.allSettled([client.close(), transport.close()]).then(() => undefined)
  }
  let rejectAbort!: (error: DOMException) => void
  const aborted = new Promise<never>((_resolve, reject) => (rejectAbort = reject))
  const abort = () => {
    void close()
    rejectAbort(new DOMException("This operation was aborted", "AbortError"))
  }
  signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(abort, admitted.limits.connectTimeoutMs)
  try {
    if (signal?.aborted) throw new DOMException("This operation was aborted", "AbortError")
    await Promise.race([
      client.connect(transport, { signal: controller.signal, timeout: admitted.limits.connectTimeoutMs }),
      aborted,
    ])
    if (hooks.afterInitialize) await Promise.race([hooks.afterInitialize(), aborted])
  } catch (error) {
    await close()
    throw new Error(formatEnterpriseMcpConnectionError(error))
  } finally {
    clearTimeout(timer)
  }
  client.onclose = () => {
    signal?.removeEventListener("abort", abort)
    if (connection) enterpriseClients.delete(connection)
    if (!closing) onclose?.()
  }
  connection = Object.freeze({ close })
  enterpriseClients.set(connection, { client, admitted })
  return connection
}

export function formatEnterpriseMcpConnectionError(error: unknown) {
  if (error instanceof EnterpriseMcpHttpError) return `[${error.code}] ${safeMessage(error.code)}`
  const status = httpStatus(error)
  if (status) return `[MCP_CONNECTION_FAILED] MCP initialize failed with HTTP status ${status}.`
  if (aborted(error)) return "[MCP_HTTP_TIMEOUT] MCP initialize timed out."
  return "[MCP_CONNECTION_FAILED] MCP initialize failed."
}

function httpStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return
  return typeof error.code === "number" && error.code >= 100 && error.code <= 599 ? error.code : undefined
}

function aborted(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.message === "This operation was aborted")
}

function safeMessage(code: EnterpriseMcpHttpError["code"]) {
  const messages: Partial<Record<EnterpriseMcpHttpError["code"], string>> = {
    MCP_HTTP_TLS_UNTRUSTED: "TLS certificate is not trusted.",
    MCP_HTTP_TLS_HOSTNAME_MISMATCH: "TLS hostname validation failed.",
    MCP_HTTP_TLS_EXPIRED: "TLS certificate validity failed.",
    MCP_HTTP_SECRET_MISSING: "A required managed secret is missing.",
    MCP_HTTP_PROXY_REJECTED: "Proxy configuration is not permitted.",
    MCP_HTTP_DNS_ADDRESS_REJECTED: "DNS returned only denied addresses.",
    MCP_HTTP_DNS_NO_ADMITTED_ADDRESS: "DNS returned no admitted address.",
    MCP_HTTP_REDIRECT_REJECTED: "Redirect response is not permitted.",
  }
  return messages[code] ?? "Managed MCP connection failed."
}
