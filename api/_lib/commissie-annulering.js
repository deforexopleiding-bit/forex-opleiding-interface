// api/_lib/commissie-annulering.js
//
// COMMISSIE VOLGT ANNULATIE (regels Maxim, 12 nov 2026).
//
//   A. Klant annuleert (offerte verwijderd of laatste abonnement van de sale
//      weg) → de commissie van die sale komt op "geannuleerd", met reden
//      ("Klant geannuleerd"), datum en door wie. Zichtbaar voor admin
//      (Mentoren → Commissies) én mentor (Mijn verdiensten → Geannuleerd).
//   B. Offerte vervangen door een nieuwe → reden "Vervangen door nieuwe
//      offerte"; de nieuwe getekende offerte van dezelfde klant toont een
//      banner om de commissie opnieuw te koppelen via "Sale toewijzen".
//   E. Per sale annuleren / herstellen met verplichte reden + audit-regel.
//
// WAT DIT RAAKT: enkel de STATUS van de ouder-rijen (toezeggingen) in
// mentor_ledger_entries die nog open staan (pending / wachten_op_betaling),
// plus de actieve toewijzing (mentor_sale_attributions) van die deal.
// Vrijgegeven en uitbetaalde stukken (children) blijven ongemoeid staan.
// Geen rekenregel verandert: de factuurmotor geeft voor een geannuleerde
// ouder gewoon niets meer vrij, en herstellen zet de vorige status terug en
// laat de motor inhalen wat betaald is (zelfde regel als altijd).
//
// Opslag: de reden staat ALTIJD in `note` in het bestaande formaat
// "| Geannuleerd (<reden>) op JJJJ-MM-DD" (zoals de handmatige rechtzetting
// van 12 nov). Met de migratie 2026-11-12-commissie-annulering.sql komen er
// ook nette kolommen bij (geannuleerd_op/_door/_reden/_soort,
// status_voor_annulering). Zonder migratie: faalzacht, enkel de note.
//
// Geen mails, geen WhatsApp, niets naar Teamleader. Wel een audit-regel in
// agent_audit_log en (alleen bij al uitbetaalde commissie) een in-app melding.

import { createNotification } from './notify.js';
import { customerDisplayName } from './customer-name.js';
import { saleVanSoort, laadSubsMetSoort } from './subscription-soort.js';

