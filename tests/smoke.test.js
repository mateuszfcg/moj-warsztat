const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const testDb = path.join('/tmp', `moj-warsztat-test-${process.pid}.sqlite`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDb + suffix); } catch (_) {} }
process.env.DB_PATH = testDb;
process.env.ADMIN_EMAIL = 'test@example.local';
process.env.ADMIN_PASSWORD = 'Test123!';
process.env.SESSION_SECRET = 'test-secret-at-least-32-characters-long';
process.env.KSEF_MODE = 'mock';
process.env.APP_BASE_PATH = '';

const app = require('../src/app');
const { db } = require('../src/db');

function csrfFrom(html) {
  const match = String(html).match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'Brak tokena CSRF w HTML');
  return match[1];
}

async function login(agent) {
  const page = await agent.get('/login').expect(200);
  const csrf = csrfFrom(page.text);
  await agent.post('/login').type('form').send({ _csrf: csrf, email: 'test@example.local', password: 'Test123!' }).expect(302).expect('Location', '/');
  return csrf;
}

test('health endpoint działa', async () => {
  const response = await request(app).get('/health').expect(200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.ksef, 'mock');
  assert.equal(response.body.app, 'Mój Warsztat');
  assert.equal(response.body.version, '0.8.0');
});

test('pełny przepływ modalny: klient + pojazd + zlecenie + RBH + protokoły + faktura + KSeF + PDF', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  await agent.get('/').expect(302).expect('Location', '/modules');
  await agent.get('/modules').expect(200);
  const ordersPage = await agent.get('/orders').expect(200);
  assert.match(ordersPage.text, /Nowe zlecenie/);
  csrf = csrfFrom(ordersPage.text);

  await agent.post('/orders').type('form').send({
    _csrf: csrf,
    creation_mode: 'new_client_vehicle',
    client_type: 'company',
    client_name: 'Auto Test sp. z o.o.',
    client_nip: '1234567890',
    client_email: 'test@client.local',
    client_phone: '500600700',
    client_address: 'ul. Testowa 1',
    vehicle_vin: 'WVWZZZ1JZXW000001',
    vehicle_registration: 'TEST123',
    vehicle_make: 'Volkswagen',
    vehicle_model: 'Golf',
    vehicle_year: 2020,
    mileage_in: 100123,
    fuel_level: '1/2',
    status: 'estimate',
    complaint: 'Wymiana klocków hamulcowych',
    price_mode: 'net'
  }).expect(302);

  const client = db.prepare('SELECT * FROM clients WHERE name=?').get('Auto Test sp. z o.o.');
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE registration=?').get('TEST123');
  const order = db.prepare('SELECT * FROM work_orders WHERE vehicle_id=?').get(vehicle.id);
  assert.ok(client && vehicle && order);

  const orderPage = await agent.get(`/orders/${order.id}`).expect(200);
  csrf = csrfFrom(orderPage.text);
  assert.match(orderPage.text, /Dodaj pozycje bez otwierania osobnego okna/);

  await agent.post('/settings/workshop').type('form').send({
    _csrf: csrf,
    labor_sale_rate_net: 210,
    labor_cost_rate_net: 90,
    labor_vat_rate: 23,
    default_price_mode: 'net',
    intake_protocol_enabled: '1',
    release_protocol_enabled: '1'
  }).expect(302);

  await agent.post(`/orders/${order.id}/items`).type('form').send({
    _csrf: csrf, type: 'part', description: 'Klocki hamulcowe przód', quantity: 1, unit: 'kpl.', price_input: 200, input_price_mode: 'net', vat_rate: 23, cost_net: 140
  }).expect(302);
  await agent.post(`/orders/${order.id}/items`).type('form').send({
    _csrf: csrf, type: 'labor', description: 'Wymiana klocków', hours: 1.5, input_price_mode: 'net', vat_rate: 23, price_input: '', cost_net: ''
  }).expect(302);
  const labor = db.prepare("SELECT * FROM work_order_items WHERE work_order_id=? AND type='labor'").get(order.id);
  assert.equal(labor.quantity, 1.5);
  assert.equal(labor.unit, 'rbh');
  assert.equal(labor.unit_price_net, 210);
  assert.equal(labor.cost_net, 90);

  await agent.post(`/orders/${order.id}/protocols`).type('form').send({
    _csrf: csrf, type: 'intake', documents: 'dowód rejestracyjny', keys: '1 szt.', damage: 'rysa na lewym błotniku', complaint_confirmed: 'Wymiana klocków', signed_by: 'Jan Testowy'
  }).expect(302);
  await agent.post(`/orders/${order.id}/protocols`).type('form').send({
    _csrf: csrf, type: 'release', released_to: 'Jan Testowy', payment_status: 'Zapłacono', work_summary: 'Wymieniono klocki', recommendations: 'Kontrola po 100 km'
  }).expect(302);
  await agent.post(`/orders/${order.id}/protocols`).type('form').send({
    _csrf: csrf, type: 'additional_costs', additional_reason: 'Usterka ujawniona po demontażu', additional_description: 'Wymiana dodatkowego przewodu', additional_net: 100, vat_rate: 23, discount_percent: 5
  }).expect(302);
  const protocols = db.prepare('SELECT * FROM protocols WHERE work_order_id=? ORDER BY id').all(order.id);
  assert.equal(protocols.length, 3);
  for (const protocol of protocols) {
    const pdf = await agent.get(`/protocols/${protocol.id}/pdf`).expect(200);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
  }

  await agent.post(`/orders/${order.id}/invoice`).type('form').send({ _csrf: csrf, payment_method: 'transfer' }).expect(302);
  const invoice = db.prepare('SELECT * FROM invoices WHERE work_order_id=?').get(order.id);
  assert.ok(invoice);
  const invoicePdf = await agent.get(`/invoices/${invoice.id}/pdf`).expect(200);
  assert.match(invoicePdf.headers['content-type'], /application\/pdf/);

  const editPage = await agent.get(`/invoices/${invoice.id}/edit`).expect(200);
  csrf = csrfFrom(editPage.text);
  await agent.post(`/invoices/${invoice.id}/issue`).type('form').send({ _csrf: csrf }).expect(302);
  assert.equal(db.prepare('SELECT status FROM work_orders WHERE id=?').get(order.id).status, 'completed');
  const invoicePage = await agent.get(`/invoices/${invoice.id}`).expect(200);
  csrf = csrfFrom(invoicePage.text);
  await agent.post(`/invoices/${invoice.id}/ksef`).type('form').send({ _csrf: csrf }).expect(302);
  const afterKsef = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoice.id);
  assert.equal(afterKsef.ksef_status, 'accepted_mock');
});

