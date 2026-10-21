// api/funnel-splits.js
//
// Funnel-split-test (2026-10-21): beheer van de vaste instaplinks (/go/<slug> op
// de website) en hun varianten + gewichten, met per variant de cijfers.
// Leadsonderhoud → Funnels → "Funnels koppelen" en de vergelijking in
// "Funnelstatistieken". De website-router (dfo-website app/go/[slug]) leest
// dezelfde tabellen; een wijziging is daar binnen ~30 s live.
//
//   GET  ?van=YYYY-MM-DD&tot=YYYY-MM-DD   (default: laatste 30 dagen, NL-tijd)
//     → { migratie_nodig, site, periode, splits: [{ …split, link, varianten: [{ …, verkeer_pct, stats }] }] }
//   POST { actie: 'split_opslaan',      id?, slug, naam, actief, fallback_pad }
//        { actie: 'variant_opslaan',    id?, split_id, bron, pad, gewicht, actief, volgorde }
//        { actie: 'variant_verwijderen', id }
//        { actie: 'winnaar',            split_id, variant_id }   → die 100, de rest 0 (blijven aan: meten + sticky)
//        { actie: 'gelijk',             split_id }               → alle actieve varianten even zwaar
//
// Rechten: lezen leads.view, wijzigen leads.update (zoals de boek-flow-schakelaar).
// Tabellen: docs/sql-migrations/2026-10-21-funnel-splits.sql (service role).

