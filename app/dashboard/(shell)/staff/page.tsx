import { Suspense } from 'react'
import Link from 'next/link'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { STAFF_LIST, listStaff } from '@/lib/staff'
import { branchesOf } from '@/lib/branch'
import { getEntitlements, countResource } from '@/lib/plan/entitlements'
import { parseListQuery } from '@/lib/list-query'
import { clearFilters, listHref, type Params } from '@/lib/list-url'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { SortableHead } from '@/components/list/sortable-head'
import { FilterBar } from '@/components/list/filter-bar'
import { Pagination } from '@/components/list/pagination'
import { SelectAll, SelectionBar, SelectionProvider, SelectRow } from '@/components/list-selection'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { deactivateSelectedStaffAction } from './actions'

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
  const rawParams = await searchParams
  // `bulkMsg` is a one-shot flash from deactivateSelectedStaffAction's
  // redirect -- kept out of `params` so every other control on this page
  // stops carrying a stale confirmation forward once it links elsewhere.
  const { bulkMsg: bulkMsgRaw, ...params } = rawParams
  const bulkMsg = typeof bulkMsgRaw === 'string' ? bulkMsgRaw : null
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
      {bulkMsg && (
        <Alert data-testid="bulk-message" variant={bulkMsg.includes('ditolak') ? 'destructive' : 'default'}>
          <AlertDescription>{bulkMsg}</AlertDescription>
        </Alert>
      )}

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
          {/* The export must carry the CURRENT view, so it reuses the same
              searchParams the list was built from. */}
          <a
            href={`/api/staff/csv?${new URLSearchParams(
              Object.entries(params).filter(([, v]) => typeof v === 'string') as [string, string][],
            )}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Ekspor CSV
          </a>
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

      {/* SelectionProvider and SelectionBar read the current filter via
          useSearchParams, which requires a Suspense boundary. */}
      <Suspense>
        <SelectionProvider total={staff.total}>
          <SelectionBar action={deactivateSelectedStaffAction} label="Nonaktifkan yang dipilih" />

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <SelectAll ids={staff.rows.map((s) => s.userId)} />
                </TableHead>
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
                  <TableCell colSpan={6} className="text-muted-foreground">
                    {Object.keys(query.filters).length > 0 ? (
                      <>
                        Tidak ada staf yang cocok dengan filter ini.{' '}
                        <Link href={listHref(params, clearFilters(STAFF_LIST))} className="underline">
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
                  <TableCell>
                    <SelectRow id={s.userId} />
                  </TableCell>
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
        </SelectionProvider>
      </Suspense>

      <Pagination result={staff} params={params} />
    </div>
  )
}
