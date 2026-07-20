import { listEnterpriseMcpTools, type EnterpriseMcpConnection } from "./enterprise-connection"
import type { AdmittedEnterpriseMcpServer } from "./enterprise-policy"

export type EnterpriseMcpCatalogCode =
  | "MCP_TOOL_CATALOG_DISCOVERY_FAILED"
  | "MCP_TOOL_REQUIRED_MISSING"
  | "MCP_TOOL_DUPLICATE"
  | "MCP_TOOL_SCHEMA_INVALID"
  | "MCP_TOOL_SCHEMA_TOO_LARGE"
  | "MCP_TOOL_SCHEMA_TOO_DEEP"
  | "MCP_TOOL_SCHEMA_TOO_MANY_ENTRIES"
  | "MCP_TOOL_SCHEMA_ARRAY_TOO_LARGE"
  | "MCP_TOOL_NAME_INVALID"
  | "MCP_TOOL_DESCRIPTION_TOO_LARGE"
  | "MCP_TOOL_DEFINITION_TOO_LARGE"
  | "MCP_TOOL_CATALOG_TOO_LARGE"
  | "MCP_TOOL_LIST_TOO_LARGE"
  | "MCP_TOOL_LIST_TOTAL_TOO_LARGE"
  | "MCP_TOOL_LIST_PAGE_LIMIT"
  | "MCP_TOOL_LIST_CURSOR_INVALID"
  | "MCP_TOOL_LIST_CURSOR_LOOP"
  | "MCP_NAME_COLLISION"

export class EnterpriseMcpCatalogError extends Error {
  override readonly name = "EnterpriseMcpCatalogError"

  constructor(readonly code: EnterpriseMcpCatalogCode) {
    super(`[${code}] ${message(code)}`)
  }
}

export type EnterpriseMcpToolDefinition = Readonly<{
  serverID: string
  referenceAlias: string
  rawName: string
  futureToolID: string
  description?: string
  inputSchema: Readonly<Record<string, unknown>>
  outputSchema?: Readonly<Record<string, unknown>>
  definitionFingerprint: string
}>

export type EnterpriseMcpCatalog = Readonly<{
  tools: readonly EnterpriseMcpToolDefinition[]
  admittedCount: number
  rejectedCount: number
  expectedCount: number
  serializedBytes: number
  resultCode: "MCP_TOOL_CATALOG_DISCOVERY_PASS"
}>

const catalogs = new WeakSet<object>()

export function isEnterpriseMcpCatalog(value: unknown): value is EnterpriseMcpCatalog {
  return typeof value === "object" && value !== null && catalogs.has(value)
}

export async function discoverEnterpriseMcpCatalog(
  connection: EnterpriseMcpConnection,
  admitted: AdmittedEnterpriseMcpServer,
  signal?: AbortSignal,
  hooks: Readonly<{
    afterPage?: (page: number) => Promise<void>
    afterValidation?: () => Promise<void>
    afterConstruction?: () => Promise<void>
    beforeStorage?: () => Promise<void>
  }> = {},
): Promise<EnterpriseMcpCatalog> {
  const advertised: { name: string; value: unknown }[] = []
  const cursors = new Set<string>()
  const names = new Set<string>()
  const normalized = new Set<string>()
  const allowed = new Set(admitted.tools)
  let receivedBytes = 0
  let cursor: string | undefined

  for (let page = 0; ; page++) {
    requireActive(signal)
    if (page >= admitted.limits.maxToolListPages) throw new EnterpriseMcpCatalogError("MCP_TOOL_LIST_PAGE_LIMIT")
    const result = await listEnterpriseMcpTools(
      connection,
      admitted,
      cursor,
      admitted.limits.requestTimeoutMs,
      signal,
    ).catch(() => {
      throw new EnterpriseMcpCatalogError("MCP_TOOL_CATALOG_DISCOVERY_FAILED")
    })
    requireActive(signal)
    for (const value of result.tools) {
      receivedBytes += measureJson(
        value,
        admitted.limits.maxToolListTotalBytes - receivedBytes,
        "MCP_TOOL_LIST_TOTAL_TOO_LARGE",
      )
      if (receivedBytes > admitted.limits.maxToolListTotalBytes)
        throw new EnterpriseMcpCatalogError("MCP_TOOL_LIST_TOTAL_TOO_LARGE")
      const name = requireToolName(value, admitted)
      if (names.has(name)) throw new EnterpriseMcpCatalogError("MCP_TOOL_DUPLICATE")
      names.add(name)
      const normalizedName = normalize(name)
      if (normalized.has(normalizedName)) throw new EnterpriseMcpCatalogError("MCP_NAME_COLLISION")
      normalized.add(normalizedName)
      advertised.push({ name, value })
      if (advertised.length > admitted.limits.maxListItems)
        throw new EnterpriseMcpCatalogError("MCP_TOOL_LIST_TOO_LARGE")
    }
    await hooks.afterPage?.(page)
    requireActive(signal)
    if (result.nextCursor === undefined) break
    validateCursor(result.nextCursor, admitted)
    if (cursors.has(result.nextCursor)) throw new EnterpriseMcpCatalogError("MCP_TOOL_LIST_CURSOR_LOOP")
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }

  if ([...allowed].some((name) => !names.has(name))) throw new EnterpriseMcpCatalogError("MCP_TOOL_REQUIRED_MISSING")
  const selected = advertised.filter((tool) => allowed.has(tool.name))
  const tools = selected
    .map((tool) => projectTool(tool.value, admitted))
    .sort((a, b) => a.futureToolID.localeCompare(b.futureToolID))
  if (new Set(tools.map((tool) => tool.futureToolID)).size !== tools.length)
    throw new EnterpriseMcpCatalogError("MCP_NAME_COLLISION")
  await hooks.afterValidation?.()
  requireActive(signal)
  const serializedBytes = tools.reduce(
    (total, tool) =>
      total + measureJson(tool, admitted.limits.maxToolCatalogBytes - total, "MCP_TOOL_CATALOG_TOO_LARGE"),
    0,
  )
  if (serializedBytes > admitted.limits.maxToolCatalogBytes)
    throw new EnterpriseMcpCatalogError("MCP_TOOL_CATALOG_TOO_LARGE")
  const catalog = deepFreeze({
    tools,
    admittedCount: tools.length,
    rejectedCount: advertised.length - tools.length,
    expectedCount: allowed.size,
    serializedBytes,
    resultCode: "MCP_TOOL_CATALOG_DISCOVERY_PASS" as const,
  })
  catalogs.add(catalog)
  await hooks.afterConstruction?.()
  requireActive(signal)
  await hooks.beforeStorage?.()
  requireActive(signal)
  return catalog
}

