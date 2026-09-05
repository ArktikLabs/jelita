/* The live demo. Was demo.arktik.id when this was designed; the demo is
   deployed here now. Env-driven so it follows a custom domain later without
   a code change. */
const DEMO_URL = process.env.NEXT_PUBLIC_DEMO_URL
  ?? "https://jelita-six.vercel.app/salon/ovarya";
/* PLACEHOLDER. Set NEXT_PUBLIC_WA_NUMBER to a real number before this page is
   shown to anyone -- a "Tanya via WhatsApp" button that reaches nobody is
   worse than no button. */
const WA_URL = `https://wa.me/${process.env.NEXT_PUBLIC_WA_NUMBER ?? "6281234567890"}`;

/* Demo seed figures, straight from the spec's §8. Labelled as demo contents —
   never dressed up as customer or performance numbers. */
/* The seeded demo's actual contents, checked against scripts/seed-demo.ts --
   8 staff since the second branch needed its own front desk. */
const COUNTS: [number, string][] = [
  [2, "cabang"],
  [15, "service"],
  [8, "staff"],
  [40, "customer"],
];

const BOARD: [string, string, string, string, string][] = [
  ["09:00", "Rina", "Creambath", "selesai", "mint"],
  ["10:00", "Sinta", "Smoothing · 90m", "jalan", "pear"],
  ["13:30", "Dewi", "Hair Spa", "menunggu", "wait"],
  ["15:00", "Putri", "Gel Nails", "menunggu", "wait"],
];

const STEPS = [
  {
    n: "1",
    hue: "var(--color-cyan)",
    h: "Customer booking sendiri",
    p: "Pilih cabang, service, staff, lalu slot. Ketersediaan dihitung dari jam kerja staff, durasi service, dan booking yang sudah ada.",
    facts: ["slot bentrok ditolak di database", "90 menit mengunci slot berikutnya", "konfirmasi masuk antrean"],
  },
  {
    n: "2",
    hue: "var(--color-pear-deep)",
    h: "Front desk checkout",
    p: "Buka booking hari ini, tambah produk retail, cari member lewat nomor WhatsApp, pilih metode bayar, cetak struk.",
    facts: ["komisi dibuat per baris", "stok berkurang otomatis", "poin member bertambah", "transaksi terkunci setelah selesai"],
  },
  {
    n: "3",
    hue: "var(--color-coral-deep)",
    h: "Owner buka dashboard",
    p: "Revenue hari ini, minggu ini, bulan ini. Top service, performa staff, funnel booking, dan produk yang perlu dipesan ulang.",
    facts: ["rekap komisi siap payroll", "export CSV", "semua angka per cabang"],
  },
];

const SPEC: [string, string][] = [
  ["Online booking", "Alur penuh: halaman publik, pilih slot, konfirmasi. Anti double-booking di level database."],
  ["Kasir / POS", "Dari booking atau walk-in. Service dan produk satu keranjang, diskon per item dan per nota, struk siap cetak."],
  ["Komisi staff", "Aturan persen atau nominal, per service per staff. Dibuat otomatis tiap transaksi selesai."],
  ["Inventory & stok", "Produk retail dan pemakaian internal. Ledger masuk/keluar dengan waktu dan pelaku. Ambang stok menipis per produk."],
  ["Notifikasi WhatsApp", "Notification Center menampilkan isi pesan yang akan dikirim, template bisa diedit admin. Belum dikirim ke nomor sungguhan."],
  ["Reports & analytics", "Revenue, top 5 service, performa staff, funnel booking. Filter tanggal, export CSV."],
  ["Member database", "Profil otomatis dari nomor WhatsApp. Riwayat kunjungan, total belanja, poin, catatan formula warna dan alergi."],
  ["Multi-cabang", "branch_id di semua entitas inti. Stok per cabang. Front desk terkunci di cabangnya sendiri."],
  ["Payroll recap", "Gaji pokok + komisi + tunjangan − potongan, per staff per bulan. Angka kotor, export CSV."],
  ["Pencatatan pembayaran", "Cash, Transfer, QRIS, Debit/Credit. Dicatat lewat adapter ManualPayment — Midtrans atau Xendit masuk lewat interface yang sama."],
];

const GAPS = [
  "Aplikasi mobile native",
  "Kirim WhatsApp ke nomor sungguhan",
  "Payment gateway live",
  "Absensi & cuti",
  "BPJS / PPh21",
  "Redemption poin",
  "Dashboard lintas cabang",
  "Transfer stok antar cabang",
  "Reschedule drag-and-drop",
];

const MARQUEE = "Booking ✱ Kasir ✱ Komisi ✱ Stok ✱ Member ✱ Payroll ✱ Multi-cabang ✱ Laporan ✱ ";

