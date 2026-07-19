import type { Argv } from "yargs"
import { Effect } from "effect"
import { CliError, effectCmd } from "../effect-cmd"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { InstanceRef } from "@/effect/instance-ref"
import { Flag } from "@opencode-ai/core/flag/flag"
import { buildDoctorVllmReport, formatDoctorVllmReport } from "./doctor-report"

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
      .option("verbose", { type: "boolean", describe: "include detailed sanitized values" }),
  handler: Effect.fn("Cli.doctor.vllm")(function* (args: {
    provider?: string
    json?: boolean
    output?: string
    verbose?: boolean
  }) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    const config = yield* Config.Service
    const provider = Flag.OPENCODE_ENTERPRISE_MODE ? yield* Provider.Service : undefined
    const effective = yield* config.get()
    const report = buildDoctorVllmReport({
      cwd: process.cwd(),
      directory: ctx.directory,
      worktree: ctx.worktree,
      config: effective,
      configDirectories: yield* config.directories(),
      runtimeProviderIDs: provider ? Object.keys(yield* provider.list()) : [],
      requestedProvider: args.provider,
    })
    const json = JSON.stringify(report, null, 2) + "\n"
    if (args.output) yield* Effect.promise(() => Bun.write(args.output!, json))
    process.stdout.write(args.json ? json : formatDoctorVllmReport(report, args.verbose))
    if (report.summary.status === "fail") process.exitCode = 1
  }),
})

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
