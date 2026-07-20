import type { ConfigMCPEnterprisePolicyV1 } from "@opencode-ai/core/v1/config/mcp-enterprise-policy"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import type { MCPConfigSource } from "@/config/config"

export const DiagnosticCodes = [
  "MCP_ENTERPRISE_MODE_ENABLED",
  "MCP_ENTERPRISE_MODE_DISABLED",
  "MCP_POLICY_PRESENT",
  "MCP_POLICY_MISSING",
  "MCP_POLICY_MANAGED",
  "MCP_POLICY_NOT_MANAGED",
  "MCP_POLICY_MODE_DIAGNOSE",
  "MCP_POLICY_MODE_CONNECT",
  "MCP_POLICY_MODE_UNSUPPORTED",
  "MCP_OPERATIONALLY_DISABLED",
  "MCP_CONNECTION_ELIGIBLE",
  "MCP_CONNECTION_OPERATIONAL",
  "MCP_CONNECTION_DISABLED",
  "MCP_CONNECTION_FAILED",
  "MCP_REFERENCE_DECLARED",
  "MCP_REFERENCE_UNKNOWN",
  "MCP_REFERENCE_DISABLED",
  "MCP_REFERENCE_ALLOWED",
  "MCP_REFERENCE_FIELDS_INVALID",
  "MCP_PROJECT_REFERENCES_ALLOWED",
  "MCP_PROJECT_REFERENCES_PROHIBITED",
  "MCP_DEFINITION_UNMANAGED",
  "MCP_SERVER_FOUND",
  "MCP_SERVER_DISABLED",
  "MCP_SERVER_KIND_REMOTE",
  "MCP_LOCAL_PROHIBITED",
  "MCP_URL_PRESENT",
  "MCP_URL_INVALID",
  "MCP_URL_CREDENTIALS_REJECTED",
  "MCP_URL_QUERY_REJECTED",
  "MCP_URL_FRAGMENT_REJECTED",
  "MCP_URL_SCHEME_REJECTED",
  "MCP_TRANSPORT_PINNED",
  "MCP_TRANSPORT_NOT_PINNED",
  "MCP_TRANSPORT_UNSUPPORTED",
  "MCP_REDIRECT_POLICY_SAFE",
  "MCP_REDIRECT_POLICY_UNSAFE",
  "MCP_OAUTH_PROHIBITED",
  "MCP_OAUTH_UNSAFE",
  "MCP_HEADER_ALLOWED",
  "MCP_HEADER_NOT_ALLOWED",
  "MCP_SECRET_REFERENCE_VALID",
  "MCP_SECRET_REFERENCE_INVALID",
  "MCP_LITERAL_SECRET_REJECTED",
  "MCP_CAPABILITY_TOOLS_EXPLICIT",
  "MCP_CAPABILITY_RESOURCES_EXPLICIT",
  "MCP_CAPABILITY_PROMPTS_EXPLICIT",
  "MCP_CAPABILITY_INSTRUCTIONS_EXPLICIT",
  "MCP_CAPABILITY_LOGGING_EXPLICIT",
  "MCP_CAPABILITY_NOT_EXPLICIT",
  "MCP_TOOL_ALLOWLIST_PRESENT",
  "MCP_TOOL_ALLOWLIST_EMPTY",
  "MCP_DYNAMIC_TOOL_POLICY_PRESENT",
  "MCP_LIMIT_VALID",
  "MCP_LIMIT_OUT_OF_RANGE",
  "MCP_NAME_VALID",
  "MCP_NAME_COLLISION",
  "MCP_POLICY_SOURCE_MANAGED_FILE",
  "MCP_POLICY_SOURCE_MANAGED_PREFERENCE",
  "MCP_POLICY_SOURCE_UNTRUSTED",
  "MCP_REFERENCE_SOURCE_PROJECT",
  "MCP_REFERENCE_SOURCE_GLOBAL",
  "MCP_REFERENCE_SOURCE_INLINE",
  "MCP_REFERENCE_SOURCE_CUSTOM_CONFIG",
  "MCP_REFERENCE_SOURCE_MANAGED",
  "MCP_DNS_POLICY_VALID",
  "MCP_DNS_POLICY_INVALID",
] as const

export type DiagnosticCode = (typeof DiagnosticCodes)[number]
export type DiagnosticCheck = {
  code: DiagnosticCode
  status: "pass" | "warning" | "fail" | "info"
  message: string
}

type Reference = ConfigMCPV1.Info | { enabled: boolean }

