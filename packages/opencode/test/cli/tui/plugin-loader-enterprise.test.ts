import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiConfig } from "@/config/tui"

const { TuiPluginRuntime } = await import("@/plugin/tui/runtime")

test("enterprise tui initialization keeps internal plugins without preparing external plugins", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "plugin.ts")
      const marker = path.join(dir, "called.txt")
      await Bun.write(
        file,
        `export default { id: "enterprise.external", tui: async () => { await Bun.write(${JSON.stringify(marker)}, "called") } }\n`,
      )
      return { file, marker }
    },
  })
  const original = Flag.OPENCODE_ENTERPRISE_MODE
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const add = spyOn(Npm, "add")
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  Flag.OPENCODE_ENTERPRISE_MODE = true
  try {
    const spec = pathToFileURL(tmp.extra.file).href
    await TuiPluginRuntime.init({
      api: createTuiPluginApi(),
      config: createTuiResolvedConfig({
        plugin: [spec],
        plugin_origins: [{ spec, scope: "local", source: path.join(tmp.path, "tui.json") }],
      }),
    })

    expect(TuiPluginRuntime.list().length).toBeGreaterThan(0)
    expect(TuiPluginRuntime.list().some((item) => item.spec === spec)).toBe(false)
    expect(wait).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(await TuiPluginRuntime.addPlugin(spec)).toBe(false)
    expect(await TuiPluginRuntime.installPlugin("external-plugin")).toEqual({
      ok: false,
      message: "External plugins are disabled in enterprise mode",
    })
    await expect(fs.stat(tmp.extra.marker)).rejects.toThrow()
  } finally {
    await TuiPluginRuntime.dispose()
    Flag.OPENCODE_ENTERPRISE_MODE = original
    cwd.mockRestore()
    add.mockRestore()
    wait.mockRestore()
  }
})
