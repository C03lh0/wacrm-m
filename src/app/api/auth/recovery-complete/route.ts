// ============================================================
// POST /api/auth/recovery-complete
//
// Lifts the password-recovery lock set by /auth/callback (see
// src/lib/auth/recovery.ts). The marker cookie is httpOnly precisely so
// the reset page can't clear it on its own — otherwise anyone holding a
// recovery session could skip the password change and walk into the
// app, which is the hole the lock exists to close.
//
// The proof that the password really changed is the user's `updated_at`:
// the cookie carries the value captured when the link was redeemed, and
// a successful `updateUser({ password })` moves it. Same value still =>
// nothing was changed => the lock stays on.
// ============================================================

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { RECOVERY_COOKIE } from '@/lib/auth/recovery';

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cookieStore = await cookies();
  const marker = cookieStore.get(RECOVERY_COOKIE);

  if (!marker) {
    // Nothing to unlock — treat as already done so a retry from the
    // reset page isn't a hard failure.
    return NextResponse.json({ ok: true });
  }

  if (user.updated_at && user.updated_at === marker.value) {
    return NextResponse.json(
      { error: 'Password has not been changed yet' },
      { status: 409 }
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete({ name: RECOVERY_COOKIE, path: '/' });
  return response;
}
