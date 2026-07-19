import { describe, expect, test } from "bun:test"
import { buildDoctorVllmReport, formatDoctorVllmReport } from "../../src/cli/cmd/doctor-report"

const provider = {
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL: "https://vllm.internal/v1", apiKey: "test-api-key-secret" },
  models: { llama: { id: "meta/llama-api" } },
}

function report(overrides: Partial<Parameters<typeof buildDoctorVllmReport>[0]> = {}) {
  return buildDoctorVllmReport({
    cwd: "/workspace/project",
    directory: "/workspace/project",
    worktree: "/workspace/project",
    config: { model: "internal-vllm/llama", provider: { "internal-vllm": provider } },
    runtimeProviderIDs: ["internal-vllm"],
    enterpriseMode: true,
    enterpriseBaseURL: "https://vllm.internal/v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  })
}

describe("vLLM doctor report", () => {
  test("reports admitted provider, runtime visibility, and model alias", () => {
    const result = report()
    expect(result.summary.status).toBe("pass")
    expect(result.providers[0].checks.map((check) => check.code)).toEqual(
      expect.arrayContaining(["PROVIDER_DECLARED", "PROVIDER_ADMITTED", "PROVIDER_VISIBLE_IN_RUNTIME"]),
    )
    expect(result.defaultModel.checks.find((check) => check.code === "DEFAULT_MODEL_FOUND")?.detail?.apiModelID).toBe(
      "meta/llama-api",
    )
  })

  test.each([
    [{ disabled_providers: ["internal-vllm"] }, "PROVIDER_DISABLED"],
    [{ enabled_providers: ["other"] }, "PROVIDER_NOT_IN_ENABLED_LIST"],
  ])("diagnoses provider selection controls", (selection, code) => {
    const result = report({
      config: { model: "internal-vllm/llama", provider: { "internal-vllm": provider }, ...selection },
      runtimeProviderIDs: [],
    })
    expect(result.providers[0].checks.map((check) => check.code)).toContain(code)
    expect(result.providers[0].checks.map((check) => check.code)).toContain("PROVIDER_MISSING_FROM_RUNTIME")
  })

  test("diagnoses missing default provider and model", () => {
    const missingProvider = report({
      config: { model: "missing/llama", provider: { "internal-vllm": provider } },
      runtimeProviderIDs: [],
    })
    expect(missingProvider.providers[0].checks.map((check) => check.code)).toContain("PROVIDER_NOT_DECLARED")
    const missingModel = report({ config: { model: "internal-vllm/missing", provider: { "internal-vllm": provider } } })
    expect(missingModel.defaultModel.checks.map((check) => check.code)).toContain("DEFAULT_MODEL_NOT_FOUND")
  })

  test("JSON and verbose human output redact authentication values", () => {
    const result = report()
    expect(JSON.stringify(result)).not.toContain("test-api-key-secret")
    expect(formatDoctorVllmReport(result, true)).not.toContain("test-api-key-secret")
    expect(JSON.stringify(result.providers.flatMap((item) => item.checks).map((check) => check.code))).toContain(
      "BASE_URL_MATCH",
    )
  })
})
