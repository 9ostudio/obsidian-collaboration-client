import { App, Modal, Notice, Setting, TextComponent } from 'obsidian'
import type { Perms } from '../core/api'
import type { Version } from '../core/history'

export class TextPromptModal extends Modal {
  private value: string
  private submitted = false

  constructor (app: App, private readonly opts: { title: string, desc?: string, placeholder?: string, value?: string, cta: string, browse?: () => Promise<string | null>, onSubmit: (value: string) => void, onCancel?: () => void }) {
    super(app)
    this.value = opts.value ?? ''
  }

  onOpen (): void {
    this.setTitle(this.opts.title)
    if (this.opts.desc) this.contentEl.createEl('p', { text: this.opts.desc })
    const submit = (): void => {
      const value = this.value.trim()
      if (!value) return
      this.submitted = true
      this.opts.onSubmit(value)
      this.close()
    }
    let text: TextComponent | null = null
    const input = new Setting(this.contentEl).addText((t) => {
      text = t
      t.setPlaceholder(this.opts.placeholder ?? '').setValue(this.value).onChange((v) => { this.value = v })
      t.inputEl.addClass('collaboration-input')
      t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
      window.setTimeout(() => t.inputEl.focus(), 0)
    })
    const browse = this.opts.browse
    if (browse) {
      input.addButton((b) => b.setButtonText('Browse…').onClick(() => {
        void browse().then((picked) => {
          if (!picked) return
          this.value = picked
          text?.setValue(picked)
        })
      }))
    }
    input.settingEl.addClass('collaboration-wide')
    new Setting(this.contentEl).addButton((b) => b.setButtonText(this.opts.cta).setCta().onClick(submit))
  }

  onClose (): void {
    this.contentEl.empty()
    if (!this.submitted) this.opts.onCancel?.()
  }
}

export function askText (app: App, opts: { title: string, desc?: string, placeholder?: string, value?: string, cta: string, browse?: () => Promise<string | null> }): Promise<string | null> {
  return new Promise((resolve) => {
    new TextPromptModal(app, { ...opts, onSubmit: resolve, onCancel: () => resolve(null) }).open()
  })
}

export class ConfirmModal extends Modal {
  constructor (app: App, private readonly opts: { title: string, body: string, cta: string, danger?: boolean, onConfirm: () => void }) {
    super(app)
  }

  onOpen (): void {
    this.setTitle(this.opts.title)
    this.contentEl.createEl('p', { text: this.opts.body })
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => {
        b.setButtonText(this.opts.cta).onClick(() => { this.close(); this.opts.onConfirm() })
        if (this.opts.danger) b.setDestructive().setCta(); else b.setCta()
      })
  }

  onClose (): void { this.contentEl.empty() }
}

export class LinkModal extends Modal {
  constructor (app: App, private readonly title: string, private readonly description: string, private readonly url: string) {
    super(app)
  }

  onOpen (): void {
    this.setTitle(this.title)
    this.contentEl.createEl('p', { text: this.description })
    const row = this.contentEl.createDiv({ cls: 'collaboration-link-row' })
    const input = row.createEl('input', { type: 'text', value: this.url })
    input.readOnly = true
    input.addEventListener('focus', () => input.select())
    const copy = row.createEl('button', { text: 'Copy link', cls: 'mod-cta' })
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.url).then(() => {
        copy.setText('Copied')
        new Notice('Link copied')
      })
    })
  }

  onClose (): void { this.contentEl.empty() }
}

export class InviteModal extends Modal {
  private readonly perms: Perms = { read: true, write: true, delete: false }

  constructor (app: App, private readonly folderName: string, private readonly onCreate: (perms: Perms) => void) {
    super(app)
  }

  onOpen (): void {
    this.setTitle(`Invite to “${this.folderName}”`)
    this.contentEl.createEl('p', { text: 'The link works for one person and expires in 7 days. They choose their display name when they join.' })
    new Setting(this.contentEl).setName('Can edit').setDesc('Create, edit and rename files.')
      .addToggle((t) => t.setValue(this.perms.write).onChange((v) => { this.perms.write = v }))
    new Setting(this.contentEl).setName('Can delete').setDesc('Delete files and restore deleted ones.')
      .addToggle((t) => t.setValue(this.perms.delete).onChange((v) => { this.perms.delete = v }))
    new Setting(this.contentEl).addButton((b) => b.setButtonText('Create link').setCta().onClick(() => {
      this.close()
      this.onCreate({ ...this.perms })
    }))
  }

  onClose (): void { this.contentEl.empty() }
}

