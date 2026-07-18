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
  assert.equal(response.body.version, '0.4.0');
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
  assert.match(orderPage.text, /Liczba roboczogodzin/);

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
    _csrf: csrf, type: 'release', released_to: 'Jan Testowy', payment_status: 'Zapłacono', work_summary: 'Wymieniono klocki', recommendations: 'Kontrola po 100 km', signed_by: 'Jan Testowy'
  }).expect(302);
  const protocols = db.prepare('SELECT * FROM protocols WHERE work_order_id=? ORDER BY id').all(order.id);
  assert.equal(protocols.length, 2);
  for (const protocol of protocols) {
    const pdf = await agent.get(`/protocols/${protocol.id}/pdf`).expect(200);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
  }

  await agent.post(`/orders/${order.id}/invoice`).type('form').send({ _csrf: csrf, payment_method: 'transfer' }).expect(302);
  const invoice = db.prepare('SELECT * FROM invoices WHERE work_order_id=?').get(order.id);
  assert.ok(invoice);
  const invoicePdf = await agent.get(`/invoices/${invoice.id}/pdf`).expect(200);
  assert.match(invoicePdf.headers['content-type'], /application\/pdf/);

  const invoicePage = await agent.get(`/invoices/${invoice.id}`).expect(200);
  csrf = csrfFrom(invoicePage.text);
  await agent.post(`/invoices/${invoice.id}/ksef`).type('form').send({ _csrf: csrf }).expect(302);
  await agent.post('/ksef/process').type('form').send({ _csrf: csrf }).expect(302);
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

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDb + suffix); } catch (_) {} }
});
