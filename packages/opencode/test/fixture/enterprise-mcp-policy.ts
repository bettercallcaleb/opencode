export const enterpriseMcpPolicy = {
  mode: "diagnose" as const,
  projectReferences: true,
  audit: { mode: "decisions" as const, includeArguments: false, includeOutput: false },
  limits: {
    connectTimeoutMs: 10_000, requestTimeoutMs: 30_000, maxResponseBytes: 2_097_152,
    maxTextBytes: 1_048_576, maxSchemaBytes: 262_144, maxListItems: 500, maxAttachments: 4,
    maxAttachmentBytes: 10_485_760, maxAttachmentTotalBytes: 20_971_520,
  },
  servers: {
    "source-control": {
      kind: "remote" as const,
      url: "https://MCP.corp.example/api/mcp/",
      transport: "streamable-http" as const,
      redirects: "deny" as const,
      dns: { allowedCidrs: ["10.20.0.0/16"], denyLoopback: true, denyLinkLocal: true },
      headers: {
        allowedNames: ["authorization", "x-correlation-id"],
        values: {
          authorization: { source: "environment" as const, name: "CORP_MCP_TOKEN", format: "Bearer" as const },
        },
      },
      oauth: { allowed: false as const },
      capabilities: {
        tools: { mode: "allowlist" as const, names: ["search_repositories"], dynamicChanges: "readmit" as const },
        resources: { mode: "deny" as const }, prompts: { mode: "deny" as const },
        instructions: { mode: "deny" as const }, logging: { mode: "metadata-only" as const },
      },
      runtime: { connect: "startup-only" as const, disconnect: "allow" as const },
    },
  },
}
