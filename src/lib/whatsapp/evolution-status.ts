/**
 * Maps Evolution API's raw connection-state vocabulary to the
 * internal, provider-independent status enum stored on
 * whatsapp_connections.status. Nothing outside this file should
 * compare against Evolution's raw strings.
 *
 * The raw values below (`close`/`connecting`/`open`) are Baileys'
 * well-known connection.update states, which Evolution API exposes
 * largely unchanged — ASSUMPTION, confirm against the target
 * deployment's actual `connection.update` / connectionState payloads.
 */

export type InternalConnectionStatus =
  | 'created'
  | 'connecting'
  | 'qr_required'
  | 'connected'
  | 'disconnected'
  | 'error'

const RAW_STATUS_MAP: Record<string, InternalConnectionStatus> = {
  open: 'connected',
  connected: 'connected',
  connecting: 'connecting',
  close: 'disconnected',
  closed: 'disconnected',
  disconnected: 'disconnected',
}

export function mapEvolutionStatus(raw: string): InternalConnectionStatus {
  const normalized = raw?.toLowerCase?.().trim()
  const mapped = normalized ? RAW_STATUS_MAP[normalized] : undefined
  if (!mapped) {
    console.warn(`[evolution] unmapped status: ${raw}`)
    return 'error'
  }
  return mapped
}
