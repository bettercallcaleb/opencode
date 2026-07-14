import { expect, spyOn, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Npm } from "@opencode-ai/core/npm"
import type { RuntimeFlags } from "../../src/effect/runtime-flags"
import * as LSPServer from "../../src/lsp/server"
import { tmpdir } from "../fixture/fixture"
import { Process } from "../../src/util/process"
import fs from "node:fs/promises"
import path from "node:path"

test("enterprise npm-backed LSP discovery is cache-only", async () => {
  await using tmp = await tmpdir()
  const originalFlag = Flag.OPENCODE_ENTERPRISE_MODE
  const originalPath = process.env.PATH
  const installLookup = spyOn(Npm, "which").mockRejectedValue(new Error("install lookup must not run"))
  const cachedLookup = spyOn(Npm, "whichCached").mockResolvedValue(undefined)
  try {
    Flag.OPENCODE_ENTERPRISE_MODE = true
    process.env.PATH = ""
    const context = { directory: tmp.path } as Parameters<typeof LSPServer.Typescript.spawn>[1]
    const flags = { disableLspDownload: false } as RuntimeFlags.Info

    const servers = [
      LSPServer.Typescript,
      LSPServer.Vue,
      LSPServer.Biome,
      LSPServer.Pyright,
      LSPServer.Svelte,
      LSPServer.Astro,
      LSPServer.YamlLS,
      LSPServer.PHPIntelephense,
      LSPServer.BashLS,
      LSPServer.DockerfileLS,
    ]
    for (const server of servers) expect(await server.spawn(tmp.path, context, flags)).toBeUndefined()

    expect(installLookup).not.toHaveBeenCalled()
    expect(cachedLookup.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        "@vue/language-server",
        "pyright",
        "svelte-language-server",
        "yaml-language-server",
        "intelephense",
        "bash-language-server",
        "dockerfile-language-server-nodejs",
      ]),
    )

    cachedLookup.mockResolvedValueOnce(process.execPath)
    const cached = await LSPServer.Vue.spawn(tmp.path, context, flags)
    expect(cached).toBeDefined()
    cached?.process.kill()
  } finally {
    Flag.OPENCODE_ENTERPRISE_MODE = originalFlag
    process.env.PATH = originalPath
    installLookup.mockRestore()
    cachedLookup.mockRestore()
  }
})

test("enterprise direct-download and package-manager LSPs stop before acquisition", async () => {
  await using tmp = await tmpdir()
  const bin = path.join(tmp.path, "bin")
  await fs.mkdir(bin)
  await Promise.all(
    ["go", "ruby", "gem"].map(async (name) => {
      const file = path.join(bin, name)
      await Bun.write(file, "#!/bin/sh\nexit 0\n")
      await fs.chmod(file, 0o755)
    }),
  )
  const eslint = path.join(tmp.path, "node_modules", "eslint")
  await fs.mkdir(eslint, { recursive: true })
  await Bun.write(path.join(eslint, "package.json"), JSON.stringify({ name: "eslint", main: "index.js" }))
  await Bun.write(path.join(eslint, "index.js"), "export default {}")

  const originalFlag = Flag.OPENCODE_ENTERPRISE_MODE
  const originalPath = process.env.PATH
  const fetchRequest = spyOn(globalThis, "fetch").mockRejectedValue(new Error("download must not run"))
  const packageManager = spyOn(Process, "spawn").mockImplementation(() => {
    throw new Error("package manager must not run")
  })
  try {
    Flag.OPENCODE_ENTERPRISE_MODE = true
    process.env.PATH = bin
    const context = { directory: tmp.path } as Parameters<typeof LSPServer.ESLint.spawn>[1]
    const flags = { disableLspDownload: false } as RuntimeFlags.Info

    expect(await LSPServer.ESLint.spawn(tmp.path, context, flags)).toBeUndefined()
    expect(await LSPServer.Gopls.spawn(tmp.path, context, flags)).toBeUndefined()
    expect(await LSPServer.Rubocop.spawn(tmp.path, context, flags)).toBeUndefined()
    expect(fetchRequest).not.toHaveBeenCalled()
    expect(packageManager).not.toHaveBeenCalled()
  } finally {
    Flag.OPENCODE_ENTERPRISE_MODE = originalFlag
    process.env.PATH = originalPath
    fetchRequest.mockRestore()
    packageManager.mockRestore()
  }
})
