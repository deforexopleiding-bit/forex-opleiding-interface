// tests/lab-fake-db.js
//
// Een kleine in-memory nabootsing van de supabase-js-querybouwer, genoeg voor
// de Lab-tests: from().select().eq/ilike/is/not/in/gte/limit/order, insert,
// update, maybeSingle/single, rpc, head-counts — en auth.admin voor het LMS.
// Geen echte SQL: alleen gelijkheid, wat deze tests nodig hebben.

import crypto from 'node:crypto';

export function maakFakeDb(start = {}, { rpc = {}, ontbrekend = [] } = {}) {
  const tabellen = {};
  for (const [k, v] of Object.entries(start)) tabellen[k] = v.map((r) => ({ ...r }));
  const log = { inserts: [], updates: [], rpc: [] };

  function bouwer(tabel) {
    const st = { filters: [], head: false, patch: null, rijen: null, enkel: null, limiet: null };
    const pas = (r) => st.filters.every(([op, k, v]) => {
      const w = r[k];
      if (op === 'eq') return w === v;
      if (op === 'ilike') return String(w ?? '').toLowerCase() === String(v).toLowerCase();
      if (op === 'is') return v === null ? w == null : w === v;
      if (op === 'notnull') return w != null;
      if (op === 'in') return v.includes(w);
      if (op === 'gte') return String(w) >= String(v);
      return true;
    });
    const uitvoeren = () => {
      if (ontbrekend.includes(tabel)) {
        return { data: null, count: null, error: { code: '42P01', message: `relation "public.${tabel}" does not exist` } };
      }
      const t = (tabellen[tabel] ||= []);
      if (st.rijen) {
        const nieuw = st.rijen.map((r) => ({ id: r.id || crypto.randomUUID(), ...r }));
        for (const r of nieuw) {
          const uniek = (tabel === 'hlms_rol' && t.some((x) => x.auth_id === r.auth_id && x.rol === r.rol));
          if (uniek) return { data: null, error: { code: '23505', message: 'duplicate' } };
        }
        t.push(...nieuw);
        log.inserts.push({ tabel, rijen: nieuw });
        return { data: nieuw, error: null };
      }
      let rijen = t.filter(pas);
      if (st.patch) {
        for (const r of rijen) Object.assign(r, st.patch);
        log.updates.push({ tabel, patch: st.patch, aantal: rijen.length });
        return { data: rijen, error: null };
      }
      if (st.head) return { data: null, count: rijen.length, error: null };
      if (st.limiet != null) rijen = rijen.slice(0, st.limiet);
      return { data: rijen.map((r) => ({ ...r })), error: null };
    };
    const k = {
      select: (_c, o) => { if (o?.head) st.head = true; return k; },
      eq: (a, b) => { st.filters.push(['eq', a, b]); return k; },
      ilike: (a, b) => { st.filters.push(['ilike', a, b]); return k; },
      is: (a, b) => { st.filters.push(['is', a, b]); return k; },
      not: (a) => { st.filters.push(['notnull', a]); return k; },
      in: (a, b) => { st.filters.push(['in', a, b]); return k; },
      gte: (a, b) => { st.filters.push(['gte', a, b]); return k; },
      order: () => k,
      limit: (n) => { st.limiet = n; return k; },
      insert: (r) => { st.rijen = Array.isArray(r) ? r : [r]; return k; },
      update: (p) => { st.patch = p; return k; },
      maybeSingle: async () => { const r = uitvoeren(); return { data: r.data?.[0] || null, error: r.error }; },
      single: async () => { const r = uitvoeren(); return { data: r.data?.[0] || null, error: r.error || (r.data?.[0] ? null : { message: 'geen rij' }) }; },
      then: (ok, nok) => Promise.resolve(uitvoeren()).then(ok, nok),
    };
    return k;
  }

  const authUsers = (tabellen['auth.users'] ||= []);
  return {
    tabellen, log, authUsers,
    from: (t) => bouwer(t),
    rpc: async (naam, args) => {
      log.rpc.push({ naam, args });
      if (rpc[naam]) return rpc[naam](args, tabellen);
      return { data: null, error: { message: 'rpc onbekend: ' + naam } };
    },
    auth: {
      admin: {
        createUser: async ({ email }) => {
          if (authUsers.some((u) => u.email === email)) {
            return { data: { user: null }, error: { code: 'email_exists', message: 'A user with this email address has already been registered' } };
          }
          const u = { id: crypto.randomUUID(), email };
          authUsers.push(u);
          return { data: { user: u }, error: null };
        },
        generateLink: async ({ email }) => {
          const u = authUsers.find((x) => x.email === email);
          return u ? { data: { user: u, properties: { hashed_token: 'h' } }, error: null } : { data: null, error: { message: 'niet gevonden' } };
        },
        deleteUser: async (id) => {
          const i = authUsers.findIndex((u) => u.id === id);
          if (i >= 0) authUsers.splice(i, 1);
          return { error: null };
        },
      },
      getUser: async (token) => {
        const u = authUsers.find((x) => x.token === token);
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'ongeldig' } };
      },
    },
  };
}

/** upsert_lead zoals de echte RPC zich gedraagt: dedup op lower(email), COALESCE. */
export function upsertLeadRpc(args, tabellen) {
  const p = args.p;
  const t = (tabellen.leads ||= []);
  const bestaand = t.find((r) => String(r.email).toLowerCase() === String(p.email).toLowerCase());
  if (bestaand) {
    for (const [k, v] of Object.entries(p)) if (bestaand[k] == null && v != null) bestaand[k] = v;
    return { data: { id: bestaand.id }, error: null };
  }
  const rij = { id: crypto.randomUUID(), verwijderd_op: null, ...p };
  t.push(rij);
  return { data: { id: rij.id }, error: null };
}
