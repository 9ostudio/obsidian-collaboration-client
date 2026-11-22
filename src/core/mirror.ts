import { sha256Hex } from './crypto'
import type { VaultIO } from './engine'
import { cancel, later, type Timer } from './timers'

export interface ExternalStat { size: number, mtime: number }

export interface ExternalFS {
  exists: (dir: string) => Promise<boolean>
  list: (dir: string) => Promise<{ files: string[], dirs: string[] }>
  stat: (dir: string, rel: string) => Promise<ExternalStat | null>
  read: (dir: string, rel: string) => Promise<Uint8Array>
  write: (dir: string, rel: string, data: Uint8Array) => Promise<void>
  remove: (dir: string, rel: string) => Promise<void>
  makeDir: (dir: string, rel: string) => Promise<void>
  removeDir: (dir: string, rel: string) => Promise<boolean>
  watch: (dir: string, onChange: () => void) => () => void
}

export type MirrorState = Record<string, string>

export interface MirrorOptions {
  vaultDir: () => string
  external: string
  io: VaultIO
  fs: ExternalFS
  load: () => Promise<MirrorState>
  save: (state: MirrorState) => Promise<void>
  onPaused?: (reason: string) => void
  onConflict?: (path: string) => void
  onRefused?: () => void
  onFolder?: (path: string) => void
  canWrite?: () => boolean
  canDelete?: () => boolean
  isOpen?: (path: string) => boolean
  log?: (...args: unknown[]) => void
}

interface Fingerprint { size: number, mtime: number, hash: string }

const TEXT = /\.(md|txt|canvas|base)$/i
const MAX_DELETES = 10
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

function conflictName (rel: string, taken: (rel: string) => boolean): string {
  const slash = rel.lastIndexOf('/')
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : ''
  const file = rel.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot) : ''
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
  for (let i = 1; ; i++) {
    const candidate = `${dir}${stem} (conflict ${stamp}${i > 1 ? ` ${i}` : ''})${ext}`
    if (!taken(candidate)) return candidate
  }
}

const toBuffer = (data: Uint8Array): ArrayBuffer => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer

export class LinkMirror {
  paused = false
  private known = new Map<string, string>()
  private readonly knownDirs = new Set<string>()
  private readonly vaultPrints = new Map<string, Fingerprint>()
  private readonly externalPrints = new Map<string, Fingerprint>()
  private queue: Promise<void> = Promise.resolve()
  private syncTimer: Timer | null = null
  private scanTimer: Timer | null = null
  private saveTimer: Timer | null = null
  private unwatch: (() => void) | null = null
  private stopped = false
  private blocked = false
  private readonly refused = new Set<string>()
  private externalNames = new Set<string>()

  constructor (private readonly o: MirrorOptions) {}

  get external (): string { return this.o.external }

  async start (): Promise<void> {
    for (const [key, value] of Object.entries(await this.o.load())) {
      if (key.endsWith('/')) this.knownDirs.add(key.slice(0, -1))
      else this.known.set(key, value)
    }
    await this.enqueue(() => this.syncAll())
    if (this.stopped) return
    this.watch()
    this.loop()
  }

  private watch (): void {
    this.unwatch?.()
    this.unwatch = this.o.fs.watch(this.o.external, () => this.schedule())
  }

  private loop (): void {
    this.scanTimer = later(() => {
      void this.enqueue(() => this.syncAll()).then(() => { if (!this.stopped) this.loop() })
    }, 30000)
  }

  stop (): void {
    this.stopped = true
    this.unwatch?.()
    for (const timer of [this.syncTimer, this.scanTimer, this.saveTimer]) cancel(timer)
    if (this.saveTimer) void this.persist()
  }

  resume (): void {
    this.paused = false
    if (!this.stopped) this.watch()
    this.schedule(0)
  }

  covers (path: string): boolean {
    const dir = this.o.vaultDir()
    return path === dir || path.startsWith(dir + '/')
  }

  schedule (delay = 250): void {
    if (this.stopped) return
    cancel(this.syncTimer)
    this.syncTimer = later(() => {
      this.syncTimer = null
      void this.enqueue(() => this.syncAll())
    }, delay)
  }

