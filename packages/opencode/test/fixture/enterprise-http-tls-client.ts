import type { ConfigMCPEnterprisePolicyV1 } from "@opencode-ai/core/v1/config/mcp-enterprise-policy"
import { createEnterpriseMcpFetch, EnterpriseMcpHttpError } from "../../src/mcp/enterprise-http"
import { admitEnterpriseMcpHttpServer } from "../../src/mcp/enterprise-policy"
import { enterpriseMcpPolicy } from "./enterprise-mcp-policy"

const endpoint = process.argv[2]
if (!endpoint) throw new Error("TLS endpoint is required")
const policy: ConfigMCPEnterprisePolicyV1.Info = {
  ...enterpriseMcpPolicy,
  servers: {
    tls: {
      ...enterpriseMcpPolicy.servers["source-control"],
      url: endpoint,
      dns: { allowedCidrs: ["127.0.0.0/8"], denyLoopback: false, denyLinkLocal: true },
      headers: { allowedNames: [], values: {} },
    },
  },
}
const admitted = admitEnterpriseMcpHttpServer(
  {
    enterpriseMode: true,
    policy,
    policySource: { kind: "managed-file", source: "/test/managed/opencode.json" },
    unmanagedPolicySources: [],
    references: { tls: { type: "managed", server: "tls" } },
    referenceSources: { tls: { kind: "managed-file", source: "/test/managed/opencode.json" } },
    platform: process.platform,
  },
  "tls",
)

try {
  const response = await createEnterpriseMcpFetch(admitted, {
    environment: {},
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  })(endpoint)
  console.log(`ok:${await response.text()}`)
} catch (error) {
  if (error instanceof EnterpriseMcpHttpError) console.log(`error:${error.code}`)
  else throw error
}
