import { cancel, later, type Timer } from './timers'

export type Message = Record<string, unknown> & { t: string }

export interface ConnectionOptions {
  url: () => string
  WebSocketImpl?: typeof WebSocket
  onOpen: () => void
  onMessage: (msg: Message) => void
  onClose: (code: number) => boolean
}

function closeQuietly (ws: WebSocket | null): void {
  if (!ws) return
  try {
    ws.close()
  } catch {
    return
  }
}

export class Connection {
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: Timer | null = null
  private stopped = false

  constructor (private readonly o: ConnectionOptions) {}

  get open (): boolean {
    return this.ws !== null && this.ws.readyState === 1
  }

  connect (): void {
    if (this.stopped || this.ws) return
    const Impl = this.o.WebSocketImpl ?? WebSocket
    const ws = new Impl(this.o.url())
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.o.onOpen()
    }
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      let msg: Message
      try {
        msg = JSON.parse(event.data) as Message
      } catch {
        return
      }
      this.o.onMessage(msg)
    }
    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return
      this.ws = null
      const retry = this.o.onClose(event.code)
      if (retry && !this.stopped) this.schedule()
    }
    ws.onerror = () => {}
  }

  private schedule (): void {
    if (this.timer) return
    const delay = Math.min(15000, 500 * 2 ** this.attempt++) + Math.random() * 500
    this.timer = later(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  send (msg: Message): boolean {
    if (!this.open || !this.ws) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  reconnect (): void {
    if (this.timer) { cancel(this.timer); this.timer = null }
    const ws = this.ws
    this.ws = null
    closeQuietly(ws)
    if (!this.stopped) this.connect()
  }

  close (): void {
    this.stopped = true
    if (this.timer) cancel(this.timer)
    const ws = this.ws
    this.ws = null
    closeQuietly(ws)
  }
}
