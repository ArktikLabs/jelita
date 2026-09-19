# Dashboard Shell and Per-Salon Theming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat top-bar navigation with a grouped sidebar (drawer on narrow screens) and let each salon's owner pick one of five theme presets plus an accent colour that every member of that salon sees.

**Architecture:** Navigation stays a permission-filtered list in `lib/nav.ts`, now with a group and icon per item, rendered by the shadcn `sidebar` component. A theme is a preset key stored on `salon_profiles.theme` plus the existing `brand_color` as accent; `lib/theme.ts` turns those into CSS variables, an inline script in the shell layout applies them to `<html>` before first paint, and a client effect keeps them in sync and removes them on unmount.

**Tech Stack:** Next.js 16.3 App Router, React 19, Tailwind v4, shadcn (base-nova style, `@base-ui/react`), lucide-react, drizzle-kit migrations, Vitest, Playwright, Postgres 17 test container.

**Spec:** `docs/superpowers/specs/2026-09-19-dashboard-shell-and-theming-design.md`

## Global Constraints

- All user-facing copy is Indonesian, matching the existing app (`Pengaturan`, `Keluar`, `Simpan tampilan`).
- Preset keys are exactly `ivory`, `charcoal`, `rose-gold`, `sage`, `sapphire`; display labels `Ivory`, `Charcoal`, `Rose Gold`, `Sage`, `Sapphire`. Default `ivory`.
- Accent is `salon_profiles.brand_color`, validated as `^#[0-9a-fA-F]{6}$` both in the action and by the existing DB check constraint.
- Props to client components must not carry more than they render: nav items cross to the client as `{ href, label, icon }` only; the branch list is only sent to roles holding `branch:switch` (existing rule in the layout).
- Sidebar and shell header carry `print:hidden` so receipts print clean.
- Every preset's default accent must clear a 4.5:1 contrast ratio against its surface, and the accent foreground is whichever of black or white contrasts more with the accent.
- Read `node_modules/next/dist/docs/` before writing Next-specific code; this Next version differs from training data.
- Tests: pure logic in `tests/*.test.ts` (Vitest), DB behaviour in `tests/*.db.test.ts` (Vitest + pg, needs `pnpm test:db` running), flows in `tests/e2e/*.spec.ts` (Playwright).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `lib/theme.ts` (create) | Preset constants, contrast maths, `themeVars`, `themeScript` |
| `tests/theme.test.ts` (create) | Pure tests for the above |
| `lib/schema/service.ts` (modify) | `theme` column on `salonProfiles` |
| `db/migrations/0036_salon_theme.sql` + meta (create) | Column, default, check constraint |
| `lib/service.ts` (modify) | `salonSettings()` returns `theme` |
| `tests/theme.db.test.ts` (create) | Constraint and default |
| `lib/nav.ts` (modify) | `group`, `icon`, Kasir, `groupedNav()` |
| `tests/nav.test.ts` (create) | Grouping and role visibility |
| `components/ui/sidebar.tsx`, `sheet.tsx`, `tooltip.tsx`, `separator.tsx`, `skeleton.tsx`, `dropdown-menu.tsx`, `hooks/use-mobile.ts` (generated) | shadcn primitives |
| `app/dashboard/(shell)/app-sidebar.tsx` (create) | Client sidebar: logo, grouped nav, footer with switcher and user menu |
| `app/dashboard/(shell)/shell-header.tsx` (create) | Client header: trigger and current page label |
| `app/dashboard/(shell)/theme-applier.tsx` (create) | Client effect that syncs and cleans up theme on `<html>` |
| `app/dashboard/(shell)/layout.tsx` (modify) | Wires everything; emits the inline theme script |
| `app/dashboard/(shell)/main-nav.tsx` (delete) | Replaced by `app-sidebar.tsx` |
| `app/globals.css` (modify) | Dark variant also matches `[data-theme=dark]` |
| `app/dashboard/(shell)/settings/settings-forms.tsx` (modify) | Theme swatches and colour input in `BrandingCard` |
| `app/dashboard/(shell)/settings/actions.ts` (modify) | Validate and persist `theme` |
| `app/dashboard/(shell)/settings/page.tsx` (modify) | Pass `theme` to the card |
| `tests/e2e/shell.spec.ts` (create) | Owner sets theme, stylist sees it; mobile drawer |

---

### Task 1: Theme constants and pure functions

**Files:**
- Create: `lib/theme.ts`
- Test: `tests/theme.test.ts`

**Interfaces:**
- Produces:
  - `type ThemeKey = 'ivory' | 'charcoal' | 'rose-gold' | 'sage' | 'sapphire'`
  - `type ThemeMode = 'light' | 'dark'`
  - `type ThemePreset = { key: ThemeKey; label: string; mode: ThemeMode; accent: string }`
  - `const THEMES: readonly ThemePreset[]`, `const DEFAULT_THEME: ThemeKey = 'ivory'`
  - `isThemeKey(v: unknown): v is ThemeKey`
  - `themeOf(key: string | null | undefined): ThemePreset` (falls back to ivory)
  - `contrastRatio(a: string, b: string): number` (hex in, WCAG ratio out)
  - `accentForeground(hex: string): '#000000' | '#ffffff'`
  - `themeVars(preset: ThemePreset, accent: string | null): Record<string, string>` (keys are CSS custom property names including the leading `--`)
  - `themeScript(mode: ThemeMode, vars: Record<string, string>): string` (inline JS)
  - `HEX_RE = /^#[0-9a-fA-F]{6}$/`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/theme.test.ts
import { describe, expect, it } from 'vitest'
import {
  THEMES, DEFAULT_THEME, accentForeground, contrastRatio, isThemeKey,
  themeOf, themeScript, themeVars,
} from '../lib/theme'

/** The surface each mode paints behind the accent: globals.css --background. */
const SURFACE = { light: '#ffffff', dark: '#252525' } as const

