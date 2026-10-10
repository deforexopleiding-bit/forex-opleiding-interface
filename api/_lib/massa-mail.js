// api/_lib/massa-mail.js
//
// Massa-e-mail fase 2a (2026-10-10): een groep leads in één keer een e-mail
// sturen via een getemporiseerde wachtrij.
//
//   zoekSegment     — alle (niet-verwijderde) leads met de verrijking die de
//                     filters nodig hebben (categorie, massa-geschiedenis,
//                     afmelding) + de combineerbare filters (AND). ~600 leads:
//                     in één keer laden en in JS filteren is ruim snel genoeg.
//   planCampagne    — wie krijgt de mail en wie wordt overgeslagen (geen geldig
//                     adres / afgemeld / voorkeur uit / dubbel adres) — PURE.
//   maakCampagne    — preview (exact aantal + voorbeeldmail) of start
//                     (massa_campagnes + massa_items in de wachtrij).
//   verwerkWachtrij — de worker (cron + "nu een portie"): per campagne max
//                     `portie` items per run, rustige pauze tussen mails, een
//                     daglimiet over alle campagnen, stille uren 21–08. Per
//                     ontvanger exact de fase-1 verzending (verstuurMail), met
//                     afmeldlink + List-Unsubscribe; logt in de draad
//                     (email_replies) en zet de item-status.
//
// Afmelden/voorkeuren: lead_mail_voorkeuren (1 rij per e-mailadres, met token).
// De publieke pagina staat op dfo-website (/voorkeuren?token=…). Bij ELKE
// verzending wordt opnieuw gekeken (wie zich na het inplannen afmeldt, wordt
// alsnog overgeslagen).

import crypto from 'node:crypto';
import { EMAIL_RE, schoonHtml, onbekendeVariabelen, leadVariabelen, vulMailVariabelen, verstuurMail, LeadBerichtFout } from './lead-bericht.js';
import { renderLeadMail, htmlNaarTekst } from './mail-shell-lead.js';
import { bepaalCategorieen } from './inbox-categorie.js';
import { sluitSmtpPools } from './send-email-core.js';

export const MIGRATIE = '2026-10-10-massa-mail-fase2a.sql';
export const WEBSITE_URL = String(process.env.WEBSITE_URL || 'https://www.deforexopleiding.nl').replace(/\/+$/, '');
export const MASSA_SOORTEN = Object.freeze({
  tips: 'Tips & lessen over traden',
  events: 'Webinars & events',
  aanbod: 'Aanbiedingen & cursusnieuws',
});
export const STANDAARD_PORTIE = 100;
export const MAX_PORTIE = 500;
export const MAX_ONTVANGERS = 5000;
export const STANDAARD_INSTELLINGEN = Object.freeze({ dag_max: 500, pauze_ms: 1500, stille_uren: true });
export const CATEGORIEEN = ['wanbetaler', 'onboarding', 'leadsonderhoud', 'lead_aanmelding', 'events', 'klant', 'onbekend'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const LEAD_VELDEN = 'id, voornaam, achternaam, email, telefoon_e164, bron, soort, traject, status, kwalificatie, aangemaakt, afspraak_op, customer_id, toestemming';

/** Ontbreekt een van de nieuwe tabellen (migratie niet gedraaid)? */
export const tabelOntbreekt = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(String(e.message || '')));

export class MassaFout extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

// ── Voorkeuren (token) ───────────────────────────────────────────────────────

export const nieuwToken = () => crypto.randomBytes(32).toString('base64url');
export const voorkeurenUrl = (token) => `${WEBSITE_URL}/voorkeuren?token=${encodeURIComponent(token)}`;
/** One-click afmelden (RFC 8058, POST) — de List-Unsubscribe-header. */
export const afmeldUrl = (token) => `${WEBSITE_URL}/api/voorkeuren?token=${encodeURIComponent(token)}`;

/** Mag dit adres een mail van deze soort krijgen? PURE. */
export function magOntvangen(voorkeur, soort) {
  if (!voorkeur) return { ok: true, reden: null };
  if (voorkeur.afgemeld) return { ok: false, reden: 'afgemeld' };
  const v = voorkeur.voorkeuren && typeof voorkeur.voorkeuren === 'object' ? voorkeur.voorkeuren : {};
  if (soort && v[soort] === false) return { ok: false, reden: 'voorkeur_uit' };
  return { ok: true, reden: null };
}

