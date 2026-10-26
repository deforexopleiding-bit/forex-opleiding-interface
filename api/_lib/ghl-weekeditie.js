// api/_lib/ghl-weekeditie.js
//
// Contentmachine 2.0, fase 5 — de Weekeditie automatisch naar de nieuwsbrieflijst via
// GoHighLevel. De campagne-API is niet bruikbaar, dus de route is (bouwopdracht §5.3):
//
//   1. het CRM werkt één VASTE template bij: "DFO Weekeditie (actueel)" (id in app_settings);
//   2. het onderwerp gaat via de custom value "Weekeditie onderwerp" (de workflow gebruikt
//      {{ custom_values.weekeditie_onderwerp }} als onderwerp);
//   3. een GHL-workflow "DFO Weekeditie versturen" (trigger: tag toegevoegd
//      `weekeditie-verzenden` → e-mail met die template → tag verwijderen) verstuurt;
//   4. het CRM zet die tag op de contacten van de nieuwsbrieflijst (doelgroep-tag), in
//      batches binnen de GHL-ratelimiet, en slaat DND/uitgeschreven contacten over.
//
// Enkel endpoints uit de officiële API v2 (services.leadconnectorhq.com):
//   GET  /workflows/?locationId=                         (workflows.readonly)
//   GET  /locations/{id}/customValues · POST · PUT /{cvId} (locations/customValues.*)
//   GET  /locations/{id}/tags                            (locations/tags.readonly)
//   POST /contacts/search  { filters:[tags contains] }   (contacts.readonly)
//   POST /contacts/{id}/tags                             (contacts.write)
// Template aanmaken/vullen + testmail: api/_lib/ghl-nieuwsbrief.js.
//
// Ratelimiet GHL: 100 aanvragen per 10 s per location → wij blijven onder ~7/s.

import { GHL_BASE, GhlNieuwsbriefFout } from './ghl-nieuwsbrief.js';

const VERSIE = '2021-07-28';
export const STANDAARD = Object.freeze({
  template_naam: 'DFO Weekeditie (actueel)',
  workflow_naam: 'DFO Weekeditie versturen',
  verzend_tag: 'weekeditie-verzenden',
  doelgroep_tag: 'nieuwsbrief',
  custom_value_naam: 'Weekeditie onderwerp',
});
/** Minimale tijd tussen twee GHL-aanvragen bij het taggen (ms). */
export const TAG_PAUZE_MS = 150;
export const ZOEK_PAGINA = 100;

