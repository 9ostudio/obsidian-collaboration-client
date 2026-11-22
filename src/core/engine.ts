import type * as Y from 'yjs'
import { applyCanvas, formatCanvas, isCanvasPath, normalizeCanvas, parseCanvas, readCanvas, toLocalCanvas, toSharedCanvas, type CanvasData } from './canvas'
import { sha256Hex } from './crypto'
import { applyToYText, threeWay } from './merge'
import { LOCAL, type FileKind, type ShareChange, type ShareSession } from './share'
import type { StoreOp } from './store'
import { cancel, later, sleep, type Timer } from './timers'

export interface VaultIO {
  listFiles: (root: string) => string[]
  isFile: (path: string) => boolean
  isFolder: (path: string) => boolean
  read: (path: string) => Promise<string>
  readBinary: (path: string) => Promise<ArrayBuffer>
  write: (path: string, text: string) => Promise<void>
  writeBinary: (path: string, data: ArrayBuffer) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  remove: (path: string) => Promise<void>
  isEmptyFolder: (path: string) => boolean
  removeFolder: (path: string) => Promise<void>
  listFolders: (root: string) => string[]
  ensureFolder: (path: string) => Promise<void>
  stat?: (path: string) => { size: number, mtime: number } | null
}

export interface EngineOptions {
  session: ShareSession
  root: string
  io: VaultIO
  log?: (...args: unknown[]) => void
  onRootMissing?: () => void
  onConflict?: (path: string) => void
  onDenied?: (message: string) => void
  onTracked?: () => void
  isOpen?: (path: string) => boolean
}

interface Base { text?: string, hash?: string, folder?: boolean }

export const isTextPath = (path: string): boolean => /\.(md|txt)$/i.test(path)
export const kindOfPath = (path: string): FileKind => isTextPath(path) ? 'text' : isCanvasPath(path) ? 'canvas' : 'blob'

export class SyncEngine {
  root: string
  private readonly session: ShareSession
  private readonly base = new Map<string, Base>()
  private readonly bound = new Map<string, number>()
  private readonly writeTimers = new Map<string, Timer>()
  private readonly pendingNew = new Set<string>()
  private readonly pendingUploads = new Set<string>()
  private readonly pendingDownloads = new Set<string>()
  private readonly pendingDeletes = new Set<string>()
  private readonly ownRemovals = new Set<string>()
  private readonly present = new Set<string>()
  private readonly deferred = new Set<string>()
  private readonly baseOps: StoreOp[] = []
  private deleteTimer: Timer | null = null
  private baseTimer: Timer | null = null
  private queue: Promise<void> = Promise.resolve()
  private live = false
  private destroyed = false
  private readonly unsubscribe: () => void

  constructor (private readonly o: EngineOptions) {
    this.root = o.root
    this.session = o.session
    this.unsubscribe = this.session.subscribe((change) => this.onShareChange(change))
  }

  rel (path: string): string | null {
    return path.startsWith(this.root + '/') ? path.slice(this.root.length + 1) : null
  }

  abs (rel: string): string { return `${this.root}/${rel}` }
  setRoot (root: string): void { this.root = root }
  fileFor (path: string): string | undefined {
    const rel = this.rel(path)
    return rel ? this.session.fileAt(rel) : undefined
  }

  private get io (): VaultIO { return this.o.io }