/** De voorkeur-rij van een adres; maakt hem (met token) aan als hij er nog niet is. */
export async function zorgVoorkeur(sb, email, leadId = null) {
  const adres = String(email || '').trim().toLowerCase();
  const lees = () => sb.from('lead_mail_voorkeuren').select('id, email, token, afgemeld, voorkeuren').eq('email', adres).maybeSingle();
  const { data, error } = await lees();
  if (error) throw new Error('voorkeur lezen: ' + error.message);
  if (data) return data;
  const { data: nieuw, error: insErr } = await sb.from('lead_mail_voorkeuren')
    .insert({ email: adres, lead_id: leadId, token: nieuwToken() })
    .select('id, email, token, afgemeld, voorkeuren').single();
  if (!insErr) return nieuw;
  if (insErr.code === '23505') { // gelijktijdig aangemaakt → die gebruiken
    const { data: d2, error: e2 } = await lees();
    if (e2 || !d2) throw new Error('voorkeur na conflict lezen: ' + (e2?.message || 'leeg'));
    return d2;
  }
  throw new Error('voorkeur aanmaken: ' + insErr.message);
}

// ── Filters ──────────────────────────────────────────────────────────────────

const lijst = (v) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])).map((x) => String(x).trim()).filter(Boolean);
const keuze = (v, toegestaan) => (toegestaan.includes(String(v || '')) ? String(v) : '');
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Canoniek filterobject; onbekende waarden vallen weg (= niet filteren). PURE. */
export function normaliseerFilter(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const m = r.massa && typeof r.massa === 'object' ? r.massa : {};
  const dagen = Math.max(1, Math.min(3650, Math.floor(Number(m.dagen) || 30)));
  return {
    q: String(r.q || '').trim().toLowerCase().slice(0, 100),
    status: lijst(r.status).filter((s) => ['nieuw', 'opgevolgd', 'gewonnen', 'verloren'].includes(s)),
    klant: keuze(r.klant, ['ja', 'nee']),
    kennismaking: keuze(r.kennismaking, ['gehad', 'ingepland', 'geen', 'ooit']),
    kwalificatie: keuze(r.kwalificatie, ['toegang', 'geen toegang', 'onder-drempel', 'knock-out', 'geen']),
    bron: lijst(r.bron),
    soort: lijst(r.soort),
    traject: lijst(r.traject).map((t) => t.toLowerCase()),
    categorie: keuze(r.categorie, CATEGORIEEN),
    wanbetaler_onboarding: keuze(r.wanbetaler_onboarding, ['uitsluiten', 'alleen_wanbetaler', 'alleen_onboarding']),
    van: DATUM_RE.test(String(r.van || '')) ? String(r.van) : '',
    tot: DATUM_RE.test(String(r.tot || '')) ? String(r.tot) : '',
    email: keuze(r.email, ['ja', 'nee']),
    nummer: keuze(r.nummer, ['ja', 'nee']),
    toestemming: keuze(r.toestemming, ['ja', 'nee']),
    afgemeld: keuze(r.afgemeld, ['verbergen', 'alleen']),
    massa: {
      modus: keuze(m.modus, ['nooit', 'dagen', 'campagne', 'alleen_gehad']),
      dagen,
      campagne_id: UUID_RE.test(String(m.campagne_id || '')) ? String(m.campagne_id) : '',
    },
    lead_ids: lijst(r.lead_ids).filter((id) => UUID_RE.test(id)).slice(0, MAX_ONTVANGERS),
  };
}

/** Kalenderdag (YYYY-MM-DD) in Amsterdam. PURE. */
export function amsDag(iso) {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(t);
}

/** Kennismakingsgesprek uit leads.afspraak_op: in de toekomst = ingepland, voorbij = gehad. PURE. */
export function kennismakingVan(afspraakOp, nuMs) {
  const t = afspraakOp ? Date.parse(afspraakOp) : NaN;
  if (!Number.isFinite(t)) return 'geen';
  return t > nuMs ? 'ingepland' : 'gehad';
}

/**
 * Voldoet een (verrijkte) lead aan het filter? Alle filters zijn AND. PURE.
 * Verrijking: categorie, tags[], is_klant, kennismaking, laatst_massa_op,
 * massa_campagnes[], afgemeld, geldig_email, geldig_nummer.
 */
