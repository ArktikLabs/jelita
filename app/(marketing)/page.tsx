import Image from 'next/image'

/* The live demo. Env-driven so it follows a custom domain without a code change. */
const DEMO_URL = process.env.NEXT_PUBLIC_DEMO_URL
  ?? 'https://jelita-six.vercel.app/salon/ovarya'
/* PLACEHOLDER. Set NEXT_PUBLIC_WA_NUMBER before this page is shown to anyone --
   a "Tanya via WhatsApp" button that reaches nobody is worse than no button. */
const WA_URL = `https://wa.me/${process.env.NEXT_PUBLIC_WA_NUMBER ?? '6281234567890'}`

/* The seeded demo's actual contents, checked against scripts/seed-demo.ts.
   Labelled as demo contents on the page -- never dressed up as customer or
   performance numbers. */
const COUNTS: [number, string][] = [
  [2, 'cabang'],
  [15, 'service'],
  [8, 'staff'],
  [40, 'customer'],
  [3, 'minggu transaksi'],
]

/* The tour. Each step is a REAL capture of the running demo, with the claims
   that screen actually demonstrates. No mockups, no invented UI. */
const TOUR = [
  {
    src: '/shots/pos.png',
    alt: 'Layar kasir Jelita: keranjang berisi satu service dan satu produk retail, '
      + 'kolom nomor WhatsApp pelanggan, dan pilihan metode pembayaran.',
    cap: 'Kasir — booking hari ini, ditambah satu produk dari rak.',
    h: 'Checkout menutup empat hal sekaligus',
    p: 'Booking selesai, stok turun, komisi dibuat, poin member naik. Satu tekan.',
    claims: [
      'Komisi dibuat per baris transaksi, bukan dihitung ulang tiap akhir bulan',
      'Aturan persen atau nominal, per service per staff',
      'Member dikenali dari nomor WhatsApp',
      'Transaksi terkunci setelah selesai — pembatalan menulis baris balik, bukan menghapus',
    ],
  },
  {
    src: '/shots/dashboard.png',
    alt: 'Dasbor pemilik Jelita: omzet, jumlah janji temu, tingkat penyelesaian, '
      + 'grafik omzet harian, dan layanan teratas.',
    cap: 'Dasbor — tujuh hari terakhir, satu cabang.',
    h: 'Revenue, top service, funnel, no-show',
    p: 'Filter tanggal, export CSV, semuanya di-scope ke cabang yang sedang dipilih. '
      + 'No-show akhirnya jadi angka yang bisa diperbaiki, bukan cerita.',
    claims: [
      'Semua angka per cabang — front desk terkunci di cabangnya sendiri',
      'Cabang kedua = satu baris di settings, bukan kolom baru di database',
      'Stylist melihat dasbor yang sama, di-scope ke dirinya sendiri',
    ],
  },
  {
    src: '/shots/notifications.png',
    alt: 'Notification Center Jelita: daftar pesan WhatsApp yang akan dikirim, '
      + 'lengkap dengan isi pesan dan statusnya.',
    cap: 'Notification Center — isi pesan yang akan dikirim, apa adanya.',
    h: 'Pipeline-nya sudah jalan, kredensialnya belum',
    p: 'Pesan disiapkan saat booking dibuat: konfirmasi, pengingat H-1, pengingat '
      + '2 jam sebelum, dan terima kasih setelah kunjungan. Template bisa diedit admin.',
    claims: [
      'Go-live ke Fonnte, Wablas, atau Meta API adalah tukar kredensial',
      'Booking yang dibatalkan membatalkan pesan yang belum terkirim',
      'Tautan reset kata sandi tidak pernah ikut tersimpan di sini',
    ],
  },
]

