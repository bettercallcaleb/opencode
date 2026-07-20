import http from "node:http"
import { afterEach, describe, expect, test } from "bun:test"
import { discoverEnterpriseMcpCatalog, EnterpriseMcpCatalogError } from "../../src/mcp/enterprise-catalog"
import { connectEnterpriseMcp, type EnterpriseMcpConnection } from "../../src/mcp/enterprise-connection"
import { admitEnterpriseMcpHttpServer } from "../../src/mcp/enterprise-policy"
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

describe("enterprise MCP private tool catalog", () => {
  test("discovers one bounded paginated allowlist and keeps an immutable private catalog", async () => {
    const methods: string[] = []
    const { url } = await serve((message) => {
      methods.push(message.method)
      if (message.method !== "tools/list") return
      if (!message.params?.cursor)
        return {
          tools: [tool("search repositories"), tool("unlisted")],
          nextCursor: "page-2",
        }
      return { tools: [tool("get_issue")] }
    })
    const admitted = admission(url, ["search repositories", "get_issue"])
    const connection = await withoutProxy(() => connectEnterpriseMcp(admitted))
    const catalog = await discoverEnterpriseMcpCatalog(connection, admitted)
    expect(methods).toEqual(["notifications/initialized", "tools/list", "tools/list"])
    expect(catalog).toMatchObject({ admittedCount: 2, rejectedCount: 1, expectedCount: 2 })
    expect(catalog.tools.map((tool) => tool.futureToolID)).toEqual(["source_get_issue", "source_search_repositories"])
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog.tools[0].inputSchema)).toBe(true)
    expect(JSON.stringify(methods)).not.toContain("tools/call")
    await connection.close()
  })

  test("retains only a defensive immutable safe projection", async () => {
    const original = {
      ...tool("required", "original description"),
      title: "ignored title",
      outputSchema: { type: "object" as const, properties: { result: { type: "string" } } },
      annotations: { destructiveHint: true },
      icons: [{ src: "https://server.invalid/icon.svg" }],
      execution: { taskSupport: "required" },
      _meta: { secret: "ignored-meta-secret" },
      extension: { secret: "ignored-extension-secret" },
    }
    const { url } = await serve((message) => (message.method === "tools/list" ? { tools: [original] } : undefined))
    const admitted = admission(url, ["required"])
    const connection = await withoutProxy(() => connectEnterpriseMcp(admitted))
    const catalog = await discoverEnterpriseMcpCatalog(connection, admitted)
    original.description = "mutated description"
    ;(original.inputSchema.properties as Record<string, unknown>).changed = { type: "number" }
    ;(original.outputSchema.properties.result as { type: string }).type = "number"
    original.annotations.destructiveHint = false
    original.extension.secret = "mutated-extension-secret"
    expect(Object.keys(catalog.tools[0])).toEqual([
      "serverID",
      "referenceAlias",
      "rawName",
      "futureToolID",
      "description",
      "inputSchema",
      "outputSchema",
      "definitionFingerprint",
    ])
    expect(catalog.tools[0].description).toBe("original description")
    expect(catalog.tools[0].inputSchema).toEqual({ properties: {}, type: "object" })
    expect(catalog.tools[0].outputSchema).toEqual({
      properties: { result: { type: "string" } },
      type: "object",
    })
    expect(JSON.stringify(catalog)).not.toMatch(/ignored|secret|annotations|icons|execution|extension|_meta/)
    expect(Object.isFrozen(catalog.tools[0].outputSchema)).toBe(true)
    await connection.close()
  })

  test("requires the genuine open handle associated with the exact admitted server", async () => {
    const { url } = await serve((message) =>
      message.method === "tools/list" ? { tools: [tool("required")] } : undefined,
    )
    const admitted = admission(url, ["required"])
    const fakes = [
      {},
      { close: async () => undefined },
      { ...({ close: async () => undefined } as EnterpriseMcpConnection) },
      Object.assign({}, { close: async () => undefined }),
    ] as EnterpriseMcpConnection[]
    for (const fake of fakes) {
      const error = await discoverEnterpriseMcpCatalog(fake, admitted).catch((item) => item)
      expect(error.code).toBe("MCP_TOOL_CATALOG_DISCOVERY_FAILED")
    }
    const connection = await withoutProxy(() => connectEnterpriseMcp(admitted))
    const other = admission(url, ["required"])
    expect((await discoverEnterpriseMcpCatalog(connection, other).catch((item) => item)).code).toBe(
      "MCP_TOOL_CATALOG_DISCOVERY_FAILED",
    )
    await connection.close()
    expect((await discoverEnterpriseMcpCatalog(connection, admitted).catch((item) => item)).code).toBe(
      "MCP_TOOL_CATALOG_DISCOVERY_FAILED",
    )
  })

  test.each([
    ["MCP_TOOL_REQUIRED_MISSING", [tool("other")], ["required"]],
    ["MCP_TOOL_DUPLICATE", [tool("required"), tool("required")], ["required"]],
    ["MCP_NAME_COLLISION", [tool("required.one"), tool("required one")], ["required.one"]],
    ["MCP_TOOL_NAME_INVALID", [tool("bad\u0000name")], []],
    ["MCP_TOOL_DESCRIPTION_TOO_LARGE", [tool("required", "x".repeat(17_000))], ["required"]],
    ["MCP_TOOL_SCHEMA_INVALID", [{ ...tool("required"), inputSchema: { type: "string" } }], ["required"]],
    ["MCP_TOOL_SCHEMA_TOO_DEEP", [{ ...tool("required"), inputSchema: deepSchema(34) }], ["required"]],
  ] as const)("fails closed with %s and publishes no partial catalog", async (code, tools, allowlist) => {
    const { url } = await serve((message) => (message.method === "tools/list" ? { tools } : undefined))
    const admitted = admission(url, [...allowlist])
    const connection = await withoutProxy(() => connectEnterpriseMcp(admitted))
    const error = await discoverEnterpriseMcpCatalog(connection, admitted).catch((item) => item)
    expect(error).toBeInstanceOf(EnterpriseMcpCatalogError)
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("required.one")
    await connection.close()
  })

  test("enforces page, item, and cursor-loop limits", async () => {
    const cases = [
      {
        code: "MCP_TOOL_LIST_PAGE_LIMIT",
        limits: { maxToolListPages: 1 },
        page: () => ({ tools: [], nextCursor: "more" }),
      },
      {
        code: "MCP_TOOL_LIST_TOO_LARGE",
        limits: { maxListItems: 1 },
        page: () => ({ tools: [tool("one"), tool("two")] }),
      },
      {
        code: "MCP_TOOL_LIST_CURSOR_LOOP",
        limits: {},
        page: () => ({ tools: [], nextCursor: "same" }),
      },
    ] as const
    for (const item of cases) {
      const { url } = await serve((message) => (message.method === "tools/list" ? item.page() : undefined))
      const admitted = admission(url, [], item.limits)
      const connection = await withoutProxy(() => connectEnterpriseMcp(admitted))
      const error = await discoverEnterpriseMcpCatalog(connection, admitted).catch((value) => value)
      expect(error.code).toBe(item.code)
      await connection.close()
    }
  })

  test("enforces exact private cursor safety without reflecting cursor values", async () => {
    const cases = [
      ["", undefined],
      ["正常-cursor", undefined],
      ["x".repeat(1_025), "MCP_TOOL_LIST_CURSOR_INVALID"],
      ["secret\u0000cursor", "MCP_TOOL_LIST_CURSOR_INVALID"],
      ["secret\ncursor", "MCP_TOOL_LIST_CURSOR_INVALID"],
    ] as const
    for (const [cursor, code] of cases) {
      let pages = 0
      const { url } = await serve((message) => {
        if (message.method !== "tools/list") return
        pages++
        return pages === 1 ? { tools: [], nextCursor: cursor } : { tools: [] }
      })
      const admitted = admission(url, [])
      const connection = await withoutProxy(() => connectEnterpriseMcp(admitted))
      const result = await discoverEnterpriseMcpCatalog(connection, admitted).catch((item) => item)
      if (code) {
        expect(result.code).toBe(code)
        expect(result.message).not.toContain("secret")
      } else expect(result.resultCode).toBe("MCP_TOOL_CATALOG_DISCOVERY_PASS")
      await connection.close()
    }
  })

  test("requires tools capability and ignores other advertised capabilities", async () => {
    const cases = [
      ["omit", "MCP_TOOL_CATALOG_DISCOVERY_FAILED"],
      [{ tools: {} }, undefined],
      [{ tools: {}, prompts: {}, resources: {} }, undefined],
    ] as const
    for (const [capabilities, code] of cases) {
      const { url } = await serve(
        (message) => (message.method === "tools/list" ? { tools: [tool("required")] } : undefined),
        capabilities,
      )
      const admitted = admission(url, ["required"])
      const connection = await withoutProxy(() => connectEnterpriseMcp(admitted).catch((error) => error))
      if (connection instanceof Error) {
        expect(code).toBe("MCP_TOOL_CATALOG_DISCOVERY_FAILED")
        expect(connection.message).toBe("[MCP_CONNECTION_FAILED] MCP initialize failed.")
        continue
      }
      const result = await discoverEnterpriseMcpCatalog(connection, admitted).catch((item) => item)
      if (code) expect(result.code).toBe(code)
      else expect(result.resultCode).toBe("MCP_TOOL_CATALOG_DISCOVERY_PASS")
      await connection.close()
    }
  })

  test.each([
    ["MCP_TOOL_LIST_TOTAL_TOO_LARGE", { extension: "x".repeat(2_000) }, { maxToolListTotalBytes: 1_024 }],
    ["MCP_TOOL_DEFINITION_TOO_LARGE", { description: "x".repeat(2_000) }, { maxToolDefinitionBytes: 1_024 }],
    ["MCP_TOOL_SCHEMA_INVALID", { inputSchema: { type: "object", $ref: "https://evil.invalid/schema" } }, {}],
    ["MCP_TOOL_SCHEMA_INVALID", { inputSchema: { type: "object", $id: "https://evil.invalid/schema" } }, {}],
    [
      "MCP_TOOL_SCHEMA_ARRAY_TOO_LARGE",
      { inputSchema: { type: "object", required: ["one", "two"] } },
      { maxToolSchemaArrayItems: 1 },
    ],
  ] as const)("bounds complete definitions and schemas with %s", async (code, extra, limits) => {
    const { url } = await serve((message) =>
      message.method === "tools/list" ? { tools: [{ ...tool("required"), ...extra }] } : undefined,
    )
    const admitted = admission(url, ["required"], limits)
    const connection = await withoutProxy(() => connectEnterpriseMcp(admitted))
    const error = await discoverEnterpriseMcpCatalog(connection, admitted).catch((item) => item)
    expect(error.code).toBe(code)
    await connection.close()
  })

  test("bounds aggregate retained catalog bytes", async () => {
    const { url } = await serve((message) =>
      message.method === "tools/list"
        ? { tools: [tool("one", "x".repeat(600)), tool("two", "x".repeat(600))] }
        : undefined,
    )
    const admitted = admission(url, ["one", "two"], {
      maxToolDefinitionBytes: 2_048,
      maxToolCatalogBytes: 1_024,
    })
    const connection = await withoutProxy(() => connectEnterpriseMcp(admitted))
    const error = await discoverEnterpriseMcpCatalog(connection, admitted).catch((item) => item)
    expect(error.code).toBe("MCP_TOOL_CATALOG_TOO_LARGE")
    await connection.close()
  })

  test("aborts between pages and immediately before storage", async () => {
    for (const hook of ["afterPage", "afterValidation", "afterConstruction", "beforeStorage"] as const) {
      const { url } = await serve((message) =>
        message.method === "tools/list" ? { tools: [tool("required")] } : undefined,
      )
      const admitted = admission(url, ["required"])
      const controller = new AbortController()
      const connection = await withoutProxy(() => connectEnterpriseMcp(admitted, undefined, controller.signal))
      const error = await discoverEnterpriseMcpCatalog(connection, admitted, controller.signal, {
        [hook]: async () => controller.abort(),
      }).catch((item) => item)
      expect(error.code).toBe("MCP_TOOL_CATALOG_DISCOVERY_FAILED")
    }
  })
})