import { supabaseAdmin, createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { berekenSplitStats, nlDagStartUtc, valideerSplit, valideerVariant, verkeersVerdeling } from './_lib/funnel-split-stats.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 1000;
export const SITE = 'https://deforexopleiding.nl';

const isMigratieFout = (e) => !!e && (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(String(e.code)) || /does not exist|schema cache/i.test(String(e.message || '')));

function nlVandaag(nu) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nu);
}
function plusDagen(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

async function haalAlles(bouw, wat) {
  const rijen = [];
  for (let van = 0; ; van += PAGE) {
    const { data, error } = await bouw().range(van, van + PAGE - 1);
    if (error) { const e = new Error(wat + ': ' + error.message); e.code = error.code; throw e; }
    rijen.push(...(data || []));
    if (!data || data.length < PAGE) return rijen;
  }
}

export function maakHandler(deps = {}) {
  const {
    db = supabaseAdmin,
    userVan = async (req) => { const { data } = await createUserClient(req).auth.getUser(); return data?.user || null; },
    magHet = (req, sleutel) => requirePermission(req, sleutel),
    nu = () => new Date(),
  } = deps;

  async function leesOverzicht(q) {
    const vandaag = nlVandaag(nu());
    const van = DATUM_RE.test(q.van || '') ? q.van : plusDagen(vandaag, -29);
    const tot = DATUM_RE.test(q.tot || '') ? q.tot : vandaag;
    if (van > tot) return { status: 400, body: { error: 'Ongeldige periode' } };
    const vanIso = nlDagStartUtc(van);
    const totIso = nlDagStartUtc(plusDagen(tot, 1));

    let splits; let varianten;
    try {
      [splits, varianten] = await Promise.all([
        haalAlles(() => db.from('funnel_splits').select('*').order('aangemaakt', { ascending: true }), 'funnel_splits'),
        haalAlles(() => db.from('funnel_split_varianten').select('*').order('volgorde', { ascending: true }), 'funnel_split_varianten'),
      ]);
    } catch (e) {
      if (isMigratieFout(e)) return { status: 200, body: { migratie_nodig: true, site: SITE, periode: { van, tot }, splits: [] } };
      throw e;
    }
    const perSplit = new Map(splits.map((s) => [s.id, []]));
    for (const v of varianten) if (perSplit.has(v.split_id)) perSplit.get(v.split_id).push(v);
    const met = splits.map((s) => ({ ...s, varianten: perSplit.get(s.id) || [] }));

    let toew = []; let events = [];
    if (met.length) {
      try {
        toew = await haalAlles(() => db.from('funnel_split_toewijzingen').select('split_id, bron, bezoeker_id')
          .gte('ts', vanIso).lt('ts', totIso), 'funnel_split_toewijzingen');
      } catch (e) { if (!isMigratieFout(e)) throw e; }
      try {
        events = await haalAlles(() => db.from('funnel_events')
          .select('variant, event_type, session_id, lead_id, split:meta->>split')
          .in('meta->>split', met.map((s) => s.slug))
          .in('event_type', ['landing', 'gegevens_ok', 'lead_ingediend', 'geboekt'])
          .gte('ts', vanIso).lt('ts', totIso), 'funnel_events');
      } catch (e) { if (!isMigratieFout(e)) throw e; }
    }
    const stats = berekenSplitStats(met, toew, events);
    return {
      status: 200,
      body: {
        migratie_nodig: false, site: SITE, periode: { van, tot },
        splits: met.map((s) => {
          const pct = verkeersVerdeling(s.varianten);
          return {
            ...s, link: `${SITE}/go/${s.slug}`,
            varianten: s.varianten.map((v) => ({ ...v, verkeer_pct: pct[v.id] || 0, stats: (stats[s.id] || {})[v.bron] || null })),
          };
        }),
      },
    };
  }

  async function schrijf(b, user) {
    const t = nu().toISOString();
    const fout = (status, error) => ({ status, body: { error } });
    const klaar = async () => ({ status: 200, body: { ok: true } });

    if (b.actie === 'split_opslaan') {
      const v = valideerSplit(b);
      if (!v.ok) return fout(400, v.fout);
      const rij = { ...v.rij, bijgewerkt: t, bijgewerkt_door: user.id };
      const q = b.id
        ? (UUID_RE.test(b.id) ? db.from('funnel_splits').update(rij).eq('id', b.id).select('id') : null)
        : db.from('funnel_splits').insert(rij).select('id');
      if (!q) return fout(400, 'Ongeldige id');
      const { data, error } = await q;
      if (error) return error.code === '23505' ? fout(409, 'Er bestaat al een link met deze naam.') : fout(500, error.message);
      return { status: 200, body: { ok: true, id: data?.[0]?.id || b.id } };
    }
    if (b.actie === 'variant_opslaan') {
      const v = valideerVariant(b);
      if (!v.ok) return fout(400, v.fout);
      if (b.id && !UUID_RE.test(b.id)) return fout(400, 'Ongeldige id');
      if (!b.id && !UUID_RE.test(String(b.split_id || ''))) return fout(400, 'Ongeldige test');
      const { error } = b.id
        ? await db.from('funnel_split_varianten').update(v.rij).eq('id', b.id).select('id')
        : await db.from('funnel_split_varianten').insert({ ...v.rij, split_id: b.split_id }).select('id');
      if (error) return error.code === '23505' ? fout(409, 'Deze variant hangt al aan deze link.') : fout(500, error.message);
      await db.from('funnel_splits').update({ bijgewerkt: t, bijgewerkt_door: user.id }).eq('id', b.split_id || '00000000-0000-0000-0000-000000000000');
      return klaar();
    }
    if (b.actie === 'variant_verwijderen') {
      if (!UUID_RE.test(String(b.id || ''))) return fout(400, 'Ongeldige id');
      const { error } = await db.from('funnel_split_varianten').delete().eq('id', b.id);
      return error ? fout(500, error.message) : klaar();
    }
    if (b.actie === 'winnaar' || b.actie === 'gelijk') {
      if (!UUID_RE.test(String(b.split_id || ''))) return fout(400, 'Ongeldige test');
      const { data: rijen, error } = await db.from('funnel_split_varianten').select('id, actief').eq('split_id', b.split_id);
      if (error) return fout(500, error.message);
      if (b.actie === 'winnaar' && !(rijen || []).some((r) => r.id === b.variant_id)) return fout(400, 'Onbekende variant');
      const actief = (rijen || []).filter((r) => r.actief);
      const gelijk = actief.length ? Math.floor(100 / actief.length) : 0;
      for (const r of rijen || []) {
        // Winnaar: verliezers blijven AAN op 0% → terugkerende bezoekers blijven sticky
        // en de winnaar (en de rest) blijft gemeten.
        const gewicht = b.actie === 'winnaar' ? (r.id === b.variant_id ? 100 : 0) : (r.actief ? gelijk : 0);
        const patch = b.actie === 'winnaar' && r.id === b.variant_id ? { gewicht, actief: true } : { gewicht };
        const { error: uErr } = await db.from('funnel_split_varianten').update(patch).eq('id', r.id);
        if (uErr) return fout(500, uErr.message);
      }
      await db.from('funnel_splits').update({ bijgewerkt: t, bijgewerkt_door: user.id }).eq('id', b.split_id);
      return klaar();
    }
    return fout(400, 'Onbekende actie');
  }

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Methode niet toegestaan' }); }
    let user = null;
    try { user = await userVan(req); } catch { user = null; }
    if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
    const sleutel = req.method === 'GET' ? 'leads.view' : 'leads.update';
    if (!(await magHet(req, sleutel))) return res.status(403).json({ error: `Geen rechten (${sleutel})`, code: 'GEEN_TOEGANG' });
    try {
      const r = req.method === 'GET' ? await leesOverzicht(req.query || {}) : await schrijf(req.body || {}, user);
      return res.status(r.status).json(r.body);
    } catch (e) {
      if (isMigratieFout(e)) return res.status(503).json({ error: 'De tabellen voor funnel-splits bestaan nog niet (migratie 2026-10-21-funnel-splits.sql).', code: 'MIGRATIE_NODIG' });
      console.error('[funnel-splits]', e?.message || e);
      return res.status(500).json({ error: 'Er ging iets mis' });
    }
  };
}

export default maakHandler();
