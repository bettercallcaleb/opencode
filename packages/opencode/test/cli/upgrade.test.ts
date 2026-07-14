import { expect, spyOn, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { UpgradeCommand } from "@/cli/cmd/upgrade"
import { Installation } from "@/installation"

async function withEnterpriseMode<A>(enabled: boolean, fn: () => Promise<A>) {
  const original = Flag.OPENCODE_ENTERPRISE_MODE
  Flag.OPENCODE_ENTERPRISE_MODE = enabled
  try {
    return await fn()
  } finally {
    Flag.OPENCODE_ENTERPRISE_MODE = original
  }
}

test("manual upgrade fails before version lookup in enterprise mode", async () => {
  const latest = spyOn(Installation, "latest")
  try {
    await expect(withEnterpriseMode(true, () => UpgradeCommand.handler({}))).rejects.toThrow(
      "OpenCode self-update is disabled in enterprise mode",
    )
    expect(latest).not.toHaveBeenCalled()
  } finally {
    latest.mockRestore()
  }
})

test("manual upgrade remains reachable outside enterprise mode", async () => {
  const method = spyOn(Installation, "method").mockResolvedValue("npm")
  const latest = spyOn(Installation, "latest").mockResolvedValue(InstallationVersion)
  try {
    await withEnterpriseMode(false, () => UpgradeCommand.handler({}))
    expect(latest).toHaveBeenCalledTimes(1)
  } finally {
    latest.mockRestore()
    method.mockRestore()
  }
})

test("enterprise flag is restored when the guarded operation fails", async () => {
  const original = Flag.OPENCODE_ENTERPRISE_MODE
  await expect(
    withEnterpriseMode(!original, async () => {
      throw new Error("expected failure")
    }),
  ).rejects.toThrow("expected failure")
  expect(Flag.OPENCODE_ENTERPRISE_MODE).toBe(original)
})