function projectTool(value: unknown, admitted: AdmittedEnterpriseMcpServer): EnterpriseMcpToolDefinition {
  const name = requireToolName(value, admitted)
  if (!value || typeof value !== "object") throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
  const description = "description" in value ? value.description : undefined
  if (
    description !== undefined &&
    (typeof description !== "string" || Buffer.byteLength(description) > admitted.limits.maxToolDescriptionBytes)
  )
    throw new EnterpriseMcpCatalogError("MCP_TOOL_DESCRIPTION_TOO_LARGE")
  if (!("inputSchema" in value)) throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
  const inputSchema = cloneSchema(value.inputSchema, admitted)
  const outputSchema =
    "outputSchema" in value && value.outputSchema !== undefined ? cloneSchema(value.outputSchema, admitted) : undefined
  const definition = {
    serverID: admitted.id,
    referenceAlias: admitted.alias,
    rawName: name,
    futureToolID: futureToolID(admitted.alias, name),
    ...(description === undefined ? {} : { description }),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
  }
  const canonical = canonicalJson(definition, admitted.limits.maxToolDefinitionBytes, "MCP_TOOL_DEFINITION_TOO_LARGE")
  return deepFreeze({
    ...definition,
    definitionFingerprint: new Bun.CryptoHasher("sha256").update(canonical).digest("hex"),
  })
}

function requireToolName(value: unknown, admitted: AdmittedEnterpriseMcpServer) {
  if (
    !value ||
    typeof value !== "object" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !value.name ||
    /[\u0000-\u001f\u007f]/.test(value.name) ||
    Buffer.byteLength(value.name) > admitted.limits.maxToolNameBytes
  )
    throw new EnterpriseMcpCatalogError("MCP_TOOL_NAME_INVALID")
  return value.name
}

function validateCursor(cursor: string, admitted: AdmittedEnterpriseMcpServer) {
  if (/[\u0000-\u001f\u007f]/.test(cursor) || Buffer.byteLength(cursor) > admitted.limits.maxCursorBytes)
    throw new EnterpriseMcpCatalogError("MCP_TOOL_LIST_CURSOR_INVALID")
}

function cloneSchema(value: unknown, admitted: AdmittedEnterpriseMcpServer) {
  const state = { entries: 0, seen: new Set<object>() }
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > admitted.limits.maxToolSchemaDepth) throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_TOO_DEEP")
    if (item === null || typeof item === "string" || typeof item === "boolean") return item
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
      return item
    }
    if (typeof item !== "object") throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
    if (state.seen.has(item)) throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
    state.seen.add(item)
    try {
      if (Array.isArray(item)) {
        if (item.length > admitted.limits.maxToolSchemaArrayItems)
          throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_ARRAY_TOO_LARGE")
        state.entries += item.length
        requireSchemaEntries(state.entries, admitted)
        return item.map((entry) => visit(entry, depth + 1))
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
      const keys = Object.keys(item)
      state.entries += keys.length
      requireSchemaEntries(state.entries, admitted)
      for (const key in item)
        if (!Object.hasOwn(item, key)) throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
      return Object.fromEntries(
        keys.sort().map((key) => {
          if (["__proto__", "prototype", "constructor"].includes(key))
            throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
          const child = Reflect.get(item, key)
          if (key === "$ref") throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
          if (key === "$id" && typeof child === "string" && URL.canParse(child))
            throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
          return [key, visit(child, depth + 1)]
        }),
      )
    } catch (error) {
      if (error instanceof EnterpriseMcpCatalogError) throw error
      throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
    } finally {
      state.seen.delete(item)
    }
  }
  const schema = visit(value, 1)
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || !("type" in schema) || schema.type !== "object")
    throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
  canonicalJson(schema, admitted.limits.maxSchemaBytes, "MCP_TOOL_SCHEMA_TOO_LARGE")
  return deepFreeze(schema as Record<string, unknown>)
}

