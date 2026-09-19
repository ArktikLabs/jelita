# Dashboard Shell and Per-Salon Theming — Design

**Date:** 2026-09-19
**Status:** draft

## 1. The problem

The dashboard's navigation is a single horizontal bar of up to twelve text
links, in an order that mixes daily work (bookings, transactions) with rare
admin pages (branches, settings). It has no grouping, no icons, and no mobile
behaviour beyond `overflow-x-auto`, so on a phone the links scroll off the
right edge. The POS page, the most-used screen for front desk, is not in the
nav at all. Visually it is unbranded: every salon sees the same grey bar.

Four complaints, all confirmed by the owner:

- too many flat items;
- breaks on mobile and tablet;
- looks generic;
- the wrong things are prominent.

Three roles use the app on three kinds of device: owners on laptops, front
desk on tablets, stylists on phones. The shell has to serve all three equally.

## 2. Scope

**In:**

- Replace the top bar with a grouped sidebar on wide screens and a hamburger
  drawer on narrow ones.
- Add Kasir (POS) to the navigation.
- Per-salon theme: one of five presets plus an optional accent colour, chosen
  by the owner on Pengaturan, applied to the whole dashboard for every member
  of that salon.

**Out, deliberately:**

- Per-user theme overrides. One salon, one look.
- A free-form token editor. Presets plus one accent is the whole surface.
- Theming the public booking page and receipts beyond the accent colour they
  already read from `brand_color`.
- A collapsible icon rail on desktop. The sidebar is either open (wide) or a
  drawer (narrow). Re-confirmed by the owner on 2026-09-19 when the header
  switcher was amended.

## 3. Shell layout

The dashboard shell layout at `app/dashboard/(shell)/layout.tsx` switches to
the shadcn `sidebar` component (`SidebarProvider`, `Sidebar`, `SidebarInset`,
`SidebarTrigger`). That component already renders a fixed sidebar from the
`md` breakpoint up and a slide-in `Sheet` below it, so the mobile drawer is
not custom code.

Sidebar contents, top to bottom:

1. **Header: the branch switcher**, in the shape of the shadcn sidebar-07
   block's `TeamSwitcher` (amended 2026-09-19, owner's request). One row: a
   square showing the salon logo when one is uploaded (via the existing
   `/api/salon/logo` route) or the salon's initial, a bold line with the
   active branch's label (`branchLabel`, so "— Nonaktif" / "— Terkunci"
   still show), and a small line with the salon name. For roles holding
   `branch:switch` the row is a dropdown trigger listing every branch, the
   active one ticked; picking one calls the existing `switchBranchAction`.
   Other roles get the same row rendered static, and never receive the list.
2. **Navigation:** the grouped items from §4. Group labels are rendered with
   `SidebarGroupLabel`; a group with no visible items for the current role is
   not rendered.
3. **Footer:** a user row showing the member's name that opens a dropdown
   menu with **Profil** (`/dashboard/profile`) and **Keluar** (the existing
   `signOutAction` form).

Above the page content, `SidebarInset` holds a slim header: the
`SidebarTrigger` hamburger (visible below `md` only) and the current page's
label from the nav list. Page components keep their own `<h1>`; the header
label is a breadcrumb-level cue, not a replacement.

The whole shell keeps `print:hidden` on sidebar and header so the receipt
page still prints clean.

The server-side rules already in the layout carry over unchanged: the branch
list is only passed to the client for roles that can switch, and nav items
reach the client as `{ href, label, icon, group }` only. `require` stays
server-side.

## 4. Navigation structure

`lib/nav.ts` keeps its permission-driven `visibleNav()` and each `NavItem`
gains `group` and `icon` (a lucide icon name, resolved to a component on the
client from a fixed map so the server payload stays strings).

| Group | Items | Permission |
|---|---|---|
| (none) | Dasbor | — |
| Operasional | Kasir, Janji temu, Pelanggan | `pos:checkout`, `booking:read`, `customer:read` |
| Keuangan | Transaksi, Komisi, Penggajian | `pos:checkout`, `commission:read:own`, `payroll:read` |
| Katalog | Layanan, Produk | `service:update`, `product:read` |
| Pengelolaan | Staf, Cabang, Notifikasi, Pengaturan | `staff:read`, `branch:update`, `notification:read`, `settings:update` |

Kasir links to `/dashboard/pos` and mirrors the guard on that page. A
stylist, holding booking, customer and own-commission reads, sees Dasbor,
Janji temu, Pelanggan and Komisi under two group labels.

The active-item rule is unchanged: exact match or prefix on a `/` boundary.

## 5. Theming model

A theme is **a preset plus an optional accent**.

### 5.1 Presets

Five presets, keyed by slug, defined as constants in a new `lib/theme.ts`:

| Key | Display | Surface | Default accent |
|---|---|---|---|
| `ivory` | Ivory | light | warm neutral (near-black) |
| `charcoal` | Charcoal | dark | soft white |
| `rose-gold` | Rose Gold | light | dusty pink, warm tint |
| `sage` | Sage | light | muted green |
| `sapphire` | Sapphire | dark | deep blue |

