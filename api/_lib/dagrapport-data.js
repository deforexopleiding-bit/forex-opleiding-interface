// api/_lib/dagrapport-data.js
//
// verzamelDagrapport({ supabaseAdmin, ref? }) -> Promise<data>
//
// Leest, READ-ONLY, alle cijfers voor het dagelijkse Dagrapport (7 blokken uit
// de mockup) en geeft ze in de vorm die api/_lib/dagrapport-pdf.js verwacht.
//
// Regels (zoals afgesproken, en in lijn met api/opvolging-rapport.js):
//   - "Vandaag" is altijd de NL-kalenderdag (Europe/Amsterdam) via nl-period.js,
//     nooit server-UTC.
//   - Een cijfer dat niet betrouwbaar uit de data komt is `null` (de PDF toont
//     dan "n.v.t."/"n.b."), NOOIT een misleidende 0.
//   - Fail-soft per blok: een leesfout zet dat blok op null-waarden en komt in
//     `waarschuwingen`; de rest van het rapport blijft staan.
//
// Hergebruikte bronnen (bevestigd in het bouwplan):
//   blok 1/2  deals (tl_quotation_status='accepted') + deal_line_items + deal-total.js
//   blok 3    follow_up_appointments.uitkomst + call-uitkomst-categorie.js
//   blok 4    follow_up_appointments.booking_source/ghl_calendar_id + ghl-calendars.js
//   blok 5    call_log (Dave) + opvolging_pogingen/opvolging_taken (lijst dag/leads)
//   blok 6    leads (aanmeldingen-per-funnel-mapping) + webinar_aanmeldingen + event_attendees
//   blok 7    follow-up-metrics.js (computeMetrics, globaal)

import { nlDayStart, nlDayEndExclusive, nlDateString } from './nl-period.js';
import { computeDealTotals } from './deal-total.js';
import { fetchTestDealIds } from './test-data-filter.js';
import { categorieVoorAfspraak } from './call-uitkomst-categorie.js';
import { getCalendarNameMap } from './ghl-calendars.js';
import { classificeerResultaat, GESPROKEN } from './opvolging-poging-telling.js';
import { isTestEmail } from './aanmeldingen-per-funnel.js';
import { computeMetrics } from '../follow-up-metrics.js';

const DAVE_EMAIL = 'dave@deforexopleiding.nl';

// Funnel-trajectherkenning: zelfde predicaten als api/_lib/aanmeldingen-per-funnel.js
// (daar module-lokaal, hier herhaald zodat we leads op traject kunnen groeperen).
const laag = (t) => String(t || '').trim().toLowerCase();
const is7daagse = (t) => t.includes('7-daagse') || t.includes('7 daagse') || t.includes('7daagse');
const isMini = (t) => t.includes('mini') || t.includes('kennismakingscursus') || t.includes('strategiesessie');
const isTrainingBron = (b) => /^(training|drop)-\d{2}-\d{2}-\d{2}(-\d)?$/.test(laag(b));

function nlLangeDatum(ref) {
  try {
    return new Intl.DateTimeFormat('nl-NL', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam',
    }).format(ref);
  } catch { return nlDateString(ref); }
}

