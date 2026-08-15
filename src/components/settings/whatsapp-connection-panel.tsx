'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Loader2, MessageSquare, QrCode } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';
import { WhatsAppEvolutionConfig } from './whatsapp-evolution-config';

type Provider = 'meta' | 'evolution' | null;

/**
 * Escape hatch back to the Meta-vs-Evolution picker. Without this, an
 * account that already has *any* whatsapp_config row (the common case —
 * Meta was the only provider before Evolution existed) can never reach
 * the picker again, so the Evolution option becomes permanently
 * unreachable from the UI.
 */
function SwitchProviderLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </button>
  );
}

/**
 * Container for the WhatsApp settings section. Decides which of three
 * things to render: a Meta-vs-Evolution picker (no connection yet), the
 * existing (unchanged) Meta config form, or the new Evolution QR flow.
 *
 * `whatsapp-config.tsx` itself is never edited by this — it's rendered
 * as-is when a Meta config exists, so the official integration keeps
 * behaving exactly as it did before Evolution existed.
 */
export function WhatsAppConnectionPanel() {
  const t = useTranslations('Settings.whatsapp');
  const { accountId, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<Provider>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const checkExistingConnection = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      const supabase = createClient();
      const [{ data: metaConfig }, evolutionRes] = await Promise.all([
        supabase
          .from('whatsapp_config')
          .select('id')
          .eq('account_id', acctId)
          .maybeSingle(),
        fetch('/api/whatsapp/connections').then((r) => (r.ok ? r.json() : { connection: null })),
      ]);

      if (metaConfig) {
        setProvider('meta');
      } else if (evolutionRes?.connection) {
        setProvider('evolution');
      } else {
        setProvider(null);
      }
    } catch (err) {
      console.error('[whatsapp-connection-panel] failed to resolve provider:', err);
      setProvider(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || !accountId) return;
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void checkExistingConnection(accountId);
  }, [accountId, authLoading, checkExistingConnection]);

  if (authLoading || loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  if (provider === 'meta') {
    return (
      <div>
        <SwitchProviderLink onClick={() => setProvider(null)} label={t('switchProvider')} />
        <WhatsAppConfig />
      </div>
    );
  }

  if (provider === 'evolution') {
    return (
      <div>
        <SwitchProviderLink onClick={() => setProvider(null)} label={t('switchProvider')} />
        <WhatsAppEvolutionConfig
          onDisconnected={() => {
            setProvider(null);
          }}
        />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('picker.title')} description={t('picker.description')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader>
            <MessageSquare className="size-6 text-primary" />
            <CardTitle className="mt-2">{t('picker.metaTitle')}</CardTitle>
            <CardDescription>{t('picker.metaDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto pt-0">
            <Button className="w-full" onClick={() => setProvider('meta')}>
              {t('picker.choose')}
            </Button>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <QrCode className="size-6 text-primary" />
            <CardTitle className="mt-2">{t('picker.evolutionTitle')}</CardTitle>
            <CardDescription>{t('picker.evolutionDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto pt-0">
            <Button className="w-full" variant="outline" onClick={() => setProvider('evolution')}>
              {t('picker.choose')}
            </Button>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
