import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { salonSettings } from '../lib/service'

/**
 * The theme column: defaulted so existing salons keep today's look, and
 * checked so a typo in a form can never become a preset nobody defined.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const ORG = 'theme_org'

beforeAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Salon Tema', 'salon-tema', now())`, [ORG])
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG])
  await pool.end()
})

describe('salon_profiles.theme', () => {
  it('defaults a new salon to ivory', async () => {
    const { rows } = await pool.query(
      `select theme from salon_profiles where organization_id = $1`, [ORG])
    expect(rows[0].theme).toBe('ivory')
    expect((await salonSettings(ORG)).theme).toBe('ivory')
  })

  it('accepts each of the five presets', async () => {
    for (const key of ['charcoal', 'rose-gold', 'sage', 'sapphire', 'ivory']) {
      await pool.query(
        `update salon_profiles set theme = $2 where organization_id = $1`, [ORG, key])
      expect((await salonSettings(ORG)).theme).toBe(key)
    }
  })

  it('rejects anything else by constraint', async () => {
    await expect(pool.query(
      `update salon_profiles set theme = 'pink' where organization_id = $1`, [ORG]))
      .rejects.toThrow(/salon_profiles_theme/)
  })
})
