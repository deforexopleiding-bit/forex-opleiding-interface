// api/super-admin-ai-manager.js
//
// POST endpoint voor de AI Manager op het super_admin-dashboard.
//
// Flow:
//   1. RBAC-gate: alleen super_admin. Harde check via createUserClient +
//      profiles.role === 'super_admin' (specifieker dan verifyAdmin, dat ook
//      admin/manager toelaat).
//   2. Rate-limit: max 10 calls/uur per user via api/_lib/rate-limit.js.
//   3. Anthropic call 1 (structured output — model claude-sonnet-4-6):
//      genereer SQL + korte NL uitleg. System-prompt bevat de view-metadata uit
//      ai_readonly.v_schema_help. Instructie: alleen SELECT tegen ai_readonly.*.
//   4. Query-guard toepassen (api/_lib/ai-query-guard.js).
//      Bij reject: 1× retry richting AI met de reject-reason als context.
//      Bij 2e reject: nette foutmelding aan user.
//   5. Query uitvoeren via READ-ONLY connectie (AI_READONLY_DATABASE_URL,
//      rol ai_readonly, statement_timeout 5s, max 20 rijen). Nooit
//      supabaseAdmin/service_role client voor dit pad.
//   6. Anthropic call 2 (messages): heldere NL samenvatting van het
//      resultaat. Instructie: NIET verzinnen — alleen wat er in de data staat.
//   7. Audit-log naar agent_audit_log (fire-and-forget via supabaseAdmin).
//   8. Response: { antwoord, gebruikte_query, ruwe_data, tokens_used,
//                  guard_verdict, uitleg, row_count }.
//
// Errors → HTTP status:
//   400  invalid body / question ontbreekt
//   401  niet ingelogd
//   403  geen super_admin
//   429  rate-limit
//   503  ANTHROPIC_API_KEY of AI_READONLY_DATABASE_URL ontbreekt
//   500  overige (guard 2x reject, DB-fout, Anthropic-fout)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { checkRateLimit }                  from './_lib/rate-limit.js';
import { anthropicStructuredOutput,
         anthropicMessages,
         AnthropicClientError }            from './_lib/anthropic-client.js';
import { guardAiSql, AiQueryGuardError }   from './_lib/ai-query-guard.js';

import pg from 'pg';
const { Pool } = pg;

// ── Read-only DB pool (module-scope voor warm-reuse in Vercel Lambda's) ─────
// AI_READONLY_DATABASE_URL wijst naar de ai_readonly-rol (bewezen dicht:
// PR-A verify TESTS 4-5 tonen dat deze rol niet kan schrijven en niet bij
// public/auth kan). Klein pool + short timeouts — dit endpoint is bursty.
let _pool = null;
function getPool() {
  if (_pool) return _pool;
  const conn = process.env.AI_READONLY_DATABASE_URL;
  if (!conn) return null;
  _pool = new Pool({
    connectionString:        conn,
    max:                     3,
    idleTimeoutMillis:       30000,
    connectionTimeoutMillis: 5000,
    // Supabase eist SSL voor externe connecties
    ssl: { rejectUnauthorized: false },
  });
  _pool.on('error', (e) => console.error('[ai-manager pool]', e?.message || e));
  return _pool;
}

// ── Constants ───────────────────────────────────────────────────────────────
const MODEL_SQL_GEN       = 'claude-sonnet-4-6';
const MODEL_SUMMARY       = 'claude-sonnet-4-6';
const STATEMENT_TIMEOUT_MS = 5000;
const MAX_ROWS_RETURNED    = 20;
const MAX_QUESTION_LEN     = 2000;

// ── Helpers ─────────────────────────────────────────────────────────────────
async function loadSchemaHelp() {
  const pool = getPool();
  if (!pool) throw new Error('AI_READONLY_DATABASE_URL niet geconfigureerd');
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const { rows } = await client.query(
      `SELECT view_naam, beschrijving, kolommen FROM ai_readonly.v_schema_help ORDER BY view_naam`
    );
    return rows;
  } finally {
    client.release();
  }
}