export function leadVoldoet(l, f, nuMs = Date.now()) {
  if (f.lead_ids.length && !f.lead_ids.includes(l.id)) return false;
  if (f.q) {
    const hooi = `${l.voornaam || ''} ${l.achternaam || ''} ${l.email || ''} ${l.telefoon_e164 || ''}`.toLowerCase();
    if (!hooi.includes(f.q)) return false;
  }
  if (f.status.length && !f.status.includes(l.status || 'nieuw')) return false;
  if (f.klant === 'ja' && !l.is_klant) return false;
  if (f.klant === 'nee' && l.is_klant) return false;
  if (f.kennismaking === 'ooit') { if (l.kennismaking === 'geen') return false; }
  else if (f.kennismaking && l.kennismaking !== f.kennismaking) return false;
  // Kwalificatie: zelfde betekenis als api/leads-list.js (knock-out/onder-drempel = 'geen toegang', geen = leeg).
  if (f.kwalificatie) {
    const k = l.kwalificatie || '';
    const doel = f.kwalificatie === 'geen' ? '' : (['knock-out', 'onder-drempel'].includes(f.kwalificatie) ? 'geen toegang' : f.kwalificatie);
    if (k !== doel) return false;
  }
  if (f.bron.length && !f.bron.includes(l.bron || '')) return false;
  if (f.soort.length && !f.soort.includes(l.soort || '')) return false;
  if (f.traject.length && !f.traject.includes(String(l.traject || '').toLowerCase())) return false;
  if (f.categorie && l.categorie !== f.categorie) return false;
  const alle = [l.categorie, ...(l.tags || [])];
  if (f.wanbetaler_onboarding === 'uitsluiten' && (alle.includes('wanbetaler') || alle.includes('onboarding'))) return false;
  if (f.wanbetaler_onboarding === 'alleen_wanbetaler' && !alle.includes('wanbetaler')) return false;
  if (f.wanbetaler_onboarding === 'alleen_onboarding' && !alle.includes('onboarding')) return false;
  const dag = amsDag(l.aangemaakt);
  if (f.van && (!dag || dag < f.van)) return false;
  if (f.tot && (!dag || dag > f.tot)) return false;
  if (f.email === 'ja' && !l.geldig_email) return false;
  if (f.email === 'nee' && l.geldig_email) return false;
  if (f.nummer === 'ja' && !l.geldig_nummer) return false;
  if (f.nummer === 'nee' && l.geldig_nummer) return false;
  if (f.toestemming === 'ja' && l.toestemming !== true) return false;
  if (f.toestemming === 'nee' && l.toestemming === true) return false;
  if (f.afgemeld === 'verbergen' && l.afgemeld) return false;
  if (f.afgemeld === 'alleen' && !l.afgemeld) return false;
  const m = f.massa;
  if (m.modus === 'nooit' && l.laatst_massa_op) return false;
  if (m.modus === 'alleen_gehad' && !l.laatst_massa_op) return false;
  if (m.modus === 'dagen' && l.laatst_massa_op && Date.parse(l.laatst_massa_op) >= nuMs - m.dagen * 86400000) return false;
  if (m.modus === 'campagne' && m.campagne_id && (l.massa_campagnes || []).includes(m.campagne_id)) return false;
  return true;
}

// ── Segment (DB) ─────────────────────────────────────────────────────────────

async function inBlokken(ids, maak, blok = 200) {
  const uit = [];
  for (let i = 0; i < ids.length; i += blok) {
    const { data, error } = await maak(ids.slice(i, i + blok));
    if (error) return { data: uit, error };
    uit.push(...(data || []));
  }
  return { data: uit, error: null };
}

async function alleLeads(sb, ids = null) {
  if (ids && ids.length) {
    return inBlokken(ids, (d) => sb.from('leads').select(LEAD_VELDEN).in('id', d).is('verwijderd_op', null));
  }
  const uit = [];
  for (let van = 0; van < 50000; van += 1000) {
    const { data, error } = await sb.from('leads').select(LEAD_VELDEN).is('verwijderd_op', null)
      .order('aangemaakt', { ascending: false }).range(van, van + 999);
    if (error) return { data: uit, error };
    uit.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: uit, error: null };
}

/**
 * Leads + verrijking + filter. -> { items, totaal, tabel_ontbreekt }
 * items zijn compact (geen PII buiten naam/e-mail/telefoon die de lijst toont).
 */
