// api/_lib/automation-overzicht.js
//
// DE SECTIE "AUTOMATION" — de rekenkern achter GET /api/automation-overzicht.
//
// Kiest een klant in zijn onboarding "Ja, bel mij" bij de automation-vraag, dan
// staat er een kaart in opvolging_taken (lijst 'automation', reden
// 'automation_interesse'; zie api/_lib/automation-interesse.js). Deze module
// maakt van die kaarten, hun pogingen, de onboarding en de geboekte call één
// overzicht: drie tabs (Te bellen · Ingepland · Afgerond) en een KPI-strip.
//
// PUUR: geen databank, geen klok behalve `nuMs`. Getoetst in
// tests/automation-overzicht.test.js. Het endpoint doet het lezen.

import { telPogingen } from './opvolging-poging-telling.js';
import { categorieVoorAfspraak, categorieInfo } from './call-uitkomst-categorie.js';

const ZONE = 'Europe/Brussels';

/** Waarom een afgeronde kaart dicht is, in mensentaal. */
export const AFGEROND_LABEL = Object.freeze({
  automation_gesprek       : 'Gesprek gehad',
  automation_geen_interesse: 'Geen interesse',
  klant_trok_interesse_in  : 'Klant trok interesse in',
});

export const TABS = Object.freeze(['te_bellen', 'ingepland', 'afgerond']);

