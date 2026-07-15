export function isLoopbackServerURL(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (url.username || url.password) return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (host === "localhost" || host === "::1") return true
    const parts = host.split(".")
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false
    const octets = parts.map(Number)
    return octets.every((part) => part >= 0 && part <= 255) && octets[0] === 127
  } catch {
    return false
  }
}
