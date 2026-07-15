import { describe, expect, test } from "bun:test"
import { isLoopbackServerURL } from "./network-policy"

describe("desktop enterprise server policy", () => {
  test("accepts managed loopback server URLs", () => {
    expect(isLoopbackServerURL("http://127.0.0.1:4096")).toBe(true)
    expect(isLoopbackServerURL("http://127.42.0.1:4096")).toBe(true)
    expect(isLoopbackServerURL("http://localhost:4096")).toBe(true)
    expect(isLoopbackServerURL("http://[::1]:4096")).toBe(true)
  })

  test("rejects public, private, credentialed, and unsupported URLs", () => {
    expect(isLoopbackServerURL("https://example.com")).toBe(false)
    expect(isLoopbackServerURL("http://192.168.1.2:4096")).toBe(false)
    expect(isLoopbackServerURL("http://user@localhost:4096")).toBe(false)
    expect(isLoopbackServerURL("ws://localhost:4096")).toBe(false)
  })
})
