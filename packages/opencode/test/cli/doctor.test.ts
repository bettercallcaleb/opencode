import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

const secret = "doctor-unique-secret-7f1c9"
const config = JSON.stringify({
  model: "internal-vllm/llama",
  provider: {
    "internal-vllm": {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: `https://user:${secret}@vllm.internal/v1?token=${secret}#${secret}`,
        apiKey: secret,
        headers: { Authorization: `Bearer ${secret}`, Cookie: `session=${secret}` },
      },
      models: { llama: { id: "meta/llama" } },
    },
  },
})

const enterprise = {
  OPENCODE_ENTERPRISE_MODE: "1",
  OPENCODE_ENTERPRISE_VLLM_BASE_URL: "https://vllm.internal/v1",
}
const networkGuard = path.join(import.meta.dir, "../fixture/doctor-network-guard.ts")

describe.serial("opencode doctor vllm", () => {
  cliIt.live(
    "returns 0 for an admitted provider and emits JSON only",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.reset
        const result = yield* opencode.spawn(["doctor", "vllm", "internal-vllm", "--json"], {
          preload: networkGuard,
          env: {
            ...enterprise,
            OPENCODE_ENTERPRISE_VLLM_BASE_URL: llm.url,
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              model: "internal-vllm/llama",
              provider: {
                "internal-vllm": {
                  npm: "@ai-sdk/openai-compatible",
                  options: { baseURL: llm.url },
                  models: { llama: {} },
                },
              },
            }),
          },
        })
        opencode.expectExit(result, 0, "doctor pass")
        expect(JSON.parse(result.stdout).summary.status).toBe("pass")
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "returns 1 for actionable diagnostics",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["doctor", "vllm", "internal-vllm", "--json"], {
          env: { ...enterprise, OPENCODE_CONFIG_CONTENT: config },
        })
        opencode.expectExit(result, 1, "doctor diagnostic failure")
        expect(JSON.parse(result.stdout).summary.status).toBe("fail")
      }),
    60_000,
  )

  cliIt.live(
    "uses exit 2 for misuse and internal output failures without changing non-doctor failures",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const misuse = yield* opencode.spawn(["doctor", "vllm", "--unknown"], { env: enterprise })
        opencode.expectExit(misuse, 2, "doctor misuse")
        const internal = yield* opencode.spawn(["doctor", "vllm", "internal-vllm", "--output", home], {
          env: { ...enterprise, OPENCODE_CONFIG_CONTENT: config },
        })
        opencode.expectExit(internal, 2, "doctor internal failure")
        expect(internal.stderr).not.toContain(secret)
        const existing = yield* opencode.spawn(["models", "--unknown"])
        opencode.expectExit(existing, 1, "existing command misuse")
      }),
    60_000,
  )

  cliIt.live(
    "redacts all configured secrets from human, verbose, JSON, and output-file reports",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const output = path.join(home, "doctor.json")
        const env = { ...enterprise, OPENCODE_CONFIG_CONTENT: config, DOCTOR_CREDENTIAL_TOKEN: secret }
        const human = yield* opencode.spawn(["doctor", "vllm", "internal-vllm"], { env })
        const verbose = yield* opencode.spawn(["doctor", "vllm", "internal-vllm", "--verbose"], { env })
        const json = yield* opencode.spawn(["doctor", "vllm", "internal-vllm", "--json", "--output", output], { env })
        expect(human.stdout + human.stderr + verbose.stdout + verbose.stderr + json.stdout + json.stderr).not.toContain(
          secret,
        )
        expect(yield* Effect.promise(() => Bun.file(output).text())).not.toContain(secret)
      }),
    60_000,
  )

  cliIt.live(
    "preserves configuration bytes in read-only mode while normal bootstrap remains writable",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, "opencode.json")
        const original = JSON.stringify({ provider: {} })
        yield* Effect.promise(() => Bun.write(file, original))
        const before = Bun.file(file).lastModified
        const doctor = yield* opencode.spawn(["doctor", "vllm"], {
          env: { ...enterprise, OPENCODE_CONFIG: file, OPENCODE_CONFIG_CONTENT: "" },
        })
        opencode.expectExit(doctor, 1, "empty doctor config")
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)
        expect(Bun.file(file).lastModified).toBe(before)
        expect(
          yield* Effect.promise(() =>
            Promise.all(
              ["config.json", "opencode.json", "opencode.jsonc"].map((name) =>
                Bun.file(path.join(home, ".config", "opencode", name)).exists(),
              ),
            ),
          ),
        ).toEqual([false, false, false])

        const failedOutput = yield* opencode.spawn(["doctor", "vllm", "--output", home], {
          env: { ...enterprise, OPENCODE_CONFIG: file, OPENCODE_CONFIG_CONTENT: "" },
        })
        opencode.expectExit(failedOutput, 2, "failed doctor output")
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)
        expect(Bun.file(file).lastModified).toBe(before)

        const normal = yield* opencode.spawn(["mcp", "list"], {
          env: { ...enterprise, OPENCODE_CONFIG: file, OPENCODE_CONFIG_CONTENT: "" },
        })
        opencode.expectExit(normal, 0, "normal writable bootstrap")
        expect(yield* Effect.promise(() => Bun.file(file).text())).toContain('"$schema"')
      }),
    60_000,
  )
})
