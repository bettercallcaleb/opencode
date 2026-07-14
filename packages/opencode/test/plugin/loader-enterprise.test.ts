import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "../fixture/fixture"
import { PluginLoader } from "@/plugin/loader"
import { installPlugin } from "@/plugin/install"

async function withEnterpriseMode<A>(enabled: boolean, fn: () => Promise<A>) {
  const original = Flag.OPENCODE_ENTERPRISE_MODE
  Flag.OPENCODE_ENTERPRISE_MODE = enabled
  try {
    return await fn()
  } finally {
    Flag.OPENCODE_ENTERPRISE_MODE = original
  }
}

test("enterprise loader skips npm, cached npm, and file plugins before every callback", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "plugin.ts")
      const marker = path.join(dir, "imported.txt")
      await Bun.write(file, `await Bun.write(${JSON.stringify(marker)}, "imported")\nexport default async () => ({})\n`)
      return { file, marker }
    },
  })
  const shared = await import("@/plugin/shared")
  const resolve = spyOn(shared, "resolvePluginTarget").mockResolvedValue(tmp.extra.file)
  const add = spyOn(Npm, "add").mockResolvedValue({ directory: tmp.path, entrypoint: tmp.extra.file })
  const callbacks: string[] = []
  try {
    const loaded = await withEnterpriseMode(true, () =>
      PluginLoader.loadExternal({
        items: [
          { spec: "external-plugin", scope: "global", source: "config.json" },
          { spec: "cached-plugin", scope: "global", source: "config.json" },
          { spec: pathToFileURL(tmp.extra.file).href, scope: "local", source: "config.json" },
        ],
        kind: "server",
        wait: async () => {
          callbacks.push("wait")
        },
        finish: async () => {
          callbacks.push("finish")
        },
        missing: async () => {
          callbacks.push("missing")
        },
        report: {
          start: () => callbacks.push("start"),
          missing: () => callbacks.push("report.missing"),
          error: () => callbacks.push("report.error"),
        },
      }),
    )

    expect(loaded).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(callbacks).toEqual([])
    await expect(fs.stat(tmp.extra.marker)).rejects.toThrow()
  } finally {
    add.mockRestore()
    resolve.mockRestore()
  }
})

test("non-enterprise external file loading remains reachable", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "plugin.ts")
      await Bun.write(file, "export default async () => ({})\n")
      return { file }
    },
  })
  const loaded = await withEnterpriseMode(false, () =>
    PluginLoader.loadExternal({
      items: [{ spec: pathToFileURL(tmp.extra.file).href, scope: "local", source: "config.json" }],
      kind: "server",
    }),
  )
  expect(loaded).toHaveLength(1)
})

test("enterprise plugin installation does not resolve the requested target", async () => {
  let resolves = 0
  const result = await withEnterpriseMode(true, () =>
    installPlugin("external-plugin", {
      resolve: async () => {
        resolves++
        return "/unused"
      },
    }),
  )
  expect(result.ok).toBe(false)
  expect(resolves).toBe(0)
})

test("restores enterprise mode after loader failure", async () => {
  const original = Flag.OPENCODE_ENTERPRISE_MODE
  await expect(
    withEnterpriseMode(!original, async () => {
      throw new Error("expected failure")
    }),
  ).rejects.toThrow("expected failure")
  expect(Flag.OPENCODE_ENTERPRISE_MODE).toBe(original)
})
