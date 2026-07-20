import path from "node:path"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import { expect } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { MCP } from "../../src/mcp"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { enterpriseMcpPolicy } from "../fixture/enterprise-mcp-policy"

const it = testEffect(LayerNode.compile(MCP.node))
const connectRequests: unknown[] = []
const connectHttpMethods: string[] = []
const connectPaths: string[] = []
let diagnoseRequests = 0

const enterpriseMode = Effect.acquireRelease(
  Effect.sync(() => {
    const original = Flag.OPENCODE_ENTERPRISE_MODE
    Flag.OPENCODE_ENTERPRISE_MODE = true
    return original
  }),
  (original) =>
    Effect.sync(() => {
      Flag.OPENCODE_ENTERPRISE_MODE = original
    }),
)

it.instance(
  "disables configured MCP servers and every public exposure boundary",
  () =>
    Effect.gen(function* () {
      yield* enterpriseMode
      const mcp = yield* MCP.Service
      const instance = yield* TestInstance

      expect(yield* mcp.status()).toEqual({
        remote: { status: "disabled" },
        local: { status: "disabled" },
      })
      expect(yield* mcp.clients()).toEqual({})
      expect(yield* mcp.tools()).toEqual({})
      expect(yield* mcp.prompts()).toEqual({})
      expect(yield* mcp.resources()).toEqual({})
      expect(yield* mcp.resourceTemplates()).toEqual({})
      expect(yield* mcp.instructions()).toEqual([])
      expect(yield* mcp.getPrompt("remote", "prompt")).toBeUndefined()
      expect(yield* mcp.readResource("remote", "file:///resource")).toBeUndefined()
      expect(yield* mcp.supportsOAuth("remote")).toBe(false)
      expect(yield* mcp.hasStoredTokens("remote")).toBe(false)
      expect(yield* mcp.getAuthStatus("remote")).toBe("not_authenticated")
      expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "mcp-spawned")).exists())).toBe(false)
    }),
  {
    config: {
      mcp: {
        remote: { type: "remote", url: "not a URL" },
        local: {
          type: "local",
          command: [process.execPath, "-e", "require('fs').writeFileSync('mcp-spawned', 'spawned')"],
        },
      },
    },
  },
)

it.instance(
  "initializes only a private managed connection in connect mode",
  () =>
    Effect.gen(function* () {
      yield* enterpriseMode
      const mcp = yield* MCP.Service

      const reads = yield* Effect.all([mcp.status(), mcp.status(), mcp.clients(), mcp.tools(), mcp.instructions()], {
        concurrency: "unbounded",
      })
      expect(reads[0]).toEqual({
        disabled: { status: "disabled" },
        local: { status: "disabled" },
        managed: { status: "connected" },
        second: { status: "connected" },
        unknown: { status: "failed", error: expect.stringContaining("[MCP_REFERENCE_UNKNOWN]") },
        unmanaged: { status: "disabled" },
      })
      expect(reads[1]).toEqual(reads[0])
      expect(reads[2]).toEqual({})
      expect(reads[3]).toEqual({})
      expect(reads[4]).toEqual([])
      expect(yield* mcp.clients()).toEqual({})
      expect(yield* mcp.tools()).toEqual({})
      expect(yield* mcp.prompts()).toEqual({})
      expect(yield* mcp.resources()).toEqual({})
      expect(yield* mcp.resourceTemplates()).toEqual({})
      expect(yield* mcp.instructions()).toEqual([])
      expect(connectRequests.map((item) => (item as { method: string }).method)).toEqual([
        "initialize",
        "notifications/initialized",
        "initialize",
        "notifications/initialized",
      ])
      expect((connectRequests[0] as { params: { capabilities: unknown } }).params.capabilities).toEqual({})
      expect(connectHttpMethods.filter((method) => method === "POST")).toHaveLength(4)
      expect(connectPaths.every((value) => value === "/mcp")).toBe(true)
      expect(yield* mcp.status()).toEqual(reads[0])
      expect(connectRequests).toHaveLength(4)
      const instance = yield* TestInstance
      expect(
        yield* Effect.promise(() => Bun.file(path.join(instance.directory, "enterprise-local-spawned")).exists()),
      ).toBe(false)
    }),
  {
    config: {
      mcp: {
        managed: { type: "managed", server: "connection" },
        second: { type: "managed", server: "connection-two" },
        disabled: { type: "managed", server: "connection-disabled", enabled: false },
        unknown: { type: "managed", server: "missing" },
        unmanaged: { type: "remote", url: "http://127.0.0.1:1/sse" },
        local: {
          type: "local",
          command: [process.execPath, "-e", "require('fs').writeFileSync('enterprise-local-spawned', 'yes')"],
        },
      },
    },
    init: managedRuntime("connect", async (request, response) => {
      connectHttpMethods.push(request.method ?? "")
      connectPaths.push(request.url ?? "")
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      if (!body) {
        response.writeHead(405).end()
        return
      }
      const message = JSON.parse(body)
      connectRequests.push(message)
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {}, prompts: {}, resources: {} },
              serverInfo: { name: "private", version: "1" },
              instructions: "not exposed",
            },
          }),
        )
        return
      }
      response.writeHead(202).end()
    }),
  },
)