test('moduły operacyjne: zadania, terminarz, WZ, magazyn, katalog i kasa', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const modules = await agent.get('/modules').expect(200);
  csrf = csrfFrom(modules.text);
  for (const route of ['/tasks','/calendar','/purchases','/inventory','/catalog','/cash','/reports','/storage']) {
    await agent.get(route).expect(200);
  }

  await agent.post('/tasks').type('form').send({ _csrf: csrf, title: 'Test zadania', priority: 'high', estimated_hours: 1 }).expect(302);
  assert.ok(db.prepare("SELECT id FROM tasks WHERE title='Test zadania'").get());

  const resource = db.prepare('SELECT id FROM calendar_resources ORDER BY id LIMIT 1').get();
  await agent.post('/calendar/events').type('form').send({ _csrf: csrf, title: 'Test terminu', resource_id: resource.id, starts_at: '2026-07-18T09:00', ends_at: '2026-07-18T10:00' }).expect(302);
  assert.ok(db.prepare("SELECT id FROM calendar_events WHERE title='Test terminu'").get());

  const supplier = db.prepare("SELECT id FROM suppliers WHERE code='AUTOPARTNER'").get();
  await agent.post('/purchases').type('form').send({ _csrf: csrf, supplier_id: supplier.id, type: 'wz', number: 'WZ-TEST-1', issue_date: '2026-07-18' }).expect(302);
  const purchase = db.prepare("SELECT id FROM purchase_documents WHERE number='WZ-TEST-1'").get();
  await agent.post(`/purchases/${purchase.id}/items`).type('form').send({ _csrf: csrf, supplier_sku: 'TEST-SKU', manufacturer: 'Test', name: 'Testowa część', quantity: 2, unit: 'szt.', purchase_price_net: 10, vat_rate: 23 }).expect(302);
  const purchaseItem = db.prepare("SELECT * FROM purchase_document_items WHERE purchase_document_id=?").get(purchase.id);
  await agent.post(`/purchase-items/${purchaseItem.id}/add-stock`).type('form').send({ _csrf: csrf, quantity: 2 }).expect(302);
  const product = db.prepare("SELECT * FROM inventory_products WHERE supplier_sku='TEST-SKU'").get();
  assert.equal(product.stock_qty, 2);

  await agent.post('/cash').type('form').send({ _csrf: csrf, type: 'income', category: 'test', amount_gross: 100, occurred_on: '2026-07-18' }).expect(302);
  assert.ok(db.prepare("SELECT id FROM cash_transactions WHERE category='test'").get());
});

