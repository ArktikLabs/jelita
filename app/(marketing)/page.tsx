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
    cap: 'Kasir — booking hari itu, ditambah satu produk dari rak.',
    h: 'Sekali bayar, empat catatan ikut beres',
    p: 'Booking ditutup, stok berkurang, komisi staf tercatat, poin pelanggan '
      + 'bertambah. Tidak ada yang perlu diingat belakangan.',
    claims: [
      'Komisi tercatat saat transaksi selesai, bukan dihitung ulang tiap akhir bulan',
      'Persen atau nominal, dan boleh beda tiap layanan dan tiap staf',
      'Pelanggan lama dikenali dari nomor WhatsApp-nya',
      'Struk yang sudah selesai tidak bisa diam-diam diubah — pembatalan tercatat sebagai pembatalan',
    ],
  },
  {
    src: '/shots/dashboard.png',
    alt: 'Dasbor pemilik Jelita: omzet, jumlah janji temu, tingkat penyelesaian, '
      + 'grafik omzet harian, dan layanan teratas.',
    cap: 'Dasbor — tujuh hari terakhir, satu cabang.',
    h: 'Tahu kondisi salon tanpa harus ada di salon',
    p: 'Omzet hari ini, layanan yang paling laku, performa tiap staf, dan berapa '
      + 'banyak yang tidak jadi datang. Semuanya mengikuti cabang yang sedang dibuka.',
    claims: [
      'Kasir hanya melihat cabangnya sendiri',
      'Buka cabang kedua tanpa menyiapkan sistem baru',
      'Staf melihat dasbor yang sama, tapi hanya soal dirinya',
      'Angka mana pun bisa diunduh ke Excel',
    ],
  },
  {
    src: '/shots/notifications.png',
    alt: 'Notification Center Jelita: daftar pesan WhatsApp yang akan dikirim, '
      + 'lengkap dengan isi pesan dan statusnya.',
    cap: 'Daftar pesan — persis kalimat yang akan sampai ke pelanggan.',
    h: 'Pelanggan diingatkan tanpa Anda mengetik satu pesan pun',
    p: 'Konfirmasi begitu booking masuk, pengingat sehari sebelum, pengingat dua jam '
      + 'sebelum, dan ucapan terima kasih setelah pulang. Kalimatnya bisa Anda ubah sendiri.',
    claims: [
      'Anda bisa baca dulu setiap pesan sebelum keluar',
      'Booking yang batal ikut membatalkan pengingatnya',
      'Kalimatnya diatur sekali, dipakai untuk semua pelanggan',
    ],
  },
]

const STEPS = [
  {
    n: '1',
    h: 'Malam sebelumnya — pelanggan pesan sendiri',
    p: 'Pelanggan memilih cabang, layanan, staf, lalu jam. Yang muncul hanya jam yang '
      + 'benar-benar kosong — dihitung dari jadwal staf, lama layanan, dan booking yang sudah ada.',
    facts: ['jam yang sama tidak bisa dipesan dua kali', 'layanan 90 menit ikut mengunci jam sesudahnya', 'konfirmasi langsung disiapkan'],
  },
  {
    n: '2',
    h: 'Siang — selesai dilayani, langsung bayar',
    p: 'Buka booking hari itu, tambahkan produk kalau ada, cari pelanggan lewat nomor '
      + 'WhatsApp, pilih cara bayar, cetak struk.',
    facts: ['komisi langsung tercatat', 'stok berkurang sendiri', 'poin pelanggan bertambah', 'struk terkunci setelah selesai'],
  },
  {
    n: '3',
    h: 'Tutup toko — Anda buka laporannya',
    p: 'Omzet hari ini, minggu ini, bulan ini. Layanan terlaris, performa tiap staf, '
      + 'dan produk yang sudah perlu dipesan lagi.',
    facts: ['rekap komisi siap untuk gajian', 'bisa diunduh ke Excel', 'semua angka per cabang'],
  },
]