export type AdmissionInput = {
  enterpriseMode: boolean
  policy?: ConfigMCPEnterprisePolicyV1.Info
  policySource?: MCPConfigSource
  unmanagedPolicySources: MCPConfigSource[]
  references: Record<string, Reference>
  referenceSources: Record<string, MCPConfigSource>
  requestedReference?: string
  platform: NodeJS.Platform
  configurationInvalid?: boolean
}

const admittedEnterpriseMcpServer = Symbol("AdmittedEnterpriseMcpServer")
const admittedEnterpriseMcpServers = new WeakSet<object>()

export type AdmittedEnterpriseMcpServer = Readonly<{
  [admittedEnterpriseMcpServer]: true
  id: string
  alias: string
  url: string
  transport: "streamable-http"
  dns: Readonly<{
    allowedCidrs: readonly string[]
    denyLoopback: boolean
    denyLinkLocal: boolean
  }>
  headers: Readonly<{
    allowedNames: readonly string[]
    secretReferences: readonly Readonly<{
      header: string
      source: "environment"
      name: string
      format: "Bearer" | "Raw"
    }>[]
  }>
  limits: Readonly<ConfigMCPEnterprisePolicyV1.Info["limits"]>
}>

export function admitEnterpriseMcpHttpServer(input: AdmissionInput, alias: string): AdmittedEnterpriseMcpServer {
  const diagnostic = diagnoseEnterpriseMcp({ ...input, requestedReference: alias })
  const reference = diagnostic.references[0]
  if (
    !input.enterpriseMode ||
    diagnostic.summary.status !== "pass" ||
    reference?.status !== "pass" ||
    !reference.server
  )
    throw new Error("Enterprise MCP server admission failed.")
  const server = input.policy?.servers[reference.server]
  if (!server || server.transport !== "streamable-http" || !input.policy)
    throw new Error("Enterprise MCP server is not admitted for Streamable HTTP.")
  const admitted = {
    [admittedEnterpriseMcpServer]: true as const,
    id: reference.server,
    alias,
    url: sanitizeServer(server).url,
    transport: "streamable-http" as const,
    dns: {
      allowedCidrs: [...server.dns.allowedCidrs],
      denyLoopback: server.dns.denyLoopback,
      denyLinkLocal: server.dns.denyLinkLocal,
    },
    headers: {
      allowedNames: server.headers.allowedNames.map((name) => name.toLowerCase()).sort(),
      secretReferences: Object.entries(server.headers.values)
        .map(([header, value]) => ({
          header: header.toLowerCase(),
          source: value.source,
          name: value.name,
          format: value.format,
        }))
        .sort((a, b) => a.header.localeCompare(b.header)),
    },
    limits: { ...input.policy.limits },
  }
  Object.defineProperty(admitted, admittedEnterpriseMcpServer, { value: true, enumerable: false })
  admittedEnterpriseMcpServers.add(admitted)
  return deepFreeze(admitted)
}

export function isAdmittedEnterpriseMcpServer(value: unknown): value is AdmittedEnterpriseMcpServer {
  return typeof value === "object" && value !== null && admittedEnterpriseMcpServers.has(value)
}

