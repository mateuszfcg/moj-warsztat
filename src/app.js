const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const config = require('./config');
const { db, audit, nextNumber } = require('./db');
const { validateVin, decodeVin, normalizeVin } = require('./services/vin');
const { sumItems, lineTotals, pln, round2 } = require('./services/money');
const { getSettings, saveSettings } = require('./settings');
const { generateInvoicePdf, generateProtocolPdf } = require('./services/pdf');
const mail = require('./services/mail');
const ksef = require('./services/ksef');

const app = express();

function appUrl(pathname = '/') {
  const value = String(pathname || '/');
  if (/^https?:\/\//i.test(value)) return value;
  const normalized = value.startsWith('/') ? value : `/${value}`;
  if (!config.appBasePath) return normalized;
  return normalized === '/' ? `${config.appBasePath}/` : `${config.appBasePath}${normalized}`;
}

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.pdfDir, { recursive: true });

app.set('view engine', 'ejs');
app.set('trust proxy', 1);
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '1mb' }));
app.use('/public', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(config.uploadDir, { maxAge: '1h' }));
class SqliteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.database = database;
    this.database.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  }
  get(sid, callback) {
    try {
      const row = this.database.prepare('SELECT sess,expires_at FROM sessions WHERE sid=?').get(sid);
      if (!row || row.expires_at < Date.now()) {
        if (row) this.database.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }
  set(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 8 * 60 * 60 * 1000;
      this.database.prepare(`INSERT INTO sessions (sid,sess,expires_at) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expires_at=excluded.expires_at`).run(sid, JSON.stringify(sess), expiresAt);
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { this.database.prepare('DELETE FROM sessions WHERE sid=?').run(sid); callback(null); } catch (error) { callback(error); }
  }
  touch(sid, sess, callback = () => {}) { this.set(sid, sess, callback); }
}

app.use(session({
  store: new SqliteSessionStore(db),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && config.baseUrl.startsWith('https://'),
    maxAge: 8 * 60 * 60 * 1000
  }
}));

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function authRequired(req, res, next) {
  if (!req.session.user) return res.redirect(appUrl('/login'));
  next();
}

function csrfMiddleware(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const token = req.body?._csrf || req.get('x-csrf-token');
    if (!token || token !== req.session.csrfToken) return res.status(403).send('Nieprawidłowy token CSRF. Odśwież stronę i spróbuj ponownie.');
  }
  next();
}
app.use(csrfMiddleware);

app.use((req, res, next) => {
  res.locals.appName = config.appName;
  res.locals.appVersion = config.appVersion;
  res.locals.basePath = config.appBasePath;
  res.locals.company = config.company;
  res.locals.settings = getSettings();
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.flash = req.session.flash || null;
  res.locals.pln = pln;
  res.locals.lineTotals = lineTotals;
  res.locals.orderStatuses = { draft: 'Nowe zlecenie', accepted: 'Zaakceptowane', in_progress: 'W trakcie naprawy', ready: 'Gotowy do odbioru', completed: 'Zakończone', cancelled: 'Anulowane' };
  res.locals.taskStatuses = { todo: 'Do zrobienia', in_progress: 'W trakcie', done: 'Zakończone' };
  res.locals.formatDate = (value) => value ? new Date(`${value}`.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString('pl-PL') : '—';
  delete req.session.flash;
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Dozwolone są pliki JPG, PNG, WEBP i PDF.'), allowed.includes(file.mimetype));
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, app: config.appName, version: config.appVersion, ksef: ksef.status().mode }));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(appUrl('/'));
  res.render('login', { title: 'Logowanie' });
});

app.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    setFlash(req, 'error', 'Nieprawidłowy e-mail lub hasło.');
    return res.redirect(appUrl('/login'));
  }
  req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  audit(user.id, 'login', 'user', user.id);
  res.redirect(appUrl('/'));
});

app.post('/logout', authRequired, (req, res) => {
  const userId = req.session.user.id;
  audit(userId, 'logout', 'user', userId);
  req.session.destroy(() => res.redirect(appUrl('/login')));
});

app.get('/', authRequired, (_req, res) => res.redirect(appUrl('/modules')));

app.get('/modules', authRequired, (_req, res) => {
  const stats = {
    clients: db.prepare('SELECT COUNT(*) count FROM clients').get().count,
    vehicles: db.prepare('SELECT COUNT(*) count FROM vehicles').get().count,
    openOrders: db.prepare("SELECT COUNT(*) count FROM work_orders WHERE status NOT IN ('completed','cancelled')").get().count,
    unpaidInvoices: db.prepare("SELECT COUNT(*) count FROM invoices WHERE status NOT IN ('paid','cancelled')").get().count,
    openTasks: db.prepare("SELECT COUNT(*) count FROM tasks WHERE status!='done'").get().count,
    todayEvents: db.prepare("SELECT COUNT(*) count FROM calendar_events WHERE date(starts_at)=date('now','localtime')").get().count,
    stockProducts: db.prepare('SELECT COUNT(*) count FROM inventory_products').get().count,
    lowStock: db.prepare('SELECT COUNT(*) count FROM inventory_products WHERE stock_qty <= min_stock').get().count,
    purchases: db.prepare('SELECT COUNT(*) count FROM purchase_documents').get().count,
    storedItems: db.prepare("SELECT COUNT(*) count FROM storage_items WHERE status='stored'").get().count
  };
  res.render('modules', { title: 'Moduły', stats });
});

app.get('/clients', authRequired, (req, res) => {
  const q = String(req.query.q || '').trim();
  const clients = q
    ? db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM vehicles v WHERE v.client_id=c.id) vehicle_count
        FROM clients c WHERE c.name LIKE ? OR c.nip LIKE ? OR c.phone LIKE ? OR c.email LIKE ? ORDER BY c.name`)
      .all(...Array(4).fill(`%${q}%`))
    : db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM vehicles v WHERE v.client_id=c.id) vehicle_count FROM clients c ORDER BY c.id DESC LIMIT 200`).all();
  res.render('clients/list', { title: 'Klienci', clients, q });
});

app.get('/clients/new', authRequired, (_req, res) => res.render('clients/form', { title: 'Nowy klient', customer: {}, action: '/clients' }));

app.post('/clients', authRequired, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'Nazwa klienta jest wymagana.'); return res.redirect(appUrl(req.body.return_to || '/clients')); }
  const result = db.prepare(`INSERT INTO clients (type,name,nip,email,phone,address,notes) VALUES (?,?,?,?,?,?,?)`)
    .run(req.body.type || 'person', name, req.body.nip || null, req.body.email || null, req.body.phone || null, req.body.address || null, req.body.notes || null);
  audit(req.session.user.id, 'create', 'client', result.lastInsertRowid, { name });
  setFlash(req, 'success', 'Klient został dodany.');
  res.redirect(appUrl(req.body.return_to || `/clients/${result.lastInsertRowid}`));
});

app.get('/clients/:id', authRequired, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id);
  if (!client) return res.status(404).render('error', { title: 'Brak klienta', message: 'Nie znaleziono klienta.' });
  const vehicles = db.prepare('SELECT * FROM vehicles WHERE client_id=? ORDER BY id DESC').all(client.id);
  const orders = db.prepare(`SELECT w.*, v.registration, v.make, v.model FROM work_orders w JOIN vehicles v ON v.id=w.vehicle_id WHERE w.client_id=? ORDER BY w.id DESC LIMIT 20`).all(client.id);
  const invoices = db.prepare('SELECT * FROM invoices WHERE client_id=? ORDER BY id DESC LIMIT 20').all(client.id);
  res.render('clients/show', { title: client.name, customer: client, vehicles, orders, invoices });
});

app.get('/clients/:id/edit', authRequired, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id);
  if (!client) return res.status(404).send('Nie znaleziono klienta.');
  res.render('clients/form', { title: 'Edycja klienta', customer: client, action: `/clients/${client.id}` });
});

