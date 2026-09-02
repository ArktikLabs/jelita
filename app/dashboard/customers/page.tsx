import Link from 'next/link'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { listCustomers } from '@/lib/customer'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  // read, not update: front desk needs the list at checkout, and stylists may
  // look someone up. The create and edit screens guard more tightly.
  await requirePagePermission({ customer: ['read'] })
  const { organizationId } = await requirePageOrg()
  const { q } = await searchParams
  const customers = await listCustomers(organizationId, { search: q })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium">Pelanggan</h1>
        <Link href="/customers/new" className={buttonVariants()}>
          Tambah pelanggan
        </Link>
      </div>

      {/* A plain GET form: zero client JS, and the query survives a reload. */}
      <form className="max-w-sm">
        <Input name="q" defaultValue={q ?? ''} placeholder="Cari nama atau nomor" />
      </form>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nama</TableHead>
            <TableHead>Nomor</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-muted-foreground">
                {q ? 'Tidak ada pelanggan yang cocok.' : 'Belum ada pelanggan.'}
              </TableCell>
            </TableRow>
          )}
          {customers.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <Link href={`/customers/${c.id}`} className="underline">{c.name}</Link>
              </TableCell>
              <TableCell>{c.phone ?? '—'}</TableCell>
              <TableCell>
                <Badge variant={c.active ? 'secondary' : 'outline'}>
                  {c.active ? 'Aktif' : 'Nonaktif'}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
