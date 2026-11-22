import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { editorInfoField } from 'obsidian'
import { yCollab, ySyncAnnotation } from 'y-codemirror.next'
import type { SyncEngine } from '../core/engine'
import { editorChanges } from '../core/merge'
import type { ShareSession } from '../core/share'

export interface BindTarget { session: ShareSession, engine: SyncEngine, f: string }

interface Binding extends BindTarget { ext: Extension, readOnly: boolean }

export class EditorBindings {
  private readonly compartment = new Compartment()
  private readonly views = new Set<EditorView>()
  private readonly bound = new Map<EditorView, Binding>()
  private timer: number | null = null

  constructor (private readonly targetFor: (path: string) => BindTarget | null, private readonly onRefresh: () => void) {}

  extensions (): Extension[] {
    const views = this.views
    const schedule = (): void => this.scheduleRefresh()
    return [
      this.compartment.of([]),
      EditorState.transactionExtender.of((tr) =>
        tr.annotation(ySyncAnnotation) !== undefined ? { annotations: Transaction.addToHistory.of(false) } : null
      ),
      ViewPlugin.fromClass(class {
        constructor (readonly view: EditorView) {
          views.add(view)
          schedule()
        }

        destroy (): void {
          views.delete(this.view)
          schedule()
        }
      })
    ]
  }

  isOpen (path: string): boolean {
    for (const view of this.views) {
      if (view.state.field(editorInfoField, false)?.file?.path === path) return true
    }
    return false
  }

  scheduleRefresh (): void {
    if (this.timer !== null) return
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.refresh()
    }, 50)
  }

  refresh (): void {
    const wanted = new Map<EditorView, BindTarget>()
    for (const view of this.views) {
      const file = view.state.field(editorInfoField, false)?.file
      if (!file) continue
      const target = this.targetFor(file.path)
      if (target && target.session.ready && !target.session.destroyed) wanted.set(view, target)
    }
    for (const [view, b] of Array.from(this.bound)) {
      const w = wanted.get(view)
      const alive = this.views.has(view)
      const installed = alive && this.compartment.get(view.state) === b.ext
      if (!w || w.session !== b.session || w.f !== b.f || b.readOnly === w.session.canWrite || !installed) this.unbind(view, b, installed)
    }
    for (const [view, target] of wanted) if (!this.bound.has(view)) this.bind(view, target)
    this.onRefresh()
  }

  private bind (view: EditorView, target: BindTarget): void {
    const editorText = view.state.doc.toString()
    const { ytext, readOnly } = target.engine.bind(target.f, editorText)
    const text = ytext.toJSON()
    if (text !== editorText) {
      view.dispatch({ changes: editorChanges(editorText, text), annotations: Transaction.addToHistory.of(false) })
    }
    const ext: Extension = [
      yCollab(ytext, target.session.awareness, { undoManager: false }),
      ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [])
    ]
    view.dispatch({ effects: this.compartment.reconfigure(ext) })
    this.bound.set(view, { ...target, ext, readOnly })
  }

  private unbind (view: EditorView, b: Binding, installed: boolean): void {
    this.bound.delete(view)
    if (installed) this.clear(view)
    if (!b.session.destroyed) b.engine.unbind(b.f)
  }

  private clear (view: EditorView): void {
    try {
      view.dispatch({ effects: this.compartment.reconfigure([]) })
    } catch {
      return
    }
  }

  unbindSession (session: ShareSession): void {
    for (const [view, b] of Array.from(this.bound)) {
      if (b.session === session) this.unbind(view, b, this.views.has(view) && this.compartment.get(view.state) === b.ext)
    }
  }

  unbindAll (): void {
    for (const [view, b] of Array.from(this.bound)) this.unbind(view, b, this.views.has(view) && this.compartment.get(view.state) === b.ext)
    if (this.timer !== null) window.clearTimeout(this.timer)
  }
}
