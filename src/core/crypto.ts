const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const utf8 = (text: string): Uint8Array => encoder.encode(text)
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes)

export function toB64 (bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromB64 (text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export const toB64Url = (bytes: Uint8Array): string => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const fromB64Url = (text: string): Uint8Array => fromB64(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))

export function randomBytes (length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function randomId (): string {
  return toB64Url(randomBytes(16))
}

function buf (bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export interface KeyEntry { epoch: number, key: string }
export type Keyring = KeyEntry[]

const VERSION = 1
const HEADER = 1 + 4 + 12

export function newKey (epoch: number): KeyEntry {
  return { epoch, key: toB64(randomBytes(32)) }
}

export function mergeKeyrings (a: Keyring, b: Keyring): Keyring {
  const byEpoch = new Map<number, KeyEntry>()
  for (const entry of [...a, ...b]) byEpoch.set(entry.epoch, entry)
  return Array.from(byEpoch.values()).sort((x, y) => x.epoch - y.epoch)
}

export function payloadEpoch (payload: Uint8Array): number {
  if (payload.length < HEADER || payload[0] !== VERSION) return -1
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(1)
}

export class Cipher {
  private keyring: Keyring = []
  private readonly keys = new Map<number, Promise<CryptoKey>>()

  constructor (keyring: Keyring) {
    this.setKeyring(keyring)
  }

  setKeyring (keyring: Keyring): void {
    this.keyring = mergeKeyrings(this.keyring, keyring)
  }

  get ring (): Keyring { return this.keyring }

  get epoch (): number {
    return this.keyring.length ? this.keyring[this.keyring.length - 1].epoch : -1
  }

  has (epoch: number): boolean {
    return this.keyring.some((k) => k.epoch === epoch)
  }

  private key (epoch: number): Promise<CryptoKey> {
    let key = this.keys.get(epoch)
    if (!key) {
      const entry = this.keyring.find((k) => k.epoch === epoch)
      if (!entry) throw new Error(`missing key for epoch ${epoch}`)
      key = crypto.subtle.importKey('raw', buf(fromB64(entry.key)), 'AES-GCM', false, ['encrypt', 'decrypt'])
      this.keys.set(epoch, key)
    }
    return key
  }

  async encrypt (aad: string, data: Uint8Array): Promise<Uint8Array> {
    const epoch = this.epoch
    const iv = randomBytes(12)
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(utf8(aad)) }, await this.key(epoch), buf(data)))
    const out = new Uint8Array(HEADER + sealed.length)
    out[0] = VERSION
    new DataView(out.buffer).setUint32(1, epoch)
    out.set(iv, 5)
    out.set(sealed, HEADER)
    return out
  }

  async decrypt (aad: string, payload: Uint8Array): Promise<Uint8Array> {
    const epoch = payloadEpoch(payload)
    if (epoch < 0) throw new Error('unknown payload format')
    const iv = payload.subarray(5, HEADER)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(utf8(aad)) }, await this.key(epoch), buf(payload.subarray(HEADER)))
    return new Uint8Array(plain)
  }

  async encryptText (aad: string, text: string): Promise<string> {
    return toB64(await this.encrypt(aad, utf8(text)))
  }

  async decryptText (aad: string, payload: string): Promise<string> {
    return fromUtf8(await this.decrypt(aad, fromB64(payload)))
  }
}

async function derive (secret: Uint8Array, purpose: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buf(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(32), info: buf(utf8(purpose)) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function sealWithSecret (secret: Uint8Array, purpose: string, data: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12)
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, await derive(secret, purpose), buf(data)))
  const out = new Uint8Array(12 + sealed.length)
  out.set(iv)
  out.set(sealed, 12)
  return out
}

export async function openWithSecret (secret: Uint8Array, purpose: string, sealed: Uint8Array): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(sealed.subarray(0, 12)) }, await derive(secret, purpose), buf(sealed.subarray(12)))
  return new Uint8Array(plain)
}

export const INVITE_PURPOSE = 'collaboration-invite-v1'
const ENVELOPE_PURPOSE = 'collaboration-envelope-v1'
const ECDH = { name: 'ECDH', namedCurve: 'P-256' }

export async function generateDeviceKeys (): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH, false, ['deriveBits'])
}

export async function exportPublicKey (key: CryptoKey): Promise<string> {
  return JSON.stringify(await crypto.subtle.exportKey('jwk', key))
}

export async function sealForPublicKey (publicKeyJwk: string, data: Uint8Array): Promise<Uint8Array> {
  const recipient = await crypto.subtle.importKey('jwk', JSON.parse(publicKeyJwk) as JsonWebKey, ECDH, false, [])
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256))
  const sealed = await sealWithSecret(shared, ENVELOPE_PURPOSE, data)
  const epk = utf8(JSON.stringify(await crypto.subtle.exportKey('jwk', ephemeral.publicKey)))
  const out = new Uint8Array(2 + epk.length + sealed.length)
  new DataView(out.buffer).setUint16(0, epk.length)
  out.set(epk, 2)
  out.set(sealed, 2 + epk.length)
  return out
}

export async function openWithPrivateKey (privateKey: CryptoKey, envelope: Uint8Array): Promise<Uint8Array> {
  const length = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).getUint16(0)
  const epk = JSON.parse(fromUtf8(envelope.subarray(2, 2 + length))) as JsonWebKey
  const sender = await crypto.subtle.importKey('jwk', epk, ECDH, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, privateKey, 256))
  return openWithSecret(shared, ENVELOPE_PURPOSE, envelope.subarray(2 + length))
}

export async function sha256Hex (data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? buf(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
