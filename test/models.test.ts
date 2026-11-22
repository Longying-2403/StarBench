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

test('parseModelInfo keeps the name, the thinking levels it knows, and the size of the context', () => {
  assert.deepEqual(parseModelInfo(deepseek[0]), {
    name: 'DeepSeek-V4.1-Flash',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    contextWindow: 1048576
  })
  assert.deepEqual(parseModelInfo(deepseek[1]), { name: 'DeepSeek-V4-Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }, 'an entry that does not say it has none')
  // Each service has its own name for the size of the context; a size that is no size is not kept.
  assert.deepEqual(parseModelInfo({ id: 'x', context_length: 131072 }), { contextWindow: 131072 })
  assert.deepEqual(parseModelInfo({ id: 'x', max_model_len: 32768, name: 'Qwen' }), { name: 'Qwen', contextWindow: 32768 })
  assert.deepEqual(parseModelInfo({ id: 'x', max_context_length: 8192 }), { contextWindow: 8192 })
  for (const odd of ['128000', 0, -1, 12.5, 1e12, null]) assert.equal(parseModelInfo({ id: 'x', context_window: odd }), null, String(odd))
  assert.deepEqual(parseModelInfo({ id: 'x', display_name: '  Some Model  ' }), { name: 'Some Model' })
  // Levels the app does not know are dropped; "default" is the app's own word, not a level.
  assert.deepEqual(parseModelInfo({ id: 'x', effort: { supported_levels: ['turbo', 'low', 'default', 7, 'xhigh'], default_level: 'ultra' } }), {
    efforts: ['low', 'xhigh']
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
