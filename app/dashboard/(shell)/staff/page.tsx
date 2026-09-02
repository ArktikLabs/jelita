import Link from 'next/link'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { listStaff } from '@/lib/staff'
import { listBranches } from '@/lib/branch'
import { getEntitlements, countResource } from '@/lib/plan/entitlements'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Pemilik',
  admin: 'Admin',
  frontdesk: 'Front desk',
  stylist: 'Terapis',
}

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>
}) {
  await requirePagePermission({ staff: ['read'] })
  const { organizationId } = await requirePageOrg()
  const { branch } = await searchParams

  // Only owner and admin hold staff:read, so there is no partial-visibility
  // case here — everyone who reaches this page sees the whole roster.
  const [staff, branches, entitlements, used] = await Promise.all([
    listStaff(organizationId),
    listBranches(organizationId),
    getEntitlements(organizationId),
    countResource(organizationId, 'staff'),
  ])
  const cap = entitlements.caps.staff
  const rows = branch ? staff.filter((s) => s.teamId === branch) : staff

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium">Staf</h1>
          {cap !== undefined && used !== null && (
            <p className="text-sm text-muted-foreground">
              {used} dari {cap} kursi staf terpakai
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/staff/import" className={buttonVariants({ variant: 'outline' })}>
            Impor staf
          </Link>
          <Link href="/dashboard/staff/new" className={buttonVariants()}>
            Tambah staf
          </Link>
        </div>
      </div>

      <form className="flex items-center gap-2">
        <select
          name="branch"
          defaultValue={branch ?? ''}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="">Semua cabang</option>
          {branches.map((b) => (
            <option key={b.teamId} value={b.teamId}>{b.name}</option>
          ))}
        </select>
        <button type="submit" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          Filter
        </button>
      </form>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nama</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Peran</TableHead>
            <TableHead>Cabang</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <TableRow key={s.userId}>
              <TableCell className="font-medium">{s.name}</TableCell>
              <TableCell>{s.email}</TableCell>
              <TableCell>{ROLE_LABEL[s.role] ?? s.role}</TableCell>
              <TableCell>{s.branchName ?? '—'}</TableCell>
              <TableCell>
                <Badge variant={s.active ? 'default' : 'secondary'}>
                  {s.active ? 'Aktif' : 'Nonaktif'}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
