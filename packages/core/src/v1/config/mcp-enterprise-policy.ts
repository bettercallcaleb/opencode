export * as ConfigMCPEnterprisePolicyV1 from "./mcp-enterprise-policy"

import { Schema } from "effect"

const bounded = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

export const SecretReference = Schema.Struct({
  source: Schema.Literal("environment"),
  name: Schema.String,
  format: Schema.Literals(["Bearer", "Raw"]),
})

const DeniedCapability = Schema.Struct({ mode: Schema.Literal("deny") })

export const RemoteServer = Schema.Struct({
  kind: Schema.Literal("remote"),
  enabled: Schema.optional(Schema.Boolean),
  url: Schema.String,
  transport: Schema.Literals(["streamable-http", "sse"]),
  redirects: Schema.Literal("deny"),
  dns: Schema.Struct({
    allowedCidrs: Schema.mutable(Schema.Array(Schema.String)),
    denyLoopback: Schema.Boolean,
    denyLinkLocal: Schema.Boolean,
  }),
  headers: Schema.Struct({
    allowedNames: Schema.mutable(Schema.Array(Schema.String)),
    values: Schema.Record(Schema.String, SecretReference),
  }),
  oauth: Schema.Struct({ allowed: Schema.Literal(false) }),
  capabilities: Schema.Struct({
    tools: Schema.Struct({
      mode: Schema.Literal("allowlist"),
      names: Schema.mutable(Schema.Array(Schema.String)),
      dynamicChanges: Schema.Literal("readmit"),
    }),
    resources: DeniedCapability,
    prompts: DeniedCapability,
    instructions: DeniedCapability,
    logging: Schema.Struct({ mode: Schema.Literals(["deny", "metadata-only"]) }),
  }),
  runtime: Schema.Struct({
    connect: Schema.Literals(["deny", "startup-only"]),
    disconnect: Schema.Literals(["deny", "allow"]),
  }),
})
export type RemoteServer = Schema.Schema.Type<typeof RemoteServer>

export const Limits = Schema.Struct({
  connectTimeoutMs: bounded(100, 120_000),
  requestTimeoutMs: bounded(100, 120_000),
  responseHeaderTimeoutMs: bounded(100, 120_000),
  streamInactivityTimeoutMs: bounded(100, 120_000),
  maxRequestBytes: bounded(1_024, 16 * 1_024 * 1_024),
  maxHeaderBytes: bounded(1_024, 128 * 1_024),
  maxStreamFrameBytes: bounded(1_024, 8 * 1_024 * 1_024),
  maxResponseBytes: bounded(1_024, 16 * 1_024 * 1_024),
  maxTextBytes: bounded(1_024, 8 * 1_024 * 1_024),
  maxSchemaBytes: bounded(1_024, 2 * 1_024 * 1_024),
  maxToolListPages: bounded(1, 100),
  maxToolListTotalBytes: bounded(1_024, 64 * 1_024 * 1_024),
  maxCursorBytes: bounded(1, 16 * 1_024),
  maxToolNameBytes: bounded(1, 1_024),
  maxToolDescriptionBytes: bounded(1, 64 * 1_024),
  maxToolDefinitionBytes: bounded(1_024, 4 * 1_024 * 1_024),
  maxToolCatalogBytes: bounded(1_024, 32 * 1_024 * 1_024),
  maxToolSchemaDepth: bounded(1, 128),
  maxToolSchemaEntries: bounded(1, 100_000),
  maxToolSchemaArrayItems: bounded(1, 100_000),
  maxListItems: bounded(1, 10_000),
  maxAttachments: bounded(0, 100),
  maxAttachmentBytes: bounded(1_024, 50 * 1_024 * 1_024),
  maxAttachmentTotalBytes: bounded(1_024, 100 * 1_024 * 1_024),
})

export const Info = Schema.Struct({
  mode: Schema.Literals(["diagnose", "connect", "catalog"]),
  projectReferences: Schema.Boolean,
  audit: Schema.Struct({
    mode: Schema.Literals(["off", "decisions"]),
    includeArguments: Schema.Boolean,
    includeOutput: Schema.Boolean,
  }),
  limits: Limits,
  servers: Schema.Record(Schema.String, RemoteServer),
}).annotate({ identifier: "EnterpriseMcpPolicy", parseOptions: { onExcessProperty: "error" } })
export type Info = Schema.Schema.Type<typeof Info>
