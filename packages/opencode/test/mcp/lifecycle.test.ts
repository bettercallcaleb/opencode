import path from "node:path"
import { createServer, type IncomingMessage } from "node:http"
import { pathToFileURL } from "node:url"
import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { MCP } from "../../src/mcp/index"
import { McpCatalog } from "../../src/mcp/catalog"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")

type Page<T> = { items: T[]; nextCursor?: string }

interface LifecycleServerState {
  tools: Tool[]
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  resourceTemplates: Array<{ name: string; uriTemplate: string; description?: string }>
  toolPages?: Record<string, Page<Tool>>
  promptPages?: Record<string, Page<{ name: string; description?: string }>>
  resourcePages?: Record<string, Page<{ name: string; uri: string; description?: string }>>
  resourceTemplatePages?: Record<string, Page<{ name: string; uriTemplate: string; description?: string }>>
  listToolsError?: string
  requestDelay?: number
  roots?: Array<{ uri: string; name?: string }>
  requests: string[]
  aborted: number
  calls: string[]
}

function lifecycleServer(input?: {
  capabilities?: ServerCapabilities
  instructions?: string
  requestRoots?: boolean
  toolName?: string
  toolResult?: string
}) {
  const capabilities = input?.capabilities ?? { tools: {}, prompts: {}, resources: {} }
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const state: LifecycleServerState = {
        tools: [
          {
            name: input?.toolName ?? "test_tool",
            description: "A test tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        prompts: [],
        resources: [],
        resourceTemplates: [],
        requests: [],
        aborted: 0,
        calls: [],
      }

      const makeProtocol = async () => {
        const protocol = new Server(
          { name: "mcp-lifecycle", version: "1.0.0" },
          { capabilities, instructions: input?.instructions },
        )
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
        })

        if (capabilities.tools) {
          protocol.setRequestHandler(ListToolsRequestSchema, (request) => {
            if (state.listToolsError) throw new Error(state.listToolsError)
            const page = state.toolPages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ tools: page?.items ?? state.tools, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(CallToolRequestSchema, ({ params }) => {
            state.calls.push(params.name)
            return Promise.resolve({
              content: [{ type: "text" as const, text: input?.toolResult ?? "LIFECYCLE_MCP_OK" }],
            })
          })
        }
        if (capabilities.prompts) {
          protocol.setRequestHandler(ListPromptsRequestSchema, (request) => {
            const page = state.promptPages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ prompts: page?.items ?? state.prompts, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(GetPromptRequestSchema, async () => {
            if (state.requestDelay) await Bun.sleep(state.requestDelay)
            return { messages: [{ role: "user", content: { type: "text", text: "prompt result" } }] }
          })
        }
        if (capabilities.resources) {
          protocol.setRequestHandler(ListResourcesRequestSchema, (request) => {
            const page = state.resourcePages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ resources: page?.items ?? state.resources, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => {
            const page = state.resourceTemplatePages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({
              resourceTemplates: page?.items ?? state.resourceTemplates,
              nextCursor: page?.nextCursor,
            })
          })
          protocol.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            if (state.requestDelay) await Bun.sleep(state.requestDelay)
            return { contents: [{ uri: request.params.uri, text: "resource result" }] }
          })
        }

        protocol.oninitialized = () => {
          if (!input?.requestRoots) return
          if (!protocol.getClientCapabilities()?.roots) return
          void Bun.sleep(25)
            .then(() => protocol.listRoots())
            .then((result) => {
              state.roots = result.roots
            })
            .catch(() => {})
        }
        await protocol.connect(transport)
        return { protocol, transport }
      }

      let current = await makeProtocol()
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          state.requests.push(request.method)
          request.signal.addEventListener("abort", () => state.aborted++)
          return current.transport.handleRequest(request)
        },
      })

      return {
        state,
        url: http.url.toString(),
        sendToolListChanged: () => current.protocol.sendToolListChanged(),
        restart: async () => {
          current = await makeProtocol()
        },
        close: async () => {
          await current.protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function legacySseServer() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const state = {
        streamableAttempts: 0,
        sseConnections: 0,
        messagePosts: 0,
        initialized: 0,
        toolsListed: 0,
        toolsCalled: 0,
        paths: [] as string[],
      }
      const protocol = new Server({ name: "mcp-legacy-sse", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.oninitialized = () => state.initialized++
      protocol.setRequestHandler(ListToolsRequestSchema, () => {
        state.toolsListed++
        return Promise.resolve({
          tools: [{ name: "legacy_sentinel", inputSchema: { type: "object", properties: {} } }],
        })
      })
      protocol.setRequestHandler(CallToolRequestSchema, ({ params }) => {
        state.toolsCalled++
        if (params.name !== "legacy_sentinel") throw new Error(`Unknown tool: ${params.name}`)
        return Promise.resolve({ content: [{ type: "text" as const, text: "LEGACY_SSE_OK" }] })
      })

      let transport: SSEServerTransport | undefined
      const http = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        state.paths.push(`${request.method} ${url.pathname}`)
        if (request.method === "POST" && url.pathname === "/legacy") {
          state.streamableAttempts++
          response.writeHead(405).end("Streamable HTTP unavailable")
          return
        }
        if (request.method === "GET" && url.pathname === "/legacy") {
          state.sseConnections++
          transport = new SSEServerTransport("/messages", response)
          void protocol.connect(transport).catch((error) => response.destroy(error))
          return
        }
        if (request.method === "POST" && url.pathname === "/messages" && transport) {
          state.messagePosts++
          void readJson(request)
            .then((body) => transport?.handlePostMessage(request, response, body))
            .catch((error) => response.destroy(error))
          return
        }
        response.writeHead(404).end("Not found")
      })
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject)
        http.listen(0, "127.0.0.1", resolve)
      })
      const address = http.address()
      if (!address || typeof address === "string") throw new Error("Legacy SSE listener has no TCP address")

      return {
        state,
        url: `http://127.0.0.1:${address.port}/legacy`,
        close: async () => {
          await protocol.close().catch(() => {})
          await transport?.close().catch(() => {})
          await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())))
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

