import http from "node:http"
import { afterEach, describe, expect, test } from "bun:test"
import {
  closeEnterpriseMcpConnections,
  connectEnterpriseMcp,
  formatEnterpriseMcpConnectionError,
} from "../../src/mcp/enterprise-connection"
import { admitEnterpriseMcpHttpServer } from "../../src/mcp/enterprise-policy"
import { EnterpriseMcpHttpError } from "../../src/mcp/enterprise-http"
import { enterpriseMcpPolicy } from "../fixture/enterprise-mcp-policy"

const servers: http.Server[] = []
const proxyNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }),
  )
})

describe("enterprise MCP connection-only client", () => {
  test("initializes with empty capabilities and performs no discovery or fallback", async () => {
    const requests: { method: string; path: string; body: unknown }[] = []
    const server = http.createServer(async (request, response) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      const message = body ? JSON.parse(body) : undefined
      requests.push({ method: request.method ?? "", path: request.url ?? "", body: message })
      if (message?.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
              serverInfo: { name: "enterprise-test", version: "1" },
              instructions: "must remain private",
            },
          }),
        )
        return
      }
      response.writeHead(202).end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test address")
    await withoutProxy(async () => {
      const connection = await connectEnterpriseMcp(admitted(`http://127.0.0.1:${address.port}/mcp`))
      await connection.close()
    })
    expect(requests.map((request) => request.path)).toEqual(["/mcp", "/mcp"])
    expect(requests.map((request) => (request.body as { method?: string })?.method)).toEqual([
      "initialize",
      "notifications/initialized",
    ])
    expect((requests[0].body as { params: { capabilities: unknown } }).params.capabilities).toEqual({})
    expect(requests.some((request) => request.method === "GET")).toBe(false)
    expect(requests.some((request) => request.path !== "/mcp")).toBe(false)
    expect(JSON.stringify(requests)).not.toContain("tools/list")
    expect(JSON.stringify(requests)).not.toContain("roots/list")
  })

  test.each([401, 403, 404, 405, 429, 500])("fails safely for HTTP %s without fallback", async (status) => {
    const paths: string[] = []
    const server = http.createServer((request, response) => {
      paths.push(request.url ?? "")
      response.writeHead(status, { "content-type": "application/json" })
      response.end('{"secret":"server-controlled"}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test address")
    const error = await withoutProxy(() =>
      connectEnterpriseMcp(admitted(`http://127.0.0.1:${address.port}/mcp`)).catch((item) => item),
    )
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe(`[MCP_CONNECTION_FAILED] MCP initialize failed with HTTP status ${status}.`)
    expect(error.message).not.toContain("server-controlled")
    expect(paths).toEqual(["/mcp"])
  })

  test.each(["malformed", "closed", "timeout"])("cleans up a %s initialize failure", async (failure) => {
    const server = http.createServer((request, response) => {
      if (failure === "closed") {
        request.socket.destroy()
        return
      }
      if (failure === "timeout") return
      response.writeHead(200, { "content-type": "application/json" }).end("{}")
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test address")
    const error = await withoutProxy(() =>
      connectEnterpriseMcp(admitted(`http://127.0.0.1:${address.port}/mcp`, 100)).catch((item) => item),
    )
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/^\[MCP_(?:CONNECTION_FAILED|HTTP_(?:TIMEOUT|CONNECT_FAILED))\]/)
    expect(error.message).not.toContain("undefined")
  })

  test("does not reconnect an interrupted receive stream in Phase 2A2", async () => {
    const paths: string[] = []
    let gets = 0
    const server = http.createServer(async (request, response) => {
      paths.push(request.url ?? "")
      if (request.method === "GET") {
        gets++
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end("id: sensitive-event-id\ndata:\n\n")
        return
      }
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks).toString())
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "reconnect-test", version: "1" },
            },
          }),
        )
        return
      }
      response.writeHead(202).end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test address")
    const connection = await withoutProxy(() => connectEnterpriseMcp(admitted(`http://127.0.0.1:${address.port}/mcp`)))
    await waitFor(() => gets === 1)
    await Bun.sleep(100)
    expect(gets).toBe(1)
    expect(paths.every((value) => value === "/mcp")).toBe(true)
    await connection.close()
  })

  test("isolates unsupported server requests and notifications", async () => {
    const responses: { id?: number; error?: unknown }[] = []
    const server = http.createServer(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream" })
        const messages = [
          { jsonrpc: "2.0", id: 10, method: "roots/list", params: { sentinel: "workspace-secret" } },
          { jsonrpc: "2.0", id: 11, method: "sampling/createMessage", params: { sentinel: "model-secret" } },
          { jsonrpc: "2.0", id: 12, method: "elicitation/create", params: { sentinel: "user-secret" } },
          { jsonrpc: "2.0", id: 13, method: "enterprise/unknown", params: { sentinel: "unknown-secret" } },
          { jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { sentinel: "tool-secret" } },
          { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "log-secret" } },
          { jsonrpc: "2.0", method: "notifications/unknown", params: { sentinel: "notification-secret" } },
        ]
        messages.forEach((message) => response.write(`data: ${JSON.stringify(message)}\n\n`))
        return
      }
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks).toString())
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "isolation-test", version: "1" },
            },
          }),
        )
        return
      }
      if ("id" in message && ("result" in message || "error" in message)) responses.push(message)
      response.writeHead(202).end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test address")
    const connection = await withoutProxy(() => connectEnterpriseMcp(admitted(`http://127.0.0.1:${address.port}/mcp`)))
    await waitFor(() => responses.length === 4)
    expect(responses.map((response) => response.id).sort()).toEqual([10, 11, 12, 13])
    expect(responses.every((response) => !!response.error)).toBe(true)
    expect(JSON.stringify(responses)).not.toMatch(/workspace-secret|model-secret|user-secret|unknown-secret/)
    await connection.close()
  })

  test("aborts initialization when lifecycle shutdown begins", async () => {
    let received!: () => void
    const initializeReceived = new Promise<void>((resolve) => (received = resolve))
    const methods: string[] = []
    const server = http.createServer(async (request, response) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks).toString())
      methods.push(message.method)
      response.writeHead(200, { "content-type": "application/json" })
      response.write('{"jsonrpc":"2.0"')
      received()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test address")
    const controller = new AbortController()
    const connecting = withoutProxy(() =>
      connectEnterpriseMcp(admitted(`http://127.0.0.1:${address.port}/mcp`), undefined, controller.signal).catch(
        (error) => error,
      ),
    )
    await initializeReceived
    controller.abort()
    const error = await connecting
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/^\[MCP_HTTP_(?:ABORTED|TIMEOUT)\]/)
    expect(methods).toEqual(["initialize"])
  })

  test("closes an initialized client before private map storage", async () => {
    let release!: () => void
    let reached!: () => void
    const barrier = new Promise<void>((resolve) => (release = resolve))
    const initialized = new Promise<void>((resolve) => (reached = resolve))
    const server = http.createServer(async (request, response) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks).toString())
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "barrier-test", version: "1" },
            },
          }),
        )
        return
      }
      response.writeHead(202).end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test address")
    const controller = new AbortController()
    const connecting = withoutProxy(() =>
      connectEnterpriseMcp(admitted(`http://127.0.0.1:${address.port}/mcp`), undefined, controller.signal, {
        afterInitialize: () => (reached(), barrier),
      }).catch((error) => error),
    )
    await initialized
    controller.abort()
    const error = await connecting
    release()
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/^\[MCP_HTTP_(?:ABORTED|TIMEOUT)\]/)
  })

  test("formats transport and SDK failures without reflected content", () => {
    expect(
      formatEnterpriseMcpConnectionError(
        new EnterpriseMcpHttpError("MCP_HTTP_TLS_UNTRUSTED", "secret response body Bearer token"),
      ),
    ).toBe("[MCP_HTTP_TLS_UNTRUSTED] TLS certificate is not trusted.")
    expect(formatEnterpriseMcpConnectionError(Object.assign(new Error("secret response"), { code: 401 }))).toBe(
      "[MCP_CONNECTION_FAILED] MCP initialize failed with HTTP status 401.",
    )
  })

  test("contains one close failure while closing every private connection", async () => {
    const closed: string[] = []
    await closeEnterpriseMcpConnections([
      {
        close: async () => {
          closed.push("first")
          throw new Error("secret close failure")
        },
      },
      { close: async () => void closed.push("second") },
    ])
    expect(closed).toEqual(["first", "second"])
  })
})

