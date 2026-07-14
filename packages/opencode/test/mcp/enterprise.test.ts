import path from "node:path"
import { expect } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { MCP } from "../../src/mcp"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))

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
