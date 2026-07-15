import { describe, expect, test } from "bun:test"
import {
  assertEnterpriseOutboundURL,
  isEnterpriseEnvironmentValue,
  isLoopbackHost,
  OutboundNetworkPolicyError,
} from "../src/network/outbound-policy"

describe("enterprise outbound policy", () => {
  test("uses established truthy semantics", () => {
    expect(isEnterpriseEnvironmentValue("1")).toBe(true)
    expect(isEnterpriseEnvironmentValue("TRUE")).toBe(true)
    expect(isEnterpriseEnvironmentValue("false")).toBe(false)
  })

  test("recognizes only loopback IP ranges", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true)
    expect(isLoopbackHost("127.99.2.3")).toBe(true)
    expect(isLoopbackHost("::1")).toBe(true)
    expect(isLoopbackHost("10.0.0.1")).toBe(false)
    expect(isLoopbackHost("192.168.1.1")).toBe(false)
  })

  test("localhost is allowed only for an explicit local OpenCode client", () => {
    expect(() =>
      assertEnterpriseOutboundURL("http://localhost:4096", {
        enterpriseMode: true,
        purpose: "local-opencode",
      }),
    ).toThrow(OutboundNetworkPolicyError)
    expect(
      assertEnterpriseOutboundURL("http://localhost:4096", {
        enterpriseMode: true,
        purpose: "local-opencode",
        allowLocalhost: true,
      }).hostname,
    ).toBe("localhost")
  })

  test("allows only the approved vLLM base path for server egress", () => {
    const policy = { enterpriseMode: true, purpose: "vllm" as const, vllmBaseURL: "https://vllm.example/v1" }
    expect(assertEnterpriseOutboundURL("https://vllm.example/v1/chat/completions", policy).pathname).toBe(
      "/v1/chat/completions",
    )
    for (const url of [
      "http://vllm.example/v1/chat/completions",
      "https://vllm.example:8443/v1/chat/completions",
      "https://10.0.0.2/v1/chat/completions",
      "https://user@vllm.example/v1/chat/completions",
      "//vllm.example/v1/chat/completions",
    ])
      expect(() => assertEnterpriseOutboundURL(url, policy)).toThrow(OutboundNetworkPolicyError)
  })

  test("allows same-origin web communication but rejects public overrides", () => {
    const policy = { enterpriseMode: true, purpose: "same-origin" as const, sameOrigin: "https://code.example" }
    expect(assertEnterpriseOutboundURL("https://code.example/api/event", policy).pathname).toBe("/api/event")
    expect(() => assertEnterpriseOutboundURL("https://attacker.example", policy)).toThrow(OutboundNetworkPolicyError)
  })

  test("forbidden application egress fails closed", () => {
    for (const url of ["http://example.com", "https://example.com", "wss://example.com/socket"])
      expect(() =>
        assertEnterpriseOutboundURL(url, { enterpriseMode: true, purpose: "forbidden" }),
      ).toThrow(OutboundNetworkPolicyError)
  })

  test("non-enterprise behavior remains reachable", () => {
    expect(
      assertEnterpriseOutboundURL("https://example.com", { enterpriseMode: false, purpose: "forbidden" }).hostname,
    ).toBe("example.com")
  })
})
