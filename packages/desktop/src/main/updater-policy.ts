export type DesktopChannel = "dev" | "beta" | "prod"

export function isTruthyEnvironmentValue(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true"
}

export function isDesktopUpdaterEnabled(input: {
  packaged: boolean
  channel: DesktopChannel
  enterpriseMode: boolean
}) {
  return input.packaged && input.channel !== "dev" && !input.enterpriseMode
}
