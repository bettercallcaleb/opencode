import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { classifyDoctorProbeTlsError, runVllmProbe, type DoctorProbeTestDependencies } from "@/cli/cmd/doctor-probe"

const secret = "probe-secret-key"
const headerSecret = "probe-custom-header-secret"
const dnsFailure = path.join(import.meta.dir, "../fixture/doctor-dns-failure.ts")
const tlsCA = path.join(import.meta.dir, "../fixture/doctor-tls-ca.pem")
const tlsCertificate = path.join(import.meta.dir, "../fixture/doctor-tls-server.pem")
const tlsMismatchCertificate = path.join(import.meta.dir, "../fixture/doctor-tls-mismatch.pem")
const tlsKey = path.join(import.meta.dir, "../fixture/doctor-tls-server-key.pem")

type Mode =
  | "compatible"
  | "auth"
  | "echo-secret"
  | "models-403"
  | "models-404"
  | "models-redirect"
  | "models-html"
  | "models-malformed"
  | "models-missing"
  | "chat-400"
  | "chat-403"
  | "chat-404"
  | "chat-429"
  | "chat-502"
  | "stream-content-type"
  | "stream-malformed"
  | "stream-missing-done"
  | "stream-options-rejected"
  | "sdk-reject"
  | "tools-rejected"
  | "tool-arguments-malformed"

function endpoint(mode: Mode, tls?: { certificate: string; key: string }) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const requests: string[] = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        ...(tls
          ? {
              tls: {
                cert: Bun.file(tls.certificate),
                key: Bun.file(tls.key),
              },
            }
          : {}),
        async fetch(request) {
          const url = new URL(request.url)
          requests.push(url.pathname)
          if (mode === "auth")
            return Response.json(
              { error: { message: "invalid credential", type: "authentication_error" } },
              { status: 401 },
            )
          if (request.method === "GET" && url.pathname === "/gateway/v1/models") {
            if (mode === "models-403") return Response.json({ error: { message: "forbidden" } }, { status: 403 })
            if (mode === "models-404") return Response.json({ error: { message: "not found" } }, { status: 404 })
            if (mode === "models-redirect") return Response.redirect(`${url.origin}/login`, 302)
            if (mode === "models-html")
              return new Response("<html>gateway error</html>", { headers: { "content-type": "text/html" } })
            if (mode === "models-malformed")
              return new Response("{not-json", { headers: { "content-type": "application/json" } })
            if (mode === "models-missing")
              return Response.json({ object: "list", data: [{ id: "different-model", object: "model" }] })
            return Response.json({ object: "list", data: [{ id: "api-model", object: "model" }] })
          }
          if (request.method !== "POST" || url.pathname !== "/gateway/v1/chat/completions")
            return Response.json({ error: { message: "not found" } }, { status: 404 })
          const body = (await request.json()) as {
            messages?: { content?: string }[]
            stream?: boolean
            tools?: unknown[]
            stream_options?: unknown
          }
          const statuses: Partial<Record<Mode, number>> = {
            "chat-400": 400,
            "chat-403": 403,
            "chat-404": 404,
            "chat-429": 429,
            "chat-502": 502,
          }
          const status = statuses[mode]
          if (status)
            return Response.json(
              { error: { message: `controlled HTTP ${status}`, type: "invalid_request_error" } },
              { status },
            )
          if (mode === "stream-options-rejected" && body.stream_options)
            return Response.json({ error: { message: "stream_options unsupported" } }, { status: 400 })
          if (body.tools?.length && mode === "tools-rejected")
            return Response.json({ error: { message: "tools unsupported" } }, { status: 400 })
          if (body.tools?.length)
            return Response.json({
              id: "chatcmpl-tool",
              model: "api-model",
              choices: [
                {
                  index: 0,
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-doctor",
                        type: "function",
                        function: {
                          name: "opencode_doctor_magic_number",
                          arguments: mode === "tool-arguments-malformed" ? "{" : "{}",
                        },
                      },
                    ],
                  },
                },
              ],
            })
          const prompt = body.messages?.map((message) => message.content ?? "").join(" ") ?? ""
          const sdk = prompt.includes("OPENCODE_SDK_OK")
          if (mode === "echo-secret")
            return Response.json(
              { error: { message: `credentials ${secret} ${headerSecret}`, type: "invalid_request_error" } },
              { status: 400 },
            )
          if (mode === "sdk-reject" && sdk)
            return Response.json(
              { error: { message: "SDK-only request field rejected", type: "invalid_request_error" } },
              { status: 400 },
            )
          const text = sdk ? "OPENCODE_SDK_OK" : "OPENCODE_DOCTOR_OK"
          if (!body.stream)
            return Response.json({
              id: "chatcmpl-doctor",
              model: "api-model",
              choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
          const stream =
            mode === "stream-malformed"
              ? "not-an-sse-line\n\ndata: {not-json\n\ndata: [DONE]\n\n"
              : [
                  `data: ${JSON.stringify({ id: "chatcmpl-doctor", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
                  `data: ${JSON.stringify({ id: "chatcmpl-doctor", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
                  ...(mode === "stream-missing-done" ? [] : ["data: [DONE]\n\n"]),
                ].join("")
          return new Response(stream, {
            headers: { "content-type": mode === "stream-content-type" ? "application/json" : "text/event-stream" },
          })
        },
      })
      return { url: server.url, requests, stop: () => server.stop(true) }
    }),
    (server) => Effect.promise(() => server.stop()),
  )
}