export const OPEN_STATUSSEN = ['pending', 'wachten_op_betaling'];
export const ANNULERING_SOORTEN = ['klant_annuleert', 'vervangen', 'handmatig'];
export const STANDAARD_REDEN = {
  klant_annuleert: 'Klant geannuleerd',
  vervangen: 'Vervangen door nieuwe offerte',
};
export const SOORT_LABEL = {
  klant_annuleert: 'Klant annuleert',
  vervangen: 'Vervangen door nieuwe offerte',
  handmatig: 'Handmatig geannuleerd',
};
export const VERVANGEN_MELDING = 'Link de nieuwe offerte via Sale toewijzen.';
const EXTRA_KOLOMMEN = ['geannuleerd_op', 'geannuleerd_door', 'geannuleerd_reden', 'geannuleerd_soort', 'status_voor_annulering'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const vandaag = () => new Date().toISOString().slice(0, 10);

export class AnnuleringFout extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ── Puur ─────────────────────────────────────────────────────────────────────

/** Kolom (of migratie) ontbreekt nog. */
export function kolomOntbreekt(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  if (code === '42703' || code === 'PGRST204') return true;
  return EXTRA_KOLOMMEN.some((k) => msg.includes(k)) && /does not exist|could not find|schema cache/i.test(msg);
}

/** "Geannuleerd (<reden> — was: pending) op 2026-11-12". */
export function annuleringStempel({ reden, datum = vandaag(), was = null }) {
  const r = String(reden || 'Geannuleerd').replace(/[()]/g, '').trim();
  return `Geannuleerd (${r}${was ? ' — was: ' + was : ''}) op ${datum}`;
}
export function herstelStempel({ reden, datum = vandaag(), naar }) {
  const r = String(reden || '').replace(/[()]/g, '').trim();
  return `Hersteld (${r}${naar ? ' — terug naar: ' + naar : ''}) op ${datum}`;
}
/** Plak een stuk achter de note met " | " (het formaat van de rechtzetting van 12 nov). */
export function plakNote(note, ...stukken) {
  const delen = [note, ...stukken].map((s) => (s == null ? '' : String(s).trim())).filter(Boolean);
  const tekst = delen.join(' | ');
  // Liever het begin inkorten dan de stempel achteraan verliezen.
  return tekst.length > 4000 ? '…' + tekst.slice(-3999) : tekst;
}

/**
 * Lees de annulering van een (ouder-)rij: kolommen eerst, anders de note.
 * Kent ook de oudere vormen ("[datum] Toewijzing geannuleerd: reden",
 * "[ts] pending→geannuleerd: reden"). Geeft null als de rij niet
 * geannuleerd is.
 */
export function leesAnnulering(entry) {
  if (!entry || entry.status !== 'geannuleerd') return null;
  const note = String(entry.note || '');
  let reden = entry.geannuleerd_reden || null;
  let op = entry.geannuleerd_op ? String(entry.geannuleerd_op).slice(0, 10) : null;
  let was = entry.status_voor_annulering || null;
  const re = /Geannuleerd \(([^)]*)\) op (\d{4}-\d{2}-\d{2})/gi;
  let m; let laatst = null;
  while ((m = re.exec(note))) laatst = m;
  if (laatst) {
    const [ruw, wasDeel] = laatst[1].split(/\s+—\s+was:\s+/);
    if (!reden) reden = ruw.trim() || null;
    if (!op) op = laatst[2];
    if (!was && wasDeel) was = wasDeel.trim();
  } else if (!reden) {
    const t = /\[(\d{4}-\d{2}-\d{2})[^\]]*\]\s*(?:Toewijzing geannuleerd|[a-z_]+→geannuleerd|geannuleerd)\s*:?\s*([^|·\n]*)/i.exec(note);
    if (t) { reden = (t[2] || '').trim() || 'Geannuleerd'; if (!op) op = t[1]; }
  }
  let soort = entry.geannuleerd_soort || null;
  if (!soort && reden) {
    if (/vervangen/i.test(reden)) soort = 'vervangen';
    else if (/klant\s+geannuleerd|klant annuleert/i.test(reden)) soort = 'klant_annuleert';
  }
  return { reden: reden || 'Geannuleerd', op, door: entry.geannuleerd_door || null, soort, was };
}

/** Status om naar terug te keren bij herstellen. */
export function herstelStatus(entry) {
  const a = leesAnnulering(entry);
  const was = a?.was && OPEN_STATUSSEN.includes(a.was) ? a.was : null;
  return was || 'pending';
}

/** Een abonnement is actief zolang het niet gestopt is. */
export const isActiefAbonnement = (s) => !!s && !['cancelled', 'completed', 'deleted'].includes(String(s.status || '').toLowerCase());

/**
 * Bij welke sale hoort dit abonnement? Soort gezet → die sale (sale_deal_id);
 * zonder soort (of zonder sale) → de eigen deal (overgangsregel).
 */
export function saleVanAbonnement(s) {
  if (!s) return null;
  const sale = saleVanSoort(s);
  return sale || s.deal_id || null;
}
export const hoortBijSale = (s, dealId) => !!dealId && saleVanAbonnement(s) === dealId;

/**
 * Regel C: welke sales met commissie verliezen hun LAATSTE actieve abonnement
 * als `subId` stopt? Een abonnement dat gelinkt is als aanpassing/incasso-
 * regeling (sale_deal_id) houdt de sale actief.
 *   subs        alle abonnementen van de klant
 *   salesMet    Set(deal-ids met open commissie)
 */
