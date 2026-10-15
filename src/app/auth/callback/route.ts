// ============================================================
// GET /auth/callback — where every link Supabase emails on our behalf
// lands (email confirmation after sign-up, password reset, invite,
// magic link).
//
// Before this route existed, the password-reset email pointed here
// and 404'd (issue #592) — anyone who forgot their password was locked
// out. Sign-up relied on Supabase's default redirect (the Site URL),
// which on a mis-configured or self-hosted instance is
// `http://localhost:3000` (issue #595), and even when correct dropped
// the user on `/` with an unexchanged `?code=` that the root redirect
// discarded — so they had to sign in again after verifying.
//
// Flow:
//   1. `?error=...`         → Supabase already rejected the link
//                             (expired / used). Send to /login with a
//                             reason it can explain.
//   2. `?code=...`          → PKCE exchange (default email templates).
//      `?token_hash=&type=` → verifyOtp (templates using {{ .TokenHash }}).
//   3. success              → 303 to the validated `next` path
//                             (/dashboard, /reset-password, /join/<t>).
//      failure              → 303 to /login?error=link_invalid.
//
// A password-reset link is special: the exchange mints an ORDINARY
// session, so the response also carries the recovery lock cookie that
// confines it to the reset form (see lib/auth/recovery).
//
// The session cookies are written by `@supabase/ssr` through the
// server client's cookie adapter, so the redirected-to page (and the
// middleware in front of it) sees the user signed in.
//
// `Location` is emitted as a relative path on purpose — see
// `relativeRedirect` for the reverse-proxy reasoning.
// ============================================================

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import {
  loginFailurePath,
  parseEmailLink,
  parseSupabaseError,
  relativeRedirect,
  safeNextPath,
} from '@/lib/auth/callback';
import {
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_MAX_AGE,
  RESET_PASSWORD_PATH,
} from '@/lib/auth/recovery';

// Session exchange is per-request by definition; never prerender.
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const next = safeNextPath(searchParams.get('next'));

  const upstreamError = parseSupabaseError(searchParams);
  if (upstreamError) {
    return relativeRedirect(loginFailurePath(upstreamError));
  }

  const link = parseEmailLink(searchParams);
  if (!link) {
    return relativeRedirect(loginFailurePath('link_invalid'));
  }

  const supabase = await createClient();
  const { data, error } =
    link.kind === 'code'
      ? await supabase.auth.exchangeCodeForSession(link.code)
      : await supabase.auth.verifyOtp({
          type: link.type,
          token_hash: link.tokenHash,
        });

  if (error) {
    // Most common cause in practice: the PKCE code verifier cookie is
    // missing because the link was opened in a different browser than
    // the one that requested it. The email itself was still verified
    // by Supabase, so /login's message tells the user to just sign in.
    console.warn('[GET /auth/callback] session exchange failed:', {
      kind: link.kind,
      message: error.message,
    });
    return relativeRedirect(loginFailurePath('link_invalid'));
  }

  // `type=recovery` is the signal on a {{ .TokenHash }} template, which
  // need not carry a `next` at all; the default templates come back
  // with `next=/reset-password` instead. Either way the session is a
  // recovery session and must be locked to the reset form.
  const isRecovery =
    next === RESET_PASSWORD_PATH ||
    (link.kind === 'token_hash' && link.type === 'recovery');

  if (!isRecovery) {
    return relativeRedirect(next);
  }

  // Same 303 + no-store as `relativeRedirect`, via NextResponse so the
  // lock cookie can be attached. The cookie value is the user's
  // `updated_at` at redemption time, which is what lets
  // /api/auth/recovery-complete tell a real password change from a
  // request that just wants the lock lifted.
  const response = new NextResponse(null, {
    status: 303,
    headers: {
      Location: next === RESET_PASSWORD_PATH ? next : RESET_PASSWORD_PATH,
      'Cache-Control': 'no-store',
    },
  });

  // A TLS-terminating proxy forwards the request over http, so the
  // scheme on `request.url` alone would drop `Secure` in exactly the
  // deployment that needs it.
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim();

  response.cookies.set(RECOVERY_COOKIE, data?.user?.updated_at ?? '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: forwardedProto
      ? forwardedProto === 'https'
      : new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge: RECOVERY_COOKIE_MAX_AGE,
  });

  return response;
}
