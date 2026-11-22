import * as Y from 'yjs'
import { readCanvas } from './canvas'
import type { BlobRef, FileKind, FileMeta, ShareSession } from './share'

export type VersionLabel = 'created' | 'edited' | 'renamed' | 'replaced' | 'deleted' | 'restored'

export interface Version {
  seq: number
  time: number
  author: string
  label: VersionLabel
  path: string
  kind: FileKind
  text?: string
  blob?: BlobRef
}

const GROUP_MS = 2 * 60 * 1000

export async function buildVersions (session: ShareSession, f: string): Promise<Version[]> {
  const events = (await session.history(f)).sort((a, b) => a.seq - b.seq)
  const doc = new Y.Doc()
  const text = doc.getText('content')
  let meta: FileMeta | null = null
  const versions: Version[] = []
  let createdOpen = false
  const push = (seq: number, time: number, author: string, label: VersionLabel): void => {
    if (!meta) return
    versions.push({ seq, time, author, label, path: meta.path, kind: meta.kind, text: meta.kind === 'text' ? text.toJSON() : meta.kind === 'canvas' ? readCanvas(doc) : undefined, blob: meta.blob })
  }
  for (const ev of events) {
    try {
      if (ev.type === 'create' || ev.type === 'meta') {
        const next = await session.decryptMeta(f, ev.d ?? '')
        const previous: FileMeta | null = meta
        meta = next
        if (ev.type === 'create') { push(ev.seq, ev.ts, ev.a, 'created'); createdOpen = true }
        else if (previous && next.blob?.id !== previous.blob?.id) push(ev.seq, ev.ts, ev.a, 'replaced')
        else if (previous && next.path !== previous.path) push(ev.seq, ev.ts, ev.a, 'renamed')
        continue
      }
      if (ev.type === 'update' || ev.type === 'snap') {
        Y.applyUpdate(doc, await session.decryptContent(f, ev.d ?? ''))
        if (ev.type === 'snap') continue
        const last = versions[versions.length - 1]
        const intoCreated = createdOpen && last?.label === 'created'
        createdOpen = false
        if (last && (last.label === 'edited' || intoCreated) && last.author === ev.a && ev.ts - last.time < GROUP_MS) {
          last.time = ev.ts
          last.seq = ev.seq
          last.text = meta?.kind === 'canvas' ? readCanvas(doc) : text.toJSON()
          continue
        }
        push(ev.seq, ev.ts, ev.a, 'edited')
        continue
      }
      push(ev.seq, ev.ts, ev.a, ev.type === 'delete' ? 'deleted' : 'restored')
    } catch {
      continue
    }
  }
  doc.destroy()
  return versions.reverse()
}