export function salesZonderAbonnementNa(subs, subId, salesMet) {
  const sub = (subs || []).find((s) => s.id === subId);
  if (!sub) return [];
  const kandidaten = [...new Set([saleVanAbonnement(sub), sub.deal_id].filter(Boolean))].filter((d) => salesMet.has(d));
  return kandidaten.filter((dealId) => !(subs || []).some((s) => s.id !== subId && isActiefAbonnement(s) && hoortBijSale(s, dealId)));
}

/** Samenvatting van de commissie op één deal uit ouders + kinderen. */
export function vatSamen({ dealId, parents = [], kids = [], attrs = [], mentorNaam = new Map(), events = new Map() }) {
  const eigen = parents.filter((p) => p.source_quote_id === dealId);
  const toewijzing = attrs.find((a) => a.deal_id === dealId && a.status === 'actief')
    || attrs.filter((a) => a.deal_id === dealId).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
  if (!eigen.length) {
    return { deal_id: dealId, heeft_commissie: false, status: 'geen', open: false, mentoren: [], totaal: 0, vrijgegeven: 0, uitbetaald: 0, bron: null, annulering: null, toewijzing: toewijzing ? { id: toewijzing.id, status: toewijzing.status, reden: toewijzing.reden } : null };
  }
  const kidsVan = new Map();
  for (const k of kids) {
    if (!['vrijgegeven', 'uitbetaald'].includes(k.status)) continue;
    const cur = kidsVan.get(k.parent_entry_id) || { vrij: 0, uit: 0 };
    cur.vrij = round2(cur.vrij + (Number(k.amount) || 0));
    if (k.status === 'uitbetaald') cur.uit = round2(cur.uit + (Number(k.amount) || 0));
    kidsVan.set(k.parent_entry_id, cur);
  }
  const mentoren = eigen.map((p) => {
    const bedrag = round2(p.original_amount != null ? Number(p.original_amount) : Number(p.amount) || 0);
    const kv = kidsVan.get(p.id) || { vrij: 0, uit: 0 };
    const zelfVrij = p.status === 'vrijgegeven' || p.status === 'uitbetaald';
    return {
      entry_id: p.id, user_id: p.mentor_user_id, naam: mentorNaam.get(p.mentor_user_id) || '(mentor)',
      bedrag, status: p.status,
      vrijgegeven: zelfVrij ? bedrag : kv.vrij,
      uitbetaald: p.status === 'uitbetaald' ? bedrag : kv.uit,
      geannuleerd: p.status === 'geannuleerd',
      annulering: leesAnnulering(p),
      bron: p.attribution_id ? 'handmatig' : 'event',
    };
  });
  const actief = mentoren.filter((m) => !m.geannuleerd);
  const open = eigen.some((p) => OPEN_STATUSSEN.includes(p.status));
  const viaEvent = eigen.find((p) => !p.attribution_id && p.event_id);
  const ev = viaEvent ? events.get(viaEvent.event_id) : null;
  const bron = viaEvent
    ? { soort: 'event', event_id: viaEvent.event_id, titel: ev?.title || 'Event', datum: ev?.starts_at || null }
    : { soort: 'handmatig', attribution_id: eigen[0].attribution_id || null, reden: toewijzing?.reden || 'handmatig', datum: toewijzing?.created_at || eigen[0].created_at || null };
  const p0 = eigen[0];
  const annulering = actief.length ? null : (mentoren.find((m) => m.annulering)?.annulering || { reden: 'Geannuleerd', op: null });
  return {
    deal_id: dealId,
    heeft_commissie: true,
    status: actief.length ? 'actief' : 'geannuleerd',
    open,
    mentoren,
    pct: p0.pct != null ? Number(p0.pct) : null,
    basis: p0.basis != null ? round2(p0.basis) : null,
    basis_incl_btw: p0.basis_incl_btw !== false,
    totaal: round2(actief.reduce((s, m) => s + m.bedrag, 0)),
    totaal_oorspronkelijk: round2(mentoren.reduce((s, m) => s + m.bedrag, 0)),
    vrijgegeven: round2(mentoren.reduce((s, m) => s + m.vrijgegeven, 0)),
    uitbetaald: round2(mentoren.reduce((s, m) => s + m.uitbetaald, 0)),
    bron,
    annulering,
    toewijzing: toewijzing ? { id: toewijzing.id, status: toewijzing.status, reden: toewijzing.reden, pct: Number(toewijzing.pct), basis_incl_btw: toewijzing.basis_incl_btw !== false } : null,
  };
}