Each preset is `{ key, label, mode: 'light' | 'dark', accent: '#rrggbb' }`.
The exact hex values are chosen during implementation and validated for
contrast against their surface; the spec fixes the set, not the numbers.

`ivory` is the default and matches today's look, so existing salons see no
change until an owner picks something else.

### 5.2 Accent

The accent reuses the existing `salon_profiles.brand_color`. When set, it
overrides the preset's default accent. This keeps one brand colour driving
the dashboard, the receipt and the booking page. When null, the preset's
default accent applies.

### 5.3 What the accent drives

The accent sets these tokens: `--primary`, `--ring`, `--sidebar-primary`,
and the matching `-foreground` tokens. The foreground is black or white,
whichever has the higher WCAG contrast ratio against the accent, so a pale
accent never yields white text on a yellow button and a mid-blue gets black
text rather than a 2.5:1 white. `--accent`,
`--secondary`, `--muted` and the surface tokens stay on the existing light
or dark sets in `app/globals.css`; the preset's `mode` decides which set.

`lib/theme.ts` exports `themeVars(preset, accent | null)` returning the
CSS custom-property map, and `accentForeground(hex)`. Both are pure and unit
tested.

## 6. Applying the theme

Dropdowns and the mobile drawer portal to `<body>`, so the theme cannot live
on a wrapper `<div>` inside the shell. It has to sit on `<html>`. The root
layout serves marketing and auth pages too and must not query the salon, so
the shell layout does it:

1. The shell layout reads the salon's preset and `brand_color` (extend the
   existing `salonSettings()` query in `lib/service.ts` with the new column).
2. It renders, as its first child, an inline `<script>` that sets
   `document.documentElement.dataset.theme = '<mode>'` and applies the
   `themeVars` map with `style.setProperty`. Inline in the streamed HTML, it
   runs before the shell paints, so there is no light-to-dark flash. The
   values are server-validated (`#rrggbb` regex plus the preset check) and
   JSON-encoded into the script, never interpolated raw.
3. A small client component mounted by the shell removes the attribute and
   properties on unmount, so a soft navigation out of the dashboard (sign
   out lands on `/login`) does not leave a dark marketing page behind.

`app/globals.css` widens the dark variant to
`@custom-variant dark (&:is(.dark *, [data-theme=dark] *))` and duplicates
the `.dark` token block selector as `.dark, [data-theme=dark]`. The existing
class keeps working for any page that already uses it.

## 7. Settings

The **Tampilan** card on `/dashboard/settings` (`BrandingCard` in
`settings-forms.tsx`) gains:

- **Tema:** five swatch cards, one per preset, each showing a miniature of
  the sidebar and a button in that preset's surface and accent. Single
  choice, rendered as radio inputs so it submits with the existing form.
- **Warna aksen:** the current hex text input becomes a native
  `<input type="color">` alongside the hex text, with a "Pakai warna tema"
  button that clears it back to the preset default. Both write the same
  `brandColor` field.

`setBrandingAction` validates `theme` against the preset keys and writes it
in the same `update salon_profiles` statement as `brand_color`. Permission
guard unchanged: `settings:update`.

## 8. Data and migration

One migration, `db/migrations/0036_salon_theme.sql`:

```sql
alter table salon_profiles add column theme text not null default 'ivory';
alter table salon_profiles add constraint salon_profiles_theme
  check (theme in ('ivory','charcoal','rose-gold','sage','sapphire'));
```

No backfill: the default covers existing rows. Adding a preset later is a
constraint change plus a constant, which is the intended shape.

## 9. Error handling

- Unknown `theme` from the form: Indonesian error on the card, same style as
  the existing colour-format error.
- A `brand_color` that fails the regex at read time (should be impossible
  given the check constraint) falls back to the preset accent rather than
  reaching the stylesheet.
- A member of a salon whose row somehow lacks a profile gets `ivory` with no
  accent, never a crash in the layout.

## 10. Testing

- `tests/theme.test.ts`: `accentForeground` returns white for dark accents
  and black for pale ones at the threshold; `themeVars` applies the accent
  override when present and the preset default when null; every preset's
  default accent clears the WCAG 4.5:1 ratio against its own surface.
- `tests/nav.test.ts` (extend if one exists, else add): groups with no
  visible items are dropped; stylist role yields Dasbor, Janji temu, Pelanggan, Komisi;
  Kasir appears for a role holding `pos:checkout`.
- `tests/salon.db.test.ts`: the theme column rejects an unknown key and the
  branding action round-trips a preset plus accent.
- One Playwright flow: owner selects Charcoal and a custom accent, saves; a
  stylist in the same salon loads the dashboard and the document root
  carries `data-theme="dark"` and the accent variable. Mobile viewport:
  the hamburger opens the drawer and the drawer lists the stylist's four
  items.

## 11. Rollout

Ships as one change. Existing salons land on Ivory with their current
`brand_color` as accent, so the only visible difference for them is the
sidebar itself.

A salon that already set a brand colour will see it become the dashboard's
primary colour on deploy day: buttons, focus rings and the active sidebar
item take the accent, not just the receipt and booking page. That is §5.2
working as designed, but it is a visible change, not a no-op.