export interface ManagedMember { userId: string, name: string, perms: Perms, joinedAt: string, owner: boolean }

export interface ManageActions {
  load: () => Promise<{ members: ManagedMember[], pendingInvites: number }>
  invite: () => void
  setPerms: (member: ManagedMember, perms: Perms) => Promise<void>
  rename: (member: ManagedMember, name: string) => Promise<void>
  remove: (member: ManagedMember) => Promise<void>
  cancelInvites: () => Promise<void>
  stopSharing: () => void
}

export class ManageModal extends Modal {
  constructor (app: App, private readonly folderName: string, private readonly actions: ManageActions) {
    super(app)
  }

  onOpen (): void { void this.render() }

  private async run (task: () => Promise<void>): Promise<void> {
    try {
      await task()
    } catch (err) {
      new Notice(`Could not save the change: ${(err as Error).message}`)
    }
    await this.render()
  }

  private async render (): Promise<void> {
    const { contentEl } = this
    contentEl.empty()
    this.setTitle(`Sharing “${this.folderName}”`)
    const loading = contentEl.createEl('p', { text: 'Loading…', cls: 'collaboration-muted' })
    let data: { members: ManagedMember[], pendingInvites: number }
    try {
      data = await this.actions.load()
    } catch (err) {
      loading.setText(`Could not reach the server: ${(err as Error).message}`)
      return
    }
    loading.remove()

    new Setting(contentEl).setName('People').setHeading()
    for (const m of data.members) {
      const row = new Setting(contentEl).setName(m.name)
      if (m.owner) {
        row.setDesc('Owner')
        row.addButton((b) => b.setButtonText('Rename').onClick(() => { void this.renameMember(m) }))
        continue
      }
      row.setDesc(`Joined ${new Date(m.joinedAt).toLocaleDateString()}`)
      row.settingEl.addClass('collaboration-member')
      const perms = row.controlEl.createDiv({ cls: 'collaboration-perms' })
      for (const key of ['read', 'write', 'delete'] as const) {
        const label = perms.createEl('label', { cls: 'collaboration-perm' })
        const box = label.createEl('input', { type: 'checkbox' })
        box.checked = m.perms[key]
        label.appendText(key === 'read' ? 'Read' : key === 'write' ? 'Edit' : 'Delete')
        box.addEventListener('change', () => {
          const next: Perms = { ...m.perms, [key]: box.checked }
          if (key === 'read' && !box.checked) { next.write = false; next.delete = false }
          if (key !== 'read' && box.checked) next.read = true
          void this.run(() => this.actions.setPerms(m, next))
        })
      }
      row.addButton((b) => b.setButtonText('Rename').onClick(() => { void this.renameMember(m) }))
      row.addButton((b) => b.setButtonText('Remove').setDestructive().onClick(() => {
        new ConfirmModal(this.app, {
          title: `Remove ${m.name}?`,
          body: `They lose access, “${this.folderName}” is deleted from their vault the next time their Obsidian is online, and the folder switches to a new encryption key.`,
          cta: 'Remove',
          danger: true,
          onConfirm: () => { void this.run(() => this.actions.remove(m)) }
        }).open()
      }))
    }
    if (data.members.length <= 1) contentEl.createEl('p', { text: 'Nobody else has joined yet.', cls: 'collaboration-muted' })

    new Setting(contentEl).setName('Invites').setHeading()
    new Setting(contentEl)
      .setName('New invite link')
      .setDesc(data.pendingInvites > 0 ? `${data.pendingInvites} unused link(s) still valid.` : 'Each link works for one person.')
      .addButton((b) => b.setButtonText('Create link').setCta().onClick(() => { this.close(); this.actions.invite() }))
      .addButton((b) => {
        b.setButtonText('Cancel unused links').onClick(() => { void this.run(() => this.actions.cancelInvites()) })
        b.setDisabled(data.pendingInvites === 0)
      })

    new Setting(contentEl).setName('Stop sharing').setHeading()
    new Setting(contentEl)
      .setDesc('Removes the folder and its history from the server and deletes it from everyone else’s vault. Your copy stays.')
      .addButton((b) => b.setButtonText('Stop sharing').setDestructive().onClick(() => {
        new ConfirmModal(this.app, {
          title: `Stop sharing “${this.folderName}”?`,
          body: 'Everyone else loses access and their copy is deleted. The history on the server is deleted too. Your folder stays as it is.',
          cta: 'Stop sharing',
          danger: true,
          onConfirm: () => { this.close(); this.actions.stopSharing() }
        }).open()
      }))
  }

