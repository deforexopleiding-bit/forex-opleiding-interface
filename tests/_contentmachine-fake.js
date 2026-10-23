// tests/_contentmachine-fake.js — kleine nep-Supabase (tabellen + storage) voor
// de Contentmachine-tests. Geen testbestand zelf (geen .test.js).
//
// Ondersteunt wat api/contentmachine/*.js gebruikt: select (kolommen genegeerd,
// behalve alias:pad->>veld), eq/neq/is/in/like/gt/order/limit, maybeSingle/single,
// insert/update/upsert(+select), en storage upload/download/remove/
// createSignedUploadUrl/getPublicUrl.

import { randomUUID } from 'node:crypto';

export function maakFake() {
  const db = { tabellen: {}, ontbreekt: {}, storage: {}, log: [] };

  function waarde(rij, kolom) {
    // alias:pad->a->>b
    const m = /^(?:\w+:)?(\w+)((?:->>?\w+)*)$/.exec(kolom);
    if (!m) return rij[kolom];
    let v = rij[m[1]];
    for (const stap of (m[2].match(/->>?\w+/g) || [])) {
      const k = stap.replace(/^->>?/, '');
      v = v == null ? null : v[k];
      if (stap.startsWith('->>') && v != null && typeof v === 'object') v = JSON.stringify(v);
    }
    return v;
  }

  function projecteer(rij, kol) {
    if (!kol || kol === '*') return { ...rij };
    const uit = {};
    for (const deel of kol.split(',').map((s) => s.trim()).filter(Boolean)) {
      const alias = /^(\w+):/.exec(deel);
      const naam = alias ? alias[1] : deel.replace(/->.*$/, '');
      uit[naam] = waarde(rij, deel);
    }
    return uit;
  }

  function from(tabel) {
    const q = { tabel, filters: [], lim: null, order: [], actie: 'select', data: null, kol: '*', terug: false, enkel: null };
    const passt = (r) => q.filters.every(([op, c, v]) => {
      const x = r[c];
      if (op === 'eq') return x === v;
      if (op === 'neq') return x !== v;
      if (op === 'is') return v === null ? x == null : x === v;
      if (op === 'in') return v.includes(x);
      if (op === 'like') return typeof x === 'string' && new RegExp('^' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$').test(x);
      if (op === 'gt') return x > v;
      return true;
    });
    const k = {
      select: (kol) => { if (q.actie === 'select') q.kol = kol || '*'; else { q.terug = true; q.kol = kol || '*'; } return k; },
      eq: (c, v) => { q.filters.push(['eq', c, v]); return k; },
      neq: (c, v) => { q.filters.push(['neq', c, v]); return k; },
      is: (c, v) => { q.filters.push(['is', c, v]); return k; },
      in: (c, v) => { q.filters.push(['in', c, v]); return k; },
      like: (c, v) => { q.filters.push(['like', c, v]); return k; },
      gt: (c, v) => { q.filters.push(['gt', c, v]); return k; },
      order: (c, o) => { q.order.push([c, o?.ascending !== false]); return k; },
      limit: (n) => { q.lim = n; return k; },
      insert: (d) => { q.actie = 'insert'; q.data = d; return k; },
      update: (d) => { q.actie = 'update'; q.data = d; return k; },
      upsert: (d) => { q.actie = 'upsert'; q.data = d; return k; },
      delete: () => { q.actie = 'delete'; return k; },
      maybeSingle: () => { q.enkel = 'maybe'; return k; },
      single: () => { q.enkel = 'single'; return k; },
      then: (ok, nok) => Promise.resolve(run()).then(ok, nok),
    };
    function run() {
      db.log.push(q);
      if (db.ontbreekt[tabel]) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${tabel}'` } };
      const rijen = (db.tabellen[tabel] = db.tabellen[tabel] || []);
      let uit;
      if (q.actie === 'insert' || q.actie === 'upsert') {
        const lijst = (Array.isArray(q.data) ? q.data : [q.data]).map((d) => ({ id: randomUUID(), aangemaakt_op: new Date().toISOString(), ...d }));
        rijen.push(...lijst);
        uit = lijst;
      } else if (q.actie === 'update') {
        uit = rijen.filter(passt);
        uit.forEach((r) => Object.assign(r, q.data));
      } else if (q.actie === 'delete') {
        uit = rijen.filter(passt);
        db.tabellen[tabel] = rijen.filter((r) => !passt(r));
      } else {
        uit = rijen.filter(passt);
        for (const [c, asc] of q.order.slice().reverse()) uit = uit.slice().sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
        if (q.lim != null) uit = uit.slice(0, q.lim);
      }
      if (q.actie !== 'select' && !q.terug && !q.enkel) return { data: null, error: null };
      const data = uit.map((r) => projecteer(r, q.kol));
      if (q.enkel === 'single') return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not single' } };
      if (q.enkel === 'maybe') return { data: data[0] || null, error: null };
      return { data, error: null };
    }
    return k;
  }

  const storage = {
    from: (bucket) => ({
      upload: async (pad, bytes, opts) => { db.storage[pad] = { bytes: Buffer.from(bytes), type: opts?.contentType }; return { data: { path: pad }, error: null }; },
      download: async (pad) => (db.storage[pad] ? { data: new Blob([db.storage[pad].bytes]), error: null } : { data: null, error: { message: 'Object not found' } }),
      remove: async (paden) => { paden.forEach((p) => delete db.storage[p]); return { data: null, error: null }; },
      createSignedUploadUrl: async (pad) => ({ data: { token: 'tok-' + pad, path: pad, signedUrl: 'https://x/' + pad }, error: null }),
      getPublicUrl: (pad) => ({ data: { publicUrl: `https://cdn.test/${bucket}/${pad}` } }),
    }),
  };

  return { db, from, storage };
}

export function maakRes() {
  return {
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