const execute = (tool: MCPNS.McpTool) =>
  McpCatalog.convertTool(tool.def, tool.client, tool.timeout).execute?.({}, {
    toolCallId: "call_mcp",
    abortSignal: new AbortController().signal,
  } as never)

function hangingLifecycleServer() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name: "mcp-lifecycle-hanging", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const requests: string[] = []
      let aborted = 0
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          requests.push(request.method)
          request.signal.addEventListener("abort", () => aborted++)
          return new Promise<Response>(() => {})
        },
      })
      return {
        requests,
        aborted: () => aborted,
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function statusName(status: Record<string, MCPNS.Status> | MCPNS.Status, server: string) {
  if ("status" in status) return status.status
  return status[server]?.status
}

const remote = (url: string, timeout?: number) => ({ type: "remote" as const, url, oauth: false as const, timeout })

it.instance("advertises and lists the instance directory as its root", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ requestRoots: true })
    const mcp = yield* MCP.Service
    const test = yield* TestInstance
    yield* mcp.add("roots", remote(server.url))

    const roots = yield* pollWithTimeout(
      Effect.sync(() => server.state.roots),
      "server did not receive roots",
    )
    expect(roots).toEqual([{ uri: pathToFileURL(test.directory).href }])
  }),
)

it.instance(
  "local mcp cwd resolves relative paths against instance directory",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const test = yield* TestInstance
      yield* mcp.add("rel-cwd", {
        type: "local",
        command: [process.execPath, stdioFixture],
        cwd: "plugins/sub",
      })

      expect((yield* mcp.tools())["rel-cwd_current_directory"]?.def.description).toBe(
        path.resolve(test.directory, "plugins/sub"),
      )
    }),
  { init: (directory) => Effect.promise(() => Bun.$`mkdir -p ${path.join(directory, "plugins/sub")}`.quiet()) },
)

