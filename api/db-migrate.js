import { supabase } from './supabase.js';

// Verwachte schema's — pas dit aan als de tabellen uitbreiden
const EXPECTED = {
  learn_examples: [
    { col: 'email_id',                  sql: 'text' },
    { col: 'sender_domain',             sql: 'text' },
    { col: 'body_snippet',              sql: 'text' },
    { col: 'correction_type',           sql: "text DEFAULT 'manual'" },
    { col: 'old_category',              sql: 'text' },
    { col: 'corrected_by',              sql: 'text' },
    { col: 'reason',                    sql: 'text' },
    { col: 'body_keywords',             sql: 'text[]' },
    { col: 'requires_action_corrected', sql: 'boolean' },
  ],
  email_patterns: [
    { col: 'sender_domain',    sql: 'text' },
    { col: 'times_seen',       sql: 'integer DEFAULT 0' },
    { col: 'source',           sql: "text DEFAULT 'ai'" },
    { col: 'last_corrected_at',sql: 'timestamptz' },
    { col: 'body_keywords',    sql: 'text[]' },
    { col: 'requires_action',  sql: 'boolean DEFAULT false' },
    { col: 'reason',           sql: 'text' },
  ],
  kennisbank_items: [
    { col: 'times_used',        sql: 'integer DEFAULT 0' },
    { col: 'times_helpful',     sql: 'integer DEFAULT 0' },
    { col: 'helpfulness_score', sql: 'integer DEFAULT 0' },
    { col: 'auto_generated',    sql: 'boolean DEFAULT false' },
    { col: 'source_email_id',   sql: 'text' },
  ],
  email_replies: [
    { col: 'email_id',    sql: 'text' },
    { col: 'cc_address',  sql: 'text' },
    { col: 'bcc_address', sql: 'text' },
  ],
};

// Tabellen die aangemaakt moeten worden als ze niet bestaan
const TABLES_TO_CREATE = {
  email_actions: `CREATE TABLE IF NOT EXISTS email_actions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email_id text NOT NULL,
  action text NOT NULL,
  value text,
  set_by text,
  set_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text
);
CREATE INDEX IF NOT EXISTS email_actions_email_id_idx ON email_actions (email_id);
ALTER TABLE email_actions DISABLE ROW LEVEL SECURITY;`,
  email_replies: `CREATE TABLE IF NOT EXISTS email_replies (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email_id text,
  email_subject text,
  final_reply text,
  from_address text,
  to_address text,
  cc_address text,
  bcc_address text,
  sent_at timestamptz DEFAULT now()
);
ALTER TABLE email_replies DISABLE ROW LEVEL SECURITY;`,
  kennisbank_items: `CREATE TABLE IF NOT EXISTS kennisbank_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type text,
  direction text,
  title text,
  category text,
  content text,
  question text,
  answer text,
  label text,
  note text,
  times_used integer DEFAULT 0,
  times_helpful integer DEFAULT 0,
  helpfulness_score integer DEFAULT 0,
  auto_generated boolean DEFAULT false,
  source_email_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE kennisbank_items DISABLE ROW LEVEL SECURITY;`,
  undo_history: `CREATE TABLE IF NOT EXISTS undo_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  action_type text NOT NULL,
  action_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  label text,
  performed_by text DEFAULT 'Jeffrey',
  performed_at timestamptz DEFAULT now(),
  undone_at timestamptz,
  is_undone boolean DEFAULT false
);
ALTER TABLE undo_history DISABLE ROW LEVEL SECURITY;`,
  taken_items: `CREATE TABLE IF NOT EXISTS taken_items (
  id text PRIMARY KEY,
  titel text,
  omschrijving text,
  prioriteit text DEFAULT 'Normaal',
  categorie text DEFAULT 'Overige',
  toegewezen_aan text,
  deadline text,
  email_id text,
  email_subject text,
  status text DEFAULT 'todo',
  notities text,
  aangemaakt timestamptz,
  afgerond_op timestamptz,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE taken_items DISABLE ROW LEVEL SECURITY;`,
};

async function tableExists(table) {
  try {
    const { error } = await supabase.from(table).select('id').limit(1);
    return !error;
  } catch { return false; }
}

