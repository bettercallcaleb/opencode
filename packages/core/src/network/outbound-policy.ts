import { assertEnterpriseRequestURL, parseEnterpriseVllmBaseURL } from "../provider/enterprise"

export const OUTBOUND_NETWORK_ERROR = "Outbound network access is disabled in enterprise mode"

export class OutboundNetworkPolicyError extends Error {
  constructor() {
    super(OUTBOUND_NETWORK_ERROR)
    this.name = "OutboundNetworkPolicyError"
  }
}

export function isEnterpriseEnvironmentValue(value: string | undefined) {
  const normalized = value?.toLowerCase()
  return normalized === "1" || normalized === "true"
}

export function isLoopbackHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "::1") return true
  const parts = host.split(".")
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false
  const octets = parts.map(Number)
  return octets.every((part) => part >= 0 && part <= 255) && octets[0] === 127
}

export function assertEnterpriseOutboundDisabled(enterpriseMode: boolean) {
  if (enterpriseMode) throw new OutboundNetworkPolicyError()
}

function parseURL(value: string | URL | Request) {
  const raw = value instanceof Request ? value.url : value.toString()
  if (raw.startsWith("//")) throw new OutboundNetworkPolicyError()
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:")
      throw new OutboundNetworkPolicyError()
    if (url.username || url.password) throw new OutboundNetworkPolicyError()
    return url
  } catch (error) {
    if (error instanceof OutboundNetworkPolicyError) throw error
    throw new OutboundNetworkPolicyError()
  }
}

export function assertEnterpriseOutboundURL(
  value: string | URL | Request,
  input: {
    enterpriseMode: boolean
    purpose: "vllm" | "local-opencode" | "same-origin" | "forbidden"
    vllmBaseURL?: string
    sameOrigin?: string
    allowLocalhost?: boolean
  },
) {
  const url = parseURL(value)
  if (!input.enterpriseMode) return url

  if (input.purpose === "vllm") {
    if (!parseEnterpriseVllmBaseURL(input.vllmBaseURL)) throw new OutboundNetworkPolicyError()
    try {
      return assertEnterpriseRequestURL(url, input.vllmBaseURL)
    } catch {
      throw new OutboundNetworkPolicyError()
    }
  }

  if (input.purpose === "local-opencode") {
    if (isLoopbackHost(url.hostname)) return url
    if (input.allowLocalhost && url.hostname.toLowerCase() === "localhost") return url
    throw new OutboundNetworkPolicyError()
  }

  if (input.purpose === "same-origin" && input.sameOrigin) {
    const origin = parseURL(input.sameOrigin)
    if (url.origin === origin.origin) return url
  }

  throw new OutboundNetworkPolicyError()
}
