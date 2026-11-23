import { App, FileSystemAdapter, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, normalizePath, requestUrl } from 'obsidian'
import { Api, ApiError, normalizeServer, parseInvite, type HttpFn, type MemberRecord, type Perms, type ShareSummary } from './core/api'
import { Cipher, INVITE_PURPOSE, exportPublicKey, fromB64, fromB64Url, fromUtf8, generateDeviceKeys, newKey, openWithSecret, randomBytes, randomId, sealWithSecret, toB64, toB64Url, utf8, type Keyring } from './core/crypto'
import { SyncEngine, isTextPath, type VaultIO } from './core/engine'
import { buildVersions } from './core/history'
import { LinkMirror, type MirrorState } from './core/mirror'
import { ShareSession, openSharedKey, type EventType } from './core/share'
import { IdbStore } from './core/store'
import { AttachmentRouter } from './attachments'
import { CollaborationSettingTab } from './settings'
import { CanvasSaver } from './ui/canvas'
import { EditorBindings, type BindTarget } from './ui/editor'
import { FolderBadges, type FolderBadge } from './ui/folders'
import { desktopFS, folderPicker, makeFolder } from './node-fs'
import { ConfirmModal, DeletedFilesModal, HistoryModal, InviteModal, LinkModal, ManageModal, TextPromptModal, askText, type ManagedMember } from './ui/modals'

export interface ShareRecord { id: string, name: string, path: string, role: 'owner' | 'member' }

interface IdentityRecord { userId: string, secret: string, publicKey: string, privateKey: CryptoKey }

export interface ActiveShare { record: ShareRecord, session: ShareSession, engine: SyncEngine, store: IdbStore }

interface FolderLink { shareId: string, sub: string, external: string }

const linkKey = (link: FolderLink): string => `${link.shareId}:${link.sub}`

const LOCAL_ID_KEY = 'collaboration-local-id'

const obsidianHttp: HttpFn = async (req) => {
  const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false })
  return { status: res.status, text: () => res.text, arrayBuffer: () => res.arrayBuffer }
}

const under = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')
const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/')

class ObsidianIO implements VaultIO {
  private readonly created = new Map<string, number>()

  constructor (private readonly app: App) {}

  createdBySync (path: string): boolean {
    const time = this.created.get(path)
    return time !== undefined && Date.now() - time < 10000
  }

  private markCreated (path: string): void {
    const now = Date.now()
    for (const [p, time] of this.created) if (now - time > 10000) this.created.delete(p)
    this.created.set(path, now)
  }

  private get (path: string): TAbstractFile | null { return this.app.vault.getAbstractFileByPath(path) }

  listFiles (root: string): string[] {
    const folder = this.get(root)
    if (!(folder instanceof TFolder)) return []
    const out: string[] = []
    const walk = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFile) out.push(child.path)
        else if (child instanceof TFolder) walk(child)
      }
    }
    walk(folder)
    return out
  }

  isFile (path: string): boolean { return this.get(path) instanceof TFile }
  isFolder (path: string): boolean { return this.get(path) instanceof TFolder }

  stat (path: string): { size: number, mtime: number } | null {
    const f = this.get(path)
    return f instanceof TFile ? { size: f.stat.size, mtime: f.stat.mtime } : null
  }

  async read (path: string): Promise<string> {
    const f = this.get(path)
    if (!(f instanceof TFile)) throw new Error(`not a file: ${path}`)
    return this.app.vault.read(f)
  }

  async readBinary (path: string): Promise<ArrayBuffer> {
    const f = this.get(path)
    if (!(f instanceof TFile)) throw new Error(`not a file: ${path}`)
    return this.app.vault.readBinary(f)
  }

  listFolders (root: string): string[] {
    const folder = this.get(root)
    if (!(folder instanceof TFolder)) return []
    const out: string[] = []
    const walk = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFolder) { out.push(child.path); walk(child) }
      }
    }
    walk(folder)
    return out
  }

  async ensureFolder (path: string): Promise<void> {
    if (!path || this.get(path) instanceof TFolder) return
    await this.ensureFolder(parentOf(path))
    this.markCreated(path)
    await this.app.vault.createFolder(path).catch(() => undefined)
  }

  async write (path: string, text: string): Promise<void> {
    const f = this.get(path)
    if (f instanceof TFile) { await this.app.vault.process(f, () => text); return }
    await this.ensureFolder(parentOf(path))
    this.markCreated(path)
    await this.app.vault.create(path, text)
  }

  async writeBinary (path: string, data: ArrayBuffer): Promise<void> {
    const f = this.get(path)
    if (f instanceof TFile) { await this.app.vault.modifyBinary(f, data); return }
    await this.ensureFolder(parentOf(path))
    this.markCreated(path)
    await this.app.vault.createBinary(path, data)
  }

  async rename (from: string, to: string): Promise<void> {
    const f = this.get(from)
    if (!f) return
    await this.ensureFolder(parentOf(to))
    await this.app.vault.rename(f, to)
  }

  async remove (path: string): Promise<void> {
    const f = this.get(path)
    if (f) await this.app.fileManager.trashFile(f)
  }

  isEmptyFolder (path: string): boolean {
    const f = this.get(path)
    return f instanceof TFolder && f.children.length === 0
  }

  async removeFolder (path: string): Promise<void> {
    const f = this.get(path)
    if (f instanceof TFolder && f.children.length === 0) await this.app.fileManager.trashFile(f)
  }
}

