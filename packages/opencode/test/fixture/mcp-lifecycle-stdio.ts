import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
if (pidFile) await Bun.write(pidFile, String(process.pid))

if (process.argv.includes("--hang")) {
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  await new Promise(() => {})
}

const server = new Server({ name: "mcp-lifecycle-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "current_directory",
        description: process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
      ...(process.argv.includes("--callable")
        ? [
            {
              name: "local_sentinel",
              description: "Return the local lifecycle sentinel",
              inputSchema: { type: "object" as const, properties: {} },
            },
          ]
        : []),
    ],
  }),
)

server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
  if (params.name !== "local_sentinel") throw new Error(`Unknown tool: ${params.name}`)
  return Promise.resolve({ content: [{ type: "text" as const, text: "LOCAL_MCP_OK" }] })
})

await server.connect(new StdioServerTransport())