it.instance(
  "keeps diagnose mode offline for an otherwise valid managed reference",
  () =>
    Effect.gen(function* () {
      yield* enterpriseMode
      const mcp = yield* MCP.Service
      expect(yield* mcp.status()).toEqual({ managed: { status: "disabled" } })
      expect(diagnoseRequests).toBe(0)
    }),
  {
    config: { mcp: { managed: { type: "managed", server: "connection" } } },
    init: managedRuntime("diagnose", (_request, response) => {
      diagnoseRequests++
      response.writeHead(500).end()
    }),
  },
)

it.instance(
  "rejects duplicate and normalized-colliding managed ownership before networking",
  () =>
    Effect.gen(function* () {
      yield* enterpriseMode
      const mcp = yield* MCP.Service
      expect(yield* mcp.status()).toEqual({
        "Source.Control": { status: "failed", error: "[MCP_NAME_COLLISION] Managed reference ownership is ambiguous." },
        source_control: { status: "failed", error: "[MCP_NAME_COLLISION] Managed reference ownership is ambiguous." },
      })
      expect(connectRequests).toEqual([])
    }),
  {
    config: {
      mcp: {
        "Source.Control": { type: "managed", server: "connection" },
        source_control: { type: "managed", server: "connection" },
      },
    },
    init: managedRuntime("connect", (_request, response) => {
      response.writeHead(500).end()
    }),
  },
)

function managedRuntime(
  mode: "diagnose" | "connect",
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  return (directory: string) =>
    Effect.gen(function* () {
      if (mode === "connect") connectRequests.splice(0)
      if (mode === "connect") connectHttpMethods.splice(0)
      if (mode === "connect") connectPaths.splice(0)
      if (mode === "diagnose") diagnoseRequests = 0
      const server = yield* loopbackServer(handler)
      const address = server.address()
      if (!address || typeof address === "string") return yield* Effect.die(new Error("missing test address"))
      yield* managedPolicyEnvironment(directory, `http://127.0.0.1:${address.port}/mcp`, mode)
    })
}

function loopbackServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<http.Server>((resolve, reject) => {
          const server = http.createServer(handler)
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => resolve(server))
        }),
    ),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
}

function managedPolicyEnvironment(directory: string, url: string, mode: "diagnose" | "connect") {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const managed = path.join(directory, "managed")
      await Bun.$`mkdir -p ${managed}`.quiet()
      await Bun.write(
        path.join(managed, "opencode.json"),
        JSON.stringify({
          enterprise: {
            mcp: {
              ...enterpriseMcpPolicy,
              mode,
              servers: {
                connection: {
                  ...enterpriseMcpPolicy.servers["source-control"],
                  url,
                  dns: { allowedCidrs: ["127.0.0.0/8"], denyLoopback: false, denyLinkLocal: true },
                  headers: { allowedNames: [], values: {} },
                },
                "connection-two": {
                  ...enterpriseMcpPolicy.servers["source-control"],
                  url,
                  dns: { allowedCidrs: ["127.0.0.0/8"], denyLoopback: false, denyLinkLocal: true },
                  headers: { allowedNames: [], values: {} },
                },
                "connection-disabled": {
                  ...enterpriseMcpPolicy.servers["source-control"],
                  enabled: false,
                  url,
                  dns: { allowedCidrs: ["127.0.0.0/8"], denyLoopback: false, denyLinkLocal: true },
                  headers: { allowedNames: [], values: {} },
                },
              },
            },
          },
        }),
      )
      const names = [
        "OPENCODE_TEST_MANAGED_CONFIG_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
      ] as const
      const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))
      process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managed
      names.slice(1).forEach((name) => delete process.env[name])
      return { names, original }
    }),
    ({ names, original }) =>
      Effect.sync(() =>
        names.forEach((name) => {
          const value = original[name]
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }),
      ),
  )
}

it.instance(
  "rejects MCP mutations and authentication before storing or connecting",
  () =>
    Effect.gen(function* () {
      yield* enterpriseMode
      const mcp = yield* MCP.Service

      const operations = [
        mcp.add("added", { type: "remote", url: "not a URL" }),
        mcp.connect("remote"),
        mcp.disconnect("remote"),
        mcp.startAuth("remote"),
        mcp.authenticate("remote"),
        mcp.finishAuth("remote", "code"),
        mcp.removeAuth("remote"),
      ]

      for (const operation of operations) {
        const exit = yield* Effect.exit(operation)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(MCP.ENTERPRISE_DISABLED_MESSAGE)
      }

      expect(yield* mcp.status()).toEqual({ remote: { status: "disabled" } })
    }),
  { config: { mcp: { remote: { type: "remote", url: "not a URL" } } } },
)
