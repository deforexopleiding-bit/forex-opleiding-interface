// tests/_nep-db.js — kleine in-memory Supabase-nabootsing voor engine-tests.
//
// Ondersteunt de ketens die de grootboek-engine en de commissie-endpoints
// gebruiken: select / insert / update + eq / neq / in / is / gt / gte / lt /
// lte / ilike / or(no-op) / order / limit / range, en maybeSingle / single /
// await. idempotency_key is uniek (23505), net als in productie.
// Tabellen in `missing` geven 42P01 terug (migratie niet gedraaid).

let teller = 0;
export function nieuwId() {
  teller += 1;
  return `00000000-0000-4000-8000-${String(teller).padStart(12, '0')}`;
}

export function maakNepDb() {
  const db = { tables: {}, missing: new Set(), log: [] };

  function from(tabel) {
    const st = { op: 'select', filters: [], patch: null, rows: null, orders: [], limit: null, selected: false };
    const pass = (r) => st.filters.every((f) => f(r));
    const exec = () => {
      if (db.missing.has(tabel)) {
        return { data: null, error: { code: '42P01', message: `relation "public.${tabel}" does not exist` } };
      }
      const t = (db.tables[tabel] ||= []);
      if (st.op === 'insert') {
        const out = [];
        for (const raw of st.rows) {
          const row = { id: raw.id || nieuwId(), ...raw };
          if (row.idempotency_key && t.some((x) => x.idempotency_key === row.idempotency_key)) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          t.push(row);
          out.push({ ...row });
        }
        db.log.push({ op: 'insert', tabel, rows: out });
        return { data: out, error: null };
      }
      if (st.op === 'update') {
        const hit = t.filter(pass);
        for (const r of hit) Object.assign(r, st.patch);
        db.log.push({ op: 'update', tabel, ids: hit.map((r) => r.id), patch: st.patch });
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      let rows = t.filter(pass).map((r) => ({ ...r }));
      for (const o of [...st.orders].reverse()) {
        rows.sort((a, b) => {
          const va = a[o.col]; const vb = b[o.col];
          if (va == null && vb == null) return 0;
          if (va == null) return o.nullsFirst ? -1 : 1;
          if (vb == null) return o.nullsFirst ? 1 : -1;
          const c = va < vb ? -1 : va > vb ? 1 : 0;
          return o.asc ? c : -c;
        });
      }
      if (st.limit != null) rows = rows.slice(0, st.limit);
      return { data: rows, error: null };
    };
    const k = {
      select() { st.selected = true; return k; },
      insert(v) { st.op = 'insert'; st.rows = Array.isArray(v) ? v : [v]; return k; },
      update(v) { st.op = 'update'; st.patch = v; return k; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return k; },
      neq(c, v) { st.filters.push((r) => r[c] !== v); return k; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return k; },
      is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return k; },
      not(c, op, v) { if (op === 'is' && v === null) st.filters.push((r) => r[c] != null); return k; },
      gt(c, v) { st.filters.push((r) => Number(r[c]) > Number(v)); return k; },
      gte(c, v) { st.filters.push((r) => r[c] >= v); return k; },
      lt(c, v) { st.filters.push((r) => r[c] < v); return k; },
      lte(c, v) { st.filters.push((r) => r[c] <= v); return k; },
      ilike() { return k; },
      or() { return k; },
      order(col, opts = {}) { st.orders.push({ col, asc: opts.ascending !== false, nullsFirst: !!opts.nullsFirst }); return k; },
      limit(n) { st.limit = n; return k; },
      range(a, b) { st.limit = b - a + 1; return k; },
      maybeSingle: async () => { const r = exec(); return r.error ? r : { data: r.data[0] ?? null, error: null }; },
      single: async () => { const r = exec(); return r.error ? r : { data: r.data[0] ?? null, error: r.data[0] ? null : { code: 'PGRST116', message: 'no rows' } }; },
      then: (res, rej) => Promise.resolve(exec()).then(res, rej),
    };
    return k;
  }

  db.client = { from, rpc: async () => ({ data: null, error: null }) };
  db.reset = (tables = {}, missing = []) => {
    db.tables = JSON.parse(JSON.stringify(tables));
    db.missing = new Set(missing);
    db.log = [];
  };
  db.rows = (tabel) => db.tables[tabel] || [];
  return db;
}
