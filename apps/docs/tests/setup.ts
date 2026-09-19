// Node 26 exposes experimental global storage accessors that return undefined
// without --localstorage-file. Vitest aliases JSDOM's window to globalThis, so
// install the browser Storage contract explicitly for renderer tests.
function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key) {
      return values.get(String(key)) ?? null
    },
    key(index) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key) {
      values.delete(String(key))
    },
    setItem(key, value) {
      values.set(String(key), String(value))
    },
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: memoryStorage(),
})
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: memoryStorage(),
})
