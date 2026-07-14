import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { call, EXA_URL, parseResponse, SearchArgs } from "../../src/tool/mcp-websearch"
import { selectWebSearchProvider, WebSearchTool, webSearchModelName, webSearchProviderLabel } from "../../src/tool/websearch"

import { webSearchEnabled } from "../../src/tool/registry"
import { it, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Flag } from "@opencode-ai/core/flag/flag"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, SessionID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"

const SESSION_ID = "ses_0196aabbccddeeff001122334455"
let requests = 0
const direct = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, RuntimeFlags.node, Agent.node, Truncate.node]), [
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests++
            return HttpClientResponse.fromWeb(request, new Response("unused"))
          }),
        ),
      ),
    ],
  ]),
)

describe("websearch provider", () => {
  direct.effect("rejects direct enterprise execution before permission or transport", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        requests = 0
        const original = Flag.OPENCODE_ENTERPRISE_MODE
        Flag.OPENCODE_ENTERPRISE_MODE = true
        return original
      }),
      () =>
        Effect.gen(function* () {
          let asks = 0
          let metadata = 0
          const info = yield* WebSearchTool
          const tool = yield* info.init()
          const exit = yield* tool
            .execute(
              { query: "enterprise" },
              {
                sessionID: SessionID.make(SESSION_ID),
                messageID: MessageID.make("msg_enterprise_websearch"),
                callID: "call_enterprise_websearch",
                agent: "build",
                abort: AbortSignal.any([]),
                messages: [],
                extra: {},
                ask: () => Effect.sync(() => void asks++),
                metadata: () => Effect.sync(() => void metadata++),
              },
            )
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          expect(asks).toBe(0)
          expect(metadata).toBe(0)
          expect(requests).toBe(0)
        }),
      (original) =>
        Effect.sync(() => {
          Flag.OPENCODE_ENTERPRISE_MODE = original
        }),
    ),
  )

  test("selects a stable provider per session", () => {
    expect(selectWebSearchProvider(SESSION_ID)).toBe(selectWebSearchProvider(SESSION_ID))
  })

  test("supports an operational override", () => {
    const original = process.env.OPENCODE_WEBSEARCH_PROVIDER

    try {
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "parallel"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("parallel")

      process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("exa")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
      else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
    }
  })

  test("routes to Exa when the Exa flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: true, parallel: false })).toBe("exa")
  })

  test("routes to Parallel when the Parallel flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: true })).toBe("parallel")
  })

  test("is only enabled for opencode or explicit websearch provider flags", () => {
    expect(webSearchEnabled(ProviderV2.ID.opencode, { exa: false, parallel: false })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: false, parallel: false })).toBe(false)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: true, parallel: false })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: false, parallel: true })).toBe(true)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })

  test("uses the provider API model id for Parallel analytics", () => {
    expect(
      webSearchModelName({
        model: {
          id: "claude-opus-4-7",
          api: { id: "claude-opus-4.7" },
        },
      }),
    ).toBe("claude-opus-4.7")
  })
})

describe("websearch MCP response parser", () => {
  test("enterprise mode blocks direct MCP calls before request execution", async () => {
    const original = Flag.OPENCODE_ENTERPRISE_MODE
    let requests = 0
    Flag.OPENCODE_ENTERPRISE_MODE = true
    try {
      const http = HttpClient.make(() =>
        Effect.sync(() => {
          requests++
          throw new Error("unexpected request")
        }),
      )
      const exit = await Effect.runPromiseExit(
        call(
          http,
          EXA_URL,
          "web_search_exa",
          SearchArgs,
          { query: "enterprise", type: "auto", numResults: 8, livecrawl: "fallback" },
          "25 seconds",
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(requests).toBe(0)
    } finally {
      Flag.OPENCODE_ENTERPRISE_MODE = original
    }
  })

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )
})
