import Link from 'next/link'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { listBranches } from '@/lib/branch'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

export default async function BranchesPage() {
  await requirePagePermission({ branch: ['update'] })
  const { organizationId } = await requirePageOrg()
  const branches = await listBranches(organizationId)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium">Cabang</h1>
        <Link href="/branches/new" className={buttonVariants()}>
          Tambah cabang
        </Link>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nama</TableHead>
            <TableHead>Alamat</TableHead>
            <TableHead>Telepon</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Staf</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {branches.map((b) => {
            const status = !b.active
              ? { label: 'Nonaktif', variant: 'secondary' as const }
              : b.withinCap
                ? { label: 'Aktif', variant: 'default' as const }
                : { label: 'Terkunci — upgrade', variant: 'destructive' as const }
            return (
              <TableRow key={b.teamId}>
                <TableCell>
                  <Link href={`/branches/${b.teamId}`} className="font-medium underline">
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
    </div>
  )
}
