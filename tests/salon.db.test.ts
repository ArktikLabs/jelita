import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { bookableBranches, resolveBranch, resolveSalon } from '../lib/salon'

/**
 * Resolving a salon and a branch from the outside world.
 *
 * These are the tenant boundary for the public booking page: everything a
 * stranger sends is a slug or an id, and nothing else stands between those and
 * available_slots.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'sal_org'
const ORG2 = 'sal_org2'
const SLUG = 'sal-one'
const SLUG2 = 'sal-two'

/** Three branches, created in this order -- branch_entitlement ranks by
 *  created_at, so seq 1..3 is stable and a cap of 1 leaves only the first. */
const TEAMS = ['sal_team1', 'sal_team2', 'sal_team3']
const OTHER_TEAM = 'sal_other_team'

const setPlan = (organizationId: string, key: string) => pool.query(`
  update subscriptions set plan_id = (select id from plans where key = $2)
   where organization_id = $1`, [organizationId, key])

const names = async (organizationId = ORG) =>
  (await bookableBranches(organizationId)).map((b) => b.name)

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Salon Satu', $2, now()), ($3, 'Salon Dua', $4, now())`,
    [ORG, SLUG, ORG2, SLUG2])
  for (const [i, id] of TEAMS.entries()) {
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
      [id, `Cabang ${i + 1}`, ORG, i])
  }
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ($1, 'Cabang Lain', $2, now())`, [OTHER_TEAM, ORG2])
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.end()
})

beforeEach(async () => {
  // Business: no branch cap at all, so within-cap never interferes unless a
  // test sets a smaller plan on purpose.
  await setPlan(ORG, 'business')
  await setPlan(ORG2, 'business')
  await pool.query(`update branch_profiles set active = true
                     where team_id = any($1)`, [[...TEAMS, OTHER_TEAM]])
})

describe('resolveSalon', () => {
  it('resolves a slug to exactly one salon, with its booking settings', async () => {
    const salon = await resolveSalon(SLUG)
    expect(salon).toMatchObject({
      organizationId: ORG, name: 'Salon Satu', currency: 'IDR', slotMinutes: 30,
    })
  })

  it('never resolves one salon to another', async () => {
    expect((await resolveSalon(SLUG2))?.organizationId).toBe(ORG2)
  })

  it('resolves nothing for an unknown or empty slug', async () => {
    expect(await resolveSalon('tidak-ada')).toBeNull()
    expect(await resolveSalon('')).toBeNull()
  })
})

describe('bookableBranches', () => {
  it('offers every active branch when the plan caps none', async () => {
    expect(await names()).toEqual(['Cabang 1', 'Cabang 2', 'Cabang 3'])
  })

  it('drops a branch the salon closed', async () => {
    await pool.query(`update branch_profiles set active = false where team_id = $1`, [TEAMS[1]])
    expect(await names()).toEqual(['Cabang 1', 'Cabang 3'])
  })

  it('drops the branches a DOWNGRADE put over the cap', async () => {
    // Driven by changing the plan, not by editing within_cap: the point is
    // that a salon dropping from Pro to Free keeps three branches it can no
    // longer operate, and customers must stop being sent to them.
    await setPlan(ORG, 'pro')       // cap 3
    expect(await names()).toHaveLength(3)
    await setPlan(ORG, 'free')      // cap 1
    expect(await names(), 'over-cap branches are read-only, not bookable')
      .toEqual(['Cabang 1'])
  })

  it('offers nothing when every branch is closed', async () => {
    await pool.query(`update branch_profiles set active = false
                       where team_id = any($1)`, [TEAMS])
    expect(await names()).toEqual([])
  })

  it('a closed branch is out of the cap ranking entirely -- the coupling bookableBranches leans on', async () => {
    // Asserted here because it cannot be asserted through bookableBranches:
    // its `active` filter is redundant while this holds, so breaking that
    // filter fails nothing. This is the guarantee that makes it redundant, and
    // this assertion DOES fail if branch_entitlement stops excluding inactive
    // branches -- at which point the filter stops being redundant.
    await pool.query(`update branch_profiles set active = false where team_id = $1`, [TEAMS[1]])
    const { rows } = await pool.query(
      `select within_cap from branch_entitlement where team_id = $1`, [TEAMS[1]])
    expect(rows, 'a closed branch has no entitlement row at all').toHaveLength(0)
  })

  it('never leaks the salon-only columns', async () => {
    const [branch] = await bookableBranches(ORG)
    expect(Object.keys(branch).sort()).toEqual(['address', 'name', 'teamId'])
  })
})

describe('resolveBranch', () => {
  it('picks the only branch when there is exactly one -- no step to show', async () => {
    await setPlan(ORG, 'free')
    expect((await resolveBranch(ORG))?.teamId).toBe(TEAMS[0])
  })

  it('refuses to guess when there is a choice', async () => {
    expect(await resolveBranch(ORG)).toBeNull()
    expect((await resolveBranch(ORG, TEAMS[2]))?.name).toBe('Cabang 3')
  })

  it('refuses another salon\'s branch -- the tenant boundary', async () => {
    expect(await resolveBranch(ORG, OTHER_TEAM)).toBeNull()
    expect(await resolveBranch(ORG2, TEAMS[0])).toBeNull()
  })

  it('refuses a closed branch, and one the plan put over the cap', async () => {
    await pool.query(`update branch_profiles set active = false where team_id = $1`, [TEAMS[1]])
    expect(await resolveBranch(ORG, TEAMS[1])).toBeNull()
    await setPlan(ORG, 'free')
    expect(await resolveBranch(ORG, TEAMS[2])).toBeNull()
  })
})
