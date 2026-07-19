const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { execFile } = require('child_process');

const config = require('./config');
const { db, audit, nextNumber } = require('./db');
const { TYPES: NUMBERING_TYPES, nextDocumentNumber, numberingPreview } = require('./services/numbering');
const { validateVin, decodeVin, normalizeVin } = require('./services/vin');
const { sumItems, lineTotals, pln, round2 } = require('./services/money');
const { getSettings, getDocumentSettings, saveSettings } = require('./settings');
const { generateInvoicePdf, generateProtocolPdf } = require('./services/pdf');
const { generateReportPdf, generateReportExcel } = require('./services/report');
const { label } = require('./i18n');
const mail = require('./services/mail');
const ksef = require('./services/ksef');
const sms = require('./services/sms');

const app = express();

function appUrl(pathname = '/') {
  const value = String(pathname || '/');
  if (/^https?:\/\//i.test(value)) return value;
  const normalized = value.startsWith('/') ? value : `/${value}`;
  if (!config.appBasePath) return normalized;
  return normalized === '/' ? `${config.appBasePath}/` : `${config.appBasePath}${normalized}`;
}

function clampDiscount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
}

function isoToday() { return new Date().toISOString().slice(0, 10); }
function dueDateFrom(issueDate, paymentDays, paymentMethod) {
  const issue = /^\d{4}-\d{2}-\d{2}$/.test(String(issueDate || '')) ? String(issueDate) : isoToday();
  if (paymentMethod === 'cash') return issue;
  const d = new Date(`${issue}T12:00:00`);
  d.setDate(d.getDate() + Math.max(0, Number(paymentDays || 0)));
  return d.toISOString().slice(0, 10);
}
function asArray(value) { return Array.isArray(value) ? value : (value == null ? [] : [value]); }
function parsePermissions(value) { try { const p = JSON.parse(value || '{}'); return p && typeof p === 'object' ? p : {}; } catch (_) { return {}; } }
function userCan(user, permission) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  const row = db.prepare('SELECT permissions_json FROM users WHERE id=?').get(user.id);
  const permissions = parsePermissions(row?.permissions_json);
  return permissions[permission] !== false;
}

function rememberSuggestion(category, value) {
  const normalized = String(value || '').trim();
  if (!normalized) return;
  db.prepare(`INSERT INTO item_suggestions (category,value,usage_count,last_used_at) VALUES (?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(category,value) DO UPDATE SET usage_count=usage_count+1,last_used_at=CURRENT_TIMESTAMP`).run(category, normalized);
}

function suggestionCategory(type) {
  if (type === 'part') return 'part';
  if (type === 'material') return 'material';
  return 'service';
}

function duplicateClient(body, excludeId = null) {
  const nip = String(body.nip || body.client_nip || '').replace(/\D/g, '');
  const email = String(body.email || body.client_email || '').trim().toLowerCase();
  const phone = String(body.phone || body.client_phone || '').replace(/\D/g, '');
  const name = String(body.name || body.client_name || '').trim();
  const rows = db.prepare(`SELECT * FROM clients WHERE (? IS NULL OR id!=?) AND (
    (?!='' AND REPLACE(REPLACE(REPLACE(COALESCE(nip,''),'-',''),' ',''),'.','')=?) OR
    (?!='' AND lower(COALESCE(email,''))=?) OR
    (?!='' AND REPLACE(REPLACE(COALESCE(phone,''),' ',''),'-','')=?) OR
    (?!='' AND lower(name)=lower(?))
  ) LIMIT 1`).get(excludeId, excludeId, nip, nip, email, email, phone, phone, name, name);
  return rows || null;
}

function duplicateVehicle(vin, registration, excludeId = null) {
  const reg = String(registration || '').trim().toUpperCase().replace(/\s+/g, '');
  return db.prepare(`SELECT * FROM vehicles WHERE (? IS NULL OR id!=?) AND (
    (?!='' AND vin=?) OR (?!='' AND REPLACE(upper(COALESCE(registration,'')),' ','')=?)) LIMIT 1`)
    .get(excludeId, excludeId, vin || '', vin || '', reg, reg) || null;
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

function ownerRequired(req, res, next) {
  if (!req.session.user) return res.redirect(appUrl('/login'));
  if (req.session.user.role !== 'owner') {
    setFlash(req, 'error', 'Tylko właściciel może zarządzać użytkownikami.');
    return res.redirect(appUrl('/settings'));
  }
  next();
}

function csrfMiddleware(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    // multipart/form-data jest parsowane przez multer dopiero na poziomie konkretnej trasy.
    // Walidację CSRF dla uploadów wykonujemy po upload.single(...).
    if (req.is('multipart/form-data')) return next();
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
  res.locals.orderStatuses = { draft: 'Nowe zlecenie', estimate: 'Wycena', approved: 'Zaakceptowane', accepted: 'Zaakceptowane', in_progress: 'W trakcie naprawy', ready: 'Gotowy do odbioru', completed: 'Zakończone', cancelled: 'Anulowane' };
  res.locals.taskStatuses = { todo: 'Do zrobienia', in_progress: 'W trakcie', done: 'Zakończone' };
  res.locals.userRoles = { owner: 'Właściciel', manager: 'Kierownik', advisor: 'Doradca serwisowy', mechanic: 'Mechanik', accounting: 'Księgowość' };
  res.locals.userCan = permission => userCan(req.session.user, permission);
  res.locals.label = label;
  res.locals.formatDate = (value) => value ? new Date(`${value}`.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString('pl-PL') : '—';
  delete req.session.flash;
  next();
});

function multipartCsrfRequired(req, res, next) {
  const token = req.body?._csrf || req.get('x-csrf-token');
  if (!token || token !== req.session.csrfToken) {
    const files = req.files || (req.file ? [req.file] : []);
    for (const file of files) { try { fs.unlinkSync(file.path); } catch (_) {} }
    return res.status(403).send('Nieprawidłowy token CSRF. Odśwież stronę i spróbuj ponownie.');
  }
  next();
}

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
const templateUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 } });
const eppUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.get('/health', (_req, res) => res.json({ ok: true, app: config.appName, version: config.appVersion, ksef: ksef.status().mode }));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(appUrl('/'));
  res.render('login', { title: 'Logowanie' });
});

app.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email=? AND is_active=1').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    setFlash(req, 'error', 'Nieprawidłowy e-mail lub hasło.');
    return res.redirect(appUrl('/login'));
  }
  req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  db.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
  audit(user.id, 'login', 'user', user.id);
  res.redirect(appUrl('/'));
});

app.get('/forgot-password', (req, res) => {
  if (req.session.user) return res.redirect(appUrl('/'));
  res.render('forgot-password', { title: 'Nie pamiętam hasła' });
});

app.post('/forgot-password', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email=? AND is_active=1').get(email);
    if (user && mail.configured()) {
      const token = crypto.randomBytes(32).toString('hex');
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id=? OR expires_at<CURRENT_TIMESTAMP').run(user.id);
      db.prepare('INSERT INTO password_reset_tokens (user_id,token_hash,expires_at) VALUES (?,?,?)').run(user.id, hash, expires);
      const resetUrl = `${config.baseUrl.replace(/\/$/,'')}${appUrl(`/reset-password/${token}`)}`;
      await mail.sendText({ to: user.email, subject: `${config.appName} — reset hasła`, text: `Dzień dobry,\n\nAby ustawić nowe hasło, otwórz poniższy link (ważny przez 60 minut):\n${resetUrl}\n\nJeżeli nie prosiłeś o zmianę hasła, zignoruj tę wiadomość.` });
    }
    setFlash(req, 'success', 'Jeżeli konto istnieje i poczta jest skonfigurowana, wysłaliśmy link do zmiany hasła.');
    res.redirect(appUrl('/login'));
  } catch (error) { next(error); }
});

app.get('/reset-password/:token', (req, res) => {
  const hash = crypto.createHash('sha256').update(String(req.params.token || '')).digest('hex');
  const row = db.prepare(`SELECT t.*,u.email FROM password_reset_tokens t JOIN users u ON u.id=t.user_id
    WHERE t.token_hash=? AND t.used_at IS NULL AND t.expires_at>CURRENT_TIMESTAMP AND u.is_active=1`).get(hash);
  if (!row) return res.status(400).render('error', { title: 'Link wygasł', message: 'Link do zmiany hasła jest nieprawidłowy albo wygasł.' });
  res.render('reset-password', { title: 'Ustaw nowe hasło', token: req.params.token, email: row.email });
});