export function diagnoseEnterpriseMcp(input: AdmissionInput) {
  const checks: DiagnosticCheck[] = [
    input.enterpriseMode
      ? pass("MCP_ENTERPRISE_MODE_ENABLED", "Enterprise mode is enabled.")
      : info("MCP_ENTERPRISE_MODE_DISABLED", "Enterprise mode is disabled; policy is diagnostic only."),
    info(
      input.policy?.mode === "connect" ? "MCP_CONNECTION_OPERATIONAL" : "MCP_OPERATIONALLY_DISABLED",
      input.policy?.mode === "connect"
        ? "Managed remote connection initialization is operational."
        : "Managed remote connection initialization is disabled.",
    ),
  ]
  const policyPresent = !!input.policy || input.unmanagedPolicySources.length > 0
  if (input.configurationInvalid)
    checks.push(fail("MCP_POLICY_MODE_UNSUPPORTED", "Configuration containing enterprise MCP data is invalid."))
  checks.push(
    policyPresent
      ? pass("MCP_POLICY_PRESENT", "Enterprise MCP policy is present.")
      : info("MCP_POLICY_MISSING", "No enterprise MCP policy is configured."),
  )
  if (input.policy && input.policySource) {
    checks.push(pass("MCP_POLICY_MANAGED", "Enterprise MCP policy came from managed configuration."))
    checks.push(
      pass(
        input.policySource.kind === "managed-preference"
          ? "MCP_POLICY_SOURCE_MANAGED_PREFERENCE"
          : "MCP_POLICY_SOURCE_MANAGED_FILE",
        "Policy provenance is administrator-managed.",
      ),
    )
    checks.push(
      pass(
        input.policy.mode === "connect" ? "MCP_POLICY_MODE_CONNECT" : "MCP_POLICY_MODE_DIAGNOSE",
        `Policy mode is ${input.policy.mode}.`,
      ),
    )
  } else if (input.unmanagedPolicySources.length > 0) {
    checks.push(fail("MCP_POLICY_NOT_MANAGED", "Enterprise MCP policy was supplied only by untrusted configuration."))
  }
  if (input.unmanagedPolicySources.length > 0)
    checks.push(
      warning(
        "MCP_POLICY_SOURCE_UNTRUSTED",
        input.policy
          ? "An untrusted policy attempt was ignored in favor of managed policy."
          : "Untrusted policy cannot authorize enterprise MCP.",
      ),
    )

  if (input.policy) {
    checks.push(...diagnoseLimits(input.policy.limits))
    const normalizedServers = new Map<string, string>()
    for (const [name, server] of Object.entries(input.policy.servers).sort((a, b) => a[0].localeCompare(b[0]))) {
      const normalized = normalizeName(name)
      const collided = normalizedServers.get(normalized)
      if (collided && collided !== name)
        checks.push(fail("MCP_NAME_COLLISION", `Managed server ${safe(name)} collides with ${safe(collided)}.`))
      else {
        normalizedServers.set(normalized, name)
        checks.push(pass("MCP_NAME_VALID", `Managed server ${safe(name)} has a unique namespace.`))
      }
      checks.push(...diagnoseServer(server))
    }
  }

  const names = input.requestedReference ? [input.requestedReference] : Object.keys(input.references).sort()
  const normalizedAliases = new Map<string, string>()
  const serverAliases = new Map<string, string>()
  const references = names.map((alias) => {
    const value = input.references[alias]
    const source = input.referenceSources[alias]
    const referenceChecks: DiagnosticCheck[] = [info("MCP_REFERENCE_DECLARED", `Reference ${safe(alias)} is selected.`)]
    if (!value) {
      referenceChecks.push(fail("MCP_REFERENCE_UNKNOWN", `Reference ${safe(alias)} is not configured.`))
      return referenceResult(alias, undefined, source, referenceChecks)
    }
    referenceChecks.push(referenceSourceCheck(source))
    if (!isManagedReference(value)) {
      referenceChecks.push(fail("MCP_DEFINITION_UNMANAGED", `Reference ${safe(alias)} is not a managed reference.`))
      return referenceResult(alias, undefined, source, referenceChecks)
    }
    if (Object.keys(value).some((key) => !["type", "server", "enabled"].includes(key)))
      referenceChecks.push(fail("MCP_REFERENCE_FIELDS_INVALID", "Managed reference contains prohibited fields."))
    const normalized = normalizeName(alias)
    const collided = normalizedAliases.get(normalized)
    if (collided && collided !== alias)
      referenceChecks.push(fail("MCP_NAME_COLLISION", `Alias collides with ${safe(collided)} after normalization.`))
    else {
      normalizedAliases.set(normalized, alias)
      referenceChecks.push(pass("MCP_NAME_VALID", "Reference name has a unique model namespace."))
    }
    const existingAlias = serverAliases.get(value.server)
    if (existingAlias && existingAlias !== alias)
      referenceChecks.push(fail("MCP_NAME_COLLISION", `Multiple aliases reference server ${safe(value.server)}.`))
    else serverAliases.set(value.server, alias)
    if (value.enabled === false) {
      referenceChecks.push(info("MCP_REFERENCE_DISABLED", "Reference is disabled."))
      referenceChecks.push(info("MCP_CONNECTION_DISABLED", "Managed connection is disabled for this reference."))
      return referenceResult(alias, value.server, source, referenceChecks)
    }
    if (!input.policy) {
      referenceChecks.push(fail("MCP_REFERENCE_UNKNOWN", "No managed policy can authorize this reference."))
      return referenceResult(alias, value.server, source, referenceChecks)
    }
    const managedSource = source?.kind === "managed-file" || source?.kind === "managed-preference"
    if (!managedSource && !input.policy.projectReferences)
      referenceChecks.push(fail("MCP_PROJECT_REFERENCES_PROHIBITED", "Policy prohibits non-managed references."))
    else
      referenceChecks.push(
        pass(
          "MCP_PROJECT_REFERENCES_ALLOWED",
          managedSource ? "Managed reference is allowed." : "Project references are allowed.",
        ),
      )
    const server = input.policy.servers[value.server]
    if (!server) {
      referenceChecks.push(fail("MCP_REFERENCE_UNKNOWN", `Managed server ${safe(value.server)} is unknown.`))
      return referenceResult(alias, value.server, source, referenceChecks)
    }
    referenceChecks.push(pass("MCP_SERVER_FOUND", "Managed server policy was found."))
    referenceChecks.push(pass("MCP_SERVER_KIND_REMOTE", "Server kind is remote."))
    if (server.enabled === false)
      referenceChecks.push(fail("MCP_SERVER_DISABLED", "Managed server policy is disabled."))
    referenceChecks.push(...diagnoseServer(server))
    if (!referenceChecks.some((check) => check.status === "fail"))
      referenceChecks.push(pass("MCP_REFERENCE_ALLOWED", "Reference passes Phase 1 admission diagnostics."))
    if (!referenceChecks.some((check) => check.status === "fail"))
      referenceChecks.push(
        input.policy.mode === "connect"
          ? pass("MCP_CONNECTION_ELIGIBLE", "Managed reference is eligible for connection initialization.")
          : info("MCP_CONNECTION_DISABLED", "Policy diagnose mode does not permit connection initialization."),
      )
    return referenceResult(alias, value.server, source, referenceChecks, sanitizeServer(server))
  })

  const all = checks.concat(references.flatMap((reference) => reference.checks))
  const errors = all.filter((check) => check.status === "fail").length
  const warnings = all.filter((check) => check.status === "warning").length
  return deepFreeze({
    checks,
    references,
    corrections: corrections(all),
    summary: {
      status: errors ? ("fail" as const) : ("pass" as const),
      errors,
      warnings,
      operationallyEnabled: input.enterpriseMode && input.policy?.mode === "connect" && !errors,
    },
  })
}

