import { notFound } from 'next/navigation'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { staffSchedule, upcomingExceptions, upcomingTimeOff } from '@/lib/schedule'
import { getStaff } from '@/lib/staff'
import { listBranches } from '@/lib/branch'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { RoleForm, TransferForm, StatusForm, PasswordForm } from './staff-detail-forms'
import {
  ScheduleExceptionsForm, StaffScheduleForm, TimeOffForm,
} from './schedule-forms'
import { BaseSalaryForm } from '../../payroll/base-salary-form'
import { toAmountInput } from '@/lib/money'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { salonSettings } from '@/lib/service'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'

// Mirrors actions.ts's NEEDS_BRANCH -- duplicated, not imported, since that
// file is 'use server' and only its async actions can cross into this page.
// It no longer decides whether a branch may be set (every role may), only
// whether one is REQUIRED -- which is what the release control keys off.
const NEEDS_BRANCH = ['stylist', 'frontdesk']

export default async function StaffDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const actor = await requirePagePermission({ staff: ['read'] })
  const { organizationId } = await requirePageOrg()
  const { id } = await params

  // getStaff is scoped by organizationId in the query itself, so null here
  // covers both "no such staff" and "not yours" -- notFound() is correct for both.
  const staff = await getStaff(id, organizationId)
  if (!staff) notFound()

  const branches = await listBranches(organizationId)
  // Narrowed to what the forms need, same as /staff/new -- a full BranchRow
  // would serialize into the RSC payload for fields these forms never show.
  const branchOptions = branches.map((b) => ({ teamId: b.teamId, name: b.name }))
  // Every role may now be placed at a branch. Owner and admin were refused
  // here, which made a working owner unbookable -- available_slots requires
  // staff_profiles.team_id, and in a small salon the owner cutting hair is the
  // normal case, not the exception. For them the branch is optional (an empty
  // value opts back out); for stylist and front desk it is still required.
  const needsBranch = staff.role.split(',').some((r) => NEEDS_BRANCH.includes(r))
  // The schedule only means something once a branch is set: staff_working_hours
  // clamps to branch_hours and returns nothing without one, so the card would
  // otherwise edit a pattern that can never produce a bookable hour.
  const [schedule, exceptions, timeOff] = staff.teamId
    ? await Promise.all([
        staffSchedule(staff.userId, organizationId),
        upcomingExceptions(staff.userId, organizationId),
        upcomingTimeOff(staff.userId, organizationId),
      ])
    : [[], [], []]
  // Both self-only cards are hidden for the same reason the transfer card is:
  // an operation that can only ever fail, or can only hurt you, should not be
  // offered. The server refuses the deactivation regardless.
  const isSelf = staff.userId === actor.user.id

  // Base salary is a PAYROLL fact, guarded by payroll:['read'] rather than
  // staff:['update']: a role that may move a stylist between branches need
  // not be able to change what they are paid.
  const { success: canSeePay } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { payroll: ['read'] } },
  })
  const { currency } = await salonSettings(organizationId)
  const { rows: payRows } = await db.execute(sql`
    select base_salary from staff_profiles
     where user_id = ${staff.userId} and organization_id = ${organizationId}`)
  const baseSalary = (payRows[0] as { base_salary: string | null }).base_salary

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{staff.name}</CardTitle>
          <CardDescription>{staff.email}</CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Peran</CardTitle>
          <CardDescription>Ubah peran staf ini di salon.</CardDescription>
        </CardHeader>
        <CardContent>
          <RoleForm staff={staff} branches={branchOptions} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cabang</CardTitle>
          <CardDescription>
            {needsBranch
              ? 'Pindahkan staf ini ke cabang lain.'
              : 'Tempatkan di cabang agar bisa dipesan pelanggan. Opsional.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TransferForm staff={staff} branches={branchOptions} needsBranch={needsBranch} />
        </CardContent>
      </Card>

      {canSeePay && (
        <Card>
          <CardHeader>
            <CardTitle>Gaji pokok</CardTitle>
            <CardDescription>
              Dipakai di rekap penggajian bersama komisi dan potongan.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BaseSalaryForm
              userId={staff.userId}
              baseSalary={baseSalary === null ? '' : toAmountInput(Number(baseSalary), currency)}
            />
          </CardContent>
        </Card>
      )}

      {!isSelf && (
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
            <CardDescription>
              {staff.active
                ? 'Menonaktifkan staf mengakhiri sesinya dan membebaskan satu kursi paket.'
                : 'Mengaktifkan kembali staf ini memakai satu kursi paket.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StatusForm staff={staff} />
          </CardContent>
        </Card>
      )}

      {/* Hidden for self for a second reason: resetStaffPasswordAction revokes
          every session of its target, so an owner resetting their own password
          here would sign themselves out mid-click. /profile's
          changePasswordAction is the self path -- it passes
          revokeOtherSessions, keeping the caller's own session alive. */}
      {!isSelf && (
        <Card>
          <CardHeader>
            <CardTitle>Kata sandi</CardTitle>
            <CardDescription>Atur ulang kata sandi staf ini di tempat.</CardDescription>
          </CardHeader>
          <CardContent>
            <PasswordForm staff={staff} />
          </CardContent>
        </Card>
      )}

      {/* Without a branch there are no branch hours to clamp to, so
          staff_working_hours returns nothing and these cards would edit a
          pattern that can never produce a bookable hour. */}
      {staff.teamId && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Jadwal mingguan</CardTitle>
              <CardDescription>
                Jam kerja normal. Dipotong jam buka cabang.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StaffScheduleForm userId={staff.userId} days={schedule} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pengecualian tanggal</CardTitle>
              <CardDescription>
                Menggantikan jadwal mingguan untuk satu tanggal — libur, atau jam berbeda.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScheduleExceptionsForm userId={staff.userId} exceptions={exceptions} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Waktu tidak tersedia</CardTitle>
              <CardDescription>
                Memotong sebagian hari, misalnya keperluan di siang hari.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TimeOffForm userId={staff.userId} blocks={timeOff} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
