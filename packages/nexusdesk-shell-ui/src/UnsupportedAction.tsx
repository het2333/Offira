import { HostError } from '@nexusdesk/office-host'

export function unsupportedCapability(message: string): HostError {
  return new HostError('UNSUPPORTED_CAPABILITY', message, false)
}

export function UnsupportedAction({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="unsupported-action" role="alert">
      {message}
    </div>
  )
}
