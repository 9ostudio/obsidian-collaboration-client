export type Timer = number

export function later (fn: () => void, ms: number): Timer {
  return window.setTimeout(fn, ms)
}

export function cancel (timer: Timer | null | undefined): void {
  if (timer !== null && timer !== undefined) window.clearTimeout(timer)
}

export function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => { later(resolve, ms) })
}
