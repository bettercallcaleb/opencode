import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import type { ConfigMCPEnterprisePolicyV1 } from "@opencode-ai/core/v1/config/mcp-enterprise-policy"
import {
  classifyEnterpriseMcpTlsError,
  createEnterpriseMcpFetch,
  EnterpriseMcpHttpError,
  type EnterpriseMcpHttpObservation,
} from "@/mcp/enterprise-http"
import { admitEnterpriseMcpHttpServer, type AdmittedEnterpriseMcpServer } from "@/mcp/enterprise-policy"
import { enterpriseMcpPolicy } from "../fixture/enterprise-mcp-policy"

const listeners: http.Server[] = []

afterEach(async () => {
  await Promise.all(
    listeners.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

describe("enterprise MCP HTTP executor", () => {
  test("accepts exact POST, GET, and DELETE while pinning the admitted address", async () => {
    const requests: Array<{ method?: string; url?: string; host?: string; body: string }> = []
    const server = await serve(async (request, response) => {
      requests.push({ method: request.method, url: request.url, host: request.headers.host, body: await body(request) })
      response.setHeader("content-type", "application/json")
      response.end('{"ok":true}')
    })
    let resolutions = 0
    const executor = createEnterpriseMcpFetch(admitted(server.url), {
      environment: {},
      resolve: async (hostname) => {
        resolutions++
        expect(hostname).toBe("mcp.enterprise.test")
        return [{ address: "127.0.0.1", family: 4 }]
      },
    })

    expect(
      await (await executor(managedUrl(server.url), { method: "POST", body: '{"jsonrpc":"2.0"}' })).json(),
    ).toEqual({ ok: true })
    expect((await executor(managedUrl(server.url), { method: "GET" })).status).toBe(200)
    expect((await executor(managedUrl(server.url), { method: "DELETE" })).status).toBe(200)
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/mcp",
        host: new URL(server.url).host.replace("127.0.0.1", "mcp.enterprise.test"),
        body: '{"jsonrpc":"2.0"}',
      },
      {
        method: "GET",
        url: "/mcp",
        host: new URL(server.url).host.replace("127.0.0.1", "mcp.enterprise.test"),
        body: "",
      },
      {
        method: "DELETE",
        url: "/mcp",
        host: new URL(server.url).host.replace("127.0.0.1", "mcp.enterprise.test"),
        body: "",
      },
    ])
    expect(resolutions).toBe(3)
  })

  test.each([
    [202, undefined, undefined],
    [204, undefined, undefined],
    [400, "application/json", undefined],
    [401, "application/json", 'Bearer realm="enterprise"'],
    [403, "application/json", undefined],
    [404, "application/json", undefined],
    [405, "application/json", undefined],
    [429, "application/json", undefined],
    [500, "application/json", undefined],
  ] as const)("returns an inspectable Response for HTTP %i", async (status, contentType, authenticate) => {
    const server = await serve((_request, response) => {
      if (contentType) response.setHeader("content-type", contentType)
      if (authenticate) response.setHeader("www-authenticate", authenticate)
      if (status === 429) response.setHeader("retry-after", "7")
      response.statusCode = status
      response.statusMessage = `Status ${status}`
      response.end(status === 202 || status === 204 ? undefined : JSON.stringify({ status }))
    })
    const observations: EnterpriseMcpHttpObservation[] = []
    const response = await createEnterpriseMcpFetch(admitted(server.url), {
      environment: {},
      resolve: loopback,
      observe: (item) => observations.push(item),
    })(managedUrl(server.url), { method: "POST" })

    expect(response.status).toBe(status)
    expect(response.statusText).toBe(`Status ${status}`)
    expect(await response.text()).toBe(status === 202 || status === 204 ? "" : JSON.stringify({ status }))
    expect(response.headers.get("www-authenticate")).toBe(authenticate ?? null)
    expect(response.headers.get("retry-after")).toBe(status === 429 ? "7" : null)
    expect(observations[0]?.errorCode).toBe(status >= 400 ? "MCP_HTTP_STATUS_ERROR" : undefined)
    expect(observations[0]?.responseStatus).toBe(status)
  })

  test("supports string, URL, Request, RequestInit, and bounded binary body forms", async () => {
    const requests: Array<{ method?: string; contentType?: string; protocol?: string; body: string }> = []
    const server = await serve(async (request, response) => {
      requests.push({
        method: request.method,
        contentType: request.headers["content-type"],
        protocol: request.headers["mcp-protocol-version"] as string | undefined,
        body: await body(request),
      })
      response.end("ok")
    })
    const endpoint = managedUrl(server.url)
    const executor = createEnterpriseMcpFetch(admitted(server.url), { environment: {}, resolve: loopback })
    await executor(endpoint, { method: "POST", body: "string-body" })
    await executor(new URL(endpoint), { method: "POST", body: new TextEncoder().encode("typed-body") })
    const request = new Request(endpoint, {
      method: "POST",
      headers: { "content-type": "request/type", "mcp-protocol-version": "request-version" },
      body: "request-body",
    })
    await executor(request, {
      headers: { "content-type": "init/type", "mcp-protocol-version": "init-version" },
    })
    expect(request.bodyUsed).toBe(true)
    await executor(endpoint, { method: "POST", body: new TextEncoder().encode("array-buffer").buffer })

    expect(requests).toEqual([
      { method: "POST", contentType: undefined, protocol: undefined, body: "string-body" },
      { method: "POST", contentType: undefined, protocol: undefined, body: "typed-body" },
      { method: "POST", contentType: "init/type", protocol: "init-version", body: "request-body" },
      { method: "POST", contentType: undefined, protocol: undefined, body: "array-buffer" },
    ])
  })

  test.each([
    [
      "alternate path",
      (url: URL) => {
        url.pathname = "/other"
      },
    ],
    [
      "child path",
      (url: URL) => {
        url.pathname += "/child"
      },
    ],
    [
      "query",
      (url: URL) => {
        url.search = "?token=secret"
      },
    ],
    [
      "fragment",
      (url: URL) => {
        url.hash = "secret"
      },
    ],
    [
      "scheme",
      (url: URL) => {
        url.protocol = "https:"
      },
    ],
    [
      "hostname",
      (url: URL) => {
        url.hostname = "other.enterprise.test"
      },
    ],
    [
      "port",
      (url: URL) => {
        url.port = String(Number(url.port) + 1)
      },
    ],
    [
      "credentials",
      (url: URL) => {
        url.username = "user"
      },
    ],
  ])("rejects %s before DNS", async (_name, mutate) => {
    let resolutions = 0
    const url = new URL("http://mcp.enterprise.test:19234/mcp")
    mutate(url)
    const executor = createEnterpriseMcpFetch(admitted("http://mcp.enterprise.test:19234/mcp"), {
      environment: {},
      resolve: async () => {
        resolutions++
        return [{ address: "127.0.0.1", family: 4 }]
      },
    })
    await expectCode(executor(url, { method: "POST" }), "MCP_HTTP_URL_REJECTED")
    expect(resolutions).toBe(0)
  })

  test("rejects unsupported methods and bodies on GET and DELETE", async () => {
    const executor = createEnterpriseMcpFetch(admitted("http://mcp.enterprise.test:19234/mcp"), { environment: {} })
    await expectCode(executor("http://mcp.enterprise.test:19234/mcp", { method: "PUT" }), "MCP_HTTP_METHOD_REJECTED")
    await expectCode(
      executor("http://mcp.enterprise.test:19234/mcp", { method: "GET", body: "x" }),
      "MCP_HTTP_METHOD_REJECTED",
    )
    await expectCode(
      executor("http://mcp.enterprise.test:19234/mcp", { method: "DELETE", body: "x" }),
      "MCP_HTTP_METHOD_REJECTED",
    )
  })

  test("rejects protocol-relative URLs before DNS", async () => {
    let resolutions = 0
    const executor = createEnterpriseMcpFetch(admitted("http://mcp.enterprise.test:19234/mcp"), {
      environment: {},
      resolve: async () => {
        resolutions++
        return []
      },
    })
    await expectCode(executor("//mcp.enterprise.test:19234/mcp"), "MCP_HTTP_URL_REJECTED")
    expect(resolutions).toBe(0)
  })

  test("rejects redirects without resolving or contacting their targets and sanitizes Location", async () => {
    let targetRequests = 0
    const target = await serve((_request, response) => {
      targetRequests++
      response.end("followed")
    })
    const source = await serve((_request, response) => {
      response.writeHead(302, { location: `${target.url}/login?token=TOP_SECRET#fragment` }).end()
    })
    const resolved: string[] = []
    const executor = createEnterpriseMcpFetch(admitted(source.url), {
      environment: {},
      resolve: async (hostname) => {
        resolved.push(hostname)
        return [{ address: "127.0.0.1", family: 4 }]
      },
    })
    const error = await capture(executor(managedUrl(source.url), { method: "POST" }))
    expect(error).toMatchObject({ code: "MCP_HTTP_REDIRECT_REJECTED" })
    expect(error.message).not.toContain("TOP_SECRET")
    expect(error.message).not.toContain("fragment")
    expect(resolved).toEqual(["mcp.enterprise.test"])
    expect(targetRequests).toBe(0)
  })

  test.each(["/same-origin-login?token=secret", "https://sso.enterprise.test/login?ticket=secret#fragment"])(
    "rejects redirect Location %s without resolving it",
    async (location) => {
      const source = await serve((_request, response) => {
        response.writeHead(307, { location }).end()
      })
      let resolutions = 0
      const executor = createEnterpriseMcpFetch(admitted(source.url), {
        environment: {},
        resolve: async () => {
          resolutions++
          return [{ address: "127.0.0.1", family: 4 }]
        },
      })
      const error = await capture(executor(managedUrl(source.url)))
      expect(error.code).toBe("MCP_HTTP_REDIRECT_REJECTED")
      expect(error.message).not.toContain("secret")
      expect(resolutions).toBe(1)
    },
  )

  test("uses admitted addresses from mixed DNS answers and never contacts denied addresses", async () => {
    let requests = 0
    const server = await serve((_request, response) => {
      requests++
      response.end("unexpected")
    })
    const denied = createEnterpriseMcpFetch(admitted(server.url, { denyLoopback: true }), {
      environment: {},
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    })
    await expectCode(denied(managedUrl(server.url)), "MCP_HTTP_DNS_ADDRESS_REJECTED")
    const mixed = createEnterpriseMcpFetch(
      admitted(server.url, { allowedCidrs: ["127.0.0.0/8", "169.254.0.0/16"], denyLinkLocal: true }),
      {
        environment: {},
        resolve: async () => [
          { address: "127.0.0.1", family: 4 },
          { address: "169.254.1.1", family: 4 },
        ],
      },
    )
    expect(await (await mixed(managedUrl(server.url))).text()).toBe("unexpected")
    const empty = createEnterpriseMcpFetch(admitted(server.url), { environment: {}, resolve: async () => [] })
    await expectCode(empty(managedUrl(server.url)), "MCP_HTTP_DNS_NO_ADMITTED_ADDRESS")
    const duplicate = createEnterpriseMcpFetch(admitted(server.url), {
      environment: {},
      resolve: async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    })
    expect((await duplicate(managedUrl(server.url))).status).toBe(200)
    expect(requests).toBe(2)
  })

  test.each([
    ["unspecified IPv4", "0.0.0.0", "0.0.0.0/0", 4],
    ["link-local IPv4", "169.254.1.1", "169.254.0.0/16", 4],
    ["multicast IPv4", "224.0.0.1", "224.0.0.0/4", 4],
    ["broadcast IPv4", "255.255.255.255", "255.255.255.255/32", 4],
    ["unspecified IPv6", "::", "::/0", 6],
    ["link-local IPv6", "fe80::1", "fe80::/10", 6],
    ["multicast IPv6", "ff02::1", "ff00::/8", 6],
  ] as const)("rejects %s before connecting", async (_name, address, cidr, family) => {
    const url = "http://mcp.enterprise.test:19234/mcp"
    const executor = createEnterpriseMcpFetch(
      admitted(url, {
        allowedCidrs: [cidr],
        denyLinkLocal: true,
        denyLoopback: false,
      }),
      { environment: {}, resolve: async () => [{ address, family }] },
    )
    await expectCode(executor(url), "MCP_HTTP_DNS_ADDRESS_REJECTED")
  })

  test("fails over deterministically only among admitted pinned addresses", async () => {
    const server = await serve((_request, response) => {
      response.end("fallback-ok")
    })
    const observations: EnterpriseMcpHttpObservation[] = []
    const executor = createEnterpriseMcpFetch(admitted(server.url, { allowedCidrs: ["127.0.0.0/8"] }), {
      environment: {},
      resolve: async () => [
        { address: "127.0.0.0", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      observe: (item) => observations.push(item),
    })
    expect(await (await executor(managedUrl(server.url))).text()).toBe("fallback-ok")
    expect(observations[0]?.selectedAddress).toBe("127.0.0.1")
  })

  test("does not perform a second DNS lookup when opening the actual connection", async () => {
    const server = await serve((_request, response) => {
      response.end("pinned")
    })
    let resolutions = 0
    const executor = createEnterpriseMcpFetch(admitted(server.url), {
      environment: {},
      resolve: async () =>
        ++resolutions === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "169.254.169.254", family: 4 }],
    })
    expect(await (await executor(managedUrl(server.url))).text()).toBe("pinned")
    expect(resolutions).toBe(1)
  })

  test("requires an authentic immutable factory-produced admitted server", async () => {
    const server = await serve((_request, response) => {
      response.end("authentic")
    })
    const fixture = admissionFixture(server.url)
    const genuine = fixture.admitted
    const raw = fixture.policy.servers["source-control"] as unknown as AdmittedEnterpriseMcpServer
    const structural = {
      id: genuine.id,
      alias: genuine.alias,
      url: genuine.url,
      transport: genuine.transport,
      dns: genuine.dns,
      headers: genuine.headers,
      limits: genuine.limits,
    } as AdmittedEnterpriseMcpServer
    const shallow = { ...genuine } as AdmittedEnterpriseMcpServer

    for (const forged of [raw, structural, shallow])
      expectSyncCode(() => createEnterpriseMcpFetch(forged), "MCP_HTTP_INTERNAL_ERROR")

    expect(Object.isFrozen(genuine)).toBe(true)
    expect(Object.isFrozen(genuine.dns)).toBe(true)
    expect(Object.isFrozen(genuine.dns.allowedCidrs)).toBe(true)
    expect(Object.isFrozen(genuine.headers.secretReferences)).toBe(true)
    expect(Object.isFrozen(genuine.limits)).toBe(true)
    expect(Reflect.set(genuine, "url", "http://evil.invalid/mcp")).toBe(false)
    expect(Reflect.set(genuine.limits, "maxResponseBytes", 1)).toBe(false)

    const originalUrl = genuine.url
    const originalCidrs = [...genuine.dns.allowedCidrs]
    const originalLimit = genuine.limits.maxResponseBytes
    Reflect.set(fixture.policy.servers["source-control"], "url", "http://evil.invalid/mcp")
    ;(fixture.policy.servers["source-control"].dns.allowedCidrs as string[]).push("0.0.0.0/0")
    Reflect.set(fixture.policy.limits, "maxResponseBytes", 1)
    expect(genuine.url).toBe(originalUrl)
    expect(genuine.dns.allowedCidrs).toEqual(originalCidrs)
    expect(genuine.limits.maxResponseBytes).toBe(originalLimit)
    expect(
      await (await createEnterpriseMcpFetch(genuine, { environment: {}, resolve: loopback })(originalUrl)).text(),
    ).toBe("authentic")
  })

  test("uses an admitted IPv6 address when the platform supports loopback IPv6", async () => {
    const server = http.createServer((_request, response) => response.end("ipv6"))
    listeners.push(server)
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(0, "::1", () => resolve(true))
    })
    if (!listening) return
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("IPv6 listener has no TCP address")
    const endpoint = `http://[::1]:${address.port}/mcp`
    const executor = createEnterpriseMcpFetch(
      admitted(endpoint, { allowedCidrs: ["::1/128"], hostname: "mcp.enterprise.test" }),
      {
        environment: {},
        resolve: async () => [{ address: "::1", family: 6 }],
      },
    )
    expect(await (await executor(managedUrl(endpoint))).text()).toBe("ipv6")
  })

  test("uses normal TLS trust and hostname verification without insecure retry", async () => {
    const trusted = await serveTls("doctor-tls-server.pem")
    const untrusted = createEnterpriseMcpFetch(admitted(trusted.url, { hostname: "localhost" }), {
      environment: {},
      resolve: loopback,
    })
    await expectCode(untrusted(managedUrl(trusted.url, "localhost")), "MCP_HTTP_TLS_UNTRUSTED")

    expect(await tlsClient(managedUrl(trusted.url, "localhost"))).toBe("ok:tls-ok")
    const mismatch = await serveTls("doctor-tls-mismatch.pem")
    expect(await tlsClient(managedUrl(mismatch.url, "localhost"))).toBe("error:MCP_HTTP_TLS_HOSTNAME_MISMATCH")
    expect(classifyEnterpriseMcpTlsError({ code: "CERT_HAS_EXPIRED" })).toBe("MCP_HTTP_TLS_EXPIRED")
    expect(classifyEnterpriseMcpTlsError({ code: "CERT_NOT_YET_VALID" })).toBe("MCP_HTTP_TLS_EXPIRED")
  })

  test("materializes environment secrets at request time and observes names only", async () => {
    const secret = "unique-secret-47b"
    let authorization = ""
    const server = await serve((request, response) => {
      authorization = request.headers.authorization ?? ""
      response.end("ok")
    })
    const observations: EnterpriseMcpHttpObservation[] = []
    const executor = createEnterpriseMcpFetch(admitted(server.url, { authorization: true }), {
      environment: { ENTERPRISE_MCP_TOKEN: secret },
      resolve: loopback,
      observe: (item) => observations.push(item),
    })
    await executor(managedUrl(server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","params":{"secret":"not-observed"}}',
    })
    expect(authorization).toBe(`Bearer ${secret}`)
    expect(observations[0]).toMatchObject({
      requestHeaderNames: ["authorization", "content-type"],
      requestFields: ["jsonrpc", "params"],
    })
    expect(JSON.stringify(observations)).not.toContain(secret)
    expect(JSON.stringify(observations)).not.toContain("not-observed")
  })

  test("rejects missing, empty, prefixed, invalid, conflicting, and forbidden headers safely", async () => {
    const url = "http://mcp.enterprise.test:19234/mcp"
    const make = (environment: Record<string, string | undefined>) =>
      createEnterpriseMcpFetch(admitted(url, { authorization: true }), { environment })
    await expectCode(make({})(url), "MCP_HTTP_SECRET_MISSING")
    await expectCode(make({ ENTERPRISE_MCP_TOKEN: "  " })(url), "MCP_HTTP_SECRET_MISSING")
    await expectCode(make({ ENTERPRISE_MCP_TOKEN: "Bearer token" })(url), "MCP_HTTP_SECRET_INVALID")
    await expectCode(make({ ENTERPRISE_MCP_TOKEN: "line\nbreak" })(url), "MCP_HTTP_SECRET_INVALID")
    await expectCode(
      make({ ENTERPRISE_MCP_TOKEN: "token" })(url, { headers: { authorization: "literal" } }),
      "MCP_HTTP_HEADER_REJECTED",
    )
    const plain = createEnterpriseMcpFetch(admitted(url), { environment: {} })
    await expectCode(plain(url, { headers: { Host: "evil.test" } }), "MCP_HTTP_HEADER_REJECTED")
    await expectCode(plain(url, { headers: { Cookie: "secret" } }), "MCP_HTTP_HEADER_REJECTED")
  })

  test("allows no proxy and NO_PROXY-only environments", async () => {
    const server = await serve((_request, response) => {
      response.end("direct")
    })
    for (const environment of [{}, { NO_PROXY: "mcp.enterprise.test" }, { no_proxy: "mcp.enterprise.test" }]) {
      const response = await createEnterpriseMcpFetch(admitted(server.url), { environment, resolve: loopback })(
        managedUrl(server.url),
      )
      expect(await response.text()).toBe("direct")
    }
  })

  test.each([
    { HTTPS_PROXY: "http://proxy-user:proxy-secret@proxy.invalid:8080" },
    { https_proxy: "http://proxy-user:proxy-secret@proxy.invalid:8080" },
    { ALL_PROXY: "http://proxy-user:proxy-secret@proxy.invalid:8080", NO_PROXY: "mcp.enterprise.test" },
  ])("fails closed for actual proxy configuration without exposing credentials", async (environment) => {
    const observations: EnterpriseMcpHttpObservation[] = []
    const executor = createEnterpriseMcpFetch(admitted("http://mcp.enterprise.test:19234/mcp"), {
      environment,
      observe: (item) => observations.push(item),
    })
    const error = await capture(executor("http://mcp.enterprise.test:19234/mcp"))
    expect(error.code).toBe("MCP_HTTP_PROXY_REJECTED")
    expect(error.message).not.toContain("proxy-secret")
    expect(JSON.stringify(observations)).not.toContain("proxy-secret")
  })

  test("returns incrementally readable ordered event streams and observes completion", async () => {
    const server = await serve(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "x-stream": "yes" })
      response.write("data: first\n\n")
      await Bun.sleep(150)
      response.write("data: second\n\n")
      response.end()
    })
    const observations: EnterpriseMcpHttpObservation[] = []
    const response = await createEnterpriseMcpFetch(admitted(server.url), {
      environment: {},
      resolve: loopback,
      observe: (item) => observations.push(item),
    })(managedUrl(server.url))
    expect(response.headers.get("x-stream")).toBe("yes")
    expect(response.body).not.toBeNull()
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n")
    expect(observations).toEqual([])
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: second\n\n")
    expect((await reader.read()).done).toBe(true)
    expect(observations[0]).toMatchObject({ responseStatus: 200, errorCode: undefined })
  })

  test("stream cancellation closes the socket and emits caller-cancellation metadata", async () => {
    let closed!: () => void
    const socketClosed = new Promise<void>((resolve) => (closed = resolve))
    const server = await serve((request, response) => {
      request.socket.once("close", closed)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write("data: first\n\n")
    })
    const observations: EnterpriseMcpHttpObservation[] = []
    const response = await createEnterpriseMcpFetch(admitted(server.url), {
      environment: {},
      resolve: loopback,
      observe: (item) => observations.push(item),
    })(managedUrl(server.url))
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n")
    await reader.cancel()
    await socketClosed
    expect(observations[0]?.errorCode).toBe("MCP_HTTP_ABORTED")
  })

  test("contains observer exceptions and provides immutable observation values", async () => {
    const server = await serve((_request, response) => {
      response.statusCode = 404
      response.end("missing")
    })
    let called = 0
    const response = await createEnterpriseMcpFetch(admitted(server.url), {
      environment: {},
      resolve: loopback,
      observe: (item) => {
        called++
        expect(Object.isFrozen(item)).toBe(true)
        expect(Object.isFrozen(item.requestHeaderNames)).toBe(true)
        expect(item.errorCode).toBe("MCP_HTTP_STATUS_ERROR")
        throw new Error("observer failure")
      },
    })(managedUrl(server.url))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("missing")
    expect(called).toBe(1)
  })

  test("enforces request, finite response, event frame, header, inactivity, and caller-abort limits", async () => {
    const ordinary = await serve((_request, response) => {
      response.end("x".repeat(1_025))
    })
    const executor = createEnterpriseMcpFetch(
      admitted(ordinary.url, { maxResponseBytes: 1_024, maxRequestBytes: 1_024 }),
      { environment: {}, resolve: loopback },
    )
    await expectCode(
      executor(managedUrl(ordinary.url), { method: "POST", body: "x".repeat(1_025) }),
      "MCP_HTTP_REQUEST_TOO_LARGE",
    )
    await expectCode(executor(managedUrl(ordinary.url)), "MCP_HTTP_RESPONSE_TOO_LARGE")

    const stream = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${"x".repeat(1_025)}`)
    })
    const streaming = createEnterpriseMcpFetch(
      admitted(stream.url, { maxStreamFrameBytes: 1_024, streamInactivityTimeoutMs: 100 }),
      { environment: {}, resolve: loopback },
    )
    await expectCode(
      streaming(managedUrl(stream.url)).then((response) => response.text()),
      "MCP_HTTP_STREAM_FRAME_TOO_LARGE",
    )

    const headers = await serve(async (_request, response) => {
      await Bun.sleep(200)
      response.end("late")
    })
    const headerTimeout = createEnterpriseMcpFetch(admitted(headers.url, { responseHeaderTimeoutMs: 100 }), {
      environment: {},
      resolve: loopback,
    })
    await expectCode(headerTimeout(managedUrl(headers.url)), "MCP_HTTP_TIMEOUT")

    const inactive = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.flushHeaders()
    })
    const inactivity = createEnterpriseMcpFetch(admitted(inactive.url, { streamInactivityTimeoutMs: 100 }), {
      environment: {},
      resolve: loopback,
    })
    await expectCode(
      inactivity(managedUrl(inactive.url)).then((response) => response.text()),
      "MCP_HTTP_TIMEOUT",
    )

    const aborted = await serve(async (_request, response) => {
      await Bun.sleep(500)
      response.end("late")
    })
    const controller = new AbortController()
    const pending = createEnterpriseMcpFetch(admitted(aborted.url), { environment: {}, resolve: loopback })(
      managedUrl(aborted.url),
      { signal: controller.signal },
    )
    controller.abort()
    await expectCode(pending, "MCP_HTTP_ABORTED")
  })
})

type AdmissionOptions = Partial<
  {
    allowedCidrs: string[]
    denyLoopback: boolean
    denyLinkLocal: boolean
    authorization: boolean
    hostname: string
  } & typeof enterpriseMcpPolicy.limits
>

function admitted(loopbackUrl: string, options?: AdmissionOptions) {
  return admissionFixture(loopbackUrl, options).admitted
}

function admissionFixture(loopbackUrl: string, options?: AdmissionOptions) {
  const url = new URL(managedUrl(loopbackUrl, options?.hostname))
  const base = enterpriseMcpPolicy.servers["source-control"]
  const policy: ConfigMCPEnterprisePolicyV1.Info = {
    ...enterpriseMcpPolicy,
    limits: {
      ...enterpriseMcpPolicy.limits,
      responseHeaderTimeoutMs: options?.responseHeaderTimeoutMs ?? enterpriseMcpPolicy.limits.responseHeaderTimeoutMs,
      streamInactivityTimeoutMs:
        options?.streamInactivityTimeoutMs ?? enterpriseMcpPolicy.limits.streamInactivityTimeoutMs,
      maxRequestBytes: options?.maxRequestBytes ?? enterpriseMcpPolicy.limits.maxRequestBytes,
      maxResponseBytes: options?.maxResponseBytes ?? enterpriseMcpPolicy.limits.maxResponseBytes,
      maxStreamFrameBytes: options?.maxStreamFrameBytes ?? enterpriseMcpPolicy.limits.maxStreamFrameBytes,
    },
    servers: {
      "source-control": {
        ...base,
        url: url.toString(),
        dns: {
          allowedCidrs: options?.allowedCidrs ?? ["127.0.0.0/8"],
          denyLoopback: options?.denyLoopback ?? false,
          denyLinkLocal: options?.denyLinkLocal ?? true,
        },
        headers: options?.authorization
          ? {
              allowedNames: ["authorization"],
              values: {
                authorization: { source: "environment", name: "ENTERPRISE_MCP_TOKEN", format: "Bearer" },
              },
            }
          : { allowedNames: [], values: {} },
      },
    },
  }
  return {
    policy,
    admitted: admitEnterpriseMcpHttpServer(
      {
        enterpriseMode: true,
        policy,
        policySource: { kind: "managed-file", source: "/test/managed/opencode.json" },
        unmanagedPolicySources: [],
        references: { test: { type: "managed", server: "source-control" } },
        referenceSources: { test: { kind: "managed-file", source: "/test/managed/opencode.json" } },
        requestedReference: "test",
        platform: process.platform,
      },
      "test",
    ),
  }
}

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = http.createServer(
    (request, response) => void Promise.resolve(handler(request, response)).catch((error) => response.destroy(error)),
  )
  listeners.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Test listener has no TCP address")
  return { url: `http://127.0.0.1:${address.port}/mcp` }
}

async function serveTls(certificate: string) {
  const server = https.createServer(
    {
      key: await Bun.file(path.join(import.meta.dir, "../fixture/doctor-tls-server-key.pem")).text(),
      cert: await Bun.file(path.join(import.meta.dir, `../fixture/${certificate}`)).text(),
    },
    (_request, response) => response.end("tls-ok"),
  )
  listeners.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("TLS listener has no TCP address")
  return { url: `https://127.0.0.1:${address.port}/mcp` }
}

async function tlsClient(endpoint: string) {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "../fixture/enterprise-http-tls-client.ts"), endpoint],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(import.meta.dir, "../fixture/doctor-tls-ca.pem") },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
  return stdout.trim()
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

const loopback = async () => [{ address: "127.0.0.1", family: 4 as const }]
const managedUrl = (value: string, hostname = "mcp.enterprise.test") =>
  value.replace("127.0.0.1", hostname).replace("[::1]", hostname)

async function capture(promise: Promise<unknown>) {
  try {
    await promise
    throw new Error("Expected enterprise MCP HTTP request to fail")
  } catch (error) {
    if (error instanceof EnterpriseMcpHttpError) return error
    throw error
  }
}

async function expectCode(promise: Promise<unknown>, code: EnterpriseMcpHttpError["code"]) {
  expect((await capture(promise)).code).toBe(code)
}

function expectSyncCode(fn: () => unknown, code: EnterpriseMcpHttpError["code"]) {
  try {
    fn()
    throw new Error("Expected enterprise MCP HTTP construction to fail")
  } catch (error) {
    if (!(error instanceof EnterpriseMcpHttpError)) throw error
    expect(error.code).toBe(code)
  }
}