// ── IO ───────────────────────────────────────────────────────────────────────

async function alle(q, wat) {
  const { data, error } = await q;
  if (error) throw new Error(`${wat}: ${error.message}`);
  return data || [];
}

const PARENT_KOLOMMEN = 'id, mentor_user_id, event_id, attribution_id, customer_id, source_quote_id, basis, basis_incl_btw, pct, amount, original_amount, status, note, created_at';

async function laadOuders(db, { dealIds = null, customerIds = null } = {}) {
  const extra = ', ' + EXTRA_KOLOMMEN.join(', ');
  const bouw = (kol) => {
    let q = db.from('mentor_ledger_entries').select(kol).eq('entry_type', 'bonus').is('parent_entry_id', null);
    if (dealIds) q = q.in('source_quote_id', dealIds);
    if (customerIds) q = q.in('customer_id', customerIds);
    return q;
  };
  const { data, error } = await bouw(PARENT_KOLOMMEN + extra);
  if (!error) return { rijen: data || [], kolommen_ok: true };
  if (!kolomOntbreekt(error)) throw new Error('ledger: ' + error.message);
  return { rijen: await alle(bouw(PARENT_KOLOMMEN), 'ledger'), kolommen_ok: false };
}

async function laadNamen(db, uids) {
  const out = new Map();
  if (!uids.length) return out;
  const [tms, profs] = await Promise.all([
    db.from('team_members').select('id, name, user_id').in('user_id', uids),
    db.from('profiles').select('id, full_name, email').in('id', uids),
  ]);
  for (const p of profs.data || []) out.set(p.id, p.full_name || p.email || '(mentor)');
  for (const t of tms.data || []) if (t.user_id && t.name) out.set(t.user_id, t.name);
  return out;
}

async function laadAttrs(db, { dealIds = null, customerIds = null } = {}) {
  let q = db.from('mentor_sale_attributions').select('id, deal_id, customer_id, reden, pct, basis, basis_incl_btw, status, note, created_at');
  if (dealIds) q = q.in('deal_id', dealIds);
  if (customerIds) q = q.in('customer_id', customerIds);
  const { data, error } = await q;
  if (error) { console.warn('[commissie-annulering] attributions:', error.message); return []; }
  return data || [];
}

/** Commissie per deal (Map dealId → samenvatting) voor een set deals. */
export async function laadCommissieVanDeals(db, dealIds) {
  const ids = [...new Set((dealIds || []).filter((d) => UUID_RE.test(String(d || ''))))];
  const out = new Map();
  if (!ids.length) return out;
  const parents = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { rijen } = await laadOuders(db, { dealIds: ids.slice(i, i + 200) });
    parents.push(...rijen);
  }
  const parentIds = parents.map((p) => p.id);
  const kids = [];
  for (let i = 0; i < parentIds.length; i += 200) {
    kids.push(...await alle(db.from('mentor_ledger_entries').select('id, parent_entry_id, amount, status')
      .in('parent_entry_id', parentIds.slice(i, i + 200)), 'children'));
  }
  const attrs = [];
  for (let i = 0; i < ids.length; i += 200) attrs.push(...await laadAttrs(db, { dealIds: ids.slice(i, i + 200) }));
  const uids = [...new Set(parents.map((p) => p.mentor_user_id).filter(Boolean))];
  const eventIds = [...new Set(parents.map((p) => p.event_id).filter(Boolean))];
  const [mentorNaam, evs] = await Promise.all([
    laadNamen(db, uids),
    eventIds.length ? alle(db.from('events').select('id, title, starts_at').in('id', eventIds), 'events') : [],
  ]);
  const events = new Map(evs.map((e) => [e.id, e]));
  for (const d of ids) out.set(d, vatSamen({ dealId: d, parents, kids, attrs, mentorNaam, events }));
  return out;
}

