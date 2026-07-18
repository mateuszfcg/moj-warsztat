const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { zipSync, strToU8 } = require('fflate');
const config = require('../config');
const { pln } = require('./money');
const { label } = require('../i18n');

function setupFonts(doc) {
  const regularPath = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const boldPath = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  if (fs.existsSync(regularPath) && fs.existsSync(boldPath)) {
    doc.registerFont('AppRegular', regularPath);
    doc.registerFont('AppBold', boldPath);
    return { regular: 'AppRegular', bold: 'AppBold' };
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold' };
}

function safeDate(value) { return String(value || '').replace(/[^0-9-]/g, ''); }
function reportFilename(from, to, ext) { return `raport_${safeDate(from)}_${safeDate(to)}.${ext}`; }

async function generateReportPdf(data) {
  const filename = reportFilename(data.from, data.to, 'pdf');
  const filepath = path.join(config.pdfDir, filename);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 42, bottom: 42, left: 42, right: 42 } });
  const fonts = setupFonts(doc);
  const stream = fs.createWriteStream(filepath);
  doc.pipe(stream);

  doc.font(fonts.bold).fontSize(20).text('Raport warsztatowy');
  doc.font(fonts.regular).fontSize(9).fillColor('#4b5563').text(`Zakres: ${data.from} - ${data.to}`);
  doc.moveDown(1.2);

  const cards = [
    ['Sprzedaż netto', pln(data.revenue.net)], ['Sprzedaż brutto', pln(data.revenue.gross)],
    ['Marża zleceń netto', pln(data.orderProfit.sales_net - data.orderProfit.cost_net)], ['Zakupy netto', pln(data.purchases.net)]
  ];
  cards.forEach(([name, value], index) => {
    const x = 42 + (index % 2) * 255;
    const y = 100 + Math.floor(index / 2) * 55;
    doc.roundedRect(x, y, 245, 44, 5).strokeColor('#d1d5db').stroke();
    doc.font(fonts.regular).fontSize(8).fillColor('#6b7280').text(name, x + 10, y + 8, { width: 225 });
    doc.font(fonts.bold).fontSize(12).fillColor('#111827').text(value, x + 10, y + 22, { width: 225 });
  });
  doc.y = 225;
  doc.font(fonts.bold).fontSize(12).fillColor('#111827').text('Faktury w zakresie');
  doc.moveDown(0.5);
  const headers = ['Numer', 'Data', 'Klient', 'Netto', 'VAT', 'Brutto', 'Status'];
  const widths = [82, 55, 125, 60, 55, 60, 68];
  let y = doc.y;
  doc.rect(42, y, 505, 22).fill('#eef2f7');
  let x = 42;
  headers.forEach((h, i) => { doc.font(fonts.bold).fontSize(7).fillColor('#1f2937').text(h, x + 3, y + 7, { width: widths[i] - 6 }); x += widths[i]; });
  doc.y = y + 22;
  for (const row of data.invoices) {
    if (doc.y > 755) { doc.addPage(); doc.y = 42; }
    y = doc.y; x = 42;
    const vals = [row.number, row.issue_date, row.client_name || 'Bez klienta', pln(row.net), pln(row.vat), pln(row.gross), label('invoice', row.status)];
    vals.forEach((v, i) => { doc.font(fonts.regular).fontSize(7).fillColor('#26323d').text(String(v), x + 3, y + 5, { width: widths[i] - 6, ellipsis: true }); x += widths[i]; });
    doc.strokeColor('#e5e7eb').moveTo(42, y + 20).lineTo(547, y + 20).stroke();
    doc.y = y + 20;
  }
  if (!data.invoices.length) doc.font(fonts.regular).fontSize(9).text('Brak faktur w wybranym zakresie.');

  const statusY = Math.max(doc.y + 24, 420);
  doc.font(fonts.bold).fontSize(12).fillColor('#111827').text('Statusy zleceń', 42, statusY, { width: 505 });
  let statusLineY = statusY + 22;
  data.orderStatus.forEach(row => {
    doc.font(fonts.regular).fontSize(9).fillColor('#26323d').text(`${label('order', row.status)}: ${row.count}`, 42, statusLineY, { width: 300 });
    statusLineY += 16;
  });

  await new Promise((resolve, reject) => { stream.on('finish', resolve); stream.on('error', reject); doc.on('error', reject); doc.end(); });
  return { filepath, filename };
}

function xmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function columnName(index) {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function sheetXml(rows) {
  const body = rows.map((row, rIndex) => {
    const cells = row.map((value, cIndex) => {
      const ref = `${columnName(cIndex)}${rIndex + 1}`;
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rIndex + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

async function generateReportExcel(data) {
  const filename = reportFilename(data.from, data.to, 'xlsx');
  const filepath = path.join(config.pdfDir, filename);
  const summaryRows = [
    ['Raport warsztatowy'], ['Od', data.from], ['Do', data.to], [],
    ['Sprzedaż netto', Number(data.revenue.net)], ['Sprzedaż brutto', Number(data.revenue.gross)],
    ['Sprzedaż zleceń netto', Number(data.orderProfit.sales_net)], ['Koszt zleceń netto', Number(data.orderProfit.cost_net)],
    ['Marża zleceń netto', Number(data.orderProfit.sales_net - data.orderProfit.cost_net)], ['Zakupy netto', Number(data.purchases.net)]
  ];
  const invoiceRows = [['Numer', 'Data wystawienia', 'Klient', 'Netto', 'VAT', 'Brutto', 'Status'], ...data.invoices.map(row => [
    row.number, row.issue_date, row.client_name || 'Bez klienta', Number(row.net), Number(row.vat), Number(row.gross), label('invoice', row.status)
  ])];
  const orderRows = [['Status', 'Liczba'], ...data.orderStatus.map(row => [label('order', row.status), Number(row.count)])];

  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Podsumowanie" sheetId="1" r:id="rId1"/><sheet name="Faktury" sheetId="2" r:id="rId2"/><sheet name="Statusy zleceń" sheetId="3" r:id="rId3"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml(summaryRows)),
    'xl/worksheets/sheet2.xml': strToU8(sheetXml(invoiceRows)),
    'xl/worksheets/sheet3.xml': strToU8(sheetXml(orderRows))
  };
  fs.writeFileSync(filepath, Buffer.from(zipSync(files, { level: 6 })));
  return { filepath, filename };
}

module.exports = { generateReportPdf, generateReportExcel };
