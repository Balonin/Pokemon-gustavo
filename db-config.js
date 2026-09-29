/* How to connect to Postgres (the app and scripts/migrate-db.js).

   Without a CA it is what it always was: SSL outside localhost, and whatever `sslmode` the URL brings
   (Neon's `sslmode=require`, which pg 8 reads as full verification — fine, Neon's certificate is public).

   With a CA — the certificate of a provider that signs with its own authority, like Aiven's `ca.pem` —
   the server is checked against it. The URL's `sslmode` has to go in that case: pg lets the URL override
   the `ssl` given here, and would check against the public authorities only, failing with
   "self-signed certificate in certificate chain". `ca` = the PEM text itself or the path of the file. */
const fs = require('fs');

function readCa(ca) {
  const text = String(ca || '').trim();
  if (!text) return '';
  return text.startsWith('-----BEGIN') ? text : fs.readFileSync(text, 'utf8');
}

function pgOptions(url, ca) {
  if (url.includes('localhost')) return { connectionString: url, ssl: false };
  const pem = readCa(ca);
  if (!pem) return { connectionString: url, ssl: { rejectUnauthorized: false } };
  const u = new URL(url);
  ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'].forEach(k => u.searchParams.delete(k));
  return { connectionString: u.toString(), ssl: { ca: pem, rejectUnauthorized: true } };
}

module.exports = { pgOptions };
