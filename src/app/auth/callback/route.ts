// ============================================================
// GET /auth/callback
//
// The Supabase Auth PKCE landing point. `createBrowserClient` /
// `createServerClient` (src/lib/supabase/*.ts) both default to
// `flowType: "pkce"`, so every email link Supabase sends (signup
// confirmation, password reset, invite) redirects the browser to
// `{redirectTo}?code=<uuid>` — the app must exchange that code for a
// real session via `exchangeCodeForSession`, using a cookie-writing
// client so middleware and server components see it too. Nothing in
// this codebase did that before this route existed, which is why a
// confirmation link used to land on a page with an inert `?code=...`
// query string and no session.
//
// `emailRedirectTo`/`resetPasswordForEmail`'s `redirectTo` should
// always point here (see signup/page.tsx and forgot-password/page.tsx)
// with a `next` telling us where to land afterwards.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';

/**
 * `next` is attacker-controllable (it round-trips through an
 * unauthenticated email link), so it must be constrained to a
 * same-origin relative path before use in a redirect — otherwise this
 * route is an open redirect: a link to this app's own domain could
 * bounce a victim to an external phishing page after they click what
 * looks like a legitimate confirmation link.
 */
function safeNext(next: string | null): string {
  if (!next) return '/dashboard';
  if (!next.startsWith('/')) return '/dashboard'; // rejects absolute/scheme URLs
  if (next.startsWith('//')) return '/dashboard'; // rejects protocol-relative URLs
  if (next.includes('\\')) return '/dashboard'; // some URL parsers treat \ as /
  return next;
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = safeNext(searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=confirmation_failed`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