async function colExists(table, col) {
  try {
    const { error } = await supabase.from(table).select(col).limit(1);
    return !error;
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const report = { tables: {}, missing: [], missing_tables: [], sql_to_run: '', ok: false };

  // ── Detecteer ontbrekende tabellen ────────────────────────────────────────
  for (const [table, createSql] of Object.entries(TABLES_TO_CREATE)) {
    const exists = await tableExists(table);
    report.tables[table] = exists ? { _table: 'ok' } : { _table: 'MISSING' };
    if (!exists) report.missing_tables.push({ table, createSql });
  }

  // ── Detecteer ontbrekende kolommen ────────────────────────────────────────
  for (const [table, cols] of Object.entries(EXPECTED)) {
    report.tables[table] = {};
    for (const { col } of cols) {
      const exists = await colExists(table, col);
      report.tables[table][col] = exists ? 'ok' : 'MISSING';
      if (!exists) report.missing.push({ table, col });
    }
  }

  if (report.missing.length === 0 && report.missing_tables.length === 0) {
    report.ok = true;
    report.message = 'Alle tabellen en kolommen aanwezig — geen migratie nodig.';
    return res.status(200).json(report);
  }

  // ── Bouw SQL voor ontbrekende tabellen ───────────────────────────────────
  const lines = ['-- Voer dit uit in Supabase → SQL Editor', ''];
  for (const { table, createSql } of report.missing_tables) {
    lines.push(`-- Nieuwe tabel: ${table}`);
    lines.push(createSql);
    lines.push('');
  }

  // ── Bouw ALTER TABLE SQL voor de ontbrekende kolommen ────────────────────
  let lastTable = null;
  for (const { table, col } of report.missing) {
    const def = EXPECTED[table].find((c) => c.col === col);
    if (table !== lastTable) {
      lines.push(`-- ${table}`);
      lastTable = table;
    }
    lines.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def.sql};`);
  }
  lines.push('', '-- RLS uitschakelen (nodig voor anon key)');
  lines.push('ALTER TABLE learn_examples DISABLE ROW LEVEL SECURITY;');
  lines.push('ALTER TABLE email_patterns DISABLE ROW LEVEL SECURITY;');
  lines.push('ALTER TABLE kennisbank_items DISABLE ROW LEVEL SECURITY;');
  report.sql_to_run = lines.join('\n');

  // ── Probeer via RPC (werkt alleen als de functie al bestaat in Supabase) ──
  // Om volledig automatisch te migreren, voeg eenmalig deze functie toe in
  // Supabase SQL Editor:
  //
  //   CREATE OR REPLACE FUNCTION run_schema_migration(sql text)
  //   RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
  //   BEGIN EXECUTE sql; RETURN 'ok'; END; $$;
  //
  let rpcWorked = false;
  try {
    for (const { createSql } of report.missing_tables) {
      const { error } = await supabase.rpc('run_schema_migration', { sql: createSql });
      if (!error) rpcWorked = true;
      else console.warn('[db-migrate] RPC tabel-aanmaak fout:', error.message);
    }
    for (const { table, col } of report.missing) {
      const def = EXPECTED[table].find((c) => c.col === col);
      const { error } = await supabase.rpc('run_schema_migration', {
        sql: `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def.sql}`
      });
      if (!error) rpcWorked = true;
      else console.warn(`[db-migrate] RPC fout voor ${table}.${col}:`, error.message);
    }
  } catch (e) {
    console.warn('[db-migrate] RPC niet beschikbaar:', e.message);
  }

  if (rpcWorked) {
    const stillMissing = [];
    for (const { table, col } of report.missing) {
      if (!(await colExists(table, col))) stillMissing.push({ table, col });
    }
    const stillMissingTables = [];
    for (const { table } of report.missing_tables) {
      if (!(await tableExists(table))) stillMissingTables.push(table);
    }
    report.ok = stillMissing.length === 0 && stillMissingTables.length === 0;
    report.rpc_applied = true;
    report.still_missing = stillMissing;
    report.message = report.ok
      ? 'Migratie automatisch uitgevoerd via RPC.'
      : `Migratie gedeeltelijk — ${stillMissing.length} kolom(men) nog ontbrekend.`;
  } else {
    report.ok = false;
    report.rpc_available = false;
    report.message = `${report.missing.length} kolom(men) ontbreken. Voer de SQL hieronder uit in Supabase om dit te fixen.`;
  }

  console.log('[db-migrate]', report.message, '· ontbrekend:', report.missing.map((m) => `${m.table}.${m.col}`).join(', '));
  return res.status(200).json(report);
}
