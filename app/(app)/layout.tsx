import Link from 'next/link'
import { headers } from 'next/headers'
import { requirePageOrg } from '@/lib/session'
import { auth } from '@/lib/auth'
import { listBranches } from '@/lib/branch'
import { buttonVariants } from '@/components/ui/button'
import { BranchSwitcher } from './branch-switcher'
import { signOutAction } from './actions'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePageOrg()
  const [branches, { success: canSwitch }] = await Promise.all([
    listBranches(session.organizationId),
    auth.api.hasPermission({
      headers: await headers(),
      body: { permissions: { branch: ['switch'] } },
    }),
  ])
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <Link href="/dashboard" className="font-medium">Jelita</Link>
        <div className="flex items-center gap-4 text-sm">
          <BranchSwitcher
            branches={branches}
            activeTeamId={session.session.activeTeamId ?? null}
            canSwitch={canSwitch}
          />
          <Link href="/profile" className="underline">{session.user.name}</Link>
          {/* The (auth) layout bounces a signed-in user away from /login, so
              this is the only reachable way out of the app. */}
          <form action={signOutAction}>
            <button
              type="submit"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Keluar
            </button>
          </form>
        </div>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  )
}
