// api/_lib/ghl-nieuwsbrief.js
//
// Contentmachine fase 5 — de nieuwsbrief gaat via GoHighLevel (beslissing Maxim,
// 23 okt 2026; GEEN Brevo). GHL blijft de bron van de lijst (~6.000 adressen) en
// van de uitschrijvingen. Dit bestand doet ENKEL wat de officiële GHL-API v2
// (services.leadconnectorhq.com, spec: github.com/GoHighLevel/highlevel-api-docs
// apps/emails.json + conversations.json + contacts.json) ondersteunt:
//
//   - e-mailtemplate aanmaken:  POST /emails/builder        { type:'html' } → { redirect: <templateId> }
//   - template vullen:          POST /emails/builder/data   { html, editorType:'html', previewText }
//   - testmail aan één contact: POST /conversations/messages { type:'Email', contactId, subject, html }
//   - campagnes + stats lezen:  GET  /emails/schedule?showStats=true  (alleen lezen)
//   - eigen contact zoeken:     GET  /contacts/search/duplicate?email=  (+ upsert als het er niet is)
//
// Een bulk-/campagneverzending AANMAKEN staat niet in de officiële spec → route (b):
// het template staat klaar in GHL, Maxim maakt de campagne en drukt zelf op versturen
// ("Open in GHL"). Deze code VERSTUURT NOOIT naar de lijst: de enige verzending is de
// testmail naar de ingelogde gebruiker.
//
// Env: GHL_PIT_TOKEN (of GHL_API_KEY), GHL_LOCATION_ID — dezelfde als de rest van het CRM.
//      GHL_NIEUWSBRIEF_USER_ID (optioneel; anders GHL_DAVE_USER_ID) — 'updatedBy' van het template.
// Scopes op het token: emails/builder.write, emails/schedule.readonly,
//      conversations/message.write, contacts.readonly, contacts.write.

export const GHL_BASE = 'https://services.leadconnectorhq.com';
const VERSIE_EMAILS = '2021-07-28';
const VERSIE_CONVERSATIES = '2021-04-15';

export class GhlNieuwsbriefFout extends Error {
  constructor(message, { code, status = null } = {}) { super(message); this.code = code; this.status = status; this.publiek = message; }
}

/** Config uit env, of null met de ontbrekende namen. */
export function ghlNieuwsbriefConfig(env = process.env) {
  const token = env.GHL_PIT_TOKEN || env.GHL_API_KEY || '';
  const locationId = env.GHL_LOCATION_ID || env.GHL_DEFAULT_LOCATION_ID || '';
  const userId = env.GHL_NIEUWSBRIEF_USER_ID || env.GHL_DAVE_USER_ID || '';
  const ontbreekt = [];
  if (!token) ontbreekt.push('GHL_PIT_TOKEN');
  if (!locationId) ontbreekt.push('GHL_LOCATION_ID');
  return { ok: ontbreekt.length === 0, ontbreekt, token, locationId, userId };
}

/** Links naar het e-mailgedeelte van GHL (de campagne maken en versturen gebeurt daar). */
export function ghlLinks(locationId) {
  const basis = `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId || '')}/marketing/emails`;
  return { campagnes: `${basis}/scheduled`, templates: `${basis}/templates` };
}

function scopeTip(status) {
  return status === 401 || status === 403 ? ' — controleer of het GHL-token (GHL_PIT_TOKEN) de juiste scopes heeft' : '';
}

