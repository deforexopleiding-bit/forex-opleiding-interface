import { supabase } from './supabase.js';

// Verwachte schema's — pas dit aan als de tabellen uitbreiden
const EXPECTED = {
  learn_examples: [
    { col: 'email_id',        sql: 'text' },
    { col: 'sender_domain',   sql: 'text' },
    { col: 'body_snippet',    sql: 'text' },
    { col: 'correction_type', sql: "text DEFAULT 'manual'" },
    { col: 'old_category',    sql: 'text' },
    { col: 'corrected_by',    sql: 'text' },
  ],
  email_patterns: [
    { col: 'sender_domain',    sql: 'text' },
    { col: 'times_seen',       sql: 'integer DEFAULT 0' },
    { col: 'source',           sql: "text DEFAULT 'ai'" },
    { col: 'last_corrected_at',sql: 'timestamptz' },
  ],
};

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

  const report = { tables: {}, missing: [], sql_to_run: '', ok: false };

  // ── Detecteer ontbrekende kolommen ────────────────────────────────────────
  for (const [table, cols] of Object.entries(EXPECTED)) {
    report.tables[table] = {};
    for (const { col } of cols) {
      const exists = await colExists(table, col);
      report.tables[table][col] = exists ? 'ok' : 'MISSING';
      if (!exists) report.missing.push({ table, col });
    }
  }

  if (report.missing.length === 0) {
    report.ok = true;
    report.message = 'Alle kolommen aanwezig — geen migratie nodig.';
    return res.status(200).json(report);
  }

  // ── Bouw ALTER TABLE SQL voor de ontbrekende kolommen ────────────────────
  const lines = ['-- Voer dit uit in Supabase → SQL Editor', ''];
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
    // Verifieer of kolommen nu bestaan
    const stillMissing = [];
    for (const { table, col } of report.missing) {
      if (!(await colExists(table, col))) stillMissing.push({ table, col });
    }
    report.ok = stillMissing.length === 0;
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
