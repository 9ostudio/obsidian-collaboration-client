import { TextFileView, type App, type Plugin } from 'obsidian'

const SAVE_DELAY = 150
const TRIGGERS = ['pointerup', 'keyup', 'input', 'paste', 'drop'] as const

export class CanvasSaver {
  private readonly watched = new WeakSet<HTMLElement>()
  private readonly timers = new Map<TextFileView, number>()

  constructor (private readonly app: App, private readonly plugin: Plugin, private readonly isShared: (path: string) => boolean) {}

  refresh (): void {
    for (const leaf of this.app.workspace.getLeavesOfType('canvas')) {
      const view = leaf.view
      if (!(view instanceof TextFileView) || !view.file || !this.isShared(view.file.path)) continue
      const el = view.containerEl
      if (this.watched.has(el)) continue
      this.watched.add(el)
      for (const type of TRIGGERS) this.plugin.registerDomEvent(el, type, () => this.soon(view))
    }
  }

  private soon (view: TextFileView): void {
    const pending = this.timers.get(view)
    if (pending !== undefined) window.clearTimeout(pending)
    this.timers.set(view, window.setTimeout(() => {
      this.timers.delete(view)
      if (view.file && this.isShared(view.file.path)) void view.save()
    }, SAVE_DELAY))
  }

  stop (): void {
    for (const timer of this.timers.values()) window.clearTimeout(timer)
    this.timers.clear()
  }
}
