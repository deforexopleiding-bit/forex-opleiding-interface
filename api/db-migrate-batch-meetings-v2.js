import { supabase } from './supabase.js';

// taken_assignees: genormaliseerde many-to-many koppeling tussen taken en toegewezen personen
// task_id is TEXT om overeen te komen met taken_items.id (ook text, geen uuid)
const TABLES_TO_CREATE = {
  taken_assignees: `CREATE TABLE IF NOT EXISTS taken_assignees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         text NOT NULL,
  assignee_type   text NOT NULL,
  assignee_id     text NOT NULL,
  assignee_name   text NOT NULL,
  added_at        timestamptz DEFAULT now(),
  CONSTRAINT unique_task_assignee UNIQUE (task_id, assignee_type, assignee_id)
);
CREATE INDEX IF NOT EXISTS idx_taken_assignees_task
  ON taken_assignees (task_id);
CREATE INDEX IF NOT EXISTS idx_taken_assignees_lookup
  ON taken_assignees (assignee_type, assignee_id);
ALTER TABLE taken_assignees DISABLE ROW LEVEL SECURITY;`,
};

async function tableExists(table) {
  try {
    const { error } = await supabase.from(table).select('id').limit(1);
    return !error;
  } catch { return false; }
}

async function runSql(sql) {
  const { error } = await supabase.rpc('run_schema_migration', { sql });
  if (error) throw new Error(error.message);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader  = req.headers.authorization || '';
    const querySecret = req.query?.secret         || '';
    if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
      return res.status(401).json({ error: 'Unauthorized — CRON_SECRET vereist' });
    }
  }

  const report = {
    created_tables:  [],
    skipped_tables:  [],
    errors:          [],
    ok: false,
  };

  for (const [table, sql] of Object.entries(TABLES_TO_CREATE)) {
    const exists = await tableExists(table);
    if (exists) {
      report.skipped_tables.push(table);
      console.log(`[db-migrate-v2] Tabel bestaat al: ${table}`);
      continue;
    }
    try {
      await runSql(sql);
      report.created_tables.push(table);
      console.log(`[db-migrate-v2] Tabel aangemaakt: ${table}`);
    } catch (e) {
      const msg = `tabel ${table}: ${e.message}`;
      report.errors.push(msg);
      console.error(`[db-migrate-v2] FOUT ${msg}`);
    }
  }

  report.ok = report.errors.length === 0;
  report.message = report.ok
    ? `Migratie succesvol — ${report.created_tables.length} tabellen aangemaakt, ${report.skipped_tables.length} overgeslagen`
    : `Migratie deels mislukt: ${report.errors.join('; ')}`;

  console.log(`[db-migrate-v2] ${report.message}`);
  return res.status(200).json(report);
}
