import Link from 'next/link'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { CUSTOMER_LIST, listCustomers } from '@/lib/customer'
import { parseListQuery } from '@/lib/list-query'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { SortableHead } from '@/components/list/sortable-head'
import { Pagination } from '@/components/list/pagination'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // read, not update: front desk needs the list at checkout, and stylists may
  // look someone up. The create and edit screens guard more tightly.
  await requirePagePermission({ customer: ['read'] })
  const { organizationId } = await requirePageOrg()
  const params = await searchParams
  const query = parseListQuery(CUSTOMER_LIST, params)
  const customers = await listCustomers(organizationId, query)
  const q = query.q

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium">Pelanggan</h1>
        <Link href="/dashboard/customers/new" className={buttonVariants()}>
          Tambah pelanggan
        </Link>
      </div>

      {/* A plain GET form: zero client JS, and the query survives a reload. */}
      <form className="max-w-sm">
        {query.filters.active !== undefined && (
          <input type="hidden" name="active" value={query.filters.active} />
        )}
        <Input name="q" defaultValue={q ?? ''} placeholder="Cari nama atau nomor" />
      </form>

      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead column="name" label="Nama" spec={CUSTOMER_LIST} query={query} params={params} />
            <TableHead>Nomor</TableHead>
            <TableHead>Status</TableHead>
            <SortableHead column="created" label="Dibuat" spec={CUSTOMER_LIST} query={query} params={params} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                {query.q || Object.keys(query.filters).length > 0 ? (
                  <>
                    Tidak ada pelanggan yang cocok dengan pencarian ini.{' '}
                    <Link href="/dashboard/customers" className="underline">Hapus filter</Link>
                  </>
                ) : (
                  'Belum ada pelanggan.'
                )}
              </TableCell>
            </TableRow>
          )}
          {customers.rows.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <Link href={`/dashboard/customers/${c.id}`} className="underline">{c.name}</Link>
              </TableCell>
              <TableCell>{c.phone ?? '—'}</TableCell>
              <TableCell>
                <Badge variant={c.active ? 'secondary' : 'outline'}>
                  {c.active ? 'Aktif' : 'Nonaktif'}
                </Badge>
              </TableCell>
              <TableCell>{c.createdAt}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Pagination result={customers} params={params} />
    </div>
  )
}
