const { db } = require('../db');
const { getSettings } = require('../settings');

const TYPES = {
  work_order: { table: 'work_orders', where: '', args: [], prefix: 'ZL', pattern: 'ZL/{YYYY}/{NNNN}', reset: 'year' },
  invoice: { table: 'invoices', where: "WHERE document_type='invoice'", args: [], prefix: 'FV', pattern: 'FV/{YYYY}/{NNNN}', reset: 'year' },
  correction: { table: 'invoices', where: "WHERE document_type='correction'", args: [], prefix: 'KOR', pattern: 'KOR/{YYYY}/{NNNN}', reset: 'year' },
  invoice_receipt: { table: 'invoices', where: "WHERE document_type='invoice_receipt'", args: [], prefix: 'FVP', pattern: 'FVP/{YYYY}/{NNNN}', reset: 'year' },
  protocol_intake: { table: 'protocols', where: "WHERE type='intake'", args: [], prefix: 'PP', pattern: 'PP/{YYYY}/{NNNN}', reset: 'year' },
  protocol_release: { table: 'protocols', where: "WHERE type='release'", args: [], prefix: 'PW', pattern: 'PW/{YYYY}/{NNNN}', reset: 'year' },
  protocol_additional_costs: { table: 'protocols', where: "WHERE type='additional_costs'", args: [], prefix: 'PDK', pattern: 'PDK/{YYYY}/{NNNN}', reset: 'year' },
  purchase_wz: { table: 'purchase_documents', where: "WHERE lower(type)='wz'", args: [], prefix: 'WZ', pattern: 'WZ/{YYYY}/{NNNN}', reset: 'year' },
  purchase_pz: { table: 'purchase_documents', where: "WHERE lower(type)='pz'", args: [], prefix: 'PZ', pattern: 'PZ/{YYYY}/{NNNN}', reset: 'year' }
};

function safePattern(value, fallback) {
  const pattern = String(value || '').trim();
  if (!pattern || pattern.length > 100) return fallback;
  return pattern.replace(/[\r\n\t]/g, ' ');
}

function periodKey(reset, date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  if (reset === 'month') return `${yyyy}-${mm}`;
  if (reset === 'none') return 'all';
  return yyyy;
}

function formatPattern(pattern, prefix, sequence, date) {
  const yyyy = String(date.getFullYear());
  const yy = yyyy.slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return pattern
    .replaceAll('{PREFIX}', prefix)
    .replaceAll('{YYYY}', yyyy)
    .replaceAll('{YY}', yy)
    .replaceAll('{MM}', mm)
    .replaceAll('{DD}', dd)
    .replaceAll('{NNNN}', String(sequence).padStart(4, '0'))
    .replaceAll('{NNN}', String(sequence).padStart(3, '0'))
    .replaceAll('{NN}', String(sequence).padStart(2, '0'))
    .replaceAll('{N}', String(sequence));
}

function currentBaseline(definition) {
  const row = db.prepare(`SELECT COALESCE(MAX(id),0) value FROM ${definition.table} ${definition.where}`).get(...definition.args);
  return Number(row?.value || 0);
}

function nextDocumentNumber(type, options = {}) {
  const definition = TYPES[type];
  if (!definition) throw new Error(`Nieobsługiwany typ numeracji: ${type}`);
  const settings = getSettings();
  const date = options.date ? new Date(options.date) : new Date();
  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const pattern = safePattern(settings[`number_pattern_${type}`], definition.pattern);
  const reset = ['year', 'month', 'none'].includes(settings[`number_reset_${type}`]) ? settings[`number_reset_${type}`] : definition.reset;
  const prefix = String(settings[`number_prefix_${type}`] || definition.prefix).trim() || definition.prefix;
  const period = periodKey(reset, validDate);
  const key = `${type}:${period}`;

  const existing = db.prepare('SELECT last_value FROM document_sequences WHERE key=?').get(key);
  let sequence;
  if (existing) {
    sequence = Number(existing.last_value) + 1;
    db.prepare('UPDATE document_sequences SET last_value=?,updated_at=CURRENT_TIMESTAMP WHERE key=?').run(sequence, key);
  } else {
    const hadSequence = db.prepare('SELECT 1 ok FROM document_sequences WHERE document_type=? LIMIT 1').get(type);
    // Przy pierwszym uruchomieniu po aktualizacji kontynuujemy po istniejących danych.
    // Przy wejściu w nowy miesiąc/rok zaczynamy od 1 zgodnie z ustawieniem zerowania.
    sequence = hadSequence ? 1 : currentBaseline(definition) + 1;
    db.prepare('INSERT INTO document_sequences (key,document_type,period_key,last_value) VALUES (?,?,?,?)').run(key, type, period, sequence);
  }
  return formatPattern(pattern, prefix, sequence, validDate);
}

function numberingPreview(type, sequence = 1, date = new Date()) {
  const definition = TYPES[type];
  if (!definition) return '';
  const settings = getSettings();
  const pattern = safePattern(settings[`number_pattern_${type}`], definition.pattern);
  const prefix = String(settings[`number_prefix_${type}`] || definition.prefix).trim() || definition.prefix;
  return formatPattern(pattern, prefix, sequence, date);
}

module.exports = { TYPES, nextDocumentNumber, numberingPreview, formatPattern };
