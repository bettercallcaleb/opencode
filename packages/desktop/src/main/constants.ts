import { app } from "electron"
import { isDesktopUpdaterEnabled, isTruthyEnvironmentValue, type DesktopChannel } from "./updater-policy"

const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: DesktopChannel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"
export const ENTERPRISE_MODE = isTruthyEnvironmentValue(process.env.OPENCODE_ENTERPRISE_MODE)

export const UPDATER_ENABLED = isDesktopUpdaterEnabled({
  packaged: app.isPackaged,
  channel: CHANNEL,
  enterpriseMode: ENTERPRISE_MODE,
})
