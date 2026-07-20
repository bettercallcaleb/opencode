import dns from "node:dns"
import net from "node:net"
import tls from "node:tls"
import http from "node:http"
import https from "node:https"
import childProcess from "node:child_process"

const blocked = (name: string) => () => {
  throw new Error(`doctor network guard blocked ${name}`)
}

Object.assign(dns, {
  lookup: blocked("dns.lookup"),
  resolve: blocked("dns.resolve"),
})
Object.assign(dns.promises, {
  lookup: blocked("dns.promises.lookup"),
  resolve: blocked("dns.promises.resolve"),
})
Object.assign(net, {
  connect: blocked("net.connect"),
  createConnection: blocked("net.createConnection"),
})
Object.assign(tls, { connect: blocked("tls.connect") })
Object.assign(http, { request: blocked("http.request"), get: blocked("http.get") })
Object.assign(https, { request: blocked("https.request"), get: blocked("https.get") })
Object.assign(childProcess, {
  spawn: blocked("child_process.spawn"),
  exec: blocked("child_process.exec"),
  execFile: blocked("child_process.execFile"),
  fork: blocked("child_process.fork"),
})
Object.defineProperties(globalThis, {
  fetch: { configurable: true, value: blocked("fetch") },
  WebSocket: { configurable: true, value: blocked("WebSocket") },
  EventSource: { configurable: true, value: blocked("EventSource") },
})
