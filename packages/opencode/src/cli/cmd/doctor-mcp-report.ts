import { InstallationVersion } from "@opencode-ai/core/installation/version"
import type { MCPEnterpriseDiagnostic } from "@/config/config"
import { diagnoseEnterpriseMcp } from "@/mcp/enterprise-policy"

export function buildDoctorMcpReport(input: {
  diagnostic: MCPEnterpriseDiagnostic
  enterpriseMode: boolean
  requestedReference?: string
  generatedAt?: string
  platform?: NodeJS.Platform
  arch?: string
}) {
  const admission = diagnoseEnterpriseMcp({
    enterpriseMode: input.enterpriseMode,
    policy: input.diagnostic.managedPolicy,
    policySource: input.diagnostic.policySource,
    unmanagedPolicySources: input.diagnostic.unmanagedPolicySources,
    references: input.diagnostic.references,
    referenceSources: input.diagnostic.referenceSources,
    requestedReference: input.requestedReference,
    platform: input.platform ?? process.platform,
    configurationInvalid: input.diagnostic.configurationInvalid,
  })
  return redact({
    schemaVersion: 1 as const,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    binary: {
      version: InstallationVersion,
      platform: input.platform ?? process.platform,
      arch: input.arch ?? process.arch,
    },
    enterprise: { enabled: input.enterpriseMode },
    policy: {
      present: !!input.diagnostic.managedPolicy || input.diagnostic.unmanagedPolicySources.length > 0,
      managed: !!input.diagnostic.managedPolicy && !!input.diagnostic.policySource,
      source: input.diagnostic.policySource
        ? { kind: input.diagnostic.policySource.kind, path: safePath(input.diagnostic.policySource.source) }
        : undefined,
      managedFieldCount: Object.keys(input.diagnostic.policyFieldSources).length,
      unmanagedAttempts: input.diagnostic.unmanagedPolicySources.map((source) => ({
        kind: source.kind,
        source: safePath(source.source),
      })),
      mode: input.diagnostic.managedPolicy?.mode,
      projectReferences: input.diagnostic.managedPolicy?.projectReferences,
      limits: input.diagnostic.managedPolicy?.limits,
    },
    runtime: {
      schemaVersion: 1 as const,
      connectionMode: input.diagnostic.managedPolicy?.mode ?? "unconfigured",
      managedRemoteConnectionPermitted:
        input.enterpriseMode &&
        (input.diagnostic.managedPolicy?.mode === "connect" || input.diagnostic.managedPolicy?.mode === "catalog") &&
        admission.summary.status === "pass",
      managedToolCatalogDiscoveryPermitted:
        input.enterpriseMode &&
        input.diagnostic.managedPolicy?.mode === "catalog" &&
        admission.summary.status === "pass",
      exposedCapabilities: {
        tools: false,
        prompts: false,
        resources: false,
        resourceTemplates: false,
        instructions: false,
      },
    },
    references: admission.references,
    checks: admission.checks,
    suggestedCorrections: admission.corrections,
    summary: admission.summary,
  })
}

export function formatDoctorMcpReport(report: ReturnType<typeof buildDoctorMcpReport>, verbose = false) {
  const lines = [
    "OpenCode Enterprise MCP Doctor",
    "",
    `Overall policy result: ${report.summary.status.toUpperCase()}`,
    "",
    `Enterprise mode: ${report.enterprise.enabled ? "enabled" : "disabled"}`,
    `Managed policy provenance: ${report.policy.source ? `${report.policy.source.kind} (${report.policy.source.path})` : report.policy.present ? "untrusted" : "not configured"}`,
    `Requested managed references: ${report.references.length}`,
  ]
  for (const reference of report.references) {
    lines.push("", `Reference ${reference.alias}: ${reference.status.toUpperCase()}`)
    if (reference.server) lines.push(`  Server policy: ${reference.server}`)
    if (reference.constraints) {
      lines.push(
        `  Transport constraints: ${reference.constraints.transport}; redirects ${reference.constraints.redirects}`,
      )
      lines.push("  Authentication constraints: OAuth prohibited; secret references only")
      lines.push(
        `  Capability constraints: tools ${reference.constraints.capabilities.tools.mode}; resources/prompts/instructions denied`,
      )
    }
    if (verbose)
      lines.push(
        ...reference.checks.map((check) => `  [${check.status.toUpperCase()}] ${check.code}: ${check.message}`),
      )
  }
  lines.push("", `Limits: ${report.policy.limits ? "explicit and bounded" : "not available"}`)
  lines.push(
    `Operational state: ${report.runtime.managedRemoteConnectionPermitted ? "managed remote connection permitted" : "disabled"}`,
  )
  if (report.suggestedCorrections.length) {
    lines.push("", "Suggested corrections:")
    lines.push(...report.suggestedCorrections.map((correction) => `  - ${correction}`))
  }
  if (report.runtime.managedRemoteConnectionPermitted) {
    lines.push("", "Managed remote connection is permitted.")
    if (report.runtime.managedToolCatalogDiscoveryPermitted) {
      lines.push("Managed tool catalog discovery is permitted.")
      lines.push("Admitted tools remain private.")
      lines.push("MCP tool execution and model exposure remain disabled.", "")
      return lines.join("\n")
    }
    lines.push("MCP tools, prompts, resources and instructions remain disabled.", "")
    return lines.join("\n")
  }
  lines.push("", "Managed remote connection is disabled.")
  lines.push("A policy PASS does not establish a connection or start a process in diagnose mode.", "")
  return lines.join("\n")
}

export function redact<T>(value: T): T {
  return visit(value, "") as T
}

function visit(value: unknown, key: string): unknown {
  if (secretKey(key)) return "[REDACTED]"
  if (typeof value === "string") return redactString(value)
  if (Array.isArray(value)) return value.map((item) => visit(item, key))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]))
}

function redactString(value: string) {
  const credential = value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
  const query = credential.replace(/([?#]).*$/, "$1[REDACTED]")
  return query.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
}

function secretKey(key: string) {
  return /authorization|cookie|proxy.*credential|access.?token|refresh.?token|client.?secret|password|secret.?value/i.test(
    key,
  )
}

function safePath(value: string) {
  return /authorization|cookie|token|secret|password|[?#]/i.test(value) ? "[REDACTED]" : value
}
