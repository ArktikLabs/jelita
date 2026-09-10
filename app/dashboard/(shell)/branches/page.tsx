import Link from 'next/link'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { BRANCH_LIST, listBranches } from '@/lib/branch'
import { parseListQuery } from '@/lib/list-query'
import { clearFilters, listHref, preservedFields, type Params } from '@/lib/list-url'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { SortableHead } from '@/components/list/sortable-head'
import { FilterBar } from '@/components/list/filter-bar'
import { Pagination } from '@/components/list/pagination'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

export default async function BranchesPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  await requirePagePermission({ branch: ['update'] })
  const { organizationId } = await requirePageOrg()
  const params = await searchParams
  const query = parseListQuery(BRANCH_LIST, params)
  const branches = await listBranches(organizationId, query)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium">Cabang</h1>
        <div className="flex items-center gap-2">
          {/* The export must carry the CURRENT view, so it reuses the same
              searchParams the list was built from. */}
          <a
            href={`/api/branches/csv?${new URLSearchParams(
              Object.entries(params).filter(([, v]) => typeof v === 'string') as [string, string][],
            )}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Ekspor CSV
          </a>
          <Link href="/dashboard/branches/new" className={buttonVariants()}>
            Tambah cabang
          </Link>
        </div>
      </div>

      <form className="max-w-sm">
        {preservedFields(params, ['q']).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Input name="q" defaultValue={query.q ?? ''} placeholder="Cari nama cabang" />
      </form>

      <FilterBar spec={BRANCH_LIST} query={query} params={params} />

      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead column="name" label="Nama" spec={BRANCH_LIST} query={query} params={params} />
            <TableHead>Alamat</TableHead>
            <TableHead>Telepon</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Staf</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {branches.rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                {query.q || Object.keys(query.filters).length > 0 ? (
                  <>
                    Tidak ada cabang yang cocok dengan pencarian ini.{' '}
                    <Link href={listHref(params, clearFilters(BRANCH_LIST))} className="underline">
                      Hapus filter
                    </Link>
                  </>
                ) : (
                  'Belum ada cabang.'
                )}
              </TableCell>
            </TableRow>
          )}
          {branches.rows.map((b) => {
            const status = !b.active
              ? { label: 'Nonaktif', variant: 'secondary' as const }
              : b.withinCap
                ? { label: 'Aktif', variant: 'default' as const }
                : { label: 'Terkunci — upgrade', variant: 'destructive' as const }
            return (
              <TableRow key={b.teamId}>
                <TableCell>
                  <Link href={`/dashboard/branches/${b.teamId}`} className="font-medium underline">
                    {b.name}
                  </Link>
                </TableCell>
                <TableCell>{b.address ?? '—'}</TableCell>
                <TableCell>{b.phone ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </TableCell>
                <TableCell>{b.staffCount}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      <Pagination result={branches} params={params} />
    </div>
  )
}