async function runReadOnlyQuery(sql) {
  const pool = getPool();
  if (!pool) throw new Error('AI_READONLY_DATABASE_URL niet geconfigureerd');
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    // Extra defense-in-depth: expliciet read-only. De rol kan sowieso niet
    // schrijven, maar dit vangt zelfs een gap in de rol op.
    await client.query(`SET LOCAL default_transaction_read_only = on`);
    const started = Date.now();
    const { rows, rowCount } = await client.query(sql);
    return {
      rows: rows.slice(0, MAX_ROWS_RETURNED),
      row_count: rowCount ?? rows.length,
      truncated: (rowCount ?? rows.length) > MAX_ROWS_RETURNED,
      duration_ms: Date.now() - started,
    };
  } finally {
    client.release();
  }
}

// System prompt voor call 1 — SQL-generatie
function buildSqlGenSystemPrompt(schemaRows) {
  const lines = schemaRows.map(r =>
    `• ai_readonly.${r.view_naam}\n  ${r.beschrijving || ''}\n  Kolommen: ${r.kolommen || ''}`
  ).join('\n\n');
  return [
    'Je bent een SQL-assistent voor het super_admin-dashboard van De Forex Opleiding.',
    'Je krijgt een vraag in natuurlijke taal en genereert daarvoor 1 PostgreSQL SELECT-query.',
    '',
    'STRIKTE REGELS:',
    '- Uitsluitend SELECT-queries. Geen INSERT/UPDATE/DELETE/DDL.',
    '- Uitsluitend refereren naar views in schema `ai_readonly`. Nooit public.*/auth.*/etc.',
    '- Geen server-side functies zoals pg_sleep, dblink, pg_read_file.',
    '- Bij aggregaat-vragen: gebruik COUNT/SUM/AVG en GROUP BY.',
    '- Beperk resultaten waar zinvol met LIMIT (max 20 wordt sowieso afgedwongen).',
    '- Als de vraag niet met de beschikbare views beantwoord kan worden: return een SQL die geen data ophaalt (bv SELECT NULL FROM ai_readonly.v_schema_help WHERE false) en zet uitleg="Vraag kan niet met beschikbare views beantwoord worden".',
    '',
    'BESCHIKBARE VIEWS (naam · beschrijving · kolommen):',
    '',
    lines,
  ].join('\n');
}

const SQL_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    sql: {
      type: 'string',
      description: 'Eén PostgreSQL SELECT-query tegen views in schema ai_readonly. Geen puntkomma aan het eind.',
    },
    uitleg: {
      type: 'string',
      description: 'Korte NL uitleg (1 zin) van wat de query berekent.',
    },
  },
  required: ['sql', 'uitleg'],
  additionalProperties: false,
};

async function generateSqlWithRetry(question, schemaRows, previousRejection = null) {
  const system = buildSqlGenSystemPrompt(schemaRows);
  const userMsg = previousRejection
    ? `Vraag: ${question}\n\nJe vorige poging werd geweigerd door de query-guard: ${previousRejection}\nGenereer een nieuwe query die aan alle regels voldoet.`
    : `Vraag: ${question}`;

  return await anthropicStructuredOutput({
    system,
    messages: [{ role: 'user', content: userMsg }],
    tool_name: 'generate_sql',
    tool_input_schema: SQL_TOOL_SCHEMA,
    model: MODEL_SQL_GEN,
    max_tokens: 1024,
    temperature: 0.1,
  });
}