export async function zoekSegment(sb, filterRaw, { nu = new Date() } = {}) {
  const f = normaliseerFilter(filterRaw);
  const nuMs = nu.getTime();
  const { data: leads, error } = await alleLeads(sb, f.lead_ids.length ? f.lead_ids : null);
  if (error) throw new Error('leads lezen: ' + error.message);
  const ids = leads.map((l) => l.id);

  // Categorie (wanbetaler/onboarding/klant/…): dezelfde berekening als de inbox.
  let cats = new Map();
  try {
    cats = await bepaalCategorieen(sb, leads.map((l) => ({ sleutel: l.id, telefoon: l.telefoon_e164 || null, customer_id: l.customer_id || null })), { nu });
  } catch (e) {
    console.error('[massa-mail] categorie bepalen mislukt (filter op categorie werkt dan niet):', e?.message || e);
  }

  // Massa-geschiedenis + afmeldingen. Ontbrekende tabellen → leeg + vlag.
  let tabelOntbreektVlag = false;
  const historie = new Map(); // lead_id -> { laatst, campagnes:Set }
  const { data: items, error: iErr } = await inBlokken(ids, (d) => sb.from('massa_items')
    .select('lead_id, campagne_id, verzonden_op').eq('status', 'sent').in('lead_id', d));
  if (iErr) {
    if (tabelOntbreekt(iErr)) tabelOntbreektVlag = true;
    else console.error('[massa-mail] massa_items lezen mislukt:', iErr.message);
  }
  for (const it of items || []) {
    const h = historie.get(it.lead_id) || { laatst: null, campagnes: new Set() };
    h.campagnes.add(it.campagne_id);
    if (it.verzonden_op && (!h.laatst || it.verzonden_op > h.laatst)) h.laatst = it.verzonden_op;
    historie.set(it.lead_id, h);
  }
  const adressen = [...new Set(leads.map((l) => String(l.email || '').trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
  const voorkeurOp = new Map();
  const { data: vk, error: vErr } = await inBlokken(adressen, (d) => sb.from('lead_mail_voorkeuren')
    .select('email, afgemeld, voorkeuren').in('email', d));
  if (vErr) {
    if (tabelOntbreekt(vErr)) tabelOntbreektVlag = true;
    else console.error('[massa-mail] voorkeuren lezen mislukt:', vErr.message);
  }
  for (const v of vk || []) voorkeurOp.set(v.email, v);

  const verrijkt = leads.map((l) => {
    const c = cats.get(l.id);
    const email = String(l.email || '').trim().toLowerCase();
    const h = historie.get(l.id);
    const v = voorkeurOp.get(email);
    const categorie = c ? c.categorie : null;
    const tags = c ? c.tags : [];
    return {
      ...l,
      email,
      categorie,
      tags,
      is_klant: !!l.customer_id || l.status === 'gewonnen' || categorie === 'klant' || tags.includes('klant'),
      kennismaking: kennismakingVan(l.afspraak_op, nuMs),
      laatst_massa_op: h ? h.laatst : null,
      massa_campagnes: h ? [...h.campagnes] : [],
      afgemeld: !!(v && v.afgemeld),
      voorkeuren: v ? v.voorkeuren || {} : {},
      geldig_email: EMAIL_RE.test(email),
      geldig_nummer: E164_RE.test(String(l.telefoon_e164 || '')),
    };
  });
  const gefilterd = verrijkt.filter((l) => leadVoldoet(l, f, nuMs))
    .sort((a, b) => String(b.aangemaakt || '').localeCompare(String(a.aangemaakt || '')));
  const uniek = (k) => [...new Set(verrijkt.map((l) => l[k]).filter(Boolean))].sort((x, y) => String(x).localeCompare(String(y)));
  const opties = { bron: uniek('bron'), soort: uniek('soort'), traject: [...new Set(verrijkt.map((l) => String(l.traject || '').toLowerCase()).filter(Boolean))].sort() };
  return { items: gefilterd, totaal: gefilterd.length, filter: f, opties, tabel_ontbreekt: tabelOntbreektVlag };
}

// ── Campagne plannen + aanmaken ──────────────────────────────────────────────

/**
 * Wie krijgt de mail? PURE. Volgorde blijft die van `leads`.
 * -> { verzenden:[lead], overgeslagen:[{lead, reden}], redenen:{…} }
 */
export function planCampagne(leads, soort) {
  const gezien = new Set();
  const verzenden = [];
  const overgeslagen = [];
  for (const l of leads) {
    const email = String(l.email || '').trim().toLowerCase();
    let reden = null;
    if (!EMAIL_RE.test(email)) reden = 'geen_geldig_email';
    else if (gezien.has(email)) reden = 'dubbel_email';
    else {
      const m = magOntvangen(l.afgemeld ? { afgemeld: true } : { voorkeuren: l.voorkeuren }, soort);
      if (!m.ok) reden = m.reden;
    }
    if (reden) overgeslagen.push({ lead: l, reden });
    else { gezien.add(email); verzenden.push(l); }
  }
  const redenen = {};
  for (const o of overgeslagen) redenen[o.reden] = (redenen[o.reden] || 0) + 1;
  return { verzenden, overgeslagen, redenen };
}

/** Velden van een campagne valideren. -> { naam, soort, onderwerp, html, portie } of MassaFout. */
export function valideerCampagne(b = {}) {
  const naam = String(b.naam || '').trim();
  if (!naam) throw new MassaFout(400, 'NAAM_LEEG', 'Geef de campagne een naam.');
  if (naam.length > 120) throw new MassaFout(400, 'NAAM_TE_LANG', 'De campagnenaam is te lang (max 120 tekens).');
  const soort = String(b.soort || '');
  if (!MASSA_SOORTEN[soort]) throw new MassaFout(400, 'SOORT_ONGELDIG', 'Kies het soort mail (voor de voorkeuren van de ontvanger).');
  if (String(b.kanaal || 'email') !== 'email') throw new MassaFout(400, 'KANAAL_NIET_ONDERSTEUND', 'Alleen e-mail kan nu; WhatsApp volgt in fase 2b.');
  const onderwerp = String(b.onderwerp || '').trim();
  if (!onderwerp) throw new MassaFout(400, 'ONDERWERP_LEEG', 'Vul een onderwerp in.');
  if (onderwerp.length > 200) throw new MassaFout(400, 'ONDERWERP_TE_LANG', 'Het onderwerp is te lang (max 200 tekens).');
  const html = schoonHtml(b.html);
  if (!htmlNaarTekst(html).trim()) throw new MassaFout(400, 'BERICHT_LEEG', 'Het bericht is leeg.');
  if (html.length > 50000) throw new MassaFout(400, 'BERICHT_TE_LANG', 'Het bericht is te lang.');
  const onbekend = onbekendeVariabelen(onderwerp + ' ' + html);
  if (onbekend.length) throw new MassaFout(400, 'ONBEKENDE_VARIABELEN', `Onbekende variabele(n): ${onbekend.map((x) => '{{' + x + '}}').join(', ')}.`);
  const p = Math.floor(Number(b.portie));
  const portie = Number.isFinite(p) && p >= 1 ? Math.min(MAX_PORTIE, p) : STANDAARD_PORTIE;
  const sjabloonId = UUID_RE.test(String(b.sjabloon_id || '')) ? String(b.sjabloon_id) : null;
  return { naam, soort, onderwerp, html, portie, sjabloon_id: sjabloonId };
}

async function boekingslinkVoor(sb, traject, cache) {
  const k = String(traject || '').toLowerCase();
  if (!k) return null;
  if (cache.has(k)) return cache.get(k);
  const { data, error } = await sb.from('onderhoud_trajecten').select('agenda_link').ilike('slug', k).maybeSingle();
  if (error) console.warn('[massa-mail] traject lezen mislukt:', k, error.message);
  const link = data?.agenda_link || null;
  cache.set(k, link);
  return link;
}

/**
 * Preview of start van een campagne.
 *   b = { naam, soort, kanaal, onderwerp, html, portie, sjabloon_id, filter, lead_ids, bevestig_aantal }
 * De ontvangers zijn PRECIES de aangevinkte lead_ids (het filter wordt alleen
 * bewaard, voor de geschiedenis). Preview → exact aantal + voorbeeldmail;
 * start → alleen als bevestig_aantal nog klopt (anders 409).
 */
export async function maakCampagne(sb, b, { start = false, userId = null, nu = new Date() } = {}) {
  const v = valideerCampagne(b);
  const ids = lijst(b.lead_ids).filter((id) => UUID_RE.test(id));
  if (!ids.length) throw new MassaFout(400, 'GEEN_SELECTIE', 'Er zijn geen leads geselecteerd.');
  if (ids.length > MAX_ONTVANGERS) throw new MassaFout(400, 'TE_VEEL', `Maximaal ${MAX_ONTVANGERS} ontvangers per campagne.`);
  const seg = await zoekSegment(sb, { lead_ids: ids }, { nu });
  if (seg.tabel_ontbreekt) throw new MassaFout(409, 'MIGRATIE_NODIG', `De massa-tabellen bestaan nog niet — draai ${MIGRATIE}.`);
  // Volgorde = de volgorde van de aangevinkte lijst.
  const positie = new Map(ids.map((id, i) => [id, i]));
  const leads = seg.items.slice().sort((a, c) => positie.get(a.id) - positie.get(c.id));
  const plan = planCampagne(leads, v.soort);
  const nietGevonden = ids.length - leads.length;
  if (nietGevonden) plan.redenen.lead_niet_gevonden = nietGevonden;

  const eerste = plan.verzenden[0] || null;
  let voorbeeld = null;
  if (eerste) {
    const link = await boekingslinkVoor(sb, eerste.traject, new Map());
    const vars = leadVariabelen(eerste, { boekingslink: link });
    voorbeeld = {
      aan: eerste.email,
      onderwerp: vulMailVariabelen(v.onderwerp, vars).slice(0, 200),
      html: renderLeadMail({ bodyHtml: vulMailVariabelen(v.html, vars, { html: true }), voorkeurenUrl: voorkeurenUrl('VOORBEELD') }),
    };
  }
  const samenvatting = {
    aantal_geselecteerd: ids.length,
    aantal_verzenden: plan.verzenden.length,
    aantal_overgeslagen: plan.overgeslagen.length + nietGevonden,
    redenen: plan.redenen,
    portie: v.portie,
    voorbeeld,
  };
  if (!start) return samenvatting;

  if (!plan.verzenden.length) throw new MassaFout(400, 'GEEN_ONTVANGERS', 'Niemand in de selectie kan deze mail ontvangen.');
  if (Number(b.bevestig_aantal) !== plan.verzenden.length) {
    throw new MassaFout(409, 'AANTAL_GEWIJZIGD', `Het aantal ontvangers is veranderd (nu ${plan.verzenden.length}). Bekijk de controle opnieuw.`, { samenvatting });
  }
  const { data: camp, error: cErr } = await sb.from('massa_campagnes').insert({
    naam: v.naam, kanaal: 'email', soort: v.soort, onderwerp: v.onderwerp, html: v.html,
    sjabloon_id: v.sjabloon_id, filter: b.filter && typeof b.filter === 'object' ? b.filter : {},
    portie: v.portie, status: 'wachtrij', aantal: plan.verzenden.length,
    aantal_overgeslagen: plan.overgeslagen.length, aangemaakt_door: userId,
  }).select('id').single();
  if (cErr) {
    if (tabelOntbreekt(cErr)) throw new MassaFout(409, 'MIGRATIE_NODIG', `De massa-tabellen bestaan nog niet — draai ${MIGRATIE}.`);
    throw new Error('campagne aanmaken: ' + cErr.message);
  }
  const rijen = [
    ...plan.verzenden.map((l) => ({ campagne_id: camp.id, lead_id: l.id, kanaal: 'email', email: l.email, status: 'queued' })),
    ...plan.overgeslagen.map((o) => ({ campagne_id: camp.id, lead_id: o.lead.id, kanaal: 'email', email: o.lead.email || null, status: 'skipped', reden: o.reden })),
  ];
  for (let i = 0; i < rijen.length; i += 500) {
    const { error: iErr } = await sb.from('massa_items').insert(rijen.slice(i, i + 500));
    if (iErr) {
      console.error('[massa-mail] items aanmaken mislukt — campagne teruggedraaid:', { campagne: camp.id, fout: iErr.message });
      const { error: dErr } = await sb.from('massa_campagnes').delete().eq('id', camp.id);
      if (dErr) console.error('[massa-mail] terugdraaien mislukt:', { campagne: camp.id, fout: dErr.message });
      throw new Error('wachtrij vullen: ' + iErr.message);
    }
  }
  return { ...samenvatting, campagne_id: camp.id };
}

// ── Worker ───────────────────────────────────────────────────────────────────

/** Instellingen uit app_settings.massa_mail (jsonb), met veilige grenzen. */
export async function leesInstellingen(sb) {
  const { data, error } = await sb.from('app_settings').select('value').eq('key', 'massa_mail').maybeSingle();
  if (error) console.warn('[massa-mail] instellingen lezen mislukt — standaard:', error.message);
  let v = data?.value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  v = v && typeof v === 'object' ? v : {};
  const getal = (x, d, min, max) => { const n = Number(x); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : d; };
  return {
    dag_max: getal(v.dag_max, STANDAARD_INSTELLINGEN.dag_max, 0, 5000),
    pauze_ms: getal(v.pauze_ms, STANDAARD_INSTELLINGEN.pauze_ms, 0, 10000),
    stille_uren: v.stille_uren !== false,
  };
}

/** Uur (0-23) in Amsterdam. PURE. */
export function amsUur(nu = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }).format(nu)) % 24;
}
/** Middernacht Amsterdam (vandaag) als ISO. PURE. */
export function amsDagStartIso(nu = new Date()) {
  const dag = amsDag(nu.toISOString());
  const [Y, M, D] = dag.split('-').map(Number);
  const utc = Date.UTC(Y, M - 1, D);
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(utc))) p[x.type] = x.value;
  const alsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(utc - (alsUtc - utc)).toISOString();
}