app.post('/reset-password/:token', (req, res) => {
  const hash = crypto.createHash('sha256').update(String(req.params.token || '')).digest('hex');
  const row = db.prepare(`SELECT t.*,u.email FROM password_reset_tokens t JOIN users u ON u.id=t.user_id
    WHERE t.token_hash=? AND t.used_at IS NULL AND t.expires_at>CURRENT_TIMESTAMP AND u.is_active=1`).get(hash);
  const password = String(req.body.password || '');
  if (!row) return res.status(400).render('error', { title: 'Link wygasł', message: 'Link do zmiany hasła jest nieprawidłowy albo wygasł.' });
  if (password.length < 10) { setFlash(req, 'error', 'Hasło musi mieć co najmniej 10 znaków.'); return res.redirect(appUrl(`/reset-password/${req.params.token}`)); }
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(bcrypt.hashSync(password, 12), row.user_id);
    db.prepare('UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id);
  });
  tx();
  audit(row.user_id, 'password_reset', 'user', row.user_id);
  setFlash(req, 'success', 'Hasło zostało zmienione. Możesz się zalogować.');
  res.redirect(appUrl('/login'));
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
  const duplicate = duplicateClient(req.body);
  if (duplicate) {
    setFlash(req, 'error', `Taki klient może już istnieć w bazie: ${duplicate.name}. Sprawdź NIP, e-mail, telefon lub nazwę.`);
    return res.redirect(appUrl(req.body.return_to || '/clients'));
  }
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
  const duplicate = duplicateClient(req.body, Number(req.params.id));
  if (duplicate) { setFlash(req, 'error', `Inny klient o takich danych już istnieje: ${duplicate.name}.`); return res.redirect(appUrl(`/clients/${req.params.id}/edit`)); }
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
  const registration = String(req.body.registration || '').toUpperCase().trim() || null;
  const existingVehicle = duplicateVehicle(vin, registration);
  if (existingVehicle) {
    setFlash(req, 'error', `Pojazd o takim ${vin && existingVehicle.vin === vin ? 'VIN' : 'numerze rejestracyjnym'} już istnieje w bazie.`);
    return res.redirect(appUrl(req.body.return_to || '/vehicles'));
  }
  try {
    let clientId = req.body.client_id || null;
    if (req.body.new_client_name) {
      const duplicate = duplicateClient({ client_name: req.body.new_client_name, client_nip: req.body.new_client_nip, client_email: req.body.new_client_email, client_phone: req.body.new_client_phone });
      if (duplicate) throw new Error(`Taki klient może już istnieć: ${duplicate.name}. Wybierz go z listy zamiast tworzyć duplikat.`);
      const createdClient = db.prepare(`INSERT INTO clients (type,name,nip,email,phone,address) VALUES (?,?,?,?,?,?)`).run(
        req.body.new_client_type || 'person', String(req.body.new_client_name).trim(), req.body.new_client_nip || null,
        req.body.new_client_email || null, req.body.new_client_phone || null, req.body.new_client_address || null);
      clientId = Number(createdClient.lastInsertRowid);
      audit(req.session.user.id, 'create', 'client', clientId, { source: 'vehicle_form' });
    }
    if (!clientId) throw new Error('Wybierz klienta albo dodaj nowego klienta.');
    const result = db.prepare(`INSERT INTO vehicles (client_id,vin,registration,make,model,year,engine,fuel,mileage,color,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(clientId, vin || null, registration,
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
  const registration = String(req.body.registration || '').toUpperCase().trim() || null;
  const duplicate = duplicateVehicle(vin, registration, Number(req.params.id));
  if (duplicate) { setFlash(req, 'error', 'Inny pojazd o takim VIN lub numerze rejestracyjnym już istnieje.'); return res.redirect(appUrl(`/vehicles/${req.params.id}/edit`)); }
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
    COALESCE(SUM(i.quantity * i.unit_price_net * (1 - COALESCE(i.discount_percent,0) / 100.0)),0) * (1 - COALESCE(w.discount_percent,0) / 100.0) total_net,
    COALESCE(SUM(i.quantity * i.unit_price_net * (1 - COALESCE(i.discount_percent,0) / 100.0) * (1 + i.vat_rate / 100.0)),0) * (1 - COALESCE(w.discount_percent,0) / 100.0) total_gross
    FROM work_orders w
    LEFT JOIN clients c ON c.id=w.client_id
    LEFT JOIN vehicles v ON v.id=w.vehicle_id
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
  try {
    // Zgodność z formularzami z wersji <= 0.7: stare nazwy pól są mapowane
    // na nowy, niezależny wybór klienta i pojazdu.
    if (req.body.creation_mode === 'new_client_vehicle') {
      req.body.new_client_name ||= req.body.client_name;
      req.body.new_client_type ||= req.body.client_type;
      req.body.new_client_nip ||= req.body.client_nip;
      req.body.new_client_email ||= req.body.client_email;
      req.body.new_client_phone ||= req.body.client_phone;
      req.body.new_client_address ||= req.body.client_address;
      req.body.new_client_notes ||= req.body.client_notes;
      req.body.new_vehicle_registration ||= req.body.vehicle_registration;
      req.body.new_vehicle_vin ||= req.body.vehicle_vin;
      req.body.new_vehicle_make ||= req.body.vehicle_make;
      req.body.new_vehicle_model ||= req.body.vehicle_model;
      req.body.new_vehicle_year ||= req.body.vehicle_year;
      req.body.new_vehicle_engine ||= req.body.vehicle_engine;
      req.body.new_vehicle_fuel ||= req.body.vehicle_fuel;
      req.body.new_vehicle_color ||= req.body.vehicle_color;
      req.body.new_vehicle_notes ||= req.body.vehicle_notes;
    } else if (req.body.creation_mode === 'new_vehicle') {
      req.body.new_vehicle_registration ||= req.body.vehicle_registration;
      req.body.new_vehicle_vin ||= req.body.vehicle_vin;
      req.body.new_vehicle_make ||= req.body.vehicle_make;
      req.body.new_vehicle_model ||= req.body.vehicle_model;
      req.body.new_vehicle_year ||= req.body.vehicle_year;
      req.body.new_vehicle_engine ||= req.body.vehicle_engine;
      req.body.new_vehicle_fuel ||= req.body.vehicle_fuel;
    }

    const create = db.transaction(() => {
      let clientId = req.body.client_id && req.body.client_id !== '__new__' ? Number(req.body.client_id) : null;
      let vehicleId = req.body.vehicle_id && req.body.vehicle_id !== '__new__' ? Number(req.body.vehicle_id) : null;

      if (req.body.new_client_name) {
        const clientName = String(req.body.new_client_name || '').trim();
        const possibleDuplicate = duplicateClient({ client_name:clientName, client_nip:req.body.new_client_nip, client_email:req.body.new_client_email, client_phone:req.body.new_client_phone });
        if (possibleDuplicate) throw new Error(`Taki klient może już istnieć: ${possibleDuplicate.name}. Wybierz istniejącą kartotekę.`);
        const client = db.prepare(`INSERT INTO clients (type,name,nip,email,phone,address,notes) VALUES (?,?,?,?,?,?,?)`).run(
          req.body.new_client_type || 'person', clientName, req.body.new_client_nip || null, req.body.new_client_email || null,
          req.body.new_client_phone || null, req.body.new_client_address || null, req.body.new_client_notes || null
        );
        clientId = Number(client.lastInsertRowid);
        audit(req.session.user.id, 'create', 'client', clientId, { source: 'order_form' });
      } else if (clientId && !db.prepare('SELECT id FROM clients WHERE id=?').get(clientId)) {
        throw new Error('Wybrany klient nie istnieje.');
      }

      if (vehicleId) {
        const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(vehicleId);
        if (!vehicle) throw new Error('Wybrany pojazd nie istnieje.');
        if (!clientId) clientId = Number(vehicle.client_id);
      }

      if (req.body.new_vehicle_registration || req.body.new_vehicle_vin) {
        if (!clientId) throw new Error('Aby dodać nowy pojazd, wybierz albo dodaj klienta.');
        const vehicle = validateNewVehiclePayload({
          vehicle_registration:req.body.new_vehicle_registration, vehicle_vin:req.body.new_vehicle_vin,
          vehicle_make:req.body.new_vehicle_make, vehicle_model:req.body.new_vehicle_model, vehicle_year:req.body.new_vehicle_year,
          vehicle_engine:req.body.new_vehicle_engine, vehicle_fuel:req.body.new_vehicle_fuel, vehicle_color:req.body.new_vehicle_color,
          vehicle_notes:req.body.new_vehicle_notes, mileage_in:req.body.mileage_in
        });
        const existingVehicle = duplicateVehicle(vehicle.vin, vehicle.registration);
        if (existingVehicle) throw new Error('Pojazd o takim VIN lub numerze rejestracyjnym już istnieje w bazie.');
        const createdVehicle = db.prepare(`INSERT INTO vehicles (client_id,vin,registration,make,model,year,engine,fuel,mileage,color,notes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(clientId, vehicle.vin, vehicle.registration, vehicle.make, vehicle.model,
            vehicle.year, vehicle.engine, vehicle.fuel, vehicle.mileage, vehicle.color, vehicle.notes);
        vehicleId = Number(createdVehicle.lastInsertRowid);
        audit(req.session.user.id, 'create', 'vehicle', vehicleId, { source: 'order_form', vin: vehicle.vin });
      }

      const number = nextDocumentNumber('work_order');
      const token = crypto.randomBytes(24).toString('hex');
      const priceMode = req.body.price_mode === 'gross' ? 'gross' : 'net';
      const result = db.prepare(`INSERT INTO work_orders
        (number,client_id,vehicle_id,status,complaint,diagnosis,notes,mileage_in,fuel_level,scheduled_for,acceptance_token,price_mode,discount_percent)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(number, clientId, vehicleId, req.body.status || 'draft', req.body.complaint || null,
          req.body.diagnosis || null, req.body.notes || null, req.body.mileage_in || null, req.body.fuel_level || null,
          req.body.scheduled_for || null, token, priceMode);
      if (req.body.mileage_in && vehicleId) db.prepare('UPDATE vehicles SET mileage=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.mileage_in, vehicleId);
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
    FROM work_orders w LEFT JOIN clients c ON c.id=w.client_id LEFT JOIN vehicles v ON v.id=w.vehicle_id WHERE w.id=?`).get(id);
}

app.get('/orders/:id', authRequired, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).render('error', { title: 'Brak zlecenia', message: 'Nie znaleziono zlecenia.' });
  const items = db.prepare('SELECT * FROM work_order_items WHERE work_order_id=? ORDER BY id').all(order.id);
  const protocols = db.prepare('SELECT * FROM protocols WHERE work_order_id=? ORDER BY id DESC').all(order.id);
  const attachments = db.prepare('SELECT * FROM attachments WHERE work_order_id=? ORDER BY id DESC').all(order.id);
  const invoice = db.prepare("SELECT * FROM invoices WHERE work_order_id=? AND status!='cancelled' ORDER BY id DESC LIMIT 1").get(order.id);
  const priceMode = req.query.price === 'gross' || (req.query.price !== 'net' && order.price_mode === 'gross') ? 'gross' : 'net';
  const suggestions = {
    service: db.prepare("SELECT value FROM item_suggestions WHERE category='service' ORDER BY usage_count DESC,last_used_at DESC LIMIT 100").all().map(r=>r.value),
    part: db.prepare("SELECT value FROM item_suggestions WHERE category='part' ORDER BY usage_count DESC,last_used_at DESC LIMIT 100").all().map(r=>r.value),
    material: db.prepare("SELECT value FROM item_suggestions WHERE category='material' ORDER BY usage_count DESC,last_used_at DESC LIMIT 100").all().map(r=>r.value)
  };
  res.render('orders/show', { title: order.number, order, items, totals: sumItems(items, order.discount_percent), protocols, attachments, invoice, priceMode, suggestions,
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
  const clients = db.prepare('SELECT id,name,nip,phone,email FROM clients ORDER BY name').all();
  if (!order) return res.status(404).send('Nie znaleziono zlecenia.');
  res.render('orders/form', { title: 'Edycja zlecenia', order, vehicles, clients, action: `/orders/${order.id}` });
});

app.post('/orders/:id', authRequired, (req, res) => {
  try {
    const update = db.transaction(() => {
      let clientId = req.body.client_id || null;
      let vehicleId = req.body.vehicle_id || null;
      if (req.body.new_client_name) {
        const duplicate = duplicateClient({ client_name: req.body.new_client_name, client_nip: req.body.new_client_nip, client_email: req.body.new_client_email, client_phone: req.body.new_client_phone });
        if (duplicate) throw new Error(`Taki klient może już istnieć: ${duplicate.name}. Wybierz go z listy.`);
        const created = db.prepare(`INSERT INTO clients (type,name,nip,email,phone,address) VALUES (?,?,?,?,?,?)`).run(
          req.body.new_client_type || 'person', String(req.body.new_client_name).trim(), req.body.new_client_nip || null,
          req.body.new_client_email || null, req.body.new_client_phone || null, req.body.new_client_address || null);
        clientId = Number(created.lastInsertRowid);
      }
      if (req.body.new_vehicle_registration || req.body.new_vehicle_vin) {
        if (!clientId) throw new Error('Aby dodać nowy pojazd, wybierz lub utwórz klienta.');
        const vin = normalizeVin(req.body.new_vehicle_vin);
        if (vin) { const check = validateVin(vin); if (!check.valid) throw new Error(check.error); }
        const registration = String(req.body.new_vehicle_registration || '').trim().toUpperCase() || null;
        if (duplicateVehicle(vin, registration)) throw new Error('Pojazd o takim VIN lub numerze rejestracyjnym już istnieje.');
        const createdVehicle = db.prepare(`INSERT INTO vehicles (client_id,vin,registration,make,model,year,engine,fuel,mileage) VALUES (?,?,?,?,?,?,?,?,?)`).run(
          clientId, vin || null, registration, req.body.new_vehicle_make || null, req.body.new_vehicle_model || null,
          req.body.new_vehicle_year || null, req.body.new_vehicle_engine || null, req.body.new_vehicle_fuel || null, req.body.mileage_in || null);
        vehicleId = Number(createdVehicle.lastInsertRowid);
      }
      db.prepare(`UPDATE work_orders SET client_id=?,vehicle_id=?,status=?,complaint=?,diagnosis=?,notes=?,mileage_in=?,fuel_level=?,scheduled_for=?,discount_percent=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(clientId || null, vehicleId || null, req.body.status, req.body.complaint || null, req.body.diagnosis || null, req.body.notes || null,
          req.body.mileage_in || null, req.body.fuel_level || null, req.body.scheduled_for || null, clampDiscount(req.body.discount_percent), req.params.id);
      if (req.body.mileage_in && vehicleId) db.prepare('UPDATE vehicles SET mileage=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.mileage_in, vehicleId);
    });
    update();
    audit(req.session.user.id, 'update', 'work_order', req.params.id);
    setFlash(req, 'success', 'Zlecenie zapisane.');
    res.redirect(appUrl(`/orders/${req.params.id}`));
  } catch (error) {
    setFlash(req, 'error', error.message);
    res.redirect(appUrl(`/orders/${req.params.id}/edit`));
  }
});

app.post('/orders/:id/items', authRequired, (req, res) => {
  const settings = getSettings();
  const types = asArray(req.body.type);
  const descriptions = asArray(req.body.description);
  const quantities = asArray(req.body.quantity);
  const hours = asArray(req.body.hours);
  const units = asArray(req.body.unit);
  const prices = asArray(req.body.price_input ?? req.body.unit_price_net);
  const vats = asArray(req.body.vat_rate);
  const costs = asArray(req.body.cost_net);
  const discounts = asArray(req.body.discount_percent);
  const inputModes = asArray(req.body.input_price_mode);
  let added = 0;
  const tx = db.transaction(() => {
    const insert = db.prepare(`INSERT INTO work_order_items (work_order_id,type,description,quantity,unit,unit_price_net,vat_rate,cost_net,discount_percent) VALUES (?,?,?,?,?,?,?,?,?)`);
    descriptions.forEach((rawDescription, index) => {
      const description = String(rawDescription || '').trim();
      if (!description) return;
      const type = ['labor','part','material','service'].includes(types[index]) ? types[index] : (types[0] || 'service');
      const vatRate = Number(vats[index] === '' || vats[index] == null ? settings.labor_vat_rate : vats[index]);
      const quantity = type === 'labor' ? Number(hours[index] || quantities[index] || 1) : Number(quantities[index] || 1);
      const unit = type === 'labor' ? 'rbh' : (units[index] || 'szt.');
      const rawPrice = prices[index];
      const enteredPrice = rawPrice === '' || rawPrice == null ? (type === 'labor' ? settings.labor_sale_rate_net : 0) : Number(rawPrice);
      const inputMode = inputModes[index] === 'gross' ? 'gross' : (inputModes[0] === 'gross' ? 'gross' : 'net');
      const unitPriceNet = inputMode === 'gross' ? round2(enteredPrice / (1 + vatRate / 100)) : round2(enteredPrice);
      const costNet = costs[index] === '' || costs[index] == null ? (type === 'labor' ? settings.labor_cost_rate_net : 0) : Number(costs[index]);
      if (!(quantity > 0)) throw new Error('Ilość lub liczba RBH musi być większa od zera.');
      const result = insert.run(req.params.id, type, description, quantity, unit, unitPriceNet, vatRate, costNet, clampDiscount(discounts[index]));
      rememberSuggestion(suggestionCategory(type), description);
      audit(req.session.user.id, 'create', 'work_order_item', result.lastInsertRowid, { work_order_id: req.params.id, type, quantity, discount_percent: clampDiscount(discounts[index]) });
      added += 1;
    });
  });
  try {
    tx();
    if (!added) { setFlash(req, 'error', 'Wpisz przynajmniej jedną pozycję.'); }
    else setFlash(req, 'success', `Dodano pozycje: ${added}.`);
  } catch (error) { setFlash(req, 'error', error.message); }
  const mode = inputModes[0] === 'gross' ? 'gross' : 'net';
  res.redirect(appUrl(`/orders/${req.params.id}?price=${mode}`));
});

app.post('/orders/:orderId/items/:itemId/delete', authRequired, (req, res) => {
  db.prepare('DELETE FROM work_order_items WHERE id=? AND work_order_id=?').run(req.params.itemId, req.params.orderId);
  audit(req.session.user.id, 'delete', 'work_order_item', req.params.itemId);
  setFlash(req, 'success', 'Pozycja usunięta.');
  res.redirect(appUrl(`/orders/${req.params.orderId}`));
});

app.post('/orders/:id/attachments', authRequired, upload.array('files', 8), multipartCsrfRequired, (req, res) => {
  const insert = db.prepare('INSERT INTO attachments (work_order_id,filename,original_name,mime_type) VALUES (?,?,?,?)');
  const tx = db.transaction((files) => files.forEach(file => insert.run(req.params.id, file.filename, file.originalname, file.mimetype)));
  tx(req.files || []);
  audit(req.session.user.id, 'upload', 'work_order', req.params.id, { count: req.files?.length || 0 });
  setFlash(req, 'success', `Dodano pliki: ${req.files?.length || 0}.`);
  res.redirect(appUrl(`/orders/${req.params.id}`));
});

app.post('/orders/:id/protocols', authRequired, (req, res) => {
  const type = ['release','additional_costs'].includes(req.body.type) ? req.body.type : 'intake';
  const body = {
    documents: req.body.documents, keys: req.body.keys, spare: req.body.spare, multimedia: req.body.multimedia,
    damage: req.body.damage, notes: req.body.notes, vehicle_condition: req.body.vehicle_condition, fuel_level: req.body.fuel_level, mileage: req.body.mileage,
    equipment: req.body.equipment, complaint_confirmed: req.body.complaint_confirmed,
    work_summary: req.body.work_summary, recommendations: req.body.recommendations,
    released_to: req.body.released_to, payment_status: req.body.payment_status,
    additional_reason: req.body.additional_reason, additional_description: req.body.additional_description,
    additional_net: Number(req.body.additional_net || 0), vat_rate: Number(req.body.vat_rate || 23),
    discount_percent: clampDiscount(req.body.discount_percent), legal_text: getSettings().protocol_legal_text
  };
  const protocolNumberType = type === 'release' ? 'protocol_release' : (type === 'additional_costs' ? 'protocol_additional_costs' : 'protocol_intake');
  const protocolNumber = nextDocumentNumber(protocolNumberType);
  const result = db.prepare(`INSERT INTO protocols (work_order_id,type,number,body_json,signed_by,signed_at) VALUES (?,?,?,?,NULL,NULL)`)
    .run(req.params.id, type, protocolNumber, JSON.stringify(body));
  audit(req.session.user.id, 'create', 'protocol', result.lastInsertRowid, { type });
  setFlash(req, 'success', type === 'additional_costs' ? 'Protokół dodatkowych kosztów został zapisany.' : 'Protokół został zapisany.');
  res.redirect(appUrl(`/orders/${req.params.id}`));
});

app.get('/protocols/:id/edit', authRequired, (req, res) => {
  const protocol = db.prepare(`SELECT p.*,w.number work_order_number FROM protocols p JOIN work_orders w ON w.id=p.work_order_id WHERE p.id=?`).get(req.params.id);
  if (!protocol) return res.status(404).render('error', { title: 'Brak protokołu', message: 'Nie znaleziono protokołu.' });
  let body = {}; try { body = JSON.parse(protocol.body_json || '{}'); } catch (_) {}
  res.render('protocols/edit', { title: 'Edycja protokołu', protocol, body });
});

app.post('/protocols/:id/edit', authRequired, (req, res) => {
  const protocol = db.prepare('SELECT * FROM protocols WHERE id=?').get(req.params.id);
  if (!protocol) return res.status(404).send('Nie znaleziono protokołu.');
  let oldBody = {}; try { oldBody = JSON.parse(protocol.body_json || '{}'); } catch (_) {}
  const body = { ...oldBody, ...req.body };
  delete body._csrf;
  if ('additional_net' in body) body.additional_net = Number(body.additional_net || 0);
  if ('vat_rate' in body) body.vat_rate = Number(body.vat_rate || 23);
  if ('discount_percent' in body) body.discount_percent = clampDiscount(body.discount_percent);
  db.prepare(`UPDATE protocols SET body_json=?,signed_by=NULL,signed_at=NULL,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?`).run(JSON.stringify(body), protocol.id);
  audit(req.session.user.id, 'update', 'protocol', protocol.id, { signature_reset: true, version: Number(protocol.version || 1) + 1 });
  setFlash(req, 'success', 'Protokół zapisany. Po edycji wcześniejszy podpis został cofnięty.');
  res.redirect(appUrl(`/orders/${protocol.work_order_id}`));
});

app.post('/protocols/:id/delete', authRequired, (req, res) => {
  const protocol = db.prepare('SELECT * FROM protocols WHERE id=?').get(req.params.id);
  if (!protocol) return res.status(404).send('Nie znaleziono protokołu.');
  db.prepare('DELETE FROM protocols WHERE id=?').run(protocol.id);
  audit(req.session.user.id, 'delete', 'protocol', protocol.id, { work_order_id: protocol.work_order_id, number: protocol.number });
  setFlash(req, 'success', 'Protokół został usunięty.');
  res.redirect(appUrl(`/orders/${protocol.work_order_id}`));
});

app.get('/protocols/:id/pdf', authRequired, async (req, res, next) => {
  try {
    const file = await generateProtocolPdf(req.params.id);
    if (req.query.download === '1') return res.download(file.filepath, file.filename);
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    res.sendFile(file.filepath);
  } catch (error) { next(error); }
});

app.get('/accept/:token', (req, res) => {
  const order = db.prepare(`SELECT w.*, c.name client_name, v.registration,v.make,v.model FROM work_orders w LEFT JOIN clients c ON c.id=w.client_id LEFT JOIN vehicles v ON v.id=w.vehicle_id WHERE w.acceptance_token=?`).get(req.params.token);
  if (!order) return res.status(404).render('error', { title: 'Nieprawidłowy link', message: 'Nie znaleziono wyceny lub link wygasł.' });
  const items = db.prepare('SELECT * FROM work_order_items WHERE work_order_id=? ORDER BY id').all(order.id);
  res.render('accept', { title: `Akceptacja ${order.number}`, order, items, totals: sumItems(items, order.discount_percent), templateSettings: getDocumentSettings('public_acceptance') });
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
  const invoices = db.prepare(`SELECT i.*,c.name client_name,base.number corrected_number FROM invoices i JOIN clients c ON c.id=i.client_id LEFT JOIN invoices base ON base.id=i.corrected_invoice_id ORDER BY i.id DESC LIMIT 250`).all();
  res.render('invoices/list', { title: 'Sprzedaż', invoices });
});

function invoiceFormData(invoice = {}) {
  return {
    invoice,
    clients: db.prepare('SELECT id,name,nip,email,phone,address FROM clients ORDER BY name').all(),
    items: invoice.id ? db.prepare('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id').all(invoice.id) : [],
    suggestions: db.prepare(`SELECT value FROM item_suggestions WHERE category IN ('invoice','service','part','material') ORDER BY usage_count DESC,last_used_at DESC LIMIT 150`).all().map(r=>r.value)
  };
}

app.get('/invoices/new', authRequired, (req, res) => {
  const type = req.query.type === 'invoice_receipt' ? 'invoice_receipt' : 'invoice';
  const today = new Date(); const days = Number(getSettings().default_payment_days || 7); const issueDate=today.toISOString().slice(0,10);
  const data = invoiceFormData({ document_type:type, issue_date:issueDate, sale_date:issueDate, due_date:dueDateFrom(issueDate,days,'transfer'), payment_days:days, payment_method:'transfer', discount_percent:0, receipt_number:'' });
  res.render('invoices/form', { title: type === 'invoice_receipt' ? 'Faktura do paragonu' : 'Nowa faktura', ...data, action:'/invoices' });
});

app.post('/invoices', authRequired, (req, res) => {
  const clientId = Number(req.body.client_id || 0);
  if (!clientId || !db.prepare('SELECT id FROM clients WHERE id=?').get(clientId)) { setFlash(req,'error','Wybierz klienta.'); return res.redirect(appUrl('/invoices/new')); }
  const documentType = ['correction','invoice_receipt'].includes(req.body.document_type) ? req.body.document_type : 'invoice';
  const number = nextDocumentNumber(documentType);
  const paymentMethod = req.body.payment_method || 'transfer';
  const paymentDays = Math.max(0, Number(req.body.payment_days ?? getSettings().default_payment_days ?? 7));
  const dueDate = dueDateFrom(req.body.issue_date, paymentDays, paymentMethod);
  const result = db.prepare(`INSERT INTO invoices (number,client_id,work_order_id,issue_date,sale_date,due_date,payment_days,payment_method,status,notes,discount_percent,receipt_number,document_type,corrected_invoice_id)
    VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?,?)`).run(number, clientId, req.body.work_order_id || null, req.body.issue_date, req.body.sale_date, dueDate, paymentDays,
      paymentMethod, req.body.notes || null, 0, req.body.receipt_number || null,
      documentType, req.body.corrected_invoice_id || null);
  audit(req.session.user.id,'create','invoice',result.lastInsertRowid,{number,status:'draft'});
  setFlash(req,'success',`Utworzono szkic ${number}. Dodaj pozycje i sprawdź dokument przed wystawieniem.`);
  res.redirect(appUrl(`/invoices/${result.lastInsertRowid}/edit`));
});

app.post('/orders/:id/invoice', authRequired, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Nie znaleziono zlecenia.');
  const items = db.prepare('SELECT * FROM work_order_items WHERE work_order_id=?').all(order.id);
  if (!order.client_id) { setFlash(req, 'error', 'Przed utworzeniem faktury przypisz klienta do zlecenia.'); return res.redirect(appUrl(`/orders/${order.id}`)); }
  if (!items.length) { setFlash(req, 'error', 'Dodaj przynajmniej jedną pozycję do zlecenia.'); return res.redirect(appUrl(`/orders/${order.id}`)); }
  const existing = db.prepare("SELECT id FROM invoices WHERE work_order_id=? AND status!='cancelled'").get(order.id);
  if (existing) return res.redirect(appUrl(`/invoices/${existing.id}/edit`));
  const today = new Date(); const issueDate=today.toISOString().slice(0,10); const paymentMethod=req.body.payment_method||'transfer'; const paymentDays=Number(getSettings().default_payment_days||7);
  const number = nextDocumentNumber('invoice');
  const tx = db.transaction(() => {
    const invoice = db.prepare(`INSERT INTO invoices (number,client_id,work_order_id,issue_date,sale_date,due_date,payment_days,payment_method,status,discount_percent,document_type) VALUES (?,?,?,?,?,?,?,?, 'draft',0,'invoice')`)
      .run(number, order.client_id, order.id, issueDate, issueDate, dueDateFrom(issueDate,paymentDays,paymentMethod), paymentDays, paymentMethod);
    const insert = db.prepare(`INSERT INTO invoice_items (invoice_id,description,quantity,unit,unit_price_net,vat_rate,discount_percent) VALUES (?,?,?,?,?,?,?)`);
    for (const item of items) insert.run(invoice.lastInsertRowid,item.description,item.quantity,item.unit,item.unit_price_net,item.vat_rate,item.discount_percent||0);
    return Number(invoice.lastInsertRowid);
  });
  const invoiceId = tx();
  audit(req.session.user.id,'create','invoice',invoiceId,{number,work_order_id:order.id,status:'draft'});
  setFlash(req,'success','Utworzono szkic faktury. Sprawdź i edytuj wszystkie dane, a następnie kliknij „Wystaw fakturę”.');
  res.redirect(appUrl(`/invoices/${invoiceId}/edit`));
});

app.get('/invoices/:id/edit', authRequired, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!invoice) return res.status(404).render('error',{title:'Brak faktury',message:'Nie znaleziono faktury.'});
  const data = invoiceFormData(invoice);
  res.render('invoices/form', { title:`Edycja ${invoice.number}`, ...data, action:`/invoices/${invoice.id}` });
});

app.post('/invoices/:id', authRequired, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!invoice) return res.status(404).send('Nie znaleziono faktury.');
  const descriptions = Array.isArray(req.body.item_description) ? req.body.item_description : (req.body.item_description ? [req.body.item_description] : []);
  const quantities = Array.isArray(req.body.item_quantity) ? req.body.item_quantity : [req.body.item_quantity];
  const units = Array.isArray(req.body.item_unit) ? req.body.item_unit : [req.body.item_unit];
  const prices = Array.isArray(req.body.item_price) ? req.body.item_price : [req.body.item_price];
  const vats = Array.isArray(req.body.item_vat) ? req.body.item_vat : [req.body.item_vat];
  const discounts = Array.isArray(req.body.item_discount) ? req.body.item_discount : [req.body.item_discount];
  const tx = db.transaction(() => {
    const requestedNumber = String(req.body.number || invoice.number).trim();
    const numberConflict = db.prepare('SELECT id FROM invoices WHERE number=? AND id!=?').get(requestedNumber, invoice.id);
    if (numberConflict) throw new Error('Dokument o takim numerze już istnieje.');
    const paymentMethod=req.body.payment_method || 'transfer';
    const paymentDays=Math.max(0,Number(req.body.payment_days ?? invoice.payment_days ?? 7));
    const dueDate=dueDateFrom(req.body.issue_date,paymentDays,paymentMethod);
    db.prepare(`UPDATE invoices SET number=?,client_id=?,issue_date=?,sale_date=?,due_date=?,payment_days=?,payment_method=?,notes=?,discount_percent=0,receipt_number=? WHERE id=?`).run(
      requestedNumber,req.body.client_id,req.body.issue_date,req.body.sale_date,dueDate,paymentDays,paymentMethod,req.body.notes || null,req.body.receipt_number || null,invoice.id);
    db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(invoice.id);
    const insert = db.prepare(`INSERT INTO invoice_items (invoice_id,description,quantity,unit,unit_price_net,vat_rate,discount_percent) VALUES (?,?,?,?,?,?,?)`);
    descriptions.forEach((description,index)=>{ const text=String(description||'').trim(); if(text) { insert.run(invoice.id,text,Number(quantities[index]||1),units[index]||'szt.',Number(prices[index]||0),Number(vats[index]||23),clampDiscount(discounts[index])); rememberSuggestion('invoice',text); } });
  });
  tx();
  audit(req.session.user.id,'update','invoice',invoice.id,{draft_edit:true});
  setFlash(req,'success','Zmiany w fakturze zostały zapisane.');
  res.redirect(appUrl(`/invoices/${invoice.id}/edit`));
});

app.post('/invoices/:id/issue', authRequired, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  const count = db.prepare('SELECT COUNT(*) count FROM invoice_items WHERE invoice_id=?').get(req.params.id)?.count || 0;
  if (!invoice || !count) { setFlash(req,'error','Faktura musi mieć przynajmniej jedną pozycję.'); return res.redirect(appUrl(`/invoices/${req.params.id}/edit`)); }
  const issueTx=db.transaction(()=>{ db.prepare("UPDATE invoices SET status='issued' WHERE id=?").run(invoice.id); if(invoice.work_order_id) db.prepare("UPDATE work_orders SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(invoice.work_order_id); }); issueTx();
  audit(req.session.user.id,'issue','invoice',invoice.id,{number:invoice.number,work_order_completed:Boolean(invoice.work_order_id)});
  setFlash(req,'success',`Faktura ${invoice.number} została wystawiona.`);
  res.redirect(appUrl(`/invoices/${invoice.id}`));
});

app.post('/invoices/:id/correction', authRequired, (req, res) => {
  const base = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!base) return res.status(404).send('Nie znaleziono faktury.');
  const number = nextDocumentNumber('correction');
  const issueDate=isoToday();
  const result = db.prepare(`INSERT INTO invoices (number,client_id,work_order_id,issue_date,sale_date,due_date,payment_days,payment_method,status,notes,discount_percent,document_type,corrected_invoice_id)
    VALUES (?,?,?,?,?,?,?,?, 'draft',?,0, 'correction',?)`).run(number,base.client_id,base.work_order_id,issueDate,base.sale_date,dueDateFrom(issueDate,base.payment_days||7,base.payment_method),base.payment_days||7,base.payment_method,`Korekta do ${base.number}`,base.id);
  const rows=db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(base.id); const insert=db.prepare('INSERT INTO invoice_items (invoice_id,description,quantity,unit,unit_price_net,vat_rate,discount_percent) VALUES (?,?,?,?,?,?,?)');
  rows.forEach(i=>insert.run(result.lastInsertRowid,`Korekta: ${i.description}`,-Math.abs(Number(i.quantity)),i.unit,i.unit_price_net,i.vat_rate,i.discount_percent||0));
  audit(req.session.user.id,'create_correction','invoice',result.lastInsertRowid,{corrected_invoice_id:base.id});
  res.redirect(appUrl(`/invoices/${result.lastInsertRowid}/edit`));
});

app.get('/invoices/:id', authRequired, (req, res) => {
  const invoice = db.prepare(`SELECT i.*,c.name client_name,c.email client_email,c.phone client_phone,c.nip client_nip,c.address client_address,w.number work_order_number,base.number corrected_number
    FROM invoices i JOIN clients c ON c.id=i.client_id LEFT JOIN work_orders w ON w.id=i.work_order_id LEFT JOIN invoices base ON base.id=i.corrected_invoice_id WHERE i.id=?`).get(req.params.id);
  if (!invoice) return res.status(404).render('error',{title:'Brak faktury',message:'Nie znaleziono faktury.'});
  const items=db.prepare('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id').all(invoice.id);
  res.render('invoices/show',{title:invoice.number,invoice,items,totals:sumItems(items,0),ksefStatus:ksef.status(),smtpConfigured:mail.configured(),smsConfigured:sms.configured()});
});

app.post('/invoices/:id/status', authRequired, (req, res) => {
  const allowed=['draft','issued','sent','paid','cancelled']; const status=allowed.includes(req.body.status)?req.body.status:'issued';
  db.prepare('UPDATE invoices SET status=? WHERE id=?').run(status,req.params.id); audit(req.session.user.id,'update_status','invoice',req.params.id,{status});
  setFlash(req,'success','Status faktury zmieniony.'); res.redirect(appUrl(`/invoices/${req.params.id}`));
});

app.get('/invoices/:id/pdf', authRequired, async (req,res,next)=>{ try { const file=await generateInvoicePdf(req.params.id); if(req.query.download==='1') return res.download(file.filepath,file.filename); res.setHeader('Content-Disposition',`inline; filename="${file.filename}"`); res.sendFile(file.filepath); } catch(error){next(error);} });

app.post('/invoices/:id/email', authRequired, async (req,res,next)=>{ try { const invoice=db.prepare(`SELECT i.*,c.email client_email FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=?`).get(req.params.id); if(!invoice) throw new Error('Nie znaleziono faktury.'); const file=await generateInvoicePdf(invoice.id); await mail.sendDocument({to:req.body.to||invoice.client_email,subject:`Faktura ${invoice.number}`,text:`Dzień dobry,\n\nw załączeniu przesyłamy fakturę ${invoice.number}.\n\n${config.company.name}`,attachmentPath:file.filepath,filename:file.filename}); db.prepare("UPDATE invoices SET status=CASE WHEN status='paid' THEN status ELSE 'sent' END WHERE id=?").run(invoice.id); audit(req.session.user.id,'email','invoice',invoice.id,{to:req.body.to||invoice.client_email}); setFlash(req,'success','Faktura została wysłana e-mailem.'); res.redirect(appUrl(`/invoices/${invoice.id}`)); } catch(error){next(error);} });

app.post('/invoices/:id/sms', authRequired, async (req,res,next)=>{ try { const invoice=db.prepare(`SELECT i.*,c.phone client_phone FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=?`).get(req.params.id); if(!invoice) throw new Error('Nie znaleziono faktury.'); const to=req.body.to||invoice.client_phone; await sms.send({to,message:`${config.company.name}: wystawiono dokument ${invoice.number}. Kwota i szczegóły są dostępne w przesłanym dokumencie.`}); audit(req.session.user.id,'sms','invoice',invoice.id,{to}); setFlash(req,'success','Powiadomienie SMS zostało wysłane.'); res.redirect(appUrl(`/invoices/${invoice.id}`)); } catch(error){next(error);} });

app.post('/invoices/:id/ksef', authRequired, (req,res,next)=>{ try { const invoice=db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id); if(!invoice) throw new Error('Nie znaleziono faktury.'); if(invoice.status==='draft') throw new Error('Najpierw wystaw fakturę.'); const jobId=ksef.queueInvoice(Number(req.params.id)); const processed=ksef.processQueued(); audit(req.session.user.id,'send_ksef','invoice',req.params.id,{jobId,processed:processed.length,mode:ksef.status().mode}); setFlash(req,'success',`Wysłano żądanie do KSeF (${ksef.status().mode}). Status dokumentu został odświeżony.`); res.redirect(appUrl(`/invoices/${req.params.id}`)); } catch(error){next(error);} });

// --- Zadania, terminarz, zakupy, magazyn i katalog dostawców ---
function todayIso() { return new Date().toISOString().slice(0, 10); }
function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function openOrders() {
  return db.prepare(`SELECT w.id,w.number,w.status,c.name client_name,v.registration,v.make,v.model
    FROM work_orders w LEFT JOIN clients c ON c.id=w.client_id LEFT JOIN vehicles v ON v.id=w.vehicle_id
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
  const users = db.prepare('SELECT id,name FROM users WHERE is_active=1 ORDER BY name').all();
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
  const purchaseType = String(req.body.type || 'wz').toLowerCase();
  const number = String(req.body.number || '').trim() || nextDocumentNumber(purchaseType === 'pz' ? 'purchase_pz' : 'purchase_wz');
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
  res.render('purchases/show', { title: `${label('purchaseType', document.type)} ${document.number}`, document, items, orders: openOrders() });
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

function normalizeReportRange(query) {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const iso = date => date.toISOString().slice(0, 10);
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  let from = valid(query.from) ? query.from : iso(first);
  let to = valid(query.to) ? query.to : iso(today);
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function reportFilters(query = {}) {
  return {
    client_id: Number(query.client_id || 0) || null,
    vehicle_id: Number(query.vehicle_id || 0) || null,
    service: String(query.service || '').trim()
  };
}

function loadReportData(from, to, filters = {}) {
  const clientId = filters.client_id || null;
  const vehicleId = filters.vehicle_id || null;
  const serviceLike = filters.service ? `%${filters.service}%` : null;
  const revenue = db.prepare(`SELECT COALESCE(SUM(ii.quantity*ii.unit_price_net*(1-COALESCE(ii.discount_percent,0)/100.0)),0) net,
    COALESCE(SUM(ii.quantity*ii.unit_price_net*(1-COALESCE(ii.discount_percent,0)/100.0)*ii.vat_rate/100.0),0) vat,
    COALESCE(SUM(ii.quantity*ii.unit_price_net*(1-COALESCE(ii.discount_percent,0)/100.0)*(1+ii.vat_rate/100.0)),0) gross
    FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id LEFT JOIN work_orders w ON w.id=i.work_order_id
    WHERE i.status!='cancelled' AND i.issue_date BETWEEN ? AND ?
      AND (? IS NULL OR i.client_id=?) AND (? IS NULL OR w.vehicle_id=?) AND (? IS NULL OR ii.description LIKE ?)`)
    .get(from,to,clientId,clientId,vehicleId,vehicleId,serviceLike,serviceLike);
  const orderProfit = db.prepare(`SELECT COALESCE(SUM(woi.quantity*woi.unit_price_net*(1-COALESCE(woi.discount_percent,0)/100.0)),0) sales_net,
    COALESCE(SUM(woi.quantity*woi.cost_net),0) cost_net FROM work_order_items woi
    JOIN work_orders w ON w.id=woi.work_order_id WHERE date(w.created_at) BETWEEN ? AND ?
      AND (? IS NULL OR w.client_id=?) AND (? IS NULL OR w.vehicle_id=?) AND (? IS NULL OR woi.description LIKE ?)`)
    .get(from,to,clientId,clientId,vehicleId,vehicleId,serviceLike,serviceLike);
  const purchases = db.prepare(`SELECT COALESCE(SUM(i.quantity*i.purchase_price_net),0) net FROM purchase_document_items i
    JOIN purchase_documents d ON d.id=i.purchase_document_id WHERE d.issue_date BETWEEN ? AND ?`).get(from, to);
  const cash = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_gross ELSE 0 END),0) income,
    COALESCE(SUM(CASE WHEN type='expense' THEN amount_gross ELSE 0 END),0) expense FROM cash_transactions WHERE occurred_on BETWEEN ? AND ?`).get(from,to);
  const employeeMonthlyCost = db.prepare(`SELECT COALESCE(SUM(monthly_cost),0) total FROM users WHERE is_active=1`).get().total || 0;
  const orderStatus = db.prepare(`SELECT status,COUNT(*) count FROM work_orders WHERE date(created_at) BETWEEN ? AND ? AND (? IS NULL OR client_id=?) AND (? IS NULL OR vehicle_id=?) GROUP BY status ORDER BY count DESC`).all(from,to,clientId,clientId,vehicleId,vehicleId);
  const lowStock = db.prepare('SELECT * FROM inventory_products WHERE stock_qty<=min_stock ORDER BY stock_qty LIMIT 25').all();
  const invoices = db.prepare(`SELECT i.number,i.issue_date,i.status,c.name client_name,v.registration,v.make,v.model,
    COALESCE(SUM(ii.quantity*ii.unit_price_net*(1-COALESCE(ii.discount_percent,0)/100.0)),0) net,
    COALESCE(SUM(ii.quantity*ii.unit_price_net*(1-COALESCE(ii.discount_percent,0)/100.0)*ii.vat_rate/100.0),0) vat,
    COALESCE(SUM(ii.quantity*ii.unit_price_net*(1-COALESCE(ii.discount_percent,0)/100.0)*(1+ii.vat_rate/100.0)),0) gross
    FROM invoices i LEFT JOIN clients c ON c.id=i.client_id LEFT JOIN work_orders w ON w.id=i.work_order_id LEFT JOIN vehicles v ON v.id=w.vehicle_id LEFT JOIN invoice_items ii ON ii.invoice_id=i.id
    WHERE i.status!='cancelled' AND i.issue_date BETWEEN ? AND ? AND (? IS NULL OR i.client_id=?) AND (? IS NULL OR w.vehicle_id=?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM invoice_items sx WHERE sx.invoice_id=i.id AND sx.description LIKE ?))
    GROUP BY i.id ORDER BY i.issue_date DESC,i.id DESC`).all(from,to,clientId,clientId,vehicleId,vehicleId,serviceLike,serviceLike);
  const monthly = db.prepare(`SELECT month,
    SUM(invoice_gross) invoice_gross,SUM(purchase_net) purchase_net,SUM(cash_income) cash_income,SUM(cash_expense) cash_expense FROM (
      SELECT substr(issue_date,1,7) month, SUM(ii.quantity*ii.unit_price_net*(1-COALESCE(ii.discount_percent,0)/100.0)*(1+ii.vat_rate/100.0)) invoice_gross,0 purchase_net,0 cash_income,0 cash_expense
      FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id WHERE i.status!='cancelled' AND i.issue_date BETWEEN ? AND ? GROUP BY substr(issue_date,1,7)
      UNION ALL SELECT substr(d.issue_date,1,7),0,SUM(pi.quantity*pi.purchase_price_net),0,0 FROM purchase_documents d JOIN purchase_document_items pi ON pi.purchase_document_id=d.id WHERE d.issue_date BETWEEN ? AND ? GROUP BY substr(d.issue_date,1,7)
      UNION ALL SELECT substr(occurred_on,1,7),0,0,SUM(CASE WHEN type='income' THEN amount_gross ELSE 0 END),SUM(CASE WHEN type='expense' THEN amount_gross ELSE 0 END) FROM cash_transactions WHERE occurred_on BETWEEN ? AND ? GROUP BY substr(occurred_on,1,7)
    ) GROUP BY month ORDER BY month DESC`).all(from,to,from,to,from,to);
  const staffSettlement = db.prepare(`SELECT u.id,u.name,u.commission_percent,u.monthly_cost,
      COALESCE(SUM(CASE WHEN t.status='done' THEN t.estimated_hours ELSE 0 END),0) completed_hours
    FROM users u LEFT JOIN tasks t ON t.assigned_to=u.id AND date(COALESCE(t.updated_at,t.created_at)) BETWEEN ? AND ?
    WHERE u.is_active=1 GROUP BY u.id ORDER BY u.name`).all(from,to).map(row=>({ ...row, commission_value: round2(Number(row.completed_hours||0)*Number(getSettings().labor_sale_rate_net||0)*Number(row.commission_percent||0)/100) }));
  const clients = db.prepare('SELECT id,name FROM clients ORDER BY name').all();
  const vehicles = db.prepare('SELECT id,registration,make,model FROM vehicles ORDER BY registration').all();
  return { from, to, filters, revenue, orderProfit, purchases, cash, employeeMonthlyCost, orderStatus, lowStock, invoices, monthly, staffSettlement, clients, vehicles };
}

app.get('/reports', authRequired, (req, res) => {
  const { from, to } = normalizeReportRange(req.query);
  const filters=reportFilters(req.query); res.render('reports/index', { title: 'Raporty', ...loadReportData(from, to, filters) });
});

app.get('/reports/print', authRequired, (req, res) => {
  const { from, to } = normalizeReportRange(req.query);
  const filters=reportFilters(req.query); res.render('reports/print', { title: 'Raport do wydruku', ...loadReportData(from, to, filters) });
});

app.get('/reports/pdf', authRequired, async (req, res, next) => {
  try {
    const { from, to } = normalizeReportRange(req.query);
    const file = await generateReportPdf(loadReportData(from, to, reportFilters(req.query)));
    if (req.query.download === '1') return res.download(file.filepath, file.filename);
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    res.sendFile(file.filepath);
  } catch (error) { next(error); }
});

app.get('/reports/excel', authRequired, async (req, res, next) => {
  try {
    const { from, to } = normalizeReportRange(req.query);
    const file = await generateReportExcel(loadReportData(from, to, reportFilters(req.query)));
    res.download(file.filepath, file.filename);
  } catch (error) { next(error); }
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

const USER_ROLES = ['owner','manager','advisor','mechanic','accounting'];

function activeOwnerCount() {
  return Number(db.prepare("SELECT COUNT(*) count FROM users WHERE role='owner' AND is_active=1").get().count || 0);
}

function permissionsFromBody(body) {
  const keys=['orders','clients','vehicles','invoices','reports','tasks','inventory','settings','ksef'];
  return Object.fromEntries(keys.map(key=>[key, Boolean(body[`permission_${key}`])]));
}

app.get('/settings/users', ownerRequired, (_req, res) => {
  const users = db.prepare(`SELECT u.id,u.email,u.name,u.role,u.is_active,u.created_at,u.updated_at,u.last_login_at,u.position_id,u.commission_percent,u.monthly_cost,u.permissions_json,p.name position_name
    FROM users u LEFT JOIN employee_positions p ON p.id=u.position_id ORDER BY u.is_active DESC, CASE u.role WHEN 'owner' THEN 0 ELSE 1 END, u.name COLLATE NOCASE`).all()
    .map(user=>({...user,permissions:parsePermissions(user.permissions_json)}));
  const positions=db.prepare('SELECT * FROM employee_positions ORDER BY active DESC,name').all();
  res.render('settings/users', { title: 'Użytkownicy', users, positions });
});

app.post('/settings/users', ownerRequired, (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = USER_ROLES.includes(req.body.role) ? req.body.role : 'mechanic';
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) { setFlash(req, 'error', 'Podaj nazwę użytkownika i poprawny adres e-mail.'); return res.redirect(appUrl('/settings/users')); }
  if (password.length < 10) { setFlash(req, 'error', 'Hasło musi mieć co najmniej 10 znaków.'); return res.redirect(appUrl('/settings/users')); }
  try {
    const hash = bcrypt.hashSync(password, 12);
    const permissions=role==='owner'?{}:permissionsFromBody(req.body);
    const result = db.prepare(`INSERT INTO users (email,password_hash,name,role,is_active,updated_at,position_id,commission_percent,monthly_cost,permissions_json)
      VALUES (?,?,?,?,1,CURRENT_TIMESTAMP,?,?,?,?)`).run(email,hash,name,role,req.body.position_id||null,Math.max(0,Number(req.body.commission_percent||0)),Math.max(0,Number(req.body.monthly_cost||0)),JSON.stringify(permissions));
    audit(req.session.user.id, 'create', 'user', result.lastInsertRowid, { email, name, role });
    setFlash(req, 'success', 'Użytkownik został dodany.');
  } catch (error) { setFlash(req, 'error', String(error.message || '').includes('UNIQUE') ? 'Użytkownik z takim adresem e-mail już istnieje.' : error.message); }
  res.redirect(appUrl('/settings/users'));
});

app.post('/settings/users/:id', ownerRequired, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) { setFlash(req, 'error', 'Nie znaleziono użytkownika.'); return res.redirect(appUrl('/settings/users')); }
  const name = String(req.body.name || '').trim(); const email = String(req.body.email || '').trim().toLowerCase(); const role = USER_ROLES.includes(req.body.role) ? req.body.role : user.role;
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) { setFlash(req, 'error', 'Podaj nazwę użytkownika i poprawny adres e-mail.'); return res.redirect(appUrl('/settings/users')); }
  if (user.role === 'owner' && role !== 'owner' && user.is_active && activeOwnerCount() <= 1) { setFlash(req, 'error', 'Nie można zmienić roli ostatniego aktywnego właściciela.'); return res.redirect(appUrl('/settings/users')); }
  try {
    const permissions=role==='owner'?{}:permissionsFromBody(req.body);
    db.prepare('UPDATE users SET name=?,email=?,role=?,position_id=?,commission_percent=?,monthly_cost=?,permissions_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(name,email,role,req.body.position_id||null,Math.max(0,Number(req.body.commission_percent||0)),Math.max(0,Number(req.body.monthly_cost||0)),JSON.stringify(permissions),id);
    if (id === req.session.user.id) req.session.user = { ...req.session.user, name, email, role };
    audit(req.session.user.id, 'update', 'user', id, { email, name, role }); setFlash(req, 'success', 'Dane użytkownika zostały zapisane.');
  } catch (error) { setFlash(req, 'error', String(error.message || '').includes('UNIQUE') ? 'Użytkownik z takim adresem e-mail już istnieje.' : error.message); }
  res.redirect(appUrl('/settings/users'));
});

app.post('/settings/users/:id/password', ownerRequired, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(id);
  const password = String(req.body.password || '');
  if (!user) { setFlash(req, 'error', 'Nie znaleziono użytkownika.'); return res.redirect(appUrl('/settings/users')); }
  if (password.length < 8) {
    setFlash(req, 'error', 'Nowe hasło musi mieć co najmniej 8 znaków.');
    return res.redirect(appUrl('/settings/users'));
  }
  db.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(bcrypt.hashSync(password, 12), id);
  audit(req.session.user.id, 'reset_password', 'user', id, { email: user.email });
  setFlash(req, 'success', 'Hasło użytkownika zostało zmienione.');
  res.redirect(appUrl('/settings/users'));
});

app.post('/settings/users/:id/toggle-active', ownerRequired, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) { setFlash(req, 'error', 'Nie znaleziono użytkownika.'); return res.redirect(appUrl('/settings/users')); }
  if (id === req.session.user.id) {
    setFlash(req, 'error', 'Nie możesz zablokować własnego konta.');
    return res.redirect(appUrl('/settings/users'));
  }
  const nextActive = user.is_active ? 0 : 1;
  if (user.role === 'owner' && user.is_active && activeOwnerCount() <= 1) {
    setFlash(req, 'error', 'Nie można zablokować ostatniego aktywnego właściciela.');
    return res.redirect(appUrl('/settings/users'));
  }
  db.prepare('UPDATE users SET is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nextActive, id);
  audit(req.session.user.id, nextActive ? 'activate' : 'deactivate', 'user', id, { email: user.email });
  setFlash(req, 'success', nextActive ? 'Konto użytkownika zostało odblokowane.' : 'Konto użytkownika zostało zablokowane.');
  res.redirect(appUrl('/settings/users'));
});

app.get('/settings/positions', ownerRequired, (_req, res) => {
  const employeePositions=db.prepare('SELECT * FROM employee_positions ORDER BY active DESC,name').all();
  const workshopStations=db.prepare('SELECT * FROM calendar_resources ORDER BY active DESC,name').all();
  res.render('settings/positions', { title:'Stanowiska', employeePositions, workshopStations });
});

app.post('/settings/positions/employee', ownerRequired, (req,res)=>{
  const name=String(req.body.name||'').trim(); if(!name){setFlash(req,'error','Podaj nazwę stanowiska.');return res.redirect(appUrl('/settings/positions'));}
  if(req.body.id) db.prepare('UPDATE employee_positions SET name=?,description=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,req.body.description||null,req.body.active?1:0,req.body.id);
  else db.prepare('INSERT INTO employee_positions (name,description,active) VALUES (?,?,1)').run(name,req.body.description||null);
  audit(req.session.user.id,'update','employee_position',req.body.id||null,{name}); setFlash(req,'success','Stanowisko pracownika zostało zapisane.'); res.redirect(appUrl('/settings/positions'));
});

app.post('/settings/positions/workshop', ownerRequired, (req,res)=>{
  const name=String(req.body.name||'').trim(); if(!name){setFlash(req,'error','Podaj nazwę stanowiska warsztatowego.');return res.redirect(appUrl('/settings/positions'));}
  const color=/^#[0-9a-f]{6}$/i.test(req.body.color||'')?req.body.color:'#3f8efc';
  if(req.body.id) db.prepare('UPDATE calendar_resources SET name=?,color=?,active=? WHERE id=?').run(name,color,req.body.active?1:0,req.body.id);
  else db.prepare('INSERT INTO calendar_resources (name,color,active) VALUES (?,?,1)').run(name,color);
  audit(req.session.user.id,'update','calendar_resource',req.body.id||null,{name}); setFlash(req,'success','Stanowisko warsztatowe zostało zapisane.'); res.redirect(appUrl('/settings/positions'));
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
    autopartner_catalog_url: catalogUrl,
    autodata_enabled: req.body.autodata_enabled ? '1' : '0',
    autodata_api_url: /^https:\/\//i.test(String(req.body.autodata_api_url || '')) ? String(req.body.autodata_api_url).trim() : '',
    tecrmi_enabled: req.body.tecrmi_enabled ? '1' : '0',
    tecrmi_api_url: /^https:\/\//i.test(String(req.body.tecrmi_api_url || '')) ? String(req.body.tecrmi_api_url).trim() : '',
    update_check_url: /^https:\/\//i.test(String(req.body.update_check_url || '')) ? String(req.body.update_check_url).trim() : ''
  });
  db.prepare("UPDATE suppliers SET catalog_url=?,integration_status=? WHERE code='AUTOPARTNER'").run(catalogUrl, mode === 'manual' ? 'manual' : mode);
  audit(req.session.user.id, 'update', 'settings', null, { section: 'integrations', supplier: 'AUTOPARTNER', mode });
  setFlash(req, 'success', 'Ustawienia integracji zostały zapisane.');
  res.redirect(appUrl('/settings/integrations'));
});


function parseCsvLine(line) {
  const values=[]; let current=''; let quoted=false;
  for (let i=0;i<String(line||'').length;i++) {
    const ch=line[i];
    if (ch==='"') {
      if (quoted && line[i+1]==='"') { current+='"'; i++; }
      else quoted=!quoted;
    } else if (ch===',' && !quoted) { values.push(current); current=''; }
    else current+=ch;
  }
  values.push(current); return values;
}
function eppDate(value) {
  const text=String(value||'');
  return /^\d{8}/.test(text) ? `${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}` : null;
}
function parseEpp(buffer) {
  let text;
  try { text = new TextDecoder('windows-1250').decode(buffer); } catch (_) { text = buffer.toString('latin1'); }
  const lines=text.split(/\r?\n/); const documents=[]; const counts={};
  for (let i=0;i<lines.length;i++) {
    if (String(lines[i]).trim() !== '[NAGLOWEK]') continue;
    const values=parseCsvLine(lines[i+1] || '');
    if (!values.length || !values[0]) continue;
    const doc={
      document_type:String(values[0]||'').trim(), document_number:String(values[6]||'').trim(),
      contractor_name:String(values[12]||values[13]||'').trim(), contractor_nip:String(values[17]||'').replace(/\D/g,''),
      contractor_city:String(values[14]||'').trim(), contractor_postcode:String(values[15]||'').trim(), contractor_address:String(values[16]||'').trim(),
      issue_date:eppDate(values[21]), net:Number(values[27]||0)||0, vat:Number(values[28]||0)||0, gross:Number(values[29]||0)||0,
      raw:values
    };
    documents.push(doc); counts[doc.document_type]=(counts[doc.document_type]||0)+1;
  }
  return { documents, counts, total:documents.length };
}

app.get('/settings/import', ownerRequired, (_req,res)=>{
  const imports=db.prepare('SELECT * FROM legacy_imports ORDER BY id DESC LIMIT 20').all().map(row=>{ try{return {...row,summary:JSON.parse(row.summary_json||'{}')}}catch(_){return {...row,summary:{}}} });
  res.render('settings/import',{title:'Import danych',imports});
});

app.post('/settings/import/epp/preview', ownerRequired, eppUpload.single('epp_file'), multipartCsrfRequired, (req,res)=>{
  if(!req.file){setFlash(req,'error','Wybierz plik EPP.');return res.redirect(appUrl('/settings/import'));}
  try {
    const parsed=parseEpp(req.file.buffer); if(!parsed.total) throw new Error('Nie znaleziono dokumentów [NAGLOWEK] w pliku EPP.');
    const hash=crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const existing=db.prepare('SELECT id FROM legacy_imports WHERE file_hash=?').get(hash);
    if(existing){setFlash(req,'error','Ten plik EPP został już wcześniej zaimportowany.');return res.redirect(appUrl('/settings/import'));}
    const tempPath=path.join('/tmp',`moj-warsztat-epp-${crypto.randomBytes(12).toString('hex')}.epp`); fs.writeFileSync(tempPath,req.file.buffer);
    if(req.session.eppPreview?.path){try{fs.unlinkSync(req.session.eppPreview.path)}catch(_){}}
    req.session.eppPreview={path:tempPath,filename:req.file.originalname,hash,summary:{total:parsed.total,counts:parsed.counts}};
    res.render('settings/import-preview',{title:'Podgląd importu EPP',filename:req.file.originalname,summary:req.session.eppPreview.summary,sample:parsed.documents.slice(0,20)});
  } catch(error){setFlash(req,'error',`Nie udało się odczytać EPP: ${error.message}`);res.redirect(appUrl('/settings/import'));}
});

app.post('/settings/import/epp/commit', ownerRequired, (req,res)=>{
  const preview=req.session.eppPreview;
  if(!preview?.path || !fs.existsSync(preview.path)){setFlash(req,'error','Podgląd importu wygasł. Wybierz plik ponownie.');return res.redirect(appUrl('/settings/import'));}
  try {
    const buffer=fs.readFileSync(preview.path); const hash=crypto.createHash('sha256').update(buffer).digest('hex');
    if(hash!==preview.hash) throw new Error('Plik tymczasowy został zmieniony.');
    const parsed=parseEpp(buffer); const createClients=Boolean(req.body.create_clients);
    const imported=db.transaction(()=>{
      const imp=db.prepare('INSERT INTO legacy_imports (filename,file_hash,format,summary_json) VALUES (?,?,\'epp\',?)').run(preview.filename,hash,JSON.stringify({total:parsed.total,counts:parsed.counts,create_clients:createClients}));
      const importId=Number(imp.lastInsertRowid);
      const insertDoc=db.prepare(`INSERT INTO legacy_documents (import_id,document_type,document_number,contractor_name,contractor_nip,issue_date,net,vat,gross,raw_json) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for(const doc of parsed.documents){
        insertDoc.run(importId,doc.document_type||null,doc.document_number||null,doc.contractor_name||null,doc.contractor_nip||null,doc.issue_date,doc.net,doc.vat,doc.gross,JSON.stringify(doc.raw));
        if(createClients && doc.contractor_name && !duplicateClient({name:doc.contractor_name,nip:doc.contractor_nip})) {
          const address=[doc.contractor_address,[doc.contractor_postcode,doc.contractor_city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
          db.prepare(`INSERT INTO clients (type,name,nip,address,notes) VALUES ('company',?,?,?,?)`).run(doc.contractor_name,doc.contractor_nip||null,address||null,`Import EPP: ${preview.filename}`);
        }
      }
      return importId;
    })();
    audit(req.session.user.id,'import','epp',imported,{filename:preview.filename,total:parsed.total,counts:parsed.counts});
    try{fs.unlinkSync(preview.path)}catch(_){} delete req.session.eppPreview;
    setFlash(req,'success',`Zaimportowano archiwum EPP: ${parsed.total} dokumentów historycznych.`); res.redirect(appUrl('/settings/import'));
  } catch(error){setFlash(req,'error',`Import nie powiódł się: ${error.message}`);res.redirect(appUrl('/settings/import'));}
});

app.get('/settings/updates', ownerRequired, (_req,res)=>{
  const settings=getSettings(); const command=process.env.MOJ_WARSZTAT_UPDATE_COMMAND||'';
  res.render('settings/updates',{title:'Wersja i aktualizacje',currentVersion:config.appVersion,settings,updateCommandConfigured:Boolean(command)});
});

app.get('/settings/updates/check', ownerRequired, async (_req,res)=>{
  const url=String(getSettings().update_check_url||'').trim();
  if(!url) return res.json({ok:true,current:config.appVersion,latest:null,message:'Nie skonfigurowano adresu sprawdzania wersji.'});
  try {
    const response=await fetch(url,{headers:{'accept':'application/json'}}); if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const data=await response.json(); res.json({ok:true,current:config.appVersion,latest:data.version||data.latest||null});
  } catch(error){res.status(502).json({ok:false,current:config.appVersion,error:error.message});}
});

app.post('/settings/updates/run', ownerRequired, (req,res)=>{
  const command=String(process.env.MOJ_WARSZTAT_UPDATE_COMMAND||'').trim(); const version=String(req.body.version||'stable').trim();
  if(!command){setFlash(req,'error','Aktualizacja z panelu nie jest skonfigurowana na tym serwerze. Użyj polecenia moj-warsztat-update przez SSH/Tailscale.');return res.redirect(appUrl('/settings/updates'));}
  if(!/^\/(usr\/local\/(s?bin)|opt\/moj-warsztat)\/[A-Za-z0-9._-]+$/.test(command)){setFlash(req,'error','Ścieżka polecenia aktualizacji nie jest dozwolona.');return res.redirect(appUrl('/settings/updates'));}
  if(version!=='stable' && !/^\d+\.\d+\.\d+$/.test(version)){setFlash(req,'error','Podaj wersję w formacie 0.8.0 albo stable.');return res.redirect(appUrl('/settings/updates'));}
  execFile(command,[version],{timeout:10*60*1000},(error,stdout,stderr)=>{
    audit(req.session?.user?.id,'run_update','application',null,{version,ok:!error,output:String(stdout||'').slice(-1000),error:String(stderr||error?.message||'').slice(-1000)});
  });
  setFlash(req,'success',`Uruchomiono aktualizację do wersji ${version}. Serwer może być chwilowo niedostępny.`); res.redirect(appUrl('/settings/updates'));
});

const DOCUMENT_TEMPLATE_TYPES = {
  invoice:'Faktura VAT', correction:'Korekta faktury', invoice_receipt:'Faktura do paragonu',
  protocol_intake:'Protokół przyjęcia', protocol_release:'Protokół wydania', protocol_additional_costs:'Protokół dodatkowych kosztów', public_acceptance:'Publiczna akceptacja kosztorysu'
};
app.get('/settings/documents', authRequired, (req, res) => {
  const templateType = DOCUMENT_TEMPLATE_TYPES[req.query.type] ? req.query.type : 'invoice';
  res.render('settings/documents', { title: 'Edytor dokumentów', formSettings: getDocumentSettings(templateType), templateType, templateTypes:DOCUMENT_TEMPLATE_TYPES });
});

app.post('/settings/documents', authRequired, (req, res) => {
  const templateType = DOCUMENT_TEMPLATE_TYPES[req.body.template_type] ? req.body.template_type : 'invoice';
  const checkbox = (name) => req.body[name] ? '1' : '0';
  const coord = (name, fallback, min, max) => Math.min(max, Math.max(min, Number(req.body[name] == null || req.body[name] === '' ? fallback : req.body[name])));
  const array = (value) => Array.isArray(value) ? value : (value == null ? [] : [value]);
  const labels = array(req.body.custom_field_label);
  const values = array(req.body.custom_field_value);
  const xs = array(req.body.custom_field_x);
  const ys = array(req.body.custom_field_y);
  const widths = array(req.body.custom_field_width);
  const fontSizes = array(req.body.custom_field_font_size);
  const weights = array(req.body.custom_field_weight);
  const documentTypes = array(req.body.custom_field_document_type);
  const customFields = labels.slice(0, 10).map((labelText, index) => ({
    label: String(labelText || '').trim(),
    value: String(values[index] || '').trim(),
    x: Math.min(540, Math.max(20, Number(xs[index] || 45))),
    y: Math.min(745, Math.max(40, Number(ys[index] || 700))),
    width: Math.min(520, Math.max(40, Number(widths[index] || 240))),
    font_size: Math.min(14, Math.max(6, Number(fontSizes[index] || 8))),
    bold: weights[index] === 'bold',
    document_type: ['all','invoice','correction','invoice_receipt','protocol'].includes(documentTypes[index]) ? documentTypes[index] : 'all'
  })).filter(field => field.label || field.value);

  const documentValues = {
    document_accent_color: /^#[0-9a-f]{6}$/i.test(req.body.document_accent_color || '') ? req.body.document_accent_color : '#2563eb',
    document_table_header_color: /^#[0-9a-f]{6}$/i.test(req.body.document_table_header_color || '') ? req.body.document_table_header_color : '#e8eef5',
    document_table_text_color: /^#[0-9a-f]{6}$/i.test(req.body.document_table_text_color || '') ? req.body.document_table_text_color : '#25313c',
    document_font_size: Math.min(12, Math.max(7, Number(req.body.document_font_size || 9))),
    document_font_family: ['dejavu','helvetica','times','courier'].includes(req.body.document_font_family) ? req.body.document_font_family : 'dejavu',
    document_compact: checkbox('document_compact'), document_show_logo: checkbox('document_show_logo'),
    document_show_company_contact: checkbox('document_show_company_contact'), document_show_bank_account: checkbox('document_show_bank_account'),
    document_bank_account: String(req.body.document_bank_account || '').trim(), document_bank_name: String(req.body.document_bank_name || '').trim(),
    document_logo_x: coord('document_logo_x',45,20,540), document_logo_y: coord('document_logo_y',57,40,740), document_logo_width: coord('document_logo_width',105,30,300), document_logo_height: coord('document_logo_height',48,20,160),
    document_title_x: coord('document_title_x',290,20,540), document_title_y: coord('document_title_y',58,40,740), document_title_width: coord('document_title_width',260,80,520),
    document_seller_x: coord('document_seller_x',45,20,540), document_seller_y: coord('document_seller_y',116,40,740), document_seller_width: coord('document_seller_width',247,100,520), document_seller_height: coord('document_seller_height',88,50,250),
    document_buyer_x: coord('document_buyer_x',303,20,540), document_buyer_y: coord('document_buyer_y',116,40,740), document_buyer_width: coord('document_buyer_width',247,100,520), document_buyer_height: coord('document_buyer_height',88,50,250),
    document_meta_x: coord('document_meta_x',45,20,540), document_meta_y: coord('document_meta_y',220,40,740), document_meta_width: coord('document_meta_width',250,100,520),
    document_bank_x: coord('document_bank_x',303,20,540), document_bank_y: coord('document_bank_y',220,40,740), document_bank_width: coord('document_bank_width',247,100,520),
    document_table_y: coord('document_table_y',286,120,700), document_custom_fields_json: JSON.stringify(customFields),
    invoice_show_lp: checkbox('invoice_show_lp'), invoice_show_unit: checkbox('invoice_show_unit'), invoice_show_net: '1',
    invoice_show_vat_rate: checkbox('invoice_show_vat_rate'), invoice_show_vat_value: checkbox('invoice_show_vat_value'), invoice_show_gross: '1',
    invoice_footer: String(req.body.invoice_footer || '').trim(), protocol_footer: String(req.body.protocol_footer || '').trim(),
    protocol_show_order_items: checkbox('protocol_show_order_items'), protocol_show_gross_total: '1', protocol_show_net_total: '1'
  };
  saveSettings(documentValues);
  db.prepare(`INSERT INTO document_templates (document_type,name,config_json,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(document_type) DO UPDATE SET name=excluded.name,config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP`).run(templateType,DOCUMENT_TEMPLATE_TYPES[templateType],JSON.stringify(documentValues));
  audit(req.session.user.id, 'update', 'settings', null, { section: 'documents', template_type:templateType, custom_fields: customFields.length });
  setFlash(req, 'success', 'Układ dokumentów został zapisany.');
  res.redirect(appUrl(`/settings/documents?type=${templateType}`));
});

app.get('/settings/documents/templates/:type/export', authRequired, (req,res)=>{
  const type=DOCUMENT_TEMPLATE_TYPES[req.params.type]?req.params.type:'invoice';
  const row=db.prepare('SELECT * FROM document_templates WHERE document_type=?').get(type);
  const payload={ version:1, app:'Mój Warsztat', document_type:type, name:DOCUMENT_TEMPLATE_TYPES[type], config: row ? JSON.parse(row.config_json||'{}') : {} };
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="szablon-${type}.json"`);
  res.send(JSON.stringify(payload,null,2));
});

app.post('/settings/documents/templates/import', authRequired, templateUpload.single('template_file'), multipartCsrfRequired, (req,res)=>{
  try {
    const type=DOCUMENT_TEMPLATE_TYPES[req.body.template_type]?req.body.template_type:'invoice';
    const text=req.file?req.file.buffer.toString('utf8'):String(req.body.template_json||'');
    const payload=JSON.parse(text);
    const configObj=payload.config && typeof payload.config==='object'?payload.config:payload;
    if(!configObj || typeof configObj!=='object' || Array.isArray(configObj)) throw new Error('Nieprawidłowy format szablonu.');
    db.prepare(`INSERT INTO document_templates (document_type,name,config_json,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(document_type) DO UPDATE SET name=excluded.name,config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP`).run(type,DOCUMENT_TEMPLATE_TYPES[type],JSON.stringify(configObj));
    audit(req.session.user.id,'import','document_template',null,{type}); setFlash(req,'success','Szablon został zaimportowany.');
    res.redirect(appUrl(`/settings/documents?type=${type}`));
  } catch(error){ setFlash(req,'error',`Nie udało się zaimportować szablonu: ${error.message}`); res.redirect(appUrl('/settings/documents')); }
});

app.get('/settings/numbering', authRequired, (_req, res) => {
  const formSettings = getSettings();
  const previews = Object.fromEntries(Object.keys(NUMBERING_TYPES).map(type => [type, numberingPreview(type, 1, new Date())]));
  res.render('settings/numbering', { title: 'Numeracja dokumentów', formSettings, numberingTypes: NUMBERING_TYPES, previews });
});

app.post('/settings/numbering', authRequired, (req, res) => {
  const values = {};
  for (const type of Object.keys(NUMBERING_TYPES)) {
    const pattern = String(req.body[`number_pattern_${type}`] || '').trim();
    if (!/\{N{1,4}\}/.test(pattern)) {
      setFlash(req, 'error', `Wzorzec dla ${type} musi zawierać {N}, {NN}, {NNN} lub {NNNN}.`);
      return res.redirect(appUrl('/settings/numbering'));
    }
    values[`number_pattern_${type}`] = pattern.slice(0, 100);
    values[`number_prefix_${type}`] = String(req.body[`number_prefix_${type}`] || '').trim().slice(0, 20);
    values[`number_reset_${type}`] = ['year','month','none'].includes(req.body[`number_reset_${type}`]) ? req.body[`number_reset_${type}`] : 'year';
    if (req.body[`reset_sequence_${type}`]) db.prepare('DELETE FROM document_sequences WHERE document_type=?').run(type);
  }
  saveSettings(values);
  audit(req.session.user.id, 'update', 'settings', null, { section: 'numbering' });
  setFlash(req, 'success', 'Numeracja dokumentów została zapisana.');
  res.redirect(appUrl('/settings/numbering'));
});

app.post('/settings/documents/logo', authRequired, upload.single('logo'), multipartCsrfRequired, (req, res) => {
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
