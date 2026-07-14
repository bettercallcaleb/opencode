import fs from "fs/promises"
import path from "path"
import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Option } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "./fixture/tmpdir"
import { Flag } from "@opencode-ai/core/flag/flag"
import { NpmConfig } from "@opencode-ai/core/npm-config"

const win = process.platform === "win32"

const writePackage = (dir: string, pkg: Record<string, unknown>) =>
  Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      version: "1.0.0",
      ...pkg,
    }),
  )

const npmLayer = (cache: string) =>
  AppNodeBuilder.build(Npm.node, [[Global.node, Global.layerWith({ cache, state: path.join(cache, "state") })]])

const runNpm = <A, E>(cache: string, effect: Effect.Effect<A, E, Npm.Service>) =>
  effect.pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)

async function withEnterpriseMode<A>(enabled: boolean, fn: () => Promise<A>) {
  const original = Flag.OPENCODE_ENTERPRISE_MODE
  Flag.OPENCODE_ENTERPRISE_MODE = enabled
  try {
    return await fn()
  } finally {
    Flag.OPENCODE_ENTERPRISE_MODE = original
  }
}

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@opencode/acme")).toBe("@opencode/acme")
    expect(Npm.sanitize("@opencode/acme@1.0.0")).toBe("@opencode/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/opencode/acme.git"
    const expected = win ? "acme@git+https_//github.com/opencode/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

describe("Npm.add", () => {
  test("returns an existing cached package in enterprise mode without loading npm config", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const pkg = "cached-package"
    const installed = path.join(cache, "packages", pkg, "node_modules", pkg)
    await fs.mkdir(installed, { recursive: true })
    await writePackage(installed, { name: pkg, main: "index.js" })
    await Bun.write(path.join(installed, "index.js"), "export const cached = true\n")
    const load = spyOn(NpmConfig, "load")
    try {
      const entry = await withEnterpriseMode(true, () =>
        runNpm(
          cache,
          Npm.Service.use((npm) => npm.add(pkg)),
        ),
      )
      expect(entry.directory).toBe(installed)
      expect(load).not.toHaveBeenCalled()
    } finally {
      load.mockRestore()
    }
  })

  test("rejects an uncached package in enterprise mode before loading npm config", async () => {
    await using tmp = await tmpdir()
    const load = spyOn(NpmConfig, "load")
    try {
      await expect(
        withEnterpriseMode(true, () =>
          runNpm(
            path.join(tmp.path, "cache"),
            Npm.Service.use((npm) => npm.add("uncached-package")),
          ),
        ),
      ).rejects.toBeInstanceOf(Npm.RuntimeInstallDisabledError)
      expect(load).not.toHaveBeenCalled()
    } finally {
      load.mockRestore()
    }
  })

  test("reifies when package cache directory exists without the package installed", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "fixture-provider"))
    await writePackage(path.join(tmp.path, "fixture-provider"), {
      name: "fixture-provider",
      main: "index.js",
    })
    await Bun.write(path.join(tmp.path, "fixture-provider", "index.js"), "export const fixture = true\n")

    const spec = `fixture-provider@file:${path.join(tmp.path, "fixture-provider")}`
    await fs.mkdir(path.join(tmp.path, "cache", "packages", Npm.sanitize(spec)), { recursive: true })

    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(entry.entrypoint).toBeDefined()
  })
})

