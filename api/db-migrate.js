import { supabase, verifyAdmin } from './supabase.js';

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
    { col: 'attachments', sql: 'jsonb DEFAULT NULL' },
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
  sent_at timestamptz DEFAULT now(),
  attachments jsonb DEFAULT NULL
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
  agents: `CREATE TABLE IF NOT EXISTS agents (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  role text NOT NULL,
  department text NOT NULL,
  avatar_color text DEFAULT '#534AB7',
  avatar_emoji text DEFAULT '🤖',
  module_url text,
  is_active boolean DEFAULT true,
  personality text,
  capabilities text[],
  created_at timestamptz DEFAULT now()
);
ALTER TABLE agents DISABLE ROW LEVEL SECURITY;`,
  agent_conversations: `CREATE TABLE IF NOT EXISTS agent_conversations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid,
  agent_name text,
  role text,
  content text NOT NULL,
  conversation_session text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE agent_conversations DISABLE ROW LEVEL SECURITY;`,
  agent_meetings: `CREATE TABLE IF NOT EXISTS agent_meetings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text,
  agenda text,
  participants text[],
  transcript jsonb DEFAULT '[]',
  summary text,
  action_points jsonb DEFAULT '[]',
  status text DEFAULT 'active',
  created_by text DEFAULT 'Jeffrey',
  created_at timestamptz DEFAULT now(),
  ended_at timestamptz
);
ALTER TABLE agent_meetings DISABLE ROW LEVEL SECURITY;`,
  agent_kennisbank: `CREATE TABLE IF NOT EXISTS agent_kennisbank (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid,
  agent_name text,
  content text,
  category text,
  learned_from text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE agent_kennisbank DISABLE ROW LEVEL SECURITY;`,
  agent_learnings: `CREATE TABLE IF NOT EXISTS agent_learnings (
  id bigint generated always as identity primary key,
  agent_id text,
  agent_name text not null,
  trigger_text text not null,
  ideal_response text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
ALTER TABLE agent_learnings DISABLE ROW LEVEL SECURITY;`,
  email_messages: `CREATE TABLE IF NOT EXISTS email_messages (
  id            bigint generated always as identity primary key,
  mailbox       text not null,
  imap_uid      bigint not null,
  message_id    text,
  from_address  text,
  from_name     text,
  subject       text,
  received_at   timestamptz,
  body_snippet  text,
  category      text,
  requires_action boolean default false,
  confidence    integer,
  ai_source     text,
  raw_flags     text[],
  is_read       boolean default false,
  synced_at     timestamptz default now(),
  UNIQUE (mailbox, imap_uid)
);
CREATE INDEX IF NOT EXISTS idx_email_messages_mailbox_received ON email_messages (mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_category ON email_messages (category);
ALTER TABLE email_messages DISABLE ROW LEVEL SECURITY;`,
  backfill_progress: `CREATE TABLE IF NOT EXISTS backfill_progress (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox               text NOT NULL UNIQUE,
  start_date            timestamptz NOT NULL,
  end_date              timestamptz,
  status                text NOT NULL DEFAULT 'pending',
  total_uids            int,
  oldest_uid            bigint,
  newest_uid            bigint,
  last_processed_uid    bigint,
  mails_total_estimated int DEFAULT 0,
  mails_processed       int DEFAULT 0,
  mails_skipped         int DEFAULT 0,
  mails_failed          int DEFAULT 0,
  started_at            timestamptz DEFAULT now(),
  last_batch_at         timestamptz,
  completed_at          timestamptz,
  error_count           int DEFAULT 0,
  last_error            text,
  last_error_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_backfill_status ON backfill_progress (status, last_batch_at);
ALTER TABLE backfill_progress DISABLE ROW LEVEL SECURITY;`,
  email_sync_log: `CREATE TABLE IF NOT EXISTS email_sync_log (
  id          bigint generated always as identity primary key,
  mailbox     text not null,
  synced_at   timestamptz default now(),
  new_count   integer default 0,
  last_uid    bigint default 0,
  duration_ms integer,
  status      text default 'ok',
  error_msg   text
);
CREATE INDEX IF NOT EXISTS idx_email_sync_log_mailbox ON email_sync_log (mailbox, synced_at DESC);
ALTER TABLE email_sync_log DISABLE ROW LEVEL SECURITY;`,
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

  // K2 — super_admin-only gate vóór alle DB-actie. Endpoint kan schema
  // wijzigen (ALTER TABLE / CREATE TABLE via RPC). Client-side auto-trigger
  // in taken.html is verwijderd; alleen bewuste super_admin-calls mogen door.
  const admin = await verifyAdmin(req);
  if (!admin || admin.profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden' });
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

  // ── Seed vertrouwde afzenders in email_patterns ──────────────────────────
  const TRUSTED = [
    { email: 'no-reply-forms@webflow.com',                      domain: 'webflow.com' },
    { email: 'noreply@send.lcmsgsndr.net',                      domain: 'send.lcmsgsndr.net' },
    { email: 'info+deforexopleiding.nl@send.lcmsgsndr.net',     domain: 'send.lcmsgsndr.net' },
  ];
  const trustedEmails = TRUSTED.map((t) => t.email);
  try {
    // Verwijder verkeerde Reclame patronen voor deze afzenders
    await supabase.from('email_patterns')
      .delete()
      .eq('category', 'Reclame')
      .in('sender_email', trustedEmails);
    // Upsert als trusted_sender
    for (const t of TRUSTED) {
      const { error } = await supabase.from('email_patterns').upsert({
        sender_email:  t.email,
        sender_domain: t.domain,
        category:      'Nieuwe Lead',
        confidence:    100,
        source:        'trusted_sender',
        times_seen:    999,
        requires_action: false,
        last_corrected_at: new Date().toISOString(),
      }, { onConflict: 'sender_email' });
      if (error) console.warn('[db-migrate] trusted_sender upsert fout:', t.email, error.message);
      else console.log('[db-migrate] trusted_sender geseeded:', t.email);
    }
    report.trusted_senders_seeded = true;
  } catch (e) {
    console.warn('[db-migrate] trusted_sender seed fout:', e.message);
    report.trusted_senders_seeded = false;
  }

  // ── Seed agents ──────────────────────────────────────────────────────────
  try {
    const { data: existingAgents } = await supabase.from('agents').select('name').limit(1);
    if (existingAgents !== null && existingAgents.length === 0) {
      await supabase.from('agents').insert([
        {
          name: 'Simon', role: 'E-mail Agent', department: 'Communicatie',
          avatar_color: '#534AB7', avatar_emoji: '📧', module_url: '/modules/email.html',
          personality: 'Je bent Simon, de E-mail Agent van De Forex Opleiding. Je bent nauwkeurig, efficient en vriendelijk. Je beheert alle inkomende en uitgaande e-mails en leert continu van correcties. Je communiceert altijd in het Nederlands. Als Jeffrey je iets vraagt over de inbox, geef je concrete cijfers en inzichten. Als Jeffrey je vraagt een actie uit te voeren, bevestig je eerst voordat je uitvoert.',
          capabilities: ['E-mails categoriseren', 'AI antwoorden genereren', 'Leads tellen', 'Kennisbank vullen', 'Rapporten genereren'],
        },
        {
          name: 'Leon', role: 'Administratief Medewerker', department: 'Administratie',
          avatar_color: '#1D9E75', avatar_emoji: '📋', module_url: null,
          personality: 'Je bent Leon, de Administratief Medewerker van De Forex Opleiding. Je bent georganiseerd, proactief en precies. Je beheert administratieve processen, contracten en klant onboarding. Je communiceert altijd in het Nederlands. Je houdt overzicht over alle lopende processen en taken.',
          capabilities: ['Documenten beheren', 'Contracten opstellen', 'Klanten onboarden', 'Taken coördineren', 'Rapporten maken'],
        },
        {
          name: 'Aron', role: 'Financieel Medewerker', department: 'Financiën',
          avatar_color: '#EF9F27', avatar_emoji: '💰', module_url: null,
          personality: 'Je bent Aron, de Financieel Medewerker van De Forex Opleiding. Je bent analytisch, betrouwbaar en resultaatgericht. Je beheert facturen, betalingen en financiële rapporten. Je communiceert altijd in het Nederlands. Je hebt oog voor detail en signaleert financiële risico\'s proactief.',
          capabilities: ['Facturen opvolgen', 'Wanbetalers beheren', 'Financiële rapporten', 'Teamleader koppeling', 'Betalingsherinneringen'],
        },
      ]);
      report.agents_seeded = true;
      console.log('[db-migrate] Agents geseeded: Simon, Leon, Aron');
    } else {
      report.agents_seeded = false;
    }
  } catch (e) {
    console.warn('[db-migrate] agents seed fout:', e.message);
    report.agents_seeded = false;
  }

  console.log('[db-migrate]', report.message, '· ontbrekend:', report.missing.map((m) => `${m.table}.${m.col}`).join(', '));
  return res.status(200).json(report);
}
