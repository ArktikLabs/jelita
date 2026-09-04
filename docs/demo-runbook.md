# Demo runbook — Ovarya

The three flows from PRD §6, in the order to walk them, with what each proves
and the numbers to expect. Verified end to end on 2026-09-04 against the
seeded demo.

**Sign in:** `owner@ovarya.demo` / `demo12345` (owner)
· `dewi@ovarya.demo` / `demo12345` (front desk, Kemang)

---

## Flow A — a customer books online (do this on a phone)

`/book/ovarya` → **Ovarya Kemang** → *Creambath* → pick a date → **Lihat
jadwal** → pick a time → name + WhatsApp number → **Pesan sekarang**.

Expect: 23 slots offered on a normal weekday; the confirmation screen reads
*"Permintaan janji temu terkirim."*; the booking lands **pending** for the
salon to confirm.

**The point to make:** four WhatsApp messages are queued the instant the
booking is made — confirmation, the day before, two hours before, and a
thank-you. Show them in **Notifikasi**.

## Flow B — front desk checks out

**Janji temu** → a booking → **Bayar** → the service is already in the cart →
add *Sampo Keratin 250ml* from the dropdown → type the customer's WhatsApp
number → **QRIS** → **Selesaikan pembayaran**.

Expect, all in one commit: a numbered receipt, **stock −1**, a **commission
row** at 10%, and **points** at Rp 10.000 = 1 point (a Rp 290.000 sale earns
29).

**The point to make:** one action, four ledgers, and voiding it reverses every
one of them.

## Flow C — the owner reviews the week

**Dasbor** → revenue trend and the four KPIs → **Kinerja staf** → **Produk**
for the low-stock banner → **Komisi** for the payroll recap.

Expect: *Stok menipis: Hair Tonic 100ml (0), Sampo Keratin 250ml (3)*; total
commission this month **Rp 643.000**, which is exactly 10% of service revenue.

Then switch the branch selector to **Ovarya Senopati** and show every number
change — Kemang runs ~Rp 32,5jt against Senopati's ~Rp 23,1jt.

**The point to make:** every screen is branch-scoped, and a stylist signing in
sees this same dashboard scoped to themselves.

## Worth showing if asked

- **Pelanggan → any member**: total spend, visit history, and a points balance.
- **Notifikasi**: the exact WhatsApp text that would be sent, with **Kirim yang
  jatuh tempo** as the manual stand-in for the scheduler. Auth email is in the
  same queue — note that a password-reset link is deliberately NOT stored.
- **Penggajian**: the payroll month, and that closing it locks the figures.

## Known, and say so before they find it

- WhatsApp is **simulated** (PRD §5.5). The pipeline is real; going live is a
  credentials swap.
- Reminders fire on a cron in production; in the demo, press the button.
