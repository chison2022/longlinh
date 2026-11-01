const fs = require('fs');
const path = require('path');
const { Pool, Client } = require('pg');
const { appRoot } = require('../src/paths');

// Connection options for the Aiven PostgreSQL service: PG_URL from .env, TLS checked against the CA file in PG_CA (a path relative to
// the app folder: the repo, or the install dir next to the .env when packaged).
function pgOptions() {
  const url = process.env.PG_URL;
  if (!url) throw new Error('PG_URL is missing in .env');
  const u = new URL(url);
  u.searchParams.delete('sslmode'); // the ssl object below replaces it (a sslmode in the URL would override the CA)
  // PG_CA_PEM = the certificate text itself (a host without files, e.g. the Activity on Render); else PG_CA = a path to the file
  const caPath = process.env.PG_CA;
  const pem = process.env.PG_CA_PEM && process.env.PG_CA_PEM.replace(/\\n/g, '\n');
  if (!pem && !caPath) throw new Error('PG_CA is missing in .env');
  const ca = pem || fs.readFileSync(path.resolve(appRoot(), caPath), 'utf8');
  return { connectionString: u.toString(), ssl: { ca, rejectUnauthorized: true } };
}

const pgClient = () => new Client(pgOptions());
// free plan: 20 connections in all. A dropped idle connection must not crash the bot: the pool replaces it on the next query.
function pgPool(max = 5) {
  const pool = new Pool({ ...pgOptions(), max, idleTimeoutMillis: 60000, connectionTimeoutMillis: 15000 });
  pool.on('error', (err) => console.error(`[db] idle connection lost: ${redactPg(err.message)}`));
  return pool;
}

// Hide the password of a postgres:// URL inside an error message.
const redactPg = (msg) => String(msg).replace(/postgres(ql)?:\/\/[^@\s/]+@/g, 'postgres$1://<redacted>@');

module.exports = { pgOptions, pgClient, pgPool, redactPg };