async function generateSummary(question, sql, uitleg, queryResult) {
  const rowsSample = JSON.stringify(queryResult.rows, null, 2);
  const system = [
    'Je vat het resultaat van een SQL-query samen voor de super_admin.',
    'Doe NIETS anders dan wat er letterlijk in de data staat. Geen aannames, geen extrapolatie.',
    'Als de data leeg is: zeg dat er 0 resultaten zijn.',
    'Als de data de vraag niet (volledig) beantwoordt: zeg dat expliciet.',
    'Antwoord in beknopt Nederlands (max 3 zinnen).',
  ].join('\n');
  const userMsg = [
    `Vraag: ${question}`,
    ``,
    `Query-uitleg: ${uitleg}`,
    ``,
    `SQL: ${sql}`,
    ``,
    `Resultaat (${queryResult.row_count} rijen${queryResult.truncated ? `, ${MAX_ROWS_RETURNED} getoond` : ''}):`,
    rowsSample,
  ].join('\n');
  const data = await anthropicMessages({
    system,
    messages: [{ role: 'user', content: userMsg }],
    model: MODEL_SUMMARY,
    max_tokens: 512,
    temperature: 0.2,
  });
  const textBlock = (data?.content || []).find(b => b?.type === 'text');
  return {
    text: textBlock?.text || 'Geen samenvatting beschikbaar.',
    usage: data?.usage || {},
  };
}