export async function commissieVanDeal(db, dealId) {
  return (await laadCommissieVanDeals(db, [dealId])).get(dealId)
    || vatSamen({ dealId });
}

async function audit(db, { action, payload, result, status = 'success', actorId }) {
  const { error } = await db.from('agent_audit_log').insert({
    agent_name: 'commissie-annulering', action, payload, result, status, triggered_by: actorId || 'system',
  });
  if (error) console.error('[commissie-annulering] audit:', error.message);
}

/** Update met de extra kolommen; ontbreken ze nog (migratie), opnieuw zonder. */
async function zetRij(db, id, basis, extra, statusGuard) {
  const run = (patch) => db.from('mentor_ledger_entries').update(patch).eq('id', id).in('status', statusGuard).select('id');
  let { data, error } = await run({ ...basis, ...extra });
  if (error && kolomOntbreekt(error)) ({ data, error } = await run(basis));
  if (error) throw new Error('ledger update: ' + error.message);
  return (data || []).length;
}

/**
 * Zet de OPEN commissie van een deal op geannuleerd (regels A, B, E).
 *
 * @param {object} o
 * @param {string} o.dealId
 * @param {'klant_annuleert'|'vervangen'|'handmatig'} o.soort
 * @param {string} [o.reden]   verplicht bij 'handmatig' (≥ 3 tekens)
 * @param {string} [o.extraNote] bv. "Offerte OFF-12 definitief verwijderd"
 * @param {string} [o.bron]    waar het vandaan komt (audit): hard_delete / abonnement / commissies
 */
