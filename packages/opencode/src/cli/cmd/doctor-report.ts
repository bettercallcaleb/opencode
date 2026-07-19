import path from "path"
import { existsSync } from "fs"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import {
  diagnoseEnterpriseProviderPolicy,
  diagnoseEnterpriseBaseURL,
  type EnterpriseProviderPolicyCheck,
} from "@opencode-ai/core/provider/enterprise"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { parseModel } from "@/provider/provider"

export type DoctorCheck = EnterpriseProviderPolicyCheck

type Source = { path: string; exists: boolean }

export type DoctorVllmReport = ReturnType<typeof buildDoctorVllmReport>

export function buildDoctorVllmReport(input: {
  cwd: string
  directory: string
  worktree: string
  config: ConfigV1.Info
  configDirectories?: string[]
  runtimeProviderIDs: string[]
  requestedProvider?: string
  generatedAt?: string
  enterpriseMode?: boolean
  enterpriseBaseURL?: string
}) {
  const configuredIDs = Object.keys(input.config.provider ?? {}).sort()
  const defaultModel = input.config.model
  const parsedDefault = defaultModel ? parseModel(defaultModel) : undefined
  const selected = input.requestedProvider
    ? [input.requestedProvider]
    : parsedDefault?.providerID
      ? [parsedDefault.providerID]
      : configuredIDs.length === 1
        ? configuredIDs
        : configuredIDs
  const enterpriseMode = input.enterpriseMode ?? Flag.OPENCODE_ENTERPRISE_MODE
  const enterpriseBaseURL = input.enterpriseBaseURL ?? Flag.OPENCODE_ENTERPRISE_VLLM_BASE_URL
  const runtimeChecks: DoctorCheck[] = [
    enterpriseMode
      ? { code: "ENTERPRISE_MODE_ENABLED", status: "pass", message: "Enterprise mode is enabled." }
      : { code: "ENTERPRISE_MODE_DISABLED", status: "fail", message: "Enterprise mode is disabled." },
    ...diagnoseEnterpriseBaseURL(enterpriseBaseURL),
  ]
  if (configuredIDs.length === 0 && !input.requestedProvider && !parsedDefault)
    runtimeChecks.push({
      code: "PROVIDER_NOT_DECLARED",
      status: "fail",
      message: "No configured provider is available to diagnose.",
    })

  const providers = selected.map((providerID) => {
    const provider = input.config.provider?.[providerID]
    if (!provider) {
      return {
        id: providerID,
        status: "fail" as const,
        checks: [
          {
            code: "PROVIDER_NOT_DECLARED",
            status: "fail" as const,
            message: `Provider ${providerID} is not declared.`,
          },
          {
            code: "PROVIDER_MISSING_FROM_RUNTIME",
            status: "fail" as const,
            message: "Provider is absent from the runtime provider list.",
          },
        ],
        models: [] as string[],
        authentication: "missing" as const,
      }
    }
    const enabled = input.config.enabled_providers
    const disabled = input.config.disabled_providers?.includes(providerID) ?? false
    const excluded = enabled !== undefined && !enabled.includes(providerID)
    const baseURL =
      typeof provider.options?.baseURL === "string"
        ? provider.options.baseURL.replace(/\$\{([^}]+)\}/g, (match, key) => process.env[String(key)] ?? match)
        : undefined
    const policy = diagnoseEnterpriseProviderPolicy({
      npm: provider.npm,
      baseURL,
      models: provider.models,
      allowedBaseURL: enterpriseBaseURL,
    })
    const visible = input.runtimeProviderIDs.includes(providerID)
    const checks: DoctorCheck[] = [
      { code: "PROVIDER_DECLARED", status: "pass", message: `Provider ${providerID} is declared.` },
      disabled
        ? { code: "PROVIDER_DISABLED", status: "fail", message: "Provider is listed in disabled_providers." }
        : excluded
          ? {
              code: "PROVIDER_NOT_IN_ENABLED_LIST",
              status: "fail",
              message: "Provider is not listed in enabled_providers.",
            }
          : { code: "PROVIDER_ENABLED", status: "pass", message: "Provider is enabled by configuration." },
      ...policy.checks,
      policy.allowed
        ? { code: "PROVIDER_ADMITTED", status: "pass", message: "Provider passes enterprise admission policy." }
        : { code: "PROVIDER_REJECTED", status: "fail", message: "Provider fails enterprise admission policy." },
      visible
        ? {
            code: "PROVIDER_VISIBLE_IN_RUNTIME",
            status: "pass",
            message: "Provider is visible in the production runtime list.",
          }
        : {
            code: "PROVIDER_MISSING_FROM_RUNTIME",
            status: "fail",
            message: "Provider is absent from the production runtime list.",
          },
    ]
    return {
      id: providerID,
      status: checks.some((check) => check.status === "fail") ? ("fail" as const) : ("pass" as const),
      checks,
      models: Object.keys(provider.models ?? {}).sort(),
      authentication:
        typeof provider.options?.apiKey !== "string"
          ? ("missing" as const)
          : /\$\{[^}]+\}|\{env:[^}]+\}/.test(provider.options.apiKey)
            ? ("configured through an environment placeholder" as const)
            : ("configured directly in config" as const),
    }
  })

  const defaultChecks: DoctorCheck[] = []
  if (!defaultModel || !parsedDefault) {
    defaultChecks.push({
      code: "DEFAULT_MODEL_CONFIGURED",
      status: "warning",
      message: "No default model is configured.",
    })
  } else {
    defaultChecks.push({
      code: "DEFAULT_MODEL_CONFIGURED",
      status: "pass",
      message: "A default model is configured.",
      actual: defaultModel,
    })
    const provider = input.config.provider?.[parsedDefault.providerID]
    if (input.requestedProvider && parsedDefault.providerID !== input.requestedProvider) {
      defaultChecks.push({
        code: "DEFAULT_MODEL_PROVIDER_MISMATCH",
        status: "fail",
        message: "Default model belongs to a different provider.",
        actual: parsedDefault.providerID,
        expected: input.requestedProvider,
      })
    } else if (!provider) {
      defaultChecks.push({
        code: "DEFAULT_MODEL_PROVIDER_MISMATCH",
        status: "fail",
        message: "Default model provider is not declared.",
        actual: parsedDefault.providerID,
      })
    } else {
      const model = provider.models?.[parsedDefault.modelID]
      defaultChecks.push(
        model
          ? {
              code: "DEFAULT_MODEL_FOUND",
              status: "pass",
              message: "Default model key exists.",
              actual: parsedDefault.modelID,
              detail: { apiModelID: model.id ?? parsedDefault.modelID },
            }
          : {
              code: "DEFAULT_MODEL_NOT_FOUND",
              status: "fail",
              message: "Default model key does not exist.",
              actual: parsedDefault.modelID,
              detail: {
                availableModels: Object.keys(provider.models ?? {})
                  .sort()
                  .join(", "),
              },
            },
      )
    }
  }

  const allChecks = [...runtimeChecks, ...providers.flatMap((provider) => provider.checks), ...defaultChecks]
  const errors = allChecks.filter((check) => check.status === "fail").length
  const warnings = allChecks.filter((check) => check.status === "warning").length
  const source = (value: string): Source => ({ path: value, exists: existsSync(value) })
  const managedDirs = ["/etc/opencode", path.join(process.env.ProgramData || "C:\\ProgramData", "opencode")].filter(
    (item, index, items) => items.indexOf(item) === index,
  )
  return {
    schemaVersion: 1 as const,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    binary: { version: InstallationVersion, platform: process.platform, arch: process.arch },
    runtime: { enterpriseMode, checks: runtimeChecks },
    configuration: {
      cwd: input.cwd,
      projectDirectory: input.directory,
      worktree: input.worktree,
      global: ["config", "config.json", "opencode.json", "opencode.jsonc"].map((file) =>
        source(path.join(Global.Path.config, file)),
      ),
      customConfig: Flag.OPENCODE_CONFIG ? source(Flag.OPENCODE_CONFIG) : undefined,
      configContentSet: Boolean(Flag.OPENCODE_CONFIG_CONTENT),
      project: ["opencode.json", "opencode.jsonc"].map((file) => source(path.join(input.worktree, file))),
      configDirectories: (input.configDirectories ?? []).flatMap((directory) =>
        ["opencode.json", "opencode.jsonc"].map((file) => source(path.join(directory, file))),
      ),
      customConfigDirectory: Flag.OPENCODE_CONFIG_DIR,
      managed: managedDirs.flatMap((directory) =>
        ["opencode.json", "opencode.jsonc"].map((file) => source(path.join(directory, file))),
      ),
      defaultModel,
      configuredProviderIDs: configuredIDs,
      enabledProviderIDs: input.config.enabled_providers?.slice().sort(),
      disabledProviderIDs: input.config.disabled_providers?.slice().sort() ?? [],
    },
    providers,
    defaultModel: {
      configured: defaultModel,
      providerID: parsedDefault?.providerID,
      modelID: parsedDefault?.modelID,
      checks: defaultChecks,
    },
    summary: { status: errors === 0 ? ("pass" as const) : ("fail" as const), errors, warnings },
  }
}