export async function verzamelDagrapport({ supabaseAdmin, ref = new Date() } = {}) {
  const start = nlDayStart(ref);
  const endExclusive = nlDayEndExclusive(ref);
  const startIso = start.toISOString();
  const endIso = endExclusive.toISOString();
  const waarschuwingen = [];

  const [blok1en2, blok3, blok4, blok5, blok6, blok7] = await Promise.all([
    salesEnOffertes(supabaseAdmin, start, endExclusive, waarschuwingen),
    callsEnUitkomst(supabaseAdmin, startIso, endIso, waarschuwingen),
    ingeboektPerAgenda(supabaseAdmin, startIso, endIso, waarschuwingen),
    belwerkDave(supabaseAdmin, startIso, endIso, waarschuwingen),
    leadsPerCategorie(supabaseAdmin, start, endExclusive, waarschuwingen),
    achterstallig(supabaseAdmin, waarschuwingen),
  ]);

  // Sales per afgeronde call = getekend vandaag / (afgeronde + no-show calls vandaag).
  const done = (blok3.afgerond || 0) + (blok3.noShows || 0);
  const salesPerCall = done > 0 ? (blok1en2.blok1.salesVandaag || 0) / done : null;

  return {
    datumLabel: nlLangeDatum(ref),
    datumIso: nlDateString(ref),
    blok1: { ...blok1en2.blok1, salesPerCall },
    blok2: blok1en2.blok2,
    blok3,
    blok4,
    blok5,
    blok6,
    blok7,
    waarschuwingen,
  };
}

// ── Blok 1 & 2: getekende offertes vandaag ──────────────────────────────────
async function salesEnOffertes(db, start, endExclusive, warn) {
  const leeg1 = { salesVandaag: 0, omzetInclBtw: 0, nieuweMrr: null };
  const leeg2 = { offertes: [], totaal: 0 };
  try {
    const { data: dealsRaw, error } = await db.from('deals')
      .select('id, customer_id, tl_quotation_status, tl_quotation_accepted_at, tl_quotation_signed_at, created_at, discount_percentage, sale_type, traject_variant_id, payment_start_date, start_date, payment_term_count, payment_term_amount')
      .eq('tl_quotation_status', 'accepted')
      .is('tl_quotation_declined_at', null)
      .is('archived_at', null)
      .limit(20000);
    if (error) throw new Error(error.message);

    const sMs = start.getTime(); const eMs = endExclusive.getTime();
    const getekendOp = (d) => d.tl_quotation_accepted_at || d.tl_quotation_signed_at || d.created_at || null;
    const inDag = (d) => { const t = Date.parse(getekendOp(d)); return Number.isFinite(t) && t >= sMs && t < eMs; };

    let deals = (dealsRaw || []).filter(inDag);
    const testIds = await fetchTestDealIds(db);
    deals = deals.filter((d) => !testIds.has(d.id));

    if (!deals.length) return { blok1: { ...leeg1 }, blok2: { ...leeg2 } };

    const ids = deals.map((d) => d.id);
    const [{ data: lines }, { data: custs }, { data: varianten }, { data: subs }] = await Promise.all([
      db.from('deal_line_items').select('deal_id, product_name, quantity, unit_price, vat_percentage, price_includes_vat').in('deal_id', ids),
      db.from('customers').select('id, is_company, company_name, first_name, last_name').in('id', [...new Set(deals.map((d) => d.customer_id).filter(Boolean))]),
      db.from('traject_variants').select('id, name').in('id', [...new Set(deals.map((d) => d.traject_variant_id).filter(Boolean))]),
      db.from('subscriptions').select('deal_id, term_count, amount').in('deal_id', ids),
    ]);

    const linesPer = new Map();
    for (const l of lines || []) { if (!linesPer.has(l.deal_id)) linesPer.set(l.deal_id, []); linesPer.get(l.deal_id).push(l); }
    const custMap = new Map((custs || []).map((c) => [c.id, c]));
    const varMap = new Map((varianten || []).map((v) => [v.id, v]));
    const subMap = new Map();
    for (const s of subs || []) { if (!subMap.has(s.deal_id)) subMap.set(s.deal_id, s); } // eerste sub als terugval

    const custLabel = (c) => {
      if (!c) return null;
      if (c.is_company) return c.company_name || null;
      return [c.first_name, c.last_name].filter(Boolean).join(' ') || null;
    };
    const productLabel = (d) => {
      const vn = d.traject_variant_id ? (varMap.get(d.traject_variant_id)?.name || null) : null;
      if (vn) return vn;
      const ls = linesPer.get(d.id) || [];
      const namen = [...new Set(ls.map((l) => l.product_name).filter(Boolean))];
      return namen.length ? namen.join(', ') : null;
    };

    const offertes = deals
      .sort((a, b) => Date.parse(getekendOp(a)) - Date.parse(getekendOp(b)))
      .map((d) => {
        const bedrag = computeDealTotals(d, linesPer.get(d.id) || []).incl;
        const sub = subMap.get(d.id);
        const termijnen = d.payment_term_count != null ? d.payment_term_count : (sub?.term_count ?? null);
        const perTermijn = d.payment_term_amount != null ? Number(d.payment_term_amount) : (sub?.amount != null ? Number(sub.amount) : null);
        return {
          klant: custLabel(custMap.get(d.customer_id)),
          product: productLabel(d),
          bedrag,
          startdatum: d.payment_start_date || d.start_date || null,
          termijnen,
          perTermijn,
        };
      });

    const totaal = Math.round(offertes.reduce((a, o) => a + (o.bedrag || 0), 0) * 100) / 100;
    return {
      blok1: { salesVandaag: offertes.length, omzetInclBtw: totaal, nieuweMrr: null },
      blok2: { offertes, totaal },
    };
  } catch (e) {
    warn.push('Blok 1/2 (getekende offertes): ' + (e?.message || e));
    return { blok1: { salesVandaag: null, omzetInclBtw: null, nieuweMrr: null }, blok2: { ...leeg2 } };
  }
}

