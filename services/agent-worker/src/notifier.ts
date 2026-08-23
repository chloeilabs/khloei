export class TaskEventNotifier {
  private readonly listeners = new Map<string, Set<() => void>>()

  notify(taskId: string) {
    const listeners = this.listeners.get(taskId)
    if (!listeners) return
    this.listeners.delete(taskId)
    for (const listener of listeners) listener()
  }

  wait(taskId: string, timeoutMs: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      let finished = false
      const listeners = this.listeners.get(taskId) ?? new Set<() => void>()
      this.listeners.set(taskId, listeners)

      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        listeners.delete(finish)
        if (listeners.size === 0) this.listeners.delete(taskId)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      signal?.addEventListener('abort', finish, { once: true })
      listeners.add(finish)
    })
  }
}
