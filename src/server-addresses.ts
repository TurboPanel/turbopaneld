export type ServerAddresses = {
  privateIpv4: string[]
  privateIpv6: string[]
  publicIpv4: string[]
  publicIpv6: string[]
}

function isLoopbackIpv4(address: string): boolean {
  return address.startsWith('127.')
}

function isLoopbackIpv6(address: string): boolean {
  const lower = address.toLowerCase()
  return lower === '::1' || lower === '0:0:0:0:0:0:0:1'
}

function isLinkLocalIpv4(address: string): boolean {
  return address.startsWith('169.254.')
}

function isLinkLocalIpv6(address: string): boolean {
  return address.toLowerCase().startsWith('fe80:')
}

const VIRTUAL_INTERFACE = [
  /^lo$/,
  /^docker\d*$/,
  /^br-/,
  /^veth/,
  /^virbr/,
  /^tun\d*$/,
  /^tap\d*$/,
  /^wg\d*$/,
  /^cni/,
  /^flannel/,
  /^cali/,
  /^kube-/,
  /^tailscale/,
  /^ifb/,
  /^dummy/,
]

function isPhysicalInterface(name: string): boolean {
  return !VIRTUAL_INTERFACE.some((pattern) => pattern.test(name))
}

function parseIpv4Octets(address: string): [number, number, number, number] | null {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null
  }
  return octets as [number, number, number, number]
}

function isUsableIpv4(address: string): boolean {
  if (isLoopbackIpv4(address) || isLinkLocalIpv4(address)) return false

  const octets = parseIpv4Octets(address)
  if (!octets) return false

  const [a] = octets
  return a > 0 && a < 224
}

function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address)
  if (!octets) return false

  const [a, b] = octets
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function isPublicIpv4(address: string): boolean {
  return isUsableIpv4(address) && !isPrivateIpv4(address)
}

function isUsableIpv6(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0]
  if (isLoopbackIpv6(lower) || isLinkLocalIpv6(lower)) return false
  if (lower.startsWith('ff')) return false
  return true
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0]
  // Unique local addresses (ULA), fc00::/7
  return lower.startsWith('fc') || lower.startsWith('fd')
}

function isPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0]
  if (!isUsableIpv6(lower) || isPrivateIpv6(lower)) return false

  // Global unicast, 2000::/3
  const first = lower.replace(/^::/, '')[0]
  return first === '2' || first === '3'
}

export function collectServerAddresses(): ServerAddresses {
  const privateIpv4 = new Set<string>()
  const privateIpv6 = new Set<string>()
  const publicIpv4 = new Set<string>()
  const publicIpv6 = new Set<string>()

  for (const addr of Deno.networkInterfaces()) {
    if (!isPhysicalInterface(addr.name)) continue

    if (addr.family === 'IPv4') {
      if (isPrivateIpv4(addr.address)) privateIpv4.add(addr.address)
      else if (isPublicIpv4(addr.address)) publicIpv4.add(addr.address)
      continue
    }

    if (isPrivateIpv6(addr.address)) privateIpv6.add(addr.address)
    else if (isPublicIpv6(addr.address)) publicIpv6.add(addr.address)
  }

  return {
    privateIpv4: [...privateIpv4].sort(),
    privateIpv6: [...privateIpv6].sort(),
    publicIpv4: [...publicIpv4].sort(),
    publicIpv6: [...publicIpv6].sort(),
  }
}
