import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { Api, KeyEnvelope, Perms } from './api'
import { Connection, type Message } from './connection'
import { Cipher, fromB64, fromUtf8, mergeKeyrings, newKey, openWithPrivateKey, randomId, sealForPublicKey, toB64, utf8, type Keyring } from './crypto'
import { applyCanvas, parseCanvas, readCanvas } from './canvas'
import { applyToYText } from './merge'
import type { Store, StoreOp } from './store'
import { cancel, later, type Timer } from './timers'

export const REMOTE = { collaborationRemote: true }
export const LOCAL = { collaborationLocal: true }
const UI = { collaborationUi: true }

export type EventType = 'create' | 'meta' | 'update' | 'snap' | 'delete' | 'restore'

export interface BlobRef { id: string, size: number, hash: string }
export type FileKind = 'text' | 'canvas' | 'blob' | 'folder'
export interface FileMeta { path: string, kind: FileKind, blob?: BlobRef }

export interface FileState extends FileMeta {
  id: string
  deleted: boolean
  createdSeq: number
  createdBy: string
  changedAt: number
  changedBy: string
}

export interface ServerEvent { seq: number, ts: number, a: string, type: EventType, f: string, d?: string, cid?: string }

export interface ShareChange { f: string, kind: 'live' | 'gone' | 'path' | 'content' | 'blob', path?: string, oldPath?: string }

export interface Member { userId: string, name: string, perms: Perms, owner: boolean }

export interface Identity { userId: string, privateKey: CryptoKey, token: () => string }

interface MemberWire { userId: string, nameEnc: string, perms: Perms, owner: boolean }
interface YouWire { perms: Perms, owner: boolean }
interface OutboxItem { cid: string, type: EventType, f: string, data?: Uint8Array, base?: number, order: number }

export interface ShareOptions {
  shareId: string
  store: Store
  api: Api
  wsUrl: () => string
  identity: Identity
  WebSocketImpl?: typeof WebSocket
  onReady?: () => void
  onResynced?: () => void
  onMembers?: () => void
  onStatus?: () => void
  onAccessLost?: (code: number) => void
  onMoved?: () => void
  onRejected?: (type: EventType, f: string, code: string) => void
  onSharePath?: (path: string | null) => void
  log?: (...args: unknown[]) => void
}

const NO_PERMS: Perms = { read: false, write: false, delete: false }

export function colorFor (userId: string): { color: string, colorLight: string } {
  let h = 0
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) % 360
  return { color: `hsl(${h}, 70%, 45%)`, colorLight: `hsla(${h}, 70%, 45%, 0.25)` }
}

function rewriteAwareness (update: Uint8Array, user: Record<string, string>): { bytes: Uint8Array, clients: number[] } {
  const decoder = decoding.createDecoder(update)
  const encoder = encoding.createEncoder()
  const length = decoding.readVarUint(decoder)
  encoding.writeVarUint(encoder, length)
  const clients: number[] = []
  for (let i = 0; i < length; i++) {
    const clientId = decoding.readVarUint(decoder)
    const clock = decoding.readVarUint(decoder)
    let state = JSON.parse(decoding.readVarString(decoder)) as Record<string, unknown> | null
    if (state !== null && typeof state === 'object') state = { ...state, user }
    clients.push(clientId)
    encoding.writeVarUint(encoder, clientId)
    encoding.writeVarUint(encoder, clock)
    encoding.writeVarString(encoder, JSON.stringify(state))
  }
  return { bytes: encoding.toUint8Array(encoder), clients }
}

function altPath (path: string, taken: Map<string, string>): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const hasExt = dot > slash + 1
  const stem = hasExt ? path.slice(0, dot) : path
  const ext = hasExt ? path.slice(dot) : ''
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

