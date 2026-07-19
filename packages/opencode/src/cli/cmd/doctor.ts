import type { Argv } from "yargs"
import { Effect } from "effect"
import { CliError, effectCmd } from "../effect-cmd"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { InstanceRef } from "@/effect/instance-ref"
import { Flag } from "@opencode-ai/core/flag/flag"
import { buildDoctorVllmReport, formatDoctorVllmReport } from "./doctor-report"
import {
  formatVllmProbe,
  runVllmProbe,
  type ProbeLevel,
  type SDKObservation,
  type VllmProbeReport,
} from "./doctor-probe"
import { streamText } from "ai"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { withEnterpriseInferenceObserver } from "@opencode-ai/core/provider/enterprise"
import type { InstanceContext } from "@/project/instance-context"

export const DoctorVllmCommand = effectCmd({
  command: "vllm [provider]",
  describe: "diagnose static enterprise vLLM provider admission",
  readOnly: true,
  internalErrorExitCode: 2,
  builder: (yargs: Argv) =>
    yargs
      .positional("provider", { type: "string", describe: "configured provider ID" })
      .option("json", { type: "boolean", describe: "print only JSON" })
      .option("output", { type: "string", describe: "write the complete JSON report to a file" })
      .option("verbose", { type: "boolean", describe: "include detailed sanitized values" })
      .option("probe", { type: "boolean", describe: "actively probe the admitted enterprise endpoint" })
      .option("probe-level", {
        type: "string",
        choices: ["transport", "api", "sdk", "full"] as const,
        default: "full" as const,
        describe: "active probe depth",
      })
      .option("timeout", {
        type: "number",
        default: 10_000,
        describe: "timeout in milliseconds for each probe operation",
      })
      .check((args) => {
        if (args.timeout < 100 || args.timeout > 120_000 || !Number.isInteger(args.timeout))
          throw new Error("timeout must be an integer between 100 and 120000 milliseconds")
        return true
      }),
  handler: Effect.fn("Cli.doctor.vllm")(function* (args: {
    provider?: string
    json?: boolean
    output?: string
    verbose?: boolean
    probe?: boolean
    "probe-level": ProbeLevel
    timeout: number
  }) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    const config = yield* Config.Service
    const provider = Flag.OPENCODE_ENTERPRISE_MODE ? yield* Provider.Service : undefined
    const effective = yield* config.get()
    const phaseOne = buildDoctorVllmReport({
      cwd: process.cwd(),
      directory: ctx.directory,
      worktree: ctx.worktree,
      config: effective,
      configDirectories: yield* config.directories(),
      runtimeProviderIDs: provider ? Object.keys(yield* provider.list()) : [],
      requestedProvider: args.provider,
    })
    const probe = args.probe
      ? yield* Effect.promise(() =>
          buildProbe({
            report: phaseOne,
            config: effective,
            provider,
            level: args["probe-level"],
            timeoutMs: args.timeout,
            ctx,
          }),
        )
      : undefined
    const report = { ...phaseOne, probe }
    const json = JSON.stringify(report, null, 2) + "\n"
    if (args.output) yield* Effect.promise(() => Bun.write(args.output!, json))
    process.stdout.write(
      args.json ? json : formatDoctorVllmReport(phaseOne, args.verbose) + (probe ? formatVllmProbe(probe) : ""),
    )
    if (phaseOne.summary.status === "fail" || probe?.summary.status === "fail") process.exitCode = 1
  }),
})