const STEPS = [
  {
    n: '1',
    h: 'Customer booking sendiri',
    p: 'Pilih cabang, service, staff, lalu slot. Ketersediaan dihitung dari jam kerja '
      + 'staff, durasi service, dan booking yang sudah ada.',
    facts: ['slot bentrok ditolak di database', '90 menit mengunci slot berikutnya', 'konfirmasi masuk antrean'],
  },
  {
    n: '2',
    h: 'Front desk checkout',
    p: 'Buka booking hari ini, tambah produk retail, cari member lewat nomor WhatsApp, '
      + 'pilih metode bayar, cetak struk.',
    facts: ['komisi dibuat per baris', 'stok berkurang otomatis', 'poin member bertambah', 'transaksi terkunci setelah selesai'],
  },
  {
    n: '3',
    h: 'Owner buka dashboard',
    p: 'Revenue hari ini, minggu ini, bulan ini. Top service, performa staff, funnel '
      + 'booking, dan produk yang perlu dipesan ulang.',
    facts: ['rekap komisi siap payroll', 'export CSV', 'semua angka per cabang'],
  },
]

const SPEC: [string, string][] = [
  ['Online booking', 'Alur penuh: halaman publik, pilih slot, konfirmasi. Anti double-booking di level database.'],
  ['Kasir / POS', 'Dari booking atau walk-in. Service dan produk satu keranjang, diskon per item dan per nota, struk siap cetak.'],
  ['Komisi staff', 'Aturan persen atau nominal, per service per staff. Dibuat otomatis tiap transaksi selesai.'],
  ['Inventory & stok', 'Produk retail dan pemakaian internal. Ledger masuk/keluar dengan waktu dan pelaku. Ambang stok menipis per produk.'],
  ['Notifikasi WhatsApp', 'Notification Center menampilkan isi pesan yang akan dikirim, template bisa diedit admin. Belum dikirim ke nomor sungguhan.'],
  ['Reports & analytics', 'Revenue, top 5 service, performa staff, funnel booking. Filter tanggal, export CSV.'],
  ['Member database', 'Profil otomatis dari nomor WhatsApp. Riwayat kunjungan, total belanja, poin, catatan formula warna dan alergi.'],
  ['Multi-cabang', 'branch_id di semua entitas inti. Stok per cabang. Front desk terkunci di cabangnya sendiri.'],
  ['Payroll recap', 'Gaji pokok + komisi + tunjangan − potongan, per staff per bulan. Angka kotor, export CSV.'],
  ['Pencatatan pembayaran', 'Cash, Transfer, QRIS, Debit/Credit. Dicatat lewat adapter ManualPayment — Midtrans atau Xendit masuk lewat interface yang sama.'],
]

const GAPS = [
  'Aplikasi mobile native',
  'Kirim WhatsApp ke nomor sungguhan',
  'Payment gateway live',
  'Absensi & cuti',
  'BPJS / PPh21',
  'Redemption poin',
  'Dashboard lintas cabang',
  'Transfer stok antar cabang',
  'Reschedule drag-and-drop',
]