function diagnoseServer(server: ConfigMCPEnterprisePolicyV1.RemoteServer) {
  const checks: DiagnosticCheck[] = []
  checks.push(...diagnoseUrl(server.url))
  checks.push(
    server.dns.allowedCidrs.every(validCidr)
      ? pass("MCP_DNS_POLICY_VALID", "Declared CIDR syntax is valid; no DNS resolution was performed.")
      : fail("MCP_DNS_POLICY_INVALID", "One or more declared CIDRs are invalid."),
  )
  checks.push(
    server.transport === "streamable-http"
      ? pass("MCP_TRANSPORT_PINNED", "Transport is pinned to streamable-http.")
      : fail("MCP_TRANSPORT_UNSUPPORTED", "SSE is not admitted in Phase 1."),
  )
  checks.push(
    server.redirects === "deny"
      ? pass("MCP_REDIRECT_POLICY_SAFE", "Redirects are denied.")
      : fail("MCP_REDIRECT_POLICY_UNSAFE", "Redirect policy is unsafe."),
  )
  checks.push(
    server.oauth.allowed === false
      ? pass("MCP_OAUTH_PROHIBITED", "OAuth is prohibited.")
      : fail("MCP_OAUTH_UNSAFE", "OAuth must be prohibited in Phase 1."),
  )
  const allowed = new Set<string>()
  for (const name of server.headers.allowedNames) {
    const normalized = name.toLowerCase()
    if (!headerName(name) || forbiddenHeader(normalized))
      checks.push(fail("MCP_HEADER_NOT_ALLOWED", `Header ${safe(normalized)} is categorically forbidden or invalid.`))
    else if (allowed.has(normalized))
      checks.push(fail("MCP_NAME_COLLISION", `Header ${safe(normalized)} is declared more than once.`))
    allowed.add(normalized)
  }
  const values = new Set(Object.keys(server.headers.values).map((name) => name.toLowerCase()))
  if (allowed.has("authorization") && !values.has("authorization"))
    checks.push(fail("MCP_SECRET_REFERENCE_INVALID", "Authorization has no typed value source."))
  const seenValues = new Set<string>()
  for (const [name, secret] of Object.entries(server.headers.values)) {
    const normalized = name.toLowerCase()
    if (seenValues.has(normalized))
      checks.push(fail("MCP_NAME_COLLISION", `Header ${safe(normalized)} has colliding values.`))
    seenValues.add(normalized)
    checks.push(
      headerName(name) && !forbiddenHeader(normalized) && allowed.has(normalized)
        ? pass("MCP_HEADER_ALLOWED", `Header ${safe(normalized)} is explicitly allowed.`)
        : fail("MCP_HEADER_NOT_ALLOWED", `Header ${safe(normalized)} is not allowed.`),
    )
    checks.push(
      secret.source === "environment" &&
        /^[A-Z_][A-Z0-9_]*$/.test(secret.name) &&
        ["Bearer", "Raw"].includes(secret.format)
        ? pass("MCP_SECRET_REFERENCE_VALID", `Header ${safe(normalized)} uses a valid environment reference.`)
        : fail("MCP_SECRET_REFERENCE_INVALID", `Header ${safe(normalized)} has an invalid secret reference.`),
    )
  }
  checks.push(pass("MCP_CAPABILITY_TOOLS_EXPLICIT", "Tool capability policy is explicit."))
  checks.push(
    server.capabilities.tools.names.length
      ? pass("MCP_TOOL_ALLOWLIST_PRESENT", "Tool allowlist is non-empty.")
      : warning("MCP_TOOL_ALLOWLIST_EMPTY", "Tool allowlist is empty."),
  )
  checks.push(pass("MCP_DYNAMIC_TOOL_POLICY_PRESENT", "Dynamic tool changes require re-admission."))
  const tools = new Map<string, string>()
  for (const name of server.capabilities.tools.names) {
    const normalized = normalizeName(name)
    const existing = tools.get(normalized)
    if (existing && existing !== name)
      checks.push(fail("MCP_NAME_COLLISION", `Tool ${safe(name)} collides with ${safe(existing)} after normalization.`))
    else tools.set(normalized, name)
  }
  checks.push(pass("MCP_CAPABILITY_RESOURCES_EXPLICIT", "Resources are explicitly denied."))
  checks.push(pass("MCP_CAPABILITY_PROMPTS_EXPLICIT", "Prompts are explicitly denied."))
  checks.push(pass("MCP_CAPABILITY_INSTRUCTIONS_EXPLICIT", "Server instructions are explicitly denied."))
  checks.push(pass("MCP_CAPABILITY_LOGGING_EXPLICIT", "Logging policy is explicit."))
  return checks
}