// ── Blok 3: calls vandaag & uitkomst ────────────────────────────────────────
async function callsEnUitkomst(db, startIso, endIso, warn) {
  try {
    let rows;
    const basis = () => db.from('follow_up_appointments')
      .select('id, status, scheduled_at, duration_minutes, parent_appointment_id, uitkomst')
      .gte('scheduled_at', startIso).lt('scheduled_at', endIso);
    const r1 = await basis();
    if (r1.error && /uitkomst/.test(r1.error.message || '')) {
      // Kolom uitkomst bestaat nog niet (migratie 2026-09-06 niet gedraaid) -> zonder.
      const r2 = await db.from('follow_up_appointments')
        .select('id, status, scheduled_at, duration_minutes, parent_appointment_id')
        .gte('scheduled_at', startIso).lt('scheduled_at', endIso);
      if (r2.error) throw new Error(r2.error.message);
      rows = r2.data || [];
    } else if (r1.error) {
      throw new Error(r1.error.message);
    } else {
      rows = r1.data || [];
    }

    const actief = rows.filter((a) => !['cancelled', 'verplaatst', 'verwijderd'].includes(String(a.status)));
    const nuMs = Date.now();
    const catTel = {};
    for (const a of actief) {
      const cat = categorieVoorAfspraak(a, { nuMs, heeftOpvolger: false });
      catTel[cat] = (catTel[cat] || 0) + 1;
    }
    const n = (k) => catTel[k] || 0;
    return {
      gepland: actief.length,
      afgerond: actief.filter((a) => String(a.status) === 'completed').length,
      noShows: actief.filter((a) => String(a.status) === 'no_show').length,
      nogInTeVullen: n('nog_niet_vastgelegd'),
      uitkomsten: {
        klantGeworden: n('sale'),
        geenKlant: n('geen_interesse') + n('niet_gekwalificeerd') + n('geen_geld'),
        opvolgingNodig: n('opvolgen'),
      },
    };
  } catch (e) {
    warn.push('Blok 3 (calls & uitkomst): ' + (e?.message || e));
    return { gepland: null, afgerond: null, noShows: null, nogInTeVullen: null, uitkomsten: { klantGeworden: null, geenKlant: null, opvolgingNodig: null } };
  }
}

