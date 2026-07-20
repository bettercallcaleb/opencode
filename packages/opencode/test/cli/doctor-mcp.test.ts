import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { enterpriseMcpPolicy } from "../fixture/enterprise-mcp-policy"

const cli = path.join(import.meta.dir, "../../src/index.ts")
const guard = path.join(import.meta.dir, "../fixture/doctor-network-guard.ts")
const secret = "mcp-cli-secret-481516"
let root = ""

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-doctor-mcp-"))
  await fs.mkdir(path.join(root, "managed"), { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const setManaged = (value: object) => Bun.write(path.join(root, "managed", "opencode.json"), JSON.stringify(value))

async function run(args: string[], input: { config?: object; preload?: boolean; env?: Record<string, string> } = {}) {
  const command = input.preload
    ? [process.execPath, "--preload", guard, "--conditions=browser", cli, ...args]
    : [process.execPath, "run", "--conditions=browser", cli, ...args]
  const child = Bun.spawn(command, {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      OPENCODE_TEST_HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      OPENCODE_ENTERPRISE_MODE: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(input.config ?? {}),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      ...input.env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe.serial("opencode doctor mcp", () => {
  test("runs valid human, JSON, and output paths with zero network or subprocess activity", async () => {
    await setManaged({ enterprise: { mcp: enterpriseMcpPolicy } })
    const config = { mcp: { source: { type: "managed", server: "source-control" } } }
    const human = await run(["doctor", "mcp"], { config, preload: true })
    expect(human.exitCode).toBe(0)
    expect(human.stdout).toContain("Overall policy result: PASS")
    expect(human.stdout).toContain("MCP is operationally disabled in Phase 1.")
    const output = path.join(root, "mcp-doctor.json")
    const json = await run(["doctor", "mcp", "source", "--json", "--output", output], { config, preload: true })
    expect(json.exitCode).toBe(0)
    expect(JSON.parse(json.stdout).summary.operationallyEnabled).toBe(false)
    expect(JSON.parse(await Bun.file(output).text()).summary.status).toBe("pass")
  }, 60_000)

  test("uses requested exit codes for empty, unmanaged, unknown, misuse, and output failure", async () => {
    await setManaged({})
    expect((await run(["doctor", "mcp", "--json"])).exitCode).toBe(0)
    expect(
      (await run(["doctor", "mcp", "--json"], { config: { enterprise: { mcp: enterpriseMcpPolicy } } })).exitCode,
    ).toBe(1)
    await setManaged({ enterprise: { mcp: enterpriseMcpPolicy } })
    expect((await run(["doctor", "mcp", "missing", "--json"])).exitCode).toBe(1)
    expect((await run(["doctor", "mcp", "--unknown"])).exitCode).toBe(2)
    expect((await run(["doctor", "mcp", "--output", root])).exitCode).toBe(2)
    await setManaged({ enterprise: { mcp: { ...enterpriseMcpPolicy, mode: "enabled" } } })
    const invalid = await run(["doctor", "mcp", "--json"])
    expect(invalid.exitCode).toBe(1)
    expect(JSON.parse(invalid.stdout).checks.map((check: { code: string }) => check.code)).toContain(
      "MCP_POLICY_MODE_UNSUPPORTED",
    )
  }, 60_000)

  test("redacts secrets from human, verbose, JSON, file, stderr, and errors", async () => {
    await setManaged({ enterprise: { mcp: enterpriseMcpPolicy } })
    const config = {
      mcp: {
        unsafe: {
          type: "remote",
          url: `https://user:${secret}@mcp.invalid/path?token=${secret}#${secret}`,
          headers: { Authorization: `Bearer ${secret}`, Cookie: secret },
        },
      },
    }
    const output = path.join(root, "redacted.json")
    const human = await run(["doctor", "mcp", "--verbose"], { config, env: { CORP_MCP_TOKEN: secret } })
    const json = await run(["doctor", "mcp", "--json", "--output", output], {
      config,
      env: { CORP_MCP_TOKEN: secret },
    })
    expect(human.stdout + human.stderr + json.stdout + json.stderr).not.toContain(secret)
    expect(await Bun.file(output).text()).not.toContain(secret)
  }, 60_000)
})
