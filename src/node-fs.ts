import { Platform } from 'obsidian'
import type { ExternalFS } from './core/mirror'

interface Dirent { name: string, isDirectory: () => boolean, isFile: () => boolean }
interface Stats { size: number, mtimeMs: number, isFile: () => boolean, isDirectory: () => boolean }
interface Watcher { close: () => void, on: (event: 'error', listener: () => void) => void }
interface NodeFs {
  promises: {
    stat: (path: string) => Promise<Stats>
    readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>
    readFile: (path: string) => Promise<Uint8Array>
    writeFile: (path: string, data: Uint8Array) => Promise<void>
    mkdir: (path: string, options: { recursive: true }) => Promise<unknown>
    rename: (from: string, to: string) => Promise<void>
    rm: (path: string, options: { force: true }) => Promise<void>
    rmdir: (path: string) => Promise<void>
  }
  watch: (path: string, options: { recursive: true }, listener: () => void) => Watcher
}
interface NodePath {
  join: (...parts: string[]) => string
  dirname: (path: string) => string
  basename: (path: string) => string
  isAbsolute: (path: string) => boolean
}
interface Shell { trashItem: (path: string) => Promise<void> }

declare const require: (id: string) => unknown

function build (fs: NodeFs, path: NodePath, shell: Shell | null): ExternalFS {
  const full = (dir: string, rel: string): string => path.join(dir, ...rel.split('/'))
  return {
    exists: async (dir) => {
      try {
        return (await fs.promises.stat(dir)).isDirectory()
      } catch {
        return false
      }
    },
    list: async (dir) => {
      const files: string[] = []
      const dirs: string[] = []
      const walk = async (abs: string, prefix: string): Promise<void> => {
        for (const entry of await fs.promises.readdir(abs, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            dirs.push(rel)
            await walk(path.join(abs, entry.name), rel)
          } else if (entry.isFile()) {
            files.push(rel)
          }
        }
      }
      await walk(dir, '')
      return { files, dirs }
    },
    stat: async (dir, rel) => {
      try {
        const stats = await fs.promises.stat(full(dir, rel))
        return stats.isFile() ? { size: stats.size, mtime: stats.mtimeMs } : null
      } catch {
        return null
      }
    },
    read: async (dir, rel) => new Uint8Array(await fs.promises.readFile(full(dir, rel))),
    write: async (dir, rel, data) => {
      const target = full(dir, rel)
      const folder = path.dirname(target)
      await fs.promises.mkdir(folder, { recursive: true })
      const tmp = path.join(folder, `.${path.basename(target)}.collaboration`)
      await fs.promises.writeFile(tmp, data)
      await fs.promises.rename(tmp, target)
    },
    remove: async (dir, rel) => {
      const target = full(dir, rel)
      if (shell) {
        try {
          await shell.trashItem(target)
          return
        } catch {
          await fs.promises.rm(target, { force: true })
          return
        }
      }
      await fs.promises.rm(target, { force: true })
    },
    makeDir: async (dir, rel) => {
      await fs.promises.mkdir(full(dir, rel), { recursive: true })
    },
    removeDir: async (dir, rel) => {
      const target = full(dir, rel)
      try {
        await fs.promises.rmdir(target)
        return true
      } catch {
        try {
          await fs.promises.stat(target)
          return false
        } catch {
          return true
        }
      }
    },
    watch: (dir, onChange) => {
      try {
        const watcher = fs.watch(dir, { recursive: true }, onChange)
        watcher.on('error', () => watcher.close())
        return () => watcher.close()
      } catch {
        return () => undefined
      }
    }
  }
}

export interface DesktopFS { fs: ExternalFS, isAbsolute: (path: string) => boolean }

export function desktopFS (): DesktopFS | null {
  if (Platform.isDesktop) {
    const fs = require('fs') as NodeFs
    const path = require('path') as NodePath
    const electron = require('electron') as { shell?: Shell }
    return { fs: build(fs, path, electron.shell ?? null), isAbsolute: (p) => path.isAbsolute(p) }
  }
  return null
}

interface Dialog { showOpenDialog: (...args: unknown[]) => Promise<{ canceled: boolean, filePaths: string[] }> }
interface Remote { dialog?: Dialog, getCurrentWindow?: () => unknown }

function remote (): Remote | null {
  try {
    const electron = require('electron') as { remote?: Remote }
    if (electron.remote?.dialog) return electron.remote
  } catch {
    return null
  }
  try {
    const module = require('@electron/remote') as Remote
    return module.dialog ? module : null
  } catch {
    return null
  }
}

export function folderPicker (): (() => Promise<string | null>) | null {
  if (!Platform.isDesktop) return null
  const r = remote()
  const dialog = r?.dialog
  if (!r || !dialog) return null
  return async () => {
    const options = { properties: ['openDirectory', 'createDirectory'] }
    const win = r.getCurrentWindow?.()
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  }
}

export async function makeFolder (dir: string): Promise<void> {
  if (Platform.isDesktop) {
    const fs = require('fs') as NodeFs
    await fs.promises.mkdir(dir, { recursive: true })
  }
}