export default class CollaborationPlugin extends Plugin {
  server = ''
  shares: Record<string, ShareRecord> = {}
  readonly active = new Map<string, ActiveShare>()
  private identity: IdentityRecord | null = null
  private api!: Api
  private io!: ObsidianIO
  private editors!: EditorBindings
  private attachments!: AttachmentRouter
  private canvases!: CanvasSaver
  private badges!: FolderBadges
  private meta!: IdbStore
  private localId = ''
  private statusEl!: HTMLElement
  private registered = false
  private checking: Promise<void> | null = null
  private readonly deniedAt = new Map<string, number>()
  private readonly pendingKeyrings = new Map<string, Keyring>()
  private readonly adopting = new Set<string>()
  private readonly desktop = desktopFS()
  private links: FolderLink[] = []
  private readonly mirrors = new Map<string, LinkMirror>()

  async onload (): Promise<void> {
    let localId = this.app.loadLocalStorage(LOCAL_ID_KEY) as string | null
    if (!localId) {
      localId = randomId()
      this.app.saveLocalStorage(LOCAL_ID_KEY, localId)
    }
    this.localId = localId
    this.meta = new IdbStore(`collaboration-${localId}`)
    this.io = new ObsidianIO(this.app)
    this.api = new Api(obsidianHttp, () => this.server, () => this.token(), (location) => { void this.serverMoved(location) })
    this.editors = new EditorBindings((path) => this.targetFor(path), () => {
      for (const a of this.active.values()) a.engine?.retryDeferred()
    })
    this.attachments = new AttachmentRouter(this.app, {
      rootFor: (path) => this.shareRootFor(path),
      canWrite: (root) => Array.from(this.active.values()).some((a) => (a.engine?.root ?? a.record.path) === root && a.session.canWrite),
      writtenBySync: (path) => this.io.createdBySync(path)
    })
    this.canvases = new CanvasSaver(this.app, this, (path) => this.shareRootFor(path) !== null)
    this.badges = new FolderBadges(this.app, () => this.folderBadges())
    this.registerEditorExtension(this.editors.extensions())
    this.statusEl = this.addStatusBarItem()
    this.addSettingTab(new CollaborationSettingTab(this.app, this))

    this.registerObsidianProtocolHandler('collaboration', (params) => { void this.handleLink(params) })
    this.addCommand({
      id: 'join',
      name: 'Join shared folder',
      callback: () => new TextPromptModal(this.app, {
        title: 'Join shared folder',
        desc: 'Paste the invite link you were sent.',
        placeholder: 'https://…/join/…',
        cta: 'Join',
        onSubmit: (value) => { void this.joinFromText(value) }
      }).open()
    })
    this.addCommand({
      id: 'version-history',
      name: 'Show version history of current file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile()
        if (!file || !this.fileTarget(file.path)) return false
        if (!checking) this.showHistory(file)
        return true
      }
    })
    this.addCommand({ id: 'check-access', name: 'Check shared folder access', callback: () => { void this.checkAccess(true) } })
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.fileMenu(menu, file)))
    this.app.workspace.onLayoutReady(() => { void this.start() })
  }

  onunload (): void {
    this.editors.unbindAll()
    this.canvases.stop()
    this.badges.stop()
    for (const a of this.active.values()) {
      a.engine.destroy()
      void a.session.close().then(() => a.store.close())
    }
    this.active.clear()
    this.meta.close()
  }

  private async start (): Promise<void> {
    const { vault, workspace } = this.app
    this.server = (await this.meta.get<string>('kv', 'server')) ?? ''
    this.shares = (await this.meta.get<Record<string, ShareRecord>>('kv', 'shares')) ?? {}
    this.identity = (await this.meta.get<IdentityRecord>('kv', 'identity')) ?? null
    this.links = (await this.meta.get<FolderLink[]>('kv', 'links')) ?? []
    this.registerEvent(vault.on('create', (f) => { this.attachments.onCreate(f); this.onVaultChange(f); this.onVaultFolder(f) }))
    this.registerEvent(vault.on('modify', (f) => {
      this.onVaultChange(f)
      if (f instanceof TFile && f.extension === 'canvas') void this.attachments.onCanvasChange(f)
    }))
    this.registerEvent(vault.on('delete', (f) => { this.onVaultDelete(f); this.badges.schedule() }))
    this.registerEvent(vault.on('rename', (f, old) => { this.attachments.onRename(f, old); this.onVaultRename(f, old); this.badges.schedule() }))
    this.registerEvent(this.app.metadataCache.on('resolve', (f) => this.attachments.onResolve(f)))
    this.registerEvent(workspace.on('layout-change', () => { this.editors.scheduleRefresh(); this.canvases.refresh(); this.badges.schedule() }))
    this.registerEvent(workspace.on('file-open', () => { this.editors.scheduleRefresh(); this.canvases.refresh() }))
    if (this.server) {
      await this.registerIdentity()
      for (const record of Object.values(this.shares)) void this.startShare(record)
      void this.checkAccess()
    }
    this.registerInterval(window.setInterval(() => { void this.checkAccess() }, 2 * 60 * 1000))
    this.updateStatus()
  }

  private async saveState (): Promise<void> {
    await this.meta.write([
      { table: 'kv', key: 'server', value: this.server },
      { table: 'kv', key: 'shares', value: this.shares }
    ])
  }

  private token (): string {
    return this.identity ? `${this.identity.userId}.${this.identity.secret}` : ''
  }

  private async ensureIdentity (): Promise<IdentityRecord> {
    if (this.identity) return this.identity
    const keys = await generateDeviceKeys()
    this.identity = {
      userId: crypto.randomUUID(),
      secret: toB64Url(randomBytes(32)),
      publicKey: await exportPublicKey(keys.publicKey),
      privateKey: keys.privateKey
    }
    await this.meta.write([{ table: 'kv', key: 'identity', value: this.identity }])
    return this.identity
  }

  private async registerIdentity (): Promise<boolean> {
    if (!this.server) return false
    const id = await this.ensureIdentity()
    try {
      await this.api.register(id.userId, id.secret, id.publicKey)
      this.registered = true
    } catch (err) {
      this.registered = false
      console.debug('[collaboration] register failed', err)
    }
    return this.registered
  }

  private async online (): Promise<boolean> {
    if (!this.server) {
      new Notice('Collaboration: open an invite or setup link first, or set the server in the plugin settings.', 10000)
      return false
    }
    if (this.registered || await this.registerIdentity()) return true
    new Notice('Collaboration: the server is unreachable. Try again when you are online.')
    return false
  }

  async setServer (input: string): Promise<boolean> {
    const url = normalizeServer(input)
    if (input.trim() && !url) { new Notice('Collaboration: that is not a valid server address.'); return false }
    if (url === this.server) return true
    if (Object.keys(this.shares).length > 0) {
      new Notice(`Collaboration: this vault already syncs folders with ${this.server}. Leave or stop sharing them before switching servers.`, 10000)
      return false
    }
    this.server = url
    this.registered = false
    await this.saveState()
    return true
  }

  private wsUrl (): string { return this.server.replace(/^http/, 'ws') + '/ws' }

  private async startShare (record: ShareRecord, keyring?: Keyring): Promise<void> {
    const ring = keyring ?? this.pendingKeyrings.get(record.id)
    try {
      await this.openShare(record, ring)
      this.pendingKeyrings.delete(record.id)
    } catch (err) {
      if (ring) this.pendingKeyrings.set(record.id, ring)
      const a = this.active.get(record.id)
      if (a) {
        this.active.delete(record.id)
        a.engine?.destroy()
        a.session.destroy()
      }
      console.error('[collaboration] could not start', record.name, err)
      this.denied(`“${record.name}” could not start syncing (${(err as Error).message}). It will try again in two minutes.`)
      this.updateStatus()
    }
  }

  private async openShare (record: ShareRecord, keyring?: Keyring): Promise<void> {
    if (this.active.has(record.id) || !this.identity) return
    const identity = this.identity
    const store = new IdbStore(`collaboration-${this.localId}-${record.id}`)
    const log = (...args: unknown[]): void => console.debug('[collaboration]', record.name, ...args)
    let engine: SyncEngine | null = null
    const session = new ShareSession({
      shareId: record.id,
      store,
      api: this.api,
      wsUrl: () => this.wsUrl(),
      identity: { userId: identity.userId, privateKey: identity.privateKey, token: () => this.token() },
      onReady: () => {
        void engine?.onReady().then(() => {
          this.editors.scheduleRefresh()
          this.startLinks(record.id)
        })
        void session.keepKeyForSelf(identity.publicKey).catch((err) => log('could not keep the key for other devices', err))
        this.updateStatus()
      },
      onResynced: () => { void engine?.retryPending() },
      onMembers: () => { this.editors.scheduleRefresh(); this.updateStatus() },
      onStatus: () => this.updateStatus(),
      onAccessLost: (code) => { void this.onAccessLost(code) },
      onMoved: () => { void this.api.checkMoved() },
      onRejected: (type, f, code) => this.onRejected(record, type, code),
      onSharePath: (path) => { void this.alignRoot(record.id, path) },
      log
    })
    this.active.set(record.id, { record, session, engine: null as unknown as SyncEngine, store })
    await session.load()
    if (keyring) session.setKeyring(keyring)
    engine = new SyncEngine({
      session,
      root: record.path,
      io: this.io,
      log,
      onRootMissing: () => this.onRootMissing(record),
      onConflict: (path) => new Notice(`Collaboration: edits made in two places couldn't be merged automatically. Your version was saved as “${path}”.`, 10000),
      onDenied: (message) => this.denied(message),
      onTracked: () => this.editors.scheduleRefresh(),
      isOpen: (path) => this.editors.isOpen(path)
    })
    await engine.loadBase()
    const entry = this.active.get(record.id)
    if (!entry || entry.session !== session) { engine.destroy(); session.destroy(); return }
    entry.engine = engine
    await engine.reconcileOffline()
    session.start()
    this.updateStatus()
  }

  private async stopShare (id: string, clear: boolean): Promise<void> {
    const a = this.active.get(id)
    if (!a) return
    this.active.delete(id)
    this.stopLinks(id)
    this.editors.unbindSession(a.session)
    a.engine?.destroy()
    if (clear) await a.session.destroyAndClear()
    else { await a.session.close(); a.store.close() }
    this.updateStatus()
  }

  private targetFor (path: string): BindTarget | null {
    if (!isTextPath(path)) return null
    const t = this.fileTarget(path)
    if (!t || t.a.session.files.get(t.f)?.kind !== 'text') return null
    return { session: t.a.session, engine: t.a.engine, f: t.f }
  }

  private fileTarget (path: string): { a: ActiveShare, f: string } | null {
    for (const a of this.active.values()) {
      if (!a.engine) continue
      const f = a.engine.fileFor(path)
      if (f) return { a, f }
    }
    return null
  }

  private activeAt (path: string): ActiveShare | undefined {
    for (const a of this.active.values()) if (a.record.path === path) return a
    return undefined
  }

  private denied (message: string): void {
    const last = this.deniedAt.get(message) ?? 0
    if (Date.now() - last < 30000) return
    this.deniedAt.set(message, Date.now())
    new Notice(`Collaboration: ${message}`, 8000)
  }

  private onRejected (record: ShareRecord, type: EventType, code: string): void {
    if (code === 'forbidden') this.denied(`your permissions in “${record.name}” changed, so it is syncing again from the server.`)
    else console.debug('[collaboration] change rejected', record.name, type, code)
  }

  private onRootMissing (record: ShareRecord): void {
    void this.stopShare(record.id, false)
    new Notice(`Collaboration: the shared folder “${record.name}” was deleted or moved, so syncing is paused. Nothing was deleted for anyone else. Restart Obsidian to bring it back, or use “${record.role === 'owner' ? 'Stop sharing' : 'Leave shared folder'}” to remove it for good.`, 15000)
  }

  private touchLinks (...paths: string[]): void {
    for (const mirror of this.mirrors.values()) if (paths.some((p) => mirror.covers(p))) mirror.schedule()
  }

  private onVaultChange (file: TAbstractFile): void {
    if (!(file instanceof TFile)) return
    this.touchLinks(file.path)
    for (const a of this.active.values()) if (a.engine && under(file.path, a.engine.root)) a.engine.onLocalChange(file.path)
  }

  private onVaultFolder (folder: TAbstractFile): void {
    if (!(folder instanceof TFolder)) return
    this.touchLinks(folder.path)
    if (!this.io.createdBySync(folder.path)) this.folderCreated(folder.path)
  }

  private folderCreated (path: string): void {
    for (const a of this.active.values()) if (a.engine && path.startsWith(a.engine.root + '/')) a.engine.onLocalFolder(path)
  }

  private onVaultDelete (file: TAbstractFile): void {
    this.touchLinks(file.path)
    for (const a of this.active.values()) {
      if (!a.engine) continue
      if (under(file.path, a.engine.root) || a.engine.root.startsWith(file.path + '/')) a.engine.onLocalDelete(file.path)
    }
  }

  private onVaultRename (file: TAbstractFile, oldPath: string): void {
    this.followLinks(file.path, oldPath)
    this.touchLinks(file.path, oldPath)
    for (const a of this.active.values()) {
      if (!a.engine) continue
      const root = a.engine.root
      if (oldPath === root || root.startsWith(oldPath + '/')) {
        const newRoot = file.path + root.slice(oldPath.length)
        a.record.path = newRoot
        a.engine.setRoot(newRoot)
        void this.saveState()
        if (a.record.role === 'owner') void this.publishRoot(a)
        continue
      }
      if (under(oldPath, root) || under(file.path, root)) a.engine.onLocalRename(oldPath, file.path, file instanceof TFolder)
    }
    this.editors.scheduleRefresh()
  }

  private fileMenu (menu: Menu, file: TAbstractFile): void {
    if (file instanceof TFolder) {
      if (file.isRoot()) return
      const a = this.activeAt(file.path)
      if (!a) {
        const overlapping = Object.values(this.shares).some((s) => under(file.path, s.path) || under(s.path, file.path))
        if (!overlapping) menu.addItem((i) => i.setTitle('Share folder…').setIcon('users').onClick(() => { void this.shareFolder(file) }))
        else this.linkMenu(menu, file)
        return
      }
      if (a.session.isOwner) {
        menu.addItem((i) => i.setTitle('Create invite link…').setIcon('link').onClick(() => this.createInvite(a.record)))
        menu.addItem((i) => i.setTitle('Manage sharing…').setIcon('users').onClick(() => this.manage(a.record)))
      }
      menu.addItem((i) => i.setTitle('Deleted files…').setIcon('trash').onClick(() => this.showDeleted(a.record)))
      if (!a.session.isOwner) menu.addItem((i) => i.setTitle('Leave shared folder').setIcon('log-out').onClick(() => this.leave(a.record)))
      this.linkMenu(menu, file)
      return
    }
    if (file instanceof TFile && this.fileTarget(file.path)) {
      menu.addItem((i) => i.setTitle('Version history…').setIcon('history').onClick(() => this.showHistory(file)))
    }
  }

  private async shareFolder (folder: TFolder): Promise<void> {
    if (!(await this.online())) return
    const identity = await this.ensureIdentity()
    const previous = (await this.meta.get<string>('kv', 'ownerName')) ?? ''
    const ownerName = await askText(this.app, {
      title: 'Your name',
      desc: 'Shown to the people you invite, next to your cursor and in the version history.',
      value: previous,
      cta: 'Share folder'
    })
    if (!ownerName) return
    const id = randomId()
    const keyring: Keyring = [newKey(0)]
    const cipher = new Cipher(keyring)
    try {
      await this.api.createShare(
        id,
        await cipher.encryptText(`${id}:share-name`, folder.name),
        await cipher.encryptText(`${id}:member-name:${identity.userId}`, ownerName),
        await cipher.encryptText(`${id}:share-path`, folder.path)
      )
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_owner') new Notice('Collaboration: only the server owner can share folders. Open the owner setup link from your server.', 10000)
      else new Notice(`Collaboration: could not share the folder (${(err as Error).message}).`)
      return
    }
    const record: ShareRecord = { id, name: folder.name, path: folder.path, role: 'owner' }
    this.shares[id] = record
    await this.saveState()
    await this.meta.write([{ table: 'kv', key: 'ownerName', value: ownerName }])
    await this.startShare(record, keyring)
    this.createInvite(record)
  }

  private createInvite (record: ShareRecord): void {
    new InviteModal(this.app, record.name, (perms) => { void this.makeInvite(record, perms) }).open()
  }

  private async makeInvite (record: ShareRecord, perms: Perms): Promise<void> {
    const a = this.active.get(record.id)
    if (!a) return
    try {
      const secret = randomBytes(32)
      const sealed = await sealWithSecret(secret, INVITE_PURPOSE, utf8(JSON.stringify(a.session.cipher.ring)))
      const { token } = await this.api.createInvite(record.id, perms, toB64(sealed))
      const url = `${this.server}/join/${token}#${toB64Url(secret)}`
      new LinkModal(this.app, `Invite to “${record.name}”`, 'Send this link privately to one person. It works once and expires in 7 days. It contains the key to the folder, so treat it like a password.', url).open()
    } catch (err) {
      new Notice(`Collaboration: could not create an invite (${(err as Error).message}).`)
    }
  }

  private async memberView (a: ActiveShare, m: MemberRecord): Promise<ManagedMember> {
    const name = await a.session.cipher.decryptText(a.session.memberAad(m.userId), m.nameEnc).catch(() => 'Unknown')
    return { userId: m.userId, name, perms: m.perms, joinedAt: m.joinedAt, owner: m.owner }
  }

  private manage (record: ShareRecord): void {
    const a = this.active.get(record.id)
    if (!a) return
    new ManageModal(this.app, record.name, {
      load: async () => {
        const res = await this.api.members(record.id)
        return { members: await Promise.all(res.members.map((m) => this.memberView(a, m))), pendingInvites: res.pendingInvites }
      },
      invite: () => this.createInvite(record),
      setPerms: async (m, perms) => {
        await this.api.updateMember(record.id, m.userId, { perms })
        if (m.perms.read && !perms.read) await this.rotate(a, m.userId)
      },
      rename: async (m, name) => {
        await this.api.updateMember(record.id, m.userId, { nameEnc: await a.session.cipher.encryptText(a.session.memberAad(m.userId), name) })
        if (m.owner) await this.meta.write([{ table: 'kv', key: 'ownerName', value: name }])
      },
      remove: async (m) => {
        await this.api.removeMember(record.id, m.userId)
        await this.rotate(a, m.userId)
      },
      cancelInvites: async () => { await this.api.cancelInvites(record.id) },
      stopSharing: () => { void this.stopSharing(record) }
    }).open()
  }

  private async rotate (a: ActiveShare, excluded: string): Promise<void> {
    const res = await this.api.members(a.record.id)
    const recipients = res.members
      .filter((m) => m.userId !== excluded && (m.owner || m.perms.read))
      .map((m) => ({ userId: m.userId, publicKey: m.publicKey }))
    await a.session.rotateKeys(recipients)
  }

  private async stopSharing (record: ShareRecord): Promise<void> {
    try {
      await this.api.deleteShare(record.id)
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) { new Notice(`Collaboration: could not stop sharing (${(err as Error).message}).`); return }
    }
    await this.stopShare(record.id, true)
    await this.forgetLinks(record.id)
    delete this.shares[record.id]
    await this.saveState()
    new Notice(`Stopped sharing “${record.name}”. Your folder was kept; everyone else’s copy will be deleted.`)
  }

  private leave (record: ShareRecord): void {
    new ConfirmModal(this.app, {
      title: `Leave “${record.name}”?`,
      body: 'You stop receiving changes. Your current copy of the folder stays in your vault.',
      cta: 'Leave',
      danger: true,
      onConfirm: () => {
        void (async () => {
          try { await this.api.leave(record.id) } catch (err) {
            if (!(err instanceof ApiError && err.status === 404)) { new Notice(`Collaboration: could not leave (${(err as Error).message}).`); return }
          }
          await this.stopShare(record.id, true)
          await this.forgetLinks(record.id)
          delete this.shares[record.id]
          await this.saveState()
          new Notice(`You left “${record.name}”.`)
        })()
      }
    }).open()
  }

  private showHistory (file: TFile): void {
    const t = this.fileTarget(file.path)
    if (!t) return
    const { session } = t.a
    new HistoryModal(this.app, {
      fileName: file.name,
      load: () => buildVersions(session, t.f),
      authorName: (userId) => session.memberName(userId),
      canRestore: session.canWrite,
      restore: async (version) => {
        if (version.kind === 'text') session.restoreText(t.f, version.text ?? '')
        else if (version.kind === 'canvas') session.restoreCanvas(t.f, version.text ?? '')
        else if (version.blob) session.setBlob(t.f, version.blob)
      }
    }).open()
  }

  private showDeleted (record: ShareRecord): void {
    const a = this.active.get(record.id)
    if (!a) return
    new DeletedFilesModal(
      this.app,
      record.name,
      () => a.session.deletedFiles().map((f) => ({ f: f.id, path: f.path, deletedBy: a.session.memberName(f.changedBy), deletedAt: f.changedAt })),
      a.session.canDelete,
      (entry) => {
        try {
          a.session.restore(entry.f)
          new Notice(`Restored “${entry.path}”.`)
        } catch (err) {
          new Notice(`Collaboration: ${(err as Error).message}.`)
        }
      }
    ).open()
  }

  private async handleLink (params: Record<string, string>): Promise<void> {
    if (params.server && !(await this.setServer(params.server))) return
    if (params.owner) await this.claimOwner(params.owner)
    else if (params.invite && params.key) await this.join(params.invite, params.key)
    else if (params.invite) new Notice('Collaboration: this invite link is incomplete. Copy the whole link, including the part after “#”.', 10000)
  }

  private async joinFromText (input: string): Promise<void> {
    const parsed = parseInvite(input)
    if (!parsed) { new Notice('Collaboration: that does not look like a complete invite link.'); return }
    if (parsed.server && !(await this.setServer(parsed.server))) return
    await this.join(parsed.token, parsed.secret)
  }

  private async claimOwner (token: string): Promise<void> {
    if (!(await this.online())) return
    try {
      await this.api.claimOwner(token)
      new Notice('Collaboration: this vault can now share folders. Right-click a folder to share it.', 10000)
    } catch (err) {
      new Notice(`Collaboration: setup failed (${(err as Error).message}).`, 10000)
    }
  }

  private async join (token: string, secret: string): Promise<void> {
    if (!(await this.online())) return
    const identity = await this.ensureIdentity()
    let invite
    try {
      invite = await this.api.getInvite(token)
    } catch (err) {
      new Notice(`Collaboration: could not join. ${(err as Error).message}`, 10000)
      return
    }
    if (this.shares[invite.shareId]) { new Notice('You already have this shared folder.'); return }
    let keyring: Keyring
    try {
      keyring = JSON.parse(fromUtf8(await openWithSecret(fromB64Url(secret), INVITE_PURPOSE, fromB64(invite.keyring)))) as Keyring
    } catch {
      new Notice('Collaboration: this invite link is incomplete or damaged. Ask for a new one.', 10000)
      return
    }
    const cipher = new Cipher(keyring)
    const folderName = await cipher.decryptText(`${invite.shareId}:share-name`, invite.shareNameEnc).catch(() => 'Shared folder')
    const ownerName = await cipher.decryptText(`${invite.shareId}:member-name:${invite.ownerId}`, invite.ownerNameEnc).catch(() => 'Someone')
    const name = await askText(this.app, {
      title: `Join “${folderName}”`,
      desc: `${ownerName} invited you. Enter the name others will see. You can't change it later; only ${ownerName} can.`,
      cta: 'Join'
    })
    if (!name) return
    let summary
    try {
      summary = await this.api.acceptInvite(token, await cipher.encryptText(`${invite.shareId}:member-name:${identity.userId}`, name))
    } catch (err) {
      new Notice(`Collaboration: could not join. ${(err as Error).message}`, 10000)
      return
    }
    const desired = invite.pathEnc ? await cipher.decryptText(`${invite.shareId}:share-path`, invite.pathEnc).catch(() => null) : null
    let path = desired ? normalizePath(desired) : ''
    if (!path || !this.pathFree(path, invite.shareId)) {
      const safe = folderName.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim() || 'Shared folder'
      path = normalizePath(safe)
      for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${safe} (${i})`)
      if (desired) new Notice(`Collaboration: “${desired}” is already used in this vault, so the folder was placed at “${path}”. Links that use full paths may not work.`, 12000)
    }
    await this.io.ensureFolder(path)
    const record: ShareRecord = { id: summary.id, name: folderName, path, role: summary.role }
    this.shares[record.id] = record
    await this.saveState()
    new Notice(`Joined “${folderName}”. Downloading…`)
    await this.startShare(record, keyring)
  }

  private async onAccessLost (code: number): Promise<void> {
    if (code === 4401 && await this.registerIdentity()) return
    await this.checkAccess()
  }

  async checkAccess (verbose = false): Promise<void> {
    if (!this.server || !this.identity) return
    if (this.checking) return this.checking
    this.checking = (async () => {
      let list
      try {
        list = await this.api.listShares()
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) await this.registerIdentity()
        if (verbose) new Notice(`Collaboration: could not check access (${(err as Error).message}).`)
        return
      }
      const byId = new Map(list.map((s) => [s.id, s]))
      for (const record of Object.values(this.shares)) {
        const summary = byId.get(record.id)
        if (!summary || (summary.role !== 'owner' && !summary.perms.read)) await this.removeLocally(record)
      }
      for (const record of Object.values(this.shares)) {
        if (!byId.has(record.id)) continue
        const a = this.active.get(record.id)
        if (!a) void this.startShare(record)
        else if (a.session.stalled) a.session.reconnect()
      }
      for (const summary of list) {
        if (!this.shares[summary.id] && (summary.role === 'owner' || summary.perms.read)) void this.adoptShare(summary)
      }
      if (verbose) new Notice('Collaboration: access is up to date.')
    })()
    try { await this.checking } finally { this.checking = null }
  }

  private adoptPath (desired: string | null, name: string, shareId: string): string {
    const overlaps = (p: string): boolean => Object.values(this.shares).some((s) => s.id !== shareId && (under(p, s.path) || under(s.path, p)))
    if (desired && !overlaps(desired)) return desired
    const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim() || 'Shared folder'
    let path = normalizePath(safe)
    for (let i = 2; overlaps(path) || this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${safe} (${i})`)
    return path
  }

  private async adoptShare (summary: ShareSummary): Promise<void> {
    const identity = this.identity
    if (!identity || this.adopting.has(summary.id) || this.shares[summary.id]) return
    this.adopting.add(summary.id)
    try {
      const keyring = await openSharedKey(this.api, summary.id, identity.privateKey)
      if (!keyring || this.shares[summary.id]) return
      const cipher = new Cipher(keyring)
      const name = await cipher.decryptText(`${summary.id}:share-name`, summary.nameEnc).catch(() => 'Shared folder')
      const desired = summary.pathEnc ? await cipher.decryptText(`${summary.id}:share-path`, summary.pathEnc).catch(() => null) : null
      const path = this.adoptPath(desired ? normalizePath(desired) : null, name, summary.id)
      await this.io.ensureFolder(path)
      const record: ShareRecord = { id: summary.id, name, path, role: summary.role }
      this.shares[record.id] = record
      await this.saveState()
      new Notice(`Collaboration: “${name}” is shared from your other device, so it now syncs here too.`, 10000)
      await this.startShare(record, keyring)
    } catch (err) {
      console.debug('[collaboration] could not add a share from another device', summary.id, err)
    } finally {
      this.adopting.delete(summary.id)
    }
  }

  private async removeLocally (record: ShareRecord): Promise<void> {
    await this.stopShare(record.id, true)
    await this.forgetLinks(record.id)
    delete this.shares[record.id]
    await this.saveState()
    if (record.role === 'member') {
      const folder = this.app.vault.getAbstractFileByPath(record.path)
      if (folder) await this.app.fileManager.trashFile(folder)
      new Notice(`Collaboration: you no longer have access to “${record.name}”, so it was removed from this vault.`, 15000)
    } else {
      new Notice(`Collaboration: “${record.name}” is no longer shared on the server. Your files were kept.`, 15000)
    }
  }

  private pathFree (path: string, shareId: string): boolean {
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing && !(existing instanceof TFolder && existing.children.length === 0)) return false
    return !Object.values(this.shares).some((s) => s.id !== shareId && (under(path, s.path) || under(s.path, path)))
  }

  private async publishRoot (a: ActiveShare): Promise<void> {
    if (!a.engine) return
    try {
      await this.api.updateSharePath(a.record.id, await a.session.cipher.encryptText(a.session.sharePathAad(), a.engine.root))
    } catch (err) {
      console.debug('[collaboration] could not publish folder path', err)
    }
  }

  private async alignRoot (id: string, sharedPath: string | null): Promise<void> {
    const a = this.active.get(id)
    if (!a?.engine) return
    const root = a.engine.root
    if (a.record.role === 'owner') {
      if (sharedPath !== root) await this.publishRoot(a)
      return
    }
    if (!sharedPath) return
    const target = normalizePath(sharedPath)
    if (target === root || under(target, root) || under(root, target)) return
    const folder = this.app.vault.getAbstractFileByPath(root)
    if (!(folder instanceof TFolder)) return
    if (!this.pathFree(target, id) || this.app.vault.getAbstractFileByPath(target)) {
      this.denied(`your copy of “${a.record.name}” is at “${root}” but the owner keeps it at “${target}”, which is already used here. Links that use full paths may not work.`)
      return
    }
    await this.io.ensureFolder(parentOf(target))
    await this.app.fileManager.renameFile(folder, target)
    new Notice(`Collaboration: moved “${a.record.name}” to “${target}” to match the owner, so links keep working.`, 10000)
  }

  private shareRootFor (path: string): string | null {
    for (const a of this.active.values()) {
      const root = a.engine?.root ?? a.record.path
      if (under(path, root)) return root
    }
    return null
  }

  private folderBadges (): FolderBadge[] {
    const badges: FolderBadge[] = Object.values(this.shares).map((record) => {
      const a = this.active.get(record.id)
      const online = !!a && a.session.connected && a.session.synced
      return {
        path: a?.engine?.root ?? record.path,
        icon: 'users',
        label: `${record.role === 'owner' ? 'Shared by you' : 'Shared with you'} · ${online ? 'online' : 'offline'}`,
        dim: !online
      }
    })
    for (const link of this.links) {
      const dir = this.linkDir(link)
      if (!dir) continue
      const paused = this.mirrors.get(linkKey(link))?.paused ?? true
      badges.push({ path: dir, icon: 'link', label: `Linked to ${link.external}${paused ? ' · paused' : ''}`, dim: paused })
    }
    return badges
  }

  private linkDir (link: FolderLink): string | null {
    const a = this.active.get(link.shareId)
    const root = a?.engine?.root ?? this.shares[link.shareId]?.path
    if (!root) return null
    return link.sub ? `${root}/${link.sub}` : root
  }

  private shareContaining (path: string): ActiveShare | undefined {
    for (const a of this.active.values()) if (a.engine && under(path, a.engine.root)) return a
    return undefined
  }

  private async saveLinks (): Promise<void> {
    await this.meta.write([{ table: 'kv', key: 'links', value: this.links }])
  }

  private startLinks (shareId: string): void {
    for (const link of this.links) if (link.shareId === shareId) this.startMirror(link)
  }

  private stopLinks (shareId: string): void {
    for (const [key, mirror] of Array.from(this.mirrors)) {
      if (key.startsWith(`${shareId}:`)) { mirror.stop(); this.mirrors.delete(key) }
    }
  }

  private async forgetLinks (shareId: string): Promise<void> {
    this.stopLinks(shareId)
    const gone = this.links.filter((l) => l.shareId === shareId)
    if (gone.length === 0) return
    this.links = this.links.filter((l) => l.shareId !== shareId)
    await this.meta.write([...gone.map((l) => ({ table: 'kv' as const, key: `mirror:${linkKey(l)}` })), { table: 'kv', key: 'links', value: this.links }])
  }

  private startMirror (link: FolderLink): void {
    const desktop = this.desktop
    const a = this.active.get(link.shareId)
    const key = linkKey(link)
    if (!desktop || !a?.engine || this.mirrors.has(key)) return
    const mirror = new LinkMirror({
      vaultDir: () => this.linkDir(link) ?? '',
      external: link.external,
      io: this.io,
      fs: desktop.fs,
      load: async () => (await this.meta.get<MirrorState>('kv', `mirror:${key}`)) ?? {},
      save: async (state) => { await this.meta.write([{ table: 'kv', key: `mirror:${key}`, value: state }]) },
      onPaused: (reason) => {
        new Notice(`Collaboration: the folder link to “${link.external}” is paused because ${reason}. Nothing was deleted. Fix it, then right-click the folder and choose “Resume folder link”.`, 15000)
        this.badges.schedule()
      },
      onConflict: (path) => new Notice(`Collaboration: a file changed in both places, so the older version was kept as “${path}”.`, 10000),
      onFolder: (path) => this.folderCreated(path),
      onRefused: () => this.denied(`some changes in “${link.external}” stay on this computer, because this shared folder doesn't let you edit or delete those files.`),
      canWrite: () => this.active.get(link.shareId)?.session.canWrite ?? false,
      canDelete: () => this.active.get(link.shareId)?.session.canDelete ?? false,
      isOpen: (path) => this.editors.isOpen(path),
      log: (...args) => console.debug('[collaboration] link', link.external, ...args)
    })
    this.mirrors.set(key, mirror)
    void mirror.start()
    this.badges.schedule()
  }

  private followLinks (newPath: string, oldPath: string): void {
    let changed = false
    for (const link of this.links) {
      const a = this.active.get(link.shareId)
      if (!a?.engine) continue
      const root = a.engine.root
      const dir = link.sub ? `${root}/${link.sub}` : root
      if (link.sub && (dir === oldPath || dir.startsWith(oldPath + '/'))) {
        const moved = newPath + dir.slice(oldPath.length)
        if (moved.startsWith(root + '/')) { link.sub = moved.slice(root.length + 1); changed = true }
      }
    }
    if (changed) void this.saveLinks()
  }

  private linkMenu (menu: Menu, folder: TFolder): void {
    if (!this.desktop) return
    const a = this.shareContaining(folder.path)
    if (!a?.engine) return
    const root = a.engine.root
    const sub = folder.path === root ? '' : folder.path.slice(root.length + 1)
    const link = this.links.find((l) => l.shareId === a.record.id && l.sub === sub)
    if (link) {
      const mirror = this.mirrors.get(linkKey(link))
      if (mirror?.paused) menu.addItem((i) => i.setTitle('Resume folder link').setIcon('refresh-cw').onClick(() => { mirror.resume(); this.badges.schedule() }))
      menu.addItem((i) => i.setTitle('Unlink folder').setIcon('unlink').onClick(() => { void this.unlinkFolder(link) }))
      return
    }
    const overlaps = this.links.some((l) => l.shareId === a.record.id && (l.sub === '' || sub === '' || under(sub, l.sub) || under(l.sub, sub)))
    if (!overlaps) menu.addItem((i) => i.setTitle('Link to a folder on this computer…').setIcon('link').onClick(() => { void this.linkFolder(a, folder, sub) }))
  }

  private async linkFolder (a: ActiveShare, folder: TFolder, sub: string): Promise<void> {
    const desktop = this.desktop
    if (!desktop) return
    const input = await askText(this.app, {
      title: `Link “${folder.name}”`,
      desc: 'Choose a folder on this computer, or type its full path. Files and folders in both are merged and kept in sync, with history on the server.',
      placeholder: '/home/me/Music/exports',
      cta: 'Link',
      browse: folderPicker() ?? undefined
    })
    const external = input?.trim()
    if (!external) return
    if (!desktop.isAbsolute(external)) { new Notice('Collaboration: enter the full path of the folder.'); return }
    const adapter = this.app.vault.adapter
    const vaultBase = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : ''
    if (vaultBase && (external === vaultBase || external.startsWith(vaultBase + '/') || external.startsWith(vaultBase + '\\'))) {
      new Notice('Collaboration: pick a folder outside this vault.')
      return
    }
    if (this.links.some((l) => l.external === external)) { new Notice('Collaboration: that folder is already linked.'); return }
    if (!(await desktop.fs.exists(external))) await makeFolder(external)
    const link: FolderLink = { shareId: a.record.id, sub, external }
    this.links.push(link)
    await this.saveLinks()
    this.startMirror(link)
    new Notice(`Collaboration: “${folder.path}” is now linked to “${external}”.`)
  }

  private async unlinkFolder (link: FolderLink): Promise<void> {
    const key = linkKey(link)
    this.mirrors.get(key)?.stop()
    this.mirrors.delete(key)
    this.links = this.links.filter((l) => l !== link)
    await this.meta.write([{ table: 'kv', key: `mirror:${key}` }, { table: 'kv', key: 'links', value: this.links }])
    this.badges.schedule()
    new Notice(`Collaboration: unlinked “${link.external}”. The files stay in both places.`)
  }

  private async serverMoved (location: string): Promise<void> {
    const url = normalizeServer(location)
    if (!url || url === this.server) return
    this.server = url
    this.registered = false
    await this.saveState()
    await this.registerIdentity()
    for (const a of this.active.values()) a.session.reconnect()
    new Notice(`Collaboration: the server moved to ${url}. Your shared folders now sync there.`, 10000)
  }

  updateStatus (): void {
    this.badges?.schedule()
    this.canvases?.refresh()
    if (!this.statusEl) return
    const shares = Array.from(this.active.values())
    if (shares.length === 0) { this.statusEl.setText(''); return }
    const online = shares.filter((a) => a.session.connected && a.session.synced).length
    this.statusEl.setText(online === shares.length ? `Shared: ${shares.length} synced` : `Shared: ${online}/${shares.length} online`)
  }
}
