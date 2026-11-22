import { setIcon, type App } from 'obsidian'

export interface FolderBadge { path: string, icon: string, label: string, dim: boolean }

export class FolderBadges {
  private readonly observers = new Map<HTMLElement, MutationObserver>()
  private readonly icons = new Set<HTMLElement>()
  private timer: number | null = null

  constructor (private readonly app: App, private readonly badges: () => FolderBadge[]) {}

  schedule (): void {
    if (this.timer !== null) return
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.render()
    }, 100)
  }

  private observe (el: HTMLElement): void {
    if (this.observers.has(el)) return
    const observer = new MutationObserver(() => this.schedule())
    observer.observe(el, { childList: true, subtree: true })
    this.observers.set(el, observer)
  }

  render (): void {
    const wanted = new Map(this.badges().map((b) => [b.path, b]))
    for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
      const root = leaf.view.containerEl
      this.observe(root)
      for (const title of Array.from(root.querySelectorAll<HTMLElement>('.nav-folder-title'))) {
        const path = title.getAttribute('data-path')
        const badge = path ? wanted.get(path) : undefined
        let icon = Array.from(title.children).find((child): child is HTMLElement => child.instanceOf(HTMLElement) && child.hasClass('collaboration-folder-badge'))
        if (!badge) {
          if (icon) { icon.remove(); this.icons.delete(icon) }
          continue
        }
        if (!icon || icon.dataset.icon !== badge.icon) {
          if (icon) { icon.remove(); this.icons.delete(icon) }
          icon = title.createDiv({ cls: 'collaboration-folder-badge' })
          icon.dataset.icon = badge.icon
          setIcon(icon, badge.icon)
          this.icons.add(icon)
        }
        icon.toggleClass('is-offline', badge.dim)
        icon.setAttr('aria-label', badge.label)
      }
    }
  }

  stop (): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    for (const observer of this.observers.values()) observer.disconnect()
    this.observers.clear()
    for (const icon of this.icons) icon.remove()
    this.icons.clear()
  }
}
