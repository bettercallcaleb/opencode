import { describe, expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { ConfigMCPV1 } from "../../../src/v1/config/mcp"
import { ConfigMCPEnterprisePolicyV1 } from "../../../src/v1/config/mcp-enterprise-policy"

const server = {
  kind: "remote" as const,
  url: "https://mcp.corp.example/api/mcp",
  transport: "streamable-http" as const,
  redirects: "deny" as const,
  dns: { allowedCidrs: ["10.20.0.0/16"], denyLoopback: true, denyLinkLocal: true },
  headers: {
    allowedNames: ["authorization"],
    values: { authorization: { source: "environment" as const, name: "CORP_MCP_TOKEN", format: "Bearer" as const } },
  },
  oauth: { allowed: false as const },
  capabilities: {
    tools: { mode: "allowlist" as const, names: ["search"], dynamicChanges: "readmit" as const },
    resources: { mode: "deny" as const },
    prompts: { mode: "deny" as const },
    instructions: { mode: "deny" as const },
    logging: { mode: "metadata-only" as const },
  },
  runtime: { connect: "startup-only" as const, disconnect: "allow" as const },
}

const policy = {
  mode: "diagnose" as const,
  projectReferences: true,
  audit: { mode: "decisions" as const, includeArguments: false, includeOutput: false },
  limits: {
    connectTimeoutMs: 10_000,
    requestTimeoutMs: 30_000,
    maxResponseBytes: 2_097_152,
    responseHeaderTimeoutMs: 10_000,
    streamInactivityTimeoutMs: 30_000,
    maxRequestBytes: 1_048_576,
    maxHeaderBytes: 16_384,
    maxStreamFrameBytes: 262_144,
    maxTextBytes: 1_048_576,
    maxSchemaBytes: 262_144,
    maxListItems: 500,
    maxAttachments: 4,
    maxAttachmentBytes: 10_485_760,
    maxAttachmentTotalBytes: 20_971_520,
  },
  servers: { "source-control": server },
}

const succeeds = (schema: Schema.Decoder<unknown, never>, value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema)(value))

describe("enterprise MCP configuration schemas", () => {
  test("accepts only a narrow managed reference", () => {
    expect(succeeds(ConfigMCPV1.Managed, { type: "managed", server: "source-control", enabled: true })).toBe(true)
    expect(succeeds(ConfigMCPV1.Managed, { type: "managed", server: "source-control", url: "https://evil" })).toBe(
      false,
    )
    expect(succeeds(ConfigMCPV1.Managed, { type: "managed", server: "" })).toBe(false)
    for (const key of ["command", "headers", "environment", "oauth", "timeout", "transport", "capabilities", "limits"])
      expect(succeeds(ConfigMCPV1.Managed, { type: "managed", server: "source-control", [key]: {} })).toBe(false)
  })

  test("accepts explicit bounded remote policy", () => {
    expect(succeeds(ConfigMCPEnterprisePolicyV1.Info, policy)).toBe(true)
  })

  test("accepts explicit connect mode", () => {
    expect(Schema.decodeUnknownSync(ConfigMCPEnterprisePolicyV1.Info)({ ...policy, mode: "connect" }).mode).toBe(
      "connect",
    )
  })

  test.each([
    [{ ...policy, unknown: true }],
    [{ ...policy, audit: { ...policy.audit, unknown: true } }],
    [{ ...policy, limits: { ...policy.limits, unknown: true } }],
    [{ ...policy, servers: { x: { ...server, unknown: true } } }],
    [{ ...policy, servers: { x: { ...server, dns: { ...server.dns, unknown: true } } } }],
    [{ ...policy, servers: { x: { ...server, headers: { ...server.headers, unknown: true } } } }],
    [
      {
        ...policy,
        servers: {
          x: {
            ...server,
            headers: {
              ...server.headers,
              values: { authorization: { ...server.headers.values.authorization, unknown: true } },
            },
          },
        },
      },
    ],
    [{ ...policy, servers: { x: { ...server, oauth: { ...server.oauth, unknown: true } } } }],
    [{ ...policy, servers: { x: { ...server, capabilities: { ...server.capabilities, unknown: true } } } }],
    [
      {
        ...policy,
        servers: {
          x: {
            ...server,
            capabilities: { ...server.capabilities, tools: { ...server.capabilities.tools, unknown: true } },
          },
        },
      },
    ],
    [{ ...policy, servers: { x: { ...server, runtime: { ...server.runtime, unknown: true } } } }],
  ])("rejects unknown fields recursively", (value) => {
    expect(succeeds(ConfigMCPEnterprisePolicyV1.Info, value)).toBe(false)
  })

  test.each([
    [{ ...policy, mode: "enabled" }, "unsupported mode"],
    [{ ...policy, limits: { ...policy.limits, requestTimeoutMs: 0 } }, "limit below bound"],
    [{ ...policy, servers: { local: { kind: "local", command: ["mcp"] } } }, "local policy"],
    [{ ...policy, servers: { x: { ...server, redirects: "follow" } } }, "unsafe redirects"],
    [{ ...policy, servers: { x: { ...server, oauth: { allowed: true } } } }, "OAuth"],
    [{ ...policy, servers: { x: { ...server, transport: "auto" } } }, "unpinned transport"],
    [
      {
        ...policy,
        servers: {
          x: { ...server, headers: { allowedNames: ["authorization"], values: { authorization: "literal-secret" } } },
        },
      },
      "literal secret",
    ],
  ])("rejects %s", (value) => expect(succeeds(ConfigMCPEnterprisePolicyV1.Info, value)).toBe(false))
})

export { policy as validEnterpriseMcpPolicy }