export class ShareSession {
  readonly files = new Map<string, FileState>()
  readonly members = new Map<string, Member>()
  readonly awareness: awarenessProtocol.Awareness
  cipher = new Cipher([])
  cursor = 0
  you: YouWire = { perms: NO_PERMS, owner: false }
  sharePath: string | null = null
  connected = false
  synced = false
  ready = false
  destroyed = false
  private readonly docs = new Map<string, Y.Doc>()
  private readonly conn: Connection
  private readonly listeners = new Set<(change: ShareChange) => void>()
  private readonly outbox = new Map<string, OutboxItem>()
  private readonly inflight = new Set<string>()
  private readonly retries = new Map<string, number>()
  private readonly pendingLocal = new Map<string, Uint8Array[]>()
  private readonly pendingOps: StoreOp[] = []
  private readonly dirtyDocs = new Set<string>()
  private readonly dirtyFiles = new Set<string>()
  private readonly sinceSnap = new Map<string, number>()
  private readonly awarenessClients = new Map<string, Set<number>>()
  private readonly requests = new Map<string, (events: ServerEvent[]) => void>()
  private resolved = new Map<string, string>()
  private byPath = new Map<string, string>()
  private folderPaths = new Map<string, string>()
  private messages: Promise<void> = Promise.resolve()
  private sending: Promise<void> = Promise.resolve()
  private batchTimer: Timer | null = null
  private flushTimer: Timer | null = null
  private awarenessTimer: Timer | null = null
  private order = 0
  private bulk = false
  private readonly snapThreshold = 150 + Math.floor(Math.random() * 100)

  constructor (readonly o: ShareOptions) {
    this.awareness = new awarenessProtocol.Awareness(new Y.Doc())
    this.awareness.on('update', this.onLocalAwareness)
    this.conn = new Connection({
      url: () => `${o.wsUrl()}/${o.shareId}?token=${encodeURIComponent(o.identity.token())}`,
      WebSocketImpl: o.WebSocketImpl,
      onOpen: () => { this.connected = true; this.gaveUp = false; o.onStatus?.() },
      onMessage: (msg) => { this.messages = this.messages.then(() => this.handle(msg)).catch((err) => o.log?.('message failed', err)) },
      onClose: (code) => this.onClose(code)
    })
  }

  get shareId (): string { return this.o.shareId }
  get me (): string { return this.o.identity.userId }
  get canWrite (): boolean { return this.you.owner || this.you.perms.write }
  get canDelete (): boolean { return this.you.owner || this.you.perms.delete }
  get isOwner (): boolean { return this.you.owner }

