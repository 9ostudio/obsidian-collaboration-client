import { MarkdownView, TFile, normalizePath, parseLinktext, type App, type EditorChange, type ReferenceCache, type TAbstractFile } from 'obsidian'
import { formatCanvas, parseCanvas } from './core/canvas'

const FRESH_MS = 60 * 1000
const CONTENT = new Set(['md', 'canvas', 'base'])
export const DATA_FOLDER = 'data'

const under = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')

interface Source { note?: TFile, canvas?: TFile }

export interface AttachmentOptions {
  rootFor: (path: string) => string | null
  canWrite: (root: string) => boolean
  writtenBySync: (path: string) => boolean
}

export class AttachmentRouter {
  private readonly fresh = new Map<string, number>()
  private readonly seen = new Map<string, Set<string>>()

  constructor (private readonly app: App, private readonly o: AttachmentOptions) {}

  onCreate (file: TAbstractFile): void {
    if (!(file instanceof TFile) || CONTENT.has(file.extension)) return
    if (this.o.writtenBySync(file.path)) return
    const root = this.o.rootFor(file.path)
    if (root && file.path.startsWith(`${root}/${DATA_FOLDER}/`)) return
    const now = Date.now()
    for (const [path, time] of this.fresh) if (now - time > FRESH_MS) this.fresh.delete(path)
    this.fresh.set(file.path, now)
  }

  onRename (file: TAbstractFile, oldPath: string): void {
    const time = this.fresh.get(oldPath)
    if (time !== undefined) {
      this.fresh.delete(oldPath)
      this.fresh.set(file.path, time)
    }
    const targets = this.seen.get(oldPath)
    if (targets) {
      this.seen.delete(oldPath)
      this.seen.set(file.path, targets)
    }
  }

  onResolve (note: TFile): void {
    const root = this.o.rootFor(note.path)
    if (!root) return
    const targets = Object.keys(this.app.metadataCache.resolvedLinks[note.path] ?? {})
    for (const target of this.newTargets(note.path, targets)) {
      if (this.claim(target, root, { note })) continue
      if (!under(target, root)) void this.adopt(target, root, { note })
    }
  }

  async onCanvasChange (file: TFile): Promise<void> {
    if (file.extension !== 'canvas') return
    const root = this.o.rootFor(file.path)
    if (!root) return
    const data = parseCanvas(await this.app.vault.cachedRead(file))
    if (!data || !Array.isArray(data.nodes)) return
    const targets: string[] = []
    for (const node of data.nodes as unknown[]) {
      const path = node !== null && typeof node === 'object' ? (node as { file?: unknown }).file : undefined
      if (typeof path === 'string') targets.push(path)
    }
    for (const target of this.newTargets(file.path, targets)) {
      if (this.claim(target, root, { canvas: file })) continue
      if (!under(target, root)) void this.adopt(target, root, { canvas: file })
    }
  }

  private newTargets (source: string, targets: string[]): string[] {
    const before = this.seen.get(source)
    this.seen.set(source, new Set(targets))
    return targets.filter((t) => this.fresh.has(t) || (before !== undefined && !before.has(t)))
  }

  private claim (path: string, root: string, source: Source): boolean {
    const time = this.fresh.get(path)
    if (time === undefined) return false
    this.fresh.delete(path)
    if (Date.now() - time <= FRESH_MS) void this.move(path, root, source)
    return true
  }

  private async dataFolder (root: string): Promise<string> {
    const folder = normalizePath(`${root}/${DATA_FOLDER}`)
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => undefined)
    return folder
  }

  private freePath (folder: string, file: TFile): string {
    let dest = normalizePath(`${folder}/${file.name}`)
    for (let i = 1; this.app.vault.getAbstractFileByPath(dest); i++) dest = normalizePath(`${folder}/${file.basename} ${i}.${file.extension}`)
    return dest
  }

  private async move (path: string, root: string, source: Source): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return
    const refs = source.note ? this.refsTo(source.note, path) : []
    const dest = this.freePath(await this.dataFolder(root), file)
    await this.app.vault.rename(file, dest)
    if (source.note) await this.applyLinks(source.note, refs, file)
    if (source.canvas) await this.fixCanvas(source.canvas, path, dest)
  }

  private async adopt (path: string, root: string, from: Source): Promise<void> {
    const source = this.app.vault.getAbstractFileByPath(path)
    if (!(source instanceof TFile) || CONTENT.has(source.extension) || !this.o.canWrite(root)) return
    const folder = await this.dataFolder(root)
    const same = this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${source.name}`))
    const refs = from.note ? this.refsTo(from.note, path) : []
    const copy = same instanceof TFile && same.stat.size === source.stat.size
      ? same
      : await this.app.vault.copy(source, this.freePath(folder, source))
    if (from.note) await this.applyLinks(from.note, refs, copy)
    if (from.canvas) await this.fixCanvas(from.canvas, path, copy.path)
  }

  private refsTo (note: TFile, path: string): ReferenceCache[] {
    const cache = this.app.metadataCache.getFileCache(note)
    return [...(cache?.embeds ?? []), ...(cache?.links ?? [])].filter((ref) =>
      this.app.metadataCache.getFirstLinkpathDest(parseLinktext(ref.link).path, note.path)?.path === path
    )
  }

  private async applyLinks (note: TFile, refs: ReferenceCache[], to: TFile): Promise<void> {
    const replacements = new Map<string, string>()
    for (const ref of refs) {
      const { subpath } = parseLinktext(ref.link)
      const alias = ref.displayText && ref.displayText !== ref.link ? ref.displayText : undefined
      let link = this.app.fileManager.generateMarkdownLink(to, note.path, subpath || undefined, alias)
      if (ref.original.startsWith('!') && !link.startsWith('!')) link = `!${link}`
      if (link !== ref.original) replacements.set(ref.original, link)
    }
    if (replacements.size === 0) return
    const view = this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view)
      .find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === note.path)
    if (view) {
      const editor = view.editor
      const text = editor.getValue()
      const changes: EditorChange[] = []
      for (const [original, link] of replacements) {
        for (let i = text.indexOf(original); i >= 0; i = text.indexOf(original, i + original.length)) {
          changes.push({ from: editor.offsetToPos(i), to: editor.offsetToPos(i + original.length), text: link })
        }
      }
      if (changes.length) editor.transaction({ changes })
      return
    }
    await this.app.vault.process(note, (text) => {
      let out = text
      for (const [original, link] of replacements) out = out.split(original).join(link)
      return out
    })
  }

  private async fixCanvas (canvas: TFile, from: string, to: string): Promise<void> {
    const data = parseCanvas(await this.app.vault.read(canvas))
    if (!data || !Array.isArray(data.nodes)) return
    const stale = (data.nodes as unknown[]).some((node) => node !== null && typeof node === 'object' && (node as { file?: unknown }).file === from)
    if (!stale) return
    await this.app.vault.process(canvas, (text) => {
      const current = parseCanvas(text)
      if (!current || !Array.isArray(current.nodes)) return text
      current.nodes = (current.nodes as unknown[]).map((node) => {
        if (node === null || typeof node !== 'object' || (node as { file?: unknown }).file !== from) return node
        return { ...(node as Record<string, unknown>), file: to }
      })
      return formatCanvas(current)
    })
  }
}
