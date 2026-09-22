/** Restrict browser-editable and legacy-imported references to model API keys. */
export function isModelCredentialRef(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}_API_KEY$/.test(value)
}

/** Prepare the old app-owned provider file for one-time Harness migration. */
export function prepareLegacyProviderEnvironment(
  values: Record<string, string | undefined>,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const keys: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue
    if (isModelCredentialRef(name)) {
      keys[name] = value
      // The app-owned file historically beat an inherited shell key. Keeping
      // that shell key would shadow the new writable Harness credential.
      delete environment[name]
    } else {
      environment[name] = value
    }
  }
  return keys
}
