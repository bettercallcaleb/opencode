import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"
import { Flag } from "@opencode-ai/core/flag/flag"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("enterprise mode ignores stored credentials and blocks mutation", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("openai", { type: "api", key: "stored-key" })
      const original = Flag.OPENCODE_ENTERPRISE_MODE
      Flag.OPENCODE_ENTERPRISE_MODE = true
      yield* Effect.gen(function* () {
        expect(yield* auth.all()).toEqual({})
        expect(yield* auth.get("openai")).toBeUndefined()
        expect(Exit.isFailure(yield* Effect.exit(auth.set("openai", { type: "api", key: "replacement" })))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(auth.remove("openai")))).toBe(true)
      }).pipe(Effect.ensuring(Effect.sync(() => (Flag.OPENCODE_ENTERPRISE_MODE = original))))
      expect((yield* auth.get("openai"))?.type).toBe("api")
    }),
  )
})
