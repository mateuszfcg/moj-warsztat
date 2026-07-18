'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const source = process.argv[2] || process.env.DB_PATH || path.join(__dirname, '..', 'storage', 'motowarsztat.sqlite');
const target = process.argv[3];

if (!target) {
  console.error('Użycie: node scripts/sqlite-snapshot.js <źródło.sqlite> <cel.sqlite>');
  process.exit(2);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) fs.unlinkSync(target);

const db = new DatabaseSync(source);
try {
  db.exec('PRAGMA wal_checkpoint(FULL);');
  const escaped = target.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}';`);
  console.log(`Snapshot SQLite zapisany: ${target}`);
} finally {
  db.close();
}
