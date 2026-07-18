const path = require('path');
const pkg = require('../package.json');

function normalizeBasePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  appName: process.env.APP_NAME || 'Mój Warsztat',
  appVersion: process.env.APP_VERSION || pkg.version,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  appBasePath: normalizeBasePath(process.env.APP_BASE_PATH),
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'storage', 'motowarsztat.sqlite'),
  uploadDir: path.join(__dirname, '..', 'storage', 'uploads'),
  pdfDir: path.join(__dirname, '..', 'storage', 'pdfs'),
  adminEmail: process.env.ADMIN_EMAIL || 'admin@example.local',
  adminPassword: process.env.ADMIN_PASSWORD || 'ZmienToHaslo123!',
  company: {
    name: process.env.COMPANY_NAME || 'Mój Warsztat',
    nip: process.env.COMPANY_NIP || '',
    address: process.env.COMPANY_ADDRESS || '',
    email: process.env.COMPANY_EMAIL || '',
    phone: process.env.COMPANY_PHONE || ''
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.COMPANY_EMAIL || ''
  },
  ksef: {
    mode: process.env.KSEF_MODE || 'mock',
    nip: process.env.KSEF_NIP || process.env.COMPANY_NIP || '',
    certPath: process.env.KSEF_CERT_PATH || '',
    certPassword: process.env.KSEF_CERT_PASSWORD || ''
  }
};
