// api/_lib/funnel-split-stats.js
//
// Funnel-split-test (2026-10-21) — pure rekenkern voor "Funnels koppelen" en de
// vergelijking in "Funnelstatistieken". Per test (/go/<slug>) en per variant:
//   bezoekers  = unieke bezoekers die de router naar deze variant stuurde
//                (funnel_split_toewijzingen, bezoeker_id; zonder id telt de rij);
//   landing    = sessies met een landing-event vanuit de test (funnel_events met
//                meta.split = slug — alleen testverkeer, niet ander verkeer op de pagina);
//   opt_in     = sessies met gegevens_ok (formulier ingevuld);
//   leads      = unieke leads met lead_ingediend (een opgeslagen CRM-lead);
//   geboekt    = sessies met geboekt (call/afspraak);
//   *_pct      = t.o.v. landing (sessies), 1 decimaal; null bij 0.
// Gewicht-% = gewicht / som van de actieve gewichten (wat NIEUWE bezoekers krijgen).

export const SPLIT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const BRON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const STAP_EVENTS = Object.freeze(['landing', 'gegevens_ok', 'lead_ingediend', 'geboekt']);

/** Eigen relatief pad ('/x'), geen '//host' of schema. */
export function veiligPad(p) {
  if (typeof p !== 'string') return null;
  const s = p.trim();
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || /[\s<>"]/.test(s)) return null;
  return s.split(/[?#]/)[0] || null;
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** % verkeer per variant voor nieuwe bezoekers (alleen actief met gewicht > 0). */
export function verkeersVerdeling(varianten) {
  const totaal = (varianten || []).filter((v) => v.actief && v.gewicht > 0).reduce((n, v) => n + v.gewicht, 0);
  const uit = {};
  for (const v of varianten || []) uit[v.id] = v.actief && v.gewicht > 0 && totaal ? Math.round((v.gewicht / totaal) * 1000) / 10 : 0;
  return uit;
}

/**
 * @param {Array<{slug, id, varianten:Array}>} splits
 * @param {Array<{split_id, bron, bezoeker_id}>} toewijzingen
 * @param {Array<{split, variant, event_type, session_id, lead_id}>} events
 * @returns {Record<splitId, Record<bron, stats>>}
 */
export function berekenSplitStats(splits, toewijzingen, events) {
  const leeg = () => ({ bezoekers: new Set(), los: 0, landing: new Set(), opt_in: new Set(), leads: new Set(), geboekt: new Set() });
  const per = new Map();   // splitId → Map(bron → acc)
  const slugNaarId = new Map((splits || []).map((s) => [s.slug, s.id]));
  const acc = (splitId, bron) => {
    if (!per.has(splitId)) per.set(splitId, new Map());
    const m = per.get(splitId);
    if (!m.has(bron)) m.set(bron, leeg());
    return m.get(bron);
  };
  for (const t of toewijzingen || []) {
    if (!t || !t.split_id || !t.bron) continue;
    const a = acc(t.split_id, t.bron);
    if (t.bezoeker_id) a.bezoekers.add(t.bezoeker_id); else a.los++;
  }
  for (const e of events || []) {
    const splitId = e && slugNaarId.get(e.split);
    if (!splitId || !e.variant || !e.session_id) continue;
    const a = acc(splitId, e.variant);
    if (e.event_type === 'landing') a.landing.add(e.session_id);
    else if (e.event_type === 'gegevens_ok') a.opt_in.add(e.session_id);
    else if (e.event_type === 'lead_ingediend') a.leads.add(e.lead_id || e.session_id);
    else if (e.event_type === 'geboekt') a.geboekt.add(e.session_id);
  }
  const uit = {};
  for (const s of splits || []) {
    const m = per.get(s.id) || new Map();
    uit[s.id] = {};
    const bronnen = new Set([...(s.varianten || []).map((v) => v.bron), ...m.keys()]);
    for (const bron of bronnen) {
      const a = m.get(bron) || leeg();
      const landing = a.landing.size;
      uit[s.id][bron] = {
        bezoekers: a.bezoekers.size + a.los,
        landing, opt_in: a.opt_in.size, leads: a.leads.size, geboekt: a.geboekt.size,
        optin_pct: pct(a.opt_in.size, landing), lead_pct: pct(a.leads.size, landing), geboekt_pct: pct(a.geboekt.size, landing),
      };
    }
  }
  return uit;
}

/** NL-kalenderdag 'YYYY-MM-DD' → UTC-ISO van 00:00 Amsterdam-tijd (DST-correct). */
export function nlDagStartUtc(ymd) {
  const [j, m, d] = String(ymd).split('-').map(Number);
  const naief = Date.UTC(j, m - 1, d, 0, 0);
  const offset = (t) => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
    const g = (x) => Number(p.find((q) => q.type === x).value);
    return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(t / 60000) * 60000) / 60000;
  };
  let gok = naief - 60 * 60000;
  for (let i = 0; i < 3; i++) gok = naief - offset(gok) * 60000;
  return new Date(gok).toISOString();
}

/** Validatie van een test (instaplink). @returns {{ok:true, rij}|{ok:false, fout}} */
export function valideerSplit(b) {
  const slug = String(b?.slug || '').trim().toLowerCase();
  if (!SPLIT_SLUG_RE.test(slug)) return { ok: false, fout: 'De link-naam mag alleen kleine letters, cijfers en streepjes bevatten (max. 41 tekens).' };
  const naam = String(b?.naam || '').trim().slice(0, 120);
  if (!naam) return { ok: false, fout: 'Geef de test een naam.' };
  const fb = b?.fallback_pad == null || b.fallback_pad === '' ? null : veiligPad(b.fallback_pad);
  if (b?.fallback_pad && !fb) return { ok: false, fout: 'Het terugvalpad moet met / beginnen (bv. /kennismakingscursus-v7).' };
  return { ok: true, rij: { slug, naam, actief: b?.actief !== false, fallback_pad: fb, notitie: b?.notitie ? String(b.notitie).slice(0, 500) : null } };
}

/** Validatie van een variant. */
export function valideerVariant(b) {
  const bron = String(b?.bron || '').trim().toLowerCase();
  if (!BRON_RE.test(bron)) return { ok: false, fout: 'Kies een geldige funnel-variant.' };
  const pad = veiligPad(b?.pad);
  if (!pad) return { ok: false, fout: 'Het pad moet met / beginnen.' };
  const g = Math.round(Number(b?.gewicht));
  if (!Number.isFinite(g) || g < 0 || g > 100) return { ok: false, fout: 'Gewicht moet tussen 0 en 100 liggen.' };
  return { ok: true, rij: { bron, pad, gewicht: g, actief: b?.actief !== false, volgorde: Number.isFinite(Number(b?.volgorde)) ? Math.round(Number(b.volgorde)) : 0 } };
}