  subscribe (listener: (change: ShareChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit (changes: ShareChange[]): void {
    for (const change of changes) for (const listener of this.listeners) listener(change)
  }

  async load (): Promise<void> {
    const store = this.o.store
    const [keyring, cursor, you] = await Promise.all([
      store.get<Keyring>('kv', 'keyring'),
      store.get<number>('kv', 'cursor'),
      store.get<YouWire>('kv', 'you')
    ])
    this.cipher = new Cipher(keyring ?? [])
    this.cursor = cursor ?? 0
    if (you) this.you = you
    for (const [id, file] of await store.all<FileState>('files')) this.files.set(id, file)
    for (const [id, state] of await store.all<Uint8Array>('docs')) Y.applyUpdate(this.docFor(id), state, REMOTE)
    this.dirtyDocs.clear()
    const items = (await store.all<OutboxItem>('outbox')).map(([, item]) => item).sort((a, b) => a.order - b.order)
    for (const item of items) {
      this.outbox.set(item.cid, item)
      this.order = Math.max(this.order, item.order + 1)
    }
    this.resolvePaths()
  }

  private gaveUp = false

  setKeyring (keyring: Keyring): void {
    this.cipher.setKeyring(keyring)
    this.queueOp({ table: 'kv', key: 'keyring', value: this.cipher.ring })
  }

  start (): void { this.conn.connect() }
  reconnect (): void { this.conn.reconnect() }

  private onClose (code: number): boolean {
    this.connected = false
    this.synced = false
    this.inflight.clear()
    for (const userId of Array.from(this.awarenessClients.keys())) this.dropAwareness(userId)
    this.o.onStatus?.()
    if (code === 4410) this.o.onMoved?.()
    if (code === 4401 || code === 4403 || code === 4404) this.o.onAccessLost?.(code)
    const retry = !this.destroyed && code !== 4403 && code !== 4404
    this.gaveUp = !retry
    return retry
  }

  get stalled (): boolean { return this.gaveUp && !this.destroyed }

  private async handle (msg: Message): Promise<void> {
    if (this.destroyed) return
    switch (msg.t) {
      case 'welcome': {
        this.you = msg.you as YouWire
        this.queueOp({ table: 'kv', key: 'you', value: this.you })
        await this.acceptEnvelope(msg.envelope as KeyEnvelope | null)
        await this.setMembers(msg.members as MemberWire[])
        await this.acceptSharePath(msg.pathEnc as string | null | undefined)
        this.bulk = this.cursor === 0
        this.conn.send({ t: 'hello', since: this.cursor })
        this.o.onMembers?.()
        break
      }
      case 'ev':
        await this.applyEvent(msg as unknown as ServerEvent)
        break
      case 'synced': {
        this.synced = true
        if (this.bulk) {
          this.bulk = false
          const before = new Set(this.resolved.keys())
          const changes = this.resolvePaths()
          for (const [f] of this.resolved) if (before.has(f) && this.files.get(f)?.kind === 'text') changes.push({ f, kind: 'content' })
          this.emit(changes)
        }
        await this.flush()
        if (!this.ready) {
          this.ready = true
          this.o.onReady?.()
        } else {
          this.o.onResynced?.()
        }
        this.sendOutbox()
        void this.sendAwareness()
        this.o.onStatus?.()
        break
      }
      case 'members':
        if (msg.you) {
          this.you = msg.you as YouWire
          this.queueOp({ table: 'kv', key: 'you', value: this.you })
        }
        await this.setMembers(msg.members as MemberWire[])
        this.o.onMembers?.()
        break
      case 'share':
        await this.acceptSharePath(msg.pathEnc as string | null | undefined)
        break
      case 'key':
        await this.acceptEnvelope(msg.envelope as KeyEnvelope | null)
        this.inflight.clear()
        this.sendOutbox()
        break
      case 'err':
        await this.onError(msg.cid as string | undefined, msg.code as string)
        break
      case 'aw':
        await this.onRemoteAwareness(msg.a as string, msg.d as string)
        break
      case 'gone':
        this.dropAwareness(msg.a as string)
        break
      case 'history': {
        const resolve = this.requests.get(msg.rid as string)
        if (resolve) {
          this.requests.delete(msg.rid as string)
          resolve(msg.events as ServerEvent[])
        }
        break
      }
    }
  }

  private aad (id: string, kind: 'meta' | 'content' | 'blob'): string { return `${this.shareId}:${id}:${kind}` }
  memberAad (userId: string): string { return `${this.shareId}:member-name:${userId}` }
  shareNameAad (): string { return `${this.shareId}:share-name` }
  sharePathAad (): string { return `${this.shareId}:share-path` }

  private async acceptSharePath (pathEnc: string | null | undefined): Promise<void> {
    const path = pathEnc ? await this.cipher.decryptText(this.sharePathAad(), pathEnc).catch(() => null) : null
    this.sharePath = path
    this.o.onSharePath?.(path)
  }

  async decryptMeta (f: string, data: string): Promise<FileMeta> {
    return JSON.parse(await this.cipher.decryptText(this.aad(f, 'meta'), data)) as FileMeta
  }

  async decryptContent (f: string, data: string): Promise<Uint8Array> {
    return this.cipher.decrypt(this.aad(f, 'content'), fromB64(data))
  }

  private async applyEvent (ev: ServerEvent): Promise<void> {
    if (ev.seq <= this.cursor) return
    const own = ev.cid ? this.outbox.get(ev.cid) : undefined
    if (own) {
      this.outbox.delete(own.cid)
      this.inflight.delete(own.cid)
      this.retries.delete(own.cid)
      this.queueOp({ table: 'outbox', key: own.cid })
    }
    const changes: ShareChange[] = []
    try {
      if (ev.type === 'create' || ev.type === 'meta') {
        const meta = await this.decryptMeta(ev.f, ev.d ?? '')
        const prev = this.files.get(ev.f)
        const file: FileState = prev ?? { id: ev.f, path: meta.path, kind: meta.kind, deleted: false, createdSeq: ev.seq, createdBy: ev.a, changedAt: ev.ts, changedBy: ev.a }
        if (ev.type === 'create') { file.createdSeq = ev.seq; file.createdBy = ev.a }
        const blobChanged = prev !== undefined && prev.blob?.id !== meta.blob?.id
        file.path = meta.path
        file.kind = meta.kind
        file.blob = meta.blob
        file.changedAt = ev.ts
        file.changedBy = ev.a
        this.files.set(ev.f, file)
        this.dirtyFiles.add(ev.f)
        if (blobChanged && !own && file.kind === 'blob') changes.push({ f: ev.f, kind: 'blob' })
      } else if (ev.type === 'update' || ev.type === 'snap') {
        if (!own) {
          Y.applyUpdate(this.docFor(ev.f), await this.decryptContent(ev.f, ev.d ?? ''), REMOTE)
          changes.push({ f: ev.f, kind: 'content' })
        }
        this.countForSnapshot(ev.f, ev.type)
      } else {
        const file = this.files.get(ev.f)
        if (file) {
          file.deleted = ev.type === 'delete'
          file.changedAt = ev.ts
          file.changedBy = ev.a
          this.dirtyFiles.add(ev.f)
        }
      }
    } catch (err) {
      this.o.log?.('could not apply event', ev.seq, err)
    }
    this.cursor = ev.seq
    this.scheduleFlush()
    if (this.bulk) return
    const structural = ev.type !== 'update' && ev.type !== 'snap' ? this.resolvePaths() : []
    this.emit([...structural, ...changes])
  }

  private resolvePaths (): ShareChange[] {
    const live = Array.from(this.files.values())
      .filter((f) => !f.deleted)
      .sort((a, b) => (a.createdSeq - b.createdSeq) || (a.id < b.id ? -1 : 1))
    const next = new Map<string, string>()
    const taken = new Map<string, string>()
    const folders = new Map<string, string>()
    for (const file of live) {
      if (file.kind === 'folder') {
        next.set(file.id, file.path)
        if (!folders.has(file.path)) folders.set(file.path, file.id)
        continue
      }
      const path = taken.has(file.path) ? altPath(file.path, taken) : file.path
      taken.set(path, file.id)
      next.set(file.id, path)
    }
    const changes: ShareChange[] = []
    for (const [f, path] of next) {
      const old = this.resolved.get(f)
      if (old === undefined) changes.push({ f, kind: 'live', path })
      else if (old !== path) changes.push({ f, kind: 'path', path, oldPath: old })
    }
    for (const [f, old] of this.resolved) if (!next.has(f)) changes.push({ f, kind: 'gone', oldPath: old })
    this.resolved = next
    this.byPath = taken
    this.folderPaths = folders
    return changes
  }

  pathOf (f: string): string | undefined { return this.resolved.get(f) }
  fileAt (path: string): string | undefined { return this.byPath.get(path) }
  folderAt (path: string): string | undefined { return this.folderPaths.get(path) }
  liveFiles (): Array<[string, string]> { return Array.from(this.resolved).filter(([f]) => this.files.get(f)?.kind !== 'folder') }
  liveFolders (): Array<[string, string]> { return Array.from(this.resolved).filter(([f]) => this.files.get(f)?.kind === 'folder') }
  deletedFiles (): FileState[] { return Array.from(this.files.values()).filter((f) => f.deleted && f.kind !== 'folder') }

  private docFor (f: string): Y.Doc {
    let doc = this.docs.get(f)
    if (!doc) {
      doc = new Y.Doc()
      doc.on('update', (update: Uint8Array, origin: unknown) => this.onDocUpdate(f, update, origin))
      this.docs.set(f, doc)
    }
    return doc
  }

  text (f: string): Y.Text { return this.docFor(f).getText('content') }
  doc (f: string): Y.Doc { return this.docFor(f) }

  private onDocUpdate (f: string, update: Uint8Array, origin: unknown): void {
    this.dirtyDocs.add(f)
    this.scheduleFlush()
    if (origin === REMOTE || this.destroyed || !this.canWrite) return
    let list = this.pendingLocal.get(f)
    if (!list) { list = []; this.pendingLocal.set(f, list) }
    list.push(update)
    if (!this.batchTimer) this.batchTimer = later(() => this.flushLocal(), 30)
    if (origin === UI) this.emit([{ f, kind: 'content' }])
  }

  private flushLocal (): void {
    if (this.batchTimer) { cancel(this.batchTimer); this.batchTimer = null }
    for (const [f, updates] of this.pendingLocal) this.enqueue('update', f, Y.mergeUpdates(updates))
    this.pendingLocal.clear()
  }

  private countForSnapshot (f: string, type: EventType): void {
    if (type === 'snap') { this.sinceSnap.set(f, 0); return }
    const count = (this.sinceSnap.get(f) ?? 0) + 1
    this.sinceSnap.set(f, count)
    if (count >= this.snapThreshold && this.canWrite && this.synced) {
      this.sinceSnap.set(f, 0)
      this.enqueue('snap', f, Y.encodeStateAsUpdate(this.docFor(f)), this.cursor)
    }
  }

  private requireWrite (): void { if (!this.canWrite) throw new Error('You can only read this shared folder') }
  private requireDelete (): void { if (!this.canDelete) throw new Error('You cannot delete files in this shared folder') }

  private newFile (f: string, meta: FileMeta): void {
    this.files.set(f, { id: f, ...meta, deleted: false, createdSeq: Number.POSITIVE_INFINITY, createdBy: this.me, changedAt: Date.now(), changedBy: this.me })
    this.dirtyFiles.add(f)
    this.enqueue('create', f, utf8(JSON.stringify(meta)))
    this.resolvePaths()
  }

  createText (path: string, content: string): string {
    this.requireWrite()
    const f = randomId()
    this.newFile(f, { path, kind: 'text' })
    if (content) this.docFor(f).transact(() => this.text(f).insert(0, content), LOCAL)
    return f
  }

  createFolder (path: string): string {
    this.requireWrite()
    const f = randomId()
    this.newFile(f, { path, kind: 'folder' })
    return f
  }

  createCanvas (path: string, content: string): string {
    this.requireWrite()
    const f = randomId()
    this.newFile(f, { path, kind: 'canvas' })
    const data = parseCanvas(content)
    if (data) {
      const doc = this.docFor(f)
      doc.transact(() => applyCanvas(doc, null, data), LOCAL)
    }
    return f
  }

  private async uploadBlob (data: Uint8Array, hash: string): Promise<BlobRef> {
    const id = randomId()
    await this.o.api.putBlob(this.shareId, id, await this.cipher.encrypt(this.aad(id, 'blob'), data))
    return { id, size: data.byteLength, hash }
  }

  async createBlob (path: string, data: Uint8Array, hash: string): Promise<string> {
    this.requireWrite()
    const blob = await this.uploadBlob(data, hash)
    const f = randomId()
    this.newFile(f, { path, kind: 'blob', blob })
    return f
  }

  private writeMeta (file: FileState): void {
    const meta: FileMeta = { path: file.path, kind: file.kind, ...(file.blob ? { blob: file.blob } : {}) }
    file.changedAt = Date.now()
    file.changedBy = this.me
    this.dirtyFiles.add(file.id)
    this.enqueue('meta', file.id, utf8(JSON.stringify(meta)))
  }

  async updateBlob (f: string, data: Uint8Array, hash: string): Promise<void> {
    this.requireWrite()
    const file = this.files.get(f)
    if (!file) return
    file.blob = await this.uploadBlob(data, hash)
    this.writeMeta(file)
  }

  setBlob (f: string, blob: BlobRef): void {
    this.requireWrite()
    const file = this.files.get(f)
    if (!file) return
    file.blob = blob
    this.writeMeta(file)
    this.emit([{ f, kind: 'blob' }])
  }

  rename (f: string, path: string): void {
    this.requireWrite()
    const file = this.files.get(f)
    if (!file || file.path === path) return
    file.path = path
    this.writeMeta(file)
    this.resolvePaths()
  }

  remove (f: string): void {
    this.requireDelete()
    const file = this.files.get(f)
    if (!file || file.deleted) return
    file.deleted = true
    file.changedAt = Date.now()
    file.changedBy = this.me
    this.dirtyFiles.add(f)
    this.enqueue('delete', f)
    this.resolvePaths()
  }

  restore (f: string): void {
    this.requireDelete()
    const file = this.files.get(f)
    if (!file || !file.deleted) return
    file.deleted = false
    this.dirtyFiles.add(f)
    this.enqueue('restore', f)
    this.emit(this.resolvePaths())
  }

  restoreText (f: string, content: string): void {
    this.requireWrite()
    const text = this.text(f)
    this.docFor(f).transact(() => applyToYText(text, content), UI)
  }

  restoreCanvas (f: string, content: string): void {
    this.requireWrite()
    const data = parseCanvas(content)
    if (!data) return
    const doc = this.docFor(f)
    doc.transact(() => applyCanvas(doc, parseCanvas(readCanvas(doc)), data), UI)
  }

  async downloadBlob (f: string, blob?: BlobRef): Promise<Uint8Array> {
    const ref = blob ?? this.files.get(f)?.blob
    if (!ref) throw new Error('not an attachment')
    return this.cipher.decrypt(this.aad(ref.id, 'blob'), await this.o.api.getBlob(this.shareId, ref.id))
  }

  private enqueue (type: EventType, f: string, data?: Uint8Array, base?: number): void {
    const item: OutboxItem = { cid: randomId(), type, f, data, base, order: this.order++ }
    this.outbox.set(item.cid, item)
    this.queueOp({ table: 'outbox', key: item.cid, value: item })
    this.scheduleFlush()
    this.sendItem(item)
  }

  private sendItem (item: OutboxItem): void {
    this.sending = this.sending.then(async () => {
      if (!this.synced || this.inflight.has(item.cid) || !this.outbox.has(item.cid) || !this.conn.open) return
      this.inflight.add(item.cid)
      try {
        const kind = item.type === 'create' || item.type === 'meta' ? 'meta' : 'content'
        const d = item.data ? toB64(await this.cipher.encrypt(this.aad(item.f, kind), item.data)) : undefined
        if (!this.conn.send({ t: 'ev', cid: item.cid, type: item.type, f: item.f, ...(d ? { d } : {}), ...(item.base !== undefined ? { b: item.base } : {}) })) this.inflight.delete(item.cid)
      } catch (err) {
        this.inflight.delete(item.cid)
        this.o.log?.('send failed', err)
      }
    })
  }

  private sendOutbox (): void {
    for (const item of Array.from(this.outbox.values()).sort((a, b) => a.order - b.order)) this.sendItem(item)
  }

  private async onError (cid: string | undefined, code: string): Promise<void> {
    const item = cid ? this.outbox.get(cid) : undefined
    if (!item) return
    this.inflight.delete(item.cid)
    const tries = (this.retries.get(item.cid) ?? 0) + 1
    this.retries.set(item.cid, tries)
    if (code === 'stale_key' && tries < 5) {
      await this.refreshKey().catch(() => undefined)
      this.sendItem(item)
      return
    }
    this.outbox.delete(item.cid)
    this.retries.delete(item.cid)
    this.queueOp({ table: 'outbox', key: item.cid })
    this.scheduleFlush()
    this.o.onRejected?.(item.type, item.f, code)
    if (code === 'forbidden') await this.resync()
  }

  private async resync (): Promise<void> {
    const ops: StoreOp[] = []
    for (const f of this.files.keys()) ops.push({ table: 'files', key: f }, { table: 'docs', key: f })
    for (const cid of this.outbox.keys()) ops.push({ table: 'outbox', key: cid })
    ops.push({ table: 'kv', key: 'cursor', value: 0 })
    this.pendingLocal.clear()
    this.outbox.clear()
    this.files.clear()
    for (const doc of this.docs.values()) doc.destroy()
    this.docs.clear()
    this.dirtyDocs.clear()
    this.dirtyFiles.clear()
    this.cursor = 0
    await this.o.store.write(ops)
    this.conn.reconnect()
  }

  private async acceptEnvelope (envelope: KeyEnvelope | null): Promise<void> {
    if (!envelope || this.cipher.has(envelope.epoch)) return
    try {
      const ring = JSON.parse(fromUtf8(await openWithPrivateKey(this.o.identity.privateKey, fromB64(envelope.data)))) as Keyring
      this.setKeyring(ring)
      await this.flush()
    } catch (err) {
      this.o.log?.('could not open key envelope', err)
    }
  }

  async refreshKey (): Promise<void> {
    const result = await this.o.api.keyEnvelope(this.shareId)
    await this.acceptEnvelope(result.envelope)
  }

  async rotateKeys (recipients: Array<{ userId: string, publicKey: string }>): Promise<void> {
    const entry = newKey(this.cipher.epoch + 1)
    const ring = mergeKeyrings(this.cipher.ring, [entry])
    const payload = utf8(JSON.stringify(ring))
    const envelopes: Record<string, string> = {}
    for (const r of recipients) envelopes[r.userId] = toB64(await sealForPublicKey(r.publicKey, payload))
    await this.o.api.rotateKeys(this.shareId, entry.epoch, envelopes)
    this.setKeyring(ring)
    await this.flush()
  }

  private async setMembers (list: MemberWire[]): Promise<void> {
    const next = new Map<string, Member>()
    for (const m of list) {
      const name = await this.cipher.decryptText(this.memberAad(m.userId), m.nameEnc).catch(() => 'Unknown')
      next.set(m.userId, { userId: m.userId, name, perms: m.perms, owner: m.owner })
    }
    this.members.clear()
    for (const [id, m] of next) this.members.set(id, m)
  }

  memberName (userId: string): string {
    return this.members.get(userId)?.name ?? 'Former member'
  }

  private readonly onLocalAwareness = ({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }, origin: unknown): void => {
    if (origin === 'remote') return
    if (![...added, ...updated, ...removed].includes(this.awareness.clientID)) return
    if (!this.awarenessTimer) {
      this.awarenessTimer = later(() => {
        this.awarenessTimer = null
        void this.sendAwareness()
      }, 50)
    }
  }

  private async sendAwareness (): Promise<void> {
    if (!this.synced || !this.conn.open || this.destroyed) return
    const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])
    const d = toB64(await this.cipher.encrypt(`${this.shareId}:awareness`, update))
    this.conn.send({ t: 'aw', d })
  }