export default function Home() {
  return (
    <>
      <a className="skip" href="#main">Lompat ke konten</a>

      <header className="nav">
        <div className="nav__inner">
          <a className="nav__brand" href="#main">Jelita</a>
          <nav className="nav__links" aria-label="Bagian halaman">
            <a className="nav__link" href="#fitur">Fitur</a>
            <a className="nav__link" href="#alur">Alur</a>
            <a className="nav__link" href="#rinci">Rinci</a>
            <a className="nav__link" href="#batas">Batas</a>
          </nav>
          <a className="btn btn--soft nav__hide-xs" href={WA_URL}>WhatsApp</a>
          <a className="btn btn--push" href={DEMO_URL}>Coba demo</a>
        </div>
      </header>

      <main id="main">
        <section className="section hero">
          <div>
            <h1 className="hero__display">Booking penuh. Komisi beres. Stok aman.</h1>
            <p className="hero__lede">
              Empat catatan yang biasanya hidup di buku tulis, chat, dan spreadsheet yang
              berbeda. Jelita menyatukannya — per cabang, per staff, per hari.
            </p>
            <div className="hero__actions">
              <a className="btn btn--push" href={DEMO_URL}>
                Coba demo <span className="btn__arrow" aria-hidden="true">→</span>
              </a>
              <a className="btn btn--soft" href={WA_URL}>Tanya via WhatsApp</a>
            </div>
            <p className="hero__note">Terbuka tanpa login. Tanpa jadwal meeting dulu.</p>
          </div>

          {/* Tier A artefact — today's board, drawn in CSS. No fake browser chrome. */}
          <div className="board">
            <span className="mark" aria-hidden="true"><span className="mark__smile" /></span>
            <div className="board__head">
              <span className="lbl">Hari ini · Kemang</span>
              <span className="board__time tnum">4 booking</span>
            </div>
            {BOARD.map(([time, who, svc, tag, pip]) => (
              <div className="board__row" key={time}>
                <span
                  className="board__pip"
                  style={{ "--pip": pip === "wait" ? "var(--color-lav)" : `var(--color-${pip})` } as React.CSSProperties}
                  aria-hidden="true"
                />
                <span>
                  <span className="board__who">{who}</span>{" "}
                  <span className="board__svc">{svc}</span>
                </span>
                <span className={`board__tag${tag === "menunggu" ? " board__tag--wait" : ""}`}>{tag}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 4 · counters — honest: this is what's inside the demo, not a claim */}
        <section className="band band--pear">
          <div className="section">
            <p className="lbl">Isi demo — bukan angka pelanggan</p>
            <div className="counts" style={{ marginBlockStart: "var(--space-lg)" }}>
              {COUNTS.map(([n, label]) => (
                <div key={label}>
                  <span
                    className="count__n"
                    style={{ "--to": n } as React.CSSProperties}
                    aria-label={`${n} ${label}`}
                  />
                  <span className="count__l">{label}</span>
                </div>
              ))}
              <div>
                <span className="count__n" style={{ "--to": 3 } as React.CSSProperties} aria-label="3 minggu" />
                <span className="count__l">minggu transaksi</span>
              </div>
            </div>
          </div>
        </section>

        {/* 3 · bento — eight tiles, each owning one accent */}
        <section className="section" id="fitur">
          <h2 style={{ fontSize: "var(--text-2xl)", maxWidth: "20ch" }}>
            Delapan hal yang <span className="hl">berhenti dikerjakan manual</span>.
          </h2>
          <div className="bento" style={{ marginBlockStart: "var(--space-xl)" }}>
            <article className="tile tile--hero">
              <p className="tile__k">01 · Booking</p>
              <h3 className="tile__h">Slot bentrok ditolak, bukan disembunyikan</h3>
              <p className="tile__p">
                Ketersediaan dihitung dari jam kerja, durasi service, dan booking berjalan.
                Dua orang klik slot yang sama — tepat satu berhasil.
              </p>
              <div className="slots">
                <span className="slot">09:00</span>
                <span className="slot">09:30</span>
                <span className="slot slot--taken">10:00</span>
                <span className="slot slot--blocked">10:30</span>
                <span className="slot slot--blocked">11:00</span>
                <span className="slot">11:30</span>
                <span className="slot">13:00</span>
              </div>
            </article>

            <article className="tile tile--cyan">
              <p className="tile__k">02 · Kasir</p>
              <h3 className="tile__h">Checkout menutup empat hal sekaligus</h3>
              <p className="tile__p">
                Booking selesai, stok turun, komisi dibuat, poin member naik. Satu tekan.
              </p>
            </article>

            <article className="tile tile--coral">
              <p className="tile__k">03 · Komisi</p>
              <h3 className="tile__h">Tidak dihitung ulang tiap akhir bulan</h3>
              <div className="mini">
                <div className="mini__r"><span>Sinta</span><b>4.180.000</b></div>
                <div className="mini__r"><span>Rani</span><b>3.640.000</b></div>
                <div className="mini__r"><span>Dewi</span><b>2.910.000</b></div>
              </div>
            </article>

            <article className="tile tile--mint">
              <p className="tile__k">04 · Stok</p>
              <h3 className="tile__h">Tahu siapa yang ambil, dan kapan</h3>
              <p className="tile__p">Ledger masuk/keluar per cabang, plus alert sebelum habis.</p>
            </article>

            <article className="tile tile--lav">
              <p className="tile__k">05 · Member</p>
              <h3 className="tile__h">Dikenali dari nomor WhatsApp</h3>
              <p className="tile__p">Riwayat, total belanja, poin, catatan formula warna dan alergi.</p>
            </article>

            <article className="tile tile--wide">
              <p className="tile__k">06 · Multi-cabang</p>
              <h3 className="tile__h">Cabang kedua = satu baris di settings</h3>
              <p className="tile__p">
                branch_id ada di semua entitas sejak hari pertama, dan scoping dikerjakan di
                middleware — bukan ditambal per endpoint.
              </p>
            </article>

            <article className="tile tile--wide tile--cyan">
              <p className="tile__k">07 · Notifikasi</p>
              <h3 className="tile__h">Pipeline-nya sudah jalan, kredensialnya belum</h3>
              <p className="tile__p">
                Pesan berhenti di Notification Center dengan isi dan status aslinya. Go-live
                ke Fonnte, Wablas, atau Meta API adalah tukar kredensial.
              </p>
            </article>

            <article className="tile tile--full tile--coral">
              <div>
                <p className="tile__k">08 · Laporan</p>
                <h3 className="tile__h">Revenue, top service, funnel, no-show</h3>
              </div>
              <p className="tile__p">
                Filter tanggal, export CSV, semuanya di-scope ke cabang yang sedang dipilih.
                No-show akhirnya jadi angka yang bisa diperbaiki, bukan cerita.
              </p>
            </article>
          </div>
        </section>

        {/* the rail — off-grid moment: the numerals break the gutter */}
        <section className="section" id="alur">
          <h2 style={{ fontSize: "var(--text-2xl)", maxWidth: "22ch", marginBlockEnd: "var(--space-xl)" }}>
            Tiga momen dalam satu hari kerja.
          </h2>
          <div className="rail">
            {STEPS.map((s) => (
              <article className="step" key={s.n}>
                <p className="step__n" style={{ "--n": s.hue } as React.CSSProperties}>{s.n}</p>
                <div>
                  <h3 className="step__h">{s.h}</h3>
                  <p className="step__p">{s.p}</p>
                  <ul className="step__facts">
                    {s.facts.map((f) => (
                      <li className="step__fact" key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* the one deliberately dense section */}
        <section className="section" id="rinci">
          <h2 style={{ fontSize: "var(--text-2xl)", maxWidth: "24ch" }}>
            Sedalam apa tiap bagian benar-benar jalan.
          </h2>
          <p style={{ marginBlock: "var(--space-md) var(--space-xl)", maxWidth: "48ch", color: "var(--color-muted)" }}>
            Ditulis apa adanya. Kalau ada yang cuma setengah jadi, tertulis setengah jadi.
          </p>
          <dl className="spec">
            {SPEC.map(([n, d]) => (
              <div className="spec__row" key={n}>
                <dt className="spec__n">{n}</dt>
                <dd className="spec__d">{d}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="band band--cyan" id="batas">
          <div className="section">
            <div className="gaps">
              <div>
                <h2 style={{ fontSize: "var(--text-xl)", maxWidth: "14ch" }}>Yang belum ada.</h2>
                <div className="aside">
                  Halaman produk biasanya diam soal ini. Kami tulis duluan karena{" "}
                  <b>lebih murah Anda baca sekarang daripada ketemu pas demo</b>.
                </div>
              </div>
              <ul className="gaps__list">
                {GAPS.map((g) => (
                  <li className="gaps__item" key={g}>{g}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="band band--coral">
          <div className="section close">
            <h2>Jangan percaya halaman ini. Buka demo-nya.</h2>
            <p>
              Booking, checkout, dan rekap di atas bisa dicoba sendiri dengan data contoh.
            </p>
            <a className="btn btn--push btn--coral" href={DEMO_URL}>
              Coba demo <span className="btn__arrow" aria-hidden="true">→</span>
            </a>
            <p className="close__aside">
              Engine yang sama jalan untuk barbershop, spa, dan klinik kecantikan. Nama,
              logo, warna, dan mata uang diatur dari settings.
            </p>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="marquee" aria-hidden="true">
          <div className="marquee__track">{MARQUEE.repeat(3)}</div>
          <div className="marquee__track">{MARQUEE.repeat(3)}</div>
        </div>
        <div className="foot__inner">
          <span className="foot__brand">Jelita</span>
          <span className="foot__tag">Sistem manajemen salon. Produk Arktik.</span>
          <a className="foot__link" href="https://arktik.id">arktik.id</a>
          <a className="foot__link" href={WA_URL}>WhatsApp</a>
          <span className="lbl">© 2026</span>
        </div>
      </footer>
    </>
  );
}
