const nodemailer = require('nodemailer');
const config = require('../config');

function configured() {
  return Boolean(config.smtp.host && config.smtp.from);
}

function transport() {
  if (!configured()) throw new Error('SMTP nie jest skonfigurowane. Uzupełnij zmienne SMTP_* w pliku .env.');
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined
  });
}

async function sendDocument({ to, subject, text, attachmentPath, filename }) {
  if (!to) throw new Error('Klient nie ma adresu e-mail.');
  return transport().sendMail({
    from: config.smtp.from,
    to,
    subject,
    text,
    attachments: attachmentPath ? [{ path: attachmentPath, filename }] : []
  });
}

module.exports = { configured, sendDocument };
