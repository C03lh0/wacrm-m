// ============================================================
// Password-recovery session lock
//
// Clicking a Supabase password-reset email runs the PKCE exchange in
// /auth/callback, which mints an ORDINARY session — same cookies, same
// privileges as signing in with a password. Without extra gating that
// makes a recovery link a one-click login: whoever opens the email can
// walk straight into /dashboard and never set a new password, and the
// "back to sign in" link bounces off the middleware's
// already-authenticated rule right back into the app.
//
// So the callback marks recovery sessions with this cookie and the
// middleware refuses to serve anything but /reset-password while it is
// present. The cookie is httpOnly so the page can't lift the lock on
// its own — it POSTs /api/auth/recovery-complete, which only clears it
// once the user record actually changed (i.e. the password really was
// updated). The cookie value is the user's `updated_at` from the moment
// the link was redeemed, which is what makes that check possible.
// ============================================================

export const RECOVERY_COOKIE = 'pw-recovery';

/** Long enough to pick a password, short enough that an abandoned tab
 *  doesn't leave a half-privileged session lying around. */
export const RECOVERY_COOKIE_MAX_AGE = 15 * 60;

export const RESET_PASSWORD_PATH = '/reset-password';

export const RECOVERY_COMPLETE_PATH = '/api/auth/recovery-complete';

/**
 * Paths a locked recovery session may still reach: the reset form
 * itself, the endpoint that lifts the lock, and /auth/* so a second
 * callback (or a sign-out) isn't trapped in a redirect loop.
 */
export function isRecoveryAllowedPath(pathname: string): boolean {
  return (
    pathname === RESET_PASSWORD_PATH ||
    pathname === RECOVERY_COMPLETE_PATH ||
    pathname.startsWith('/auth/')
  );
}