it.instance("falls back from Streamable HTTP to a live legacy SSE MCP server", () =>
  Effect.gen(function* () {
    const server = yield* legacySseServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("legacy-sse", remote(server.url))

    expect((yield* mcp.status())["legacy-sse"]?.status).toBe("connected")
    const tool = (yield* mcp.tools())["legacy-sse_legacy_sentinel"]
    expect(tool).toBeDefined()
    expect(yield* Effect.promise(() => execute(tool!)!)).toMatchObject({
      content: [{ type: "text", text: "LEGACY_SSE_OK" }],
    })
    expect(server.state).toMatchObject({
      streamableAttempts: 1,
      sseConnections: 1,
      initialized: 1,
      toolsListed: 1,
      toolsCalled: 1,
    })
    expect(server.state.messagePosts).toBeGreaterThanOrEqual(4)
    expect(server.state.paths.every((item) => item.endsWith(" /legacy") || item.endsWith(" /messages"))).toBe(true)

    yield* mcp.disconnect("legacy-sse")
    expect((yield* mcp.status())["legacy-sse"]?.status).toBe("disabled")
  }),
)

it.instance(
  "keeps a managed reference inert beside callable local and remote MCP servers",
  () =>
    Effect.gen(function* () {
      const server = yield* lifecycleServer({ toolName: "remote_sentinel", toolResult: "REMOTE_MCP_OK" })
      const test = yield* TestInstance
      const pidFile = path.join(test.directory, "local-mcp.pid")
      const mcp = yield* MCP.Service
      yield* mcp.add("local-test", {
        type: "local",
        command: [process.execPath, stdioFixture, "--callable"],
        environment: { MCP_LIFECYCLE_PID_FILE: pidFile },
      })
      yield* mcp.add("remote-test", remote(server.url))

      expect(yield* mcp.status()).toMatchObject({
        "local-test": { status: "connected" },
        "remote-test": { status: "connected" },
        "managed-test": { status: "disabled" },
      })
      expect(Object.keys(yield* mcp.clients()).sort()).toEqual(["local-test", "remote-test"])
      const tools = yield* mcp.tools()
      expect(Object.keys(tools).sort()).toEqual([
        "local-test_current_directory",
        "local-test_local_sentinel",
        "remote-test_remote_sentinel",
      ])
      expect(yield* Effect.promise(() => execute(tools["local-test_local_sentinel"]!)!)).toMatchObject({
        content: [{ type: "text", text: "LOCAL_MCP_OK" }],
      })
      expect(yield* Effect.promise(() => execute(tools["remote-test_remote_sentinel"]!)!)).toMatchObject({
        content: [{ type: "text", text: "REMOTE_MCP_OK" }],
      })
      expect(server.state.calls).toEqual(["remote_sentinel"])
      expect(Object.keys(yield* mcp.prompts()).some((key) => key.startsWith("managed-test:"))).toBe(false)
      expect(Object.keys(yield* mcp.resources()).some((key) => key.startsWith("managed-test:"))).toBe(false)
      expect(Object.keys(yield* mcp.resourceTemplates()).some((key) => key.startsWith("managed-test:"))).toBe(false)
      expect((yield* mcp.instructions()).some((item) => item.name === "managed-test")).toBe(false)

      const pid = Number(yield* Effect.promise(() => Bun.file(pidFile).text()))
      yield* mcp.disconnect("local-test")
      yield* mcp.disconnect("remote-test")
      yield* pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return undefined
          } catch {
            return true
          }
        }),
        "local MCP fixture process was not terminated",
      )
      yield* pollWithTimeout(
        Effect.sync(() => (server.state.aborted > 0 ? true : undefined)),
        "remote MCP transport was not closed",
      )
      expect(Object.keys(yield* mcp.clients())).toEqual([])
    }),
  { config: { mcp: { "managed-test": { type: "managed", server: "managed-test" } } } },
)

