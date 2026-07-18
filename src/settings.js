const { db } = require('./db');

const DEFAULTS = {
  labor_sale_rate_net: '200',
  labor_cost_rate_net: '80',
  labor_vat_rate: '23',
  default_price_mode: 'net',
  intake_protocol_enabled: '1',
  release_protocol_enabled: '1',
  document_accent_color: '#2563eb',
  document_table_header_color: '#e8eef5',
  document_table_text_color: '#25313c',
  document_font_size: '9',
  document_compact: '1',
  document_show_logo: '1',
  document_logo_path: '',
  document_show_company_contact: '1',
  document_show_bank_account: '1',
  document_bank_account: '',
  document_bank_name: '',
  invoice_show_lp: '1',
  invoice_show_unit: '1',
  invoice_show_net: '1',
  invoice_show_vat_rate: '1',
  invoice_show_vat_value: '1',
  invoice_show_gross: '1',
  invoice_footer: 'Dziękujemy za skorzystanie z usług naszego warsztatu.',
  protocol_footer: 'Dokument sporządzono w dwóch jednobrzmiących egzemplarzach.',
  protocol_show_order_items: '1',
  protocol_show_gross_total: '1'
};

function asBool(value) {
  return String(value) === '1' || String(value).toLowerCase() === 'true';
}

function getSettings() {
  const rows = db.prepare('SELECT key,value FROM app_settings').all();
  const raw = { ...DEFAULTS };
  for (const row of rows) raw[row.key] = row.value;
  return {
    ...raw,
    labor_sale_rate_net: Number(raw.labor_sale_rate_net || 0),
    labor_cost_rate_net: Number(raw.labor_cost_rate_net || 0),
    labor_vat_rate: Number(raw.labor_vat_rate || 23),
    document_font_size: Number(raw.document_font_size || 9),
    document_compact: asBool(raw.document_compact),
    document_show_logo: asBool(raw.document_show_logo),
    document_show_company_contact: asBool(raw.document_show_company_contact),
    document_show_bank_account: asBool(raw.document_show_bank_account),
    invoice_show_lp: asBool(raw.invoice_show_lp),
    invoice_show_unit: asBool(raw.invoice_show_unit),
    invoice_show_net: asBool(raw.invoice_show_net),
    invoice_show_vat_rate: asBool(raw.invoice_show_vat_rate),
    invoice_show_vat_value: asBool(raw.invoice_show_vat_value),
    invoice_show_gross: asBool(raw.invoice_show_gross),
    intake_protocol_enabled: asBool(raw.intake_protocol_enabled),
    release_protocol_enabled: asBool(raw.release_protocol_enabled),
    protocol_show_order_items: asBool(raw.protocol_show_order_items),
    protocol_show_gross_total: asBool(raw.protocol_show_gross_total)
  };
}

function saveSettings(values) {
  const statement = db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`);
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) statement.run(key, value == null ? '' : String(value));
  });
  tx(Object.entries(values));
}

module.exports = { DEFAULTS, getSettings, saveSettings, asBool };