app.post('/clients/:id', authRequired, (req, res) => {
  db.prepare(`UPDATE clients SET type=?,name=?,nip=?,email=?,phone=?,address=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(req.body.type || 'person', req.body.name, req.body.nip || null, req.body.email || null, req.body.phone || null, req.body.address || null, req.body.notes || null, req.params.id);
  audit(req.session.user.id, 'update', 'client', req.params.id);
  setFlash(req, 'success', 'Dane klienta zapisane.');
  res.redirect(appUrl(`/clients/${req.params.id}`));
});

app.get('/vehicles', authRequired, (req, res) => {
  const q = String(req.query.q || '').trim();
  const vehicles = q
    ? db.prepare(`SELECT v.*, c.name client_name FROM vehicles v JOIN clients c ON c.id=v.client_id
        WHERE v.registration LIKE ? OR v.vin LIKE ? OR v.make LIKE ? OR v.model LIKE ? OR c.name LIKE ? ORDER BY v.id DESC`)
      .all(...Array(5).fill(`%${q}%`))
    : db.prepare(`SELECT v.*, c.name client_name FROM vehicles v JOIN clients c ON c.id=v.client_id ORDER BY v.id DESC LIMIT 200`).all();
  const clients = db.prepare('SELECT id,name FROM clients ORDER BY name').all();
  res.render('vehicles/list', { title: 'Pojazdy', vehicles, clients, q });
});

app.get('/vehicles/new', authRequired, (req, res) => {
  const clients = db.prepare('SELECT id,name FROM clients ORDER BY name').all();
  res.render('vehicles/form', { title: 'Nowy pojazd', vehicle: { client_id: req.query.client_id || '' }, clients, action: '/vehicles' });
});

app.post('/vehicles', authRequired, (req, res) => {
  const vin = normalizeVin(req.body.vin);
  if (vin) {
    const check = validateVin(vin);
    if (!check.valid) { setFlash(req, 'error', check.error); return res.redirect(appUrl(req.body.return_to || '/vehicles')); }
  }
  try {
    const result = db.prepare(`INSERT INTO vehicles (client_id,vin,registration,make,model,year,engine,fuel,mileage,color,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.body.client_id, vin || null, String(req.body.registration || '').toUpperCase() || null,
      req.body.make || null, req.body.model || null, req.body.year || null, req.body.engine || null, req.body.fuel || null,
      req.body.mileage || null, req.body.color || null, req.body.notes || null);
    audit(req.session.user.id, 'create', 'vehicle', result.lastInsertRowid, { vin });
    setFlash(req, 'success', 'Pojazd został dodany.');
    res.redirect(appUrl(req.body.return_to || `/vehicles/${result.lastInsertRowid}`));
  } catch (error) {
    setFlash(req, 'error', error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Pojazd o takim VIN już istnieje.' : error.message);
    res.redirect(appUrl(req.body.return_to || '/vehicles'));
  }
});

app.get('/vehicles/:id', authRequired, (req, res) => {
  const vehicle = db.prepare(`SELECT v.*, c.name client_name, c.id client_id FROM vehicles v JOIN clients c ON c.id=v.client_id WHERE v.id=?`).get(req.params.id);
  if (!vehicle) return res.status(404).render('error', { title: 'Brak pojazdu', message: 'Nie znaleziono pojazdu.' });
  const orders = db.prepare('SELECT * FROM work_orders WHERE vehicle_id=? ORDER BY id DESC').all(vehicle.id);
  res.render('vehicles/show', { title: `${vehicle.make || ''} ${vehicle.model || ''}`.trim() || vehicle.registration, vehicle, orders });
});

app.get('/vehicles/:id/edit', authRequired, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(req.params.id);
  const clients = db.prepare('SELECT id,name FROM clients ORDER BY name').all();
  if (!vehicle) return res.status(404).send('Nie znaleziono pojazdu.');
  res.render('vehicles/form', { title: 'Edycja pojazdu', vehicle, clients, action: `/vehicles/${vehicle.id}` });
});

