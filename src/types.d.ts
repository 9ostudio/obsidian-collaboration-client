declare module 'y-codemirror.next' {
  import type { Extension, AnnotationType } from '@codemirror/state'
  import type * as Y from 'yjs'
  import type { Awareness } from 'y-protocols/awareness'
  export function yCollab (ytext: Y.Text, awareness: Awareness | null, opts?: { undoManager?: Y.UndoManager | false }): Extension
  export const ySyncAnnotation: AnnotationType<unknown>
}
