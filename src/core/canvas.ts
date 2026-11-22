import type * as Y from 'yjs'

type Item = Record<string, unknown>
export interface CanvasData { nodes?: unknown, edges?: unknown, [key: string]: unknown }

const LISTS = ['nodes', 'edges'] as const
type List = typeof LISTS[number]

export const isCanvasPath = (path: string): boolean => /\.canvas$/i.test(path)

export function parseCanvas (text: string): CanvasData | null {
  if (!text.trim()) return {}
  try {
    const data = JSON.parse(text) as unknown
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data as CanvasData : null
  } catch {
    return null
  }
}

export function formatCanvas (data: CanvasData): string {
  const { nodes, edges, ...rest } = data
  return JSON.stringify({ nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [], ...rest }, null, '\t')
}

export function normalizeCanvas (text: string): string | null {
  const data = parseCanvas(text)
  return data ? formatCanvas(data) : null
}

function parts (doc: Y.Doc, list: List): { items: Y.Map<string>, order: Y.Array<string> } {
  return { items: doc.getMap<string>(`canvas-${list}`), order: doc.getArray<string>(`canvas-${list}-order`) }
}

function keyed (value: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(value)) return out
  value.forEach((item: unknown, i) => {
    const id = item !== null && typeof item === 'object' && typeof (item as Item).id === 'string' ? (item as Item).id as string : `#${i}`
    out.set(id, JSON.stringify(item))
  })
  return out
}

export function readCanvas (doc: Y.Doc): string {
  const out: CanvasData = {}
  for (const list of LISTS) {
    const { items, order } = parts(doc, list)
    const seen = new Set<string>()
    const ids: string[] = []
    for (const id of order.toArray()) {
      if (!seen.has(id) && items.has(id)) { seen.add(id); ids.push(id) }
    }
    for (const id of Array.from(items.keys()).sort()) if (!seen.has(id)) ids.push(id)
    out[list] = ids.map((id) => JSON.parse(items.get(id) ?? 'null') as unknown)
  }
  const extra = doc.getMap<string>('canvas-extra')
  for (const key of Array.from(extra.keys()).sort()) out[key] = JSON.parse(extra.get(key) ?? 'null') as unknown
  return formatCanvas(out)
}

function mergeList (doc: Y.Doc, list: List, baseValue: unknown, nextValue: unknown): void {
  const { items, order } = parts(doc, list)
  const base = keyed(baseValue)
  const next = keyed(nextValue)
  for (const [id, value] of next) {
    if (value !== base.get(id) && items.get(id) !== value) items.set(id, value)
  }
  for (const id of base.keys()) if (!next.has(id) && items.has(id)) items.delete(id)
  const localOrder = Array.from(next.keys())
  if (localOrder.join('\n') === Array.from(base.keys()).join('\n') && order.length > 0) return
  const current = order.toArray()
  const desired = [...localOrder, ...current.filter((id) => !next.has(id) && !base.has(id) && items.has(id))]
  if (desired.join('\n') === current.join('\n')) return
  order.delete(0, order.length)
  order.insert(0, desired)
}

export function applyCanvas (doc: Y.Doc, base: CanvasData | null, next: CanvasData): void {
  for (const list of LISTS) mergeList(doc, list, base?.[list], next[list])
  const extra = doc.getMap<string>('canvas-extra')
  const keys = new Set([...Object.keys(next), ...Object.keys(base ?? {})])
  for (const key of keys) {
    if (key === 'nodes' || key === 'edges') continue
    const value = key in next ? JSON.stringify(next[key]) : undefined
    const before = base && key in base ? JSON.stringify(base[key]) : undefined
    if (value === before) continue
    if (value === undefined) extra.delete(key)
    else if (extra.get(key) !== value) extra.set(key, value)
  }
}

export const SHARE_PREFIX = '@share/'

function mapFiles (data: CanvasData, fn: (path: string) => string): CanvasData {
  if (!Array.isArray(data.nodes)) return data
  const nodes = (data.nodes as unknown[]).map((node) => {
    if (node === null || typeof node !== 'object') return node
    const file = (node as Item).file
    if (typeof file !== 'string') return node
    const next = fn(file)
    return next === file ? node : { ...(node as Item), file: next }
  })
  return { ...data, nodes }
}

export function toSharedCanvas (data: CanvasData, root: string): CanvasData {
  const prefix = `${root}/`
  return mapFiles(data, (path) => path.startsWith(prefix) ? SHARE_PREFIX + path.slice(prefix.length) : path)
}

export function toLocalCanvas (data: CanvasData, root: string): CanvasData {
  return mapFiles(data, (path) => path.startsWith(SHARE_PREFIX) ? `${root}/${path.slice(SHARE_PREFIX.length)}` : path)
}