export function suggestedCorrections(report: DoctorVllmReport) {
  const codes = new Set(
    report.runtime.checks
      .concat(
        report.providers.flatMap((provider) => provider.checks),
        report.defaultModel.checks,
      )
      .map((check) => check.code),
  )
  return [
    codes.has("ENTERPRISE_MODE_DISABLED") && "Set OPENCODE_ENTERPRISE_MODE=1 before starting OpenCode.",
    codes.has("ENTERPRISE_BASE_URL_MISSING") && "Set OPENCODE_ENTERPRISE_VLLM_BASE_URL.",
    (codes.has("PROVIDER_NPM_MISSING") || codes.has("PROVIDER_NPM_MISMATCH")) &&
      "Change provider npm to @ai-sdk/openai-compatible.",
    codes.has("PROVIDER_MODELS_EMPTY") && "Add at least one explicit model.",
    [...codes].some((code) => code.startsWith("BASE_URL_") && code.endsWith("_MISMATCH")) &&
      "Make options.baseURL match the enterprise base URL.",
    codes.has("PROVIDER_BASE_URL_QUERY_REJECTED") && "Remove query parameters from the base URL.",
    codes.has("PROVIDER_DISABLED") && "Remove the provider from disabled_providers.",
    codes.has("PROVIDER_NOT_IN_ENABLED_LIST") && "Add the provider to enabled_providers.",
  ].filter((item): item is string => Boolean(item))
}