export async function annuleerCommissie(db, { dealId, soort, reden = '', extraNote = '', bron = 'handmatig', actorId = null } = {}) {
  if (!UUID_RE.test(String(dealId || ''))) throw new AnnuleringFout(400, 'DEAL_ONGELDIG', 'deal_id (uuid) vereist');
  if (!ANNULERING_SOORTEN.includes(soort)) throw new AnnuleringFout(400, 'SOORT_ONGELDIG', 'Kies: klant annuleert, vervangen of handmatig');
  const eigen = String(reden || '').trim().slice(0, 300);
  if (soort === 'handmatig' && eigen.length < 3) throw new AnnuleringFout(400, 'REDEN_VERPLICHT', 'Geef een reden op (minstens 3 tekens)');
  const redenTekst = soort === 'handmatig' ? eigen : (STANDAARD_REDEN[soort] + (eigen ? ': ' + eigen : ''));
  const datum = vandaag();
  const nu = new Date().toISOString();

  const { rijen, kolommen_ok } = await laadOuders(db, { dealIds: [dealId] });
  const open = rijen.filter((p) => OPEN_STATUSSEN.includes(p.status));
  const ids = rijen.map((p) => p.id);
  const kids = ids.length
    ? await alle(db.from('mentor_ledger_entries').select('id, parent_entry_id, amount, status').in('parent_entry_id', ids), 'children')
    : [];
  const kidsVanOpen = kids.filter((k) => open.some((p) => p.id === k.parent_entry_id));
  const alVrij = round2(kidsVanOpen.filter((k) => k.status === 'vrijgegeven' || k.status === 'uitbetaald').reduce((s, k) => s + Number(k.amount || 0), 0));
  const alUit = round2(kidsVanOpen.filter((k) => k.status === 'uitbetaald').reduce((s, k) => s + Number(k.amount || 0), 0));

  let geannuleerd = 0;
  const geraakt = [];
  for (const p of open) {
    const stempel = annuleringStempel({ reden: redenTekst, datum, was: p.status });
    const n = await zetRij(db, p.id,
      { status: 'geannuleerd', note: plakNote(p.note, extraNote, stempel) },
      { geannuleerd_op: nu, geannuleerd_door: actorId || null, geannuleerd_reden: redenTekst, geannuleerd_soort: soort, status_voor_annulering: p.status },
      OPEN_STATUSSEN);
    geannuleerd += n;
    if (n) geraakt.push({ entry_id: p.id, mentor_user_id: p.mentor_user_id, was: p.status, bedrag: round2(p.original_amount ?? p.amount) });
  }

  // Actieve handmatige toewijzing van deze deal mee annuleren.
  let toewijzing = null;
  const attrs = await laadAttrs(db, { dealIds: [dealId] });
  const actieveAttr = attrs.find((a) => a.status === 'actief');
  if (actieveAttr) {
    const { error } = await db.from('mentor_sale_attributions').update({
      status: 'geannuleerd', cancelled_at: nu, cancelled_by: actorId || null,
      note: plakNote(actieveAttr.note, annuleringStempel({ reden: redenTekst, datum })),
    }).eq('id', actieveAttr.id).eq('status', 'actief');
    if (error) console.error('[commissie-annulering] attribution annuleren:', error.message);
    else toewijzing = actieveAttr.id;
  }

  const resultaat = {
    ok: true, deal_id: dealId, soort, reden: redenTekst,
    geannuleerd_regels: geannuleerd, regels: geraakt, toewijzing_geannuleerd: toewijzing,
    al_vrijgegeven: alVrij, al_uitbetaald: alUit, kolommen_ok,
    niets_open: open.length === 0,
    melding: soort === 'vervangen' ? VERVANGEN_MELDING : null,
  };
  if (geannuleerd || toewijzing) {
    await audit(db, { action: 'commissie.annuleren', payload: { deal_id: dealId, soort, reden: redenTekst, bron, extra: extraNote || null }, result: resultaat, actorId });
  }
  if (alUit > 0) {
    createNotification({
      toRole: ['manager', 'super_admin'],
      type: 'finance.mentor_commissie_clawback',
      title: 'Geannuleerde sale had al uitbetaalde commissie',
      body: `${SOORT_LABEL[soort]}: EUR ${alUit.toFixed(2)} was al uitbetaald. Dat blijft staan; verrekenen kan enkel met een handmatige post.`,
      linkUrl: '/modules/klanten-v2/?v2preview=mentoren',
      entityType: 'deal', entityId: dealId,
    }).catch(() => {});
  }
  return resultaat;
}

/**
 * Herstel de geannuleerde commissie van een deal (regel E): terug naar de
 * status van vóór de annulering (of 'pending'), toewijzing weer actief als er
 * geen andere actieve is. Daarna mag de factuurmotor inhalen wat betaald is.
 */