it.instance("tools() reuses cached definitions until a protocol notification", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: { listChanged: true } } })
    const mcp = yield* MCP.Service
    yield* mcp.add("cache-server", remote(server.url))
    server.state.tools = [{ name: "next_tool", inputSchema: { type: "object", properties: {} } }]

    expect(Object.keys(yield* mcp.tools())).toEqual(["cache-server_test_tool"])
    yield* Effect.promise(server.sendToolListChanged)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const keys = Object.keys(yield* mcp.tools())
        return keys.includes("cache-server_next_tool") ? keys : undefined
      }),
      "tool cache did not refresh",
    )
    expect(Object.keys(yield* mcp.tools())).toEqual(["cache-server_next_tool"])
  }),
)

it.instance("instructions() returns non-empty connected server instructions with tool names", () =>
  Effect.gen(function* () {
    const guide = yield* lifecycleServer({ instructions: "Use lookup before mutate." })
    const blank = yield* lifecycleServer({ instructions: "   " })
    const mcp = yield* MCP.Service
    yield* mcp.add("guide-server", remote(guide.url))
    yield* mcp.add("blank-server", remote(blank.url))

    expect(yield* mcp.instructions()).toEqual([
      { name: "guide-server", instructions: "Use lookup before mutate.", tools: ["guide-server_test_tool"] },
    ])
    yield* mcp.disconnect("guide-server")
    expect(yield* mcp.instructions()).toEqual([])
  }),
)

it.instance("follows cursors when listing tools, prompts, resources, and templates", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.toolPages = {
      initial: { items: [{ name: "tool-one", inputSchema: { type: "object" } }], nextCursor: "tools-2" },
      "tools-2": { items: [{ name: "tool-two", inputSchema: { type: "object" } }] },
    }
    server.state.promptPages = {
      initial: { items: [{ name: "prompt-one" }], nextCursor: "prompts-2" },
      "prompts-2": { items: [{ name: "prompt-two" }] },
    }
    server.state.resourcePages = {
      initial: { items: [{ name: "resource-one", uri: "test://one" }], nextCursor: "resources-2" },
      "resources-2": { items: [{ name: "resource-two", uri: "test://two" }] },
    }
    server.state.resourceTemplatePages = {
      initial: { items: [{ name: "template-one", uriTemplate: "test://one/{id}" }], nextCursor: "templates-2" },
      "templates-2": { items: [{ name: "template-two", uriTemplate: "test://two/{id}" }] },
    }
    const mcp = yield* MCP.Service
    yield* mcp.add("paged-server", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["paged-server_tool-one", "paged-server_tool-two"])
    expect(Object.keys(yield* mcp.prompts())).toEqual(["paged-server:prompt-one", "paged-server:prompt-two"])
    expect(Object.keys(yield* mcp.resources())).toEqual(["paged-server:test://one", "paged-server:test://two"])
    expect(Object.keys(yield* mcp.resourceTemplates())).toEqual([
      "paged-server:test://one/{id}",
      "paged-server:test://two/{id}",
    ])
  }),
)

it.instance("accepts empty cursors and rejects repeated cursors", () =>
  Effect.gen(function* () {
    const empty = yield* lifecycleServer({ capabilities: { prompts: {} } })
    empty.state.promptPages = {
      initial: { items: [{ name: "prompt-one" }], nextCursor: "" },
      "": { items: [{ name: "prompt-two" }] },
    }
    const looping = yield* lifecycleServer({ capabilities: { tools: {} } })
    looping.state.toolPages = {
      initial: { items: [], nextCursor: "repeat" },
      repeat: { items: [], nextCursor: "repeat" },
    }
    const mcp = yield* MCP.Service
    yield* mcp.add("empty-cursor", remote(empty.url))
    const result = yield* mcp.add("looping-cursor", remote(looping.url))

    expect(Object.keys(yield* mcp.prompts())).toEqual(["empty-cursor:prompt-one", "empty-cursor:prompt-two"])
    expect(statusName(result.status, "looping-cursor")).toBe("failed")
  }),
)