describe("Npm.install", () => {
  test("keeps valid existing local dependencies without installing in enterprise mode", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    await fs.mkdir(path.join(tmp.path, "node_modules", "local-package"), { recursive: true })
    await writePackage(tmp.path, { name: "fixture", dependencies: { "local-package": "1.0.0" } })
    await Bun.write(
      path.join(tmp.path, "package-lock.json"),
      JSON.stringify({ packages: { "": { dependencies: { "local-package": "1.0.0" } } } }),
    )
    const load = spyOn(NpmConfig, "load")
    try {
      await withEnterpriseMode(true, () =>
        runNpm(
          cache,
          Npm.Service.use((npm) => npm.install(tmp.path)),
        ),
      )
      expect(load).not.toHaveBeenCalled()
    } finally {
      load.mockRestore()
    }
  })

  test("rejects missing node_modules in enterprise mode before loading npm config", async () => {
    await using tmp = await tmpdir()
    await writePackage(tmp.path, { name: "fixture", dependencies: { missing: "1.0.0" } })
    const load = spyOn(NpmConfig, "load")
    try {
      await expect(
        withEnterpriseMode(true, () =>
          runNpm(
            path.join(tmp.path, "cache"),
            Npm.Service.use((npm) => npm.install(tmp.path)),
          ),
        ),
      ).rejects.toBeInstanceOf(Npm.RuntimeInstallDisabledError)
      expect(load).not.toHaveBeenCalled()
      await expect(fs.stat(path.join(tmp.path, "node_modules"))).rejects.toThrow()
      await expect(fs.stat(path.join(tmp.path, "package-lock.json"))).rejects.toThrow()
    } finally {
      load.mockRestore()
    }
  })

  test("rejects dirty dependencies without changing package-lock.json in enterprise mode", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "node_modules"))
    await writePackage(tmp.path, { name: "fixture", dependencies: { missing: "1.0.0" } })
    const lockfile = JSON.stringify({ packages: { "": { dependencies: {} } } })
    await Bun.write(path.join(tmp.path, "package-lock.json"), lockfile)
    const load = spyOn(NpmConfig, "load")
    try {
      await expect(
        withEnterpriseMode(true, () =>
          runNpm(
            path.join(tmp.path, "cache"),
            Npm.Service.use((npm) => npm.install(tmp.path)),
          ),
        ),
      ).rejects.toBeInstanceOf(Npm.RuntimeInstallDisabledError)
      expect(await Bun.file(path.join(tmp.path, "package-lock.json")).text()).toBe(lockfile)
      expect(load).not.toHaveBeenCalled()
    } finally {
      load.mockRestore()
    }
  })

  test("respects omit from project .npmrc", async () => {
    await using tmp = await tmpdir()

    await writePackage(tmp.path, {
      name: "fixture",
      dependencies: {
        "prod-pkg": "file:./prod-pkg",
      },
      devDependencies: {
        "dev-pkg": "file:./dev-pkg",
      },
    })
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit=dev\n")
    await fs.mkdir(path.join(tmp.path, "prod-pkg"))
    await fs.mkdir(path.join(tmp.path, "dev-pkg"))
    await writePackage(path.join(tmp.path, "prod-pkg"), { name: "prod-pkg" })
    await writePackage(path.join(tmp.path, "dev-pkg"), { name: "dev-pkg" })

    await withEnterpriseMode(false, () => Npm.install(tmp.path))

    await expect(fs.stat(path.join(tmp.path, "node_modules", "prod-pkg"))).resolves.toBeDefined()
    await expect(fs.stat(path.join(tmp.path, "node_modules", "dev-pkg"))).rejects.toThrow()
  })
})

describe("Npm.which", () => {
  test("cache-only lookup never installs or removes a lockfile", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const dir = path.join(cache, "packages", "tooling-bin")
    await fs.mkdir(dir, { recursive: true })
    const lockfile = "preserve-tooling-lockfile"
    await Bun.write(path.join(dir, "package-lock.json"), lockfile)
    const load = spyOn(NpmConfig, "load")
    try {
      const result = await runNpm(
        cache,
        Npm.Service.use((npm) => npm.whichCached!("tooling-bin")),
      )
      expect(result).toBeUndefined()
      expect(await Bun.file(path.join(dir, "package-lock.json")).text()).toBe(lockfile)
      expect(load).not.toHaveBeenCalled()
    } finally {
      load.mockRestore()
    }
  })

  test("returns an existing cached binary in enterprise mode", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const bin = path.join(cache, "packages", "cached-bin", "node_modules", ".bin", "cached-bin")
    await fs.mkdir(path.dirname(bin), { recursive: true })
    await Bun.write(bin, "")

    const result = await withEnterpriseMode(true, () =>
      runNpm(
        cache,
        Npm.Service.use((npm) => npm.which("cached-bin")),
      ),
    )
    expect(result).toBe(bin)
  })

  test("returns undefined for an uncached binary without deleting its lockfile", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const dir = path.join(cache, "packages", "uncached-bin")
    await fs.mkdir(dir, { recursive: true })
    const lockfile = "preserve-enterprise-lockfile"
    await Bun.write(path.join(dir, "package-lock.json"), lockfile)
    const load = spyOn(NpmConfig, "load")
    try {
      const result = await withEnterpriseMode(true, () =>
        runNpm(
          cache,
          Npm.Service.use((npm) => npm.which("uncached-bin")),
        ),
      )
      expect(result).toBeUndefined()
      expect(await Bun.file(path.join(dir, "package-lock.json")).text()).toBe(lockfile)
      expect(load).not.toHaveBeenCalled()
    } finally {
      load.mockRestore()
    }
  })
})

test("restores the enterprise flag when a guarded operation fails", async () => {
  const original = Flag.OPENCODE_ENTERPRISE_MODE
  await expect(
    withEnterpriseMode(!original, async () => {
      throw new Error("expected failure")
    }),
  ).rejects.toThrow("expected failure")
  expect(Flag.OPENCODE_ENTERPRISE_MODE).toBe(original)
})