async function roep(cfg, pad, { method = 'GET', body, versie = VERSIE_EMAILS, fetchImpl = fetch, wat } = {}) {
  let r;
  try {
    r = await fetchImpl(GHL_BASE + pad, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, Version: versie, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new GhlNieuwsbriefFout(`GHL niet bereikbaar (${wat}): ${e?.message || e}`, { code: 'GHL_NETWERK' });
  }
  const tekst = await r.text();
  let json = null;
  try { json = tekst ? JSON.parse(tekst) : null; } catch { /* geen json */ }
  if (!r.ok) {
    const msg = (json && (json.message || json.error)) || tekst.slice(0, 200) || `HTTP ${r.status}`;
    console.error(`[ghl-nieuwsbrief] ${wat} mislukt:`, r.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
    throw new GhlNieuwsbriefFout(`GHL ${wat}: ${Array.isArray(msg) ? msg.join(', ') : msg} (HTTP ${r.status})${scopeTip(r.status)}`, { code: 'GHL_API', status: r.status });
  }
  return json || {};
}

/** Nieuw html-template; → templateId. */
export async function maakTemplate(cfg, { naam }, fetchImpl) {
  const j = await roep(cfg, '/emails/builder', {
    method: 'POST', fetchImpl, wat: 'template aanmaken',
    body: { locationId: cfg.locationId, type: 'html', title: naam, name: naam, builderVersion: '2', isPlainText: false, ...(cfg.userId ? { updatedBy: cfg.userId } : {}) },
  });
  const id = j.redirect || j.id || (j.template && j.template.id);
  if (!id) throw new GhlNieuwsbriefFout('GHL gaf geen template-id terug.', { code: 'GHL_API' });
  return String(id);
}

/** Template vullen met de HTML (+ voorbeeldtekst). */
export async function vulTemplate(cfg, { templateId, html, previewText }, fetchImpl) {
  return roep(cfg, '/emails/builder/data', {
    method: 'POST', fetchImpl, wat: 'template vullen',
    body: {
      locationId: cfg.locationId, templateId, updatedBy: cfg.userId || 'contentmachine',
      dnd: { elements: [], attrs: {}, templateSettings: {} }, html, editorType: 'html',
      previewText: String(previewText || '').slice(0, 150), isPlainText: false,
    },
  });
}

/** GHL-contact van de ingelogde gebruiker (voor de testmail): zoeken, anders aanmaken (zonder tags). */
export async function eigenContact(cfg, { email, naam }, fetchImpl) {
  const q = new URLSearchParams({ locationId: cfg.locationId, email });
  const d = await roep(cfg, `/contacts/search/duplicate?${q}`, { fetchImpl, wat: 'contact zoeken' });
  const gevonden = d.contact && d.contact.id;
  if (gevonden) return String(gevonden);
  const u = await roep(cfg, '/contacts/upsert', {
    method: 'POST', fetchImpl, wat: 'contact aanmaken',
    body: { locationId: cfg.locationId, email, ...(naam ? { name: naam } : {}) },
  });
  const id = u.contact && u.contact.id;
  if (!id) throw new GhlNieuwsbriefFout('GHL gaf geen contact-id terug.', { code: 'GHL_API' });
  return String(id);
}

/** Testmail naar één contact (de ingelogde gebruiker). */
export async function stuurTestmail(cfg, { contactId, email, onderwerp, html }, fetchImpl) {
  return roep(cfg, '/conversations/messages', {
    method: 'POST', fetchImpl, versie: VERSIE_CONVERSATIES, wat: 'testmail',
    body: { type: 'Email', contactId, emailTo: email, subject: `[TEST] ${onderwerp}`, html },
  });
}

/**
 * Campagnes in GHL die dit template gebruiken, met stats als GHL ze meegeeft.
 * → [{ id, naam, status, stats|null }]
 */
export async function campagnesVoorTemplate(cfg, { templateId }, fetchImpl) {
  const q = new URLSearchParams({ locationId: cfg.locationId, showStats: 'true', limit: '100', campaignsOnly: 'true' });
  const j = await roep(cfg, `/emails/schedule?${q}`, { fetchImpl, wat: 'campagnes lezen' });
  const lijst = Array.isArray(j.schedules) ? j.schedules : [];
  return lijst.filter((c) => c && String(c.templateId || '') === String(templateId)).map((c) => ({
    id: String(c.id || c._id || ''), naam: c.name || '', status: c.status || '',
    stats: statsUit(c),
  }));
}

/** Stats uit een campagne-object; GHL's veldnamen zijn niet gedocumenteerd → defensief. */
export function statsUit(c) {
  const s = (c && (c.stats || c.statistics)) || null;
  if (!s || typeof s !== 'object') return null;
  const n = (...k) => { for (const x of k) if (Number.isFinite(Number(s[x]))) return Number(s[x]); return null; };
  const uit = {
    verstuurd: n('sent', 'totalSent', 'delivered', 'recipients'),
    geopend: n('opened', 'opens', 'uniqueOpens'),
    geklikt: n('clicked', 'clicks', 'uniqueClicks'),
    uitgeschreven: n('unsubscribed', 'unsubscribes'),
    bounces: n('bounced', 'bounces'),
  };
  return Object.values(uit).some((v) => v != null) ? uit : null;
}
