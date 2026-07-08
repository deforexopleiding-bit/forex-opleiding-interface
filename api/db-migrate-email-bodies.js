import { supabase, verifyAdmin } from './supabase.js';

// ── Nieuwe kolommen voor email_messages (body-fetch Fase 2) ────────────────
const NEW_COLS = [
  { col: 'body_text',        sql: 'text' },
  { col: 'body_html',        sql: 'text' },
  { col: 'body_fetched_at',  sql: 'timestamptz' },
  { col: 'body_truncated',   sql: 'boolean DEFAULT false' },
  { col: 'body_fetch_error', sql: 'text' },
];

// Geen last_processed_id kolom — voortgang wordt bijgehouden via
// body_fetched_at/body_fetch_error NULL-status op email_messages zelf.
const BACKFILL_BODY_TABLE = `CREATE TABLE IF NOT EXISTS backfill_body_progress (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox        text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'pending',
  bodies_fetched int DEFAULT 0,
  bodies_failed  int DEFAULT 0,
  last_batch_at  timestamptz,
  completed_at   timestamptz,
  error_count    int DEFAULT 0,
  last_error     text,
  last_error_at  timestamptz
);
ALTER TABLE backfill_body_progress DISABLE ROW LEVEL SECURITY;`;

// Verwijder last_processed_id als het nog bestaat (bigint/uuid mismatch fix)
const DROP_CURSOR_COL = `ALTER TABLE backfill_body_progress DROP COLUMN IF EXISTS last_processed_id;`;

async function colExists(table, col) {
  try {
    const { error } = await supabase.from(table).select(col).limit(1);
    return !error;
  } catch { return false; }
}

async function tableExists(table) {
  try {
    const { error } = await supabase.from(table).select('id').limit(1);
    return !error;
  } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // K2 — super_admin-only gate vóór alle DB-actie. Endpoint kan schema
  // wijzigen (ALTER TABLE / CREATE TABLE via RPC).
  const admin = await verifyAdmin(req);
  if (!admin || admin.profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const missing     = [];
  const applied     = [];
  const sqlLines    = ['-- Voer dit uit in Supabase → SQL Editor indien RPC niet beschikbaar', ''];
  let   rpcWorked   = false;

  // ── Check en migreer body-kolommen op email_messages ──────────────────────
  for (const { col, sql } of NEW_COLS) {
    const exists = await colExists('email_messages', col);
    if (!exists) {
      missing.push(col);
      const alterSql = `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS ${col} ${sql};`;
      sqlLines.push(alterSql);
      try {
        const { error } = await supabase.rpc('run_schema_migration', { sql: alterSql });
        if (!error) {
          applied.push(col);
          rpcWorked = true;
          console.log(`[db-migrate-bodies] kolom aangemaakt: email_messages.${col}`);
        } else {
          console.warn(`[db-migrate-bodies] RPC fout voor ${col}:`, error.message);
        }
      } catch (e) {
        console.warn(`[db-migrate-bodies] RPC niet beschikbaar voor ${col}:`, e.message);
      }
    }
  }

  // ── Check en maak backfill_body_progress tabel ────────────────────────────
  const tableOk = await tableExists('backfill_body_progress');
  if (!tableOk) {
    missing.push('tabel:backfill_body_progress');
    sqlLines.push('', '-- Nieuwe tabel: backfill_body_progress');
    sqlLines.push(BACKFILL_BODY_TABLE);
    try {
      const { error } = await supabase.rpc('run_schema_migration', { sql: BACKFILL_BODY_TABLE });
      if (!error) {
        applied.push('tabel:backfill_body_progress');
        rpcWorked = true;
        console.log('[db-migrate-bodies] tabel backfill_body_progress aangemaakt');
      } else {
        console.warn('[db-migrate-bodies] RPC tabel-aanmaak fout:', error.message);
      }
    } catch (e) {
      console.warn('[db-migrate-bodies] RPC niet beschikbaar voor tabel:', e.message);
    }
  }

  // ── Verwijder last_processed_id kolom als die nog bestaat (uuid/bigint fix) ─
  // Idempotent via DROP COLUMN IF EXISTS — veilig bij herhaalde aanroep.
  if (tableOk || applied.includes('tabel:backfill_body_progress')) {
    try {
      const hasCursor = await colExists('backfill_body_progress', 'last_processed_id');
      if (hasCursor) {
        sqlLines.push('', '-- Verwijder verouderde cursor-kolom (bigint/uuid mismatch)');
        sqlLines.push(DROP_CURSOR_COL);
        const { error } = await supabase.rpc('run_schema_migration', { sql: DROP_CURSOR_COL });
        if (!error) {
          applied.push('drop:last_processed_id');
          rpcWorked = true;
          console.log('[db-migrate-bodies] last_processed_id kolom verwijderd');
        } else {
          console.warn('[db-migrate-bodies] DROP COLUMN fout:', error.message);
        }
      }
    } catch (e) {
      console.warn('[db-migrate-bodies] DROP COLUMN check threw:', e.message);
    }
  }

  if (missing.length === 0) {
    return res.status(200).json({
      ok:      true,
      message: 'Alle body-kolommen en backfill_body_progress tabel aanwezig — geen migratie nodig.',
      missing: [],
    });
  }

  const stillMissing = [];
  for (const { col } of NEW_COLS) {
    if (!(await colExists('email_messages', col))) stillMissing.push(col);
  }
  if (!(await tableExists('backfill_body_progress'))) stillMissing.push('tabel:backfill_body_progress');

  return res.status(200).json({
    ok:           stillMissing.length === 0,
    missing_found: missing,
    applied,
    still_missing: stillMissing,
    rpc_applied:  rpcWorked,
    message:      stillMissing.length === 0
      ? 'Migratie automatisch uitgevoerd via RPC.'
      : `${stillMissing.length} item(s) nog ontbrekend — voer de SQL hieronder handmatig uit in Supabase SQL Editor.`,
    sql_to_run:   sqlLines.join('\n'),
  });
}