describe('presets', () => {
  it('has exactly the five agreed keys, ivory first', () => {
    expect(THEMES.map((t) => t.key)).toEqual(['ivory', 'charcoal', 'rose-gold', 'sage', 'sapphire'])
    expect(DEFAULT_THEME).toBe('ivory')
  })

  it('every default accent clears 4.5:1 against its own surface', () => {
    for (const t of THEMES) {
      expect(contrastRatio(t.accent, SURFACE[t.mode]), t.key).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('every default accent clears 4.5:1 against its computed foreground', () => {
    for (const t of THEMES) {
      expect(contrastRatio(t.accent, accentForeground(t.accent)), t.key).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('isThemeKey accepts the keys and nothing else', () => {
    expect(isThemeKey('rose-gold')).toBe(true)
    expect(isThemeKey('pink')).toBe(false)
    expect(isThemeKey(null)).toBe(false)
  })

  it('themeOf falls back to ivory for unknown or missing keys', () => {
    expect(themeOf('sage').key).toBe('sage')
    expect(themeOf('nope').key).toBe('ivory')
    expect(themeOf(null).key).toBe('ivory')
  })
})

describe('accentForeground', () => {
  it('is white on a dark accent and black on a pale one', () => {
    expect(accentForeground('#1a2b3c')).toBe('#ffffff')
    expect(accentForeground('#ffe066')).toBe('#000000')
  })

  it('picks whichever of black or white contrasts MORE, not a fixed luminance cut', () => {
    // A mid-blue: luminance sits under 0.5, yet black contrasts far better.
    expect(accentForeground('#7aa2f7')).toBe('#000000')
  })
})

describe('themeVars', () => {
  const sage = themeOf('sage')

  it('uses the preset accent when the salon has none', () => {
    const vars = themeVars(sage, null)
    expect(vars['--primary']).toBe(sage.accent)
    expect(vars['--primary-foreground']).toBe(accentForeground(sage.accent))
    expect(vars['--ring']).toBe(sage.accent)
    expect(vars['--sidebar-primary']).toBe(sage.accent)
    expect(vars['--sidebar-primary-foreground']).toBe(accentForeground(sage.accent))
  })

  it('lets the salon accent override the preset', () => {
    const vars = themeVars(sage, '#1a2b3c')
    expect(vars['--primary']).toBe('#1a2b3c')
    expect(vars['--primary-foreground']).toBe('#ffffff')
  })

  it('ignores an accent that is not #rrggbb rather than emitting it', () => {
    expect(themeVars(sage, 'red')['--primary']).toBe(sage.accent)
  })
})

describe('themeScript', () => {
  it('sets data-theme and each variable, and never emits a raw < character', () => {
    const js = themeScript('dark', { '--primary': '#7aa2f7' })
    expect(js).toContain('"dark"')
    expect(js).toContain('"--primary"')
    expect(js).toContain('"#7aa2f7"')
    expect(js).not.toMatch(/<\//)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/theme.test.ts`
Expected: FAIL, cannot resolve `../lib/theme`.

- [ ] **Step 3: Implement `lib/theme.ts`**

```ts
// lib/theme.ts
/**
 * A salon's look is a PRESET plus an optional ACCENT.
 *
 * The preset decides the surface (which of the two token sets in globals.css
 * applies) and a default accent. The accent, when the salon has set
 * brand_color, overrides the preset's default -- one brand colour drives the
 * dashboard, the receipt and the booking page.
 *
 * Everything here is pure: the layout calls themeVars() on the server and the
 * settings page renders THEMES as swatches. No DOM, no React.
 */
export type ThemeKey = 'ivory' | 'charcoal' | 'rose-gold' | 'sage' | 'sapphire'
export type ThemeMode = 'light' | 'dark'
export type ThemePreset = { key: ThemeKey; label: string; mode: ThemeMode; accent: string }

export const HEX_RE = /^#[0-9a-fA-F]{6}$/

// Accents were checked against their surface (#ffffff light, #252525 dark)
// and against their computed foreground; tests/theme.test.ts keeps them
// honest. A prettier rose that fails 4.5:1 is not an option.
export const THEMES: readonly ThemePreset[] = [
  { key: 'ivory', label: 'Ivory', mode: 'light', accent: '#2a2622' },
  { key: 'charcoal', label: 'Charcoal', mode: 'dark', accent: '#f3f1ee' },
  { key: 'rose-gold', label: 'Rose Gold', mode: 'light', accent: '#a04e5b' },
  { key: 'sage', label: 'Sage', mode: 'light', accent: '#4f6b52' },
  { key: 'sapphire', label: 'Sapphire', mode: 'dark', accent: '#7aa2f7' },
]

export const DEFAULT_THEME: ThemeKey = 'ivory'

export function isThemeKey(v: unknown): v is ThemeKey {
  return typeof v === 'string' && THEMES.some((t) => t.key === v)
}

export function themeOf(key: string | null | undefined): ThemePreset {
  return THEMES.find((t) => t.key === key) ?? THEMES[0]
}

function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG 2 contrast ratio between two #rrggbb colours, always >= 1. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Black or white, whichever reads better on the accent. Chosen by contrast
 * rather than a luminance threshold: a mid-blue sits under 0.5 luminance and
 * still needs black text (white on it is 2.5:1).
 */
export function accentForeground(hex: string): '#000000' | '#ffffff' {
  return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff') ? '#000000' : '#ffffff'
}

/** The CSS custom properties the accent drives. Keys include the `--`. */
export function themeVars(preset: ThemePreset, accent: string | null): Record<string, string> {
  const colour = accent && HEX_RE.test(accent) ? accent : preset.accent
  const fg = accentForeground(colour)
  return {
    '--primary': colour,
    '--primary-foreground': fg,
    '--ring': colour,
    '--sidebar-primary': colour,
    '--sidebar-primary-foreground': fg,
  }
}

/**
 * The inline script the shell layout emits before any content, so the theme
 * is on <html> before first paint and before anything portals to <body>.
 * Values are JSON-encoded, never interpolated raw, and `<` is escaped so a
 * value can never close the script tag.
 */
export function themeScript(mode: ThemeMode, vars: Record<string, string>): string {
  const json = JSON.stringify({ mode, vars }).replace(/</g, '\\u003c')
  return `(function(t){var d=document.documentElement;d.dataset.theme=t.mode;` +
    `for(var k in t.vars)d.style.setProperty(k,t.vars[k]);})(${json})`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/theme.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/theme.ts tests/theme.test.ts
git commit -m "feat(theme): preset table, contrast maths and CSS variable builder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `theme` column, migration and settings read

**Files:**
- Modify: `lib/schema/service.ts` (the `salonProfiles` table, after `brandColor`)
- Create: `db/migrations/0036_salon_theme.sql` and its journal and snapshot entries (generated)
- Modify: `lib/service.ts:252-273` (`salonSettings`)
- Test: `tests/theme.db.test.ts`

**Interfaces:**
- Consumes: `ThemeKey`, `DEFAULT_THEME` from `lib/theme.ts`.
- Produces: `salonSettings(organizationId)` gains `theme: ThemeKey`.

- [ ] **Step 1: Write the failing DB test**

```ts
// tests/theme.db.test.ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:db` (once, if the container is not up), then `pnpm vitest run tests/theme.db.test.ts`
Expected: FAIL, `column "theme" does not exist`.

- [ ] **Step 3: Add the column to the drizzle schema**

In `lib/schema/service.ts`, directly after the `brandColor: text('brand_color'),` line inside `salonProfiles`:

```ts
  // Which of the five presets in lib/theme.ts paints the dashboard for every
  // member of this salon. Defaulted to the look the app had before presets
  // existed; constrained to the known keys in the migration.
  theme: text('theme').notNull().default('ivory'),
```

- [ ] **Step 4: Generate the migration and add the check constraint**

Run: `pnpm exec drizzle-kit generate --name salon_theme`
Expected: creates `db/migrations/0036_salon_theme.sql`, `db/migrations/meta/0036_snapshot.json`, and appends an entry to `db/migrations/meta/_journal.json`.

Open `db/migrations/0036_salon_theme.sql`. It contains the `ALTER TABLE ... ADD COLUMN "theme" text DEFAULT 'ivory' NOT NULL;` line. Append after it:

```sql
--> statement-breakpoint
-- The keys are lib/theme.ts THEMES. Adding a preset is a constant plus this
-- constraint; the pair moves together or the form starts writing keys the
-- layout cannot render.
alter table salon_profiles add constraint salon_profiles_theme
  check (theme in ('ivory', 'charcoal', 'rose-gold', 'sage', 'sapphire'));
```

- [ ] **Step 5: Return `theme` from `salonSettings`**

In `lib/service.ts`, add the import at the top:

```ts
import { DEFAULT_THEME, isThemeKey, type ThemeKey } from './theme'
```

In the `salonSettings` query, change the select list to include `theme`:

```ts
    select currency, slot_minutes, logo_key, brand_color, auto_close_shift,
           points_kind, points_value, theme,
           to_char(logo_updated_at, 'YYYYMMDDHH24MISS') as logo_version
```

And in the returned object, after `brandColor`:

```ts
    // The constraint makes a non-key impossible; the guard is for a row that
    // predates the column in a test that bypassed migrations.
    theme: (isThemeKey(r?.theme) ? r.theme : DEFAULT_THEME) as ThemeKey,
```

- [ ] **Step 6: Reset the test database and run the test**

Run: `pnpm exec tsx tests/reset-db.ts && pnpm vitest run tests/theme.db.test.ts tests/salon.db.test.ts tests/pos.db.test.ts`
Expected: PASS. The two older files are included because they touch `salon_profiles` and prove nothing else broke.

- [ ] **Step 7: Commit**

```bash
git add lib/schema/service.ts lib/service.ts db/migrations tests/theme.db.test.ts
git commit -m "feat(theme): salon_profiles.theme, defaulted to ivory and constrained to the presets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Grouped navigation with icons and Kasir

**Files:**
- Modify: `lib/nav.ts`
- Test: `tests/nav.test.ts`

**Interfaces:**
- Produces:
  - `type NavGroup = 'Operasional' | 'Keuangan' | 'Katalog' | 'Pengelolaan'`
  - `type NavIcon = 'dashboard' | 'pos' | 'calendar' | 'customers' | 'receipt' | 'percent' | 'wallet' | 'scissors' | 'package' | 'staff' | 'branch' | 'bell' | 'settings'`
  - `NavItem` gains `icon: NavIcon` and `group?: NavGroup`
  - `type ClientNavItem = { href: string; label: string; icon: NavIcon }`
  - `type NavSection = { label: NavGroup | null; items: ClientNavItem[] }`
  - `groupedNav(roleCsv: string): NavSection[]` (ungrouped items first as `label: null`; empty groups omitted; group order fixed)
  - `visibleNav(roleCsv)` unchanged in signature.

- [ ] **Step 1: Write the failing test**

```ts
// tests/nav.test.ts
import { describe, expect, it } from 'vitest'
import { NAV, groupedNav, visibleNav } from '../lib/nav'

/**
 * Which links which role sees, and how they are grouped. Pure: the role
 * table in lib/permissions.ts decides, no database.
 */
const labels = (sections: ReturnType<typeof groupedNav>) =>
  sections.map((s) => [s.label, s.items.map((i) => i.label)])

describe('groupedNav', () => {
  it('gives the owner every group in the agreed order', () => {
    expect(labels(groupedNav('owner'))).toEqual([
      [null, ['Dasbor']],
      ['Operasional', ['Kasir', 'Janji temu', 'Pelanggan']],
      ['Keuangan', ['Transaksi', 'Komisi', 'Penggajian']],
      ['Katalog', ['Layanan', 'Produk']],
      ['Pengelolaan', ['Staf', 'Cabang', 'Notifikasi', 'Pengaturan']],
    ])
  })

  it('drops a group with no visible items: a stylist sees three links in two groups', () => {
    expect(labels(groupedNav('stylist'))).toEqual([
      [null, ['Dasbor']],
      ['Operasional', ['Janji temu']],
      ['Keuangan', ['Komisi']],
    ])
  })

  it('shows Kasir to a role holding pos:checkout and hides it otherwise', () => {
    const has = (role: string) => groupedNav(role).some((s) => s.items.some((i) => i.href === '/dashboard/pos'))
    expect(has('frontdesk')).toBe(true)
    expect(has('stylist')).toBe(false)
  })

  it('hands the client only href, label and icon', () => {
    for (const s of groupedNav('owner')) {
      for (const item of s.items) expect(Object.keys(item).sort()).toEqual(['href', 'icon', 'label'])
    }
  })

  it('unions roles from a comma-separated list', () => {
    const only = (csv: string) => visibleNav(csv).map((i) => i.label)
    expect(only('stylist, frontdesk')).toEqual(
      expect.arrayContaining([...only('stylist'), ...only('frontdesk')]))
  })

  it('every item has an icon', () => {
    for (const item of NAV) expect(item.icon).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/nav.test.ts`
Expected: FAIL, `groupedNav` is not exported.

- [ ] **Step 3: Rewrite `lib/nav.ts`**

Replace the whole file with:

```ts
import { roles, type SalonRole } from './permissions'

export type NavGroup = 'Operasional' | 'Keuangan' | 'Katalog' | 'Pengelolaan'

/** Icon NAMES, resolved to lucide components on the client (app-sidebar.tsx).
 *  Strings here keep the server payload a list of strings, not components. */
export type NavIcon =
  | 'dashboard' | 'pos' | 'calendar' | 'customers' | 'receipt' | 'percent'
  | 'wallet' | 'scissors' | 'package' | 'staff' | 'branch' | 'bell' | 'settings'

export type NavItem = {
  href: string
  label: string
  icon: NavIcon
  /** Absent means the item sits above every group (Dasbor). */
  group?: NavGroup
  /** The permission the destination page's own guard requires. */
  require?: { resource: string; action: string }
}

/** What crosses to the client: nothing a stylist's browser has no use for. */
export type ClientNavItem = { href: string; label: string; icon: NavIcon }
export type NavSection = { label: NavGroup | null; items: ClientNavItem[] }

/** Render order of the groups. Daily work first, rare admin last. */
export const NAV_GROUPS: readonly NavGroup[] = ['Operasional', 'Keuangan', 'Katalog', 'Pengelolaan']

/**
 * Each entry's `require` mirrors the guard on the page it links to. Deriving
 * visibility from lib/permissions.ts rather than hardcoding a role list means
 * a permission change moves the link and the guard together -- a hardcoded
 * list drifts, and the failure is a nav item that redirects the moment you
 * click it.
 */
export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dasbor', icon: 'dashboard' },
  { href: '/dashboard/pos', label: 'Kasir', icon: 'pos', group: 'Operasional', require: { resource: 'pos', action: 'checkout' } },
  { href: '/dashboard/bookings', label: 'Janji temu', icon: 'calendar', group: 'Operasional', require: { resource: 'booking', action: 'read' } },
  { href: '/dashboard/customers', label: 'Pelanggan', icon: 'customers', group: 'Operasional', require: { resource: 'customer', action: 'read' } },
  { href: '/dashboard/transactions', label: 'Transaksi', icon: 'receipt', group: 'Keuangan', require: { resource: 'pos', action: 'checkout' } },
  { href: '/dashboard/commissions', label: 'Komisi', icon: 'percent', group: 'Keuangan', require: { resource: 'commission', action: 'read:own' } },
  { href: '/dashboard/payroll', label: 'Penggajian', icon: 'wallet', group: 'Keuangan', require: { resource: 'payroll', action: 'read' } },
  { href: '/dashboard/services', label: 'Layanan', icon: 'scissors', group: 'Katalog', require: { resource: 'service', action: 'update' } },
  { href: '/dashboard/products', label: 'Produk', icon: 'package', group: 'Katalog', require: { resource: 'product', action: 'read' } },
  { href: '/dashboard/staff', label: 'Staf', icon: 'staff', group: 'Pengelolaan', require: { resource: 'staff', action: 'read' } },
  { href: '/dashboard/branches', label: 'Cabang', icon: 'branch', group: 'Pengelolaan', require: { resource: 'branch', action: 'update' } },
  { href: '/dashboard/notifications', label: 'Notifikasi', icon: 'bell', group: 'Pengelolaan', require: { resource: 'notification', action: 'read' } },
  { href: '/dashboard/settings', label: 'Pengaturan', icon: 'settings', group: 'Pengelolaan', require: { resource: 'settings', action: 'update' } },
]

/**
 * `members.role` is a comma-separated list -- better-auth splits it on ',' in
 * hasPermissionFn -- so a member may hold several roles and the union of their
 * statements applies.
 */
export function visibleNav(roleCsv: string): NavItem[] {
  const held = roleCsv.split(',').map((r) => r.trim()).filter(Boolean)
  const granted = new Set<string>()
  for (const name of held) {
    const role = roles[name as SalonRole]
    if (!role) continue // a custom role this build does not know about
    for (const [resource, actions] of Object.entries(role.statements ?? {})) {
      for (const action of actions as readonly string[]) granted.add(`${resource}:${action}`)
    }
  }
  return NAV.filter((item) =>
    !item.require || granted.has(`${item.require.resource}:${item.require.action}`))
}

/**
 * The visible items in sidebar order: ungrouped first (label null), then each
 * group in NAV_GROUPS order. A group the role cannot see anything in is
 * omitted rather than rendered as an empty heading.
 */
export function groupedNav(roleCsv: string): NavSection[] {
  const visible = visibleNav(roleCsv)
  const strip = ({ href, label, icon }: NavItem): ClientNavItem => ({ href, label, icon })
  const sections: NavSection[] = []
  const top = visible.filter((i) => !i.group).map(strip)
  if (top.length) sections.push({ label: null, items: top })
  for (const group of NAV_GROUPS) {
    const items = visible.filter((i) => i.group === group).map(strip)
    if (items.length) sections.push({ label: group, items })
  }
  return sections
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/nav.test.ts tests/permissions.test.ts`
Expected: PASS. If the stylist or frontdesk expectations fail, read `lib/permissions.ts` and fix the TEST's expected lists to match the real role table; do not change the role table.

- [ ] **Step 5: Type-check the one consumer**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors. `app/dashboard/(shell)/layout.tsx` still maps `visibleNav(...)` to `{ href, label }`, which remains valid; it is replaced in Task 5.

- [ ] **Step 6: Commit**

```bash
git add lib/nav.ts tests/nav.test.ts
git commit -m "feat(nav): group items, name their icons, and add Kasir

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Install the shadcn sidebar and dropdown primitives

**Files:**
- Create (generated): `components/ui/sidebar.tsx`, `components/ui/sheet.tsx`, `components/ui/tooltip.tsx`, `components/ui/separator.tsx`, `components/ui/skeleton.tsx`, `components/ui/dropdown-menu.tsx`, `hooks/use-mobile.ts`
- Possibly modified (generated): `components/ui/button.tsx`, `components/ui/input.tsx`, `app/globals.css`

**Interfaces:**
- Produces the shadcn exports used in Task 5: `SidebarProvider`, `Sidebar`, `SidebarHeader`, `SidebarContent`, `SidebarFooter`, `SidebarGroup`, `SidebarGroupLabel`, `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarInset`, `SidebarTrigger`, `useSidebar`; `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator`.

- [ ] **Step 1: Record the current state of files the CLI may touch**

Run: `git status --short && git diff --stat`
Expected: clean tree (after Task 3's commit).

- [ ] **Step 2: Add the components**

Run: `pnpm exec shadcn add sidebar dropdown-menu --yes`
Expected: the CLI writes the files listed above under `components/ui/` and `hooks/`. It may offer to overwrite `button.tsx` or `input.tsx`; the `--yes` flag accepts. If it rewrites `button.tsx`, run `git diff components/ui/button.tsx` and confirm `buttonVariants` is still exported with the `outline` variant used by the layout; if the export name changed, restore the file with `git checkout components/ui/button.tsx` and re-run the add with `--overwrite=false`.

- [ ] **Step 3: Check the CSS variables**

Run: `grep -n "sidebar" app/globals.css | head -20`
Expected: the `--sidebar*` tokens already exist in both `:root` and `.dark`; the CLI adds nothing new. If it appended a duplicate block, delete the duplicate so each token is defined once per selector.

- [ ] **Step 4: Verify the sidebar component's mobile mechanism**

Run: `grep -n "Sheet\|useIsMobile\|data-sidebar=\"trigger\"\|data-sidebar=\"sidebar\"" components/ui/sidebar.tsx | head`
Expected: the component renders a `Sheet` when `useIsMobile()` is true and marks the trigger button with `data-sidebar="trigger"` and the panel with `data-sidebar="sidebar"`. Task 8's e2e selectors rely on those attributes. If the generated version uses different attributes, note the actual ones and use them in Task 8.

- [ ] **Step 5: Type-check and lint**

Run: `pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add components/ui hooks app/globals.css package.json pnpm-lock.yaml
git commit -m "chore(ui): add shadcn sidebar and dropdown-menu primitives

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The sidebar shell

**Files:**
- Create: `app/dashboard/(shell)/app-sidebar.tsx`
- Create: `app/dashboard/(shell)/shell-header.tsx`
- Modify: `app/dashboard/(shell)/layout.tsx` (whole file)
- Delete: `app/dashboard/(shell)/main-nav.tsx`

**Interfaces:**
- Consumes: `groupedNav`, `NavSection`, `NavIcon` from `lib/nav.ts`; `salonSettings` from `lib/service.ts` (for `hasLogo`, `logoVersion`); shadcn exports from Task 4; existing `BranchSwitcher`, `signOutAction`, `branchLabel`, `branchesOf`.
- Produces:
  - `AppSidebar` props: `{ salon: { name: string; slug: string; hasLogo: boolean; logoVersion: string }; sections: NavSection[]; userName: string; branchSwitcher: React.ReactNode }`
  - `ShellHeader` props: `{ sections: NavSection[] }`

- [ ] **Step 1: Write `app-sidebar.tsx`**

```tsx
// app/dashboard/(shell)/app-sidebar.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Bell, Building2, CalendarDays, ChevronsUpDown, CreditCard, IdCard, LayoutDashboard,
  LogOut, Package, Percent, Receipt, Scissors, Settings, User, Users, Wallet,
} from 'lucide-react'
import type { NavIcon, NavSection } from '@/lib/nav'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { signOutAction } from './actions'

/** Icon names from lib/nav.ts resolved here, on the client, so the server
 *  payload is strings and the import list is one place. */
const ICONS: Record<NavIcon, React.ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  pos: CreditCard,
  calendar: CalendarDays,
  customers: Users,
  receipt: Receipt,
  percent: Percent,
  wallet: Wallet,
  scissors: Scissors,
  package: Package,
  staff: IdCard,
  branch: Building2,
  bell: Bell,
  settings: Settings,
}

/** Prefix match so /customers/<id> still highlights Pelanggan, guarded on a
 *  boundary so /services never lights up /service-x. Dasbor is exact only. */
export function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AppSidebar({
  salon, sections, userName, branchSwitcher,
}: {
  salon: { name: string; slug: string; hasLogo: boolean; logoVersion: string }
  sections: NavSection[]
  userName: string
  branchSwitcher: React.ReactNode
}) {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()
  // On a phone the sidebar is a drawer; a tap on a link should close it.
  const closeOnMobile = () => { if (isMobile) setOpenMobile(false) }

  return (
    <Sidebar className="print:hidden">
      <SidebarHeader>
        <Link href="/dashboard" className="flex items-center gap-2 px-2 py-1.5 font-medium">
          {salon.hasLogo ? (
            // eslint-disable-next-line @next/next/no-img-element -- served from
            // object storage through our own route; next/image would add an
            // optimiser in front of a 50 KB file for nothing.
            <img
              src={`/api/salon/logo?salon=${salon.slug}&v=${salon.logoVersion}`}
              alt=""
              className="size-7 rounded-md object-contain"
            />
          ) : (
            <span className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground text-sm font-semibold">
              {salon.name.charAt(0).toUpperCase() || 'J'}
            </span>
          )}
          <span className="truncate">{salon.name}</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {sections.map((section) => (
          <SidebarGroup key={section.label ?? 'top'}>
            {section.label && <SidebarGroupLabel>{section.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  const Icon = ICONS[item.icon]
                  const active = isActive(pathname, item.href)
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={<Link href={item.href} aria-current={active ? 'page' : undefined} />}
                        isActive={active}
                        onClick={closeOnMobile}
                      >
                        <Icon className="size-4" />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <div className="px-2 pb-1">{branchSwitcher}</div>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<SidebarMenuButton size="lg" />}
              >
                <span className="flex size-8 items-center justify-center rounded-full bg-sidebar-accent text-sidebar-accent-foreground text-sm font-medium">
                  {userName.charAt(0).toUpperCase()}
                </span>
                <span className="truncate text-sm">{userName}</span>
                <ChevronsUpDown className="ml-auto size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-56">
                <DropdownMenuItem
                  render={<Link href="/dashboard/profile" onClick={closeOnMobile} />}
                >
                  <User className="size-4" />
                  Profil
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* The (auth) layout bounces a signed-in user away from /login,
                    so this is the only reachable way out of the app. */}
                <form action={signOutAction}>
                  <DropdownMenuItem render={<button type="submit" className="w-full" />}>
                    <LogOut className="size-4" />
                    Keluar
                  </DropdownMenuItem>
                </form>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
```

Note on `render={...}`: the base-nova style of shadcn uses base-ui's `render` prop instead of Radix's `asChild`. Open `components/ui/sidebar.tsx` and `components/ui/dropdown-menu.tsx` after Task 4 and confirm `SidebarMenuButton`, `DropdownMenuTrigger` and `DropdownMenuItem` accept `render`. If the generated components expose `asChild` instead, replace each `render={<X />}` with `asChild` and nest the element as the child.

- [ ] **Step 2: Write `shell-header.tsx`**

```tsx
// app/dashboard/(shell)/shell-header.tsx
'use client'

import { usePathname } from 'next/navigation'
import type { NavSection } from '@/lib/nav'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { isActive } from './app-sidebar'

/**
 * The strip above the page: the drawer button on narrow screens and the
 * label of the section the user is in. Pages keep their own <h1>; this is a
 * breadcrumb-level cue, not a replacement.
 */
export function ShellHeader({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname()
  const current = sections.flatMap((s) => s.items).find((i) => isActive(pathname, i.href))

  return (
    <header className="flex h-12 items-center gap-2 border-b px-4 print:hidden">
      <SidebarTrigger className="md:hidden" aria-label="Buka menu" />
      <span className="text-sm text-muted-foreground">{current?.label ?? 'Dasbor'}</span>
    </header>
  )
}
```

- [ ] **Step 3: Rewrite `layout.tsx`**

Replace the whole file with:

```tsx
// app/dashboard/(shell)/layout.tsx
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requirePageOrg } from '@/lib/session'
import { groupedNav } from '@/lib/nav'
import { auth } from '@/lib/auth'
import { branchesOf } from '@/lib/branch'
import { branchLabel } from '@/lib/branch-label'
import { salonSettings } from '@/lib/service'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { ShellHeader } from './shell-header'
import { BranchSwitcher } from './branch-switcher'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePageOrg()
  const activeTeamId = session.session.activeTeamId ?? null
  const { success: canSwitch } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { branch: ['switch'] } },
  })
  // A role that cannot switch must never RECEIVE the branch list: props to a
  // client component are serialized into the RSC payload whether or not they
  // are rendered, so passing the whole table and letting the component pick one
  // label handed front desk and stylists every branch's name, address, phone
  // and lock state on every page — the very table spec §8 guards /branches to
  // keep from them. They get one row, resolved and rendered on the server.
  const [branches, settings, { rows: orgRows }, { rows: memberRows }] = await Promise.all([
    canSwitch
      ? branchesOf(session.organizationId)
      : activeTeamId ? branchesOf(session.organizationId, activeTeamId) : Promise.resolve([]),
    salonSettings(session.organizationId),
    db.execute(sql`select name, slug from organizations where id = ${session.organizationId}`),
    // The caller's role, read once, decides which links appear. Showing a link
    // whose page would redirect is worse than showing none -- it reads as a
    // broken app rather than an unavailable feature.
    db.execute(sql`
      select role from members
       where user_id = ${session.user.id}
         and organization_id = ${session.organizationId}`),
  ])
  const org = orgRows[0] as { name: string; slug: string }
  const sections = groupedNav((memberRows[0] as { role?: string })?.role ?? '')

  // Narrowed for the same reason the non-switching roles get one row: the
  // switcher needs an id and a label; address, phone and staffCount are the
  // /branches table's business, not the sidebar's.
  const branchOptions = branches.map(
    ({ teamId, name, active, withinCap }) => ({ teamId, name, active, withinCap }),
  )
  const branchSwitcher = canSwitch ? (
    <BranchSwitcher branches={branchOptions} activeTeamId={activeTeamId} />
  ) : (
    <span className="block truncate px-2 text-sm text-muted-foreground">
      {branches[0] ? branchLabel(branches[0]) : '—'}
    </span>
  )

  return (
    <SidebarProvider>
      <AppSidebar
        salon={{
          name: org.name, slug: org.slug,
          hasLogo: settings.hasLogo, logoVersion: settings.logoVersion,
        }}
        sections={sections}
        userName={session.user.name}
        branchSwitcher={branchSwitcher}
      />
      <SidebarInset>
        <ShellHeader sections={sections} />
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
```

- [ ] **Step 4: Delete the old nav and fix the branch switcher width**

Run: `git rm app/dashboard/\(shell\)/main-nav.tsx`

In `app/dashboard/(shell)/branch-switcher.tsx`, change `<SelectTrigger size="sm" className="w-56">` to `<SelectTrigger size="sm" className="w-full">` so it fills the sidebar footer instead of overflowing it.

- [ ] **Step 5: Type-check, lint, and look at it**

Run: `pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: no errors. The most likely error is a `render` vs `asChild` mismatch (see the note in Step 1) or a lucide icon name that does not exist in the installed version; run `grep -c "IdCard\|CreditCard\|ChevronsUpDown" node_modules/lucide-react/dist/lucide-react.d.ts` and substitute `Contact` for `IdCard` if it is missing.

Run: `pnpm dev`, sign in as any seeded owner (see `docs/demo-runbook.md` for credentials), open `http://localhost:3001/dashboard`.
Expected on a wide window: sidebar on the left with logo or initial, five groups, branch switcher and user row at the bottom; user row opens a menu with Profil and Keluar; Keluar signs out. Narrow the window under 768px: the sidebar disappears, the header shows a hamburger, tapping it slides in the drawer, tapping a link closes it. Open `/dashboard/transactions/<any id>` and print preview: no sidebar, no header.

- [ ] **Step 6: Run the existing e2e suite for the shell**

Run: `pnpm test:e2e tests/e2e/ui.spec.ts tests/e2e/branch.spec.ts`
Expected: PASS. If a spec asserted on the old header markup (a `nav` link by text, or the `Keluar` button outside a menu), update that assertion to the new structure: nav links are inside `[data-sidebar="sidebar"]`, and Keluar is reached by clicking the user row first.

- [ ] **Step 7: Commit**

```bash
git add app/dashboard/\(shell\)/app-sidebar.tsx app/dashboard/\(shell\)/shell-header.tsx \
        app/dashboard/\(shell\)/layout.tsx app/dashboard/\(shell\)/branch-switcher.tsx tests/e2e
git commit -m "feat(shell): grouped sidebar with mobile drawer replaces the top bar

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Apply the salon theme to the document

**Files:**
- Modify: `app/globals.css:5` (dark variant) and `app/globals.css:95` (dark token block selector)
- Create: `app/dashboard/(shell)/theme-applier.tsx`
- Modify: `app/dashboard/(shell)/layout.tsx` (add the inline script and applier)

**Interfaces:**
- Consumes: `themeOf`, `themeVars`, `themeScript` from `lib/theme.ts`; `settings.theme` and `settings.brandColor` from `salonSettings`.
- Produces: `ThemeApplier` props `{ mode: ThemeMode; vars: Record<string, string> }`.

- [ ] **Step 1: Widen the dark variant in `globals.css`**

Change line 5 from:

```css
@custom-variant dark (&:is(.dark *));
```

to:

```css
/* .dark is the class shadcn's docs assume; data-theme is what the dashboard
   shell sets on <html> from the salon's preset (lib/theme.ts). Both work. */
@custom-variant dark (&:is(.dark *, [data-theme="dark"] *));
```

Change the dark token block opener at line 95 from `.dark {` to:

```css
.dark, [data-theme="dark"] {
```

- [ ] **Step 2: Write `theme-applier.tsx`**

```tsx
// app/dashboard/(shell)/theme-applier.tsx
'use client'

import { useLayoutEffect } from 'react'
import type { ThemeMode } from '@/lib/theme'

/**
 * Keeps <html> in step with the salon's theme AFTER first paint.
 *
 * The inline script in the layout handles the first paint. React does not
 * re-run an inline script when the layout re-renders, so when the owner saves
 * a new preset the changed props land here and this effect applies them. On
 * unmount (sign out lands on /login, a soft navigation) it removes everything
 * so the marketing and auth pages are not left dark.
 */
export function ThemeApplier({ mode, vars }: { mode: ThemeMode; vars: Record<string, string> }) {
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.theme = mode
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    return () => {
      delete root.dataset.theme
      for (const k of Object.keys(vars)) root.style.removeProperty(k)
    }
  }, [mode, vars])
  return null
}
```

- [ ] **Step 3: Emit the script and mount the applier in `layout.tsx`**

Add to the imports:

```tsx
import { themeOf, themeScript, themeVars } from '@/lib/theme'
import { ThemeApplier } from './theme-applier'
```

After `const sections = groupedNav(...)`, add:

```tsx
  const preset = themeOf(settings.theme)
  const vars = themeVars(preset, settings.brandColor)
```

Change the returned JSX so the script is the first thing rendered and the applier sits beside it:

```tsx
  return (
    <SidebarProvider>
      {/* First in the stream so <html> carries the theme before the shell
          paints -- no light-to-dark flash, and portalled menus inherit it.
          Content is JSON-encoded in themeScript, never raw. */}
      <script dangerouslySetInnerHTML={{ __html: themeScript(preset.mode, vars) }} />
      <ThemeApplier mode={preset.mode} vars={vars} />
      <AppSidebar
```

(the rest of the JSX unchanged).

- [ ] **Step 4: Type-check and verify in the browser**

Run: `pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: no errors.

Run: `pnpm dev`, then in psql against the dev database: `update salon_profiles set theme = 'charcoal' where organization_id = '<your dev org id>';`. Reload `/dashboard`.
Expected: dark shell and pages with no flash of white on hard reload; the branch Select dropdown and the user menu are dark too. Sign out: `/login` is light. Set `theme = 'sapphire'` and `brand_color = null`: dark with blue primary buttons and black text on them. Set `brand_color = '#a04e5b'`: buttons go rose with white text. Reset to `ivory`.

- [ ] **Step 5: Run the unit suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/globals.css app/dashboard/\(shell\)/theme-applier.tsx app/dashboard/\(shell\)/layout.tsx
git commit -m "feat(theme): apply the salon preset and accent to the document root

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Theme picker on the settings page

**Files:**
- Modify: `app/dashboard/(shell)/settings/actions.ts:166-201` (`setBrandingAction`)
- Modify: `app/dashboard/(shell)/settings/settings-forms.tsx:155-221` (`BrandingCard`)
- Modify: `app/dashboard/(shell)/settings/page.tsx:43-48`

**Interfaces:**
- Consumes: `THEMES`, `isThemeKey`, `type ThemeKey`, `accentForeground` from `lib/theme.ts`.
- Produces: `BrandingCard` gains prop `theme: ThemeKey`; form field `theme` (radio) submitted alongside `brandColor` and `logo`.

- [ ] **Step 1: Validate and persist `theme` in the action**

In `app/dashboard/(shell)/settings/actions.ts`, add the import:

```ts
import { isThemeKey } from '@/lib/theme'
```

In `setBrandingAction`, after the colour validation block (the `if (color && !/^#.../.test(color))` return), add:

```ts
  const theme = String(formData.get('theme') ?? '')
  if (!isThemeKey(theme)) {
    // Also a check constraint in the database. This one says so in Indonesian.
    return { error: 'Pilih salah satu tema yang tersedia.' }
  }
```

Change the final update statement to write both columns:

```ts
  await db.execute(sql`
    update salon_profiles
       set brand_color = ${color || null}, theme = ${theme}, updated_at = now()
     where organization_id = ${organizationId}`)
  // The shell layout reads the theme; the page path alone would leave the
  // sidebar and <html> on the old preset until a hard reload.
  revalidatePath('/dashboard', 'layout')
  return { done: true }
```

(remove the existing `revalidatePath('/dashboard/settings')` line; the layout revalidation covers it).

- [ ] **Step 2: Rewrite `BrandingCard`**

In `settings-forms.tsx`, add to the imports:

```tsx
import { THEMES, accentForeground, type ThemeKey } from '@/lib/theme'
```

Replace the whole `BrandingCard` function with:

```tsx
/**
 * Logo, theme preset and accent colour. Multipart because a file cannot ride
 * in a normal action payload, so the preset and colour travel in the same
 * form and the same action as the logo.
 */
export function BrandingCard({
  slug, hasLogo, logoVersion, brandColor, theme,
}: {
  slug: string
  hasLogo: boolean
  logoVersion: string
  brandColor: string | null
  theme: ThemeKey
}) {
  const [state, action, pending] = useActionState(setBrandingAction, initial)
  // Controlled so the colour well, the hex box and the reset button agree.
  const [accent, setAccent] = useState(brandColor ?? '')
  const [preset, setPreset] = useState<ThemeKey>(theme)
  const previewAccent = accent || THEMES.find((t) => t.key === preset)!.accent

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tampilan</CardTitle>
        <CardDescription>
          Logo, tema dan warna aksen yang dipakai di dasbor, struk dan halaman pemesanan.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-5">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {state.done && (
            <Alert><AlertDescription>Tampilan disimpan.</AlertDescription></Alert>
          )}

          {hasLogo && (
            // eslint-disable-next-line @next/next/no-img-element -- served
            // from object storage through our own route; next/image would add
            // an optimiser in front of a 50 KB file for nothing.
            <img
              src={`/api/salon/logo?salon=${slug}&v=${logoVersion}`}
              alt="Logo salon"
              className="h-12 w-auto"
            />
          )}
          <div className="space-y-2">
            <Label htmlFor="logo">Logo</Label>
            <input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" className="block text-sm" />
            <p className="text-xs text-muted-foreground">PNG, JPEG atau WebP. Maksimal 200 KB.</p>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Tema</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {THEMES.map((t) => {
                const surface = t.mode === 'dark' ? '#252525' : '#ffffff'
                const side = t.mode === 'dark' ? '#343434' : '#f4f4f5'
                const text = t.mode === 'dark' ? '#e5e5e5' : '#3f3f46'
                const swatchAccent = t.key === preset ? previewAccent : t.accent
                return (
                  <label
                    key={t.key}
                    className="cursor-pointer rounded-lg border p-2 has-checked:border-primary has-checked:ring-2 has-checked:ring-primary/30"
                  >
                    <input
                      type="radio"
                      name="theme"
                      value={t.key}
                      checked={preset === t.key}
                      onChange={() => setPreset(t.key)}
                      className="sr-only"
                    />
                    {/* A miniature of the shell: sidebar strip, a heading line
                        and one accent button. Enough to tell presets apart. */}
                    <div
                      aria-hidden
                      className="flex h-16 overflow-hidden rounded-md border"
                      style={{ background: surface, borderColor: side }}
                    >
                      <div className="w-1/3" style={{ background: side }} />
                      <div className="flex flex-1 flex-col gap-1.5 p-2">
                        <div className="h-1.5 w-3/4 rounded" style={{ background: text, opacity: 0.5 }} />
                        <div className="h-1.5 w-1/2 rounded" style={{ background: text, opacity: 0.3 }} />
                        <div
                          className="mt-auto h-4 w-10 rounded"
                          style={{ background: swatchAccent, color: accentForeground(swatchAccent) }}
                        />
                      </div>
                    </div>
                    <div className="mt-1.5 text-center text-xs">{t.label}</div>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="brandColor">Warna aksen</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Pilih warna aksen"
                value={accent || previewAccent}
                onChange={(e) => setAccent(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
              />
              <input
                id="brandColor"
                name="brandColor"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                placeholder={previewAccent}
                className="flex h-9 w-32 rounded-md border bg-transparent px-3 py-1 font-mono text-sm shadow-xs"
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => setAccent('')} disabled={!accent}>
                Pakai warna tema
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Kosongkan untuk memakai warna bawaan tema. Warna ini juga dipakai di struk dan halaman pemesanan.
            </p>
          </div>

          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? 'Menyimpan…' : 'Simpan tampilan'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
```

If the existing `BrandingCard` had a logo `<input type="file">` with different attributes than shown, keep the existing input markup; only the theme fieldset and accent row are new.

- [ ] **Step 3: Pass `theme` from the page**

In `app/dashboard/(shell)/settings/page.tsx`, add `theme={salon.theme}` to the `<BrandingCard ... />` props.

- [ ] **Step 4: Type-check, lint, and try the form**

Run: `pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: no errors. If Tailwind rejects `has-checked:`, replace those two classes with `has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-primary/30`.

Run: `pnpm dev`, open `/dashboard/settings` as owner.
Expected: five swatches with Ivory selected; picking Charcoal and saving shows "Tampilan disimpan." and the whole app goes dark without a reload; typing `#a04e5b` and saving turns buttons rose; "Pakai warna tema" clears the box and saving restores the preset accent; typing `red` shows the Indonesian format error.

- [ ] **Step 5: Run the existing settings-related suites**

Run: `pnpm vitest run tests/pos.db.test.ts tests/theme.db.test.ts && pnpm test:e2e tests/e2e/ui.spec.ts tests/e2e/public-booking.spec.ts`
Expected: PASS. If a spec posts the branding form without a `theme` field and now sees the new error, add `theme: 'ivory'` to that spec's form data.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/\(shell\)/settings tests/e2e
git commit -m "feat(settings): choose a theme preset and accent on the Tampilan card

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end check of the shell and theme

**Files:**
- Create: `tests/e2e/shell.spec.ts`

**Interfaces:**
- Consumes: `createSalon`, `signIn`, `BASE_URL` from `tests/e2e/fixtures.ts`; `TEST_DATABASE_URL` from `tests/db.ts`; the `data-sidebar` attributes confirmed in Task 4 Step 4.

- [ ] **Step 1: Write the spec**

```ts
// tests/e2e/shell.spec.ts
import { test, expect } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon, signIn } from './fixtures'

/**
 * The shell as three people meet it: the owner picks a look on Pengaturan,
 * a stylist in the same salon sees it on their next load, and on a phone
 * the navigation is a drawer that lists only what that role may open.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const DOMAIN = 'shellcheck.test'
const PW = 'ShellCheck#2026'

let orgId: string
let owner: Awaited<ReturnType<typeof createSalon>>['ctx']
let stylist: Awaited<ReturnType<typeof signIn>>

const cookiesOf = async (ctx: typeof owner) => (await ctx.storageState()).cookies

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug = 'shellcheck'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  const salon = await createSalon(pool, {
    name: 'Shell Owner', email: `owner@${DOMAIN}`, password: PW,
    salon: 'Shell Check', slug: 'shellcheck',
  })
  owner = salon.ctx
  orgId = salon.organizationId
  const { rows: [team] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`, [orgId])
  await owner.post('/api/staff', {
    data: { name: 'Shell Stylist', email: `stylist@${DOMAIN}`, password: PW, role: 'stylist', branchId: team.id },
  })
  stylist = await signIn(`stylist@${DOMAIN}`, PW)
})

test.afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [orgId])
  await pool.end()
})

test('a fresh salon is ivory: light, no accent override', async ({ page }) => {
  await page.context().addCookies(await cookiesOf(owner))
  await page.goto('/dashboard')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible()
  await expect(page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Kasir' })).toBeVisible()
})

test('the owner picks Charcoal and an accent; a stylist sees both on next load', async ({ page, browser }) => {
  await page.context().addCookies(await cookiesOf(owner))
  await page.goto('/dashboard/settings')
  await page.getByRole('radio', { name: 'Charcoal' }).check({ force: true })
  await page.locator('#brandColor').fill('#7aa2f7')
  await page.getByRole('button', { name: 'Simpan tampilan' }).click()
  await expect(page.getByText('Tampilan disimpan.')).toBeVisible()
  // Applied without a reload: the applier effect ran on the re-rendered layout.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  const { rows } = await pool.query(
    `select theme, brand_color from salon_profiles where organization_id = $1`, [orgId])
  expect(rows[0]).toEqual({ theme: 'charcoal', brand_color: '#7aa2f7' })

  const ctx = await browser.newContext()
  await ctx.addCookies(await cookiesOf(stylist))
  const other = await ctx.newPage()
  await other.goto('/dashboard')
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark')
  const primary = await other.evaluate(
    () => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())
  expect(primary).toBe('#7aa2f7')
  await ctx.close()
})

test('on a phone the stylist opens the drawer and sees only their three links', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await ctx.addCookies(await cookiesOf(stylist))
  const page = await ctx.newPage()
  await page.goto('/dashboard')
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeHidden()
  await page.locator('[data-sidebar="trigger"]').click()
  const drawer = page.locator('[data-sidebar="sidebar"]')
  await expect(drawer).toBeVisible()
  const links = drawer.getByRole('link').filter({ hasNotText: 'Shell Check' })
  await expect(links).toHaveText(['Dasbor', 'Janji temu', 'Komisi'])
  await expect(drawer.getByText('Katalog')).toHaveCount(0)
  await links.filter({ hasText: 'Komisi' }).click()
  await expect(page).toHaveURL(/\/dashboard\/commissions/)
  await expect(drawer).toBeHidden()
  await ctx.close()
})

test('a theme key the form does not know is refused in Indonesian, not as a 500', async ({ page }) => {
  await page.context().addCookies(await cookiesOf(owner))
  await page.goto('/dashboard/settings')
  await page.evaluate(() => {
    const el = document.querySelector('input[name="theme"]:checked') as HTMLInputElement
    el.value = 'pink'
  })
  await page.getByRole('button', { name: 'Simpan tampilan' }).click()
  await expect(page.getByText('Pilih salah satu tema yang tersedia.')).toBeVisible()
})
```

- [ ] **Step 2: Run it and iterate on selectors**

Run: `pnpm test:e2e tests/e2e/shell.spec.ts`
Expected: PASS. If the radio's accessible name is not the label text, target it as `page.locator('input[name="theme"][value="charcoal"]')`. If the drawer's link list includes the logo link, adjust the `hasNotText` filter to the salon name used above. If the mobile sidebar renders a different `data-sidebar` attribute (Task 4 Step 4), use that.

- [ ] **Step 3: Run everything**

Run: `pnpm exec tsx tests/reset-db.ts && pnpm test && pnpm test:e2e`
Expected: all green. Paste the summary lines of both runners into the commit body if anything needed adjusting.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/shell.spec.ts
git commit -m "test(shell): owner sets theme, stylist sees it, phone drawer lists role links

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review against the spec

- §3 shell layout: Task 5 (sidebar, header, footer, print:hidden, payload rules kept). ✔
- §4 nav structure: Task 3 (groups, icons, Kasir, empty groups dropped, active rule). ✔
- §5 theming model: Task 1 (presets, accent override, tokens driven, foreground). Foreground is chosen by higher contrast rather than a 0.5 luminance cut; this is stricter than the spec's wording and the reason is in the code comment and the test. ✔
- §6 applying: Task 6 (inline script, applier with cleanup, dark variant widened). ✔
- §7 settings: Task 7 (swatches, colour input, reset, action validation, layout revalidation). ✔
- §8 migration: Task 2 (column, default, constraint, generated via drizzle-kit so the journal and snapshot stay in step). ✔
- §9 errors: Task 7 (Indonesian error), Task 1 and 2 (invalid accent or theme falls back, never reaches CSS). ✔
- §10 tests: Tasks 1, 2, 3, 8. ✔
- §11 rollout: default `ivory`, no backfill. ✔
