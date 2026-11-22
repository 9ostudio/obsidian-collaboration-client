import DiffMatchPatch from 'diff-match-patch'
import type * as Y from 'yjs'

const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 2
dmp.Match_Threshold = 0.4
dmp.Patch_DeleteThreshold = 0.4

type Diff = [number, string]

export function diff (from: string, to: string): Diff[] {
  const diffs = dmp.diff_main(from, to)
  dmp.diff_cleanupSemantic(diffs)
  return diffs
}

export function applyToYText (ytext: Y.Text, next: string): boolean {
  const current = ytext.toJSON()
  if (current === next) return false
  let index = 0
  for (const [op, text] of diff(current, next)) {
    if (op === 0) {
      index += text.length
    } else if (op === -1) {
      ytext.delete(index, text.length)
    } else {
      ytext.insert(index, text)
      index += text.length
    }
  }
  return true
}

export function editorChanges (from: string, to: string): Array<{ from: number, to: number, insert: string }> {
  const changes: Array<{ from: number, to: number, insert: string }> = []
  let pos = 0
  for (const [op, text] of diff(from, to)) {
    if (op === 0) {
      pos += text.length
    } else if (op === -1) {
      changes.push({ from: pos, to: pos + text.length, insert: '' })
      pos += text.length
    } else {
      changes.push({ from: pos, to: pos, insert: text })
    }
  }
  return changes
}

export interface MergeResult {
  text: string
  clean: boolean
}

export function threeWay (base: string, local: string, remote: string): MergeResult {
  if (local === remote || local === base) return { text: remote, clean: true }
  if (remote === base) return { text: local, clean: true }
  const patches = dmp.patch_make(base, local)
  const [text, applied] = dmp.patch_apply(patches, remote)
  return { text, clean: applied.every(Boolean) }
}
