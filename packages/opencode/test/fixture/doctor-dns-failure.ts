import dns from "node:dns/promises"
import net from "node:net"
import tls from "node:tls"

const blocked = (name: string) => () => {
  throw new Error(`doctor DNS fixture blocked ${name}`)
}

Object.assign(dns, {
  lookup: async () => {
    const error = new Error("controlled DNS failure") as Error & { code: string }
    error.code = "ENOTFOUND"
    throw error
  },
})
Object.assign(net, { createConnection: blocked("net.createConnection") })
Object.assign(tls, { connect: blocked("tls.connect") })
Object.defineProperty(globalThis, "fetch", { configurable: true, value: blocked("fetch") })