function config(baseURL: string) {
  return JSON.stringify({
    model: "internal-vllm/model-key",
    provider: {
      "internal-vllm": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL, apiKey: secret, headers: { "x-doctor-token": headerSecret } },
        models: { "model-key": { id: "api-model", tool_call: true } },
      },
    },
  })
}

function env(baseURL: string) {
  return {
    OPENCODE_ENTERPRISE_MODE: "1",
    OPENCODE_ENTERPRISE_VLLM_BASE_URL: baseURL,
    OPENCODE_CONFIG_CONTENT: config(baseURL),
  }
}

describe.serial("opencode doctor vllm active probe", () => {
  cliIt.live(
    "passes every stage against a compatible endpoint",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* endpoint("compatible")
          const baseURL = `${server.url}gateway/v1`
          const result = yield* opencode.spawn(["doctor", "vllm", "internal-vllm", "--probe", "--json"], {
            env: env(baseURL),
            timeoutMs: 30_000,
          })
          const report = JSON.parse(result.stdout)
          expect(report.probe.stages.find((stage: { id: string }) => stage.id === "sdk")).toMatchObject({
            status: "pass",
          })
          opencode.expectExit(result, 0, "compatible probe")
          expect(report.probe.summary.status).toBe("pass")
          expect(report.probe.stages.map((stage: { id: string }) => stage.id)).toEqual([
            "dns",
            "tcp",
            "tls",
            "models",
            "chat",
            "stream",
            "sdk",
            "tool",
          ])
          expect(result.stdout).not.toContain(secret)
          expect(result.stdout).not.toContain(headerSecret)
        }),
      ),
    60_000,
  )

  cliIt.live(
    "distinguishes authentication failure",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* endpoint("auth")
          const baseURL = `${server.url}gateway/v1`
          const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--probe-level", "api", "--json"], {
            env: env(baseURL),
          })
          opencode.expectExit(result, 1, "authentication probe")
          expect(result.stdout).toContain("MODELS_AUTH_UNAUTHORIZED")
          expect(result.stdout).toContain("CHAT_AUTH_UNAUTHORIZED")
        }),
      ),
    60_000,
  )

  cliIt.live(
    "classifies controlled DNS failure without attempting later transport",
    ({ opencode }) =>
      Effect.gen(function* () {
        const baseURL = "https://doctor.invalid/gateway/v1"
        const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--probe-level", "transport", "--json"], {
          env: env(baseURL),
          preload: dnsFailure,
        })
        opencode.expectExit(result, 1, "DNS failure")
        expect(result.stdout).toContain("DNS_RESOLUTION_FAIL")
        expect(result.stdout).toContain("TCP skipped because DNS returned no addresses")
        expect(result.stderr).not.toContain("fixture blocked")
      }),
    60_000,
  )

  cliIt.live(
    "classifies loopback TCP refusal",
    ({ opencode }) =>
      Effect.gen(function* () {
        const baseURL = "http://127.0.0.1:1/gateway/v1"
        const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--probe-level", "transport", "--json"], {
          env: env(baseURL),
        })
        opencode.expectExit(result, 1, "TCP refusal")
        expect(result.stdout).toContain("TCP_CONNECT_FAIL")
        expect(result.stdout).toContain("TCP_ALL_ADDRESSES_FAILED")
      }),
    60_000,
  )

  cliIt.live(
    "reports trusted TLS evidence and authoritative guarded HTTPS success",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* endpoint("compatible", { certificate: tlsCertificate, key: tlsKey })
          const baseURL = `https://localhost:${server.url.port}/gateway/v1`
          const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--probe-level", "api", "--json"], {
            env: { ...env(baseURL), NODE_EXTRA_CA_CERTS: tlsCA },
          })
          opencode.expectExit(result, 0, "trusted TLS")
          const report = JSON.parse(result.stdout)
          const tls = report.probe.stages.find((stage: { id: string }) => stage.id === "tls")
          expect(tls.checks.map((check: { code: string }) => check.code)).toContain("TLS_HANDSHAKE_PASS")
          expect(tls.detail).toMatchObject({
            subjectCommonName: "localhost",
            issuerCommonName: "OpenCode-Doctor-Test-CA",
            hostnameValidation: true,
            certificateTrust: true,
          })
          expect(tls.detail.protocol).toBeString()
          expect(tls.detail.cipher).toBeString()
          expect(tls.detail.validFrom).toBeString()
          expect(tls.detail.validTo).toBeString()
          expect(tls.detail.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
          expect(report.probe.stages.find((stage: { id: string }) => stage.id === "chat").status).toBe("pass")
          expect(server.requests).toEqual([
            "/gateway/v1/models",
            "/gateway/v1/chat/completions",
            "/gateway/v1/chat/completions",
          ])
          expect(result.stdout).not.toContain("BEGIN CERTIFICATE")
          expect(result.stdout).not.toContain("BEGIN PRIVATE KEY")
        }),
      ),
    60_000,
  )

  cliIt.live(
    "rejects an untrusted TLS chain without retrying insecurely",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* endpoint("compatible", { certificate: tlsCertificate, key: tlsKey })
          const baseURL = `https://localhost:${server.url.port}/gateway/v1`
          const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--probe-level", "api", "--json"], {
            env: { ...env(baseURL), NODE_EXTRA_CA_CERTS: "" },
          })
          opencode.expectExit(result, 1, "untrusted TLS")
          const report = JSON.parse(result.stdout)
          const tls = report.probe.stages.find((stage: { id: string }) => stage.id === "tls")
          expect(tls.checks.map((check: { code: string }) => check.code)).toContain("TLS_CERTIFICATE_UNTRUSTED")
          expect(tls.categories).toContain("certificate")
          expect(server.requests).toEqual([])
          expect(result.stdout + result.stderr).not.toContain("BEGIN PRIVATE KEY")
          expect(result.stdout + result.stderr).not.toContain("PRIVATE KEY")
        }),
      ),
    60_000,
  )

  cliIt.live(
    "reports a trusted certificate hostname mismatch without contacting an alternate target",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* endpoint("compatible", { certificate: tlsMismatchCertificate, key: tlsKey })
          const baseURL = `https://localhost:${server.url.port}/gateway/v1`
          const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--probe-level", "api", "--json"], {
            env: { ...env(baseURL), NODE_EXTRA_CA_CERTS: tlsCA },
          })
          opencode.expectExit(result, 1, "TLS hostname mismatch")
          const report = JSON.parse(result.stdout)
          const tls = report.probe.stages.find((stage: { id: string }) => stage.id === "tls")
          expect(tls.checks.map((check: { code: string }) => check.code)).toContain("TLS_HOSTNAME_MISMATCH")
          expect(tls.detail).toMatchObject({
            hostname: "localhost",
            hostnameValidation: false,
            certificateTrust: true,
          })
          expect(server.requests).toEqual([])
          expect(result.stdout).not.toContain("mismatch.invalid/gateway")
        }),
      ),
    60_000,
  )

  cliIt.live(
    "reports raw chat pass with production SDK failure and request-field comparison",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* endpoint("sdk-reject")
          const baseURL = `${server.url}gateway/v1`
          const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--json"], { env: env(baseURL) })
          opencode.expectExit(result, 1, "SDK incompatibility probe")
          const report = JSON.parse(result.stdout)
          expect(report.probe.stages.find((stage: { id: string }) => stage.id === "chat").status).toBe("pass")
          const sdk = report.probe.stages.find((stage: { id: string }) => stage.id === "sdk")
          expect(sdk.status).toBe("fail")
          expect(sdk.checks.map((check: { code: string }) => check.code)).toContain("SDK_RESPONSE_FAIL")
          expect(sdk.detail.requestFieldComparison).toBeDefined()
        }),
      ),
    60_000,
  )

  cliIt.live(
    "identifies streaming content-type incompatibility",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* endpoint("stream-content-type")
          const baseURL = `${server.url}gateway/v1`
          const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--probe-level", "api", "--json"], {
            env: env(baseURL),
          })
          opencode.expectExit(result, 1, "streaming incompatibility probe")
          expect(result.stdout).toContain("STREAM_CONTENT_TYPE_INVALID")
        }),
      ),
    60_000,
  )

  cliIt.live(
    "classifies models endpoint compatibility variants without suppressing chat",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cases: [Mode, string, number][] = [
            ["models-403", "MODELS_AUTH_FORBIDDEN", 0],
            ["models-404", "MODELS_NOT_FOUND", 0],
            ["models-redirect", "MODELS_REDIRECT_REJECTED", 1],
            ["models-html", "MODELS_CONTENT_TYPE_INVALID", 0],
            ["models-malformed", "MODELS_JSON_INVALID", 0],
            ["models-missing", "MODELS_CONFIGURED_MODEL_MISSING", 0],
          ]
          for (const [mode, code, exitCode] of cases) {
            const server = yield* endpoint(mode)
            const baseURL = `${server.url}gateway/v1`
            const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--probe-level", "api", "--json"], {
              env: env(baseURL),
            })
            opencode.expectExit(result, exitCode, mode)
            expect(result.stdout).toContain(code)
            const report = JSON.parse(result.stdout)
            expect(report.probe.stages.find((stage: { id: string }) => stage.id === "chat").status).toBe("pass")
            if (mode === "models-redirect") {
              const redirect = report.probe.stages
                .find((stage: { id: string }) => stage.id === "models")
                .checks.find((check: { code: string }) => check.code === "MODELS_REDIRECT_REJECTED")
              expect(redirect.detail).toMatchObject({ sameOrigin: "true", location: `${server.url.origin}/login` })
              expect(server.requests).not.toContain("/login")
            }
          }
        }),
      ),
    60_000,
  )

  cliIt.live(
    "classifies common raw-chat HTTP failures",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cases: [Mode, string][] = [
            ["chat-400", "CHAT_HTTP_STATUS_FAIL"],
            ["chat-403", "CHAT_AUTH_FORBIDDEN"],
            ["chat-404", "CHAT_NOT_FOUND"],
            ["chat-429", "CHAT_HTTP_STATUS_FAIL"],
            ["chat-502", "CHAT_HTTP_STATUS_FAIL"],
          ]
          for (const [mode, code] of cases) {
            const server = yield* endpoint(mode)
            const baseURL = `${server.url}gateway/v1`
            const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--probe-level", "api", "--json"], {
              env: env(baseURL),
            })
            opencode.expectExit(result, 1, mode)
            expect(result.stdout).toContain(code)
          }
        }),
      ),
    60_000,
  )

  cliIt.live(
    "classifies malformed, incomplete, and rejected streaming protocols",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cases: [Mode, string[]][] = [
            ["stream-malformed", ["STREAM_SSE_INVALID", "STREAM_JSON_EVENT_INVALID"]],
            ["stream-missing-done", ["STREAM_DONE_MISSING"]],
            ["stream-options-rejected", ["STREAM_HTTP_STATUS_FAIL"]],
          ]
          for (const [mode, codes] of cases) {
            const server = yield* endpoint(mode)
            const baseURL = `${server.url}gateway/v1`
            const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--probe-level", "api", "--json"], {
              env: env(baseURL),
            })
            opencode.expectExit(result, 1, mode)
            for (const code of codes) expect(result.stdout).toContain(code)
          }
        }),
      ),
    60_000,
  )

  cliIt.live(
    "validates rejected tools and malformed tool arguments",
    ({ opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cases: [Mode, string][] = [
            ["tools-rejected", "TOOL_REQUEST_FAIL"],
            ["tool-arguments-malformed", "TOOL_ARGUMENTS_INVALID"],
          ]
          for (const [mode, code] of cases) {
            const server = yield* endpoint(mode)
            const baseURL = `${server.url}gateway/v1`
            const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--json"], { env: env(baseURL) })
            opencode.expectExit(result, 1, mode)
            expect(result.stdout).toContain(code)
          }
        }),
      ),
    60_000,
  )

  cliIt.live(
    "redacts active-probe secrets from every report surface",
    ({ home, opencode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* endpoint("echo-secret")
          const baseURL = `${server.url}gateway/v1`
          const output = path.join(home, "active-probe.json")
          const reports = yield* Effect.all(
            [
              ["doctor", "vllm", "--probe"],
              ["doctor", "vllm", "--probe", "--verbose"],
              ["doctor", "vllm", "--probe", "--json", "--output", output],
            ].map((args) => opencode.spawn(args, { env: env(baseURL) })),
            { concurrency: 1 },
          )
          const text = reports.map((result) => result.stdout + result.stderr).join("")
          const file = yield* Effect.promise(() => Bun.file(output).text())
          expect(text + file).not.toContain(secret)
          expect(text + file).not.toContain(headerSecret)
          expect(file).toContain("[redacted]")
        }),
      ),
    60_000,
  )

  cliIt.live(
    "unsafe Phase 1 target skips probes before network activity",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["doctor", "vllm", "--probe", "--json"], {
          env: {
            OPENCODE_ENTERPRISE_MODE: "1",
            OPENCODE_ENTERPRISE_VLLM_BASE_URL: "https://allowed.invalid/v1",
            OPENCODE_CONFIG_CONTENT: config("https://different.invalid/v1"),
          },
          preload: new URL("../fixture/doctor-network-guard.ts", import.meta.url).pathname,
        })
        opencode.expectExit(result, 1, "unsafe probe")
        expect(result.stdout).toContain("PROBE_SKIPPED_UNSAFE_TARGET")
      }),
    60_000,
  )
})