export function formatDoctorVllmReport(report: DoctorVllmReport, verbose = false) {
  const lines = ["OpenCode vLLM Doctor", "", `Overall result: ${report.summary.status.toUpperCase()}`, "", "Runtime"]
  const format = (check: DoctorCheck) =>
    `  ${check.status.toUpperCase()} [${check.code}] ${check.message}${verbose && check.actual ? ` Actual: ${check.actual}` : ""}${verbose && check.expected ? ` Expected: ${check.expected}` : ""}`
  lines.push(...report.runtime.checks.map(format), "", "Configuration sources")
  lines.push(
    `  Working directory: ${report.configuration.cwd}`,
    `  Project root: ${report.configuration.worktree}`,
    `  OPENCODE_CONFIG_CONTENT: ${report.configuration.configContentSet ? "set" : "not set"}`,
    `  Configured providers: ${report.configuration.configuredProviderIDs.join(", ") || "none"}`,
    `  Enabled providers: ${report.configuration.enabledProviderIDs?.join(", ") ?? "all"}`,
    `  Disabled providers: ${report.configuration.disabledProviderIDs.join(", ") || "none"}`,
  )
  if (report.configuration.customConfig)
    lines.push(
      `  ${report.configuration.customConfig.exists ? "FOUND" : "MISSING"} OPENCODE_CONFIG ${report.configuration.customConfig.path}`,
    )
  if (report.configuration.customConfigDirectory)
    lines.push(`  OPENCODE_CONFIG_DIR ${report.configuration.customConfigDirectory}`)
  for (const item of [
    ...report.configuration.global,
    ...report.configuration.project,
    ...report.configuration.configDirectories,
    ...report.configuration.managed,
  ])
    lines.push(`  ${item.exists ? "FOUND" : "MISSING"} ${item.path}`)
  for (const provider of report.providers) {
    const visibility = provider.checks.filter((check) =>
      ["PROVIDER_VISIBLE_IN_RUNTIME", "PROVIDER_MISSING_FROM_RUNTIME"].includes(check.code),
    )
    lines.push(
      "",
      `Provider: ${provider.id}`,
      ...provider.checks.filter((check) => !visibility.includes(check)).map(format),
      "",
      "Runtime visibility",
      ...visibility.map(format),
    )
  }
  lines.push("", "Default model", ...report.defaultModel.checks.map(format), "", "Suggested corrections")
  const suggestions = suggestedCorrections(report)
  lines.push(...(suggestions.length ? suggestions.map((item) => `  - ${item}`) : ["  None."]))
  return lines.join("\n") + "\n"
}