test('ustawienia wyglądu dokumentów zapisują konfigurację', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const page = await agent.get('/settings/documents').expect(200);
  csrf = csrfFrom(page.text);
  await agent.post('/settings/documents').type('form').send({
    _csrf: csrf,
    document_accent_color: '#123456',
    document_table_header_color: '#eeeeee',
    document_table_text_color: '#222222',
    document_font_size: 10,
    document_compact: '1', document_show_logo: '1', document_show_company_contact: '1',
    invoice_show_lp: '1', invoice_show_unit: '1', invoice_show_net: '1', invoice_show_vat_rate: '1', invoice_show_vat_value: '1', invoice_show_gross: '1',
    protocol_show_order_items: '1', protocol_show_gross_total: '1', invoice_footer: 'Stopka testowa', protocol_footer: 'Stopka protokołu'
  }).expect(302);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='document_accent_color'").get().value, '#123456');
});


test('zlecenie może powstać bez klienta i pojazdu', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const page = await agent.get('/orders').expect(200);
  csrf = csrfFrom(page.text);
  const response = await agent.post('/orders').type('form').send({
    _csrf: csrf, creation_mode: 'standalone', status: 'draft', complaint: 'Zlecenie bez kartoteki', price_mode: 'net'
  }).expect(302);
  assert.match(response.headers.location, /^\/orders\/\d+$/);
  const order = db.prepare("SELECT * FROM work_orders WHERE complaint='Zlecenie bez kartoteki'").get();
  assert.ok(order);
  assert.equal(order.client_id, null);
  assert.equal(order.vehicle_id, null);
  const show = await agent.get(`/orders/${order.id}`).expect(200);
  assert.match(show.text, /Bez klienta/);
  assert.match(show.text, /Bez pojazdu/);
});

test('raporty obsługują zakres dat oraz eksport PDF i Excel', async () => {
  const agent = request.agent(app);
  await login(agent);
  const page = await agent.get('/reports?from=2026-07-01&to=2026-07-31').expect(200);
  assert.match(page.text, /Pobierz Excel/);
  const pdf = await agent.get('/reports/pdf?from=2026-07-01&to=2026-07-31').expect(200);
  assert.match(pdf.headers['content-type'], /application\/pdf/);
  const excel = await agent.get('/reports/excel?from=2026-07-01&to=2026-07-31').expect(200);
  assert.match(excel.headers['content-type'], /(spreadsheet|octet-stream)/);
  assert.match(excel.headers['content-disposition'], /raport_2026-07-01_2026-07-31\.xlsx/);
});

test('wgrywanie logo działa z CSRF w multipart/form-data', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const page = await agent.get('/settings/documents').expect(200);
  csrf = csrfFrom(page.text);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6xJkAAAAASUVORK5CYII=', 'base64');
  await agent.post('/settings/documents/logo').field('_csrf', csrf).attach('logo', png, { filename: 'logo.png', contentType: 'image/png' }).expect(302);
  const row = db.prepare("SELECT value FROM app_settings WHERE key='document_logo_path'").get();
  assert.ok(row?.value);
});


