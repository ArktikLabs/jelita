import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { listProducts, lowStock, recordMovement, sellableProducts } from '../lib/inventory'
import { checkout, voidSale } from '../lib/pos'

/**
 * The stock ledger, against real Postgres.
 *
 * On-hand is read through the `stock_on_hand` view in every assertion, never
 * re-summed here: the whole point of the view is that the products list, the
 * POS and these tests agree on one number, and a test that sums it its own way
 * proves only that its copy works.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'inv_org'
const ORG2 = 'inv_org2'
const TEAM = 'inv_team'
const TEAM_B = 'inv_team_b'
const TEAM_OTHER = 'inv_team_other'
const STAFF = 'inv_staff'
const SHAMPOO = 'inv_shampoo'
const TOWEL = 'inv_towel'
const FOREIGN_PRODUCT = 'inv_foreign'
const SERVICE = 'inv_service'

const onHand = async (productId = SHAMPOO, teamId = TEAM) =>
  (await listProducts(ORG, teamId)).find((p) => p.id === productId)!.onHand

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Inv', 'inv-one', now()), ($2, 'Inv Two', 'inv-two', now())`, [ORG, ORG2])
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ($1, 'Cabang A', $2, now()), ($3, 'Cabang B', $2, now()),
           ($4, 'Cabang Lain', $5, now())`,
    [TEAM, ORG, TEAM_B, TEAM_OTHER, ORG2])
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ($1, 'Inv Staff', 'inv@inv.local', true, now(), now())`, [STAFF])
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('inv_m', $1, $2, 'stylist', now())`, [STAFF, ORG])
  await pool.query(`update staff_profiles set team_id = $1
                     where user_id = $2 and organization_id = $3`, [TEAM, STAFF, ORG])
  await pool.query(`
    insert into services (id, organization_id, name, duration_minutes, price)
    values ($1, $2, 'Potong', 60, 150000)`, [SERVICE, ORG])
  await pool.query(`
    insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)`,
    [SERVICE, STAFF, ORG])
})

afterAll(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where id = $1`, [STAFF])
  await pool.end()
})

beforeEach(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from shifts where organization_id = $1`, [ORG])
  await pool.query(`delete from stock_movements where organization_id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from products where organization_id = any($1)`, [[ORG, ORG2]])
  await pool.query(`
    insert into products (id, organization_id, name, kind, price, reorder_level)
    values ($1, $2, 'Sampo', 'retail', 60000, 2),
           ($3, $2, 'Handuk', 'internal', null, 5),
           ($4, $5, 'Sampo Lain', 'retail', 50000, 0)`,
    [SHAMPOO, ORG, TOWEL, FOREIGN_PRODUCT, ORG2])
})

describe('the ledger', () => {
  it('sums to on-hand, per branch -- one branch\'s stock is not another\'s', async () => {
    await recordMovement({
      organizationId: ORG, teamId: TEAM, productId: SHAMPOO, quantity: 10, reason: 'purchase',
    })
    await recordMovement({
      organizationId: ORG, teamId: TEAM_B, productId: SHAMPOO, quantity: 3, reason: 'purchase',
    })
    await recordMovement({
      organizationId: ORG, teamId: TEAM, productId: SHAMPOO, quantity: -4, reason: 'usage',
    })
    expect(await onHand(SHAMPOO, TEAM)).toBe(6)
    expect(await onHand(SHAMPOO, TEAM_B)).toBe(3)
  })

  it('is append-only: a movement cannot be edited or deleted', async () => {
    await recordMovement({
      organizationId: ORG, teamId: TEAM, productId: SHAMPOO, quantity: 5, reason: 'purchase',
    })
    await expect(pool.query(`update stock_movements set quantity = 99`))
      .rejects.toThrow(/append-only/)
    await expect(pool.query(`delete from stock_movements`)).rejects.toThrow(/append-only/)
  })

  it('refuses a zero movement', async () => {
    await expect(recordMovement({
      organizationId: ORG, teamId: TEAM, productId: SHAMPOO, quantity: 0, reason: 'adjustment',
    })).rejects.toThrow('BAD_QUANTITY')
    await expect(pool.query(
      `insert into stock_movements (id, organization_id, team_id, product_id, quantity, reason)
       values ($1, $2, $3, $4, 0, 'adjustment')`,
      [crypto.randomUUID(), ORG, TEAM, SHAMPOO]))
      .rejects.toThrow(/stock_movements_quantity/)
  })

  it('refuses another salon\'s product or branch', async () => {
    // NOT_FOUND, not the constraint name: recordMovement translates the
    // foreign key at its boundary, because drizzle wraps driver errors and a
    // caller matching on `.message` sees only "Failed query: ...".
    await expect(recordMovement({
      organizationId: ORG, teamId: TEAM, productId: FOREIGN_PRODUCT, quantity: 1, reason: 'purchase',
    })).rejects.toThrow('NOT_FOUND')
    await expect(recordMovement({
      organizationId: ORG, teamId: TEAM_OTHER, productId: SHAMPOO, quantity: 1, reason: 'purchase',
    })).rejects.toThrow('NOT_FOUND')
  })
})

describe('selling', () => {
  const sell = (quantity = 1, discount = 0) => checkout({
    organizationId: ORG, teamId: TEAM, userId: STAFF, method: 'cash',
    items: [{ productId: SHAMPOO, quantity, discount }],
  })

  beforeEach(async () => {
    await recordMovement({
      organizationId: ORG, teamId: TEAM, productId: SHAMPOO, quantity: 10, reason: 'purchase',
    })
  })

  it('deducts, and the movement names the sale that caused it', async () => {
    const { id } = await sell(2)
    expect(await onHand()).toBe(8)
    const { rows } = await pool.query(
      `select quantity, reason, transaction_id from stock_movements
        where reason = 'sale' and organization_id = $1`, [ORG])
    expect(rows[0]).toMatchObject({ quantity: -2, reason: 'sale', transaction_id: id })
  })

  it('puts it back when the sale is voided', async () => {
    const { id } = await sell(3)
    expect(await onHand()).toBe(7)
    await voidSale(id, ORG, STAFF)
    expect(await onHand(), 'exactly what the sale took').toBe(10)
  })

  it('deducts a line discounted to zero -- the goods still left the shelf', async () => {
    // The reason the direction is read from `reverses_id` and not from the
    // line's net amount: a fully discounted line nets zero, and a sign of zero
    // is a movement of zero, which the constraint refuses.
    await sell(1, 60000)
    expect(await onHand()).toBe(9)
  })

  it('allows selling below zero, and says so', async () => {
    // Blocking the till because the ledger says zero punishes the customer for
    // a bookkeeping gap, and the workaround is to sell it without telling the
    // system at all (spec 2.3).
    await sell(15)
    expect(await onHand()).toBe(-5)
    expect((await lowStock(ORG, TEAM)).map((p) => p.id)).toContain(SHAMPOO)
  })

  it('refuses to sell an internal-use product at all', async () => {
    await expect(checkout({
      organizationId: ORG, teamId: TEAM, userId: STAFF, method: 'cash',
      items: [{ productId: TOWEL, quantity: 1, discount: 0 }],
    })).rejects.toThrow('NOT_OFFERED')
    expect(await sellableProducts(ORG, TEAM)).toHaveLength(1)
  })

  it('refuses to sell a withdrawn product', async () => {
    await pool.query(`update products set active = false where id = $1`, [SHAMPOO])
    await expect(sell()).rejects.toThrow('NOT_OFFERED')
  })

  it('sells a product and a service in one transaction', async () => {
    const { id } = await checkout({
      organizationId: ORG, teamId: TEAM, userId: STAFF, method: 'cash',
      items: [
        { serviceId: SERVICE, quantity: 1, discount: 0, staffUserId: STAFF },
        { productId: SHAMPOO, quantity: 1, discount: 0 },
      ],
    })
    const { rows } = await pool.query(
      `select kind, name from transaction_lines where transaction_id = $1 order by kind`, [id])
    expect(rows.map((r) => r.kind)).toEqual(['product', 'service'])
    const total = await pool.query(`select total from transactions where id = $1`, [id])
    expect(total.rows[0].total).toBe('210000')
    expect(await onHand()).toBe(9)
  })

  it('earns no commission, even when a product line names a performer', async () => {
    // The reason the cart needs no "products carry no staff" guard: it could
    // not be falsified there. This is the guarantee underneath -- commission_rule
    // is keyed by service, so a product line joins to nothing.
    await pool.query(`update salon_profiles set commission_kind = 'percent',
                       commission_value = 1000 where organization_id = $1`, [ORG])
    const { id } = await checkout({
      organizationId: ORG, teamId: TEAM, userId: STAFF, method: 'cash',
      items: [{ productId: SHAMPOO, quantity: 1, discount: 0, staffUserId: STAFF }],
    })
    const { rows } = await pool.query(
      `select count(*)::int n from commissions where transaction_id = $1`, [id])
    expect(rows[0].n, 'retail commission is not in this slice (spec, out of scope)').toBe(0)
    // ...and the line really did name them, so the absence is the join's doing.
    const line = await pool.query(
      `select staff_user_id from transaction_lines where transaction_id = $1`, [id])
    expect(line.rows[0].staff_user_id).toBe(STAFF)
    await pool.query(`update salon_profiles set commission_kind = null,
                       commission_value = null where organization_id = $1`, [ORG])
  })

  it('does not deduct anything for a services-only sale', async () => {
    await checkout({
      organizationId: ORG, teamId: TEAM, userId: STAFF, method: 'cash',
      items: [{ serviceId: SERVICE, quantity: 1, discount: 0, staffUserId: STAFF }],
    })
    const { rows } = await pool.query(
      `select count(*)::int n from stock_movements where reason = 'sale'`)
    expect(rows[0].n).toBe(0)
  })
})

describe('what the database refuses outright', () => {
  it('refuses a retail product with no price, and an internal one with a price', async () => {
    await expect(pool.query(
      `insert into products (id, organization_id, name, kind) values ($1, $2, 'X', 'retail')`,
      [crypto.randomUUID(), ORG])).rejects.toThrow(/products_price_for_kind/)
    await expect(pool.query(
      `insert into products (id, organization_id, name, kind, price)
       values ($1, $2, 'Y', 'internal', 100)`,
      [crypto.randomUUID(), ORG])).rejects.toThrow(/products_price_for_kind/)
  })

  it('refuses a line naming both a service and a product, or neither', async () => {
    const txn = 'inv_open_txn'
    await pool.query(
      `insert into transactions (id, organization_id, team_id, status, subtotal,
                                 discount, total, currency)
       values ($1, $2, $3, 'open', 0, 0, 0, 'IDR')
       on conflict (id) do nothing`, [txn, ORG, TEAM])
    const line = (kind: string, service: string | null, product: string | null) => pool.query(
      `insert into transaction_lines (id, transaction_id, organization_id, kind,
                                      service_id, product_id, name, unit_price, quantity)
       values ($1, $2, $3, $4, $5, $6, 'X', 1, 1)`,
      [crypto.randomUUID(), txn, ORG, kind, service, product])
    await expect(line('service', SERVICE, SHAMPOO)).rejects.toThrow(/transaction_lines_subject/)
    await expect(line('service', null, null)).rejects.toThrow(/transaction_lines_subject/)
    await expect(line('product', SERVICE, null)).rejects.toThrow(/transaction_lines_subject/)
    await pool.query(`delete from transaction_lines where transaction_id = $1`, [txn])
    await pool.query(`delete from transactions where id = $1`, [txn])
  })

  it('flags low stock at OR below the reorder level', async () => {
    await recordMovement({
      organizationId: ORG, teamId: TEAM, productId: SHAMPOO, quantity: 3, reason: 'purchase',
    })
    expect((await lowStock(ORG, TEAM)).map((p) => p.id)).not.toContain(SHAMPOO)
    await recordMovement({
      organizationId: ORG, teamId: TEAM, productId: SHAMPOO, quantity: -1, reason: 'usage',
    })
    // reorder_level is 2, on-hand is now 2 -- AT the level counts as low.
    expect((await lowStock(ORG, TEAM)).map((p) => p.id)).toContain(SHAMPOO)
  })
})
