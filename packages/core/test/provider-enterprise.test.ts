import { describe, expect, mock, test } from "bun:test"
import {
  assertEnterpriseRequestURL,
  diagnoseEnterpriseProviderPolicy,
  EnterpriseInferencePolicyError,
  enterpriseInferenceFetch,
  enterpriseEndpointURL,
  isEnterpriseProviderAllowed,
  normalizeEnterpriseBaseURL,
  parseEnterpriseVllmBaseURL,
} from "../src/provider/enterprise"

describe("enterprise inference policy", () => {
  const legacyAllowed = (input: {
    npm: string | undefined
    baseURL: string | undefined
    models: Record<string, unknown> | undefined
    allowedBaseURL: string | undefined
  }) => {
    if (input.npm !== "@ai-sdk/openai-compatible") return false
    if (!input.models || Object.keys(input.models).length === 0) return false
    const configured = normalizeEnterpriseBaseURL(input.baseURL)
    const allowed = normalizeEnterpriseBaseURL(input.allowedBaseURL)
    return configured !== undefined && configured === allowed
  }

  test.each([
    ["https://host/v1", "https://host/v1"],
    ["https://host/v1/", "https://host/v1"],
    ["https://host:443/v1", "https://host/v1"],
    ["http://host:80/v1", "http://host/v1"],
    ["https://host:8443/v1", "https://host:8443/v1"],
    ["https://[2001:db8::1]:8443/v1", "https://[2001:db8::1]:8443/v1"],
    ["HTTPS://HOST/v1", "https://host/v1"],
    ["not a URL", "https://host/v1"],
    ["https://user:password@host/v1", "https://host/v1"],
    ["https://host/v1?token=x", "https://host/v1"],
    ["https://host/v1#fragment", "https://host/v1"],
    ["ftp://host/v1", "ftp://host/v1"],
    [undefined, "https://host/v1"],
  ])("preserves legacy admission for %s against %s", (baseURL, allowedBaseURL) => {
    const input = { npm: "@ai-sdk/openai-compatible", baseURL, models: { model: {} }, allowedBaseURL }
    expect(isEnterpriseProviderAllowed(input)).toBe(legacyAllowed(input))
  })

  test("missing and malformed base URLs fail closed", () => {
    expect(parseEnterpriseVllmBaseURL(undefined)).toBeUndefined()
    expect(parseEnterpriseVllmBaseURL("not a url")).toBeUndefined()
    expect(parseEnterpriseVllmBaseURL("ftp://vllm.internal/v1")).toBeUndefined()
    expect(parseEnterpriseVllmBaseURL("https://user@vllm.internal/v1")).toBeUndefined()
  })

  test("normalizes only URL syntax and trailing slashes", () => {
    expect(normalizeEnterpriseBaseURL("HTTPS://VLLM.INTERNAL:443/v1///")).toBe("https://vllm.internal/v1")
    expect(normalizeEnterpriseBaseURL("http://vllm.internal:8000/v1/")).toBe("http://vllm.internal:8000/v1")
  })

  test("appends probe endpoints without dropping the configured base path", () => {
    expect(enterpriseEndpointURL("https://host/v1", "models").href).toBe("https://host/v1/models")
    expect(enterpriseEndpointURL("https://host/gateway/openai/v1/", "/chat/completions").href).toBe(
      "https://host/gateway/openai/v1/chat/completions",
    )
  })

  test("allows only explicit matching OpenAI-compatible providers with models", () => {
    const allowedBaseURL = "https://vllm.internal/v1"
    expect(
      isEnterpriseProviderAllowed({
        npm: "@ai-sdk/openai-compatible",
        baseURL: `${allowedBaseURL}/`,
        models: { llama: {} },
        allowedBaseURL,
      }),
    ).toBe(true)
    expect(
      isEnterpriseProviderAllowed({
        npm: "@ai-sdk/openai",
        baseURL: allowedBaseURL,
        models: { llama: {} },
        allowedBaseURL,
      }),
    ).toBe(false)
    expect(
      isEnterpriseProviderAllowed({
        npm: "@ai-sdk/openai-compatible",
        baseURL: allowedBaseURL,
        models: {},
        allowedBaseURL,
      }),
    ).toBe(false)
  })

  test.each([
    ["https://vllm.internal/v1", "BASE_URL_MATCH"],
    ["https://vllm.internal/v1/", "BASE_URL_MATCH"],
    ["http://vllm.internal/v1", "BASE_URL_SCHEME_MISMATCH"],
    ["https://other.internal/v1", "BASE_URL_HOST_MISMATCH"],
    ["https://vllm.internal:8443/v1", "BASE_URL_PORT_MISMATCH"],
    ["https://vllm.internal/v2", "BASE_URL_PATH_MISMATCH"],
    ["//vllm.internal/v1", "PROVIDER_BASE_URL_INVALID"],
    ["${VLLM_URL}", "PROVIDER_BASE_URL_UNRESOLVED"],
    ["{env:VLLM_URL}", "PROVIDER_BASE_URL_UNRESOLVED"],
  ])("diagnoses provider URL %s with %s", (baseURL, code) => {
    const result = diagnoseEnterpriseProviderPolicy({
      npm: "@ai-sdk/openai-compatible",
      baseURL,
      models: { llama: {} },
      allowedBaseURL: "https://vllm.internal/v1",
    })
    expect(result.checks.map((check) => check.code)).toContain(code)
    expect(result.allowed).toBe(code === "BASE_URL_MATCH")
  })

  test("diagnoses required fields", () => {
    const result = diagnoseEnterpriseProviderPolicy({
      npm: undefined,
      baseURL: undefined,
      models: {},
      allowedBaseURL: undefined,
    })
    expect(result.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining([
        "PROVIDER_NPM_MISSING",
        "PROVIDER_MODELS_EMPTY",
        "PROVIDER_BASE_URL_MISSING",
        "ENTERPRISE_BASE_URL_MISSING",
      ]),
    )
  })

  test.each([
    ["https://user:secret@vllm.internal/v1", "PROVIDER_BASE_URL_CREDENTIALS_REJECTED", "secret"],
    ["https://vllm.internal/v1?token=secret", "PROVIDER_BASE_URL_QUERY_REJECTED", "token=secret"],
    ["https://vllm.internal/v1#secret", "PROVIDER_BASE_URL_HASH_REJECTED", "#secret"],
  ])("redacts rejected URL data", (baseURL, code, secret) => {
    const result = diagnoseEnterpriseProviderPolicy({
      npm: "@ai-sdk/openai-compatible",
      baseURL,
      models: { llama: {} },
      allowedBaseURL: "https://vllm.internal/v1",
    })
    expect(result.checks.map((check) => check.code)).toContain(code)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  test("allows request paths beneath the configured base", () => {
    expect(
      assertEnterpriseRequestURL("https://VLLM.INTERNAL/v1/chat/completions", "https://vllm.internal/v1").href,
    ).toBe("https://vllm.internal/v1/chat/completions")
  })

  test.each([
    "http://vllm.internal/v1/chat/completions",
    "https://other.internal/v1/chat/completions",
    "https://vllm.internal:8443/v1/chat/completions",
    "https://user@vllm.internal/v1/chat/completions",
    "https://vllm.internal/v2/chat/completions",
    "https://vllm.internal/v1%2f..%2fadmin",
    "//vllm.internal/v1/chat/completions",
  ])("blocks disallowed request URL %s", (url) => {
    expect(() => assertEnterpriseRequestURL(url, "https://vllm.internal/v1")).toThrow(EnterpriseInferencePolicyError)
  })

  test("rejected requests never invoke a custom transport", async () => {
    const transport = mock(async () => new Response("ok"))
    await expect(
      enterpriseInferenceFetch("https://public.example/v1/chat", undefined, "https://vllm.internal/v1", transport),
    ).rejects.toBeInstanceOf(EnterpriseInferencePolicyError)
    expect(transport).not.toHaveBeenCalled()
  })

  test("allowed requests use manual redirects and reject redirect responses", async () => {
    const transport = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual")
      return new Response(null, { status: 302, headers: { location: "https://public.example/escape" } })
    })
    await expect(
      enterpriseInferenceFetch(
        "https://vllm.internal/v1/chat/completions",
        { redirect: "follow" },
        "https://vllm.internal/v1",
        transport,
      ),
    ).rejects.toBeInstanceOf(EnterpriseInferencePolicyError)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  test("allowed requests reach the configured transport", async () => {
    const transport = mock(async () => new Response("ok"))
    const response = await enterpriseInferenceFetch(
      "https://vllm.internal/v1/chat/completions",
      undefined,
      "https://vllm.internal/v1",
      transport,
    )
    expect(await response.text()).toBe("ok")
    expect(transport).toHaveBeenCalledTimes(1)
  })
})