function diagnoseUrl(value: string) {
  const checks: DiagnosticCheck[] = [pass("MCP_URL_PRESENT", "An exact server URL is declared.")]
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value))
    return checks.concat(fail("MCP_URL_INVALID", "URL contains whitespace or control characters."))
  if (/\{[^}]+\}|\$\{[^}]+\}/.test(value))
    return checks.concat(fail("MCP_URL_INVALID", "URL contains an unresolved placeholder."))
  if (value.startsWith("//")) return checks.concat(fail("MCP_URL_INVALID", "Protocol-relative URLs are prohibited."))
  try {
    const url = new URL(value)
    if (!url.hostname) checks.push(fail("MCP_URL_INVALID", "URL hostname is missing."))
    if (url.protocol !== "http:" && url.protocol !== "https:")
      checks.push(fail("MCP_URL_SCHEME_REJECTED", "Only HTTP and HTTPS URLs are supported."))
    if (url.username || url.password)
      checks.push(fail("MCP_URL_CREDENTIALS_REJECTED", "URL credentials are prohibited."))
    if (url.search) checks.push(fail("MCP_URL_QUERY_REJECTED", "URL query values are prohibited."))
    if (url.hash) checks.push(fail("MCP_URL_FRAGMENT_REJECTED", "URL fragments are prohibited."))
  } catch {
    checks.push(fail("MCP_URL_INVALID", "URL is invalid."))
  }
  return checks
}

function diagnoseLimits(limits: ConfigMCPEnterprisePolicyV1.Info["limits"]) {
  return Object.entries(limits).map(([name, value]) =>
    Number.isSafeInteger(value) && value >= 0
      ? pass("MCP_LIMIT_VALID", `Limit ${safe(name)} is valid.`)
      : fail("MCP_LIMIT_OUT_OF_RANGE", `Limit ${safe(name)} is out of range.`),
  )
}