  private async renameMember (m: ManagedMember): Promise<void> {
    const name = await askText(this.app, { title: `Rename ${m.name}`, value: m.name, cta: 'Save' })
    if (name && name !== m.name) await this.run(() => this.actions.rename(m, name))
  }

  onClose (): void { this.contentEl.empty() }
}

const LABELS: Record<Version['label'], string> = {
  created: 'Created',
  edited: 'Edited',
  renamed: 'Renamed',
  replaced: 'Replaced',
  deleted: 'Deleted',
  restored: 'Restored'
}

export interface HistoryOptions {
  fileName: string
  load: () => Promise<Version[]>
  authorName: (userId: string) => string
  canRestore: boolean
  restore: (version: Version) => Promise<void>
}

export class HistoryModal extends Modal {
  constructor (app: App, private readonly opts: HistoryOptions) {
    super(app)
  }

  onOpen (): void {
    this.modalEl.addClass('collaboration-history')
    void this.render()
  }

  private async render (): Promise<void> {
    const { contentEl } = this
    contentEl.empty()
    this.setTitle(`Version history: ${this.opts.fileName}`)
    const loading = contentEl.createEl('p', { text: 'Loading…', cls: 'collaboration-muted' })
    let versions: Version[]
    try {
      versions = await this.opts.load()
    } catch (err) {
      loading.setText(`Could not load the history: ${(err as Error).message}`)
      return
    }
    loading.remove()
    if (versions.length === 0) { contentEl.createEl('p', { text: 'No history yet.', cls: 'collaboration-muted' }); return }
    const list = contentEl.createDiv({ cls: 'collaboration-versions' })
    const preview = contentEl.createDiv({ cls: 'collaboration-preview' })
    preview.createEl('p', { text: 'Select a version to preview it.', cls: 'collaboration-muted' })
    versions.forEach((v, i) => {
      const row = new Setting(list)
        .setName(`${LABELS[v.label]} by ${this.opts.authorName(v.author)}`)
        .setDesc(`${new Date(v.time).toLocaleString()}${i === 0 ? ' · current' : ''}`)
      row.addButton((b) => b.setButtonText('Preview').onClick(() => this.show(preview, v)))
      if (this.opts.canRestore && i > 0 && v.label !== 'deleted') {
        row.addButton((b) => b.setButtonText('Restore').onClick(() => {
          new ConfirmModal(this.app, {
            title: 'Restore this version?',
            body: 'The current content is replaced for everyone. The current version stays in the history.',
            cta: 'Restore',
            onConfirm: () => {
              void this.opts.restore(v).then(() => {
                new Notice('Version restored')
                this.close()
              }, (err: Error) => new Notice(`Could not restore: ${err.message}`))
            }
          }).open()
        }))
      }
    })
  }

  private show (preview: HTMLElement, v: Version): void {
    preview.empty()
    preview.createDiv({ text: `${v.path} · ${new Date(v.time).toLocaleString()}`, cls: 'collaboration-muted' })
    if (v.kind !== 'blob') preview.createEl('pre', { text: v.text ?? '', cls: 'collaboration-preview-text' })
    else preview.createEl('p', { text: v.blob ? `Attachment, ${Math.ceil(v.blob.size / 1024)} KB` : 'Attachment' })
  }

  onClose (): void { this.contentEl.empty() }
}

export interface DeletedEntry { f: string, path: string, deletedBy: string, deletedAt: number }

export class DeletedFilesModal extends Modal {
  constructor (app: App, private readonly folderName: string, private readonly entries: () => DeletedEntry[], private readonly canRestore: boolean, private readonly restore: (entry: DeletedEntry) => void) {
    super(app)
  }

  onOpen (): void { this.render() }

  private render (): void {
    const { contentEl } = this
    contentEl.empty()
    this.setTitle(`Deleted files in “${this.folderName}”`)
    const entries = this.entries().sort((a, b) => b.deletedAt - a.deletedAt)
    if (entries.length === 0) { contentEl.createEl('p', { text: 'No deleted files.', cls: 'collaboration-muted' }); return }
    for (const entry of entries) {
      const row = new Setting(contentEl).setName(entry.path).setDesc(`Deleted by ${entry.deletedBy}, ${new Date(entry.deletedAt).toLocaleString()}`)
      if (this.canRestore) {
        row.addButton((b) => b.setButtonText('Restore').onClick(() => {
          this.restore(entry)
          this.render()
        }))
      }
    }
  }

  onClose (): void { this.contentEl.empty() }
}
