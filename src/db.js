const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const config = require('./config');

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Minimalny odpowiednik transakcji znany z popularnych sterowników SQLite.
db.transaction = (fn) => (...args) => {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn(...args);
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'person',
  name TEXT NOT NULL,
  nip TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  vin TEXT UNIQUE,
  registration TEXT,
  make TEXT,
  model TEXT,
  year INTEGER,
  engine TEXT,
  fuel TEXT,
  mileage INTEGER,
  color TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft',
  complaint TEXT,
  diagnosis TEXT,
  notes TEXT,
  mileage_in INTEGER,
  fuel_level TEXT,
  accepted_at TEXT,
  acceptance_token TEXT UNIQUE,
  scheduled_for TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS work_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'labor',
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'szt.',
  unit_price_net REAL NOT NULL DEFAULT 0,
  vat_rate REAL NOT NULL DEFAULT 23,
  cost_net REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS protocols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  body_json TEXT NOT NULL,
  signed_by TEXT,
  signed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
  issue_date TEXT NOT NULL,
  sale_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'transfer',
  status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT,
  ksef_number TEXT,
  ksef_status TEXT NOT NULL DEFAULT 'not_sent',
  ksef_reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'szt.',
  unit_price_net REAL NOT NULL DEFAULT 0,
  vat_rate REAL NOT NULL DEFAULT 23
);

CREATE TABLE IF NOT EXISTS ksef_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  direction TEXT NOT NULL DEFAULT 'send',
  status TEXT NOT NULL DEFAULT 'queued',
  reference TEXT,
  response_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'normal',
  planned_date TEXT,
  estimated_hours REAL NOT NULL DEFAULT 0,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS calendar_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#3f8efc',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  resource_id INTEGER REFERENCES calendar_resources(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  catalog_url TEXT,
  integration_status TEXT NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_sku TEXT,
  manufacturer TEXT,
  manufacturer_sku TEXT,
  name TEXT NOT NULL,
  barcode TEXT,
  unit TEXT NOT NULL DEFAULT 'szt.',
  vat_rate REAL NOT NULL DEFAULT 23,
  purchase_price_net REAL NOT NULL DEFAULT 0,
  sale_price_net REAL NOT NULL DEFAULT 0,
  stock_qty REAL NOT NULL DEFAULT 0,
  reserved_qty REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, supplier_sku)
);

CREATE TABLE IF NOT EXISTS purchase_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'wz',
  number TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  reference TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, type, number)
);

