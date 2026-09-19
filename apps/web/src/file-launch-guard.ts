export function fileLaunchMessage(url: URL): string | undefined {
  if (url.protocol !== 'file:') return undefined
  return 'NexusDesk must be opened through Local Host. Run: npm run start:web -- /absolute/file.xlsx'
}
