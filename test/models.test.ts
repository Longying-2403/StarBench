import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { fetchModelInfo, parseModelInfo } from '../src/main/models.ts'

// What DeepSeek's model list returned on 2026-11-21, trimmed.
const deepseek = [
  {
    id: 'deepseek-flash',
    object: 'model',
    owned_by: 'deepseek',
    name: 'DeepSeek-V4.1-Flash',
    context_window: 1048576,
    effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' }
  },
  { id: 'deepseek-v4-pro', object: 'model', name: 'DeepSeek-V4-Pro', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }
]

test('parseModelInfo keeps the name and the thinking levels it knows', () => {
  assert.deepEqual(parseModelInfo(deepseek[0]), {
    name: 'DeepSeek-V4.1-Flash',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high'
  })
  assert.deepEqual(parseModelInfo({ id: 'x', display_name: '  Some Model  ' }), { name: 'Some Model' })
  // Levels the app cannot send are dropped; "default" is the app's own word, not a level.
  assert.deepEqual(parseModelInfo({ id: 'x', effort: { supported_levels: ['minimal', 'low', 'default', 7], default_level: 'medium' } }), {
    efforts: ['low']
  })
  // A plain OpenAI-style entry has nothing the app can use.
  assert.equal(parseModelInfo({ id: 'gpt-x', object: 'model', owned_by: 'someone' }), null)
  assert.equal(parseModelInfo({ id: 'x', name: '   ', effort: 'high' }), null)
  assert.equal(parseModelInfo(null), null)
  assert.equal(parseModelInfo('deepseek-flash'), null)
})

/** Serves `body` with `status` for every request and records the paths and keys it saw. */
async function fakeService(status: number, body: unknown) {
  const seen: { url?: string; authorization?: string }[] = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization })
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { seen, baseURL, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('fetchModelInfo finds the configured model in the service list', async () => {
  const service = await fakeService(200, { object: 'list', data: deepseek })
  const connection = { apiKey: 'test-key', baseURL: service.baseURL }
  assert.equal((await fetchModelInfo({ ...connection, model: 'deepseek-v4-pro' }))?.name, 'DeepSeek-V4-Pro')
  assert.equal(await fetchModelInfo({ ...connection, model: 'not-in-the-list' }), null)
  await service.close()
  assert.deepEqual(service.seen[0], { url: '/models', authorization: 'Bearer test-key' })
})

test('fetchModelInfo rejects when the service has no model list', async () => {
  const missing = await fakeService(404, { error: { message: 'not found' } })
  await assert.rejects(fetchModelInfo({ apiKey: 'k', baseURL: missing.baseURL, model: 'm' }))
  await missing.close()

  // A list in an unexpected shape is "nothing known", not a crash.
  const odd = await fakeService(200, { models: ['a', 'b'] })
  assert.equal(await fetchModelInfo({ apiKey: 'k', baseURL: odd.baseURL, model: 'a' }), null)
  await odd.close()
})