export async function herstelCommissie(db, { dealId, reden = '', actorId = null, vrijgave = null } = {}) {
  if (!UUID_RE.test(String(dealId || ''))) throw new AnnuleringFout(400, 'DEAL_ONGELDIG', 'deal_id (uuid) vereist');
  const r = String(reden || '').trim().slice(0, 300);
  if (r.length < 3) throw new AnnuleringFout(400, 'REDEN_VERPLICHT', 'Geef een reden op (minstens 3 tekens)');
  const { rijen, kolommen_ok } = await laadOuders(db, { dealIds: [dealId] });
  const weg = rijen.filter((p) => p.status === 'geannuleerd');
  if (!weg.length) throw new AnnuleringFout(409, 'NIETS_TE_HERSTELLEN', 'Er staat geen geannuleerde commissie op deze offerte');
  const datum = vandaag();
  let hersteld = 0;
  const regels = [];
  for (const p of weg) {
    const naar = herstelStatus(p);
    const n = await zetRij(db, p.id,
      { status: naar, note: plakNote(p.note, herstelStempel({ reden: r, datum, naar })) },
      { geannuleerd_op: null, geannuleerd_door: null, geannuleerd_reden: null, geannuleerd_soort: null, status_voor_annulering: null },
      ['geannuleerd']);
    hersteld += n;
    if (n) regels.push({ entry_id: p.id, mentor_user_id: p.mentor_user_id, naar });
  }
  // Toewijzing terug actief (unieke index: max 1 actieve per deal).
  let toewijzing = null;
  const attrIds = [...new Set(weg.map((p) => p.attribution_id).filter(Boolean))];
  if (attrIds.length) {
    const attrs = await laadAttrs(db, { dealIds: [dealId] });
    if (!attrs.some((a) => a.status === 'actief')) {
      const a = attrs.filter((x) => attrIds.includes(x.id)).sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')))[0];
      if (a) {
        const { error } = await db.from('mentor_sale_attributions').update({
          status: 'actief', cancelled_at: null, cancelled_by: null, note: plakNote(a.note, herstelStempel({ reden: r, datum })),
        }).eq('id', a.id).eq('status', 'geannuleerd');
        if (error) console.error('[commissie-annulering] attribution herstellen:', error.message);
        else toewijzing = a.id;
      }
    }
  }
  let inhaal = null;
  const custId = weg[0].customer_id;
  if (typeof vrijgave === 'function' && custId) {
    try { inhaal = await vrijgave(custId); } catch (e) { console.error('[commissie-annulering] vrijgave na herstel:', e.message); inhaal = { fout: e.message }; }
  }
  const resultaat = { ok: true, deal_id: dealId, hersteld_regels: hersteld, regels, toewijzing_hersteld: toewijzing, kolommen_ok, vrijgave: inhaal };
  await audit(db, { action: 'commissie.herstellen', payload: { deal_id: dealId, reden: r }, result: resultaat, actorId });
  return resultaat;
}

/**
 * Regel B, banner op de nieuwe offerte: had een vorige offerte van deze klant
 * commissie die "vervangen" werd, en is er sindsdien geen nieuwe commissie
 * gekoppeld? Geeft het voorstel om de toewijs-wizard voor te vullen.
 */
export async function vorigeVervangenCommissie(db, { customerId, dealId }) {
  if (!UUID_RE.test(String(customerId || ''))) return null;
  const { rijen } = await laadOuders(db, { customerIds: [customerId] });
  const vervangen = rijen.filter((p) => p.source_quote_id !== dealId && leesAnnulering(p)?.soort === 'vervangen');
  if (!vervangen.length) return null;
  const laatsteOp = vervangen.map((p) => leesAnnulering(p).op || '').sort().pop() || '';
  // Al gekoppeld: deze deal heeft zelf commissie, of er kwam na de vervanging
  // een andere actieve commissie bij deze klant.
  const actiefNa = rijen.some((p) => p.status !== 'geannuleerd'
    && (p.source_quote_id === dealId || String(p.created_at || '').slice(0, 10) >= laatsteOp));
  if (actiefNa) return null;
  const vorigeDeal = vervangen.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0].source_quote_id;
  const vanVorige = vervangen.filter((p) => p.source_quote_id === vorigeDeal);
  const namen = await laadNamen(db, [...new Set(vanVorige.map((p) => p.mentor_user_id))]);
  const p0 = vanVorige[0];
  let bron = { soort: p0.attribution_id ? 'handmatig' : 'event', titel: null, datum: null };
  if (p0.event_id) {
    const { data: ev } = await db.from('events').select('id, title, starts_at').eq('id', p0.event_id).maybeSingle();
    if (ev) bron = { soort: 'event', event_id: ev.id, titel: ev.title, datum: ev.starts_at };
  }
  const { data: vd } = await db.from('deals').select('id, quote_reference').eq('id', vorigeDeal).maybeSingle();
  return {
    vorige_deal_id: vorigeDeal,
    vorige_offerte: vd?.quote_reference || null,
    vorige_verwijderd: !vd,
    vervangen_op: laatsteOp || null,
    mentoren: [...new Set(vanVorige.map((p) => p.mentor_user_id))].map((u) => ({ user_id: u, naam: namen.get(u) || '(mentor)' })),
    pct: p0.pct != null ? Number(p0.pct) : 3,
    basis_incl_btw: p0.basis_incl_btw !== false,
    bedrag: round2(vanVorige.reduce((s, p) => s + Number(p.original_amount ?? p.amount ?? 0), 0)),
    bron,
  };
}