test('właściciel może zarządzać użytkownikami w ustawieniach', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const page = await agent.get('/settings/users').expect(200);
  csrf = csrfFrom(page.text);
  assert.match(page.text, /Nowy użytkownik/);

  await agent.post('/settings/users').type('form').send({
    _csrf: csrf, name: 'Jan Mechanik', email: 'jan.mechanik@example.local', role: 'mechanic', password: 'Mechanik123!'
  }).expect(302);
  const worker = db.prepare("SELECT * FROM users WHERE email='jan.mechanik@example.local'").get();
  assert.ok(worker);
  assert.equal(worker.role, 'mechanic');
  assert.equal(worker.is_active, 1);

  await agent.post(`/settings/users/${worker.id}`).type('form').send({
    _csrf: csrf, name: 'Jan Kowalski', email: 'jan.kowalski@example.local', role: 'advisor'
  }).expect(302);
  assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(worker.id).role, 'advisor');

  await agent.post(`/settings/users/${worker.id}/password`).type('form').send({ _csrf: csrf, password: 'NoweHaslo123!' }).expect(302);
  await agent.post(`/settings/users/${worker.id}/toggle-active`).type('form').send({ _csrf: csrf }).expect(302);
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id=?').get(worker.id).is_active, 0);

  const blocked = request.agent(app);
  const loginPage = await blocked.get('/login').expect(200);
  const blockedCsrf = csrfFrom(loginPage.text);
  await blocked.post('/login').type('form').send({ _csrf: blockedCsrf, email: 'jan.kowalski@example.local', password: 'NoweHaslo123!' }).expect(302).expect('Location', '/login');
});


test('0.6: faktura bez zlecenia, rabat, edycja przed wystawieniem, korekta i FV do paragonu', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const clientResult = db.prepare(`INSERT INTO clients (type,name,nip,email,phone) VALUES ('company','Klient FV 0.6','9876543210','fv06@example.local','501502503')`).run();
  const clientId = Number(clientResult.lastInsertRowid);

  const newPage = await agent.get('/invoices/new').expect(200);
  csrf = csrfFrom(newPage.text);
  const created = await agent.post('/invoices').type('form').send({
    _csrf: csrf, client_id: clientId, issue_date: '2026-07-18', sale_date: '2026-07-18', due_date: '2026-07-25', payment_method: 'transfer', discount_percent: 10, document_type: 'invoice'
  }).expect(302);
  assert.match(created.headers.location, /^\/invoices\/\d+\/edit$/);
  const invoiceId = Number(created.headers.location.match(/\d+/)[0]);
  const edit = await agent.get(`/invoices/${invoiceId}/edit`).expect(200);
  csrf = csrfFrom(edit.text);
  await agent.post(`/invoices/${invoiceId}`).type('form').send({
    _csrf: csrf, client_id: clientId, issue_date: '2026-07-18', sale_date: '2026-07-18', due_date: '2026-07-25', payment_method: 'transfer', discount_percent: 10,
    item_description: ['Usługa testowa 0.6'], item_quantity: ['2'], item_unit: ['usł.'], item_price: ['100'], item_vat: ['23'], item_discount: ['10']
  }).expect(302);
  const draft = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.work_order_id, null);
  assert.equal(draft.discount_percent, 0);
  assert.equal(db.prepare('SELECT discount_percent FROM invoice_items WHERE invoice_id=?').get(invoiceId).discount_percent, 10);
  await agent.post(`/invoices/${invoiceId}/issue`).type('form').send({ _csrf: csrf }).expect(302);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(invoiceId).status, 'issued');

  await agent.post(`/invoices/${invoiceId}/correction`).type('form').send({ _csrf: csrf }).expect(302);
  const correction = db.prepare("SELECT * FROM invoices WHERE corrected_invoice_id=? AND document_type='correction'").get(invoiceId);
  assert.ok(correction);
  assert.equal(correction.status, 'draft');

  const receiptPage = await agent.get('/invoices/new?type=invoice_receipt').expect(200);
  csrf = csrfFrom(receiptPage.text);
  await agent.post('/invoices').type('form').send({
    _csrf: csrf, client_id: clientId, issue_date: '2026-07-18', sale_date: '2026-07-18', due_date: '2026-07-18', payment_method: 'cash', discount_percent: 0, document_type: 'invoice_receipt', receipt_number: 'PAR/123/2026'
  }).expect(302);
  assert.ok(db.prepare("SELECT * FROM invoices WHERE document_type='invoice_receipt' AND receipt_number='PAR/123/2026'").get());
});