/** Tellers van een campagne opnieuw uit de items halen (+ klaar zetten). */
export async function herteltCampagne(sb, id, nu = new Date()) {
  const tel = async (status) => {
    const { count, error } = await sb.from('massa_items').select('id', { count: 'exact', head: true }).eq('campagne_id', id).eq('status', status);
    if (error) throw new Error('tellen ' + status + ': ' + error.message);
    return count || 0;
  };
  const [queued, sending, sent, failed, skipped] = await Promise.all(['queued', 'sending', 'sent', 'failed', 'skipped'].map(tel));
  const patch = { aantal_verstuurd: sent, aantal_mislukt: failed, aantal_overgeslagen: skipped };
  const { data: c } = await sb.from('massa_campagnes').select('status').eq('id', id).maybeSingle();
  if (c && ['wachtrij', 'bezig'].includes(c.status) && queued === 0 && sending === 0) {
    patch.status = 'klaar'; patch.klaar_op = nu.toISOString();
  }
  const { error } = await sb.from('massa_campagnes').update(patch).eq('id', id);
  if (error) console.error('[massa-mail] tellers bijwerken mislukt:', { campagne: id, fout: error.message });
  return { queued, sending, sent, failed, skipped, klaar: patch.status === 'klaar' };
}

const slaapStandaard = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function zetItem(sb, id, patch) {
  const { error } = await sb.from('massa_items').update(patch).eq('id', id);
  if (error) console.error('[massa-mail] item-status zetten mislukt:', { item: id, patch: patch.status, fout: error.message });
}