  private enqueue (fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => { if (!this.destroyed) await fn() }).catch((err) => this.o.log?.('sync error', err))
    this.queue = run
    return run
  }

  async idle (): Promise<void> {
    for (;;) {
      const q = this.queue
      await q
      await sleep(5)
      if (q === this.queue && this.writeTimers.size === 0 && this.deleteTimer === null) return
      if (this.writeTimers.size > 0 || this.deleteTimer !== null) await sleep(50)
    }
  }

  destroy (): void {
    this.destroyed = true
    this.unsubscribe()
    for (const t of this.writeTimers.values()) cancel(t)
    this.writeTimers.clear()
    if (this.deleteTimer) cancel(this.deleteTimer)
    if (this.baseTimer) { cancel(this.baseTimer); void this.persistBase() }
  }

  async loadBase (): Promise<void> {
    for (const [f, value] of await this.session.o.store.all<Base>('disk')) this.base.set(f, value)
  }

  private setBase (f: string, value: Base): void {
    this.present.add(f)
    this.base.set(f, value)
    this.baseOps.push({ table: 'disk', key: f, value })
    this.scheduleBase()
  }

  private forgetBase (f: string): void {
    if (!this.base.delete(f)) return
    this.baseOps.push({ table: 'disk', key: f })
    this.scheduleBase()
  }

  private scheduleBase (): void {
    if (!this.baseTimer) this.baseTimer = later(() => { void this.persistBase() }, 300)
  }

  private async persistBase (): Promise<void> {
    this.baseTimer = null
    const ops = this.baseOps.splice(0)
    if (ops.length) await this.session.o.store.write(ops)
  }

  private denied (message: string): void { this.o.onDenied?.(message) }

  reconcileOffline (): Promise<void> {
    return this.enqueue(async () => {
      for (const [f, rel] of this.session.liveFiles()) {
        const path = this.abs(rel)
        if (!this.io.isFile(path)) continue
        await this.ingest(f, rel, false)
      }
      for (const path of this.io.listFiles(this.root)) {
        const rel = this.rel(path)
        if (rel && !this.session.fileAt(rel)) this.pendingNew.add(rel)
      }
    })
  }

  onReady (): Promise<void> {
    return this.enqueue(async () => {
      this.live = true
      for (const rel of Array.from(this.pendingNew)) {
        const path = this.abs(rel)
        if (!this.io.isFile(path)) continue
        const existing = this.session.fileAt(rel)
        const kind = kindOfPath(rel)
        if (kind !== 'blob') {
          const disk = await this.io.read(path)
          if (!existing) {
            if (kind === 'text') await this.ingestText(undefined, rel, disk)
            else await this.ingestCanvas(undefined, rel, disk)
          } else if (this.contentOf(existing) === this.normalize(kind, disk)) {
            this.setBase(existing, { text: this.normalize(kind, disk) ?? disk })
          } else {
            await this.keepConflictCopy(rel, disk)
          }
        } else {
          const data = await this.io.readBinary(path)
          if (!existing) {
            await this.ingestBlob(undefined, rel, true)
          } else if (this.session.files.get(existing)?.blob?.hash !== await sha256Hex(data)) {
            await this.keepBlobConflictCopy(rel, data)
          }
        }
      }
      this.pendingNew.clear()
      for (const rel of Array.from(this.pendingUploads)) {
        if (this.io.isFile(this.abs(rel))) await this.ingestBlob(this.session.fileAt(rel), rel, true)
        else this.pendingUploads.delete(rel)
      }
      for (const [f] of this.session.liveFiles()) await this.materialize(f)
      for (const [f] of this.session.liveFolders()) await this.materializeFolder(f)
      await this.reconcileFolders()
      await this.upgradeCanvases()
    })
  }

  private kindOf (f: string): FileKind | undefined { return this.session.files.get(f)?.kind }

  private async reconcileFolders (): Promise<void> {
    const folders = this.io.listFolders(this.root).sort((a, b) => b.length - a.length)
    for (const path of folders) {
      const rel = this.rel(path)
      if (!rel || this.session.folderAt(rel)) continue
      const gone = Array.from(this.session.files.values()).find((file) => file.kind === 'folder' && file.deleted && file.path === rel && this.base.has(file.id))
      if (gone) {
        this.forgetBase(gone.id)
        await this.dropFolder(path)
        continue
      }
      if (this.session.canWrite) this.setBase(this.session.createFolder(rel), { folder: true })
    }
  }

  private async materializeFolder (f: string): Promise<void> {
    const rel = this.session.pathOf(f)
    if (!rel || this.kindOf(f) !== 'folder') return
    const path = this.abs(rel)
    if (!this.io.isFolder(path)) {
      if (this.present.has(f)) return
      await this.io.ensureFolder(path)
    }
    this.setBase(f, { folder: true })
  }

  private async dropFolder (path: string): Promise<void> {
    const rel = this.rel(path)
    if (!rel || this.session.folderAt(rel) || !this.io.isFolder(path) || !this.io.isEmptyFolder(path)) return
    this.ownRemovals.add(path)
    await this.io.removeFolder(path)
    await this.pruneFolders(path)
  }

  private async moveFolderOnDisk (f: string, oldRel: string, newRel: string): Promise<void> {
    if (this.kindOf(f) !== 'folder' || this.session.pathOf(f) !== newRel) return
    await this.io.ensureFolder(this.abs(newRel))
    this.setBase(f, { folder: true })
    if (oldRel && oldRel !== newRel) await this.dropFolder(this.abs(oldRel))
  }

  private async removeFolderFromDisk (f: string, oldRel: string): Promise<void> {
    this.forgetBase(f)
    this.present.delete(f)
    if (oldRel) await this.dropFolder(this.abs(oldRel))
  }

  onLocalFolder (path: string): void {
    const rel = this.rel(path)
    if (!rel) return
    void this.enqueue(async () => {
      if (!this.live || !this.session.canWrite) return
      if (!this.io.isFolder(path) || this.rel(path) !== rel || this.session.folderAt(rel)) return
      this.setBase(this.session.createFolder(rel), { folder: true })
    })
  }

  private contentOf (f: string): string {
    if (this.kindOf(f) !== 'canvas') return this.session.text(f).toJSON()
    return formatCanvas(toLocalCanvas(parseCanvas(readCanvas(this.session.doc(f))) ?? {}, this.root))
  }

  private sharedCanvas (data: CanvasData): string {
    return formatCanvas(toSharedCanvas(data, this.root))
  }

  private createCanvasFrom (rel: string, raw: string): string {
    const created = this.session.createCanvas(rel, this.sharedCanvas(parseCanvas(raw) ?? {}))
    this.setBase(created, { text: this.contentOf(created) })
    return created
  }

  private async upgradeCanvases (): Promise<void> {
    if (!this.session.isOwner) return
    for (const [f, rel] of this.session.liveFiles()) {
      if (this.kindOf(f) !== 'blob' || !isCanvasPath(rel)) continue
      const path = this.abs(rel)
      if (!this.io.isFile(path)) continue
      const raw = await this.io.read(path)
      if (!parseCanvas(raw)) continue
      this.session.remove(f)
      this.forgetBase(f)
      this.createCanvasFrom(rel, raw)
    }
  }

  private normalize (kind: FileKind, text: string): string | null {
    return kind === 'canvas' ? normalizeCanvas(text) : text
  }

  private async materialize (f: string): Promise<void> {
    const kind = this.kindOf(f)
    if (kind === 'blob') await this.downloadIfNeeded(f)
    else if (kind === 'folder') await this.materializeFolder(f)
    else if (kind) await this.flushText(f)
  }

  private async ingest (f: string | undefined, rel: string, upload: boolean): Promise<void> {
    const kind = f ? this.kindOf(f) ?? kindOfPath(rel) : kindOfPath(rel)
    if (kind === 'blob') { await this.ingestBlob(f, rel, upload); return }
    const disk = await this.io.read(this.abs(rel))
    if (kind === 'canvas') await this.ingestCanvas(f, rel, disk)
    else await this.ingestText(f, rel, disk)
  }

  retryPending (): Promise<void> {
    return this.enqueue(async () => {
      for (const rel of Array.from(this.pendingUploads)) {
        if (this.io.isFile(this.abs(rel))) await this.ingestBlob(this.session.fileAt(rel), rel, true)
        else this.pendingUploads.delete(rel)
      }
      for (const f of Array.from(this.pendingDownloads)) await this.downloadIfNeeded(f)
    })
  }

  private onShareChange (change: ShareChange): void {
    const kind = this.session.files.get(change.f)?.kind
    switch (change.kind) {
      case 'live':
        if (kind === 'blob') void this.enqueue(() => this.downloadIfNeeded(change.f))
        else if (kind === 'folder') void this.enqueue(() => this.materializeFolder(change.f))
        else this.scheduleWrite(change.f)
        break
      case 'content':
        this.scheduleWrite(change.f)
        break
      case 'blob':
        void this.enqueue(() => this.downloadIfNeeded(change.f))
        break
      case 'path':
        if (kind === 'folder') void this.enqueue(() => this.moveFolderOnDisk(change.f, change.oldPath ?? '', change.path ?? ''))
        else void this.enqueue(() => this.moveOnDisk(change.f, change.oldPath ?? '', change.path ?? ''))
        break
      case 'gone':
        if (kind === 'folder') void this.enqueue(() => this.removeFolderFromDisk(change.f, change.oldPath ?? ''))
        else void this.enqueue(() => this.removeFromDisk(change.f, change.oldPath ?? ''))
        break
    }
  }

  private scheduleWrite (f: string, delay = 60): void {
    if (this.held(f)) return
    const existing = this.writeTimers.get(f)
    if (existing) cancel(existing)
    this.writeTimers.set(f, later(() => {
      this.writeTimers.delete(f)
      void this.enqueue(() => this.flushText(f))
    }, delay))
  }

  private held (f: string): boolean { return (this.bound.get(f) ?? 0) > 0 }

  private openElsewhere (f: string, path: string): boolean {
    return this.kindOf(f) === 'text' && (this.o.isOpen?.(path) ?? false)
  }

  private async flushText (f: string): Promise<void> {
    if (this.held(f)) return
    const rel = this.session.pathOf(f)
    const kind = this.kindOf(f)
    if (!rel || (kind !== 'text' && kind !== 'canvas')) return
    const path = this.abs(rel)
    const content = this.contentOf(f)
    if (this.io.isFile(path)) {
      const raw = await this.io.read(path)
      const disk = this.normalize(kind, raw)
      if (disk === content) { this.setBase(f, { text: content }); return }
      const base = this.base.get(f)?.text
      if (disk !== null && base !== undefined && disk !== base && this.session.canWrite) {
        if (kind === 'canvas') await this.ingestCanvas(f, rel, raw)
        else await this.ingestText(f, rel, raw)
        return
      }
    } else if (this.present.has(f)) {
      return
    }
    if (this.held(f) || this.session.pathOf(f) !== rel) return
    if (this.openElsewhere(f, path)) { this.deferred.add(f); return }
    await this.io.write(path, content)
    this.setBase(f, { text: content })
  }

  private async downloadIfNeeded (f: string): Promise<void> {
    const blob = this.session.files.get(f)?.blob
    const rel = this.session.pathOf(f)
    if (!blob || !rel) { this.pendingDownloads.delete(f); return }
    const path = this.abs(rel)
    if (!this.io.isFile(path) && this.present.has(f)) { this.pendingDownloads.delete(f); return }
    if (this.io.isFile(path)) {
      const hash = await sha256Hex(await this.io.readBinary(path))
      if (hash === blob.hash) { this.setBase(f, { hash }); this.pendingDownloads.delete(f); return }
      const base = this.base.get(f)?.hash
      if (base !== undefined && hash !== base && this.session.canWrite) { await this.ingestBlob(f, rel, true); return }
    }
    try {
      const data = await this.session.downloadBlob(f, blob)
      if (await sha256Hex(data) !== blob.hash) throw new Error('attachment does not match its hash')
      if (this.session.files.get(f)?.blob?.id !== blob.id || this.session.pathOf(f) !== rel) return
      await this.io.writeBinary(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      this.setBase(f, { hash: blob.hash })
      this.pendingDownloads.delete(f)
    } catch (err) {
      this.pendingDownloads.add(f)
      this.o.log?.('download failed', rel, err)
    }
  }

  private async moveOnDisk (f: string, oldRel: string, newRel: string): Promise<void> {
    const from = this.abs(oldRel)
    const to = this.abs(newRel)
    if (this.io.isFile(from) && !this.io.isFile(to)) {
      await this.io.rename(from, to)
      await this.pruneFolders(from)
      return
    }
    await this.materialize(f)
  }

  private async pruneFolders (path: string): Promise<void> {
    let dir = path.split('/').slice(0, -1).join('/')
    while (dir.startsWith(this.root + '/') && this.io.isEmptyFolder(dir) && !this.session.folderAt(dir.slice(this.root.length + 1))) {
      this.ownRemovals.add(dir)
      await this.io.removeFolder(dir)
      dir = dir.split('/').slice(0, -1).join('/')
    }
  }

  private async removeFromDisk (f: string, oldRel: string): Promise<void> {
    const path = this.abs(oldRel)
    const file = this.session.files.get(f)
    if (!oldRel || !this.io.isFile(path)) { this.forgetBase(f); return }
    if (!this.held(f) && this.session.canWrite) {
      const base = this.base.get(f)
      if ((file?.kind === 'text' || file?.kind === 'canvas') && base?.text !== undefined) {
        const raw = await this.io.read(path)
        const disk = this.normalize(file.kind, raw)
        if (disk !== null && disk !== base.text) {
          this.forgetBase(f)
          if (!this.session.fileAt(oldRel)) {
            if (file.kind === 'canvas') this.createCanvasFrom(oldRel, raw)
            else this.setBase(this.session.createText(oldRel, raw), { text: disk })
          }
          return
        }
      } else if (file?.kind === 'blob' && base?.hash !== undefined) {
        const data = await this.io.readBinary(path)
        if (await sha256Hex(data) !== base.hash) {
          this.forgetBase(f)
          if (!this.session.fileAt(oldRel)) await this.ingestBlob(undefined, oldRel, true)
          return
        }
      }
    }
    if (this.session.fileAt(oldRel)) return
    this.ownRemovals.add(path)
    await this.io.remove(path)
    this.forgetBase(f)
    this.present.delete(f)
    this.bound.delete(f)
    await this.pruneFolders(path)
  }

  onLocalChange (path: string): void {
    const rel = this.rel(path)
    if (!rel) return
    const f = this.session.fileAt(rel)
    if (f && this.held(f)) return
    void this.enqueue(async () => {
      if (!this.io.isFile(path) || this.rel(path) !== rel) return
      const current = this.session.fileAt(rel)
      if (current && this.held(current)) return
      await this.ingest(current, rel, this.live)
    })
  }

  onLocalDelete (path: string): void {
    if (this.ownRemovals.delete(path)) return
    if (path === this.root || this.root.startsWith(path + '/')) { this.o.onRootMissing?.(); return }
    const rel = this.rel(path)
    if (!rel) return
    this.pendingDeletes.add(rel)
    if (this.deleteTimer) cancel(this.deleteTimer)
    this.deleteTimer = later(() => this.flushDeletes(), 300)
  }

  private flushDeletes (): void {
    this.deleteTimer = null
    const rels = Array.from(this.pendingDeletes)
    this.pendingDeletes.clear()
    if (!this.io.isFolder(this.root)) { this.o.onRootMissing?.(); return }
    const gone = new Set<string>()
    for (const rel of rels) {
      for (const [f, path] of this.session.liveFiles()) {
        const known = this.present.has(f) || this.held(f)
        if (known && (path === rel || path.startsWith(rel + '/')) && !this.io.isFile(this.abs(path))) gone.add(f)
      }
    }
    const goneFolders = new Set<string>()
    for (const rel of rels) {
      for (const [f, path] of this.session.liveFolders()) {
        if (this.present.has(f) && (path === rel || path.startsWith(rel + '/')) && !this.io.isFolder(this.abs(path))) goneFolders.add(f)
      }
    }
    if (gone.size === 0 && goneFolders.size === 0) return
    if (!this.session.canDelete) {
      this.denied('You can\'t delete files in this shared folder, so they were put back.')
      for (const f of gone) {
        this.forgetBase(f)
        this.present.delete(f)
        if (this.kindOf(f) === 'blob') void this.enqueue(() => this.downloadIfNeeded(f))
        else this.scheduleWrite(f, 0)
      }
      for (const f of goneFolders) {
        this.present.delete(f)
        void this.enqueue(() => this.materializeFolder(f))
      }
      return
    }
    for (const f of gone) {
      this.session.remove(f)
      this.forgetBase(f)
      this.present.delete(f)
      this.bound.delete(f)
    }
    for (const f of goneFolders) {
      this.session.remove(f)
      this.forgetBase(f)
      this.present.delete(f)
    }
  }

  onLocalRename (oldPath: string, newPath: string, isFolder: boolean): void {
    const oldRel = this.rel(oldPath)
    const newRel = this.rel(newPath)
    if (oldRel && newRel) {
      const pairs: Array<[string, string, string]> = []
      for (const [f, path] of this.session.liveFiles()) {
        if (isFolder ? path.startsWith(oldRel + '/') : path === oldRel) pairs.push([f, path, isFolder ? newRel + path.slice(oldRel.length) : newRel])
      }
      const folderPairs: Array<[string, string]> = []
      if (isFolder) {
        for (const [f, path] of this.session.liveFolders()) {
          if (path === oldRel || path.startsWith(oldRel + '/')) folderPairs.push([f, newRel + path.slice(oldRel.length)])
        }
      }
      if (pairs.length === 0 && folderPairs.length === 0) {
        if (isFolder) this.onLocalFolder(newPath)
        else this.onLocalChange(newPath)
        return
      }
      if (!this.session.canWrite) {
        this.denied('This shared folder is read-only for you, so the rename was undone.')
        void this.enqueue(() => this.io.rename(newPath, oldPath))
        return
      }
      for (const [f, , to] of pairs) this.session.rename(f, to)
      for (const [f, to] of folderPairs) this.session.rename(f, to)
      if (isFolder && !this.session.folderAt(newRel)) this.setBase(this.session.createFolder(newRel), { folder: true })
    } else if (oldRel) {
      this.onLocalDelete(oldPath)
    } else if (newRel) {
      if (isFolder) void this.enqueue(() => this.scanForNew())
      else this.onLocalChange(newPath)
    }
  }

  private async scanForNew (): Promise<void> {
    for (const path of this.io.listFiles(this.root)) {
      const rel = this.rel(path)
      if (!rel || this.session.fileAt(rel)) continue
      await this.ingest(undefined, rel, this.live)
    }
    if (!this.live || !this.session.canWrite) return
    for (const path of this.io.listFolders(this.root)) {
      const rel = this.rel(path)
      if (rel && !this.session.folderAt(rel)) this.setBase(this.session.createFolder(rel), { folder: true })
    }
  }

  private async ingestText (f: string | undefined, rel: string, disk: string): Promise<void> {
    if (!f) {
      if (!this.live) { this.pendingNew.add(rel); return }
      if (!this.session.canWrite) { this.denied('This shared folder is read-only for you, so new files in it are not shared.'); return }
      this.setBase(this.session.createText(rel, disk), { text: disk })
      this.o.onTracked?.()
      return
    }
    const ytext = this.session.text(f)
    const current = ytext.toJSON()
    if (disk === current) { this.setBase(f, { text: disk }); return }
    const base = this.base.get(f)?.text
    if (base === undefined || disk === base) { this.scheduleWrite(f, 0); return }
    if (!this.session.canWrite) {
      this.denied('This shared folder is read-only for you, so your changes were undone.')
      this.scheduleWrite(f, 0)
      return
    }
    const merged = threeWay(base, disk, current)
    if (!merged.clean) await this.keepConflictCopy(rel, disk)
    this.applyText(ytext, merged.text)
    if (merged.text === disk) { this.setBase(f, { text: disk }); return }
    if (this.held(f)) return
    if (this.openElsewhere(f, this.abs(rel))) {
      this.setBase(f, { text: disk })
      this.deferred.add(f)
      return
    }
    await this.io.write(this.abs(rel), merged.text)
    this.setBase(f, { text: merged.text })
  }

  private async ingestCanvas (f: string | undefined, rel: string, disk: string): Promise<void> {
    const next = parseCanvas(disk)
    if (!next) return
    const normalized = formatCanvas(next)
    if (!f) {
      if (!this.live) { this.pendingNew.add(rel); return }
      if (!this.session.canWrite) { this.denied('This shared folder is read-only for you, so new files in it are not shared.'); return }
      this.createCanvasFrom(rel, disk)
      this.o.onTracked?.()
      return
    }
    const doc = this.session.doc(f)
    const current = this.contentOf(f)
    if (normalized === current) { this.setBase(f, { text: current }); return }
    const base = this.base.get(f)?.text
    if (base === undefined || normalized === base) { this.scheduleWrite(f, 0); return }
    if (!this.session.canWrite) {
      this.denied('This shared folder is read-only for you, so your changes were undone.')
      this.scheduleWrite(f, 0)
      return
    }
    const baseData = parseCanvas(base)
    doc.transact(() => applyCanvas(doc, baseData ? toSharedCanvas(baseData, this.root) : null, toSharedCanvas(next, this.root)), LOCAL)
    const merged = this.contentOf(f)
    if (merged !== normalized) await this.io.write(this.abs(rel), merged)
    this.setBase(f, { text: merged })
  }

  private applyText (ytext: Y.Text, next: string): void {
    ytext.doc?.transact(() => applyToYText(ytext, next), LOCAL)
  }

  private async ingestBlob (f: string | undefined, rel: string, upload: boolean): Promise<void> {
    const data = new Uint8Array(await this.io.readBinary(this.abs(rel)))
    const hash = await sha256Hex(data)
    if (!f) {
      if (!this.live || !upload) { this.pendingNew.add(rel); return }
      if (!this.session.canWrite) { this.denied('This shared folder is read-only for you, so new files in it are not shared.'); return }
      try {
        this.setBase(await this.session.createBlob(rel, data, hash), { hash })
        this.pendingUploads.delete(rel)
      } catch (err) {
        this.pendingUploads.add(rel)
        this.o.log?.('upload failed', rel, err)
      }
      return
    }
    const blob = this.session.files.get(f)?.blob
    if (blob?.hash === hash) { this.setBase(f, { hash }); this.pendingUploads.delete(rel); return }
    const base = this.base.get(f)?.hash
    if (base === undefined || base === hash || !this.session.canWrite) {
      if (base !== undefined && base !== hash) this.denied('This shared folder is read-only for you, so your changes were undone.')
      this.pendingDownloads.add(f)
      if (this.live) await this.downloadIfNeeded(f)
      return
    }
    if (!upload) { this.pendingUploads.add(rel); return }
    try {
      await this.session.updateBlob(f, data, hash)
      this.setBase(f, { hash })
      this.pendingUploads.delete(rel)
    } catch (err) {
      this.pendingUploads.add(rel)
      this.o.log?.('upload failed', rel, err)
    }
  }

  private conflictName (rel: string): string {
    const slash = rel.lastIndexOf('/')
    const dir = slash >= 0 ? rel.slice(0, slash + 1) : ''
    const file = rel.slice(slash + 1)
    const dot = file.lastIndexOf('.')
    const stem = dot > 0 ? file.slice(0, dot) : file
    const ext = dot > 0 ? file.slice(dot) : ''
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
    for (let i = 1; ; i++) {
      const candidate = `${dir}${stem} (conflict ${stamp}${i > 1 ? ` ${i}` : ''})${ext}`
      if (!this.session.fileAt(candidate) && !this.io.isFile(this.abs(candidate))) return candidate
    }
  }

  private async keepConflictCopy (rel: string, content: string): Promise<void> {
    const name = this.conflictName(rel)
    await this.io.write(this.abs(name), content)
    if (this.session.canWrite) {
      if (isCanvasPath(name)) {
        this.createCanvasFrom(name, content)
      } else {
        this.setBase(this.session.createText(name, content), { text: content })
      }
    }
    this.o.onConflict?.(this.abs(name))
  }

  private async keepBlobConflictCopy (rel: string, data: ArrayBuffer): Promise<void> {
    const name = this.conflictName(rel)
    await this.io.writeBinary(this.abs(name), data)
    if (this.session.canWrite) await this.ingestBlob(undefined, name, true)
    this.o.onConflict?.(this.abs(name))
  }

  retryDeferred (): void {
    for (const f of Array.from(this.deferred)) {
      this.deferred.delete(f)
      this.scheduleWrite(f, 0)
    }
  }

  bind (f: string, editorText: string): { ytext: Y.Text, readOnly: boolean } {
    this.deferred.delete(f)
    const timer = this.writeTimers.get(f)
    if (timer) { cancel(timer); this.writeTimers.delete(f) }
    const ytext = this.session.text(f)
    const current = ytext.toJSON()
    const base = this.base.get(f)?.text
    if (this.session.canWrite && editorText !== current && base !== undefined && editorText !== base) {
      const merged = threeWay(base, editorText, current)
      if (!merged.clean) {
        const rel = this.session.pathOf(f)
        if (rel) void this.enqueue(() => this.keepConflictCopy(rel, editorText))
      }
      this.applyText(ytext, merged.text)
    }
    this.bound.set(f, (this.bound.get(f) ?? 0) + 1)
    this.present.add(f)
    this.forgetBase(f)
    return { ytext, readOnly: !this.session.canWrite }
  }

  unbind (f: string): void {
    const count = this.bound.get(f) ?? 0
    if (count === 0) return
    if (count > 1) { this.bound.set(f, count - 1); return }
    this.bound.delete(f)
    this.scheduleWrite(f, 0)
  }
}
