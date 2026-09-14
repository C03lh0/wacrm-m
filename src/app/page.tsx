import { redirect } from 'next/navigation'

interface RootPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default async function RootPage({ searchParams }: RootPageProps) {
  const params = await searchParams

  // Defensive fallback: a Supabase email link (confirmation, reset,
  // invite) lands here with a `?code=` when the project's dashboard
  // "Site URL" is the bare origin — the common default. Forward it to
  // /auth/callback (which does the actual PKCE code exchange) instead
  // of dropping it, which is what a plain redirect('/dashboard') would
  // do (this function's own redirect() below strips the query string).
  const code = typeof params.code === 'string' ? params.code : undefined
  if (code) {
    const next = typeof params.next === 'string' ? params.next : '/dashboard'
    redirect(
      `/auth/callback?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`
    )
  }

  redirect('/dashboard')
}