app.post('/vehicles/:id', authRequired, (req, res) => {
  const vin = normalizeVin(req.body.vin);
  if (vin) {
    const check = validateVin(vin);
    if (!check.valid) { setFlash(req, 'error', check.error); return res.redirect(appUrl(`/vehicles/${req.params.id}/edit`)); }
  }
  try {
    db.prepare(`UPDATE vehicles SET client_id=?,vin=?,registration=?,make=?,model=?,year=?,engine=?,fuel=?,mileage=?,color=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(req.body.client_id, vin || null, String(req.body.registration || '').toUpperCase() || null, req.body.make || null,
        req.body.model || null, req.body.year || null, req.body.engine || null, req.body.fuel || null, req.body.mileage || null,
        req.body.color || null, req.body.notes || null, req.params.id);
    audit(req.session.user.id, 'update', 'vehicle', req.params.id);
    setFlash(req, 'success', 'Dane pojazdu zapisane.');
    res.redirect(appUrl(`/vehicles/${req.params.id}`));
  } catch (error) {
    setFlash(req, 'error', error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Pojazd o takim VIN już istnieje.' : error.message);
    res.redirect(appUrl(`/vehicles/${req.params.id}/edit`));
  }
});

app.post('/api/vin/decode', authRequired, async (req, res, next) => {
  try {
    const check = validateVin(req.body.vin);
    if (!check.valid) return res.status(400).json({ ok: false, error: check.error });
    const data = await decodeVin(check.vin);
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

app.get('/orders', authRequired, (req, res) => {
  const status = String(req.query.status || '');
  const q = String(req.query.q || '').trim();
  const priceMode = req.query.price === 'gross' ? 'gross' : 'net';
  let sql = `SELECT w.*, c.name client_name, c.phone client_phone, v.registration, v.make, v.model,
    COALESCE(SUM(i.quantity * i.unit_price_net),0) total_net,
    COALESCE(SUM(i.quantity * i.unit_price_net * (1 + i.vat_rate / 100.0)),0) total_gross
    FROM work_orders w
    JOIN clients c ON c.id=w.client_id
    JOIN vehicles v ON v.id=w.vehicle_id
    LEFT JOIN work_order_items i ON i.work_order_id=w.id
    WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND w.status=?'; params.push(status); }
  if (q) { sql += ' AND (w.number LIKE ? OR c.name LIKE ? OR v.registration LIKE ? OR v.vin LIKE ?)'; params.push(...Array(4).fill(`%${q}%`)); }
  sql += ' GROUP BY w.id ORDER BY w.id DESC LIMIT 250';
  const orders = db.prepare(sql).all(...params);
  const vehicles = db.prepare(`SELECT v.id,v.client_id,v.registration,v.make,v.model,c.name client_name
    FROM vehicles v JOIN clients c ON c.id=v.client_id ORDER BY c.name,v.registration`).all();
  const clients = db.prepare('SELECT id,name FROM clients ORDER BY name').all();
  res.render('orders/list', { title: 'Zlecenia', orders, vehicles, clients, status, q, priceMode });
});

app.get('/orders/new', authRequired, (_req, res) => res.redirect(appUrl('/orders?new=1')));

function validateNewVehiclePayload(body) {
  const vin = normalizeVin(body.vehicle_vin || body.vin);
  if (vin) {
    const check = validateVin(vin);
    if (!check.valid) throw new Error(check.error);
  }
  const registration = String(body.vehicle_registration || body.registration || '').trim().toUpperCase();
  if (!registration && !vin) throw new Error('Podaj numer rejestracyjny albo VIN pojazdu.');
  return {
    vin: vin || null,
    registration: registration || null,
    make: String(body.vehicle_make || body.make || '').trim() || null,
    model: String(body.vehicle_model || body.model || '').trim() || null,
    year: body.vehicle_year || body.year || null,
    engine: String(body.vehicle_engine || body.engine || '').trim() || null,
    fuel: String(body.vehicle_fuel || body.fuel || '').trim() || null,
    mileage: body.mileage_in || body.vehicle_mileage || null,
    color: String(body.vehicle_color || '').trim() || null,
    notes: String(body.vehicle_notes || '').trim() || null
  };
}

app.post('/orders', authRequired, (req, res) => {
  const mode = ['existing_vehicle','new_vehicle','new_client_vehicle'].includes(req.body.creation_mode)
    ? req.body.creation_mode : 'existing_vehicle';
  try {
    const create = db.transaction(() => {
      let clientId;
      let vehicleId;
      if (mode === 'existing_vehicle') {
        const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(req.body.vehicle_id);
        if (!vehicle) throw new Error('Wybierz istniejący pojazd.');
        clientId = Number(vehicle.client_id);
        vehicleId = Number(vehicle.id);
      } else {
        if (mode === 'new_client_vehicle') {
          const clientName = String(req.body.client_name || '').trim();
          if (!clientName) throw new Error('Podaj nazwę lub imię i nazwisko klienta.');
          const client = db.prepare(`INSERT INTO clients (type,name,nip,email,phone,address,notes) VALUES (?,?,?,?,?,?,?)`).run(
            req.body.client_type || 'person', clientName, req.body.client_nip || null, req.body.client_email || null,
            req.body.client_phone || null, req.body.client_address || null, req.body.client_notes || null
          );
          clientId = Number(client.lastInsertRowid);
          audit(req.session.user.id, 'create', 'client', clientId, { source: 'order_modal' });
        } else {
          const client = db.prepare('SELECT id FROM clients WHERE id=?').get(req.body.client_id);
          if (!client) throw new Error('Wybierz klienta dla nowego pojazdu.');
          clientId = Number(client.id);
        }
        const vehicle = validateNewVehiclePayload(req.body);
        const createdVehicle = db.prepare(`INSERT INTO vehicles (client_id,vin,registration,make,model,year,engine,fuel,mileage,color,notes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(clientId, vehicle.vin, vehicle.registration, vehicle.make, vehicle.model,
            vehicle.year, vehicle.engine, vehicle.fuel, vehicle.mileage, vehicle.color, vehicle.notes);
        vehicleId = Number(createdVehicle.lastInsertRowid);
        audit(req.session.user.id, 'create', 'vehicle', vehicleId, { source: 'order_modal', vin: vehicle.vin });
      }

      const number = nextNumber('ZL', 'work_orders');
      const token = crypto.randomBytes(24).toString('hex');
      const priceMode = req.body.price_mode === 'gross' ? 'gross' : 'net';
      const result = db.prepare(`INSERT INTO work_orders
        (number,client_id,vehicle_id,status,complaint,diagnosis,notes,mileage_in,fuel_level,scheduled_for,acceptance_token,price_mode)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(number, clientId, vehicleId, req.body.status || 'draft', req.body.complaint || null,
          req.body.diagnosis || null, req.body.notes || null, req.body.mileage_in || null, req.body.fuel_level || null,
          req.body.scheduled_for || null, token, priceMode);
      if (req.body.mileage_in) db.prepare('UPDATE vehicles SET mileage=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.mileage_in, vehicleId);
      audit(req.session.user.id, 'create', 'work_order', result.lastInsertRowid, { number, source: 'modal' });
      return { id: Number(result.lastInsertRowid), number };
    });
    const order = create();
    setFlash(req, 'success', `Utworzono zlecenie ${order.number}.`);
    res.redirect(appUrl(`/orders/${order.id}`));
  } catch (error) {
    setFlash(req, 'error', error.message.includes('UNIQUE') ? 'Pojazd o takim VIN już istnieje.' : error.message);
    res.redirect(appUrl('/orders?new=1'));
  }
});

function getOrder(id) {
  return db.prepare(`SELECT w.*, c.name client_name,c.email client_email,c.phone client_phone,c.nip client_nip,c.address client_address,
    v.registration,v.vin,v.make,v.model,v.year,v.engine,v.fuel,v.mileage
    FROM work_orders w JOIN clients c ON c.id=w.client_id JOIN vehicles v ON v.id=w.vehicle_id WHERE w.id=?`).get(id);
}

app.get('/orders/:id', authRequired, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).render('error', { title: 'Brak zlecenia', message: 'Nie znaleziono zlecenia.' });
  const items = db.prepare('SELECT * FROM work_order_items WHERE work_order_id=? ORDER BY id').all(order.id);
  const protocols = db.prepare('SELECT * FROM protocols WHERE work_order_id=? ORDER BY id DESC').all(order.id);
  const attachments = db.prepare('SELECT * FROM attachments WHERE work_order_id=? ORDER BY id DESC').all(order.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE work_order_id=? ORDER BY id DESC LIMIT 1').get(order.id);
  const priceMode = req.query.price === 'gross' || (req.query.price !== 'net' && order.price_mode === 'gross') ? 'gross' : 'net';
  res.render('orders/show', { title: order.number, order, items, totals: sumItems(items), protocols, attachments, invoice, priceMode,
    acceptanceUrl: `${config.baseUrl.replace(/\/$/, '')}/accept/${order.acceptance_token}` });
});

app.post('/orders/:id/price-mode', authRequired, (req, res) => {
  const priceMode = req.body.price_mode === 'gross' ? 'gross' : 'net';
  db.prepare('UPDATE work_orders SET price_mode=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(priceMode, req.params.id);
  audit(req.session.user.id, 'update_price_mode', 'work_order', req.params.id, { priceMode });
  res.redirect(appUrl(`/orders/${req.params.id}?price=${priceMode}`));
});

app.get('/orders/:id/edit', authRequired, (req, res) => {
  const order = getOrder(req.params.id);
  const vehicles = db.prepare(`SELECT v.id,v.client_id,v.registration,v.make,v.model,c.name client_name FROM vehicles v JOIN clients c ON c.id=v.client_id ORDER BY c.name,v.registration`).all();
  if (!order) return res.status(404).send('Nie znaleziono zlecenia.');
  res.render('orders/form', { title: 'Edycja zlecenia', order, vehicles, action: `/orders/${order.id}` });
});

app.post('/orders/:id', authRequired, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(req.body.vehicle_id);
  if (!vehicle) { setFlash(req, 'error', 'Wybierz pojazd.'); return res.redirect(appUrl(`/orders/${req.params.id}/edit`)); }
  db.prepare(`UPDATE work_orders SET client_id=?,vehicle_id=?,status=?,complaint=?,diagnosis=?,notes=?,mileage_in=?,fuel_level=?,scheduled_for=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(vehicle.client_id, vehicle.id, req.body.status, req.body.complaint || null, req.body.diagnosis || null, req.body.notes || null,
      req.body.mileage_in || null, req.body.fuel_level || null, req.body.scheduled_for || null, req.params.id);
  if (req.body.mileage_in) db.prepare('UPDATE vehicles SET mileage=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.mileage_in, vehicle.id);
  audit(req.session.user.id, 'update', 'work_order', req.params.id);
  setFlash(req, 'success', 'Zlecenie zapisane.');
  res.redirect(appUrl(`/orders/${req.params.id}`));
});

app.post('/orders/:id/items', authRequired, (req, res) => {
  const settings = getSettings();
  const type = ['labor','part','material','service'].includes(req.body.type) ? req.body.type : 'labor';
  const description = String(req.body.description || '').trim();
  if (!description) { setFlash(req, 'error', 'Podaj nazwę pozycji.'); return res.redirect(appUrl(`/orders/${req.params.id}`)); }
  const vatRate = Number(req.body.vat_rate === '' || req.body.vat_rate == null ? settings.labor_vat_rate : req.body.vat_rate);
  const quantity = type === 'labor' ? Number(req.body.hours || req.body.quantity || 1) : Number(req.body.quantity || 1);
  const unit = type === 'labor' ? 'rbh' : (req.body.unit || 'szt.');
  const rawPrice = req.body.price_input ?? req.body.unit_price_net;
  const enteredPrice = rawPrice === '' || rawPrice == null
    ? (type === 'labor' ? settings.labor_sale_rate_net : 0) : Number(rawPrice);
  const inputMode = req.body.input_price_mode === 'gross' ? 'gross' : 'net';
  const unitPriceNet = inputMode === 'gross' ? round2(enteredPrice / (1 + vatRate / 100)) : round2(enteredPrice);
  const costNet = req.body.cost_net === '' || req.body.cost_net == null
    ? (type === 'labor' ? settings.labor_cost_rate_net : 0) : Number(req.body.cost_net);
  if (!(quantity > 0)) { setFlash(req, 'error', 'Ilość lub liczba RBH musi być większa od zera.'); return res.redirect(appUrl(`/orders/${req.params.id}`)); }
  const result = db.prepare(`INSERT INTO work_order_items (work_order_id,type,description,quantity,unit,unit_price_net,vat_rate,cost_net) VALUES (?,?,?,?,?,?,?,?)`)
    .run(req.params.id, type, description, quantity, unit, unitPriceNet, vatRate, costNet);
  audit(req.session.user.id, 'create', 'work_order_item', result.lastInsertRowid, { work_order_id: req.params.id, type, quantity });
  setFlash(req, 'success', type === 'labor' ? `Dodano ${quantity} RBH.` : 'Pozycja została dodana.');
  res.redirect(appUrl(`/orders/${req.params.id}?price=${inputMode}`));
});

app.post('/orders/:orderId/items/:itemId/delete', authRequired, (req, res) => {
  db.prepare('DELETE FROM work_order_items WHERE id=? AND work_order_id=?').run(req.params.itemId, req.params.orderId);
  audit(req.session.user.id, 'delete', 'work_order_item', req.params.itemId);
  setFlash(req, 'success', 'Pozycja usunięta.');
  res.redirect(appUrl(`/orders/${req.params.orderId}`));
});

app.post('/orders/:id/attachments', authRequired, upload.array('files', 8), (req, res) => {
  const insert = db.prepare('INSERT INTO attachments (work_order_id,filename,original_name,mime_type) VALUES (?,?,?,?)');
  const tx = db.transaction((files) => files.forEach(file => insert.run(req.params.id, file.filename, file.originalname, file.mimetype)));
  tx(req.files || []);
  audit(req.session.user.id, 'upload', 'work_order', req.params.id, { count: req.files?.length || 0 });
  setFlash(req, 'success', `Dodano pliki: ${req.files?.length || 0}.`);
  res.redirect(appUrl(`/orders/${req.params.id}`));
});

app.post('/orders/:id/protocols', authRequired, (req, res) => {
  const type = req.body.type === 'release' ? 'release' : 'intake';
  const body = {
    documents: req.body.documents, keys: req.body.keys, spare: req.body.spare, multimedia: req.body.multimedia,
    damage: req.body.damage, notes: req.body.notes, vehicle_condition: req.body.vehicle_condition,
    equipment: req.body.equipment, complaint_confirmed: req.body.complaint_confirmed,
    work_summary: req.body.work_summary, recommendations: req.body.recommendations,
    released_to: req.body.released_to, payment_status: req.body.payment_status
  };
  const result = db.prepare(`INSERT INTO protocols (work_order_id,type,body_json,signed_by,signed_at) VALUES (?,?,?,?,?)`)
    .run(req.params.id, type, JSON.stringify(body), req.body.signed_by || null, req.body.signed_by ? new Date().toISOString() : null);
  audit(req.session.user.id, 'create', 'protocol', result.lastInsertRowid, { type });
  setFlash(req, 'success', 'Protokół został zapisany.');
  res.redirect(appUrl(`/orders/${req.params.id}`));
});

app.get('/protocols/:id/pdf', authRequired, async (req, res, next) => {
  try {
    const file = await generateProtocolPdf(req.params.id);
    res.download(file.filepath, file.filename);
  } catch (error) { next(error); }
});

app.get('/accept/:token', (req, res) => {
  const order = db.prepare(`SELECT w.*, c.name client_name, v.registration,v.make,v.model FROM work_orders w JOIN clients c ON c.id=w.client_id JOIN vehicles v ON v.id=w.vehicle_id WHERE w.acceptance_token=?`).get(req.params.token);
  if (!order) return res.status(404).render('error', { title: 'Nieprawidłowy link', message: 'Nie znaleziono wyceny lub link wygasł.' });
  const items = db.prepare('SELECT * FROM work_order_items WHERE work_order_id=? ORDER BY id').all(order.id);
  res.render('accept', { title: `Akceptacja ${order.number}`, order, items, totals: sumItems(items) });
});

app.post('/accept/:token', (req, res) => {
  const order = db.prepare('SELECT * FROM work_orders WHERE acceptance_token=?').get(req.params.token);
  if (!order) return res.status(404).send('Nie znaleziono wyceny.');
  if (!req.body.accepted) return res.status(400).send('Potwierdź akceptację wyceny.');
  db.prepare(`UPDATE work_orders SET status='approved',accepted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(order.id);
  audit(null, 'public_accept', 'work_order', order.id, { ip: req.ip, name: req.body.name });
  res.render('accepted', { title: 'Wycena zaakceptowana', order });
});

app.get('/invoices', authRequired, (req, res) => {
  const invoices = db.prepare(`SELECT i.*,c.name client_name FROM invoices i JOIN clients c ON c.id=i.client_id ORDER BY i.id DESC LIMIT 250`).all();
  res.render('invoices/list', { title: 'Faktury', invoices });
});

app.post('/orders/:id/invoice', authRequired, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Nie znaleziono zlecenia.');
  const items = db.prepare('SELECT * FROM work_order_items WHERE work_order_id=?').all(order.id);
  if (!items.length) { setFlash(req, 'error', 'Dodaj przynajmniej jedną pozycję do zlecenia.'); return res.redirect(appUrl(`/orders/${order.id}`)); }
  const existing = db.prepare('SELECT id FROM invoices WHERE work_order_id=? AND status != ?').get(order.id, 'cancelled');
  if (existing) return res.redirect(appUrl(`/invoices/${existing.id}`));
  const today = new Date();
  const due = new Date(today); due.setDate(due.getDate() + 7);
  const date = today.toISOString().slice(0, 10);
  const dueDate = due.toISOString().slice(0, 10);
  const number = nextNumber('FV', 'invoices');
  const tx = db.transaction(() => {
    const invoice = db.prepare(`INSERT INTO invoices (number,client_id,work_order_id,issue_date,sale_date,due_date,payment_method,status) VALUES (?,?,?,?,?,?,?,'issued')`)
      .run(number, order.client_id, order.id, date, date, dueDate, req.body.payment_method || 'transfer');
    const insert = db.prepare(`INSERT INTO invoice_items (invoice_id,description,quantity,unit,unit_price_net,vat_rate) VALUES (?,?,?,?,?,?)`);
    for (const item of items) insert.run(invoice.lastInsertRowid, item.description, item.quantity, item.unit, item.unit_price_net, item.vat_rate);
    return Number(invoice.lastInsertRowid);
  });
  const invoiceId = tx();
  audit(req.session.user.id, 'create', 'invoice', invoiceId, { number, work_order_id: order.id });
  setFlash(req, 'success', `Utworzono fakturę ${number}.`);
  res.redirect(appUrl(`/invoices/${invoiceId}`));
});

app.get('/invoices/:id', authRequired, (req, res) => {
  const invoice = db.prepare(`SELECT i.*,c.name client_name,c.email client_email,c.nip client_nip,c.address client_address,w.number work_order_number
    FROM invoices i JOIN clients c ON c.id=i.client_id LEFT JOIN work_orders w ON w.id=i.work_order_id WHERE i.id=?`).get(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Brak faktury', message: 'Nie znaleziono faktury.' });
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id').all(invoice.id);
  const jobs = db.prepare('SELECT * FROM ksef_jobs WHERE invoice_id=? ORDER BY id DESC').all(invoice.id);
  res.render('invoices/show', { title: invoice.number, invoice, items, totals: sumItems(items), jobs, ksefStatus: ksef.status(), smtpConfigured: mail.configured() });
});

app.post('/invoices/:id/status', authRequired, (req, res) => {
  const allowed = ['draft', 'issued', 'sent', 'paid', 'cancelled'];
  const status = allowed.includes(req.body.status) ? req.body.status : 'issued';
  db.prepare('UPDATE invoices SET status=? WHERE id=?').run(status, req.params.id);
  audit(req.session.user.id, 'update_status', 'invoice', req.params.id, { status });
  setFlash(req, 'success', 'Status faktury zmieniony.');
  res.redirect(appUrl(`/invoices/${req.params.id}`));
});

app.get('/invoices/:id/pdf', authRequired, async (req, res, next) => {
  try {
    const file = await generateInvoicePdf(req.params.id);
    res.download(file.filepath, file.filename);
  } catch (error) { next(error); }
});

app.post('/invoices/:id/email', authRequired, async (req, res, next) => {
  try {
    const invoice = db.prepare(`SELECT i.*,c.email client_email FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=?`).get(req.params.id);
    if (!invoice) throw new Error('Nie znaleziono faktury.');
    const file = await generateInvoicePdf(invoice.id);
    await mail.sendDocument({ to: req.body.to || invoice.client_email, subject: `Faktura ${invoice.number}`, text: `Dzień dobry,\n\nw załączeniu przesyłamy fakturę ${invoice.number}.\n\n${config.company.name}`, attachmentPath: file.filepath, filename: file.filename });
    db.prepare("UPDATE invoices SET status=CASE WHEN status='paid' THEN status ELSE 'sent' END WHERE id=?").run(invoice.id);
    audit(req.session.user.id, 'email', 'invoice', invoice.id, { to: req.body.to || invoice.client_email });
    setFlash(req, 'success', 'Faktura została wysłana e-mailem.');
    res.redirect(appUrl(`/invoices/${invoice.id}`));
  } catch (error) { next(error); }
});

app.post('/invoices/:id/ksef', authRequired, (req, res, next) => {
  try {
    const jobId = ksef.queueInvoice(Number(req.params.id));
    audit(req.session.user.id, 'queue_ksef', 'invoice', req.params.id, { jobId, mode: ksef.status().mode });
    setFlash(req, 'success', `Faktura dodana do kolejki KSeF (${ksef.status().mode}).`);
    res.redirect(appUrl(`/invoices/${req.params.id}`));
  } catch (error) { next(error); }
});

app.post('/ksef/process', authRequired, (req, res, next) => {
  try {
    const processed = ksef.processQueued();
    audit(req.session.user.id, 'process', 'ksef_jobs', null, { count: processed.length, mode: ksef.status().mode });
    setFlash(req, 'success', `Przetworzono zadań KSeF: ${processed.length}.`);
    res.redirect(req.get('referer') || appUrl('/'));
  } catch (error) { next(error); }
});


// --- Zadania, terminarz, zakupy, magazyn i katalog dostawców ---
function todayIso() { return new Date().toISOString().slice(0, 10); }
function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function openOrders() {
  return db.prepare(`SELECT w.id,w.number,w.status,c.name client_name,v.registration,v.make,v.model
    FROM work_orders w JOIN clients c ON c.id=w.client_id JOIN vehicles v ON v.id=w.vehicle_id
    WHERE w.status NOT IN ('completed','cancelled') ORDER BY w.id DESC LIMIT 200`).all();
}
function upsertInventoryProduct(item, quantity, userId, notes, purchaseItemId = null) {
  const qty = Math.max(0, safeNumber(quantity, 1));
  if (!(qty > 0)) throw new Error('Ilość musi być większa od zera.');
  let product = item.product_id ? db.prepare('SELECT * FROM inventory_products WHERE id=?').get(item.product_id) : null;
  if (!product && item.supplier_id && item.supplier_sku) {
    product = db.prepare('SELECT * FROM inventory_products WHERE supplier_id=? AND supplier_sku=?').get(item.supplier_id, item.supplier_sku);
  }
  if (!product) {
    const created = db.prepare(`INSERT INTO inventory_products
      (supplier_id,supplier_sku,manufacturer,manufacturer_sku,name,unit,vat_rate,purchase_price_net,sale_price_net,stock_qty)
      VALUES (?,?,?,?,?,?,?,?,?,0)`).run(item.supplier_id || null, item.supplier_sku || null, item.manufacturer || null,
        item.manufacturer_sku || null, item.name, item.unit || 'szt.', safeNumber(item.vat_rate, 23),
        safeNumber(item.purchase_price_net), safeNumber(item.suggested_sale_price_net || item.sale_price_net));
    product = db.prepare('SELECT * FROM inventory_products WHERE id=?').get(created.lastInsertRowid);
  }
  const unitCost = safeNumber(item.purchase_price_net, product.purchase_price_net);
  db.prepare(`UPDATE inventory_products SET stock_qty=stock_qty+?,purchase_price_net=?,
    sale_price_net=CASE WHEN sale_price_net<=0 AND ?>0 THEN ? ELSE sale_price_net END,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(qty, unitCost, safeNumber(item.suggested_sale_price_net || item.sale_price_net), safeNumber(item.suggested_sale_price_net || item.sale_price_net), product.id);
  db.prepare(`INSERT INTO stock_movements (product_id,type,quantity,unit_cost_net,purchase_document_item_id,notes) VALUES (?,?,?,?,?,?)`)
    .run(product.id, 'receipt', qty, unitCost, purchaseItemId, notes || 'Przyjęcie do magazynu');
  if (purchaseItemId) db.prepare('UPDATE purchase_document_items SET product_id=?,added_to_stock=1 WHERE id=?').run(product.id, purchaseItemId);
  audit(userId, 'stock_receipt', 'inventory_product', product.id, { quantity: qty, purchaseItemId });
  return product.id;
}
function addPartToOrder(item, workOrderId, quantity, userId, purchaseItemId = null) {
  const order = db.prepare("SELECT id FROM work_orders WHERE id=? AND status NOT IN ('completed','cancelled')").get(workOrderId);
  if (!order) throw new Error('Wybierz aktualne, otwarte zlecenie.');
  const qty = Math.max(0, safeNumber(quantity, 1));
  if (!(qty > 0)) throw new Error('Ilość musi być większa od zera.');
  const price = safeNumber(item.suggested_sale_price_net || item.sale_price_net || item.purchase_price_net);
  const result = db.prepare(`INSERT INTO work_order_items
    (work_order_id,type,description,quantity,unit,unit_price_net,vat_rate,cost_net) VALUES (?,'part',?,?,?,?,?,?)`)
    .run(workOrderId, [item.manufacturer, item.name, item.manufacturer_sku].filter(Boolean).join(' · '), qty,
      item.unit || 'szt.', price, safeNumber(item.vat_rate, 23), safeNumber(item.purchase_price_net));
  if (purchaseItemId) db.prepare('UPDATE purchase_document_items SET work_order_id=? WHERE id=?').run(workOrderId, purchaseItemId);
  audit(userId, 'add_supplier_item_to_order', 'work_order_item', result.lastInsertRowid, { workOrderId, purchaseItemId });
  return result.lastInsertRowid;
}

app.get('/tasks', authRequired, (req, res) => {
  const status = String(req.query.status || 'open');
  let sql = `SELECT t.*,w.number work_order_number,c.name client_name,v.registration,v.make,v.model,u.name assigned_name
    FROM tasks t LEFT JOIN work_orders w ON w.id=t.work_order_id LEFT JOIN clients c ON c.id=w.client_id
    LEFT JOIN vehicles v ON v.id=w.vehicle_id LEFT JOIN users u ON u.id=t.assigned_to WHERE 1=1`;
  const params = [];
  if (status === 'open') sql += " AND t.status!='done'";
  else if (['todo','in_progress','done'].includes(status)) { sql += ' AND t.status=?'; params.push(status); }
  sql += ` ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
    COALESCE(t.planned_date,'9999-12-31'),t.id DESC`;
  const tasks = db.prepare(sql).all(...params);
  const users = db.prepare('SELECT id,name FROM users ORDER BY name').all();
  res.render('tasks/list', { title: 'Zadania', tasks, orders: openOrders(), users, status });
});

app.post('/tasks', authRequired, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) { setFlash(req, 'error', 'Podaj nazwę zadania.'); return res.redirect(appUrl('/tasks')); }
  const result = db.prepare(`INSERT INTO tasks (work_order_id,title,description,status,priority,planned_date,estimated_hours,assigned_to)
    VALUES (?,?,?,?,?,?,?,?)`).run(req.body.work_order_id || null, title, req.body.description || null, 'todo',
      ['low','normal','high','urgent'].includes(req.body.priority) ? req.body.priority : 'normal', req.body.planned_date || null,
      Math.max(0, safeNumber(req.body.estimated_hours)), req.body.assigned_to || req.session.user.id);
  audit(req.session.user.id, 'create', 'task', result.lastInsertRowid, { title });
  setFlash(req, 'success', 'Zadanie zostało dodane.');
  res.redirect(appUrl('/tasks'));
});

app.post('/tasks/:id/status', authRequired, (req, res) => {
  const status = ['todo','in_progress','done'].includes(req.body.status) ? req.body.status : 'todo';
  db.prepare('UPDATE tasks SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, req.params.id);
  audit(req.session.user.id, 'update_status', 'task', req.params.id, { status });
  res.redirect(req.get('referer') || appUrl('/tasks'));
});

app.get('/calendar', authRequired, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : todayIso();
  const resources = db.prepare('SELECT * FROM calendar_resources WHERE active=1 ORDER BY id').all();
  const events = db.prepare(`SELECT e.*,r.name resource_name,w.number work_order_number,c.name client_name,v.registration
    FROM calendar_events e LEFT JOIN calendar_resources r ON r.id=e.resource_id LEFT JOIN work_orders w ON w.id=e.work_order_id
    LEFT JOIN clients c ON c.id=w.client_id LEFT JOIN vehicles v ON v.id=w.vehicle_id
    WHERE date(e.starts_at)=? ORDER BY e.starts_at`).all(date);
  const scheduledOrderIds = new Set(db.prepare('SELECT DISTINCT work_order_id FROM calendar_events WHERE work_order_id IS NOT NULL').all().map(row => row.work_order_id));
  const unscheduled = openOrders().filter(order => !scheduledOrderIds.has(order.id));
  res.render('calendar/day', { title: 'Terminarz', date, resources, events, unscheduled, orders: openOrders() });
});

app.post('/calendar/events', authRequired, (req, res) => {
  const title = String(req.body.title || '').trim();
  const startsAt = String(req.body.starts_at || '').trim();
  const endsAt = String(req.body.ends_at || '').trim();
  if (!title || !startsAt || !endsAt || new Date(endsAt) <= new Date(startsAt)) {
    setFlash(req, 'error', 'Podaj nazwę oraz prawidłowy czas rozpoczęcia i zakończenia.');
    return res.redirect(appUrl(`/calendar?date=${String(startsAt).slice(0,10) || todayIso()}`));
  }
  const result = db.prepare(`INSERT INTO calendar_events (work_order_id,resource_id,title,starts_at,ends_at,status,notes)
    VALUES (?,?,?,?,?,'planned',?)`).run(req.body.work_order_id || null, req.body.resource_id || null, title, startsAt, endsAt, req.body.notes || null);
  audit(req.session.user.id, 'create', 'calendar_event', result.lastInsertRowid, { startsAt, endsAt });
  setFlash(req, 'success', 'Termin został zapisany.');
  res.redirect(appUrl(`/calendar?date=${startsAt.slice(0,10)}`));
});

app.post('/calendar/events/:id/delete', authRequired, (req, res) => {
  const event = db.prepare('SELECT starts_at FROM calendar_events WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM calendar_events WHERE id=?').run(req.params.id);
  audit(req.session.user.id, 'delete', 'calendar_event', req.params.id);
  res.redirect(appUrl(`/calendar?date=${event ? event.starts_at.slice(0,10) : todayIso()}`));
});

app.get('/purchases', authRequired, (req, res) => {
  const documents = db.prepare(`SELECT d.*,s.name supplier_name,
    COALESCE(SUM(i.quantity*i.purchase_price_net),0) total_net,
    COALESCE(SUM(i.quantity*i.purchase_price_net*(1+i.vat_rate/100.0)),0) total_gross
    FROM purchase_documents d LEFT JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN purchase_document_items i ON i.purchase_document_id=d.id
    GROUP BY d.id ORDER BY d.issue_date DESC,d.id DESC`).all();
  const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
  res.render('purchases/list', { title: 'Zakupy i WZ', documents, suppliers });
});

app.post('/purchases', authRequired, (req, res) => {
  const number = String(req.body.number || '').trim() || nextNumber(String(req.body.type || 'WZ').toUpperCase(), 'purchase_documents');
  try {
    const result = db.prepare(`INSERT INTO purchase_documents (supplier_id,type,number,issue_date,status,reference,notes) VALUES (?,?,?,?,?,?,?)`)
      .run(req.body.supplier_id || null, ['wz','invoice','receipt'].includes(req.body.type) ? req.body.type : 'wz', number,
        req.body.issue_date || todayIso(), 'received', req.body.reference || null, req.body.notes || null);
    audit(req.session.user.id, 'create', 'purchase_document', result.lastInsertRowid, { number });
    res.redirect(appUrl(`/purchases/${result.lastInsertRowid}`));
  } catch (error) {
    setFlash(req, 'error', error.message.includes('UNIQUE') ? 'Taki dokument dostawcy już istnieje.' : error.message);
    res.redirect(appUrl('/purchases'));
  }
});

app.get('/purchases/:id', authRequired, (req, res) => {
  const document = db.prepare(`SELECT d.*,s.name supplier_name,s.code supplier_code FROM purchase_documents d LEFT JOIN suppliers s ON s.id=d.supplier_id WHERE d.id=?`).get(req.params.id);
  if (!document) return res.status(404).render('error', { title: 'Brak dokumentu', message: 'Nie znaleziono dokumentu zakupu.' });
  const items = db.prepare('SELECT * FROM purchase_document_items WHERE purchase_document_id=? ORDER BY id').all(document.id);
  res.render('purchases/show', { title: `${document.type.toUpperCase()} ${document.number}`, document, items, orders: openOrders() });
});

app.post('/purchases/:id/items', authRequired, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'Podaj nazwę towaru.'); return res.redirect(appUrl(`/purchases/${req.params.id}`)); }
  const result = db.prepare(`INSERT INTO purchase_document_items
    (purchase_document_id,supplier_sku,manufacturer,manufacturer_sku,name,quantity,unit,purchase_price_net,vat_rate)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(req.params.id, req.body.supplier_sku || null, req.body.manufacturer || null,
      req.body.manufacturer_sku || null, name, Math.max(0.01, safeNumber(req.body.quantity,1)), req.body.unit || 'szt.',
      Math.max(0, safeNumber(req.body.purchase_price_net)), Math.max(0, safeNumber(req.body.vat_rate,23)));
  audit(req.session.user.id, 'create', 'purchase_document_item', result.lastInsertRowid, { purchase_document_id: req.params.id });
  res.redirect(appUrl(`/purchases/${req.params.id}`));
});

app.post('/purchase-items/:id/add-stock', authRequired, (req, res) => {
  const item = db.prepare(`SELECT i.*,d.supplier_id FROM purchase_document_items i JOIN purchase_documents d ON d.id=i.purchase_document_id WHERE i.id=?`).get(req.params.id);
  if (!item) return res.status(404).send('Nie znaleziono pozycji WZ.');
  try { upsertInventoryProduct(item, req.body.quantity || item.quantity, req.session.user.id, `Dokument WZ ${item.purchase_document_id}`, item.id); setFlash(req, 'success', 'Towar dodano do magazynu.'); }
  catch (error) { setFlash(req, 'error', error.message); }
  res.redirect(appUrl(`/purchases/${item.purchase_document_id}`));
});

app.post('/purchase-items/:id/add-order', authRequired, (req, res) => {
  const item = db.prepare(`SELECT i.*,d.supplier_id FROM purchase_document_items i JOIN purchase_documents d ON d.id=i.purchase_document_id WHERE i.id=?`).get(req.params.id);
  if (!item) return res.status(404).send('Nie znaleziono pozycji WZ.');
  try { addPartToOrder(item, req.body.work_order_id, req.body.quantity || item.quantity, req.session.user.id, item.id); setFlash(req, 'success', 'Pozycję dodano do zlecenia.'); }
  catch (error) { setFlash(req, 'error', error.message); }
  res.redirect(appUrl(`/purchases/${item.purchase_document_id}`));
});

app.get('/inventory', authRequired, (req, res) => {
  const q = String(req.query.q || '').trim();
  const products = q ? db.prepare(`SELECT p.*,s.name supplier_name FROM inventory_products p LEFT JOIN suppliers s ON s.id=p.supplier_id
    WHERE p.name LIKE ? OR p.supplier_sku LIKE ? OR p.manufacturer_sku LIKE ? OR p.barcode LIKE ? ORDER BY p.name`)
    .all(...Array(4).fill(`%${q}%`)) : db.prepare(`SELECT p.*,s.name supplier_name FROM inventory_products p LEFT JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.name LIMIT 500`).all();
  const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
  res.render('inventory/list', { title: 'Magazyn', products, suppliers, q });
});

app.post('/inventory/products', authRequired, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'Podaj nazwę towaru.'); return res.redirect(appUrl('/inventory')); }
  const result = db.prepare(`INSERT INTO inventory_products
    (supplier_id,supplier_sku,manufacturer,manufacturer_sku,name,barcode,unit,vat_rate,purchase_price_net,sale_price_net,stock_qty,min_stock,location)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.body.supplier_id || null, req.body.supplier_sku || null, req.body.manufacturer || null,
      req.body.manufacturer_sku || null, name, req.body.barcode || null, req.body.unit || 'szt.', safeNumber(req.body.vat_rate,23),
      safeNumber(req.body.purchase_price_net), safeNumber(req.body.sale_price_net), safeNumber(req.body.stock_qty), safeNumber(req.body.min_stock), req.body.location || null);
  if (safeNumber(req.body.stock_qty) !== 0) db.prepare(`INSERT INTO stock_movements (product_id,type,quantity,unit_cost_net,notes) VALUES (?,'opening',?,?,?)`)
    .run(result.lastInsertRowid, safeNumber(req.body.stock_qty), safeNumber(req.body.purchase_price_net), 'Stan początkowy');
  audit(req.session.user.id, 'create', 'inventory_product', result.lastInsertRowid, { name });
  setFlash(req, 'success', 'Towar został utworzony.');
  res.redirect(appUrl('/inventory'));
});

app.post('/inventory/products/:id/adjust', authRequired, (req, res) => {
  const delta = safeNumber(req.body.quantity_delta);
  db.prepare('UPDATE inventory_products SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(delta, req.params.id);
  db.prepare(`INSERT INTO stock_movements (product_id,type,quantity,unit_cost_net,notes) SELECT id,'adjustment',?,purchase_price_net,? FROM inventory_products WHERE id=?`)
    .run(delta, req.body.notes || 'Korekta ręczna', req.params.id);
  audit(req.session.user.id, 'adjust_stock', 'inventory_product', req.params.id, { delta });
  res.redirect(appUrl('/inventory'));
});

app.get('/catalog', authRequired, (req, res) => {
  const tab = req.query.tab === 'wz' ? 'wz' : 'sales';
  const q = String(req.query.q || '').trim();
  const supplier = db.prepare("SELECT * FROM suppliers WHERE code='AUTOPARTNER'").get();
  let catalogItems = [];
  if (supplier) {
    catalogItems = q ? db.prepare(`SELECT * FROM supplier_catalog_items WHERE supplier_id=? AND
      (name LIKE ? OR supplier_sku LIKE ? OR manufacturer LIKE ? OR manufacturer_sku LIKE ?) ORDER BY name`)
      .all(supplier.id, ...Array(4).fill(`%${q}%`)) : db.prepare('SELECT * FROM supplier_catalog_items WHERE supplier_id=? ORDER BY name LIMIT 500').all(supplier.id);
  }
  const wzItems = db.prepare(`SELECT i.*,d.number document_number,d.issue_date,s.name supplier_name,d.supplier_id
    FROM purchase_document_items i JOIN purchase_documents d ON d.id=i.purchase_document_id LEFT JOIN suppliers s ON s.id=d.supplier_id
    ORDER BY i.id DESC LIMIT 500`).all();
  res.render('catalog/index', { title: 'Katalog części', tab, q, supplier, catalogItems, wzItems, orders: openOrders() });
});

app.post('/catalog/items/:id/add-stock', authRequired, (req, res) => {
  const item = db.prepare('SELECT * FROM supplier_catalog_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).send('Nie znaleziono pozycji katalogowej.');
  try { upsertInventoryProduct(item, req.body.quantity, req.session.user.id, 'Katalog Auto Partner'); setFlash(req, 'success', 'Pozycję katalogową dodano do magazynu.'); }
  catch (error) { setFlash(req, 'error', error.message); }
  res.redirect(appUrl('/catalog?tab=sales'));
});

app.post('/catalog/items/:id/add-order', authRequired, (req, res) => {
  const item = db.prepare('SELECT * FROM supplier_catalog_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).send('Nie znaleziono pozycji katalogowej.');
  try { addPartToOrder(item, req.body.work_order_id, req.body.quantity, req.session.user.id); setFlash(req, 'success', 'Pozycję katalogową dodano do zlecenia.'); }
  catch (error) { setFlash(req, 'error', error.message); }
  res.redirect(appUrl('/catalog?tab=sales'));
});

app.get('/cash', authRequired, (req, res) => {
  const transactions = db.prepare(`SELECT t.*,i.number invoice_number,d.number purchase_number FROM cash_transactions t
    LEFT JOIN invoices i ON i.id=t.invoice_id LEFT JOIN purchase_documents d ON d.id=t.purchase_document_id
    ORDER BY t.occurred_on DESC,t.id DESC LIMIT 500`).all();
  const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_gross ELSE 0 END),0) income,
    COALESCE(SUM(CASE WHEN type='expense' THEN amount_gross ELSE 0 END),0) expense FROM cash_transactions`).get();
  res.render('cash/list', { title: 'Kasa', transactions, totals });
});

app.post('/cash', authRequired, (req, res) => {
  const amount = Math.max(0, safeNumber(req.body.amount_gross));
  if (!(amount > 0)) { setFlash(req, 'error', 'Podaj kwotę większą od zera.'); return res.redirect(appUrl('/cash')); }
  const result = db.prepare(`INSERT INTO cash_transactions (type,category,amount_gross,payment_method,description,occurred_on) VALUES (?,?,?,?,?,?)`)
    .run(req.body.type === 'expense' ? 'expense' : 'income', req.body.category || 'inne', amount,
      req.body.payment_method || 'cash', req.body.description || null, req.body.occurred_on || todayIso());
  audit(req.session.user.id, 'create', 'cash_transaction', result.lastInsertRowid, { amount });
  res.redirect(appUrl('/cash'));
});

app.get('/reports', authRequired, (_req, res) => {
  const revenue = db.prepare(`SELECT COALESCE(SUM(ii.quantity*ii.unit_price_net),0) net,
    COALESCE(SUM(ii.quantity*ii.unit_price_net*(1+ii.vat_rate/100.0)),0) gross FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.status!='cancelled'`).get();
  const orderProfit = db.prepare(`SELECT COALESCE(SUM(quantity*unit_price_net),0) sales_net,COALESCE(SUM(quantity*cost_net),0) cost_net FROM work_order_items`).get();
  const purchases = db.prepare(`SELECT COALESCE(SUM(quantity*purchase_price_net),0) net FROM purchase_document_items`).get();
  const orderStatus = db.prepare('SELECT status,COUNT(*) count FROM work_orders GROUP BY status ORDER BY count DESC').all();
  const lowStock = db.prepare('SELECT * FROM inventory_products WHERE stock_qty<=min_stock ORDER BY stock_qty LIMIT 25').all();
  res.render('reports/index', { title: 'Raporty', revenue, orderProfit, purchases, orderStatus, lowStock });
});

app.get('/storage', authRequired, (_req, res) => {
  const items = db.prepare(`SELECT s.*,c.name client_name,v.registration,v.make,v.model FROM storage_items s JOIN clients c ON c.id=s.client_id
    LEFT JOIN vehicles v ON v.id=s.vehicle_id ORDER BY s.status,s.id DESC`).all();
  const clients = db.prepare('SELECT id,name FROM clients ORDER BY name').all();
  const vehicles = db.prepare('SELECT id,client_id,registration,make,model FROM vehicles ORDER BY registration').all();
  res.render('storage/list', { title: 'Przechowalnia', items, clients, vehicles });
});

app.post('/storage', authRequired, (req, res) => {
  const description = String(req.body.description || '').trim();
  if (!description) { setFlash(req, 'error', 'Podaj opis przechowywanych rzeczy.'); return res.redirect(appUrl('/storage')); }
  const result = db.prepare(`INSERT INTO storage_items (client_id,vehicle_id,type,description,location,season,status,accepted_on,notes)
    VALUES (?,?,?,?,?,?,'stored',?,?)`).run(req.body.client_id, req.body.vehicle_id || null, req.body.type || 'tyres', description,
      req.body.location || null, req.body.season || null, req.body.accepted_on || todayIso(), req.body.notes || null);
  audit(req.session.user.id, 'create', 'storage_item', result.lastInsertRowid);
  res.redirect(appUrl('/storage'));
});

app.post('/storage/:id/release', authRequired, (req, res) => {
  db.prepare("UPDATE storage_items SET status='released',released_on=? WHERE id=?").run(req.body.released_on || todayIso(), req.params.id);
  audit(req.session.user.id, 'release', 'storage_item', req.params.id);
  res.redirect(appUrl('/storage'));
});

app.get('/settings', authRequired, (_req, res) => {
  res.render('settings/index', { title: 'Ustawienia' });
});

app.get('/settings/workshop', authRequired, (_req, res) => {
  res.render('settings/workshop', { title: 'Stawki warsztatowe', formSettings: getSettings() });
});

app.post('/settings/workshop', authRequired, (req, res) => {
  const values = {
    labor_sale_rate_net: Math.max(0, Number(req.body.labor_sale_rate_net || 0)),
    labor_cost_rate_net: Math.max(0, Number(req.body.labor_cost_rate_net || 0)),
    labor_vat_rate: Math.max(0, Number(req.body.labor_vat_rate || 23)),
    default_price_mode: req.body.default_price_mode === 'gross' ? 'gross' : 'net',
    intake_protocol_enabled: req.body.intake_protocol_enabled ? '1' : '0',
    release_protocol_enabled: req.body.release_protocol_enabled ? '1' : '0'
  };
  saveSettings(values);
  audit(req.session.user.id, 'update', 'settings', null, { section: 'workshop' });
  setFlash(req, 'success', 'Stawki i ustawienia zleceń zostały zapisane.');
  res.redirect(appUrl('/settings/workshop'));
});

app.get('/settings/integrations', authRequired, (_req, res) => {
  const supplier = db.prepare("SELECT * FROM suppliers WHERE code='AUTOPARTNER'").get();
  res.render('settings/integrations', { title: 'Integracje', formSettings: getSettings(), supplier });
});

app.post('/settings/integrations', authRequired, (req, res) => {
  const mode = ['manual','csv','api_pending'].includes(req.body.autopartner_integration_mode) ? req.body.autopartner_integration_mode : 'manual';
  const catalogUrl = /^https:\/\//i.test(String(req.body.autopartner_catalog_url || '')) ? String(req.body.autopartner_catalog_url).trim() : 'https://apcat.eu/';
  saveSettings({
    autopartner_customer_number: String(req.body.autopartner_customer_number || '').trim(),
    autopartner_integration_mode: mode,
    autopartner_catalog_url: catalogUrl
  });
  db.prepare("UPDATE suppliers SET catalog_url=?,integration_status=? WHERE code='AUTOPARTNER'").run(catalogUrl, mode === 'manual' ? 'manual' : mode);
  audit(req.session.user.id, 'update', 'settings', null, { section: 'integrations', supplier: 'AUTOPARTNER', mode });
  setFlash(req, 'success', 'Ustawienia integracji zostały zapisane.');
  res.redirect(appUrl('/settings/integrations'));
});

app.get('/settings/documents', authRequired, (_req, res) => {
  res.render('settings/documents', { title: 'Wygląd dokumentów', formSettings: getSettings() });
});

app.post('/settings/documents', authRequired, (req, res) => {
  const checkbox = (name) => req.body[name] ? '1' : '0';
  saveSettings({
    document_accent_color: /^#[0-9a-f]{6}$/i.test(req.body.document_accent_color || '') ? req.body.document_accent_color : '#2563eb',
    document_table_header_color: /^#[0-9a-f]{6}$/i.test(req.body.document_table_header_color || '') ? req.body.document_table_header_color : '#e8eef5',
    document_table_text_color: /^#[0-9a-f]{6}$/i.test(req.body.document_table_text_color || '') ? req.body.document_table_text_color : '#25313c',
    document_font_size: Math.min(12, Math.max(7, Number(req.body.document_font_size || 9))),
    document_compact: checkbox('document_compact'),
    document_show_logo: checkbox('document_show_logo'),
    document_show_company_contact: checkbox('document_show_company_contact'),
    document_show_bank_account: checkbox('document_show_bank_account'),
    document_bank_account: String(req.body.document_bank_account || '').trim(),
    document_bank_name: String(req.body.document_bank_name || '').trim(),
    invoice_show_lp: checkbox('invoice_show_lp'),
    invoice_show_unit: checkbox('invoice_show_unit'),
    invoice_show_net: '1',
    invoice_show_vat_rate: checkbox('invoice_show_vat_rate'),
    invoice_show_vat_value: checkbox('invoice_show_vat_value'),
    invoice_show_gross: '1',
    invoice_footer: String(req.body.invoice_footer || '').trim(),
    protocol_footer: String(req.body.protocol_footer || '').trim(),
    protocol_show_order_items: checkbox('protocol_show_order_items'),
    protocol_show_gross_total: '1', protocol_show_net_total: '1'
  });
  audit(req.session.user.id, 'update', 'settings', null, { section: 'documents' });
  setFlash(req, 'success', 'Wygląd dokumentów został zapisany.');
  res.redirect(appUrl('/settings/documents'));
});

app.post('/settings/documents/logo', authRequired, upload.single('logo'), (req, res) => {
  if (!req.file || !['image/jpeg','image/png'].includes(req.file.mimetype)) {
    setFlash(req, 'error', 'Wybierz plik logo JPG lub PNG.');
    return res.redirect(appUrl('/settings/documents'));
  }
  saveSettings({ document_logo_path: req.file.filename, document_show_logo: '1' });
  audit(req.session.user.id, 'upload', 'settings_logo', null, { filename: req.file.filename });
  setFlash(req, 'success', 'Logo dokumentów zostało zapisane.');
  res.redirect(appUrl('/settings/documents'));
});

app.get('/audit', authRequired, (_req, res) => {
  const logs = db.prepare(`SELECT a.*,u.email user_email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300`).all();
  res.render('audit', { title: 'Dziennik zmian', logs });
});

app.use((req, res) => res.status(404).render('error', { title: 'Nie znaleziono', message: 'Ta strona nie istnieje.' }));

app.use((error, req, res, _next) => {
  console.error(error);
  if (req.session) setFlash(req, 'error', error.message || 'Wystąpił błąd.');
  if (req.accepts('html')) return res.status(500).render('error', { title: 'Błąd', message: error.message || 'Wystąpił nieoczekiwany błąd.' });
  res.status(500).json({ ok: false, error: error.message || 'Wystąpił błąd.' });
});

module.exports = app;