export default function Home() {
  return (
    <>
      <a href="#isi" className="skip">Lompat ke isi</a>

      {/* N5 · floating pill */}
      <nav className="nav" aria-label="Utama">
        <span className="nav__mark">Jelita</span>
        <div className="nav__links">
          <a href="#alur">Alur</a>
          <a href="#rinci">Rinci</a>
          <a href="#batas">Batas</a>
        </div>
        <a className="btn btn--primary btn--sm" href={DEMO_URL}>Coba demo</a>
      </nav>

      <main id="isi" className="shell">
        {/* H2 · split diptych — the product is in the fold, not a promise about it */}
        <section className="hero">
          <div>
            <h1>Booking penuh. Komisi beres. Stok aman.</h1>
            <p className="lede hero__lede">
              Empat catatan yang biasanya hidup di buku tulis, chat, dan spreadsheet
              yang berbeda. Jelita menyatukannya — per cabang, per staff, per hari.
            </p>
            <div className="hero__cta">
              <a className="btn btn--primary" href={DEMO_URL}>Coba demo</a>
              <a className="btn btn--ghost" href={WA_URL}>Tanya via WhatsApp</a>
            </div>
            <p className="hero__note">Terbuka tanpa login. Tanpa jadwal meeting dulu.</p>
          </div>
          <figure className="shot">
            <Image
              src="/shots/bookings.png" alt="Daftar janji temu Jelita untuk satu hari di satu cabang, dengan jam, pelanggan, layanan, staf, dan statusnya."
              width={1280} height={720} priority
            />
            <figcaption>
              Satu hari di satu cabang. Slot bentrok ditolak di database — dua orang
              klik slot yang sama, tepat satu berhasil.
            </figcaption>
          </figure>
        </section>

        <section aria-labelledby="isi-demo">
          <p className="kicker" id="isi-demo">Isi demo — bukan angka pelanggan</p>
          <div className="counts">
            {COUNTS.map(([n, label]) => (
              <div key={label}>
                <span
                  className="count__n tnum"
                  style={{ '--to': n } as React.CSSProperties}
                  aria-label={`${n} ${label}`}
                />
                <span className="count__l">{label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* F5 · the tour. Real captures, alternating side. */}
        <section className="section" id="fitur">
          <div className="head">
            <p className="kicker">Isinya</p>
            <h2>Delapan hal yang berhenti dikerjakan manual.</h2>
          </div>
          <div className="tour">
            {TOUR.map((t, i) => (
              <div
                key={t.src}
                className={`tour__row${i % 2 === 1 ? ' tour__row--flip' : ''}`}
              >
                <div className="tour__text">
                  <h3>{t.h}</h3>
                  <p>{t.p}</p>
                  <ul className="claims">
                    {t.claims.map((c) => <li key={c}><span>{c}</span></li>)}
                  </ul>
                </div>
                <figure className="shot">
                  <Image src={t.src} alt={t.alt} width={1280} height={720} />
                  <figcaption>{t.cap}</figcaption>
                </figure>
              </div>
            ))}
          </div>

          {/* C4 · sticky bottom bar — after the third capture, once context is built */}
          <aside className="stickybar">
            <p>Semua yang di atas jalan di demo, dengan data contoh.</p>
            <a className="btn btn--primary btn--sm" href={DEMO_URL}>Buka demo</a>
          </aside>
        </section>

        {/* F4 · step sequence */}
        <section className="section" id="alur">
          <div className="head">
            <p className="kicker">Alur</p>
            <h2>Tiga momen dalam satu hari kerja.</h2>
          </div>
          <div className="steps">
            {STEPS.map((s) => (
              <article className="step" key={s.n}>
                <p className="step__n tnum">{s.n}</p>
                <div>
                  <h3>{s.h}</h3>
                  <p>{s.p}</p>
                  <ul className="step__facts">
                    {s.facts.map((f) => <li key={f}>{f}</li>)}
                  </ul>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* F3 · tabular spec sheet */}
        <section className="section" id="rinci">
          <div className="head">
            <p className="kicker">Rinci</p>
            <h2>Sedalam apa tiap bagian benar-benar jalan.</h2>
            <p className="lede">Ditulis apa adanya. Kalau ada yang cuma setengah jadi, tertulis setengah jadi.</p>
          </div>
          <table className="spec">
            <tbody>
              {SPEC.map(([k, v]) => (
                <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* The designed exception: the deadpan aside, kept from the Hum design */}
        <section className="section" id="batas">
          <div className="panel">
            <div className="head" style={{ marginBlockEnd: 'var(--space-md)' }}>
              <h2>Yang belum ada.</h2>
              <p className="lede">
                Halaman produk biasanya diam soal ini. Kami tulis duluan karena lebih
                murah Anda baca sekarang daripada ketemu pas demo.
              </p>
            </div>
            <ul className="gaps">
              {GAPS.map((g) => <li key={g}>{g}</li>)}
            </ul>
          </div>
        </section>

        {/* Ft2 · inline rule */}
        <footer className="foot">
          <span className="foot__mark">Jelita</span>
          <span>Sistem manajemen salon. Produk Arktik.</span>
          <span className="foot__end">
            <a href={WA_URL}>WhatsApp</a> · © 2026
          </span>
        </footer>
      </main>
    </>
  )
}