function admitted(url: string, connectTimeoutMs = enterpriseMcpPolicy.limits.connectTimeoutMs) {
  const policy = {
    ...enterpriseMcpPolicy,
    mode: "connect" as const,
    limits: { ...enterpriseMcpPolicy.limits, connectTimeoutMs },
    servers: {
      connection: {
        ...enterpriseMcpPolicy.servers["source-control"],
        url,
        dns: { allowedCidrs: ["127.0.0.0/8"], denyLoopback: false, denyLinkLocal: true },
        headers: { allowedNames: [], values: {} },
      },
    },
  }
  return admitEnterpriseMcpHttpServer(
    {
      enterpriseMode: true,
      policy,
      policySource: { kind: "managed-file", source: "/test/managed/opencode.json" },
      unmanagedPolicySources: [],
      references: { connection: { type: "managed", server: "connection" } },
      referenceSources: { connection: { kind: "managed-file", source: "/test/managed/opencode.json" } },
      platform: "linux",
    },
    "connection",
  )
}

async function withoutProxy<T>(fn: () => Promise<T>) {
  const original = Object.fromEntries(proxyNames.map((name) => [name, process.env[name]]))
  proxyNames.forEach((name) => delete process.env[name])
  try {
    return await fn()
  } finally {
    proxyNames.forEach((name) => {
      const value = original[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  }
}

async function waitFor(done: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (done()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for MCP test traffic.")
}