// Fire-and-forget audit-log naar agent_audit_log
function logAudit({ user_id, question, sql, guard_verdict, row_count, tokens, status, error_message }) {
  supabaseAdmin
    .from('agent_audit_log')
    .insert({
      agent_name:    'ai_manager',
      action:        'ai_manager.query',
      payload:       { question, generated_sql: sql, guard_verdict },
      result:        { row_count, tokens },
      status:        status || 'success',
      error_message: error_message || null,
      triggered_by:  user_id || 'system',
    })
    .then(({ error }) => {
      if (error) console.warn('[ai-manager audit] insert error:', error.message);
    });
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Auth + super_admin gate ────────────────────────────────────────────
  let user, profile;
  try {
    const supabase = createUserClient(req);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: 'Niet ingelogd' });
    }
    user = userData.user;
    const { data: profData } = await supabase
      .from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
    profile = profData;
    if (!profile || !profile.is_active || profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin' });
    }
  } catch (e) {
    console.error('[ai-manager] auth-check faalde:', e?.message || e);
    return res.status(500).json({ error: 'Auth-check faalde' });
  }

  // ── 2. Rate-limit ────────────────────────────────────────────────────────
  try {
    const { limited } = await checkRateLimit({
      req, bucket: `ai_manager:${user.id}`, maxHits: 10, withinSeconds: 3600,
    });
    if (limited) {
      return res.status(429).json({
        error: 'Rate-limit bereikt (10 calls per uur). Probeer later opnieuw.',
      });
    }
  } catch (e) {
    console.warn('[ai-manager] rate-limit check faalde (fail-open):', e?.message);
  }

  // ── 3. Body ───────────────────────────────────────────────────────────────
  let question = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    question = String(body.question || '').trim();
  } catch {
    return res.status(400).json({ error: 'Ongeldige JSON-body' });
  }
  if (!question) {
    return res.status(400).json({ error: 'Veld "question" is verplicht' });
  }
  if (question.length > MAX_QUESTION_LEN) {
    return res.status(400).json({ error: `Vraag is te lang (max ${MAX_QUESTION_LEN} tekens)` });
  }

  // ── 4. Env-check ─────────────────────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
  }
  if (!process.env.AI_READONLY_DATABASE_URL) {
    return res.status(503).json({ error: 'AI_READONLY_DATABASE_URL niet geconfigureerd' });
  }

  // ── 5. Load view-metadata ────────────────────────────────────────────────
  let schemaRows;
  try {
    schemaRows = await loadSchemaHelp();
  } catch (e) {
    console.error('[ai-manager] schema-load faalde:', e?.message || e);
    return res.status(500).json({ error: 'Kan view-metadata niet laden', detail: e?.message });
  }

  // ── 6. Anthropic call 1 (SQL-gen) + guard, 1x retry ──────────────────────
  let sqlGen, sql, uitleg, guardVerdict = 'ok', tokensCall1 = {};
  let attempt = 0;
  let lastGuardError = null;
  while (attempt < 2) {
    attempt++;
    try {
      sqlGen = await generateSqlWithRetry(question, schemaRows, lastGuardError);
      sql    = String(sqlGen?.sql || '').trim().replace(/;\s*$/, '');
      uitleg = String(sqlGen?.uitleg || '');
    } catch (e) {
      console.error('[ai-manager] Anthropic SQL-gen faalde:', e?.message || e);
      logAudit({
        user_id: user.id, question, sql: '', guard_verdict: 'error',
        row_count: 0, tokens: {}, status: 'error',
        error_message: `sql_gen: ${e?.message || e}`,
      });
      const status = e instanceof AnthropicClientError && e.code === 'ANTHROPIC_RATE_LIMIT' ? 503 : 500;
      return res.status(status).json({ error: 'SQL-generatie faalde', detail: e?.message });
    }

    try {
      guardAiSql(sql);
      guardVerdict = 'ok';
      lastGuardError = null;
      break; // guard OK, verlaat de retry-loop
    } catch (guardErr) {
      if (!(guardErr instanceof AiQueryGuardError)) {
        console.error('[ai-manager] onbekende guard-error:', guardErr);
        return res.status(500).json({ error: 'Query-guard interne fout' });
      }
      guardVerdict = guardErr.code;
      lastGuardError = `${guardErr.code}: ${guardErr.message}`;
      if (attempt >= 2) {
        // 2e keer geweigerd → hard falen
        logAudit({
          user_id: user.id, question, sql, guard_verdict: guardVerdict,
          row_count: 0, tokens: {}, status: 'error',
          error_message: `guard_2x: ${lastGuardError}`,
        });
        return res.status(500).json({
          error: 'AI kon geen veilige query genereren',
          detail: lastGuardError,
          gebruikte_query: sql,
          guard_verdict: guardVerdict,
        });
      }
      // else: retry — nieuwe iteratie
    }
  }

  // ── 7. Query uitvoeren via READ-ONLY connectie ──────────────────────────
  let queryResult;
  try {
    queryResult = await runReadOnlyQuery(sql);
  } catch (e) {
    console.error('[ai-manager] read-only query faalde:', e?.message || e);
    logAudit({
      user_id: user.id, question, sql, guard_verdict: guardVerdict,
      row_count: 0, tokens: {}, status: 'error',
      error_message: `query_exec: ${e?.message || e}`,
    });
    return res.status(500).json({
      error: 'Query uitvoeren mislukt (mogelijk timeout of syntax-issue)',
      detail: e?.message,
      gebruikte_query: sql,
      guard_verdict: guardVerdict,
    });
  }

  // ── 8. Anthropic call 2 (samenvatting) ──────────────────────────────────
  let summary;
  try {
    summary = await generateSummary(question, sql, uitleg, queryResult);
  } catch (e) {
    console.error('[ai-manager] samenvatting faalde:', e?.message || e);
    // Non-fatal — geef ruwe data terug zonder AI-samenvatting
    summary = { text: `Query leverde ${queryResult.row_count} rijen op. (Samenvatting-fout: ${e?.message})`, usage: {} };
  }

  // ── 9. Audit + response ─────────────────────────────────────────────────
  const tokens = {
    input_tokens:  (tokensCall1?.input_tokens  || 0) + (summary?.usage?.input_tokens  || 0),
    output_tokens: (tokensCall1?.output_tokens || 0) + (summary?.usage?.output_tokens || 0),
  };
  logAudit({
    user_id: user.id, question, sql, guard_verdict: guardVerdict,
    row_count: queryResult.row_count, tokens, status: 'success',
  });

  return res.status(200).json({
    antwoord:        summary.text,
    uitleg,
    gebruikte_query: sql,
    ruwe_data:       queryResult.rows,
    row_count:       queryResult.row_count,
    truncated:       queryResult.truncated,
    tokens_used:     tokens,
    guard_verdict:   guardVerdict,
    duration_ms:     queryResult.duration_ms,
  });
}
