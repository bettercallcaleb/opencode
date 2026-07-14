import { test, expect } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import {
  ensureImportSourceAllowed,
  fetchRemoteImport,
  isRemoteImport,
  parseShareUrl,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ShareData,
} from "../../src/cli/cmd/import"

async function withImportGlobals<A>(enterprise: boolean, replacement: typeof fetch, fn: () => Promise<A>) {
  const originalEnterprise = Flag.OPENCODE_ENTERPRISE_MODE
  const originalFetch = globalThis.fetch
  Flag.OPENCODE_ENTERPRISE_MODE = enterprise
  globalThis.fetch = replacement
  try {
    return await fn()
  } finally {
    Flag.OPENCODE_ENTERPRISE_MODE = originalEnterprise
    globalThis.fetch = originalFetch
  }
}

function fetchRecorder(calls: string[]) {
  return (async (input: string | URL | Request) => {
    calls.push(input.toString())
    return new Response("[]", { status: 200 })
  }) as typeof fetch
}

test("recognizes remote import schemes case-insensitively without matching local paths", () => {
  expect(isRemoteImport("HTTPS://example.com/session")).toBe(true)
  expect(isRemoteImport("Http://example.com/session")).toBe(true)
  expect(isRemoteImport("hTtPs://example.com/session")).toBe(true)
  expect(isRemoteImport("./HTTPS-session.json")).toBe(false)
  expect(isRemoteImport("session-https://example.com.json")).toBe(false)
})

test("enterprise mode rejects mixed-case remote schemes before fetch", async () => {
  const calls: string[] = []
  await withImportGlobals(true, fetchRecorder(calls), async () => {
    for (const url of [
      "HTTPS://example.com/session",
      "Http://example.com/session",
      "hTtPs://example.com/session",
    ]) {
      await expect(Effect.runPromise(ensureImportSourceAllowed(url))).rejects.toThrow(
        "Remote session import is disabled in enterprise mode",
      )
    }
  })
  expect(calls).toEqual([])
})

test("enterprise mode rejects https imports before fetch", async () => {
  const calls: string[] = []
  await withImportGlobals(true, fetchRecorder(calls), async () => {
    await expect(Effect.runPromise(ensureImportSourceAllowed("https://example.com/share/test"))).rejects.toThrow(
      "Remote session import is disabled in enterprise mode",
    )
  })
  expect(calls).toEqual([])
})

test("enterprise mode rejects http imports before fetch", async () => {
  const calls: string[] = []
  await withImportGlobals(true, fetchRecorder(calls), async () => {
    await expect(Effect.runPromise(ensureImportSourceAllowed("http://example.com/share/test"))).rejects.toThrow(
      "Remote session import is disabled in enterprise mode",
    )
  })
  expect(calls).toEqual([])
})

test("enterprise mode also blocks the remote fetch boundary", async () => {
  const calls: string[] = []
  await withImportGlobals(true, fetchRecorder(calls), async () => {
    await expect(Effect.runPromise(fetchRemoteImport("https://example.com/share/test", {}))).rejects.toThrow(
      "Remote session import is disabled in enterprise mode",
    )
  })
  expect(calls).toEqual([])
})

test("enterprise mode leaves local file imports reachable", async () => {
  const calls: string[] = []
  await withImportGlobals(true, fetchRecorder(calls), async () => {
    expect(isRemoteImport("./session.json")).toBe(false)
    await Effect.runPromise(ensureImportSourceAllowed("./session.json"))
  })
  expect(calls).toEqual([])
})

test("non-enterprise remote import remains reachable", async () => {
  const originalEnterprise = Flag.OPENCODE_ENTERPRISE_MODE
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  await withImportGlobals(false, fetchRecorder(calls), async () => {
    await Effect.runPromise(fetchRemoteImport("https://example.com/share/test", {}))
  })
  expect(calls).toEqual(["https://example.com/share/test"])
  expect(Flag.OPENCODE_ENTERPRISE_MODE).toBe(originalEnterprise)
  expect(globalThis.fetch).toBe(originalFetch)
})

test("import globals are restored when the operation fails", async () => {
  const originalEnterprise = Flag.OPENCODE_ENTERPRISE_MODE
  const originalFetch = globalThis.fetch
  await expect(
    withImportGlobals(!originalEnterprise, fetchRecorder([]), async () => {
      throw new Error("expected failure")
    }),
  ).rejects.toThrow("expected failure")
  expect(Flag.OPENCODE_ENTERPRISE_MODE).toBe(originalEnterprise)
  expect(globalThis.fetch).toBe(originalFetch)
})

// parseShareUrl tests
test("parses valid share URLs", () => {
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toBe("abc123")
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toBe("test_id-123")
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://opncd.ai/s/Jsj3hNIW")).toBeNull() // legacy format
  expect(parseShareUrl("https://opncd.ai/share/")).toBeNull()
  expect(parseShareUrl("https://opncd.ai/share/id/extra")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } as any },
    { type: "message", data: { id: "msg-1", sessionID: "sess-1" } as any },
    { type: "part", data: { id: "part-1", messageID: "msg-1" } as any },
    { type: "part", data: { id: "part-2", messageID: "msg-1" } as any },
  ]

  const result = transformShareData(data)!

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns null for invalid share data", () => {
  expect(transformShareData([])).toBeNull()
  expect(transformShareData([{ type: "message", data: {} as any }])).toBeNull()
  expect(transformShareData([{ type: "session", data: { id: "s" } as any }])).toBeNull() // no messages
})
