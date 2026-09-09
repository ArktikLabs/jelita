import Link from 'next/link'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { STAFF_LIST, listStaff } from '@/lib/staff'
import { branchesOf } from '@/lib/branch'
import { getEntitlements, countResource } from '@/lib/plan/entitlements'
import { parseListQuery } from '@/lib/list-query'
import { listHref, type Params } from '@/lib/list-url'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SortableHead } from '@/components/list/sortable-head'
import { FilterBar } from '@/components/list/filter-bar'
import { Pagination } from '@/components/list/pagination'
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
  searchParams: Promise<Params>
}) {
  await requirePagePermission({ staff: ['read'] })
  const { organizationId } = await requirePageOrg()
  const params = await searchParams
  const query = parseListQuery(STAFF_LIST, params)

  // Only owner and admin hold staff:read, so there is no partial-visibility
  // case here — everyone who reaches this page sees the whole roster.
  const [staff, branches, entitlements, used] = await Promise.all([
    listStaff(organizationId, query),
    branchesOf(organizationId),
    getEntitlements(organizationId),
    countResource(organizationId, 'staff'),
  ])
  const cap = entitlements.caps.staff

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

      <FilterBar
        spec={STAFF_LIST}
        query={query}
        params={params}
        controls={{
          branch: {
            type: 'select',
            placeholder: 'Semua cabang',
            options: branches.map((b) => ({ value: b.teamId, label: b.name })),
          },
        }}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead column="name" label="Nama" spec={STAFF_LIST} query={query} params={params} />
            <TableHead>Email</TableHead>
            <TableHead>Peran</TableHead>
            <TableHead>Cabang</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {staff.rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                {Object.keys(query.filters).length > 0 ? (
                  <>
                    Tidak ada staf yang cocok dengan filter ini.{' '}
                    <Link href={listHref(params, { branch: null, active: null })} className="underline">
                      Hapus filter
                    </Link>
                  </>
                ) : (
                  'Belum ada staf.'
                )}
              </TableCell>
            </TableRow>
          )}
          {staff.rows.map((s) => (
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

      <Pagination result={staff} params={params} />
    </div>
  )
}
