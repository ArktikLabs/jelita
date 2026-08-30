import Link from 'next/link'
import { headers } from 'next/headers'
import { requirePageOrg } from '@/lib/session'
import { auth } from '@/lib/auth'
import { listBranches } from '@/lib/branch'
import { branchLabel } from '@/lib/branch-label'
import { buttonVariants } from '@/components/ui/button'
import { BranchSwitcher } from './branch-switcher'
import { signOutAction } from './actions'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePageOrg()
  const activeTeamId = session.session.activeTeamId ?? null
  const { success: canSwitch } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { branch: ['switch'] } },
  })
  // A role that cannot switch must never RECEIVE the branch list: props to a
  // client component are serialized into the RSC payload whether or not they
  // are rendered, so passing the whole table and letting the component pick one
  // label handed front desk and stylists every branch's name, address, phone
  // and lock state on every page — the very table spec §8 guards /branches to
  // keep from them. They get one row, resolved and rendered on the server.
  const branches = canSwitch
    ? await listBranches(session.organizationId)
    : activeTeamId ? await listBranches(session.organizationId, activeTeamId) : []
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <Link href="/dashboard" className="font-medium">Jelita</Link>
        <div className="flex items-center gap-4 text-sm">
          {canSwitch ? (
            <BranchSwitcher branches={branches} activeTeamId={activeTeamId} />
          ) : (
            <span className="text-sm text-muted-foreground">
              {branches[0] ? branchLabel(branches[0]) : '—'}
            </span>
          )}
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
