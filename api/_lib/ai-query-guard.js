// api/_lib/ai-query-guard.js
//
// Defense-in-depth SQL-guard voor de AI Manager. Bewijst dat een door de LLM
// gegenereerde SQL-string strikt SELECT-only is en uitsluitend refereert naar
// het whitelist-schema `ai_readonly`.
//
// LAAG A — Regex-tripwires (goedkoop, snel):
//   * geen multi-statement (semicolons buiten string)
//   * geen INSERT/UPDATE/DELETE/COPY/ALTER/CREATE/DROP/GRANT/REVOKE/TRUNCATE/CALL/DO/EXECUTE
//   * geen server-side functions (pg_sleep / pg_read_file / pg_ls_dir / dblink / lo_import / lo_export)
//
// LAAG B — node-sql-parser AST (structureel):
//   * exact 1 statement
//   * type === 'select'
//   * elke tabel-referentie zit in schema 'ai_readonly' (via parser.tableList)
//
// LAAG C — de DB zelf: zelfs als beide lagen falen, kan de rol `ai_readonly` niet
// bij public.* (bewezen door PR-A verify tests). Dit is de finale rechter.
//
// Deze module gooit `AiQueryGuardError` met `.code` bij reject.

// node-sql-parser v5.4 exposes { Parser } via default export in ESM.
import pkg from 'node-sql-parser';
const { Parser } = pkg;

const parser = new Parser();

// Kritieke keywords die NOOIT in een AI-gegenereerde read-only query horen.
// (Woord-boundary + case-insensitive.)
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'COPY', 'ALTER', 'CREATE',
  'DROP', 'GRANT', 'REVOKE', 'TRUNCATE', 'CALL', 'DO', 'EXECUTE',
  'MERGE', 'REFRESH', 'REASSIGN', 'ANALYZE', 'VACUUM', 'CLUSTER',
];

// Server-side functions die of DoS-vectors of file/network access opleveren.
const FORBIDDEN_FUNCTIONS = [
  'pg_sleep', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_ls_logdir',
  'pg_ls_waldir', 'dblink', 'dblink_connect', 'lo_import', 'lo_export',
  'lo_from_bytea', 'pg_terminate_backend', 'pg_cancel_backend',
  'pg_reload_conf', 'pg_rotate_logfile', 'pg_notify', 'pg_stat_reset',
];

const ALLOWED_SCHEMA = 'ai_readonly';

export class AiQueryGuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AiQueryGuardError';
    this.code = code;
    this.details = details;
  }
}

// ── LAAG A — regex-tripwires ────────────────────────────────────────────────
function checkRegexTripwires(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');

  // Multi-statement: elke ; buiten een string is een tweede statement.
  // We doen een ruwe check: strip alle string-literals + comments, dan zoek `;`.
  const stripped = stripStringsAndComments(trimmed);
  if (stripped.includes(';')) {
    throw new AiQueryGuardError('GUARD_MULTI_STATEMENT',
      'Meerdere statements zijn niet toegestaan (semicolon buiten string).');
  }

  // Forbidden keywords (woord-boundary, case-insensitive)
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(stripped)) {
      throw new AiQueryGuardError('GUARD_FORBIDDEN_KEYWORD',
        `Verboden keyword: ${kw}`, { keyword: kw });
    }
  }

  // Forbidden functions
  for (const fn of FORBIDDEN_FUNCTIONS) {
    const re = new RegExp(`\\b${fn}\\s*\\(`, 'i');
    if (re.test(stripped)) {
      throw new AiQueryGuardError('GUARD_FORBIDDEN_FUNCTION',
        `Verboden functie: ${fn}`, { function: fn });
    }
  }

  // Query moet met SELECT of WITH (CTE die met SELECT eindigt) beginnen.
  // Extra vangnet: ook zonder AST-parse gaan we een niet-SELECT niet door laten.
  if (!/^\s*(SELECT|WITH)\b/i.test(stripped)) {
    throw new AiQueryGuardError('GUARD_NOT_SELECT_STATEMENT',
      'Query moet met SELECT of WITH beginnen.');
  }
}

