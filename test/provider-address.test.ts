// Run with: node --test test/provider-address.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as model from '../src/main/settings-model.ts'

/** Settings with a provider of one's own, "Mine", whose key is stored for DeepSeek's address. */
function withKey(): model.StoredSettings {
  return model.saveProvider(model.readSettings(null), { name: 'Mine', kind: 'openai-chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'OLD-KEY')
}
const mine = (settings: model.StoredSettings): model.StoredProvider | undefined => settings.providers.find((p) => p.name === 'Mine')

test('a stored key stays with the host it was given for', () => {
  const settings = withKey()
  const id = mine(settings)!.id
  const moveTo = (baseURL: string, key?: string): string | undefined =>
    mine(model.saveProvider(settings, { id, name: 'Mine', kind: 'openai-chat', baseURL, model: '' }, key))?.encryptedKey

  // Another path, or another kind of interface, on the same host keeps it.
  assert.equal(moveTo('https://api.deepseek.com/v1'), 'OLD-KEY')
  assert.equal(mine(model.saveProvider(settings, { id, name: 'Mine', kind: 'anthropic', baseURL: 'https://api.deepseek.com/anthropic', model: '' }))?.encryptedKey, 'OLD-KEY')
  // Another host does not get it: say, a relay from a tutorial. A key given for that host is stored.
  assert.equal(moveTo('https://relay.example.com/v1'), undefined)
  assert.equal(moveTo('https://relay.example.com/v1', 'NEW-KEY'), 'NEW-KEY')
  // The port is part of the host.
  assert.equal(moveTo('https://api.deepseek.com:8443'), undefined)
})

test('no key is saved for an address that plain http would expose it on', () => {
  const settings = withKey()
  const id = mine(settings)!.id
  // The key kept on the same host, now over http; a new key for such an address; neither is saved.
  assert.throws(() => model.saveProvider(settings, { id, name: 'Mine', kind: 'openai-chat', baseURL: 'http://api.deepseek.com', model: '' }), { message: model.KEY_NEEDS_HTTPS })
  assert.throws(() => model.saveProvider(settings, { name: 'Other', kind: 'openai-chat', baseURL: 'http://relay.example.com/v1', model: '' }, 'KEY'), { message: model.KEY_NEEDS_HTTPS })
  // Without a key such an address is saved: there is nothing to give away.
  const keyless = model.saveProvider(settings, { name: 'Open', kind: 'openai-chat', baseURL: 'http://models.example.com/v1', model: '' })
  assert.equal(keyless.providers.find((p) => p.name === 'Open')?.encryptedKey, undefined)
  // Moved to another host over http, the provider leaves its key behind and is saved.
  assert.equal(mine(model.saveProvider(settings, { id, name: 'Mine', kind: 'openai-chat', baseURL: 'http://relay.example.com/v1', model: '' }))?.encryptedKey, undefined)
  // To this computer, and to a local-network address written as a number, http is as good as it gets.
  for (const local of ['http://localhost:11434/v1', 'http://192.168.1.20:8000/v1', 'http://100.101.102.103:8000/v1', 'http://[fd00::5]:8000/v1']) {
    const saved = model.saveProvider(settings, { id, name: 'Mine', kind: 'openai-chat', baseURL: local, model: '' }, 'LOCAL-KEY')
    assert.equal(mine(saved)?.encryptedKey, 'LOCAL-KEY', local)
  }
  // A name, even one of the local network, could be answered for by another machine on a shared network.
  for (const named of ['http://gpu-box:8000/v1', 'http://nas.lan:8000/v1', 'http://box.local/v1', 'http://srv.internal/v1']) {
    assert.throws(() => model.saveProvider(settings, { id, name: 'Mine', kind: 'openai-chat', baseURL: named, model: '' }, 'LOCAL-KEY'), { message: model.KEY_NEEDS_HTTPS }, named)
  }
})

test('what keeps a saved key from being used is said to the person in the language of the app, with what to do about it', () => {
  // Shown in the conversation when a message or a compaction is begun, in the list of models, and where the provider is saved.
  for (const said of [model.KEY_NEEDS_HTTPS, model.KEY_UNREADABLE]) {
    assert.match(said, /^\p{Script=Han}/u, said)
    assert.match(said, /在设置里/, said)
  }
  // An address over plain http: the reasons and the way out that the settings page gives under such an address.
  assert.match(model.KEY_NEEDS_HTTPS, /^这个服务的地址用的是 http:\/\/，又不是本机或局域网的 IP 地址，所以 API Key 不会发往这里，也不会为它保存：/)
  assert.match(model.KEY_NEEDS_HTTPS, /Key 会明文经过网络，按名字找到的电脑也可能被同一网络里的其他电脑冒充。请在设置里把地址改成 https:\/\/；局域网里的服务器可以改填它的 IP 地址。$/)
  // A key this computer cannot decrypt is typed in again.
  assert.match(model.KEY_UNREADABLE, /^保存的 API Key 在这台电脑上解不开（设置可能是从别的电脑或别的 Windows 用户拷过来的）。/)
  assert.match(model.KEY_UNREADABLE, /重新填写这个服务的 API Key。$/)
})

test('a key is sent over https, or over http to this computer or a local-network IP address', () => {
  for (const address of ['https://api.deepseek.com', 'https://gpu-box:8443/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:8000', 'http://10.0.0.5/v1', 'http://[::1]:8000', 'http://[fe80::1]/v1']) {
    assert.equal(model.sendsKeySafely(address), true, address)
  }
  for (const address of ['http://api.deepseek.com', 'http://relay.example.com/v1', 'http://8.8.8.8/v1', 'http://gpu-box:8000/v1', 'http://box.local/v1', 'http://nas.lan/v1', 'http://app.localhost/v1', 'ftp://example.com', 'not an address']) {
    assert.equal(model.sendsKeySafely(address), false, address)
  }
})
