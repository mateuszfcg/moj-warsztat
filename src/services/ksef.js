const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db');

class KsefService {
  get mode() { return config.ksef.mode; }

  status() {
    return {
      mode: this.mode,
      configured: this.mode === 'mock' || Boolean(config.ksef.nip && config.ksef.certPath),
      productionReady: false,
      message: this.mode === 'mock'
        ? 'Tryb symulacyjny: pozwala testować kolejkę i statusy bez skutków prawnych.'
        : 'Adapter produkcyjny wymaga podpięcia certyfikatu i oficjalnego klienta KSeF API 2.0.'
    };
  }

  queueInvoice(invoiceId) {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new Error('Nie znaleziono faktury.');
    if (this.mode === 'disabled') throw new Error('KSeF jest wyłączony w konfiguracji.');
    const result = db.prepare(`INSERT INTO ksef_jobs (invoice_id, direction, status) VALUES (?, 'send', 'queued')`).run(invoiceId);
    db.prepare(`UPDATE invoices SET ksef_status = 'queued' WHERE id = ?`).run(invoiceId);
    return Number(result.lastInsertRowid);
  }

  processQueued() {
    const jobs = db.prepare(`SELECT * FROM ksef_jobs WHERE status = 'queued' ORDER BY id LIMIT 20`).all();
    const processed = [];
    for (const job of jobs) {
      if (this.mode !== 'mock') {
        const error = 'Tryb demo/production nie został jeszcze aktywowany w tej wersji. Nie wysłano dokumentu.';
        db.prepare(`UPDATE ksef_jobs SET status='blocked', error=?, processed_at=CURRENT_TIMESTAMP WHERE id=?`).run(error, job.id);
        db.prepare(`UPDATE invoices SET ksef_status='blocked' WHERE id=?`).run(job.invoice_id);
        processed.push({ id: job.id, status: 'blocked' });
        continue;
      }
      const reference = `MOCK-${crypto.randomUUID()}`;
      const ksefNumber = `${config.ksef.nip || '0000000000'}-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${String(job.invoice_id).padStart(6,'0')}-MOCK`;
      const response = { reference, ksefNumber, mock: true, acceptedAt: new Date().toISOString() };
      db.prepare(`UPDATE ksef_jobs SET status='accepted', reference=?, response_json=?, processed_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(reference, JSON.stringify(response), job.id);
      db.prepare(`UPDATE invoices SET ksef_status='accepted_mock', ksef_reference=?, ksef_number=? WHERE id=?`)
        .run(reference, ksefNumber, job.invoice_id);
      processed.push({ id: job.id, status: 'accepted', reference });
    }
    return processed;
  }
}

module.exports = new KsefService();
