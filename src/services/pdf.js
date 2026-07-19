const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const config = require('../config');
const { db } = require('../db');
const { getDocumentSettings } = require('../settings');
const { lineTotals, sumItems, pln } = require('./money');
const { label } = require('../i18n');

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function setupFonts(doc, settings = {}) {
  const family = settings.document_font_family || 'dejavu';
  if (family === 'times') return { regular: 'Times-Roman', bold: 'Times-Bold' };
  if (family === 'courier') return { regular: 'Courier', bold: 'Courier-Bold' };
  if (family === 'helvetica') return { regular: 'Helvetica', bold: 'Helvetica-Bold' };
  const regularPath = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const boldPath = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  if (fs.existsSync(regularPath) && fs.existsSync(boldPath)) {
    doc.registerFont('AppRegular', regularPath);
    doc.registerFont('AppBold', boldPath);
    return { regular: 'AppRegular', bold: 'AppBold' };
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold' };
}

function color(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
}

function drawPageFooter(doc, settings, fonts, text) {
  const oldY = doc.y;
  doc.save();
  // Stopka mieści się ponad dolnym marginesem PDFKit. Poprzednia pozycja 798 pkt
  // mogła automatycznie tworzyć kolejne puste strony przy każdym renderowaniu stopki.
  doc.strokeColor('#d8dee4').lineWidth(0.5).moveTo(45, 770).lineTo(550, 770).stroke();
  doc.fillColor('#6b7785').font(fonts.regular).fontSize(7).text(text || '', 45, 778, { width: 420, height: 12, ellipsis: true });
  doc.text(`Strona ${doc.page.number || 1}`, 480, 778, { width: 70, height: 12, align: 'right' });
  doc.restore();
  doc.y = oldY;
}

function addDocumentPage(doc, settings, fonts, footerText) {
  doc.addPage({ size: 'A4', margin: 45 });
  drawPageFooter(doc, settings, fonts, footerText);
  doc.y = 45;
}

function ensureSpace(doc, needed, settings, fonts, footerText) {
  if (doc.y + needed > 752) addDocumentPage(doc, settings, fonts, footerText);
}

function drawDocumentHeader(doc, title, number, settings, fonts) {
  const accent = color(settings.document_accent_color, '#2563eb');
  doc.rect(45, 42, 505, 5).fill(accent);
  const logoX = Number(settings.document_logo_x || 45), logoY = Number(settings.document_logo_y || 57);
  const logoW = Number(settings.document_logo_width || 105), logoH = Number(settings.document_logo_height || 48);
  const titleX = Number(settings.document_title_x || 290), titleY = Number(settings.document_title_y || 58), titleW = Number(settings.document_title_width || 260);
  const logoPath = settings.document_logo_path ? path.join(config.uploadDir, settings.document_logo_path) : '';
  const logoSupported = /\.(png|jpe?g)$/i.test(logoPath);
  if (settings.document_show_logo && logoSupported && fs.existsSync(logoPath)) {
    try { doc.image(logoPath, logoX, logoY, { fit: [logoW, logoH], align: 'left', valign: 'center' }); } catch (_) {}
  } else if (settings.document_show_logo) {
    doc.font(fonts.bold).fillColor(accent).fontSize(17).text(config.company.name, logoX, logoY + 4, { width: logoW + 155 });
  }
  const titleSize = String(title).length > 22 ? 13.5 : 18;
  doc.fillColor('#26323d').font(fonts.bold).fontSize(titleSize).text(title, titleX, titleY, { width: titleW, align: 'right', lineGap: 1 });
  if (number) doc.font(fonts.regular).fontSize(8.5).fillColor('#687481').text(number, titleX, titleY + 36, { width: titleW, align: 'right' });
  doc.y = Math.max(110, logoY + logoH + 8, titleY + 58);
}

function drawBox(doc, x, y, width, title, lines, fonts, settings, height = 88) {
  const header = color(settings.document_table_header_color, '#e8eef5');
  doc.fillColor(header).rect(x, y, width, 22).fill();
  doc.strokeColor('#d7dde3').lineWidth(0.6).rect(x, y, width, height).stroke();
  doc.fillColor('#25313c').font(fonts.bold).fontSize(8.5).text(title, x + 8, y + 7, { width: width - 16 });
  doc.font(fonts.regular).fontSize(8).fillColor('#35414c').text(lines.filter(Boolean).join('\n'), x + 8, y + 30, { width: width - 16, height: Math.max(20, height - 36), ellipsis: true, lineGap: 2 });
}

function drawMeta(doc, pairs, x, y, width, fonts) {
  const labelWidth = 92;
  let cursor = y;
  for (const [label, value] of pairs) {
    doc.font(fonts.bold).fontSize(8).fillColor('#65717d').text(label, x, cursor, { width: labelWidth });
    doc.font(fonts.regular).fillColor('#26323d').text(value || '—', x + labelWidth, cursor, { width: width - labelWidth });
    cursor += 14;
  }
  return cursor;
}


function resolveCustomValue(value, context, settings) {
  const replacements = {
    '{FIRMA}': config.company.name || '', '{NIP}': config.company.nip || '', '{ADRES_FIRMY}': config.company.address || '',
    '{EMAIL_FIRMY}': config.company.email || '', '{TELEFON_FIRMY}': config.company.phone || '',
    '{RACHUNEK}': settings.document_bank_account || '', '{BANK}': settings.document_bank_name || '',
    '{NUMER}': context.number || '', '{KLIENT}': context.client_name || '', '{POJAZD}': context.vehicle || ''
  };
  let result = String(value || '');
  for (const [token, replacement] of Object.entries(replacements)) result = result.replaceAll(token, replacement);
  return result;
}

function drawCustomFields(doc, settings, fonts, documentType, context = {}) {
  const fields = Array.isArray(settings.document_custom_fields) ? settings.document_custom_fields : [];
  for (const field of fields) {
    if (!field || (field.document_type && !['all', documentType, documentType.startsWith('protocol') ? 'protocol' : ''].includes(field.document_type))) continue;
    const labelText = String(field.label || '').trim();
    const valueText = resolveCustomValue(field.value, context, settings);
    const text = labelText && valueText ? `${labelText}: ${valueText}` : (labelText || valueText);
    if (!text) continue;
    const x = Number(field.x || 45), y = Number(field.y || 700), width = Number(field.width || 240), size = Number(field.font_size || 8);
    doc.font(field.bold ? fonts.bold : fonts.regular).fontSize(size).fillColor('#35414c').text(text, x, y, { width, lineGap: 1 });
  }
}

function invoiceColumns(settings) {
  const cols = [];
  if (settings.invoice_show_lp) cols.push({ key: 'lp', label: 'Lp.', weight: 0.45, align: 'center' });
  cols.push({ key: 'description', label: 'Nazwa towaru / usługi', weight: 3.15, align: 'left' });
  cols.push({ key: 'quantity', label: 'Ilość', weight: 0.72, align: 'right' });
  if (settings.invoice_show_unit) cols.push({ key: 'unit', label: 'J.m.', weight: 0.65, align: 'center' });
  cols.push({ key: 'discount', label: 'Rabat', weight: 0.72, align: 'center' });
  cols.push({ key: 'net', label: 'Netto', weight: 1.05, align: 'right' });
  if (settings.invoice_show_vat_rate) cols.push({ key: 'vatRate', label: 'VAT', weight: 0.65, align: 'center' });
  if (settings.invoice_show_vat_value) cols.push({ key: 'vat', label: 'Kwota VAT', weight: 1.05, align: 'right' });
  cols.push({ key: 'gross', label: 'Brutto', weight: 1.1, align: 'right' });
  const totalWeight = cols.reduce((sum, col) => sum + col.weight, 0);
  let x = 45;
  for (const col of cols) {
    col.width = 505 * col.weight / totalWeight;
    col.x = x;
    x += col.width;
  }
  return cols;
}

function drawTableHeader(doc, columns, settings, fonts) {
  const headerColor = color(settings.document_table_header_color, '#e8eef5');
  const textColor = color(settings.document_table_text_color, '#25313c');
  const y = doc.y;
  doc.fillColor(headerColor).rect(45, y, 505, 25).fill();
  doc.strokeColor('#cfd7de').lineWidth(0.6).rect(45, y, 505, 25).stroke();
  for (const col of columns) {
    doc.fillColor(textColor).font(fonts.bold).fontSize(7.2).text(col.label, col.x + 4, y + 8, { width: col.width - 8, align: col.align });
  }
  doc.y = y + 25;
}

function drawInvoiceRows(doc, items, columns, settings, fonts, footerText) {
  const baseFont = settings.document_font_size || 9;
  items.forEach((item, index) => {
    const totals = lineTotals(item);
    const values = {
      lp: String(index + 1), description: item.description, quantity: String(item.quantity), unit: item.unit,
      discount: `${Number(item.discount_percent || 0)}%`, net: pln(totals.net), vatRate: `${item.vat_rate}%`, vat: pln(totals.vat), gross: pln(totals.gross)
    };
    const descCol = columns.find(col => col.key === 'description');
    const descHeight = doc.heightOfString(item.description, { width: Math.max(50, descCol.width - 8) });
    const rowHeight = Math.max(settings.document_compact ? 23 : 29, descHeight + 10);
    if (doc.y + rowHeight > 752) {
      addDocumentPage(doc, settings, fonts, footerText);
      drawTableHeader(doc, columns, settings, fonts);
    }
    const y = doc.y;
    if (index % 2 === 1) doc.fillColor('#fbfcfd').rect(45, y, 505, rowHeight).fill();
    doc.strokeColor('#e0e5e9').lineWidth(0.4).moveTo(45, y + rowHeight).lineTo(550, y + rowHeight).stroke();
    for (const col of columns) {
      doc.fillColor('#303c47').font(fonts.regular).fontSize(baseFont).text(values[col.key] || '', col.x + 4, y + 7, { width: col.width - 8, align: col.align });
    }
    doc.y = y + rowHeight;
  });
}

async function generateInvoicePdf(invoiceId) {
  const invoice = db.prepare(`SELECT i.*, c.name client_name, c.nip client_nip, c.address client_address, c.email client_email, c.phone client_phone
    FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=?`).get(invoiceId);
  if (!invoice) throw new Error('Nie znaleziono faktury.');
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id').all(invoiceId);
  const totals = sumItems(items, invoice.discount_percent);
  const settings = getDocumentSettings(invoice.document_type || 'invoice');
  const filename = `faktura_${safeName(invoice.number)}.pdf`;
  const filepath = path.join(config.pdfDir, filename);
  const doc = new PDFDocument({ margin: 45, size: 'A4', autoFirstPage: true });
  const fonts = setupFonts(doc, settings);
  const stream = fs.createWriteStream(filepath);
  doc.pipe(stream);
  const footerText = settings.invoice_footer || '';
  drawPageFooter(doc, settings, fonts, footerText);
  const invoiceTitle = invoice.document_type === 'correction' ? 'FAKTURA KORYGUJĄCA' : (invoice.document_type === 'invoice_receipt' ? 'FAKTURA DO PARAGONU' : 'FAKTURA VAT');
  drawDocumentHeader(doc, invoiceTitle, invoice.number, settings, fonts);

  drawBox(doc, settings.document_seller_x, settings.document_seller_y, settings.document_seller_width, 'SPRZEDAWCA', [config.company.name, config.company.address, config.company.nip ? `NIP: ${config.company.nip}` : '', settings.document_show_company_contact ? [config.company.email, config.company.phone].filter(Boolean).join(' · ') : ''], fonts, settings, settings.document_seller_height);
  drawBox(doc, settings.document_buyer_x, settings.document_buyer_y, settings.document_buyer_width, 'NABYWCA', [invoice.client_name, invoice.client_address, invoice.client_nip ? `NIP: ${invoice.client_nip}` : '', [invoice.client_email, invoice.client_phone].filter(Boolean).join(' · ')], fonts, settings, settings.document_buyer_height);
  drawMeta(doc, [
    ['Data wystawienia', invoice.issue_date], ['Data sprzedaży', invoice.sale_date], ['Termin płatności', invoice.due_date], ['Forma płatności', label('payment', invoice.payment_method)], ['Rabat', `${Number(invoice.discount_percent || 0)}%`], ['Numer paragonu', invoice.receipt_number || '—']
  ], settings.document_meta_x, settings.document_meta_y, settings.document_meta_width, fonts);
  if (settings.document_show_bank_account && settings.document_bank_account) {
    drawMeta(doc, [['Rachunek', settings.document_bank_account], ['Bank', settings.document_bank_name]], settings.document_bank_x, settings.document_bank_y, settings.document_bank_width, fonts);
  }
  drawCustomFields(doc, settings, fonts, invoice.document_type || 'invoice', { number: invoice.number, client_name: invoice.client_name });
  doc.y = settings.document_table_y;
  const columns = invoiceColumns(settings);
  drawTableHeader(doc, columns, settings, fonts);
  drawInvoiceRows(doc, items, columns, settings, fonts, footerText);

  ensureSpace(doc, 105, settings, fonts, footerText);
  const totalsY = doc.y + 14;
  doc.strokeColor('#d7dde3').rect(340, totalsY, 210, 73).stroke();
  doc.font(fonts.regular).fontSize(9).fillColor('#55616d').text('Razem netto', 352, totalsY + 10, { width: 100 });
  doc.text('VAT', 352, totalsY + 28, { width: 100 });
  doc.font(fonts.bold).fillColor('#26323d').text(pln(totals.net), 445, totalsY + 10, { width: 92, align: 'right' });
  doc.text(pln(totals.vat), 445, totalsY + 28, { width: 92, align: 'right' });
  if (totals.discountPercent > 0) doc.font(fonts.regular).fontSize(7.5).fillColor('#687481').text(`Rabat ${totals.discountPercent}%: -${pln(totals.discountGross)}`, 45, totalsY + 12, { width: 250 });
  doc.fillColor(color(settings.document_accent_color, '#2563eb')).fontSize(11).text('DO ZAPŁATY', 352, totalsY + 50, { width: 100 });
  doc.text(pln(totals.gross), 430, totalsY + 50, { width: 107, align: 'right' });
  doc.y = totalsY + 88;
  if (invoice.ksef_number) doc.font(fonts.regular).fontSize(7.5).fillColor('#687481').text(`Numer KSeF: ${invoice.ksef_number}`);
  if (invoice.notes) doc.moveDown().fontSize(8).fillColor('#35414c').text(`Uwagi: ${invoice.notes}`);

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve); stream.on('error', reject); doc.on('error', reject); doc.end();
  });
  return { filepath, filename };
}

