import { describe, expect, test } from "bun:test"
import { diagnoseEnterpriseMcp, DiagnosticCodes } from "../../src/mcp/enterprise-policy"
import { enterpriseMcpPolicy } from "../fixture/enterprise-mcp-policy"

const managed = { kind: "managed-file" as const, source: "/etc/opencode/opencode.json" }
const project = { kind: "project" as const, source: "/workspace/opencode.json" }

function diagnose(overrides: Partial<Parameters<typeof diagnoseEnterpriseMcp>[0]> = {}) {
  return diagnoseEnterpriseMcp({
    enterpriseMode: true,
    policy: enterpriseMcpPolicy,
    policySource: managed,
    unmanagedPolicySources: [],
    references: { source: { type: "managed", server: "source-control", enabled: true } },
    referenceSources: { source: project },
    platform: "linux",
    ...overrides,
  })
}

describe("enterprise MCP admission", () => {
  test("admits a known reference while remaining operationally disabled", () => {
    const result = diagnose()
    expect(result.summary).toMatchObject({ status: "pass", operationallyEnabled: false })
    expect(result.references[0].constraints?.url).toBe("https://mcp.corp.example/api/mcp")
    expect(result.references[0].checks.map((check) => check.code)).toContain("MCP_REFERENCE_ALLOWED")
  })

  test("fails unknown and unmanaged definitions", () => {
    expect(diagnose({ references: { source: { type: "managed", server: "missing" } } }).summary.status).toBe("fail")
    expect(diagnose({ references: { source: { type: "remote", url: "https://mcp.corp.example" } } }).references[0]?.checks.map((check) => check.code)).toContain("MCP_DEFINITION_UNMANAGED")
  })

  test("treats disabled references as informational", () => {
    const result = diagnose({ references: { source: { type: "managed", server: "source-control", enabled: false } } })
    expect(result.summary.status).toBe("pass")
    expect(result.references[0].checks.map((check) => check.code)).toContain("MCP_REFERENCE_DISABLED")
  })

  test("enforces project reference policy and detects namespaces", () => {
    expect(diagnose({ policy: { ...enterpriseMcpPolicy, projectReferences: false } }).summary.status).toBe("fail")
    const collision = diagnose({
      references: {
        "source.control": { type: "managed", server: "source-control" },
        source_control: { type: "managed", server: "source-control" },
      },
      referenceSources: { "source.control": project, source_control: project },
    })
    expect(collision.references.flatMap((item) => item.checks).map((check) => check.code)).toContain("MCP_NAME_COLLISION")
  })

  test("rejects URL credentials, query, fragment, scheme and unresolved placeholders", () => {
    const urls = [
      ["https://user:password@mcp.corp/api", "MCP_URL_CREDENTIALS_REJECTED"],
      ["https://mcp.corp/api?secret=value", "MCP_URL_QUERY_REJECTED"],
      ["https://mcp.corp/api#secret", "MCP_URL_FRAGMENT_REJECTED"],
      ["file:///tmp/mcp", "MCP_URL_SCHEME_REJECTED"],
      ["https://${MCP_HOST}/api", "MCP_URL_INVALID"],
    ] as const
    for (const [url, code] of urls) {
      const policy = { ...enterpriseMcpPolicy, servers: { "source-control": { ...enterpriseMcpPolicy.servers["source-control"], url } } }
      expect(diagnose({ policy }).references[0].checks.map((check) => check.code)).toContain(code)
    }
  })

  test.each([
    ["HTTPS://MCP.CORP.EXAMPLE:443/a/../api/", "https://mcp.corp.example/api"],
    ["https://mcp.corp.example:8443/api", "https://mcp.corp.example:8443/api"],
    ["https://mcp.corp.example/a//b", "https://mcp.corp.example/a//b"],
    ["https://mcp.corp.example/a%2Fb", "https://mcp.corp.example/a%2Fb"],
    ["https://[2001:db8::1]/mcp", "https://[2001:db8::1]/mcp"],
    ["https://bücher.example/mcp", "https://xn--bcher-kva.example/mcp"],
  ])("canonicalizes safe URL %s", (url, canonical) => {
    const policy = { ...enterpriseMcpPolicy, servers: { "source-control": { ...enterpriseMcpPolicy.servers["source-control"], url } } }
    expect(diagnose({ policy }).references[0].constraints?.url).toBe(canonical)
  })

  test.each(["//mcp.example/rpc", "https://[fe80::1%25eth0]/rpc", " https://mcp.example", "https://mcp.example\n"])(
    "rejects ambiguous URL %s",
    (url) => {
      const policy = { ...enterpriseMcpPolicy, servers: { "source-control": { ...enterpriseMcpPolicy.servers["source-control"], url } } }
      expect(diagnose({ policy }).summary.status).toBe("fail")
    },
  )

  test("rejects header case collisions, missing values, invalid names, and forbidden transport headers", () => {
    const variants = [
      { allowedNames: ["Authorization", "authorization"], values: { authorization: { source: "environment" as const, name: "TOKEN", format: "Bearer" as const } } },
      { allowedNames: ["Authorization"], values: {} },
      { allowedNames: [" Authorization"], values: { " Authorization": { source: "environment" as const, name: "TOKEN", format: "Raw" as const } } },
      { allowedNames: [":authority"], values: { ":authority": { source: "environment" as const, name: "TOKEN", format: "Raw" as const } } },
      ...["Host", "Content-Length", "Transfer-Encoding", "Connection", "Proxy-Authorization", "Cookie", "Set-Cookie"].map((name) => ({
        allowedNames: [name],
        values: { [name]: { source: "environment" as const, name: "TOKEN", format: "Raw" as const } },
      })),
    ]
    for (const headers of variants) {
      const policy = { ...enterpriseMcpPolicy, servers: { "source-control": { ...enterpriseMcpPolicy.servers["source-control"], headers } } }
      expect(diagnose({ policy }).summary.status).toBe("fail")
    }
  })

  test("rejects tool names that collide after MCP namespace sanitization", () => {
    const base = enterpriseMcpPolicy.servers["source-control"]
    const policy = {
      ...enterpriseMcpPolicy,
      servers: {
        "source-control": {
          ...base,
          capabilities: { ...base.capabilities, tools: { ...base.capabilities.tools, names: ["tool.a", "tool_a"] } },
        },
      },
    }
    expect(diagnose({ policy }).references[0].checks).toContainEqual(
      expect.objectContaining({ code: "MCP_NAME_COLLISION", status: "fail" }),
    )
  })

  test("publishes a stable complete code vocabulary", () => {
    expect(new Set(DiagnosticCodes).size).toBe(DiagnosticCodes.length)
    expect(DiagnosticCodes).toContain("MCP_OPERATIONALLY_DISABLED")
    expect(DiagnosticCodes).toContain("MCP_LITERAL_SECRET_REJECTED")
  })

  test.each([
    [{ kind: "managed-file" as const, source: "C:\\ProgramData\\opencode\\opencode.json" }, "win32" as const],
    [{ kind: "managed-file" as const, source: "/etc/opencode/opencode.json" }, "linux" as const],
    [{ kind: "managed-preference" as const, source: "mobileconfig:/Library/Managed Preferences/ai.opencode.managed.plist" }, "darwin" as const],
  ])("accepts production-classified managed provenance", (policySource, platform) => {
    const result = diagnose({ policySource, platform })
    expect(result.summary.status).toBe("pass")
    expect(result.checks.map((check) => check.code)).toContain(
      policySource.kind === "managed-preference" ? "MCP_POLICY_SOURCE_MANAGED_PREFERENCE" : "MCP_POLICY_SOURCE_MANAGED_FILE",
    )
  })

  test("ignores untrusted policy fields when a later managed policy exists", () => {
    const result = diagnose({ unmanagedPolicySources: [{ kind: "project", source: "/workspace/opencode.json" }] })
    expect(result.summary.status).toBe("pass")
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "MCP_POLICY_SOURCE_UNTRUSTED", status: "warning" }))
  })
})