const wacht = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function roep(cfg, pad, { method = 'GET', body, fetchImpl = fetch, wat, pogingen = 3 } = {}) {
  for (let poging = 1; ; poging++) {
    let r;
    try {
      r = await fetchImpl(GHL_BASE + pad, {
        method,
        headers: { Authorization: `Bearer ${cfg.token}`, Version: VERSIE, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      if (poging < pogingen) { await wacht(1000 * poging); continue; }
      throw new GhlNieuwsbriefFout(`GHL niet bereikbaar (${wat}): ${e?.message || e}`, { code: 'GHL_NETWERK' });
    }
    // Ratelimiet of tijdelijke fout: even wachten en opnieuw.
    if ((r.status === 429 || r.status >= 500) && poging < pogingen) {
      const na = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : 0);
      await wacht(Number.isFinite(na) && na > 0 ? Math.min(na, 10) * 1000 : 2000 * poging);
      continue;
    }
    const tekst = await r.text();
    let json = null;
    try { json = tekst ? JSON.parse(tekst) : null; } catch { /* geen json */ }
    if (!r.ok) {
      const msg = (json && (json.message || json.error)) || tekst.slice(0, 200) || `HTTP ${r.status}`;
      console.error(`[ghl-weekeditie] ${wat} mislukt:`, r.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
      const tip = r.status === 401 || r.status === 403 ? ' — controleer de scopes van GHL_PIT_TOKEN' : '';
      throw new GhlNieuwsbriefFout(`GHL ${wat}: ${Array.isArray(msg) ? msg.join(', ') : msg} (HTTP ${r.status})${tip}`, { code: 'GHL_API', status: r.status });
    }
    return json || {};
  }
}

// ── workflow, custom value, tags ────────────────────────────────────────────
/** De workflow met deze naam (hoofdletterongevoelig), of null. → { id, naam, status } */
export async function zoekWorkflow(cfg, naam, fetchImpl) {
  const j = await roep(cfg, `/workflows/?locationId=${encodeURIComponent(cfg.locationId)}`, { fetchImpl, wat: 'workflows lezen' });
  const lijst = Array.isArray(j.workflows) ? j.workflows : [];
  const w = lijst.find((x) => x && String(x.name || '').trim().toLowerCase() === String(naam).trim().toLowerCase());
  return w ? { id: String(w.id), naam: w.name, status: w.status || null } : null;
}

/** Custom value voor het onderwerp: zoeken op id of naam, anders aanmaken. Zet de waarde. → { id, sleutel } */
export async function zetOnderwerp(cfg, { id = null, naam = STANDAARD.custom_value_naam, waarde }, fetchImpl) {
  const loc = encodeURIComponent(cfg.locationId);
  const j = await roep(cfg, `/locations/${loc}/customValues`, { fetchImpl, wat: 'custom values lezen' });
  const lijst = Array.isArray(j.customValues) ? j.customValues : [];
  const cv = lijst.find((x) => x && (String(x.id) === String(id) || String(x.name || '').trim().toLowerCase() === naam.toLowerCase()));
  const body = { name: cv ? cv.name : naam, value: String(waarde || '').slice(0, 250) };
  const r = cv
    ? await roep(cfg, `/locations/${loc}/customValues/${encodeURIComponent(cv.id)}`, { method: 'PUT', body, fetchImpl, wat: 'onderwerp bijwerken' })
    : await roep(cfg, `/locations/${loc}/customValues`, { method: 'POST', body, fetchImpl, wat: 'onderwerp aanmaken' });
  const uit = (r && (r.customValue || r)) || {};
  return { id: String(uit.id || (cv && cv.id) || ''), sleutel: uit.fieldKey || (cv && cv.fieldKey) || '{{ custom_values.weekeditie_onderwerp }}' };
}

/** Alle tags van de location (namen). */
export async function tagsVanLocatie(cfg, fetchImpl) {
  const j = await roep(cfg, `/locations/${encodeURIComponent(cfg.locationId)}/tags`, { fetchImpl, wat: 'tags lezen' });
  return (Array.isArray(j.tags) ? j.tags : []).map((t) => String((t && t.name) || t || '')).filter(Boolean);
}

/** Eén pagina contacten met deze tag. searchAfter = cursor van de vorige pagina. → { contacten, totaal, volgende } */
export async function zoekContactenMetTag(cfg, { tag, searchAfter = null, limiet = ZOEK_PAGINA }, fetchImpl) {
  const body = {
    locationId: cfg.locationId, pageLimit: limiet,
    filters: [{ field: 'tags', operator: 'contains', value: tag }],
    sort: [{ field: 'dateAdded', direction: 'asc' }],
    ...(searchAfter ? { searchAfter } : {}),
  };
  const j = await roep(cfg, '/contacts/search', { method: 'POST', body, fetchImpl, wat: 'contacten zoeken' });
  const contacten = Array.isArray(j.contacts) ? j.contacts : [];
  const laatste = contacten[contacten.length - 1];
  return {
    contacten,
    totaal: Number.isFinite(Number(j.total)) ? Number(j.total) : null,
    volgende: contacten.length === limiet && laatste && Array.isArray(laatste.searchAfter) ? laatste.searchAfter : null,
  };
}

/** Aantal contacten met een tag (één zoekopdracht van 1 contact). */
export async function telTag(cfg, tag, fetchImpl) {
  const r = await zoekContactenMetTag(cfg, { tag, limiet: 1 }, fetchImpl);
  return r.totaal;
}

export async function zetTag(cfg, contactId, tag, fetchImpl) {
  return roep(cfg, `/contacts/${encodeURIComponent(contactId)}/tags`, { method: 'POST', body: { tags: [tag] }, fetchImpl, wat: 'tag zetten' });
}

/**
 * Mag dit contact de tag krijgen? DND (alles of e-mail), geen e-mailadres, of de tag staat er
 * nog (dan triggert de workflow niet opnieuw) → overslaan met reden.
 */
export function magTaggen(c, { verzendTag = STANDAARD.verzend_tag } = {}) {
  if (!c || !c.id) return { ok: false, reden: 'geen id' };
  if (!String(c.email || '').includes('@')) return { ok: false, reden: 'geen e-mailadres' };
  if (c.dnd === true) return { ok: false, reden: 'DND' };
  const st = c.dndSettings && c.dndSettings.Email && String(c.dndSettings.Email.status || '').toLowerCase();
  if (st && st !== 'inactive') return { ok: false, reden: 'uitgeschreven (DND e-mail)' };
  const tags = (Array.isArray(c.tags) ? c.tags : []).map((t) => String(t).toLowerCase());
  if (tags.includes(String(verzendTag).toLowerCase())) return { ok: false, reden: 'had de verzendtag al' };
  return { ok: true };
}

/** Kandidaten voor de bestaande nieuwsbrieflijst (voor de melding "welke tag is het?"). */
export function nieuwsbriefKandidaten(tags) {
  return tags.filter((t) => /nieuwsbrief|newsletter|marktanalyse|weekeditie|mailing|optin|opt-in/i.test(t) && !/verzenden/i.test(t));
}
