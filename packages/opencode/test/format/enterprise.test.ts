import path from "node:path"
import { expect, spyOn, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Npm } from "@opencode-ai/core/npm"
import * as Formatter from "../../src/format/formatter"
import { tmpdir } from "../fixture/fixture"

test("enterprise formatter discovery uses cache-only npm lookup", async () => {
  await using tmp = await tmpdir()
  await Bun.write(
    path.join(tmp.path, "package.json"),
    JSON.stringify({ dependencies: { prettier: "3.0.0", oxfmt: "1.0.0" } }),
  )
  await Bun.write(path.join(tmp.path, "biome.json"), "{}")

  const original = Flag.OPENCODE_ENTERPRISE_MODE
  const installLookup = spyOn(Npm, "which").mockRejectedValue(new Error("install lookup must not run"))
  const cachedLookup = spyOn(Npm, "whichCached").mockResolvedValue(undefined)
  try {
    Flag.OPENCODE_ENTERPRISE_MODE = true
    const context = { directory: tmp.path, worktree: tmp.path, experimentalOxfmt: true }

    expect(await Formatter.prettier.enabled(context)).toBe(false)
    expect(await Formatter.oxfmt.enabled(context)).toBe(false)
    expect(await Formatter.biome.enabled(context)).toBe(false)
    expect(installLookup).not.toHaveBeenCalled()
    expect(cachedLookup).toHaveBeenCalledTimes(3)
  } finally {
    Flag.OPENCODE_ENTERPRISE_MODE = original
    installLookup.mockRestore()
    cachedLookup.mockRestore()
  }
})

test("enterprise formatter discovery accepts cached binaries", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ dependencies: { prettier: "3.0.0" } }))

  const original = Flag.OPENCODE_ENTERPRISE_MODE
  const cachedLookup = spyOn(Npm, "whichCached").mockResolvedValue("/cache/bin/prettier")
  try {
    Flag.OPENCODE_ENTERPRISE_MODE = true
    expect(
      await Formatter.prettier.enabled({ directory: tmp.path, worktree: tmp.path, experimentalOxfmt: false }),
    ).toEqual(["/cache/bin/prettier", "--write", "$FILE"])
  } finally {
    Flag.OPENCODE_ENTERPRISE_MODE = original
    cachedLookup.mockRestore()
  }
})
