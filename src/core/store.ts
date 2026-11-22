export type Table = 'kv' | 'files' | 'docs' | 'disk' | 'outbox'

export interface StoreOp { table: Table, key: string, value?: unknown }

export interface Store {
  get: <T>(table: Table, key: string) => Promise<T | undefined>
  all: <T>(table: Table) => Promise<Array<[string, T]>>
  write: (ops: StoreOp[]) => Promise<void>
  destroy: () => Promise<void>
}

const TABLES: Table[] = ['kv', 'files', 'docs', 'disk', 'outbox']

function clone<T> (value: T): T {
  if (value === undefined || value === null) return value
  try { return structuredClone(value) } catch { return value }
}

export class MemoryStore implements Store {
  constructor (readonly data = new Map<string, Map<string, unknown>>()) {}

  private table (name: Table): Map<string, unknown> {
    let table = this.data.get(name)
    if (!table) { table = new Map(); this.data.set(name, table) }
    return table
  }

  async get<T> (table: Table, key: string): Promise<T | undefined> {
    return clone(this.table(table).get(key) as T | undefined)
  }

  async all<T> (table: Table): Promise<Array<[string, T]>> {
    return Array.from(this.table(table), ([k, v]) => [k, clone(v as T)])
  }

  async write (ops: StoreOp[]): Promise<void> {
    for (const op of ops) {
      if (op.value === undefined) this.table(op.table).delete(op.key)
      else this.table(op.table).set(op.key, clone(op.value))
    }
  }

  async destroy (): Promise<void> { this.data.clear() }
}

function request<T> (req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function completion (tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export class IdbStore implements Store {
  private readonly db: Promise<IDBDatabase>

  constructor (readonly name: string) {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => {
        for (const table of TABLES) if (!req.result.objectStoreNames.contains(table)) req.result.createObjectStore(table)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB'))
    })
  }

  async get<T> (table: Table, key: string): Promise<T | undefined> {
    const db = await this.db
    return request(db.transaction(table, 'readonly').objectStore(table).get(key)) as Promise<T | undefined>
  }

  async all<T> (table: Table): Promise<Array<[string, T]>> {
    const store = (await this.db).transaction(table, 'readonly').objectStore(table)
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
    return keys.map((k, i) => [k as string, values[i] as T])
  }

  async write (ops: StoreOp[]): Promise<void> {
    if (ops.length === 0) return
    const tables = Array.from(new Set(ops.map((op) => op.table)))
    const tx = (await this.db).transaction(tables, 'readwrite')
    for (const op of ops) {
      const store = tx.objectStore(op.table)
      if (op.value === undefined) store.delete(op.key)
      else store.put(op.value, op.key)
    }
    await completion(tx)
  }

  close (): void {
    void this.db.then((db) => db.close())
  }

  async destroy (): Promise<void> {
    (await this.db).close()
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(this.name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    })
  }
}