/**
 * Eén run van de wachtrij.
 * opts: campagneId (alleen die), tijdBudgetMs, handmatig (negeert stille uren),
 *       verstuur (test-injectie), slaap (test-injectie), nu.
 * -> samenvatting { verstuurd, mislukt, overgeslagen, campagnes:[…], reden? }
 */
export async function verwerkWachtrij(sb, {
  campagneId = null, tijdBudgetMs = 240000, handmatig = false,
  verstuur = verstuurMail, slaap = slaapStandaard, nu = () => new Date(),
} = {}) {
  const start = Date.now();
  const uit = { verstuurd: 0, mislukt: 0, overgeslagen: 0, campagnes: [], reden: null, dag_resterend: null };
  const inst = await leesInstellingen(sb);
  const uur = amsUur(nu());
  if (!handmatig && inst.stille_uren && (uur >= 21 || uur < 8)) { uit.reden = 'stille_uren'; return uit; }

  // Hangende 'sending' (run viel weg na de claim): niet opnieuw versturen —
  // we weten niet of de mail de deur uit ging. Markeer als mislukt.
  const grens = new Date(nu().getTime() - 15 * 60000).toISOString();
  const { error: hErr } = await sb.from('massa_items').update({ status: 'failed', fout: 'onderbroken: geen bevestiging van verzending' })
    .eq('status', 'sending').lt('geclaimd_op', grens);
  if (hErr && !tabelOntbreekt(hErr)) console.error('[massa-mail] hangende items opruimen mislukt:', hErr.message);

  const { count: vandaag, error: dErr } = await sb.from('massa_items').select('id', { count: 'exact', head: true })
    .eq('status', 'sent').gte('verzonden_op', amsDagStartIso(nu()));
  if (dErr) {
    if (tabelOntbreekt(dErr)) { uit.reden = 'migratie_nodig'; return uit; }
    throw new Error('daglimiet tellen: ' + dErr.message);
  }
  let resterend = Math.max(0, inst.dag_max - (vandaag || 0));
  uit.dag_resterend = resterend;
  if (resterend <= 0) { uit.reden = 'daglimiet'; return uit; }

  let q = sb.from('massa_campagnes').select('id, naam, soort, onderwerp, html, portie, status, aangemaakt_door, gestart_op')
    .in('status', ['wachtrij', 'bezig']).order('aangemaakt_op', { ascending: true }).limit(20);
  if (campagneId) q = q.eq('id', campagneId);
  const { data: campagnes, error: cErr } = await q;
  if (cErr) throw new Error('campagnes lezen: ' + cErr.message);

  const linkCache = new Map();
  try {
    for (const c of campagnes || []) {
      if (resterend <= 0 || Date.now() - start > tijdBudgetMs) break;
      const per = { id: c.id, naam: c.naam, verstuurd: 0, mislukt: 0, overgeslagen: 0 };
      uit.campagnes.push(per);
      const max = Math.min(c.portie || STANDAARD_PORTIE, resterend);
      const { data: items, error: iErr } = await sb.from('massa_items').select('id, lead_id')
        .eq('campagne_id', c.id).eq('status', 'queued').order('aangemaakt_op', { ascending: true }).limit(max);
      if (iErr) { console.error('[massa-mail] items lezen mislukt:', { campagne: c.id, fout: iErr.message }); continue; }
      if ((items || []).length && c.status === 'wachtrij') {
        const { error: sErr } = await sb.from('massa_campagnes').update({ status: 'bezig', gestart_op: c.gestart_op || nu().toISOString() }).eq('id', c.id).eq('status', 'wachtrij');
        if (sErr) console.error('[massa-mail] campagne op bezig zetten mislukt:', { campagne: c.id, fout: sErr.message });
      }
      let eersteMail = true;
      for (const it of items || []) {
        if (resterend <= 0 || Date.now() - start > tijdBudgetMs) break;
        // Atomische claim: een parallelle run pakt hetzelfde item niet nog eens.
        const { data: claim, error: clErr } = await sb.from('massa_items').update({ status: 'sending', geclaimd_op: nu().toISOString() })
          .eq('id', it.id).eq('status', 'queued').select('id');
        if (clErr) { console.error('[massa-mail] claim mislukt:', { item: it.id, fout: clErr.message }); continue; }
        if (!claim || !claim.length) continue;
        // Gepauzeerd of geannuleerd sinds het begin van de run? Terugzetten en stoppen.
        const { data: nogActief } = await sb.from('massa_campagnes').select('status').eq('id', c.id).maybeSingle();
        if (!nogActief || !['wachtrij', 'bezig'].includes(nogActief.status)) {
          await zetItem(sb, it.id, { status: nogActief?.status === 'geannuleerd' ? 'skipped' : 'queued', reden: nogActief?.status === 'geannuleerd' ? 'geannuleerd' : null });
          break;
        }
        try {
          const { data: lead, error: lErr } = await sb.from('leads')
            .select('id, voornaam, achternaam, email, traject, verwijderd_op').eq('id', it.lead_id).maybeSingle();
          if (lErr) throw new Error('lead lezen: ' + lErr.message);
          const email = String(lead?.email || '').trim().toLowerCase();
          if (!lead || lead.verwijderd_op) { await zetItem(sb, it.id, { status: 'skipped', reden: 'lead_verwijderd' }); per.overgeslagen++; uit.overgeslagen++; continue; }
          if (!EMAIL_RE.test(email)) { await zetItem(sb, it.id, { status: 'skipped', reden: 'geen_geldig_email', email: email || null }); per.overgeslagen++; uit.overgeslagen++; continue; }
          const vk = await zorgVoorkeur(sb, email, lead.id);
          const mag = magOntvangen(vk, c.soort);
          if (!mag.ok) { await zetItem(sb, it.id, { status: 'skipped', reden: mag.reden, email }); per.overgeslagen++; uit.overgeslagen++; continue; }
          if (!eersteMail && inst.pauze_ms) await slaap(inst.pauze_ms);
          eersteMail = false;
          const boekingslink = await boekingslinkVoor(sb, lead.traject, linkCache);
          const r = await verstuur(sb, {
            lead: { ...lead, email }, onderwerp: c.onderwerp, html: c.html, boekingslink,
            userId: c.aangemaakt_door || null,
            massa: { voorkeurenUrl: voorkeurenUrl(vk.token), afmeldUrl: afmeldUrl(vk.token), campagneId: c.id },
          });
          await zetItem(sb, it.id, { status: 'sent', verzonden_op: nu().toISOString(), extern_id: r?.messageId || null, email, fout: r?.in_draad === false ? 'verstuurd, maar niet in de draad gelogd' : null });
          per.verstuurd++; uit.verstuurd++; resterend--;
        } catch (e) {
          const code = e instanceof LeadBerichtFout ? e.code : null;
          if (code === 'GEEN_GELDIG_EMAIL') { await zetItem(sb, it.id, { status: 'skipped', reden: 'geen_geldig_email' }); per.overgeslagen++; uit.overgeslagen++; continue; }
          console.error('[massa-mail] verzenden mislukt:', { campagne: c.id, item: it.id, code, fout: e?.message || e });
          await zetItem(sb, it.id, { status: 'failed', fout: String(e?.message || e).slice(0, 500) });
          per.mislukt++; uit.mislukt++;
          if (code === 'MAIL_NIET_GECONFIGUREERD') { uit.reden = 'mail_niet_geconfigureerd'; break; }
        }
      }
      try { per.stand = await herteltCampagne(sb, c.id, nu()); } catch (e) { console.error('[massa-mail] hertellen mislukt:', { campagne: c.id, fout: e?.message || e }); }
      if (uit.reden === 'mail_niet_geconfigureerd') break;
    }
  } finally {
    sluitSmtpPools();
  }
  uit.dag_resterend = resterend;
  if (!uit.reden && Date.now() - start > tijdBudgetMs) uit.reden = 'tijdbudget';
  return uit;
}