// Strip strings ('...' + "...") + line-comments (-- tot einde regel) + block-comments (/* ... */)
// zodat een `;` in een string-literal of comment geen false-positive geeft.
function stripStringsAndComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    // block comment
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // line comment
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? n : end;
      continue;
    }
    // single-quoted string (incl. '' escape)
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    // double-quoted identifier (incl. "" escape) — behandelen als "opaque" (niet strippen; identifiers zijn belangrijk voor keyword-check)
    // maar wel de inhoud passthroughen zodat AST later klopt; hier laten we het gewoon staan.
    if (c === '"') {
      out += c; i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { out += '""'; i += 2; continue; }
        if (sql[i] === '"') { out += '"'; i++; break; }
        out += sql[i]; i++;
      }
      continue;
    }
    // dollar-quoted string $$ ... $$ (PL/pgSQL) — voor de zekerheid ook strippen
    if (c === '$') {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_]*)\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// ── LAAG B — AST-check (node-sql-parser) ────────────────────────────────────
function checkAstWhitelist(sql) {
  let ast;
  try {
    ast = parser.astify(sql, { database: 'postgresql' });
  } catch (e) {
    throw new AiQueryGuardError('GUARD_UNPARSEABLE',
      'SQL is niet parsbaar door node-sql-parser: ' + (e?.message || String(e)));
  }
  const stmts = Array.isArray(ast) ? ast : [ast];
  if (stmts.length !== 1) {
    throw new AiQueryGuardError('GUARD_MULTI_STATEMENT_AST',
      `AST-parse leverde ${stmts.length} statements op — exact 1 vereist.`);
  }
  const stmt = stmts[0];
  if (stmt.type !== 'select') {
    throw new AiQueryGuardError('GUARD_NOT_SELECT_AST',
      `Statement-type is '${stmt.type}', alleen 'select' toegestaan.`);
  }

  // tableList format: 'op::schema::table', bv 'select::ai_readonly::v_klanten_overzicht'
  // Schema kan 'null' zijn als parser 't niet kan afleiden (bv. bare FROM).
  let tableList;
  try {
    tableList = parser.tableList(sql, { database: 'postgresql' });
  } catch (e) {
    throw new AiQueryGuardError('GUARD_TABLELIST_FAIL',
      'Kan tabel-lijst niet afleiden: ' + (e?.message || String(e)));
  }
  if (!Array.isArray(tableList) || tableList.length === 0) {
    // Kan gebeuren bij `SELECT 1` zonder FROM — dat is safe maar zinloos.
    // We accepteren het niet als resultaat, want de AI heeft dan gefaald om
    // de views te gebruiken.
    throw new AiQueryGuardError('GUARD_NO_TABLES',
      'Query bevat geen FROM-clause op een ai_readonly-view.');
  }
  for (const t of tableList) {
    const parts = t.split('::');
    if (parts.length < 3) {
      throw new AiQueryGuardError('GUARD_TABLE_PARSE_FAIL',
        `Kan tabelref '${t}' niet parsen.`);
    }
    const [op, schema, tbl] = parts;
    if (op !== 'select') {
      throw new AiQueryGuardError('GUARD_NON_SELECT_OP',
        `Non-select operatie '${op}' op ${schema}.${tbl}.`);
    }
    if (schema !== ALLOWED_SCHEMA) {
      throw new AiQueryGuardError('GUARD_WRONG_SCHEMA',
        `Tabel '${schema}.${tbl}' zit niet in whitelist-schema '${ALLOWED_SCHEMA}'.`,
        { table: `${schema}.${tbl}` });
    }
  }
}

// ── Publieke API ────────────────────────────────────────────────────────────
export function guardAiSql(sql) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new AiQueryGuardError('GUARD_EMPTY_INPUT', 'SQL is leeg.');
  }
  if (sql.length > 10000) {
    throw new AiQueryGuardError('GUARD_TOO_LONG',
      'SQL is te lang (>10000 chars).');
  }
  checkRegexTripwires(sql);
  checkAstWhitelist(sql);
  return true;
}