function requireSchemaEntries(entries: number, admitted: AdmittedEnterpriseMcpServer) {
  if (entries > admitted.limits.maxToolSchemaEntries)
    throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_TOO_MANY_ENTRIES")
}

function measureJson(value: unknown, limit: number, overflow: EnterpriseMcpCatalogCode) {
  return Buffer.byteLength(canonicalJson(value, limit, overflow))
}

function canonicalJson(value: unknown, limit: number, overflow: EnterpriseMcpCatalogCode) {
  const seen = new Set<object>()
  let bytes = 0
  const append = (value: string) => {
    bytes += Buffer.byteLength(value)
    if (bytes > limit) throw new EnterpriseMcpCatalogError(overflow)
    return value
  }
  const visit = (item: unknown): string => {
    if (item === null || typeof item === "boolean" || typeof item === "string") return append(JSON.stringify(item))
    if (typeof item === "number" && Number.isFinite(item)) return append(JSON.stringify(item))
    if (typeof item !== "object") throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
    if (seen.has(item)) throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
    seen.add(item)
    try {
      if (Array.isArray(item)) {
        const parts = item.flatMap((value, index) => (index ? [append(","), visit(value)] : [visit(value)]))
        return append("[") + parts.join("") + append("]")
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
      for (const key in item)
        if (!Object.hasOwn(item, key)) throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
      return (
        append("{") +
        Object.keys(item)
          .sort()
          .flatMap((key, index) => [
            ...(index ? [append(",")] : []),
            append(JSON.stringify(key)),
            append(":"),
            visit(Reflect.get(item, key)),
          ])
          .join("") +
        append("}")
      )
    } catch (error) {
      if (error instanceof EnterpriseMcpCatalogError) throw error
      throw new EnterpriseMcpCatalogError("MCP_TOOL_SCHEMA_INVALID")
    } finally {
      seen.delete(item)
    }
  }
  return visit(value)
}

function requireActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new EnterpriseMcpCatalogError("MCP_TOOL_CATALOG_DISCOVERY_FAILED")
}

function normalize(value: string) {
  return value.normalize("NFC").replace(/[^a-zA-Z0-9_-]/g, "_")
}

// This is the exact existing OpenCode MCP tool-name contract, kept local so the
// enterprise catalog cannot import normal tool conversion or execution code.
function futureToolID(alias: string, name: string) {
  return alias.replace(/[^a-zA-Z0-9_-]/g, "_") + "_" + name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

function message(code: EnterpriseMcpCatalogCode) {
  const messages: Record<EnterpriseMcpCatalogCode, string> = {
    MCP_TOOL_CATALOG_DISCOVERY_FAILED: "Managed tool catalog discovery failed.",
    MCP_TOOL_REQUIRED_MISSING: "A required managed tool was not advertised.",
    MCP_TOOL_DUPLICATE: "The server advertised a duplicate tool name.",
    MCP_TOOL_SCHEMA_INVALID: "A managed tool schema is invalid.",
    MCP_TOOL_SCHEMA_TOO_LARGE: "A managed tool schema exceeds its byte limit.",
    MCP_TOOL_SCHEMA_TOO_DEEP: "A managed tool schema exceeds its depth limit.",
    MCP_TOOL_SCHEMA_TOO_MANY_ENTRIES: "A managed tool schema exceeds its entry limit.",
    MCP_TOOL_SCHEMA_ARRAY_TOO_LARGE: "A managed tool schema array exceeds its item limit.",
    MCP_TOOL_NAME_INVALID: "A managed tool name is invalid.",
    MCP_TOOL_DESCRIPTION_TOO_LARGE: "A managed tool description exceeds its byte limit.",
    MCP_TOOL_DEFINITION_TOO_LARGE: "A managed tool definition exceeds its byte limit.",
    MCP_TOOL_CATALOG_TOO_LARGE: "The managed tool catalog exceeds its byte limit.",
    MCP_TOOL_LIST_TOO_LARGE: "The managed tool list exceeds its item limit.",
    MCP_TOOL_LIST_TOTAL_TOO_LARGE: "The managed tool list exceeds its total byte limit.",
    MCP_TOOL_LIST_PAGE_LIMIT: "The managed tool list exceeds its page limit.",
    MCP_TOOL_LIST_CURSOR_INVALID: "The managed tool list returned an invalid cursor.",
    MCP_TOOL_LIST_CURSOR_LOOP: "The managed tool list returned a cursor loop.",
    MCP_NAME_COLLISION: "Managed tool names collide after normalization.",
  }
  return messages[code]
}