test('0.6: edycja protokołu cofa podpis i zwiększa wersję', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const order = db.prepare('SELECT id FROM work_orders ORDER BY id LIMIT 1').get();
  assert.ok(order);
  const protocol = db.prepare(`INSERT INTO protocols (work_order_id,type,body_json,signed_by,signed_at) VALUES (?,'intake','{"notes":"przed"}','Klient',CURRENT_TIMESTAMP)`).run(order.id);
  const id = Number(protocol.lastInsertRowid);
  const page = await agent.get(`/protocols/${id}/edit`).expect(200);
  csrf = csrfFrom(page.text);
  await agent.post(`/protocols/${id}/edit`).type('form').send({ _csrf: csrf, notes: 'po edycji', vehicle_condition: 'Dobry' }).expect(302);
  const updated = db.prepare('SELECT * FROM protocols WHERE id=?').get(id);
  assert.equal(updated.signed_by, null);
  assert.equal(updated.signed_at, null);
  assert.equal(updated.version, 2);
});

test('0.6: wykrywanie duplikatu klienta i pojazdu po numerze rejestracyjnym', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const client = db.prepare('SELECT * FROM clients ORDER BY id LIMIT 1').get();
  const page = await agent.get('/clients').expect(200); csrf = csrfFrom(page.text);
  const beforeClients = db.prepare('SELECT COUNT(*) count FROM clients').get().count;
  await agent.post('/clients').type('form').send({ _csrf: csrf, name: client.name, nip: client.nip || '', email: client.email || '', phone: client.phone || '' }).expect(302);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM clients').get().count, beforeClients);

  const vehicle = db.prepare('SELECT * FROM vehicles WHERE registration IS NOT NULL ORDER BY id LIMIT 1').get();
  if (vehicle) {
    const beforeVehicles = db.prepare('SELECT COUNT(*) count FROM vehicles').get().count;
    await agent.post('/vehicles').type('form').send({ _csrf: csrf, client_id: vehicle.client_id, registration: String(vehicle.registration).toLowerCase().replace(/ /g,''), make: 'Duplikat' }).expect(302);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM vehicles').get().count, beforeVehicles);
  }
});

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDb + suffix); } catch (_) {} }
});

test('0.7: edytor dokumentów zapisuje układ, czcionkę i własne pola', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const page = await agent.get('/settings/documents').expect(200);
  csrf = csrfFrom(page.text);
  assert.match(page.text, /Edytor dokumentów/);
  await agent.post('/settings/documents').type('form').send({
    _csrf: csrf,
    document_accent_color: '#245678', document_table_header_color: '#eeeeee', document_table_text_color: '#222222',
    document_font_size: 9, document_font_family: 'times', document_compact: '1', document_show_company_contact: '1', document_show_bank_account: '1',
    document_bank_account: '12 3456 7890 1234 5678 9012 3456', document_bank_name: 'Bank Test',
    document_logo_x: 70, document_logo_y: 62, document_logo_width: 120, document_logo_height: 50,
    document_title_x: 300, document_title_y: 60, document_title_width: 240,
    document_seller_x: 45, document_seller_y: 125, document_seller_width: 245, document_seller_height: 90,
    document_buyer_x: 305, document_buyer_y: 125, document_buyer_width: 245, document_buyer_height: 90,
    document_meta_x: 45, document_meta_y: 230, document_meta_width: 250,
    document_bank_x: 305, document_bank_y: 230, document_bank_width: 245, document_table_y: 300,
    invoice_show_lp: '1', invoice_show_unit: '1', invoice_show_vat_rate: '1', invoice_show_vat_value: '1', protocol_show_order_items: '1',
    custom_field_label: ['BDO'], custom_field_value: ['000012345'], custom_field_document_type: ['invoice'], custom_field_x: ['45'], custom_field_y: ['720'], custom_field_width: ['220'], custom_field_font_size: ['8'], custom_field_weight: ['bold']
  }).expect(302);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='document_font_family'").get().value, 'times');
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='document_logo_x'").get().value, '70');
  const fields = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='document_custom_fields_json'").get().value);
  assert.equal(fields[0].label, 'BDO');
  assert.equal(fields[0].bold, true);
  const invoice = db.prepare('SELECT id FROM invoices ORDER BY id LIMIT 1').get();
  if (invoice) {
    const pdf = await agent.get(`/invoices/${invoice.id}/pdf`).expect(200);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
  }
});