function tool(name: string, description = "safe description") {
  return { name, description, inputSchema: { type: "object" as const, properties: {} } }
}

function deepSchema(depth: number): Record<string, unknown> {
  return depth === 1 ? { type: "object" } : { type: "object", properties: { nested: deepSchema(depth - 1) } }
}

async function serve(
  page: (message: { method: string; params?: { cursor?: string } }) => unknown,
  capabilities: unknown | "omit" = { tools: { listChanged: true } },
) {
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(405).end()
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
            ...(capabilities === "omit" ? {} : { capabilities }),
            serverInfo: { name: "catalog-test", version: "1" },
          },
        }),
      )
      return
    }
    const result = page(message)
    if (result) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
      return
    }
    response.writeHead(202).end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing test address")
  return { url: `http://127.0.0.1:${address.port}/mcp` }
}

function admission(url: string, names: string[], limits: Record<string, number> = {}) {
  const policy = {
    ...enterpriseMcpPolicy,
    mode: "catalog" as const,
    limits: { ...enterpriseMcpPolicy.limits, ...limits },
    servers: {
      catalog: {
        ...enterpriseMcpPolicy.servers["source-control"],
        url,
        dns: { allowedCidrs: ["127.0.0.0/8"], denyLoopback: false, denyLinkLocal: true },
        headers: { allowedNames: [], values: {} },
        capabilities: {
          ...enterpriseMcpPolicy.servers["source-control"].capabilities,
          tools: { mode: "allowlist" as const, names, dynamicChanges: "readmit" as const },
        },
      },
    },
  }
  return admitEnterpriseMcpHttpServer(
    {
      enterpriseMode: true,
      policy,
      policySource: { kind: "managed-file", source: "/test/managed/opencode.json" },
      unmanagedPolicySources: [],
      references: { source: { type: "managed", server: "catalog" } },
      referenceSources: { source: { kind: "managed-file", source: "/test/managed/opencode.json" } },
      platform: "linux",
    },
    "source",
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