CREATE TABLE IF NOT EXISTS purchase_document_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_document_id INTEGER NOT NULL REFERENCES purchase_documents(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES inventory_products(id) ON DELETE SET NULL,
  supplier_sku TEXT,
  manufacturer TEXT,
  manufacturer_sku TEXT,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'szt.',
  purchase_price_net REAL NOT NULL DEFAULT 0,
  vat_rate REAL NOT NULL DEFAULT 23,
  added_to_stock INTEGER NOT NULL DEFAULT 0,
  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES inventory_products(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_cost_net REAL NOT NULL DEFAULT 0,
  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
  purchase_document_item_id INTEGER REFERENCES purchase_document_items(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supplier_catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  external_id TEXT,
  supplier_sku TEXT NOT NULL,
  manufacturer TEXT,
  manufacturer_sku TEXT,
  name TEXT NOT NULL,
  stock_text TEXT,
  purchase_price_net REAL NOT NULL DEFAULT 0,
  suggested_sale_price_net REAL NOT NULL DEFAULT 0,
  vat_rate REAL NOT NULL DEFAULT 23,
  unit TEXT NOT NULL DEFAULT 'szt.',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, supplier_sku)
);

CREATE TABLE IF NOT EXISTS cash_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_gross REAL NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  purchase_document_id INTEGER REFERENCES purchase_documents(id) ON DELETE SET NULL,
  description TEXT,
  occurred_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS storage_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'tyres',
  description TEXT NOT NULL,
  location TEXT,
  season TEXT,
  status TEXT NOT NULL DEFAULT 'stored',
  accepted_on TEXT NOT NULL,
  released_on TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
CREATE INDEX IF NOT EXISTS idx_vehicles_registration ON vehicles(registration);
CREATE INDEX IF NOT EXISTS idx_vehicles_vin ON vehicles(vin);
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_date ON tasks(status, planned_date);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(starts_at);
CREATE INDEX IF NOT EXISTS idx_inventory_products_name ON inventory_products(name);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_documents_date ON purchase_documents(issue_date);
`);

function ensureColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

ensureColumn('work_orders', 'price_mode', "TEXT NOT NULL DEFAULT 'net'");

// Migracja starszych baz: od wersji 0.5.0 zlecenie może istnieć bez klienta i pojazdu.
// SQLite nie potrafi usunąć ograniczenia NOT NULL prostym ALTER TABLE, dlatego przebudowujemy
// wyłącznie tabelę work_orders, zachowując identyfikatory i wszystkie dane.
function migrateWorkOrdersNullableRelations() {
  const columns = db.prepare('PRAGMA table_info(work_orders)').all();
  const client = columns.find(column => column.name === 'client_id');
  const vehicle = columns.find(column => column.name === 'vehicle_id');
  if (!client || !vehicle || (!client.notnull && !vehicle.notnull)) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec(`
      CREATE TABLE work_orders_v050 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number TEXT NOT NULL UNIQUE,
        client_id INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
        vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'draft',
        complaint TEXT,
        diagnosis TEXT,
        notes TEXT,
        mileage_in INTEGER,
        fuel_level TEXT,
        accepted_at TEXT,
        acceptance_token TEXT UNIQUE,
        scheduled_for TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        price_mode TEXT NOT NULL DEFAULT 'net'
      );
      INSERT INTO work_orders_v050
        (id,number,client_id,vehicle_id,status,complaint,diagnosis,notes,mileage_in,fuel_level,accepted_at,acceptance_token,scheduled_for,created_at,updated_at,price_mode)
      SELECT id,number,client_id,vehicle_id,status,complaint,diagnosis,notes,mileage_in,fuel_level,accepted_at,acceptance_token,scheduled_for,created_at,updated_at,COALESCE(price_mode,'net')
      FROM work_orders;
      DROP TABLE work_orders;
      ALTER TABLE work_orders_v050 RENAME TO work_orders;
      CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
    `);
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

migrateWorkOrdersNullableRelations();

const defaultSettings = {
  labor_sale_rate_net: '200', labor_cost_rate_net: '80', labor_vat_rate: '23', default_price_mode: 'net',
  intake_protocol_enabled: '1', release_protocol_enabled: '1', document_accent_color: '#2563eb',
  document_table_header_color: '#e8eef5', document_table_text_color: '#25313c', document_font_size: '9',
  document_compact: '1', document_show_logo: '1', document_logo_path: '', document_show_company_contact: '1',
  document_show_bank_account: '1', document_bank_account: '', document_bank_name: '', invoice_show_lp: '1',
  invoice_show_unit: '1', invoice_show_net: '1', invoice_show_vat_rate: '1', invoice_show_vat_value: '1',
  invoice_show_gross: '1', invoice_footer: 'Dziękujemy za skorzystanie z usług naszego warsztatu.',
  protocol_footer: 'Dokument sporządzono w dwóch jednobrzmiących egzemplarzach.', protocol_show_order_items: '1',
  protocol_show_gross_total: '1', protocol_show_net_total: '1', document_show_net_and_gross: '1', inventory_default_markup: '40', calendar_day_start: '08:00', calendar_day_end: '18:00', autopartner_customer_number: '', autopartner_integration_mode: 'manual', autopartner_catalog_url: 'https://apcat.eu/'
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key,value) VALUES (?,?)');
for (const [key,value] of Object.entries(defaultSettings)) insertSetting.run(key,value);

const insertResource = db.prepare('INSERT OR IGNORE INTO calendar_resources (name,color) VALUES (?,?)');
insertResource.run('Stanowisko 1', '#3f8efc');
insertResource.run('Stanowisko 2', '#22a06b');

const insertSupplier = db.prepare(`INSERT OR IGNORE INTO suppliers (code,name,catalog_url,integration_status,notes) VALUES (?,?,?,?,?)`);
insertSupplier.run('AUTOPARTNER', 'Auto Partner S.A.', 'https://apcat.eu/', 'awaiting_credentials', 'Integracja oczekuje na oficjalną dokumentację lub dostęp API od opiekuna handlowego.');
const autoPartner = db.prepare(`SELECT id FROM suppliers WHERE code='AUTOPARTNER'`).get();
if (autoPartner) {
  const insertCatalog = db.prepare(`INSERT OR IGNORE INTO supplier_catalog_items
    (supplier_id,external_id,supplier_sku,manufacturer,manufacturer_sku,name,stock_text,purchase_price_net,suggested_sale_price_net,vat_rate,unit)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  insertCatalog.run(autoPartner.id, 'demo-1', 'AP-DEMO-001', 'Filtron', 'OP 520/1', 'Filtr oleju — pozycja demonstracyjna', 'Dane testowe', 22.50, 39.90, 23, 'szt.');
  insertCatalog.run(autoPartner.id, 'demo-2', 'AP-DEMO-002', 'Bosch', '0 986 494 596', 'Klocki hamulcowe — pozycja demonstracyjna', 'Dane testowe', 145.00, 229.00, 23, 'kpl.');
  insertCatalog.run(autoPartner.id, 'demo-3', 'AP-DEMO-003', 'MANN-FILTER', 'CUK 2939', 'Filtr kabinowy — pozycja demonstracyjna', 'Dane testowe', 52.00, 89.00, 23, 'szt.');
}

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(config.adminEmail.toLowerCase());
if (!existing) {
  const hash = bcrypt.hashSync(config.adminPassword, 12);
  db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(config.adminEmail.toLowerCase(), hash, 'Administrator', 'owner');
  console.log(`Utworzono konto administratora: ${config.adminEmail}`);
}

function audit(userId, action, entityType, entityId = null, details = null) {
  db.prepare(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
              VALUES (?, ?, ?, ?, ?)`)
    .run(userId || null, action, entityType, entityId, details ? JSON.stringify(details) : null);
}

function nextNumber(prefix, table) {
  const year = new Date().getFullYear();
  const row = db.prepare(`SELECT number FROM ${table} WHERE number LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}/${year}/%`);
  let seq = 1;
  if (row) {
    const parsed = Number(String(row.number).split('/').pop());
    if (Number.isFinite(parsed)) seq = parsed + 1;
  }
  return `${prefix}/${year}/${String(seq).padStart(4, '0')}`;
}

module.exports = { db, audit, nextNumber };
