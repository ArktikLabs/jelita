import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Signed-out-only group: nothing on these pages applies once you have a
  // session. A user with no organization hops on to /dashboard/onboarding
  // via the dashboard guard — two redirects, by design. /reset-password lives
  // outside this group precisely because it must still work while signed in.
  const session = await getSession()
  if (session?.user) redirect('/dashboard')

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