function protocolFields(type, body) {
  if (type === 'additional_costs') return [
    ['Powód rozszerzenia', body.additional_reason], ['Opis dodatkowych prac / części', body.additional_description],
    ['Dodatkowy koszt netto', body.additional_net != null ? pln(body.additional_net) : null], ['VAT', body.vat_rate != null ? `${body.vat_rate}%` : null],
    ['Rabat', body.discount_percent ? `${body.discount_percent}%` : '0%'], ['Uwagi', body.notes]
  ];
  if (type === 'release') return [
    ['Wydano osobie', body.released_to], ['Status płatności', body.payment_status], ['Kluczyki', body.keys],
    ['Wykonane prace', body.work_summary], ['Zalecenia', body.recommendations], ['Uwagi', body.notes]
  ];
  return [
    ['Dokumenty', body.documents], ['Kluczyki', body.keys], ['Koło / zestaw', body.spare], ['Multimedia', body.multimedia],
    ['Wyposażenie', body.equipment], ['Stan pojazdu', body.vehicle_condition], ['Widoczne uszkodzenia', body.damage],
    ['Zakres zgłoszenia', body.complaint_confirmed], ['Uwagi', body.notes]
  ];
}

async function generateProtocolPdf(protocolId) {
  const protocol = db.prepare(`SELECT p.*, w.number work_order_number, w.vehicle_id, w.mileage_in, w.fuel_level, w.complaint, w.discount_percent,
    c.name client_name, c.nip client_nip, c.address client_address, c.phone client_phone,
    v.registration, v.vin, v.make, v.model, v.year
    FROM protocols p JOIN work_orders w ON w.id=p.work_order_id LEFT JOIN clients c ON c.id=w.client_id LEFT JOIN vehicles v ON v.id=w.vehicle_id
    WHERE p.id=?`).get(protocolId);
  if (!protocol) throw new Error('Nie znaleziono protokołu.');
  const items = db.prepare('SELECT * FROM work_order_items WHERE work_order_id=? ORDER BY id').all(protocol.work_order_id);
  const totals = sumItems(items, protocol.discount_percent);
  const body = JSON.parse(protocol.body_json || '{}');
  const settings = getDocumentSettings(`protocol_${protocol.type}`);
  const title = protocol.type === 'release' ? 'PROTOKÓŁ WYDANIA POJAZDU' : (protocol.type === 'additional_costs' ? 'PROTOKÓŁ DODATKOWYCH KOSZTÓW' : 'PROTOKÓŁ PRZYJĘCIA POJAZDU');
  const filename = `protokol_${protocol.type}_${safeName(protocol.work_order_number)}.pdf`;
  const filepath = path.join(config.pdfDir, filename);
  const doc = new PDFDocument({ margin: 45, size: 'A4', autoFirstPage: true });
  const fonts = setupFonts(doc, settings);
  const stream = fs.createWriteStream(filepath);
  doc.pipe(stream);
  const footerText = settings.protocol_footer || '';
  drawPageFooter(doc, settings, fonts, footerText);
  drawDocumentHeader(doc, title, protocol.number || protocol.work_order_number, settings, fonts);
  drawBox(doc, settings.document_seller_x, settings.document_seller_y, settings.document_seller_width, 'WARSZTAT', [config.company.name, config.company.address, config.company.nip ? `NIP: ${config.company.nip}` : '', settings.document_show_company_contact ? [config.company.email, config.company.phone].filter(Boolean).join(' · ') : ''], fonts, settings, settings.document_seller_height);
  drawBox(doc, settings.document_buyer_x, settings.document_buyer_y, settings.document_buyer_width, 'KLIENT I POJAZD', [protocol.client_name || 'Klient nieprzypisany', protocol.client_address, protocol.client_nip ? `NIP: ${protocol.client_nip}` : '', `${protocol.make || ''} ${protocol.model || ''} ${protocol.year || ''}`.trim() || 'Pojazd nieprzypisany', protocol.vehicle_id ? `${protocol.registration || 'bez rejestracji'} · VIN: ${protocol.vin || '—'}` : ''], fonts, settings, settings.document_buyer_height);
  drawMeta(doc, [['Przebieg', protocol.mileage_in ? `${protocol.mileage_in} km` : '—'], ['Stan paliwa', protocol.fuel_level || '—'], ['Data dokumentu', new Date(protocol.created_at).toLocaleDateString('pl-PL')], ['Zlecenie', protocol.work_order_number]], settings.document_meta_x, settings.document_meta_y, Math.max(250, settings.document_meta_width), fonts);
  drawCustomFields(doc, settings, fonts, `protocol_${protocol.type}`, { number: protocol.number || protocol.work_order_number, client_name: protocol.client_name, vehicle: `${protocol.make || ''} ${protocol.model || ''} ${protocol.registration || ''}`.trim() });
  doc.y = Math.max(270, settings.document_meta_y + 68, settings.document_seller_y + settings.document_seller_height + 12, settings.document_buyer_y + settings.document_buyer_height + 12);
  doc.font(fonts.bold).fontSize(10).fillColor('#26323d').text(protocol.type === 'release' ? 'Wydanie i podsumowanie' : (protocol.type === 'additional_costs' ? 'Rozszerzenie zakresu i dodatkowe koszty' : 'Stan pojazdu przy przyjęciu'));
  doc.moveDown(0.5);
  for (const [label, value] of protocolFields(protocol.type, body)) {
    if (!value) continue;
    ensureSpace(doc, 34, settings, fonts, footerText);
    doc.font(fonts.bold).fontSize(8).fillColor('#697580').text(label, { continued: false });
    doc.font(fonts.regular).fontSize(8.5).fillColor('#2f3b46').text(String(value), { lineGap: 2 });
    doc.moveDown(0.5);
  }

  if (settings.protocol_show_order_items && items.length) {
    ensureSpace(doc, 90, settings, fonts, footerText);
    doc.moveDown().font(fonts.bold).fontSize(10).fillColor('#26323d').text('Pozycje zlecenia — usługi i części rozdzielone');
    doc.moveDown(0.4);
    const columns = [
      { key: 'description', label: 'Nazwa', x: 45, width: 225, align: 'left' },
      { key: 'quantity', label: 'Ilość', x: 270, width: 55, align: 'right' },
      { key: 'unit', label: 'J.m.', x: 325, width: 45, align: 'center' },
      { key: 'net', label: 'Netto', x: 370, width: 85, align: 'right' },
      { key: 'vatRate', label: 'VAT', x: 455, width: 40, align: 'center' },
      { key: 'gross', label: 'Brutto', x: 495, width: 55, align: 'right' }
    ];
    drawTableHeader(doc, columns, settings, fonts);
    [...items.filter(i => ['labor','service'].includes(i.type)), ...items.filter(i => !['labor','service'].includes(i.type))].forEach((item, itemIndex, orderedItems) => {
      const previous = orderedItems[itemIndex - 1];
      const group = ['labor','service'].includes(item.type) ? 'USŁUGI / ROBOCIZNA' : 'CZĘŚCI / MATERIAŁY';
      const previousGroup = previous ? (['labor','service'].includes(previous.type) ? 'USŁUGI / ROBOCIZNA' : 'CZĘŚCI / MATERIAŁY') : null;
      if (group !== previousGroup) { ensureSpace(doc, 24, settings, fonts, footerText); doc.font(fonts.bold).fontSize(8).fillColor('#65717d').text(group); doc.moveDown(0.25); }
      const t = lineTotals(item);
      const rowHeight = 24;
      if (doc.y + rowHeight > 752) { addDocumentPage(doc, settings, fonts, footerText); drawTableHeader(doc, columns, settings, fonts); }
      const y = doc.y;
      const values = { description: item.description, quantity: String(item.quantity), unit: item.unit, net: pln(t.net), vatRate: `${item.vat_rate}%`, gross: pln(t.gross) };
      for (const col of columns) doc.font(fonts.regular).fontSize(8).fillColor('#303c47').text(values[col.key], col.x + 4, y + 7, { width: col.width - 8, align: col.align });
      doc.strokeColor('#e0e5e9').moveTo(45, y + rowHeight).lineTo(550, y + rowHeight).stroke();
      doc.y = y + rowHeight;
    });
    const summaryY = doc.y + 10;
    doc.strokeColor('#d7dde3').rect(340, summaryY, 210, 72).stroke();
    doc.font(fonts.regular).fontSize(8.5).fillColor('#55616d').text('Razem netto', 352, summaryY + 9, { width: 90 });
    doc.text('VAT', 352, summaryY + 27, { width: 90 });
    doc.font(fonts.bold).fillColor('#26323d').text(pln(totals.net), 445, summaryY + 9, { width: 92, align: 'right' });
    doc.text(pln(totals.vat), 445, summaryY + 27, { width: 92, align: 'right' });
    doc.font(fonts.bold).fontSize(10).fillColor(color(settings.document_accent_color, '#2563eb')).text('Razem brutto', 352, summaryY + 49, { width: 100 });
    doc.text(pln(totals.gross), 435, summaryY + 49, { width: 102, align: 'right' });
    if (totals.discountPercent > 0) doc.font(fonts.regular).fontSize(7.5).fillColor('#687481').text(`Rabat ${totals.discountPercent}%: -${pln(totals.discountGross)}`, 45, summaryY + 12, { width: 250 });
    doc.y = summaryY + 82;
  }

  const legalText = body.legal_text || settings.protocol_legal_text;
  if (legalText) {
    ensureSpace(doc, 100, settings, fonts, footerText);
    doc.moveDown(1).font(fonts.bold).fontSize(8).fillColor('#26323d').text('Warunki i potwierdzenia');
    doc.moveDown(0.35).font(fonts.regular).fontSize(7.2).fillColor('#4b5864').text(legalText, { lineGap: 1.5 });
  }
  ensureSpace(doc, 90, settings, fonts, footerText);
  doc.moveDown(2);
  const signatureY = doc.y;
  doc.strokeColor('#687481').moveTo(55, signatureY + 35).lineTo(250, signatureY + 35).stroke();
  doc.moveTo(345, signatureY + 35).lineTo(540, signatureY + 35).stroke();
  doc.fontSize(7).fillColor('#697580').text('podpis klienta / odbierającego', 55, signatureY + 40, { width: 195, align: 'center' });
  doc.text('podpis pracownika warsztatu', 345, signatureY + 40, { width: 195, align: 'center' });

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve); stream.on('error', reject); doc.on('error', reject); doc.end();
  });
  return { filepath, filename };
}

module.exports = { generateInvoicePdf, generateProtocolPdf };
