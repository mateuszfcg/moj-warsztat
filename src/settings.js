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
  protocol_show_gross_total: '1',
  default_payment_days: '7',
  autodata_enabled: '0',
  tecrmi_enabled: '0',
  autodata_api_url: '',
  tecrmi_api_url: '',
  update_check_url: '',
  update_command: '',
  document_font_family: 'dejavu',
  document_logo_x: '45',
  document_logo_y: '57',
  document_logo_width: '105',
  document_logo_height: '48',
  document_title_x: '290',
  document_title_y: '58',
  document_title_width: '260',
  document_seller_x: '45',
  document_seller_y: '116',
  document_seller_width: '247',
  document_seller_height: '88',
  document_buyer_x: '303',
  document_buyer_y: '116',
  document_buyer_width: '247',
  document_buyer_height: '88',
  document_meta_x: '45',
  document_meta_y: '220',
  document_meta_width: '250',
  document_bank_x: '303',
  document_bank_y: '220',
  document_bank_width: '247',
  document_table_y: '286',
  document_custom_fields_json: '[]',
  number_pattern_work_order: 'ZL/{YYYY}/{NNNN}', number_reset_work_order: 'year', number_prefix_work_order: 'ZL',
  number_pattern_invoice: 'FV/{YYYY}/{NNNN}', number_reset_invoice: 'year', number_prefix_invoice: 'FV',
  number_pattern_correction: 'KOR/{YYYY}/{NNNN}', number_reset_correction: 'year', number_prefix_correction: 'KOR',
  number_pattern_invoice_receipt: 'FVP/{YYYY}/{NNNN}', number_reset_invoice_receipt: 'year', number_prefix_invoice_receipt: 'FVP',
  number_pattern_protocol_intake: 'PP/{YYYY}/{NNNN}', number_reset_protocol_intake: 'year', number_prefix_protocol_intake: 'PP',
  number_pattern_protocol_release: 'PW/{YYYY}/{NNNN}', number_reset_protocol_release: 'year', number_prefix_protocol_release: 'PW',
  number_pattern_protocol_additional_costs: 'PDK/{YYYY}/{NNNN}', number_reset_protocol_additional_costs: 'year', number_prefix_protocol_additional_costs: 'PDK',
  number_pattern_purchase_wz: 'WZ/{YYYY}/{NNNN}', number_reset_purchase_wz: 'year', number_prefix_purchase_wz: 'WZ',
  number_pattern_purchase_pz: 'PZ/{YYYY}/{NNNN}', number_reset_purchase_pz: 'year', number_prefix_purchase_pz: 'PZ'
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
    default_payment_days: Number(raw.default_payment_days || 7),
    document_font_size: Number(raw.document_font_size || 9),
    document_logo_x: Number(raw.document_logo_x || 45), document_logo_y: Number(raw.document_logo_y || 57),
    document_logo_width: Number(raw.document_logo_width || 105), document_logo_height: Number(raw.document_logo_height || 48),
    document_title_x: Number(raw.document_title_x || 290), document_title_y: Number(raw.document_title_y || 58), document_title_width: Number(raw.document_title_width || 260),
    document_seller_x: Number(raw.document_seller_x || 45), document_seller_y: Number(raw.document_seller_y || 116), document_seller_width: Number(raw.document_seller_width || 247), document_seller_height: Number(raw.document_seller_height || 88),
    document_buyer_x: Number(raw.document_buyer_x || 303), document_buyer_y: Number(raw.document_buyer_y || 116), document_buyer_width: Number(raw.document_buyer_width || 247), document_buyer_height: Number(raw.document_buyer_height || 88),
    document_meta_x: Number(raw.document_meta_x || 45), document_meta_y: Number(raw.document_meta_y || 220), document_meta_width: Number(raw.document_meta_width || 250),
    document_bank_x: Number(raw.document_bank_x || 303), document_bank_y: Number(raw.document_bank_y || 220), document_bank_width: Number(raw.document_bank_width || 247),
    document_table_y: Number(raw.document_table_y || 286),
    document_custom_fields: (() => { try { const value = JSON.parse(raw.document_custom_fields_json || '[]'); return Array.isArray(value) ? value : []; } catch (_) { return []; } })(),
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
    protocol_show_gross_total: asBool(raw.protocol_show_gross_total),
    autodata_enabled: asBool(raw.autodata_enabled),
    tecrmi_enabled: asBool(raw.tecrmi_enabled)
  };
}

function getDocumentSettings(documentType = 'invoice') {
  const base = getSettings();
  const row = db.prepare('SELECT config_json FROM document_templates WHERE document_type=?').get(documentType);
  if (!row) return base;
  try {
    const config = JSON.parse(row.config_json || '{}');
    const merged = { ...base, ...config };
    const booleanKeys = [
      'document_compact','document_show_logo','document_show_company_contact','document_show_bank_account',
      'invoice_show_lp','invoice_show_unit','invoice_show_net','invoice_show_vat_rate','invoice_show_vat_value','invoice_show_gross',
      'protocol_show_order_items','protocol_show_gross_total','intake_protocol_enabled','release_protocol_enabled'
    ];
    for (const key of booleanKeys) merged[key] = asBool(merged[key]);
    const numberKeys = [
      'document_font_size','document_logo_x','document_logo_y','document_logo_width','document_logo_height',
      'document_title_x','document_title_y','document_title_width','document_seller_x','document_seller_y','document_seller_width','document_seller_height',
      'document_buyer_x','document_buyer_y','document_buyer_width','document_buyer_height','document_meta_x','document_meta_y','document_meta_width',
      'document_bank_x','document_bank_y','document_bank_width','document_table_y'
    ];
    for (const key of numberKeys) merged[key] = Number(merged[key] || base[key] || 0);
    if (typeof merged.document_custom_fields_json === 'string') {
      try {
        const value = JSON.parse(merged.document_custom_fields_json || '[]');
        merged.document_custom_fields = Array.isArray(value) ? value : [];
      } catch (_) { merged.document_custom_fields = []; }
    }
    return merged;
  } catch (_) { return base; }
}

function saveSettings(values) {
  const statement = db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`);
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) statement.run(key, value == null ? '' : String(value));
  });
  tx(Object.entries(values));
}

module.exports = { DEFAULTS, getSettings, getDocumentSettings, saveSettings, asBool };