function sanitizeServer(server: ConfigMCPEnterprisePolicyV1.RemoteServer) {
  let normalizedUrl = "invalid"
  try {
    const url = new URL(server.url)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    url.hostname = url.hostname.toLowerCase()
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "")
    normalizedUrl = url.toString()
  } catch {}
  return {
    kind: server.kind,
    url: normalizedUrl,
    transport: server.transport,
    redirects: server.redirects,
    oauth: { allowed: false as const },
    headerNames: server.headers.allowedNames.map((name) => name.toLowerCase()).sort(),
    secretReferences: Object.entries(server.headers.values)
      .map(([header, value]) => ({
        header: header.toLowerCase(),
        source: value.source,
        name: value.name,
        format: value.format,
      }))
      .sort((a, b) => a.header.localeCompare(b.header)),
    capabilities: server.capabilities,
    runtime: server.runtime,
  }
}

function referenceResult(
  alias: string,
  server: string | undefined,
  source: MCPConfigSource | undefined,
  checks: DiagnosticCheck[],
  constraints?: ReturnType<typeof sanitizeServer>,
) {
  return {
    alias: safe(alias),
    server: server ? safe(server) : undefined,
    source,
    status: checks.some((check) => check.status === "fail") ? ("fail" as const) : ("pass" as const),
    checks,
    constraints,
  }
}

function referenceSourceCheck(source?: MCPConfigSource): DiagnosticCheck {
  if (!source) return warning("MCP_REFERENCE_SOURCE_GLOBAL", "Reference provenance is unavailable.")
  const codes: Partial<Record<MCPConfigSource["kind"], DiagnosticCode>> = {
    project: "MCP_REFERENCE_SOURCE_PROJECT",
    global: "MCP_REFERENCE_SOURCE_GLOBAL",
    inline: "MCP_REFERENCE_SOURCE_INLINE",
    "custom-config": "MCP_REFERENCE_SOURCE_CUSTOM_CONFIG",
    "custom-config-directory": "MCP_REFERENCE_SOURCE_CUSTOM_CONFIG",
    "managed-file": "MCP_REFERENCE_SOURCE_MANAGED",
    "managed-preference": "MCP_REFERENCE_SOURCE_MANAGED",
  }
  return info(codes[source.kind] ?? "MCP_REFERENCE_SOURCE_GLOBAL", `Reference source is ${source.kind}.`)
}

function corrections(checks: DiagnosticCheck[]) {
  const map: Partial<Record<DiagnosticCode, string>> = {
    MCP_POLICY_NOT_MANAGED: "Move enterprise.mcp policy into administrator-managed configuration.",
    MCP_REFERENCE_UNKNOWN: "Reference an ID declared by the managed enterprise MCP policy.",
    MCP_DEFINITION_UNMANAGED: "Replace local or remote MCP configuration with a narrow managed reference.",
    MCP_PROJECT_REFERENCES_PROHIBITED:
      "Ask an administrator to allow project references or declare the reference in managed configuration.",
    MCP_TRANSPORT_UNSUPPORTED: "Pin the managed server to streamable-http for the planned remote phase.",
    MCP_NAME_COLLISION: "Choose unique aliases and one alias per managed server.",
  }
  return [...new Set(checks.flatMap((check) => (check.status === "fail" && map[check.code] ? [map[check.code]!] : [])))]
}

function isManagedReference(value: Reference): value is ConfigMCPV1.Managed {
  return typeof value === "object" && value !== null && "type" in value && value.type === "managed"
}

function normalizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()
}
function safe(value: string) {
  return value.replace(/[\r\n\t]/g, " ").slice(0, 256)
}
function headerName(value: string) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
}
function forbiddenHeader(value: string) {
  return new Set([
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "proxy-authorization",
    "cookie",
    "set-cookie",
  ]).has(value)
}
function validCidr(value: string) {
  const parts = value.split("/")
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return false
  const prefix = Number(parts[1])
  if (parts[0].includes(":")) return /^[0-9a-f:]+$/i.test(parts[0]) && prefix >= 0 && prefix <= 128
  const octets = parts[0].split(".")
  return (
    octets.length === 4 &&
    octets.every((item) => /^\d+$/.test(item) && Number(item) <= 255) &&
    prefix >= 0 &&
    prefix <= 32
  )
}
function pass(code: DiagnosticCode, message: string): DiagnosticCheck {
  return { code, status: "pass", message }
}
function fail(code: DiagnosticCode, message: string): DiagnosticCheck {
  return { code, status: "fail", message }
}
function info(code: DiagnosticCode, message: string): DiagnosticCheck {
  return { code, status: "info", message }
}
function warning(code: DiagnosticCode, message: string): DiagnosticCheck {
  return { code, status: "warning", message }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") Object.values(value).forEach(deepFreeze)
  return value && typeof value === "object" ? Object.freeze(value) : value
}