const SPEC: [string, string][] = [
  ['Booking online', 'Halaman booking sendiri untuk pelanggan, tanpa perlu aplikasi. Jam yang sama tidak bisa dipesan dua kali — dijaga sistem, bukan diingat orang.'],
  ['Kasir', 'Dari booking atau dari pelanggan yang langsung datang. Layanan dan produk dalam satu nota, diskon per item atau per nota, struk siap cetak.'],
  ['Komisi staf', 'Persen atau nominal, boleh beda tiap layanan dan tiap staf. Tercatat sendiri setiap transaksi selesai, tidak dihitung ulang di akhir bulan.'],
  ['Stok', 'Produk yang dijual dan yang dipakai sendiri. Setiap barang masuk dan keluar tercatat: kapan, berapa, oleh siapa. Ada peringatan sebelum habis.'],
  ['Pengingat WhatsApp', 'Pesan disiapkan otomatis dan bisa Anda baca sebelum keluar. Kalimatnya bisa diubah kapan saja.'],
  ['Laporan', 'Omzet, lima layanan terlaris, performa staf, dan berapa yang tidak jadi datang. Bisa disaring per tanggal dan diunduh ke Excel.'],
  ['Data pelanggan', 'Profil terbentuk sendiri dari nomor WhatsApp. Riwayat kunjungan, total belanja, poin, dan catatan seperti formula warna atau alergi.'],
  ['Banyak cabang', 'Setiap catatan tahu miliknya cabang mana. Stok dihitung per cabang, dan kasir hanya melihat cabangnya sendiri.'],
  ['Rekap gaji', 'Gaji pokok + komisi + tunjangan − potongan, per staf per bulan. Masih angka kotor — pajak belum dihitung. Bisa diunduh.'],
  ['Cara bayar', 'Tunai, transfer, QRIS, dan kartu, semuanya tercatat. Payment gateway bisa disambungkan nanti tanpa mengubah cara kasir bekerja.'],
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
              Buku booking, catatan kas, hitungan komisi, dan stok — biasanya empat
              tempat yang berbeda, dan cuma Anda yang tahu semuanya. Di sini satu
              tempat, dan saling tahu.
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
              Satu hari, satu cabang. Kalau dua orang memesan jam yang sama, yang
              kedua ditolak — bukan karena resepsionis ingat, tapi karena sistemnya
              memang tidak mengizinkan.
            </figcaption>
          </figure>
        </section>

        <section aria-labelledby="isi-demo">
          {/* Says these are the demo's own contents without wearing a
              disclaimer: "salon contoh" is what makes it honest, and it reads
              like a caption instead of a compliance note. */}
          <p className="kicker" id="isi-demo">Salon contoh di dalam demo</p>
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
            <p>Semua yang di atas bisa Anda coba sendiri, dengan data contoh.</p>
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
            <h2>Apa saja yang sudah bisa dipakai hari ini.</h2>
          </div>
          <table className="spec">
            <tbody>
              {SPEC.map(([k, v]) => (
                <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* The designed exception, kept from the Hum build: the deadpan aside.
            Prose, not a chip register -- a list of nine unbuilt features is a
            backlog, and a backlog on a product page reads as an internal
            document no matter how honest it is. */}
        <section className="section" id="batas">
          <div className="panel">
            <div className="head" style={{ marginBlockEnd: 0 }}>
              <h2>Belum semuanya ada.</h2>
              <p className="lede">
                Absensi dan hitungan pajak, aplikasi mobile, pembayaran online, tukar
                poin, dan beberapa hal lintas cabang belum kami kerjakan. Pengingat
                WhatsApp pun baru berjalan di dalam sistem — isinya sudah tersusun,
                tapi belum benar-benar terkirim ke nomor pelanggan.
              </p>
              <p className="lede">
                Kalau justru itu yang paling Anda butuhkan sekarang, lebih baik kita
                bicara dulu daripada Anda pindah lalu kecewa.
              </p>
            </div>
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