// ── Blok 4: nieuwe calls ingeboekt vandaag, per agenda ──────────────────────
async function ingeboektPerAgenda(db, startIso, endIso, warn) {
  try {
    const { data: rows, error } = await db.from('follow_up_appointments')
      .select('id, booking_source, ghl_calendar_id, owner_id, setter_user_id')
      .gte('created_at', startIso).lt('created_at', endIso)
      .is('parent_appointment_id', null);   // alleen eerste boekingen
    if (error) throw new Error(error.message);
    const appts = rows || [];
    if (!appts.length) return { rijen: [], totaal: 0 };

    // Agenda-namen (fail-soft; lege map als GHL niet bereikbaar).
    const naamMap = await getCalendarNameMap().catch(() => new Map());
    // Eigenaarsnamen voor het "(Dave)"-achtervoegsel.
    const ownerIds = [...new Set(appts.map((a) => a.setter_user_id || a.owner_id).filter(Boolean))];
    let profMap = new Map();
    if (ownerIds.length) {
      const { data: profs } = await db.from('profiles').select('id, full_name').in('id', ownerIds);
      profMap = new Map((profs || []).map((p) => [p.id, p.full_name]));
    }

    const basisLabel = (a) => {
      const bron = laag(a.booking_source);
      if (bron === 'strategiescan') return 'Strategie-scan';
      if (bron === 'the-lab') return 'Strategiesessie';
      if (isTrainingBron(a.booking_source)) return 'Strategiesessie';
      if (a.ghl_calendar_id && naamMap.get(a.ghl_calendar_id)) return naamMap.get(a.ghl_calendar_id);
      if (a.booking_source || a.ghl_calendar_id) return 'Opstartsessie';
      return 'Overig';
    };
    const voornaam = (a) => {
      const vol = profMap.get(a.setter_user_id || a.owner_id);
      return vol ? String(vol).trim().split(/\s+/)[0] : null;
    };

    // Groepeer per basislabel; voeg "(Naam)" toe als de hele groep één eigenaar heeft.
    const groepen = new Map();
    for (const a of appts) {
      const key = basisLabel(a);
      if (!groepen.has(key)) groepen.set(key, { label: key, aantal: 0, namen: new Set() });
      const g = groepen.get(key);
      g.aantal += 1;
      const vn = voornaam(a);
      if (vn) g.namen.add(vn);
    }
    const rijen = [...groepen.values()]
      .sort((a, b) => b.aantal - a.aantal)
      .map((g) => ({
        agenda: g.namen.size === 1 ? `${g.label} (${[...g.namen][0]})` : g.label,
        aantal: g.aantal,
      }));
    return { rijen, totaal: appts.length };
  } catch (e) {
    warn.push('Blok 4 (ingeboekt per agenda): ' + (e?.message || e));
    return { rijen: [], totaal: null };
  }
}