it.instance("disconnect removes protocol data and reconnect establishes a new session", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("reconnect-server", remote(server.url))
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("connected")

    yield* mcp.disconnect("reconnect-server")
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("disabled")
    expect(Object.keys(yield* mcp.tools())).toEqual([])
    yield* pollWithTimeout(
      Effect.sync(() => (server.state.aborted > 0 ? server.state.aborted : undefined)),
      "disconnected HTTP session was not aborted",
    )

    yield* Effect.promise(server.restart)
    yield* mcp.connect("reconnect-server")
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["reconnect-server_test_tool"])
  }),
)

it.instance("add() closes the old protocol session when replacing a server", () =>
  Effect.gen(function* () {
    const first = yield* lifecycleServer()
    const second = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("replace-server", remote(first.url))
    yield* mcp.add("replace-server", remote(second.url))

    yield* pollWithTimeout(
      Effect.sync(() => (first.state.aborted > 0 ? first.state.aborted : undefined)),
      "replaced HTTP session was not aborted",
    )
    expect(second.state.aborted).toBe(0)
    expect(Object.keys(yield* mcp.tools())).toEqual(["replace-server_test_tool"])
  }),
)

it.instance("one failed server does not affect another connected server", () =>
  Effect.gen(function* () {
    const good = yield* lifecycleServer()
    good.state.tools = [{ name: "good_tool", inputSchema: { type: "object" } }]
    const bad = yield* lifecycleServer()
    bad.state.listToolsError = "listTools failed"
    const mcp = yield* MCP.Service
    yield* mcp.add("good-server", remote(good.url))
    yield* mcp.add("bad-server", remote(bad.url))

    expect((yield* mcp.status())["good-server"]?.status).toBe("connected")
    expect((yield* mcp.status())["bad-server"]?.status).toBe("failed")
    expect(Object.keys(yield* mcp.tools())).toEqual(["good-server_good_tool"])
  }),
)

it.instance("falls back when output schema refs fail SDK tool discovery", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.tools = [
      {
        name: "render_screen",
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        outputSchema: { type: "object", properties: { screen: { $ref: "#/$defs/ScreenInstance" } } },
      },
    ]
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("schema-server", remote(server.url))

    expect(statusName(result.status, "schema-server")).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["schema-server_render_screen"])
  }),
)

it.instance("does not fall back for protocol tool discovery errors", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.listToolsError = "transport closed"
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("broken-server", remote(server.url))

    expect(statusName(result.status, "broken-server")).toBe("failed")
  }),
)

it.instance("disabled server is marked disabled without opening a protocol session", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("disabled-server", { ...remote(server.url), enabled: false })

    expect((yield* mcp.status())["disabled-server"]?.status).toBe("disabled")
    expect(server.state.requests).toEqual([])
  }),
)

it.instance("returns prompts and URI-keyed resources from connected servers", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.prompts = [{ name: "my-prompt", description: "A test prompt" }]
    server.state.resources = [
      { name: "same-name", uri: "file:///test.txt" },
      { name: "same-name", uri: "ui://component-state" },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("content-server", remote(server.url))

    expect(Object.keys(yield* mcp.prompts())).toEqual(["content-server:my-prompt"])
    expect(Object.keys(yield* mcp.resources())).toEqual([
      "content-server:file:///test.txt",
      "content-server:ui://component-state",
    ])
    yield* mcp.disconnect("content-server")
    expect(yield* mcp.prompts()).toEqual({})
  }),
)

it.instance("uses per-server timeouts for prompt and resource requests", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.requestDelay = 200
    const mcp = yield* MCP.Service
    yield* mcp.add("timeout-server", remote(server.url, 50))

    expect(yield* mcp.getPrompt("timeout-server", "test")).toBeUndefined()
    expect(yield* mcp.readResource("timeout-server", "test://resource")).toBeUndefined()
  }),
)