test('0.7: konfigurowalna numeracja dokumentów generuje wzorzec z tokenami', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const page = await agent.get('/settings/numbering').expect(200);
  csrf = csrfFrom(page.text);
  assert.match(page.text, /Numeracja dokumentów/);
  const types = ['work_order','invoice','correction','invoice_receipt','protocol_intake','protocol_release','protocol_additional_costs','purchase_wz','purchase_pz'];
  const defaults = {
    work_order:'ZL/{YYYY}/{NNNN}', invoice:'TEST/{YY}/{MM}/{NNN}', correction:'KOR/{YYYY}/{NNNN}', invoice_receipt:'FVP/{YYYY}/{NNNN}',
    protocol_intake:'PP/{YYYY}/{NNNN}', protocol_release:'PW/{YYYY}/{NNNN}', protocol_additional_costs:'PDK/{YYYY}/{NNNN}', purchase_wz:'WZ/{YYYY}/{NNNN}', purchase_pz:'PZ/{YYYY}/{NNNN}'
  };
  const payload = { _csrf: csrf };
  for (const type of types) {
    payload[`number_pattern_${type}`] = defaults[type]; payload[`number_prefix_${type}`] = type === 'invoice' ? 'TEST' : type.toUpperCase().slice(0,5); payload[`number_reset_${type}`] = type === 'invoice' ? 'month' : 'year';
  }
  await agent.post('/settings/numbering').type('form').send(payload).expect(302);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='number_pattern_invoice'").get().value, 'TEST/{YY}/{MM}/{NNN}');
  const { nextDocumentNumber } = require('../src/services/numbering');
  const number = nextDocumentNumber('invoice', { date: '2026-07-18' });
  assert.match(number, /^TEST\/26\/07\/\d{3}$/);
});


test('0.8: ustawienia stanowisk, integracji, importu i aktualizacji są dostępne', async () => {
  const agent = request.agent(app);
  await login(agent);
  await agent.get('/settings/positions').expect(200);
  await agent.get('/settings/integrations').expect(200);
  await agent.get('/settings/import').expect(200);
  await agent.get('/settings/updates').expect(200);
  const template = await agent.get('/settings/documents/templates/invoice/export').expect(200);
  assert.match(template.headers['content-type'], /application\/json/);
});

test('0.8: importer EPP pokazuje podgląd i zapisuje archiwum dopiero po potwierdzeniu', async () => {
  const agent = request.agent(app);
  let csrf = await login(agent);
  const page = await agent.get('/settings/import').expect(200);
  csrf = csrfFrom(page.text);
  const epp = Buffer.from('[INFO]\r\n1.11,0,1250,"Test"\r\n[NAGLOWEK]\r\n"FS",1,0,1,,,"FV 1/2026",,,,,1,"Klient Import","Klient Import","Zamość","22-400","Testowa 1",1234567890,"Sprzedaż",,"Zamość",20260718000000,20260718000000,20260718000000,1,1,,100.00,23.00,123.00\r\n', 'utf8');
  const preview = await agent.post('/settings/import/epp/preview').field('_csrf', csrf).attach('epp_file', epp, { filename: 'test-import.epp', contentType: 'application/octet-stream' }).expect(200);
  assert.match(preview.text, /Podgląd importu EPP/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM legacy_imports').get().count, 0);
  csrf = csrfFrom(preview.text);
  await agent.post('/settings/import/epp/commit').type('form').send({ _csrf: csrf }).expect(302);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM legacy_imports').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM legacy_documents').get().count, 1);
});
