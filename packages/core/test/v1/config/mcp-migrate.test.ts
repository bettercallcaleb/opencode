import { describe, expect, test } from "bun:test"
import { ConfigMigrateV1 } from "../../../src/v1/config/migrate"

describe("v1 MCP migration", () => {
  test("preserves local, disabled, environment, and timeout fields", () => {
    const input = {
      mcp: {
        local: {
          type: "local" as const,
          command: ["bun", "server.ts"],
          cwd: "/workspace",
          environment: { TOKEN_ENV: "TOKEN_VALUE" },
          enabled: false,
          timeout: 4321,
        },
      },
    }
    expect(ConfigMigrateV1.migrate(input).mcp).toEqual({
      timeout: undefined,
      servers: {
        local: {
          type: "local",
          command: ["bun", "server.ts"],
          cwd: "/workspace",
          environment: { TOKEN_ENV: "TOKEN_VALUE" },
          disabled: true,
          timeout: { request: 4321 },
        },
      },
    })
  })

  test("preserves remote headers, OAuth, enabled state, and timeout", () => {
    const migrated = ConfigMigrateV1.migrate({
      mcp: {
        remote: {
          type: "remote",
          url: "https://mcp.example/rpc",
          headers: { Authorization: "Bearer test" },
          oauth: {
            clientId: "client",
            clientSecret: "secret",
            scope: "tools",
            callbackPort: 19876,
            redirectUri: "http://127.0.0.1:19876/callback",
          },
          enabled: true,
          timeout: 9876,
        },
      },
    })
    expect(migrated.mcp?.servers.remote).toEqual({
      type: "remote",
      url: "https://mcp.example/rpc",
      headers: { Authorization: "Bearer test" },
      oauth: {
        client_id: "client",
        client_secret: "secret",
        scope: "tools",
        callback_port: 19876,
        redirect_uri: "http://127.0.0.1:19876/callback",
      },
      disabled: false,
      timeout: { request: 9876 },
    })
  })

  test("preserves managed references without creating policy", () => {
    const input = { mcp: { source: { type: "managed" as const, server: "source-control", enabled: false } } }
    const first = ConfigMigrateV1.migrate(input)
    expect(first.mcp?.servers.source).toEqual({ type: "managed", server: "source-control", disabled: true })
    expect(first.enterprise).toBeUndefined()
    expect(input).toEqual({ mcp: { source: { type: "managed", server: "source-control", enabled: false } } })
  })

  test("migration is deterministic and does not create enterprise MCP policy", () => {
    const input = {
      enterprise: { url: "https://enterprise.example" },
      mcp: { remote: { type: "remote" as const, url: "https://mcp.example" } },
    }
    expect(ConfigMigrateV1.migrate(structuredClone(input))).toEqual(ConfigMigrateV1.migrate(structuredClone(input)))
    expect(ConfigMigrateV1.migrate(input).enterprise).toEqual({ url: "https://enterprise.example" })
  })
})