  private async onRemoteAwareness (userId: string, data: string): Promise<void> {
    let update: Uint8Array
    try {
      update = await this.cipher.decrypt(`${this.shareId}:awareness`, fromB64(data))
    } catch {
      return
    }
    const { bytes, clients } = rewriteAwareness(update, { name: this.memberName(userId), ...colorFor(userId) })
    let set = this.awarenessClients.get(userId)
    if (!set) { set = new Set(); this.awarenessClients.set(userId, set) }
    for (const client of clients) set.add(client)
    awarenessProtocol.applyAwarenessUpdate(this.awareness, bytes, 'remote')
  }

  private dropAwareness (userId: string): void {
    const set = this.awarenessClients.get(userId)
    if (!set) return
    this.awarenessClients.delete(userId)
    awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(set), 'remote')
  }

  history (f: string): Promise<ServerEvent[]> {
    return new Promise((resolve, reject) => {
      const rid = randomId()
      const timer = later(() => { this.requests.delete(rid); reject(new Error('The server did not answer')) }, 20000)
      this.requests.set(rid, (events) => { cancel(timer); resolve(events) })
      if (!this.conn.send({ t: 'history', f, rid })) {
        this.requests.delete(rid)
        cancel(timer)
        reject(new Error('Not connected'))
      }
    })
  }

  private queueOp (op: StoreOp): void {
    this.pendingOps.push(op)
    this.scheduleFlush()
  }

  private scheduleFlush (): void {
    if (!this.flushTimer && !this.destroyed) this.flushTimer = later(() => { void this.flush() }, 500)
  }

  async flush (): Promise<void> {
    if (this.flushTimer) { cancel(this.flushTimer); this.flushTimer = null }
    this.flushLocal()
    const ops = this.pendingOps.splice(0)
    for (const f of this.dirtyDocs) {
      const doc = this.docs.get(f)
      if (doc) ops.push({ table: 'docs', key: f, value: Y.encodeStateAsUpdate(doc) })
    }
    for (const f of this.dirtyFiles) ops.push({ table: 'files', key: f, value: this.files.get(f) })
    this.dirtyDocs.clear()
    this.dirtyFiles.clear()
    ops.push({ table: 'kv', key: 'cursor', value: this.cursor })
    try {
      await this.o.store.write(ops)
    } catch (err) {
      this.o.log?.('could not save state', err)
    }
  }

  async close (): Promise<void> {
    if (this.destroyed) return
    await this.flush()
    this.destroy()
  }

  destroy (): void {
    if (this.destroyed) return
    this.destroyed = true
    this.conn.close()
    for (const timer of [this.batchTimer, this.flushTimer, this.awarenessTimer]) if (timer) cancel(timer)
    this.awareness.off('update', this.onLocalAwareness)
    this.awareness.destroy()
    for (const doc of this.docs.values()) doc.destroy()
    this.listeners.clear()
  }

  async destroyAndClear (): Promise<void> {
    this.destroy()
    await this.o.store.destroy()
  }
}
