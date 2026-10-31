import type { SupabaseClient } from '@supabase/supabase-js'
import { groupInboundMessages } from './activity-grouping'
import type { ActivityItem } from './types'

// Rows carry raw `params`, not finished sentences: this runs in the
// browser and the locale is a per-request cookie here, so the feed
// component does the ICU formatting (see ActivityItem in ./types).

type DB = SupabaseClient

export async function loadActivity(db: DB, limit = 20): Promise<ActivityItem[]> {
  const [msgs, contacts, deals, broadcasts, autoLogs] = await Promise.all([
    db
      .from('messages')
      .select('id, content_text, sender_type, created_at, conversation_id, conversations(contact_id, contacts(name, phone))')
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(40),
    db
      .from('contacts')
      .select('id, name, phone, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('deals')
      .select('id, title, updated_at, stage:pipeline_stages(name)')
      .order('updated_at', { ascending: false })
      .limit(10),
    db
      .from('broadcasts')
      .select('id, name, status, total_recipients, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
    db
      .from('automation_logs')
      .select('id, trigger_event, status, created_at, automation:automations(name), contact:contacts(name, phone)')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const items: ActivityItem[] = []

  const inbound = (msgs.data ?? []) as unknown as Array<{
    id: string
    created_at: string
    conversation_id: string
    conversations:
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }[]
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }
      | null
  }>

  // One row per conversation ("X sent 3 messages") rather than three
  // near-identical rows crowding the feed.
  const grouped = groupInboundMessages(
    inbound.map((m) => {
      const conv = Array.isArray(m.conversations) ? m.conversations[0] : m.conversations
      const contact = Array.isArray(conv?.contacts) ? conv?.contacts[0] : conv?.contacts
      return {
        id: m.id,
        conversationId: m.conversation_id,
        // Empty rather than a translated fallback: the component
        // substitutes its own `unknownContact` label.
        who: contact?.name || contact?.phone || '',
        at: m.created_at,
      }
    }),
  )

  for (const g of grouped) {
    items.push({
      id: `msg-${g.id}`,
      kind: 'message',
      params: { who: g.who || null, count: g.count },
      at: g.at,
      href: `/inbox?c=${g.conversationId}`,
    })
  }

  for (const c of (contacts.data ?? []) as Array<{ id: string; name: string | null; phone: string; created_at: string }>) {
    items.push({
      id: `contact-${c.id}`,
      kind: 'contact',
      params: { name: c.name || c.phone },
      at: c.created_at,
      href: '/contacts',
    })
  }

  for (const d of (deals.data ?? []) as unknown as Array<{
    id: string
    title: string
    updated_at: string
    stage: { name: string }[] | { name: string } | null
  }>) {
    const stage = Array.isArray(d.stage) ? d.stage[0] : d.stage
    items.push({
      id: `deal-${d.id}`,
      kind: 'deal',
      params: stage?.name
        ? { title: d.title, stage: stage.name }
        : { title: d.title, stage: null },
      at: d.updated_at,
      href: '/pipelines',
    })
  }

  for (const b of (broadcasts.data ?? []) as Array<{
    id: string
    name: string
    status: string
    total_recipients: number
    created_at: string
  }>) {
    items.push({
      id: `broadcast-${b.id}`,
      kind: 'broadcast',
      params: {
        name: b.name,
        status: b.status,
        count: b.total_recipients,
        sent: b.status === 'sent',
      },
      at: b.created_at,
      href: '/broadcasts',
    })
  }

  for (const l of (autoLogs.data ?? []) as unknown as Array<{
    id: string
    trigger_event: string
    status: string
    created_at: string
    automation: { name: string }[] | { name: string } | null
    contact: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null
  }>) {
    const automation = Array.isArray(l.automation) ? l.automation[0] : l.automation
    const contact = Array.isArray(l.contact) ? l.contact[0] : l.contact
    const who = contact?.name || contact?.phone || null
    const autoName = automation?.name || null
    items.push({
      id: `auto-${l.id}`,
      kind: 'automation',
      params: { name: autoName, who, failed: l.status === 'failed' },
      at: l.created_at,
    })
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit)
}
