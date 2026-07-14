import { expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import config, { runtimeParsers } from "../src/parsers-config"

test("enterprise mode does not register URL-backed parsers", () => {
  const original = Flag.OPENCODE_ENTERPRISE_MODE
  try {
    Flag.OPENCODE_ENTERPRISE_MODE = true
    expect(runtimeParsers()).toEqual([])

    Flag.OPENCODE_ENTERPRISE_MODE = false
    expect(runtimeParsers()).toBe(config.parsers)
  } finally {
    Flag.OPENCODE_ENTERPRISE_MODE = original
  }
})
