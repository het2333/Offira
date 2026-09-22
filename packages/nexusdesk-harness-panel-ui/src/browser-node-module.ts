/** Same fail-closed browser seam used by the official Harness web build. */
export function createRequire(): never {
  throw new Error('Node module loading is not available in the browser.')
}