/** YYYY-MM-DD in Brussel. PURE. */
export function dagVan(ms) {
  const t = typeof ms === 'number' ? ms : Date.parse(ms);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

function plusDagen(dag, n) {
  const d = new Date(`${dag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Maandag t/m zondag van de week van `dag`. PURE. */
export function weekVan(dag) {
  const wd = new Date(`${dag}T12:00:00Z`).getUTCDay(); // 0 = zondag
  const ma = plusDagen(dag, -((wd + 6) % 7));
  return { van: ma, tot: plusDagen(ma, 6) };
}

/** In welke tab hoort de kaart? PURE. */
export function tabVoor(kaart) {
  const s = String(kaart?.status || '');
  if (s === 'gearchiveerd') return 'afgerond';
  if (s === 'ingepland') return 'ingepland';
  return 'te_bellen';
}

/** Waarom dicht: reden_code, anders de vrije archief_reden. PURE. */
export function afgerondLabel(kaart) {
  if (!kaart || kaart.status !== 'gearchiveerd') return null;
  return AFGEROND_LABEL[kaart.reden_code] || (kaart.archief_reden ? String(kaart.archief_reden) : 'Afgerond');
}

/**
 * De laatste stand van een geboekte call: volg de verzet-keten
 * (parent_appointment_id) tot de nieuwste afspraak. PURE.
 *
 * @param {string|null} id
 * @param {Map<string, object>} afspraken  id → rij
 * @param {Map<string, object>} opvolgers  parent-id → nieuwste kind
 */
export function laatsteAfspraak(id, afspraken, opvolgers) {
  let a = id ? afspraken.get(String(id)) : null;
  for (let i = 0; a && i < 6; i++) {
    const kind = opvolgers.get(String(a.id));
    if (!kind) break;
    a = kind;
  }
  return a || null;
}

/** Wat de Ingepland-tab over de call toont. PURE. */
export function afspraakStand(kaart, afspraken, opvolgers, nuMs) {
  const ref = kaart?.afspraak_ref || null;
  if (!ref || (!ref.appointment_id && !ref.scheduled_at)) return null;
  const a = laatsteAfspraak(ref.appointment_id, afspraken, opvolgers);
  const scheduled_at = a?.scheduled_at || ref.scheduled_at || null;
  const heeftOpvolger = !!(a && opvolgers.get(String(a.id)));
  const cat = a ? categorieVoorAfspraak(a, { nuMs, heeftOpvolger }) : 'gepland';
  const info = categorieInfo(cat);
  return {
    appointment_id: a?.id || ref.appointment_id || null,
    scheduled_at,
    handmatig: ref.handmatig === true,
    zoom_join_url: a?.zoom_join_url || ref.zoom_join_url || null,
    status: a?.status || null,
    uitkomst: a?.uitkomst || null,
    uitkomst_op: a?.uitkomst_op || null,
    verzet: !!(a && ref.appointment_id && String(a.id) !== String(ref.appointment_id)),
    categorie: cat,
    label: info.label,
    kleur: info.kleur,
  };
}

/**
 * Het hele overzicht. PURE.
 *
 * @param {object} p
 * @param {object[]} p.kaarten       rijen uit opvolging_taken
 * @param {object[]} p.pogingen      rijen uit opvolging_pogingen (taak_id, soort, tijdstip, …)
 * @param {Map<string, object>} p.onboardings  id → { mentor_user_id, traject_id, start_date, automation_interesse_op, automation_belmoment, customer_id, status }
 * @param {Map<string, string>} p.trajecten    traject_id → label
 * @param {Map<string, string>} p.mentoren     user_id → naam
 * @param {Map<string, object>} p.afspraken    appointment_id → rij
 * @param {Map<string, object>} p.opvolgers    parent-id → nieuwste kind
 * @param {number} p.nuMs
 */
export function bouwOverzicht({ kaarten = [], pogingen = [], onboardings = new Map(), trajecten = new Map(), mentoren = new Map(), afspraken = new Map(), opvolgers = new Map(), nuMs }) {
  const vandaag = dagVan(nuMs);
  const week = weekVan(vandaag);
  const perTaak = new Map();
  for (const p of [...pogingen].sort((a, b) => String(a.tijdstip).localeCompare(String(b.tijdstip)))) {
    if (!perTaak.has(p.taak_id)) perTaak.set(p.taak_id, []);
    perTaak.get(p.taak_id).push(p);
  }

  const items = kaarten.map((k) => {
    const ref = k.bron_ref || {};
    const ob = ref.onboarding_id ? onboardings.get(String(ref.onboarding_id)) || null : null;
    const traject_id = ob?.traject_id || ref.traject_id || null;
    const mentorId = ob?.mentor_user_id || null;
    const belmoment = Array.isArray(ob?.automation_belmoment) && ob.automation_belmoment.length
      ? ob.automation_belmoment : (Array.isArray(ref.belmoment) ? ref.belmoment : []);
    const tel = telPogingen(perTaak.get(k.id) || [], vandaag, dagVan);
    const tab = tabVoor(k);
    return {
      id: k.id,
      naam: k.naam,
      telefoon: k.telefoon || null,
      email: k.email || null,
      reden: k.reden,
      lijst: k.lijst,
      status: k.status,
      due: k.due || null,
      later: !!k.later,
      notitie: k.notitie || null,
      reden_code: k.reden_code || null,
      archief_reden: k.archief_reden || null,
      gearchiveerd_at: k.gearchiveerd_at || null,
      created_at: k.created_at || null,
      is_test: k.is_test === true,
      tab,
      afgerond_label: afgerondLabel(k),
      onboarding_id: ref.onboarding_id || null,
      customer_id: ob?.customer_id || ref.customer_id || null,
      traject: traject_id ? trajecten.get(String(traject_id)) || null : null,
      start_date: ob?.start_date || ref.start_date || null,
      mentor: mentorId ? mentoren.get(String(mentorId)) || 'Mentor (naam onbekend)' : null,
      belmoment,
      interesse_op: ob?.automation_interesse_op || k.created_at || null,
      afspraak: afspraakStand(k, afspraken, opvolgers, nuMs),
      ...tel,
      // Voor 'Later terugbellen': de kaart staat pas op die dag weer bij Te bellen.
      komt_terug_op: tab === 'te_bellen' && k.due && k.due > vandaag ? k.due : null,
    };
  });

  const volgorde = {
    te_bellen: (a, b) => (a.komt_terug_op ? 1 : 0) - (b.komt_terug_op ? 1 : 0)
      || String(a.due || '').localeCompare(String(b.due || ''))
      || String(a.created_at || '').localeCompare(String(b.created_at || '')),
    ingepland: (a, b) => String(a.afspraak?.scheduled_at || '').localeCompare(String(b.afspraak?.scheduled_at || '')),
    afgerond: (a, b) => String(b.gearchiveerd_at || '').localeCompare(String(a.gearchiveerd_at || '')),
  };
  const perTab = {};
  for (const t of TABS) perTab[t] = items.filter((i) => i.tab === t).sort(volgorde[t]);

  const metGesprek = items.filter((i) => i.afspraak || i.reden_code === 'automation_gesprek');
  const inWeek = (iso) => { const d = iso ? dagVan(iso) : null; return !!d && d >= week.van && d <= week.tot; };
  const kpi = {
    nieuw_vandaag: items.filter((i) => i.created_at && dagVan(i.created_at) === vandaag).length,
    te_bellen: perTab.te_bellen.filter((i) => !i.komt_terug_op).length,
    later: perTab.te_bellen.filter((i) => i.komt_terug_op).length,
    ingepland_week: items.filter((i) => i.afspraak && inWeek(i.afspraak.scheduled_at)).length,
    gesprekken: metGesprek.length,
    totaal: items.length,
    conversie_pct: items.length ? Math.round((metGesprek.length / items.length) * 1000) / 10 : null,
  };
  return {
    vandaag,
    week,
    kpi,
    aantallen: { te_bellen: perTab.te_bellen.length, ingepland: perTab.ingepland.length, afgerond: perTab.afgerond.length, alle: items.length },
    tabs: perTab,
  };
}