// ── Blok 5: belwerk Dave vandaag ────────────────────────────────────────────
async function belwerkDave(db, startIso, endIso, warn) {
  const uit = { minuten: null, gesprekken: null, gemTijd: null, opvolging: {}, belpot: {} };
  // 5a. call_log (Dave)
  try {
    let daveId = process.env.DAVE_PROFILE_ID || null;
    if (!daveId) {
      const { data: prof } = await db.from('profiles').select('id').eq('email', DAVE_EMAIL).maybeSingle();
      daveId = prof?.id || null;
    }
    if (!daveId) {
      warn.push('Blok 5 (belwerk): Dave-profiel niet gevonden (email ' + DAVE_EMAIL + ' / env DAVE_PROFILE_ID).');
    } else {
      const { data: calls, error } = await db.from('call_log')
        .select('duration_sec')
        .eq('user_id', daveId)
        .gte('started_at', startIso).lt('started_at', endIso);
      if (error) throw new Error(error.message);
      const rows = calls || [];
      let totSec = 0; let metDuur = 0;
      for (const c of rows) {
        const s = Number(c.duration_sec);
        if (Number.isFinite(s) && s > 0) { totSec += s; metDuur += 1; }
      }
      uit.minuten = Math.round(totSec / 60);
      uit.gesprekken = rows.length;
      uit.gemTijd = metDuur > 0 ? mmss(Math.round(totSec / metDuur)) : null;
    }
  } catch (e) {
    warn.push('Blok 5 (call_log): ' + (e?.message || e));
  }
  // 5b. opvolging + belpot splits uit opvolging_pogingen (lijst van de taak via embed)
  try {
    const { data: pog, error } = await db.from('opvolging_pogingen')
      .select('soort, resultaat, richting, opvolging_taken!inner(lijst)')
      .gte('tijdstip', startIso).lt('tijdstip', endIso);
    if (error) throw new Error(error.message);
    const tel = (lijst) => {
      const rijen = (pog || []).filter((p) => (p.opvolging_taken?.lijst || 'dag') === lijst && p.richting !== 'in');
      const calls = rijen.filter((p) => p.soort === 'call');
      const bereikt = calls.filter((p) => classificeerResultaat(p.resultaat) === GESPROKEN).length;
      return {
        gebeld: calls.length,
        bereikt,
        afspraak: rijen.filter((p) => p.soort === 'ingepland').length,
        voicememo: rijen.filter((p) => p.soort === 'spraakbericht').length,
        nietBereikt: calls.length - bereikt,
      };
    };
    const dag = tel('dag'); const leads = tel('leads');
    uit.opvolging = { gebeld: dag.gebeld, bereikt: dag.bereikt, afspraak: dag.afspraak, voicememo: dag.voicememo };
    uit.belpot = { gebeld: leads.gebeld, bereikt: leads.bereikt, afspraak: leads.afspraak, nietBereikt: leads.nietBereikt };
  } catch (e) {
    warn.push('Blok 5 (opvolging/belpot): ' + (e?.message || e));
    uit.opvolging = { gebeld: null, bereikt: null, afspraak: null, voicememo: null };
    uit.belpot = { gebeld: null, bereikt: null, afspraak: null, nietBereikt: null };
  }
  return uit;
}

