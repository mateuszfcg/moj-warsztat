const config = require('../config');

function configured() {
  return Boolean(process.env.SMS_WEBHOOK_URL);
}

async function send({ to, message }) {
  const url = process.env.SMS_WEBHOOK_URL;
  if (!url) throw new Error('Brak konfiguracji SMS_WEBHOOK_URL. Skonfiguruj bramkę SMS w pliku .env.');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.SMS_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` } : {}) },
    body: JSON.stringify({ to, message, sender: process.env.SMS_SENDER || config.appName })
  });
  if (!response.ok) throw new Error(`Bramka SMS zwróciła HTTP ${response.status}.`);
  return true;
}

module.exports = { configured, send };
