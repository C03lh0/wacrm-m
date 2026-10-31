"use client"

import Link from 'next/link'
import { useState } from 'react'
import {
  MessageSquare,
  UserPlus,
  Briefcase,
  Radio,
  Zap,
  Inbox,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { ActivityItem, ActivityKind } from '@/lib/dashboard/types'
import { relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface ActivityFeedProps {
  items: ActivityItem[] | null
  loading: boolean
}

const PAGE_SIZES = [5, 10, 20, 50] as const
type PageSize = (typeof PAGE_SIZES)[number]

const KIND_ICON: Record<ActivityKind, ComponentType<{ className?: string }>> = {
  message: MessageSquare,
  contact: UserPlus,
  deal: Briefcase,
  broadcast: Radio,
  automation: Zap,
}

import { useTranslations } from 'next-intl'

export function ActivityFeed({ items, loading }: ActivityFeedProps) {
  const t = useTranslations('Dashboard.activityFeed')
  const tItems = useTranslations('Dashboard.activityFeed.items')
  // Start at 5 — a quick scan of the most recent events without
  // dominating vertical real estate. User expands explicitly via the
  // footer control when they want deeper history.
  const [pageSize, setPageSize] = useState<PageSize>(5)

  const totalLoaded = items?.length ?? 0
  const visible = items?.slice(0, pageSize) ?? []
  // A size option is "useful" if picking it would reveal rows the
  // smaller option doesn't already show. With PAGE_SIZES=[5,10,20,50]:
  // "10" is useful only once we've loaded ≥6 items, "20" once ≥11, etc.
  // The smallest option is always enabled.
  const isSizeUseful = (size: PageSize, i: number) =>
    i === 0 || totalLoaded > PAGE_SIZES[i - 1]

  return (
    <section className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <header className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
        <Link
          href="/inbox"
          className="text-xs font-medium text-primary hover:text-primary/80"
        >
          {t('viewAll')}
        </Link>
      </header>

      {loading || !items ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Inbox}
            title={t('noActivity')}
            hint={t('noActivityHint')}
          />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {visible.map((it, i) => {
              const Icon = KIND_ICON[it.kind]
              // Alternating row background for scanability. bg-muted/40
              // keeps the stripe visible in both light and dark modes
              // (bg-card/40 vanishes against a white card surface in light).
              const stripe = i % 2 === 0 ? 'bg-transparent' : 'bg-muted/40'
              const row = (
                <div className="flex items-center gap-3 px-5 py-2.5">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {buildText(it, tItems)}
                  </span>
                  <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">
                    {relativeTime(it.at, t)}
                  </span>
                </div>
              )
              return (
                <li key={it.id} className={cn(stripe, 'transition-colors hover:bg-muted/40')}>
                  {it.href ? (
                    <Link href={it.href} className="block">
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              )
            })}
          </ul>
          <footer className="flex items-center justify-between border-t border-border px-5 py-3 text-xs">
            <span className="text-muted-foreground tabular-nums">
              {t('showingOf', { visible: visible.length, totalLoaded, plus: totalLoaded === 50 ? '+' : '' })}
            </span>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-muted-foreground">{t('show')}</span>
              {PAGE_SIZES.map((size, i) => {
                const disabled = !isSizeUseful(size, i)
                return (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setPageSize(size)}
                    disabled={disabled}
                    className={cn(
                      'rounded-md px-2 py-1 font-medium tabular-nums transition-colors',
                      pageSize === size
                        ? 'bg-secondary text-secondary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
                    )}
                  >
                    {size}
                  </button>
                )
              })}
            </div>
          </footer>
        </>
      )}
    </section>
  )
}

/**
 * Builds the feed row's primary line from an item's `kind` + `params`
 * via an ICU message per kind — never pre-formatted English text, so
 * this is the only place that needs to know how each kind reads.
 * `t` should be scoped to `Dashboard.activityFeed.items`.
 */
function buildText(item: ActivityItem, t: ReturnType<typeof useTranslations>): string {
  const p = item.params
  switch (item.kind) {
    case 'message': {
      // `count` is the size of the inbound group for one conversation
      // (groupInboundMessages in lib/dashboard/activity-grouping).
      const who = (p.who as string) || t('unknownContact')
      const count = (p.count as number) ?? 1
      return count > 1 ? t('newMessages', { who, count }) : t('newMessage', { who })
    }
    case 'contact':
      return t('newContact', { name: p.name as string })
    case 'deal':
      return p.stage
        ? t('dealInStage', { title: p.title as string, stage: p.stage as string })
        : t('dealUpdated', { title: p.title as string })
    case 'broadcast':
      return p.sent
        ? t('broadcastSent', { name: p.name as string, count: p.count as number })
        : t('broadcastOther', {
            name: p.name as string,
            status: t(`broadcastStatus.${p.status as string}`),
            count: p.count as number,
          })
    case 'automation':
      return p.failed
        ? t('automationFailed', {
            name: (p.name as string) || t('unknownAutomation'),
            who: (p.who as string) || t('unknownContact'),
          })
        : t('automationTriggered', {
            name: (p.name as string) || t('unknownAutomation'),
            who: (p.who as string) || t('unknownContact'),
          })
    default:
      return ''
  }
}