  idle (): Promise<void> {
    return this.queue
  }

  private enqueue (fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => { if (!this.stopped && !this.paused) await fn() }).catch((err) => this.o.log?.('link sync failed', err))
    this.queue = run
    return run
  }

  private pause (reason: string): void {
    if (this.paused) return
    this.paused = true
    this.o.onPaused?.(reason)
  }

  private async vaultHash (rel: string, path: string): Promise<string> {
    const stat = this.o.io.stat?.(path) ?? null
    const cached = this.vaultPrints.get(rel)
    if (stat && cached && cached.size === stat.size && cached.mtime === stat.mtime) return cached.hash
    const hash = await sha256Hex(await this.o.io.readBinary(path))
    if (stat) this.vaultPrints.set(rel, { ...stat, hash })
    return hash
  }

  private async externalHash (rel: string, stat: ExternalStat): Promise<string> {
    const cached = this.externalPrints.get(rel)
    if (cached && cached.size === stat.size && cached.mtime === stat.mtime) return cached.hash
    const hash = await sha256Hex(await this.o.fs.read(this.o.external, rel))
    this.externalPrints.set(rel, { ...stat, hash })
    return hash
  }

  private async syncAll (): Promise<void> {
    const dir = this.o.vaultDir()
    if (!this.o.io.isFolder(dir)) { this.pause(`the folder “${dir}” is missing in the vault`); return }
    if (!(await this.o.fs.exists(this.o.external))) { this.pause(`the linked folder “${this.o.external}” is missing`); return }
    const vaultRels = new Set(this.o.io.listFiles(dir).map((p) => p.slice(dir.length + 1)))
    const externalRels = new Set((await this.o.fs.list(this.o.external)).files)
    this.externalNames = externalRels
    const all = new Set([...vaultRels, ...externalRels, ...this.known.keys()])
    let deletes = 0
    for (const rel of all) {
      const known = this.known.get(rel)
      if (known !== undefined && vaultRels.has(rel) !== externalRels.has(rel)) deletes++
    }
    if (deletes > MAX_DELETES && deletes > this.known.size / 2) {
      this.pause(`${deletes} files disappeared from one side at once`)
      return
    }
    for (const rel of all) await this.syncOne(dir, rel)
    await this.syncDirs(dir)
    if (this.blocked) {
      this.blocked = false
      this.o.onRefused?.()
    }
  }

  private refuse (rel: string): void {
    if (this.refused.has(rel)) return
    this.refused.add(rel)
    this.blocked = true
  }

  private async toVault (dir: string, rel: string, data?: Uint8Array): Promise<boolean> {
    const path = `${dir}/${rel}`
    if (TEXT.test(rel) && this.o.isOpen?.(path)) return false
    const bytes = data ?? await this.o.fs.read(this.o.external, rel)
    if (TEXT.test(rel)) await this.o.io.write(path, decoder.decode(bytes))
    else await this.o.io.writeBinary(path, toBuffer(bytes))
    return true
  }

  private async toExternal (rel: string, path: string): Promise<void> {
    await this.o.fs.write(this.o.external, rel, new Uint8Array(await this.o.io.readBinary(path)))
  }

  private async syncOne (dir: string, rel: string): Promise<void> {
    const path = `${dir}/${rel}`
    const stat = await this.o.fs.stat(this.o.external, rel)
    const v = this.o.io.isFile(path) ? await this.vaultHash(rel, path) : null
    const e = stat ? await this.externalHash(rel, stat) : null
    const known = this.known.get(rel)
    const write = this.o.canWrite?.() ?? true
    if (v === e) {
      this.remember(rel, v)
      return
    }
    if (v !== null && e !== null) {
      if (known === e) {
        await this.toExternal(rel, path)
        this.remember(rel, v)
      } else if (known === v) {
        if (!write) this.refuse(rel)
        else if (await this.toVault(dir, rel)) this.remember(rel, e)
      } else {
        await this.conflict(dir, rel, path, stat?.mtime ?? 0, write)
      }
      return
    }
    if (v !== null) {
      if (known !== v) {
        await this.toExternal(rel, path)
        this.remember(rel, v)
      } else if (!(this.o.canDelete?.() ?? true)) {
        this.refuse(rel)
      } else {
        await this.o.io.remove(path)
        this.remember(rel, null)
      }
      return
    }
    if (e !== null) {
      if (known === e) {
        await this.o.fs.remove(this.o.external, rel)
        this.remember(rel, null)
      } else if (!write) {
        this.refuse(rel)
      } else if (await this.toVault(dir, rel)) {
        this.remember(rel, e)
      }
    }
  }

  private async syncDirs (dir: string): Promise<void> {
    const vaultDirs = new Set(this.o.io.listFolders(dir).map((p) => p.slice(dir.length + 1)))
    const externalDirs = new Set((await this.o.fs.list(this.o.external)).dirs)
    const all = Array.from(new Set([...vaultDirs, ...externalDirs, ...this.knownDirs])).sort((a, b) => b.length - a.length)
    const write = this.o.canWrite?.() ?? true
    const remove = this.o.canDelete?.() ?? true
    for (const rel of all) {
      const path = `${dir}/${rel}`
      const inVault = vaultDirs.has(rel)
      const inExternal = externalDirs.has(rel)
      const known = this.knownDirs.has(rel)
      if (inVault && !inExternal) {
        if (known && this.o.io.isEmptyFolder(path)) {
          if (!remove) { this.refuse(`${rel}/`); continue }
          await this.o.io.removeFolder(path)
          this.rememberDir(rel, false)
          continue
        }
        await this.o.fs.makeDir(this.o.external, rel)
      } else if (inExternal && !inVault) {
        if (known && await this.o.fs.removeDir(this.o.external, rel)) { this.rememberDir(rel, false); continue }
        if (!write) { this.refuse(`${rel}/`); continue }
        await this.o.io.ensureFolder(path)
        this.o.onFolder?.(path)
      } else if (!inVault && !inExternal) {
        this.rememberDir(rel, false)
        continue
      }
      this.rememberDir(rel, true)
    }
  }

  private rememberDir (rel: string, present: boolean): void {
    this.refused.delete(`${rel}/`)
    if (this.knownDirs.has(rel) === present) return
    if (present) this.knownDirs.add(rel)
    else this.knownDirs.delete(rel)
    cancel(this.saveTimer)
    this.saveTimer = later(() => { void this.persist() }, 500)
  }

  private async conflict (dir: string, rel: string, path: string, externalTime: number, write: boolean): Promise<void> {
    const externalWins = write && externalTime >= (this.o.io.stat?.(path)?.mtime ?? 0)
    if (externalWins && TEXT.test(rel) && this.o.isOpen?.(path)) return
    const external = await this.o.fs.read(this.o.external, rel)
    const vault = new Uint8Array(await this.o.io.readBinary(path))
    const copy = conflictName(rel, (c) => this.known.has(c) || this.o.io.isFile(`${dir}/${c}`) || this.externalNames.has(c))
    const loser = externalWins ? vault : external
    await this.o.fs.write(this.o.external, copy, loser)
    if (write) {
      await this.toVault(dir, copy, loser)
      this.remember(copy, await sha256Hex(loser))
    }
    if (externalWins) {
      await this.toVault(dir, rel, external)
      this.remember(rel, await sha256Hex(external))
    } else {
      await this.o.fs.write(this.o.external, rel, vault)
      this.remember(rel, await sha256Hex(vault))
    }
    this.o.onConflict?.(write ? `${dir}/${copy}` : `${this.o.external}/${copy}`)
  }

  private remember (rel: string, hash: string | null): void {
    this.refused.delete(rel)
    if ((this.known.get(rel) ?? null) === hash) return
    if (hash === null) this.known.delete(rel)
    else this.known.set(rel, hash)
    cancel(this.saveTimer)
    this.saveTimer = later(() => { void this.persist() }, 500)
  }

  private async persist (): Promise<void> {
    this.saveTimer = null
    const state: MirrorState = Object.fromEntries(this.known)
    for (const rel of this.knownDirs) state[`${rel}/`] = 'dir'
    await this.o.save(state)
  }
}
