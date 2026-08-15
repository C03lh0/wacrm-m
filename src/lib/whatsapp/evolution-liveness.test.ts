import { describe, expect, it, vi, beforeEach } from 'vitest'

const { fetchInstanceInfo, probeInstanceLiveness, restartInstance } = vi.hoisted(() => ({
  fetchInstanceInfo: vi.fn(),
  probeInstanceLiveness: vi.fn(),
  restartInstance: vi.fn(async () => {}),
}))
vi.mock('./providers/evolution-api', () => ({ fetchInstanceInfo, probeInstanceLiveness, restartInstance }))

import { checkAndRecoverInstanceLiveness } from './evolution-liveness'

const CONNECTION = { id: 'conn-1', instance_name: 'wacrm-acct1-0001' }

describe('checkAndRecoverInstanceLiveness', () => {
  beforeEach(() => {
    fetchInstanceInfo.mockReset()
    probeInstanceLiveness.mockReset()
    restartInstance.mockClear()
  })

  it('skips the probe entirely when the instance is not reporting "open"', async () => {
    fetchInstanceInfo.mockResolvedValue({ connectionStatus: 'close', ownerJid: '5511999999999@s.whatsapp.net' })

    const result = await checkAndRecoverInstanceLiveness(CONNECTION)

    expect(result).toEqual({ checked: false })
    expect(probeInstanceLiveness).not.toHaveBeenCalled()
    expect(restartInstance).not.toHaveBeenCalled()
  })

  it('skips the probe when "open" but the owner number is not yet known', async () => {
    fetchInstanceInfo.mockResolvedValue({ connectionStatus: 'open', ownerJid: null })

    const result = await checkAndRecoverInstanceLiveness(CONNECTION)

    expect(result).toEqual({ checked: false })
    expect(probeInstanceLiveness).not.toHaveBeenCalled()
  })

  it('probes with the owner number (digits only, JID suffix stripped) when "open" and reports alive on success', async () => {
    fetchInstanceInfo.mockResolvedValue({ connectionStatus: 'open', ownerJid: '5511999999999@s.whatsapp.net' })
    probeInstanceLiveness.mockResolvedValue({ alive: true })

    const result = await checkAndRecoverInstanceLiveness(CONNECTION)

    expect(probeInstanceLiveness).toHaveBeenCalledWith({ instanceName: 'wacrm-acct1-0001', number: '5511999999999' })
    expect(result).toEqual({ checked: true, alive: true })
    expect(restartInstance).not.toHaveBeenCalled()
  })

  it('restarts the instance when the probe reports not-alive (the zombie-session case)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchInstanceInfo.mockResolvedValue({ connectionStatus: 'open', ownerJid: '5511999999999@s.whatsapp.net' })
    probeInstanceLiveness.mockResolvedValue({ alive: false, reason: 'fetchProfile returned HTTP 500' })

    const result = await checkAndRecoverInstanceLiveness(CONNECTION)

    expect(restartInstance).toHaveBeenCalledWith({ instanceName: 'wacrm-acct1-0001' })
    expect(result).toEqual({ checked: true, alive: false, restarted: true })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection=conn-1'))
    warnSpy.mockRestore()
  })

  it('propagates a restartInstance failure to the caller (no silent swallow)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchInstanceInfo.mockResolvedValue({ connectionStatus: 'open', ownerJid: '5511999999999@s.whatsapp.net' })
    probeInstanceLiveness.mockResolvedValue({ alive: false, reason: 'timeout' })
    restartInstance.mockRejectedValueOnce(new Error('Evolution unreachable'))

    await expect(checkAndRecoverInstanceLiveness(CONNECTION)).rejects.toThrow('Evolution unreachable')
  })
})