// ── Blok 6: nieuwe leads per categorie ──────────────────────────────────────
async function leadsPerCategorie(db, start, endExclusive, warn) {
  const rijen = [];
  const startIso = start.toISOString(); const endIso = endExclusive.toISOString();

  // mini-cursus & 7-daagse uit `leads`
  try {
    const { data: leadsRaw, error } = await db.from('leads')
      .select('id, email, bron, traject, afspraak_op')
      .is('verwijderd_op', null)
      .gte('aangemaakt', startIso).lt('aangemaakt', endIso)
      .limit(5000);
    if (error) throw new Error(error.message);
    const leads = (leadsRaw || []).filter((l) => l && l.id && !isTestEmail(l.email) && l.bron !== 'Import' && l.bron !== 'Import-telefoon');

    // "gebeld": lead heeft een opvolging_taken-kaart met een call-poging.
    const leadIds = leads.map((l) => l.id);
    const gebeldSet = new Set();
    if (leadIds.length) {
      const { data: taken } = await db.from('opvolging_taken').select('id, lead_id').in('lead_id', leadIds);
      const taakNaarLead = new Map((taken || []).map((t) => [t.id, t.lead_id]));
      const taakIds = [...taakNaarLead.keys()];
      if (taakIds.length) {
        const { data: pog } = await db.from('opvolging_pogingen').select('taak_id').eq('soort', 'call').in('taak_id', taakIds);
        for (const p of pog || []) { const lid = taakNaarLead.get(p.taak_id); if (lid) gebeldSet.add(lid); }
      }
    }

    const maakRij = (label, pred) => {
      const groep = leads.filter((l) => pred(laag(l.traject)));
      const callGepland = groep.filter((l) => l.afspraak_op != null).length;
      const gebeld = groep.filter((l) => gebeldSet.has(l.id)).length;
      const nietAangeraakt = groep.filter((l) => l.afspraak_op == null && !gebeldSet.has(l.id)).length;
      return { funnel: label, nieuw: groep.length, callGepland, gebeld, nietAangeraakt };
    };
    rijen.push(maakRij('Mini-cursus', isMini));
    rijen.push(maakRij('7-daagse', is7daagse));
  } catch (e) {
    warn.push('Blok 6 (mini/7-daagse leads): ' + (e?.message || e));
    rijen.push({ funnel: 'Mini-cursus', nieuw: null, callGepland: null, gebeld: null, nietAangeraakt: null });
    rijen.push({ funnel: '7-daagse', nieuw: null, callGepland: null, gebeld: null, nietAangeraakt: null });
  }

  // webinar: alleen "nieuw"; belwerk n.v.t.
  try {
    const { count, error } = await db.from('webinar_aanmeldingen')
      .select('id', { count: 'exact', head: true })
      .eq('is_test', false)
      .gte('created_at', startIso).lt('created_at', endIso);
    if (error) throw new Error(error.message);
    rijen.push({ funnel: 'Webinar', nieuw: count || 0, callGepland: null, gebeld: null, nietAangeraakt: null });
  } catch (e) {
    warn.push('Blok 6 (webinar): ' + (e?.message || e));
    rijen.push({ funnel: 'Webinar', nieuw: null, callGepland: null, gebeld: null, nietAangeraakt: null });
  }

  // events: "nieuw" + gebeld/onaangeraakt uit event_attendees.call_status; call gepland n.v.t.
  try {
    const { data: att, error } = await db.from('event_attendees')
      .select('email, is_test, status, call_status')
      .gte('created_at', startIso).lt('created_at', endIso)
      .limit(5000);
    if (error) throw new Error(error.message);
    const ev = (att || []).filter((a) => a && !a.is_test && a.status !== 'switched_to_other_event' && !isTestEmail(a.email));
    const gebeld = ev.filter((a) => a.call_status != null && String(a.call_status).trim() !== '').length;
    rijen.push({ funnel: 'Events', nieuw: ev.length, callGepland: null, gebeld, nietAangeraakt: ev.length - gebeld });
  } catch (e) {
    warn.push('Blok 6 (events): ' + (e?.message || e));
    rijen.push({ funnel: 'Events', nieuw: null, callGepland: null, gebeld: null, nietAangeraakt: null });
  }

  // Totaal: som van de gedefinieerde cellen per kolom.
  const som = (k) => rijen.reduce((a, r) => a + (r[k] == null ? 0 : r[k]), 0);
  const totaal = { nieuw: som('nieuw'), callGepland: som('callGepland'), gebeld: som('gebeld'), nietAangeraakt: som('nietAangeraakt') };
  // Actieregel: nieuwe leads vandaag zonder geplande call en nog niet gebeld.
  const onaangeraakt = totaal.nietAangeraakt;
  const actieRegel = `${onaangeraakt} nieuwe ${onaangeraakt === 1 ? 'lead' : 'leads'} van vandaag ${onaangeraakt === 1 ? 'heeft' : 'hebben'} nog geen call gepland en ${onaangeraakt === 1 ? 'is' : 'zijn'} nog niet gebeld. Deze staan klaar in de belpot.`;
  return { rijen, totaal, actieRegel };
}

// ── Blok 7: achterstallig (totaal) ──────────────────────────────────────────
async function achterstallig(db, warn) {
  try {
    const m = await computeMetrics(db, { period: 'today' }); // globaal (geen ownerScope)
    return {
      opvolgingenOverTijd: m.achterstallig_opvolgingen ?? m.opvolgingen_overdue ?? 0,
      outcomesOntbrekend: m.achterstallig_outcomes ?? 0,
      voicememosUitstaand: m.achterstallig_voicememos ?? 0,
      totaal: m.achterstallig_totaal ?? 0,
    };
  } catch (e) {
    warn.push('Blok 7 (achterstallig): ' + (e?.message || e));
    return { opvolgingenOverTijd: null, outcomesOntbrekend: null, voicememosUitstaand: null, totaal: null };
  }
}

function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
