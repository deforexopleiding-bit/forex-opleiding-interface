import { supabase } from './supabase.js';

// ── Nieuwe tabellen ────────────────────────────────────────────────────────────
const TABLES_TO_CREATE = {
  team_members: `CREATE TABLE IF NOT EXISTS team_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  role          text NOT NULL,
  type          text NOT NULL DEFAULT 'employee',
  email         text,
  avatar_color  text DEFAULT '#534AB7',
  avatar_emoji  text DEFAULT '👤',
  is_active     boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_name ON team_members (name);
ALTER TABLE team_members DISABLE ROW LEVEL SECURITY;`,

  decisions: `CREATE TABLE IF NOT EXISTS decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    uuid REFERENCES agent_meetings(id) ON DELETE SET NULL,
  title         text NOT NULL,
  description   text,
  decided_by    text,
  decision_date date DEFAULT now(),
  status        text DEFAULT 'active',
  tags          text[],
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decisions_meeting_id ON decisions (meeting_id);
CREATE INDEX IF NOT EXISTS idx_decisions_date ON decisions (decision_date DESC);
ALTER TABLE decisions DISABLE ROW LEVEL SECURITY;`,

  agent_audit_log: `CREATE TABLE IF NOT EXISTS agent_audit_log (
  id            bigint generated always as identity primary key,
  agent_name    text NOT NULL,
  action        text NOT NULL,
  payload       jsonb DEFAULT '{}',
  result        jsonb DEFAULT '{}',
  status        text DEFAULT 'success',
  error_message text,
  approval_id   uuid,
  meeting_id    uuid,
  triggered_by  text DEFAULT 'system',
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON agent_audit_log (agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON agent_audit_log (action, created_at DESC);
ALTER TABLE agent_audit_log DISABLE ROW LEVEL SECURITY;`,

  agent_approval_queue: `CREATE TABLE IF NOT EXISTS agent_approval_queue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name    text NOT NULL,
  action        text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  description   text,
  requested_by  text DEFAULT 'agent',
  status        text DEFAULT 'pending',
  approved_by   text,
  approved_at   timestamptz,
  rejected_at   timestamptz,
  reject_reason text,
  meeting_id    uuid,
  created_at    timestamptz DEFAULT now(),
  expires_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON agent_approval_queue (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_queue_agent  ON agent_approval_queue (agent_name, status);
ALTER TABLE agent_approval_queue DISABLE ROW LEVEL SECURITY;`,
};

