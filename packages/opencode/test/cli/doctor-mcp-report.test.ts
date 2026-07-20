import { describe, expect, test } from "bun:test"
import { buildDoctorMcpReport, formatDoctorMcpReport, redact } from "../../src/cli/cmd/doctor-mcp-report"
import { enterpriseMcpPolicy } from "../fixture/enterprise-mcp-policy"

const secret = "mcp-doctor-secret-9274"

describe("MCP doctor report", () => {
  test("builds deterministic valid, unmanaged, and unknown-reference reports", () => {
    const valid = buildDoctorMcpReport({
      enterpriseMode: true,
      generatedAt: "2026-01-01T00:00:00.000Z",
      platform: "linux",
      arch: "x64",
      diagnostic: {
        managedPolicy: enterpriseMcpPolicy,
        policySource: { kind: "managed-file", source: "/etc/opencode/opencode.json" },
        policyFieldSources: {},
        unmanagedPolicySources: [],
        references: { source: { type: "managed", server: "source-control" } },
        referenceSources: { source: { kind: "project", source: "/workspace/opencode.json" } },
      },
    })
    expect(valid.summary).toMatchObject({ status: "pass", operationallyEnabled: false })
    expect(valid.runtime).toMatchObject({ connectionMode: "diagnose", managedRemoteConnectionPermitted: false })
    expect(formatDoctorMcpReport(valid)).toContain("Managed remote connection is disabled.")
    const unmanaged = buildDoctorMcpReport({
      enterpriseMode: true,
      diagnostic: {
        policyFieldSources: {},
        unmanagedPolicySources: [{ kind: "inline", source: "OPENCODE_CONFIG_CONTENT" }],
        references: {},
        referenceSources: {},
      },
    })
    expect(unmanaged.summary.status).toBe("fail")
    const unknown = buildDoctorMcpReport({
      enterpriseMode: true,
      requestedReference: "missing",
      diagnostic: {
        managedPolicy: enterpriseMcpPolicy,
        policySource: { kind: "managed-file", source: "/etc/opencode/opencode.json" },
        policyFieldSources: {},
        unmanagedPolicySources: [],
        references: {},
        referenceSources: {},
      },
    })
    expect(unknown.summary.status).toBe("fail")
  })

  test("reports connect permission without advertising runtime capabilities", () => {
    const report = buildDoctorMcpReport({
      enterpriseMode: true,
      diagnostic: {
        managedPolicy: { ...enterpriseMcpPolicy, mode: "connect" },
        policySource: { kind: "managed-file", source: "/etc/opencode/opencode.json" },
        policyFieldSources: {},
        unmanagedPolicySources: [],
        references: { source: { type: "managed", server: "source-control" } },
        referenceSources: { source: { kind: "project", source: "/workspace/opencode.json" } },
      },
    })
    expect(report.runtime).toEqual({
      schemaVersion: 1,
      connectionMode: "connect",
      managedRemoteConnectionPermitted: true,
      exposedCapabilities: {
        tools: false,
        prompts: false,
        resources: false,
        resourceTemplates: false,
        instructions: false,
      },
    })
    const output = formatDoctorMcpReport(report)
    expect(output).toContain("Managed remote connection is permitted.")
    expect(output).toContain("MCP tools, prompts, resources and instructions remain disabled.")
  })

  test("redacts secrets recursively and verbose never weakens it", () => {
    const value = redact({
      Authorization: `Bearer ${secret}`,
      Cookie: secret,
      password: secret,
      url: `https://user:${secret}@mcp.invalid/path?token=${secret}#${secret}`,
      message: `failure Bearer ${secret}`,
    })
    const output = JSON.stringify(value)
    expect(output).not.toContain(secret)
    expect(output).not.toContain("user:")
  })
})