function connectedSocket(onDestroy?: () => void) {
  return {
    destroy() {
      onDestroy?.()
    },
    setTimeout() {},
    once(event: string, callback: () => void) {
      if (event === "connect") queueMicrotask(callback)
    },
  } as never
}

function compatibleFetch(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  if (url.pathname.endsWith("/models")) return Promise.resolve(Response.json({ data: [{ id: "api-model" }] }))
  const body = JSON.parse(String(init?.body)) as { stream?: boolean }
  if (!body.stream)
    return Promise.resolve(
      Response.json({
        model: "api-model",
        choices: [{ finish_reason: "stop", message: { content: "OPENCODE_DOCTOR_OK" } }],
      }),
    )
  return Promise.resolve(
    new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "OPENCODE_DOCTOR_OK" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    ),
  )
}

function probeInput(level: "transport" | "api" | "sdk", testDependencies?: Partial<DoctorProbeTestDependencies>) {
  return {
    level,
    timeoutMs: 20,
    baseURL: "https://localhost:443/gateway/v1",
    apiModelID: "api-model",
    toolCallSupported: false,
    testDependencies,
  }
}

describe.serial("vLLM doctor probe resource cleanup", () => {
  test("destroys successful TCP and TLS sockets after collecting evidence", async () => {
    let tcpDestroyed = false
    let tlsDestroyed = false
    const report = await runVllmProbe(
      probeInput("transport", {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        tcpConnect: () => connectedSocket(() => (tcpDestroyed = true)),
        tlsConnect() {
          return {
            destroy() {
              tlsDestroyed = true
            },
            setTimeout() {},
            once(event: string, callback: () => void) {
              if (event === "secureConnect") queueMicrotask(callback)
            },
            getPeerCertificate() {
              return { subject: { CN: "localhost" }, issuer: { CN: "test" } }
            },
            getCipher() {
              return { name: "test" }
            },
            getProtocol() {
              return "TLSv1.3"
            },
          } as never
        },
      }),
    )
    expect(report.summary.status).toBe("pass")
    expect(tcpDestroyed).toBeTrue()
    expect(tlsDestroyed).toBeTrue()
  })

  test("bounds DNS timeout and does not create later transport resources", async () => {
    let tcpCalls = 0
    let tlsCalls = 0
    const started = performance.now()
    const report = await runVllmProbe(
      probeInput("transport", {
        lookup: () => new Promise(() => {}),
        tcpConnect() {
          tcpCalls++
          return connectedSocket()
        },
        tlsConnect() {
          tlsCalls++
          return {} as never
        },
      }),
    )
    expect(report.stages[0].checks[0].code).toBe("DNS_RESOLUTION_TIMEOUT")
    expect(performance.now() - started).toBeLessThan(250)
    expect(tcpCalls).toBe(0)
    expect(tlsCalls).toBe(0)
  })

  test("destroys a timed-out TCP socket and skips TLS and HTTP", async () => {
    let destroyed = false
    let tlsCalls = 0
    let fetchCalls = 0
    const started = performance.now()
    const report = await runVllmProbe(
      probeInput("transport", {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        tcpConnect() {
          return {
            destroy() {
              destroyed = true
            },
            setTimeout(milliseconds: number, callback: () => void) {
              setTimeout(callback, milliseconds)
            },
            once() {},
          } as never
        },
        tlsConnect() {
          tlsCalls++
          return {} as never
        },
        fetch() {
          fetchCalls++
          return Promise.reject(new Error("unexpected fetch"))
        },
      }),
    )
    const tcp = report.stages.find((stage) => stage.id === "tcp")!
    expect(tcp.checks.map((check) => check.code)).toContain("TCP_CONNECT_TIMEOUT")
    expect(tcp.detail?.attempts).toEqual([
      expect.objectContaining({ address: "127.0.0.1", connected: false, code: "PROBE_TIMEOUT" }),
    ])
    expect(performance.now() - started).toBeLessThan(250)
    expect(destroyed).toBeTrue()
    expect(tlsCalls).toBe(0)
    expect(fetchCalls).toBe(0)
  })

  test("destroys a TLS socket when the handshake times out", async () => {
    let destroyed = false
    const report = await runVllmProbe(
      probeInput("transport", {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        tcpConnect: () => connectedSocket(),
        tlsConnect() {
          return {
            destroy() {
              destroyed = true
            },
            setTimeout() {},
            once() {},
            getPeerCertificate() {
              return {}
            },
            getCipher() {
              return { name: "unused" }
            },
            getProtocol() {
              return null
            },
          } as never
        },
      }),
    )
    const tls = report.stages.find((stage) => stage.id === "tls")!
    expect(tls.checks.map((check) => check.code)).toContain("TLS_HANDSHAKE_TIMEOUT")
    expect(destroyed).toBeTrue()
  })

  test("aborts and cancels a stream that stalls before its first event", async () => {
    let requests = 0
    let aborted = false
    let cancelled = false
    const report = await runVllmProbe(
      probeInput("api", {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        tcpConnect: () => connectedSocket(),
        tlsConnect() {
          return {
            destroy() {},
            setTimeout() {},
            once(event: string, callback: (error?: unknown) => void) {
              if (event === "secureConnect") queueMicrotask(() => callback())
            },
            getPeerCertificate() {
              return { subject: { CN: "localhost" }, issuer: { CN: "test" } }
            },
            getCipher() {
              return { name: "test" }
            },
            getProtocol() {
              return "TLSv1.3"
            },
          } as never
        },
        fetch(input, init) {
          requests++
          if (requests < 3) return compatibleFetch(input, init)
          init?.signal?.addEventListener("abort", () => {
            aborted = true
          })
          return Promise.resolve(
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
          )
        },
      }),
    )
    const stream = report.stages.find((stage) => stage.id === "stream")!
    expect(stream.checks.map((check) => check.code)).toContain("STREAM_FIRST_EVENT_TIMEOUT")
    expect(aborted).toBeTrue()
    expect(cancelled).toBeTrue()
  })

  test("aborts an SDK request that exceeds its operation timeout", async () => {
    let aborted = false
    const report = await runVllmProbe({
      ...probeInput("sdk"),
      sdk: (signal: AbortSignal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            aborted = true
          })
        }),
    })
    expect(report.stages[0].checks.map((check) => check.code)).toContain("SDK_RESPONSE_FAIL")
    expect(aborted).toBeTrue()
  })

  test("preserves conflicting low-level TLS and authoritative guarded fetch evidence", async () => {
    let tlsDestroyed = false
    const report = await runVllmProbe(
      probeInput("api", {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        tcpConnect: () => connectedSocket(),
        tlsConnect() {
          return {
            destroy() {
              tlsDestroyed = true
            },
            setTimeout() {},
            once(event: string, callback: (error: unknown) => void) {
              if (event === "error")
                queueMicrotask(() =>
                  callback(Object.assign(new Error("untrusted"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })),
                )
            },
            getPeerCertificate() {
              return {}
            },
            getCipher() {
              return { name: "unused" }
            },
            getProtocol() {
              return null
            },
          } as never
        },
        fetch: compatibleFetch,
      }),
    )
    expect(report.stages.find((stage) => stage.id === "tls")?.checks.map((check) => check.code)).toContain(
      "TLS_CERTIFICATE_UNTRUSTED",
    )
    expect(report.stages.find((stage) => stage.id === "models")?.status).toBe("pass")
    expect(report.stages.find((stage) => stage.id === "chat")?.status).toBe("pass")
    expect(report.stages.find((stage) => stage.id === "stream")?.status).toBe("pass")
    expect(report.summary).toMatchObject({ status: "fail", firstFailureStage: "tls" })
    expect(tlsDestroyed).toBeTrue()
  })

  test("never resolves or fetches a sanitized cross-origin redirect target", async () => {
    const lookups: string[] = []
    const requests: string[] = []
    let tcpCalls = 0
    let count = 0
    const report = await runVllmProbe(
      probeInput("api", {
        lookup: async (hostname) => {
          lookups.push(hostname)
          return [{ address: "127.0.0.1", family: 4 }]
        },
        tcpConnect() {
          tcpCalls++
          return connectedSocket()
        },
        tlsConnect() {
          return {
            destroy() {},
            setTimeout() {},
            once(event: string, callback: () => void) {
              if (event === "secureConnect") queueMicrotask(callback)
            },
            getPeerCertificate() {
              return { subject: { CN: "localhost" }, issuer: { CN: "test" } }
            },
            getCipher() {
              return { name: "test" }
            },
            getProtocol() {
              return "TLSv1.3"
            },
          } as never
        },
        fetch(input, init) {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          requests.push(url.hostname)
          count++
          if (count === 1)
            return Promise.resolve(
              new Response("redirect", {
                status: 302,
                headers: { location: "https://user:password@redirect.invalid/login?token=secret#fragment" },
              }),
            )
          return compatibleFetch(input, init)
        },
      }),
    )
    const redirect = report.stages
      .find((stage) => stage.id === "models")!
      .checks.find((check) => check.code === "MODELS_REDIRECT_REJECTED")!
    expect(redirect.detail).toMatchObject({
      location: "https://redirect.invalid/login",
      sameOrigin: "false",
      differentHostname: "true",
    })
    expect(lookups).toEqual(["localhost"])
    expect(tcpCalls).toBe(1)
    expect(requests).toEqual(["localhost", "localhost", "localhost"])
  })

  test("classifies expiration deterministically without a clock-sensitive certificate", () => {
    expect(classifyDoctorProbeTlsError({ code: "CERT_HAS_EXPIRED" }).check).toBe("TLS_CERTIFICATE_EXPIRED")
    expect(classifyDoctorProbeTlsError({ code: "CERT_NOT_YET_VALID" }).check).toBe("TLS_CERTIFICATE_NOT_YET_VALID")
  })
})
