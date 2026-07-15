import { describe, expect, test } from "bun:test"
import { isAllowedEnterpriseWebServer } from "./network-policy"

describe("web enterprise server policy", () => {
  test("keeps same-origin and explicit loopback communication", () => {
    expect(isAllowedEnterpriseWebServer("https://code.example/api", "https://code.example")).toBe(true)
    expect(isAllowedEnterpriseWebServer("http://127.0.0.1:4096", "https://code.example")).toBe(true)
    expect(isAllowedEnterpriseWebServer("http://localhost:4096", "https://code.example")).toBe(true)
  })

  test("rejects localStorage-style public overrides", () => {
    expect(isAllowedEnterpriseWebServer("https://attacker.example", "https://code.example")).toBe(false)
    expect(isAllowedEnterpriseWebServer("http://192.168.1.3:4096", "https://code.example")).toBe(false)
    expect(isAllowedEnterpriseWebServer("https://user@code.example", "https://code.example")).toBe(false)
  })
})