it.instance("connects resource-only, prompt-only, and tools-only servers", () =>
  Effect.gen(function* () {
    const resources = yield* lifecycleServer({ capabilities: { resources: {} } })
    resources.state.resources = [{ name: "docs", uri: "docs://readme" }]
    const prompts = yield* lifecycleServer({ capabilities: { prompts: {} } })
    prompts.state.prompts = [{ name: "review" }]
    const tools = yield* lifecycleServer({ capabilities: { tools: {} } })
    const mcp = yield* MCP.Service
    yield* mcp.add("resource-only", remote(resources.url))
    yield* mcp.add("prompt-only", remote(prompts.url))
    yield* mcp.add("tools-only", remote(tools.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["tools-only_test_tool"])
    expect(Object.keys(yield* mcp.prompts())).toEqual(["prompt-only:review"])
    expect(Object.keys(yield* mcp.resources())).toEqual(["resource-only:docs://readme"])
  }),
)

it.instance("connect and disconnect fail for unknown servers", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    for (const operation of [mcp.connect("missing"), mcp.disconnect("missing")]) {
      const exit = yield* operation.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "MCP.NotFoundError", name: "missing" })
      }
    }
    expect(yield* mcp.status()).toEqual({})
    expect(yield* mcp.tools()).toEqual({})
  }),
)

it.instance("unavailable remote server is marked failed without tools", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: () => new Response("unavailable", { status: 503 }) })),
      (http) => Effect.promise(() => http.stop(true)),
    )
    const mcp = yield* MCP.Service
    yield* mcp.add("unavailable", remote(server.url.toString(), 500))

    expect((yield* mcp.status()).unavailable?.status).toBe("failed")
    expect(yield* mcp.tools()).toEqual({})
  }),
)

it.instance("tools() prefixes sanitized server and tool names", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.tools = [
      { name: "tool-a", inputSchema: { type: "object" } },
      { name: "tool.b", inputSchema: { type: "object" } },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("my.special-server", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["my_special-server_tool-a", "my_special-server_tool_b"])
  }),
)

it.instance("local stdio timeout terminates the real server process", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const pidFile = path.join(test.directory, "mcp.pid")
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("hanging-stdio", {
      type: "local",
      command: [process.execPath, stdioFixture, "--hang"],
      environment: { MCP_LIFECYCLE_PID_FILE: pidFile },
      timeout: 100,
    })

    expect(statusName(result.status, "hanging-stdio")).toBe("failed")
    const pid = yield* pollWithTimeout(
      Effect.promise(async () => {
        const file = Bun.file(pidFile)
        return (await file.exists()) ? Number(await file.text()) : undefined
      }),
      "stdio fixture did not publish its pid",
    )
    yield* pollWithTimeout(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)
          return undefined
        } catch {
          return true
        }
      }),
      "stdio fixture process was not terminated",
    )
  }),
)

it.instance("remote timeout aborts both real HTTP transport attempts", () =>
  Effect.gen(function* () {
    const server = yield* hangingLifecycleServer()
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("hanging-remote", remote(server.url, 100))

    expect(statusName(result.status, "hanging-remote")).toBe("failed")
    yield* pollWithTimeout(
      Effect.sync(() => (server.aborted() >= 2 ? server.aborted() : undefined)),
      "remote transport requests were not aborted",
    )
    expect(server.requests).toEqual(["POST", "GET"])
  }),
)

it.live("McpOAuthCallback.cancelPending rejects the pending callback", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => McpOAuthCallback.waitForCallback("abc123hexstate", "my-mcp-server")),
    (callback) =>
      Effect.gen(function* () {
        McpOAuthCallback.cancelPending("my-mcp-server")
        const exit = yield* Effect.tryPromise({
          try: () => callback,
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    () => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore),
  ),
)
