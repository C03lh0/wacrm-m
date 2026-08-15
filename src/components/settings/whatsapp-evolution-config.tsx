'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Loader2, QrCode, RotateCcw } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useRealtime, type WhatsAppConnectionRow } from '@/hooks/use-realtime';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';

const QR_AUTO_REFRESH_LIMIT = 5;

interface ConnectionApiShape {
  connectionId?: string;
  id?: string;
  provider: 'evolution';
  status: WhatsAppConnectionRow['status'];
  qrCode?: string | null;
  qr_code?: string | null;
  qrExpiresAt?: string | null;
  qr_expires_at?: string | null;
  phone_number?: string | null;
  error?: { code: string; message: string };
}

function qrImageSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`;
}

export function WhatsAppEvolutionConfig({
  onDisconnected,
}: {
  onDisconnected: () => void;
}) {
  const t = useTranslations('Settings.whatsapp.evolution');
  const { accountId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [refreshingQr, setRefreshingQr] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [status, setStatus] = useState<WhatsAppConnectionRow['status'] | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrExpiresAt, setQrExpiresAt] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const autoRefreshCountRef = useRef(0);

  const applyConnection = useCallback((data: ConnectionApiShape | null) => {
    if (!data) {
      setStatus(null);
      setQrCode(null);
      setQrExpiresAt(null);
      setPhoneNumber(null);
      return;
    }
    setStatus(data.status);
    setQrCode(data.qrCode ?? data.qr_code ?? null);
    setQrExpiresAt(data.qrExpiresAt ?? data.qr_expires_at ?? null);
    if (data.phone_number) setPhoneNumber(data.phone_number);
  }, []);

  const fetchConnection = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/connections');
      const data = await res.json();
      applyConnection(data.connection);
    } catch (err) {
      console.error('[whatsapp-evolution-config] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [applyConnection]);

  useEffect(() => {
    void fetchConnection();
  }, [fetchConnection]);

  // Live status updates from the Evolution webhook — no polling needed
  // once the QR has been shown; the row flips qr_required → connecting
  // → connected as events arrive.
  useRealtime({
    channelName: `whatsapp-connection-${accountId ?? 'anon'}`,
    enabled: Boolean(accountId),
    onConnectionEvent: (event) => {
      if (event.eventType === 'DELETE') return;
      applyConnection(event.new);
      if (event.new.status === 'connected') {
        autoRefreshCountRef.current = 0;
        toast.success(t('connectedTitle'));
      }
    },
  });

  const refreshQr = useCallback(async () => {
    setRefreshingQr(true);
    try {
      const res = await fetch('/api/whatsapp/connections/qr', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error?.message || data.error || t('errorGeneric'));
        return;
      }
      applyConnection(data);
    } catch (err) {
      console.error('[whatsapp-evolution-config] QR refresh failed:', err);
      toast.error(t('errorGeneric'));
    } finally {
      setRefreshingQr(false);
    }
  }, [applyConnection, t]);

  // QR expiry countdown — the only "polling-adjacent" behavior in this
  // flow, and it's a plain client-side timer, not a network request.
  useEffect(() => {
    if (!qrExpiresAt || status === 'connected') {
      setSecondsLeft(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.floor((new Date(qrExpiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0 && autoRefreshCountRef.current < QR_AUTO_REFRESH_LIMIT) {
        autoRefreshCountRef.current += 1;
        void refreshQr();
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [qrExpiresAt, status, refreshQr]);

  async function handleConnect() {
    setConnecting(true);
    try {
      const res = await fetch('/api/whatsapp/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'evolution' }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error?.message || data.error || t('errorGeneric'));
        return;
      }
      autoRefreshCountRef.current = 0;
      applyConnection(data);
    } catch (err) {
      console.error('[whatsapp-evolution-config] connect failed:', err);
      toast.error(t('errorGeneric'));
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm(`${t('disconnectConfirmTitle')} ${t('disconnectConfirmDesc')}`)) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/connections', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error?.message || data.error || t('errorGeneric'));
        return;
      }
      toast.success(t('disconnect'));
      onDisconnected();
    } catch (err) {
      console.error('[whatsapp-evolution-config] disconnect failed:', err);
      toast.error(t('errorGeneric'));
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {status === 'connected' ? (
        <Card className="max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-green-600" />
              <CardTitle>{t('connectedTitle')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('provider')}</span>
              <Badge variant="secondary">{t('providerName')}</Badge>
            </div>
            {phoneNumber ? (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('phoneNumber')}</span>
                <span className="font-medium text-foreground">+{phoneNumber}</span>
              </div>
            ) : null}
            <Button
              variant="outline"
              className="w-full"
              onClick={handleDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? t('disconnecting') : t('disconnect')}
            </Button>
          </CardContent>
        </Card>
      ) : status === 'disconnected' || status === 'error' ? (
        <Card className="max-w-md">
          <CardHeader>
            <QrCode className="size-6 text-muted-foreground" />
            <CardTitle className="mt-2">{t('disconnectedTitle')}</CardTitle>
            <CardDescription>{t('disconnectedDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={() => void refreshQr()} disabled={refreshingQr}>
              {refreshingQr ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('reconnecting')}
                </>
              ) : (
                t('reconnect')
              )}
            </Button>
          </CardContent>
        </Card>
      ) : status && qrCode ? (
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>{t('waitingForScan')}</CardTitle>
            <CardDescription>{t('scanInstructions')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <div className="rounded-lg border border-border bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrImageSrc(qrCode)} alt="WhatsApp QR code" className="size-56" />
            </div>
            {secondsLeft > 0 ? (
              <p className="text-sm text-muted-foreground">{secondsLeft}s</p>
            ) : (
              <Alert>
                <AlertTitle>{t('qrExpired')}</AlertTitle>
                <AlertDescription>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => void refreshQr()}
                    disabled={refreshingQr}
                  >
                    <RotateCcw className="size-3.5" />
                    {refreshingQr ? t('refreshingQr') : t('refreshQr')}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="max-w-md">
          <CardHeader>
            <QrCode className="size-6 text-primary" />
            <CardTitle className="mt-2">{t('title')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={handleConnect} disabled={connecting}>
              {connecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('connecting')}
                </>
              ) : (
                t('connect')
              )}
            </Button>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
