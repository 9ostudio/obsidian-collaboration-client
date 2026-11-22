export interface HttpRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string | ArrayBuffer
}

export interface HttpResponse {
  status: number
  text: () => string
  arrayBuffer: () => ArrayBuffer
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>

export interface Perms { read: boolean, write: boolean, delete: boolean }

export interface ShareSummary { id: string, role: 'owner' | 'member', perms: Perms, nameEnc: string, pathEnc?: string | null, epoch: number }

export interface MemberRecord {
  userId: string
  nameEnc: string
  perms: Perms
  owner: boolean
  joinedAt: string
  publicKey: string
}

export interface InviteRecord {
  shareId: string
  perms: Perms
  keyring: string
  shareNameEnc: string
  ownerNameEnc: string
  pathEnc?: string | null
  ownerId: string
}

export interface KeyEnvelope { epoch: number, data: string }

function errorBody (text: string): { error?: string, location?: string } {
  try {
    return JSON.parse(text) as { error?: string, location?: string }
  } catch {
    return {}
  }
}

export class ApiError extends Error {
  constructor (readonly status: number, readonly code: string, readonly location?: string) {
    super(code)
  }
}

export class Api {
  constructor (
    private readonly http: HttpFn,
    private readonly base: () => string,
    private readonly token: () => string,
    private readonly onMoved?: (location: string) => void
  ) {}

  private async request (method: string, path: string, body?: unknown): Promise<HttpResponse> {
    const base = this.base()
    if (!base) throw new ApiError(0, 'No server is set')
    const headers: Record<string, string> = { authorization: `Bearer ${this.token()}` }
    let payload: string | ArrayBuffer | undefined
    if (body instanceof ArrayBuffer) {
      headers['content-type'] = 'application/octet-stream'
      payload = body
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    let res: HttpResponse
    try {
      res = await this.http({ url: base + path, method, headers, body: payload })
    } catch {
      throw new ApiError(0, 'The server is unreachable')
    }
    if (res.status >= 400) {
      const body = errorBody(res.text())
      if (res.status === 410 && body.error === 'moved' && body.location) this.onMoved?.(body.location)
      throw new ApiError(res.status, body.error ?? `http_${res.status}`, body.location)
    }
    return res
  }

  private async json<T> (method: string, path: string, body?: unknown): Promise<T> {
    const text = (await this.request(method, path, body)).text()
    return (text ? JSON.parse(text) : {}) as T
  }

  register (userId: string, secret: string, publicKey: string): Promise<{ canShare: boolean }> {
    return this.json('POST', '/api/register', { userId, secret, publicKey })
  }

  claimOwner (token: string): Promise<unknown> { return this.json('POST', '/api/claim', { token }) }

  async checkMoved (): Promise<void> {
    await this.listShares().catch(() => undefined)
  }

  async listShares (): Promise<ShareSummary[]> {
    return (await this.json<{ shares: ShareSummary[] }>('GET', '/api/shares')).shares
  }

  createShare (id: string, nameEnc: string, ownerNameEnc: string, pathEnc: string): Promise<ShareSummary> {
    return this.json('POST', '/api/shares', { id, nameEnc, ownerNameEnc, pathEnc })
  }

  updateSharePath (id: string, pathEnc: string): Promise<unknown> {
    return this.json('PATCH', `/api/shares/${id}`, { pathEnc })
  }

  deleteShare (id: string): Promise<unknown> { return this.json('DELETE', `/api/shares/${id}`) }

  createInvite (id: string, perms: Perms, keyring: string): Promise<{ token: string, expiresAt: string }> {
    return this.json('POST', `/api/shares/${id}/invites`, { perms, keyring })
  }

  cancelInvites (id: string): Promise<unknown> { return this.json('DELETE', `/api/shares/${id}/invites`) }

  members (id: string): Promise<{ members: MemberRecord[], pendingInvites: number }> {
    return this.json('GET', `/api/shares/${id}/members`)
  }

  updateMember (id: string, userId: string, change: { perms?: Perms, nameEnc?: string }): Promise<unknown> {
    return this.json('PATCH', `/api/shares/${id}/members/${encodeURIComponent(userId)}`, change)
  }

  removeMember (id: string, userId: string): Promise<unknown> {
    return this.json('DELETE', `/api/shares/${id}/members/${encodeURIComponent(userId)}`)
  }

  leave (id: string): Promise<unknown> { return this.json('DELETE', `/api/shares/${id}/membership`) }

  rotateKeys (id: string, epoch: number, envelopes: Record<string, string>): Promise<unknown> {
    return this.json('POST', `/api/shares/${id}/keys`, { epoch, envelopes })
  }

  keyEnvelope (id: string): Promise<{ epoch: number, envelope: KeyEnvelope | null }> {
    return this.json('GET', `/api/shares/${id}/key`)
  }

  getInvite (token: string): Promise<InviteRecord> { return this.json('GET', `/api/invites/${encodeURIComponent(token)}`) }

  acceptInvite (token: string, nameEnc: string): Promise<ShareSummary> {
    return this.json('POST', `/api/invites/${encodeURIComponent(token)}/accept`, { nameEnc })
  }

  async putBlob (id: string, blobId: string, data: Uint8Array): Promise<void> {
    const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    await this.request('PUT', `/api/shares/${id}/blobs/${blobId}`, body)
  }

  async getBlob (id: string, blobId: string): Promise<Uint8Array> {
    return new Uint8Array((await this.request('GET', `/api/shares/${id}/blobs/${blobId}`)).arrayBuffer())
  }
}

export function normalizeServer (input: string | undefined | null): string {
  if (!input) return ''
  try {
    const url = new URL(input.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return url.origin
  } catch {
    return ''
  }
}

export interface ParsedInvite { server: string, token: string, secret: string }

export function parseInvite (input: string): ParsedInvite | null {
  const text = input.trim()
  const link = text.match(/^(https?:\/\/[^/]+)\/join\/([A-Za-z0-9_-]{16,})#([A-Za-z0-9_-]{20,})/)
  if (link) return { server: normalizeServer(link[1]), token: link[2], secret: link[3] }
  const uri = text.match(/[?&]invite=([A-Za-z0-9_-]{16,})/)
  const key = text.match(/[?&]key=([A-Za-z0-9_-]{20,})/)
  const server = text.match(/[?&]server=([^&]+)/)
  if (uri && key) return { server: server ? normalizeServer(decodeURIComponent(server[1])) : '', token: uri[1], secret: key[1] }
  return null
}
