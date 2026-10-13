// tests/vast/nep-db.js
//
// Een kleine nep-PostgREST voor de belrij-toetsen.
//
// ── WAAROM DIT EEN APART BESTAND IS ─────────────────────────────────────────
// Er stonden drie kopieën van deze nabouw in drie toetsbestanden, en de eerste
// twee hadden allemaal dezelfde fout: `update(velden).in('id', lijst)` paste de
// wijziging toe op wat de filters tot dán toe selecteerden, niet op de rijen uit
// de `.in()` erna. Daardoor raakte een UPDATE méér rijen dan in productie, en
// liet een toets die juist moest bewijzen dat er één reden werd afgevinkt, een
// bug door: hij vinkte álle onverwerkte redenen van die rij af, de handmatige
// erbij.
//
// Een nabouw die ruimer is dan het echte ding, bewijst niets. Dus: één kopie,
// en de mutatie wordt pas toegepast als de keten wordt uitgevoerd.
//
// ── WAT ERIN ZIT ─────────────────────────────────────────────────────────────
// eq / in / is / not / filter (de `kolom->>pad`-vorm) / order / limit, en
// select / single / maybeSingle / insert / update / upsert. Order is een no-op:
// de toetsen die ervan afhangen zouden dan de sortering van de nabouw toetsen
// in plaats van de code. Meer dan dit nabouwen levert een toets op die zijn
// eigen nabouw toetst.

let teller = 0;

/**
 * @param {Record<string, object[]>} tabellen  begintoestand per tabel
 * @param {object} [opties]
 * @param {(tabel: string, soort: 'select'|'insert'|'update'|'upsert') => boolean|object} [opties.faalOp]
 *        geef true om die bewerking op die tabel te laten falen, zodat
 *        fail-soft-paden echt getoetst worden en niet alleen gegrepen. Geef een
 *        OBJECT om de fout zelf te bepalen — nodig zodra de code op `code`
 *        kijkt en niet alleen op het bestaan van een fout, zoals bij een
 *        unieke-index-overtreding: `{ code: '23505', message: '...' }`.
 */
export function nepDb(tabellen = {}, { faalOp = null } = {}) {
  const data = {};
  for (const [t, rijen] of Object.entries(tabellen)) data[t] = rijen.map((r) => ({ ...r }));

  const from = (tabel) => {
    data[tabel] = data[tabel] || [];
    const filters = [];
    let max = null;

    const pas = () => {
      let uit = data[tabel];
      for (const f of filters) {
        if (f.op === 'eq')   uit = uit.filter((r) => r[f.k] === f.v);
        if (f.op === 'in')   uit = uit.filter((r) => f.v.includes(r[f.k]));
        if (f.op === 'is')   uit = uit.filter((r) => (r[f.k] ?? null) === f.v);
        if (f.op === 'not')  uit = uit.filter((r) => (r[f.k] ?? null) !== f.v);
        if (f.op === 'json') uit = uit.filter((r) => String((r[f.k] || {})[f.sub] ?? '') === f.v);
      }
      return max == null ? uit : uit.slice(0, max);
    };

    const fout = (soort) => {
      const f = faalOp && faalOp(tabel, soort);
      if (!f) return null;
      return typeof f === 'object' ? f : { message: `nep-fout op ${tabel}.${soort}` };
    };

    /** Een keten die een MUTATIE uitvoert zodra ze wordt uitgevoerd — niet eerder. */
    const mutatie = (soort, doe) => {
      const voer = () => {
        const e = fout(soort);
        if (e) return { data: null, error: e };
        return { data: doe(pas()), error: null };
      };
      const kl = {
        select: () => kl,
        eq:  (k, v) => { filters.push({ op: 'eq', k, v }); return kl; },
        in:  (k, v) => { filters.push({ op: 'in', k, v }); return kl; },
        is:  (k, v) => { filters.push({ op: 'is', k, v }); return kl; },
        not: (k, _o, v) => { filters.push({ op: 'not', k, v }); return kl; },
        single:      async () => { const r = voer(); return { data: r.error ? null : (r.data[0] || null), error: r.error }; },
        maybeSingle: async () => { const r = voer(); return { data: r.error ? null : (r.data[0] || null), error: r.error }; },
        then: (res, rej) => Promise.resolve(voer()).then(res, rej),
      };
      return kl;
    };

    const k = {
      select: () => k,
      eq:  (kol, v) => { filters.push({ op: 'eq', k: kol, v }); return k; },
      in:  (kol, v) => { filters.push({ op: 'in', k: kol, v }); return k; },
      is:  (kol, v) => { filters.push({ op: 'is', k: kol, v }); return k; },
      not: (kol, _o, v) => { filters.push({ op: 'not', k: kol, v }); return k; },
      filter: (pad, _o, v) => {
        const [kol, sub] = String(pad).split('->>');
        filters.push({ op: 'json', k: kol, sub, v });
        return k;
      },
      gte: () => k, lte: () => k, gt: () => k, lt: () => k,
      order: () => k,
      limit: (n) => { max = n; return k; },
      maybeSingle: async () => {
        const e = fout('select'); if (e) return { data: null, error: e };
        return { data: pas()[0] || null, error: null };
      },
      single: async () => {
        const e = fout('select'); if (e) return { data: null, error: e };
        return { data: pas()[0] || null, error: null };
      },
      then: (res, rej) => {
        const e = fout('select');
        return Promise.resolve(e ? { data: null, error: e } : { data: pas(), error: null }).then(res, rej);
      },

      insert: (rijen) => mutatie('insert', () =>
        (Array.isArray(rijen) ? rijen : [rijen]).map((r) => {
          const nw = { id: `${tabel}-${++teller}`, ...r };
          data[tabel].push(nw);
          return nw;
        })),

      // De kern van waarom dit bestand bestaat: `doe` krijgt de rijen ná alle
      // filters, dus ook ná een `.in('id', …)` die na `.update()` komt.
      update: (velden) => mutatie('update', (raak) => {
        for (const r of raak) Object.assign(r, velden);
        return raak;
      }),

      upsert: (rijen, { onConflict } = {}) => mutatie('upsert', () => {
        const sleutels = String(onConflict || '').split(',').map((s) => s.trim()).filter(Boolean);
        const uit = [];
        for (const r of (Array.isArray(rijen) ? rijen : [rijen])) {
          const bestaand = sleutels.length
            ? data[tabel].find((x) => sleutels.every((s) => x[s] === r[s]))
            : null;
          if (bestaand) { Object.assign(bestaand, r); uit.push(bestaand); }
          else { const nw = { id: `${tabel}-${++teller}`, ...r }; data[tabel].push(nw); uit.push(nw); }
        }
        return uit;
      }),
    };
    return k;
  };

  return { from, _data: data };
}
