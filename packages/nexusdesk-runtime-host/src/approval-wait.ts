/** Host owns the 120s approval deadline. The extra 10s is transport grace, not permission. */
export function waitForApproval(reply: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const finish = (approved: boolean) => { cleanup(); resolve(approved) }
    const abort = () => { cleanup(); reject(signal.reason) }
    const timer = setTimeout(() => finish(false), 130_000)
    signal.addEventListener('abort', abort, { once: true })
    void reply.then(finish, () => finish(false))
  })
}