// ── Kolommen toe te voegen aan bestaande tabellen ─────────────────────────────
const COLUMNS_TO_ADD = [
  // agent_meetings — vergadering-rapport + voorzitter + type + externe inputs
  { table: 'agent_meetings', col: 'rapport_md',           sql: 'text' },
  { table: 'agent_meetings', col: 'rapport_generated_at', sql: 'timestamptz' },
  { table: 'agent_meetings', col: 'chair_agent',          sql: "text DEFAULT 'Simon'" },
  { table: 'agent_meetings', col: 'meeting_type',         sql: "text DEFAULT 'team'" },
  { table: 'agent_meetings', col: 'external_inputs',      sql: "jsonb DEFAULT '[]'" },

  // taken_items — toewijzing-type + bronvergadering + agenda-check
  { table: 'taken_items', col: 'assigned_to_type',      sql: "text DEFAULT 'employee'" },
  { table: 'taken_items', col: 'assigned_to_id',        sql: 'uuid' },
  { table: 'taken_items', col: 'source_meeting_id',     sql: 'uuid' },
  { table: 'taken_items', col: 'last_status_check_at',  sql: 'timestamptz' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
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

async function runSql(sql) {
  const { error } = await supabase.rpc('run_schema_migration', { sql });
  if (error) throw new Error(error.message);
}

// ── Handler ───────────────────────────────────────────────────────────────────
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
    tables_checked:  Object.keys(TABLES_TO_CREATE),
    columns_checked: COLUMNS_TO_ADD.map(c => `${c.table}.${c.col}`),
    created_tables:  [],
    added_columns:   [],
    skipped_tables:  [],
    skipped_columns: [],
    errors:          [],
    seed_team_members: null,
    ok: false,
  };

  // ── 1. Nieuwe tabellen aanmaken ───────────────────────────────────────────
  for (const [table, sql] of Object.entries(TABLES_TO_CREATE)) {
    const exists = await tableExists(table);
    if (exists) {
      report.skipped_tables.push(table);
      console.log(`[db-migrate-meetings] Tabel bestaat al: ${table}`);
      continue;
    }
    try {
      await runSql(sql);
      report.created_tables.push(table);
      console.log(`[db-migrate-meetings] Tabel aangemaakt: ${table}`);
    } catch (e) {
      const msg = `tabel ${table}: ${e.message}`;
      report.errors.push(msg);
      console.error(`[db-migrate-meetings] FOUT ${msg}`);
    }
  }

  // ── 2. Kolommen toevoegen aan bestaande tabellen ──────────────────────────
  for (const { table, col, sql } of COLUMNS_TO_ADD) {
    const exists = await colExists(table, col);
    if (exists) {
      report.skipped_columns.push(`${table}.${col}`);
      continue;
    }
    try {
      await runSql(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${sql}`);
      report.added_columns.push(`${table}.${col}`);
      console.log(`[db-migrate-meetings] Kolom toegevoegd: ${table}.${col}`);
    } catch (e) {
      const msg = `kolom ${table}.${col}: ${e.message}`;
      report.errors.push(msg);
      console.error(`[db-migrate-meetings] FOUT ${msg}`);
    }
  }

  // ── 3. Seed team_members (idempotent via UNIQUE name) ─────────────────────
  const TEAM = [
    { name: 'Jeffrey Biemold', role: 'Eigenaar',              type: 'employee',  email: 'jeffrey@deforexopleiding.nl', avatar_emoji: '👑', avatar_color: '#534AB7' },
    { name: 'Maxim',           role: 'Opleidingshoofd',        type: 'employee',  email: 'maxim@deforexopleiding.nl',   avatar_emoji: '🎓', avatar_color: '#1D9E75' },
    { name: 'Dave',            role: 'Sales',                  type: 'employee',  email: 'dave@deforexopleiding.nl',    avatar_emoji: '💼', avatar_color: '#EF9F27' },
    { name: 'Romy',            role: 'Appointmentsetter',      type: 'freelance', email: null,                          avatar_emoji: '📅', avatar_color: '#E05C5C' },
    { name: 'Rogier',          role: 'Boekhouder',             type: 'freelance', email: null,                          avatar_emoji: '📊', avatar_color: '#3B82F6' },
    { name: 'Muddasir',        role: 'Meta-ads Specialist',    type: 'freelance', email: null,                          avatar_emoji: '📣', avatar_color: '#8B5CF6' },
    { name: 'Mentor 1',        role: 'Mentor',                 type: 'mentor',    email: null,                          avatar_emoji: '🏫', avatar_color: '#6B7280' },
    { name: 'Mentor 2',        role: 'Mentor',                 type: 'mentor',    email: null,                          avatar_emoji: '🏫', avatar_color: '#6B7280' },
    { name: 'Mentor 3',        role: 'Mentor',                 type: 'mentor',    email: null,                          avatar_emoji: '🏫', avatar_color: '#6B7280' },
    { name: 'Mentor 4',        role: 'Mentor',                 type: 'mentor',    email: null,                          avatar_emoji: '🏫', avatar_color: '#6B7280' },
    { name: 'Mentor 5',        role: 'Mentor',                 type: 'mentor',    email: null,                          avatar_emoji: '🏫', avatar_color: '#6B7280' },
    { name: 'Mentor 6',        role: 'Mentor',                 type: 'mentor',    email: null,                          avatar_emoji: '🏫', avatar_color: '#6B7280' },
  ];

  try {
    // Check hoeveel er al bestaan
    const tmExists = await tableExists('team_members');
    if (!tmExists) {
      report.seed_team_members = 'overgeslagen — tabel bestaat nog niet na migratie-fouten';
    } else {
      const { data: existing } = await supabase.from('team_members').select('name');
      const existingNames = new Set((existing || []).map(r => r.name));
      const toInsert = TEAM.filter(m => !existingNames.has(m.name));

      if (toInsert.length === 0) {
        report.seed_team_members = `overgeslagen — alle ${TEAM.length} teamleden al aanwezig`;
      } else {
        const { error: seedErr } = await supabase.from('team_members').insert(toInsert);
        if (seedErr) {
          report.seed_team_members = `fout: ${seedErr.message}`;
          report.errors.push(`team_members seed: ${seedErr.message}`);
        } else {
          report.seed_team_members = `${toInsert.length} teamleden toegevoegd (${toInsert.map(m => m.name).join(', ')})`;
          console.log(`[db-migrate-meetings] Team geseeded: ${toInsert.map(m => m.name).join(', ')}`);
        }
      }
    }
  } catch (e) {
    report.seed_team_members = `fout: ${e.message}`;
    report.errors.push(`team_members seed: ${e.message}`);
  }

  // ── Samenvatting ──────────────────────────────────────────────────────────
  report.ok = report.errors.length === 0;
  report.message = report.ok
    ? `Migratie succesvol — ${report.created_tables.length} tabellen aangemaakt, ${report.added_columns.length} kolommen toegevoegd`
    : `Migratie deels mislukt — ${report.errors.length} fout(en): ${report.errors.join('; ')}`;

  console.log(`[db-migrate-meetings] ${report.message}`);
  return res.status(200).json(report);
}
