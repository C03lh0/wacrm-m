import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, it } from 'vitest'

import messages from '../../../messages/en.json'
import type { DashboardOverview } from '@/lib/dashboard/overview'
import { AttentionRow } from './attention-row'

const data = {
  attention: {
    waiting: 0,
    oldestWaitingSince: null,
    waitingOverTarget: 0,
    unassigned: 0,
    windowsClosing: 3,
    failed: 0,
    failedMessages: [],
    queue: [],
  },
} as unknown as DashboardOverview

function render(sessionWindowApplies?: boolean) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <AttentionRow data={data} now={0} onlineCount={0} sessionWindowApplies={sessionWindowApplies} />
    </NextIntlClientProvider>,
  )
}

describe('AttentionRow', () => {
  it('shows the reply-windows-closing tile by default (Meta)', () => {
    const html = render()
    expect(html).toContain('filter=expiring')
    expect(html).toContain('xl:grid-cols-4')
  })

  it('hides the reply-windows-closing tile when the provider has no session window (Evolution)', () => {
    const html = render(false)
    expect(html).not.toContain('filter=expiring')
    expect(html).toContain('xl:grid-cols-3')
  })
})
