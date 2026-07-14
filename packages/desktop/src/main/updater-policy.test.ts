import { describe, expect, test } from "bun:test"
import { isDesktopUpdaterEnabled, isTruthyEnvironmentValue } from "./updater-policy"

describe("desktop updater policy", () => {
  test("recognizes established truthy environment values", () => {
    expect(isTruthyEnvironmentValue("1")).toBe(true)
    expect(isTruthyEnvironmentValue("true")).toBe(true)
    expect(isTruthyEnvironmentValue("TRUE")).toBe(true)
    expect(isTruthyEnvironmentValue(undefined)).toBe(false)
    expect(isTruthyEnvironmentValue("0")).toBe(false)
    expect(isTruthyEnvironmentValue("false")).toBe(false)
    expect(isTruthyEnvironmentValue("enabled")).toBe(false)
  })

  test("disables packaged production and beta updates in enterprise mode", () => {
    expect(isDesktopUpdaterEnabled({ packaged: true, channel: "prod", enterpriseMode: true })).toBe(false)
    expect(isDesktopUpdaterEnabled({ packaged: true, channel: "beta", enterpriseMode: true })).toBe(false)
  })

  test("enables packaged production updates outside enterprise mode", () => {
    expect(isDesktopUpdaterEnabled({ packaged: true, channel: "prod", enterpriseMode: false })).toBe(true)
  })

  test("keeps development channel updates disabled", () => {
    expect(isDesktopUpdaterEnabled({ packaged: true, channel: "dev", enterpriseMode: false })).toBe(false)
  })
})
