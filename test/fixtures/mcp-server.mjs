// A tiny MCP server for tests. Speaks stdio by default; `--http <port>` serves streamable HTTP instead.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import http from 'node:http'

function createServer() {
  const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'add',
        description: 'Add two numbers',
        inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
      },
      { name: 'env', description: 'Read FIXTURE_VALUE from the environment', inputSchema: { type: 'object' } },
      { name: 'argv', description: 'Return the command line arguments the server was started with', inputSchema: { type: 'object' } },
      { name: 'fail', description: 'Always reports an error', inputSchema: { type: 'object' } },
      { name: 'weird name!', inputSchema: { type: 'object' } }
    ]
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params
    if (name === 'add') return { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] }
    if (name === 'env') return { content: [{ type: 'text', text: process.env.FIXTURE_VALUE ?? '(unset)' }] }
    if (name === 'argv') return { content: [{ type: 'text', text: JSON.stringify(process.argv.slice(2)) }] }
    if (name === 'fail') return { content: [{ type: 'text', text: 'it broke' }], isError: true }
    return { content: [{ type: 'image', data: '', mimeType: 'image/png' }, { type: 'text', text: 'after image' }] }
  })
  return server
}

const httpFlag = process.argv.indexOf('--http')
if (httpFlag === -1) {
  await createServer().connect(new StdioServerTransport())
} else {
  // Stateless mode: a fresh server and transport per request.
  http
    .createServer(async (req, res) => {
      if (req.headers['x-test-auth'] !== 'secret') return void res.writeHead(401).end('unauthorized')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => void transport.close())
      await createServer().connect(transport)
      await transport.handleRequest(req, res, body)
    })
    .listen(Number(process.argv[httpFlag + 1]), '127.0.0.1', () => console.error('listening'))
}