// ── Regel C: abonnement stopt ───────────────────────────────────────────────

/** Alle deals + abonnementen (met soort) van een klant. */
async function klantContext(db, customerId) {
  const deals = await alle(db.from('deals').select('id, customer_id, quote_reference, archived_at').eq('customer_id', customerId), 'deals');
  const subs = await laadSubsMetSoort(db, deals.map((d) => d.id), 'id, deal_id, status, description, start_date');
  return { deals, subs };
}

/**
 * Wordt dit abonnement het LAATSTE actieve van een sale met open commissie?
 * Dan moet het stopvenster vragen: klant annuleert of nieuwe regeling.
 * Geeft { vraag: bool, sales: [samenvatting] }.
 */
export async function commissieVraagBijStop(db, { subscriptionId }) {
  const { data: sub, error } = await db.from('subscriptions').select('id, deal_id').eq('id', subscriptionId).maybeSingle();
  if (error) throw new Error('subscription: ' + error.message);
  if (!sub?.deal_id) return { vraag: false, sales: [] };
  const { data: deal } = await db.from('deals').select('id, customer_id').eq('id', sub.deal_id).maybeSingle();
  if (!deal?.customer_id) return { vraag: false, sales: [] };
  const { deals, subs } = await klantContext(db, deal.customer_id);
  const per = await laadCommissieVanDeals(db, deals.map((d) => d.id));
  const metOpen = new Set([...per.values()].filter((c) => c.open).map((c) => c.deal_id));
  const geraakt = salesZonderAbonnementNa(subs, subscriptionId, metOpen);
  const sales = geraakt.map((d) => ({ ...per.get(d), offerte: deals.find((x) => x.id === d)?.quote_reference || null }));
  return { vraag: sales.length > 0, sales, customer_id: deal.customer_id };
}

/**
 * Klant annuleert (bv. onboarding annuleren): commissie op geannuleerd voor
 * de gearchiveerde deals én voor elke sale met open commissie die geen actief
 * abonnement meer heeft. Een sale die nog een (gelinkt) actief abonnement
 * heeft, blijft staan.
 */
export async function annuleerNaKlantAnnulering(db, { customerId, dealIds = [], reden = '', bron, actorId = null }) {
  if (!UUID_RE.test(String(customerId || ''))) return { ok: true, sales: [] };
  const { deals, subs } = await klantContext(db, customerId);
  const per = await laadCommissieVanDeals(db, deals.map((d) => d.id));
  const doel = new Set(dealIds.filter((d) => per.get(d)?.open));
  for (const c of per.values()) {
    if (!c.open) continue;
    const eigenSubs = subs.filter((s) => hoortBijSale(s, c.deal_id));
    if (eigenSubs.length && !eigenSubs.some(isActiefAbonnement)) doel.add(c.deal_id);
  }
  const out = [];
  for (const dealId of doel) {
    try {
      const r = await annuleerCommissie(db, { dealId, soort: 'klant_annuleert', reden, bron, actorId });
      out.push({ deal_id: dealId, ok: true, geannuleerd_regels: r.geannuleerd_regels, al_vrijgegeven: r.al_vrijgegeven });
    } catch (e) {
      console.error('[commissie-annulering] na klantannulering', dealId, e?.message || e);
      out.push({ deal_id: dealId, ok: false, error: e?.message || String(e) });
    }
  }
  return { ok: out.every((x) => x.ok), sales: out };
}

/** Label voor een klant (voor meldingen). */
export const klantLabel = (c) => customerDisplayName(c, '(klant)');
