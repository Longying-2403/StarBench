// Where an API key, or a token in the headers of a remote MCP server, may be sent. Over https it
// may go anywhere. Over plain http it crosses the network as it is, so only to this computer, or to
// a local-network address written as a number: a name could be answered for by another machine on
// a shared network (on a café's Wi-Fi, a name without a dot or one ending in .local is looked up by
// asking everyone around), and the key would go to whoever answered.
// Nothing in this file depends on Electron.

/** The loopback, private, link-local and shared (100.64/10) ranges of IPv4. */
function localIPv4(host: string): boolean {
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!ip) return false
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

/** Whether a key may be sent to an address: the base URL of a model service, or the URL of a remote MCP server. */
export function sendsKeySafely(address: string): boolean {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost') return true
  // IPv6, written in brackets: this computer, a unique local address, or one of the link.
  if (host.startsWith('[')) return /^\[(::1|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*)\]$/.test(host)
  return localIPv4(host)
}
