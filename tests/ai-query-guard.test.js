// tests/ai-query-guard.test.js
// Unit-tests voor de AI query-guard. 6 kwaadaardige inputs moeten allemaal
// geweigerd worden; 2 legitieme queries moeten doorgelaten worden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardAiSql, AiQueryGuardError } from '../api/_lib/ai-query-guard.js';

// Helper: assert dat guard weigert met specifieke code (of any AiQueryGuardError als code=null).
function assertRejected(sql, expectedCode = null) {
  try {
    guardAiSql(sql);
    assert.fail(`Expected guard to reject:\n${sql}`);
  } catch (e) {
    assert.ok(e instanceof AiQueryGuardError, `Expected AiQueryGuardError, got ${e?.name}: ${e?.message}`);
    if (expectedCode) {
      assert.equal(e.code, expectedCode, `Expected code ${expectedCode}, got ${e.code}`);
    }
  }
}

// ── KWAADAARDIGE INPUTS (6 verplichte cases) ────────────────────────────────

test('reject: INSERT statement', () => {
  assertRejected(`INSERT INTO ai_readonly.v_klanten_overzicht (customer_id) VALUES ('x');`);
});

test('reject: UPDATE statement', () => {
  assertRejected(`UPDATE ai_readonly.v_klanten_overzicht SET klant_naam = 'x' WHERE customer_id = '1';`);
});

test('reject: DROP statement', () => {
  assertRejected(`DROP VIEW ai_readonly.v_klanten_overzicht;`);
});

test('reject: pg_sleep DoS', () => {
  assertRejected(`SELECT pg_sleep(1000000) FROM ai_readonly.v_klanten_overzicht LIMIT 1;`);
});

test('reject: multi-statement (SELECT + INSERT)', () => {
  assertRejected(`SELECT count(*) FROM ai_readonly.v_klanten_overzicht; INSERT INTO customers (first_name) VALUES ('x');`);
});

test('reject: SELECT tegen public schema (wrong schema)', () => {
  assertRejected(`SELECT * FROM public.customers LIMIT 5;`);
});

// ── EXTRA GEVAARLIJKE VARIANTEN ─────────────────────────────────────────────

test('reject: DELETE via CTE ("WITH deleted AS (DELETE ...) SELECT")', () => {
  assertRejected(`WITH deleted AS (DELETE FROM customers RETURNING id) SELECT * FROM deleted;`);
});

test('reject: dblink probing', () => {
  assertRejected(`SELECT * FROM dblink('host=evil.com dbname=x user=y', 'SELECT 1') AS t(x int);`);
});

test('reject: TRUNCATE', () => {
  assertRejected(`TRUNCATE TABLE ai_readonly.v_klanten_overzicht;`);
});

test('reject: GRANT rights', () => {
  assertRejected(`GRANT ALL ON SCHEMA public TO ai_readonly;`);
});

test('reject: subquery tegen auth.users', () => {
  assertRejected(`SELECT customer_id FROM ai_readonly.v_klanten_overzicht WHERE customer_id IN (SELECT id FROM auth.users);`);
});

test('reject: leeg', () => {
  assertRejected('', 'GUARD_EMPTY_INPUT');
});

test('reject: alleen whitespace', () => {
  assertRejected('    \n\t   ', 'GUARD_EMPTY_INPUT');
});

test('reject: SELECT 1 zonder FROM (geen tabel-referentie)', () => {
  assertRejected(`SELECT 1;`);
});

test('reject: multi-statement met verborgen semicolon-in-string werkt niet als bypass', () => {
  // De semicolon in de string moet NIET tellen; maar de tweede statement wel.
  // Deze query is een echt multi-statement dus moet gerejected worden.
  assertRejected(`SELECT ';' FROM ai_readonly.v_klanten_overzicht LIMIT 1; DROP TABLE customers;`);
});

// ── LEGITIEME QUERIES (moeten doorgelaten) ──────────────────────────────────

test('accept: eenvoudige count op ai_readonly view', () => {
  assert.doesNotThrow(() => {
    guardAiSql(`SELECT count(*) FROM ai_readonly.v_klanten_overzicht;`);
  });
});

test('accept: SELECT met WHERE + ORDER BY + LIMIT', () => {
  assert.doesNotThrow(() => {
    guardAiSql(`
      SELECT klant_naam, totaal_open_bedrag
      FROM ai_readonly.v_openstaand_per_klant
      WHERE totaal_open_bedrag > 100
      ORDER BY totaal_open_bedrag DESC
      LIMIT 10
    `);
  });
});

test('accept: JOIN tussen 2 ai_readonly views', () => {
  assert.doesNotThrow(() => {
    guardAiSql(`
      SELECT k.klant_naam, w.stage_slug
      FROM ai_readonly.v_klanten_overzicht k
      LEFT JOIN ai_readonly.v_wanbetalers_actief w ON w.customer_id = k.customer_id
      LIMIT 20
    `);
  });
});

test('accept: aggregatie met GROUP BY', () => {
  assert.doesNotThrow(() => {
    guardAiSql(`
      SELECT soort, SUM(aantal_geconverteerd) AS totaal
      FROM ai_readonly.v_leads_conversie
      GROUP BY soort
    `);
  });
});

test('accept: string met semicolon in het midden', () => {
  assert.doesNotThrow(() => {
    guardAiSql(`SELECT ';' as sep FROM ai_readonly.v_deals_per_status LIMIT 1`);
  });
});
