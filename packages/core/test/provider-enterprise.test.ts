import { describe, expect, mock, test } from "bun:test"
import {
  assertEnterpriseRequestURL,
  EnterpriseInferencePolicyError,
  enterpriseInferenceFetch,
  isEnterpriseProviderAllowed,
  normalizeEnterpriseBaseURL,
  parseEnterpriseVllmBaseURL,
} from "../src/provider/enterprise"

describe("enterprise inference policy", () => {
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

  test("allows request paths beneath the configured base", () => {
    expect(assertEnterpriseRequestURL("https://VLLM.INTERNAL/v1/chat/completions", "https://vllm.internal/v1").href).toBe(
      "https://vllm.internal/v1/chat/completions",
    )
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