async function buildProbe(input: {
  report: ReturnType<typeof buildDoctorVllmReport>
  config: Parameters<typeof buildDoctorVllmReport>[0]["config"]
  provider: Provider.Interface | undefined
  level: ProbeLevel
  timeoutMs: number
  ctx: InstanceContext
}): Promise<VllmProbeReport> {
  const selected = input.report.providers[0]
  const unsafe = new Set([
    "ENTERPRISE_MODE_DISABLED",
    "ENTERPRISE_BASE_URL_MISSING",
    "ENTERPRISE_BASE_URL_INVALID",
    "PROVIDER_NOT_DECLARED",
    "PROVIDER_REJECTED",
    "PROVIDER_BASE_URL_MISSING",
    "PROVIDER_BASE_URL_INVALID",
    "PROVIDER_BASE_URL_UNRESOLVED",
    "PROVIDER_BASE_URL_CREDENTIALS_REJECTED",
    "PROVIDER_BASE_URL_QUERY_REJECTED",
    "PROVIDER_BASE_URL_HASH_REJECTED",
    "PROVIDER_BASE_URL_SCHEME_REJECTED",
    "BASE_URL_SCHEME_MISMATCH",
    "BASE_URL_HOST_MISMATCH",
    "BASE_URL_PORT_MISMATCH",
    "BASE_URL_PATH_MISMATCH",
  ])
  const codes = new Set(input.report.runtime.checks.concat(selected?.checks ?? []).map((check) => check.code))
  const baseURL = Flag.OPENCODE_ENTERPRISE_VLLM_BASE_URL
  if (!selected || !baseURL || [...codes].some((code) => unsafe.has(code))) {
    return {
      version: 1,
      level: input.level,
      target: { scheme: "unknown", hostname: "unknown", effectivePort: 0, path: "" },
      environment: {
        platform: process.platform,
        arch: process.arch,
        hostname: "not resolved",
        endpoint: { scheme: "unknown", hostname: "unknown", effectivePort: 0, path: "" },
        proxies: {},
        certificates: {
          NODE_EXTRA_CA_CERTS: { set: false, pathExists: false },
          SSL_CERT_FILE: { set: false, pathExists: false },
          SSL_CERT_DIR: { set: false, pathExists: false },
        },
        authentication: {
          apiKey: "missing",
          authorizationHeader: false,
          customHeaderNames: [],
        },
      },
      stages: [
        {
          id: "admission",
          status: "fail",
          checks: [
            {
              code: "PROBE_SKIPPED_UNSAFE_TARGET",
              status: "fail",
              message: "Active probing was skipped because Phase 1 could not establish a safe admitted target.",
            },
          ],
          categories: ["unknown"],
        },
      ],
      summary: { status: "fail", firstFailureStage: "admission", errorCategories: ["unknown"] },
    }
  }
  const configured = input.config.provider?.[selected.id]
  const defaultModel = input.report.defaultModel
  const modelKey = defaultModel.providerID === selected.id ? defaultModel.modelID : selected.models[0]
  const modelConfig = modelKey ? configured?.models?.[modelKey] : undefined
  const apiModelID = modelConfig?.id ?? modelKey
  if (!configured || !apiModelID) throw new Error("probe model could not be resolved")
  const options = configured.options ?? {}
  const headers =
    options.headers && typeof options.headers === "object" && !Array.isArray(options.headers)
      ? Object.fromEntries(
          Object.entries(options.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : undefined
  return runVllmProbe({
    level: input.level,
    timeoutMs: input.timeoutMs,
    baseURL,
    apiModelID,
    apiKey: typeof options.apiKey === "string" ? options.apiKey : undefined,
    headers,
    toolCallSupported: modelConfig?.tool_call !== false,
    sdk:
      input.provider && modelKey
        ? (signal) => sdkProbe(input.provider!, selected.id, modelKey, input.ctx, signal)
        : undefined,
  })
}

async function sdkProbe(
  provider: Provider.Interface,
  providerID: string,
  modelID: string,
  ctx: InstanceContext,
  signal: AbortSignal,
) {
  const observation: SDKObservation = {}
  return withEnterpriseInferenceObserver(
    {
      request(request, init) {
        const body = typeof init?.body === "string" ? init.body : ""
        let parsed: Record<string, unknown> = {}
        try {
          const value = JSON.parse(body)
          if (value && typeof value === "object" && !Array.isArray(value)) parsed = value
        } catch {}
        const url = new URL(request instanceof Request ? request.url : request.toString())
        observation.request = {
          method: init?.method ?? (request instanceof Request ? request.method : "GET"),
          url: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`,
          headerNames: [...new Headers(init?.headers).keys()].sort(),
          fields: Object.keys(parsed).sort(),
          nestedFields: Object.entries(parsed)
            .flatMap(([key, value]) =>
              value && typeof value === "object" && !Array.isArray(value)
                ? Object.keys(value).map((nested) => `${key}.${nested}`)
                : [],
            )
            .sort(),
          fieldTypes: Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [key, Array.isArray(value) ? "array" : typeof value]),
          ),
          bodyBytes: Buffer.byteLength(body),
          bodySha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
        }
      },
      async response(value) {
        const response = value as Response
        const body = await response.text()
        observation.response = {
          status: response.status,
          contentType: response.headers.get("content-type") ?? undefined,
          bodyBytes: Buffer.byteLength(body),
          bodySha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
        }
      },
    },
    async () => {
      try {
        const model = await Effect.runPromise(
          provider
            .getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))
            .pipe(Effect.provideService(InstanceRef, ctx)),
        ).catch(() => {
          observation.resolutionFailure = "model"
          return undefined
        })
        if (!model) return { text: "", observation }
        const language = await Effect.runPromise(
          provider.getLanguage(model).pipe(Effect.provideService(InstanceRef, ctx)),
        ).catch(() => {
          observation.resolutionFailure = "provider"
          return undefined
        })
        if (!language) return { text: "", observation }
        const result = streamText({
          model: language,
          prompt: "Reply with exactly: OPENCODE_SDK_OK",
          temperature: 0,
          maxOutputTokens: 32,
          maxRetries: 0,
          abortSignal: signal,
          onError() {},
        })
        return { text: await result.text, observation }
      } catch {
        return { text: "", observation }
      }
    },
  )
}

export const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "diagnostic tools",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(DoctorVllmCommand)
      .demandCommand()
      .fail((message, error) => {
        if (error) throw error
        throw new CliError({ message: message || "Invalid doctor command", exitCode: 2 })
      }),
  handler: Effect.fn("Cli.doctor")(function* () {}),
})
