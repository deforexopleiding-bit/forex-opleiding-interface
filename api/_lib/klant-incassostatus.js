// api/_lib/klant-incassostatus.js
//
// INCASSOSTATUS PER KLANT (PR 3 mentorcommissie, beslissing Maxim 3 nov 2026)
//
// Eén eenduidige status per klant, met datum, reden, wie en historiek:
//   actief            geen incasso (er is geen actieve rij)
//   bij_incasso       dossier bij het incassobureau → commissie STAAT STIL:
//                     betalingen vanaf `sinds` tellen (nog) niet
//   incasso_regeling  er is een regeling → betalingen tellen WEER, op wat
//                     effectief bij ons binnenkomt (nooit het bedrag vóór een
//                     bureaufee; de bureaufactuur is concept en telt nooit)
//   afgesloten        betaald (alles telt) of oninbaar (er komt niets meer;
//                     betalingen vanaf het begin van de incasso tellen niet)
// Dit VERVANGT de oude regel "alles na incasso telt nooit meer mee": bij
// incasso staat de commissie stil, en zodra er een regeling is loopt ze weer
// op echte betalingen (ook wat tijdens de stilstand binnenkwam). Al
// vrijgegeven/uitbetaald blijft altijd staan (forward-only).
//
// OPSLAG: mentor_commissie_incasso (2026-10-22) + kolommen uit
// docs/sql-migrations/2026-11-03-klant-incassostatus.sql (status,
// afgesloten_als, incasso_sinds). Eén ACTIEVE rij per klant (deal_id NULL,
// opgeheven_op NULL) = de huidige status. Elke wijziging sluit de vorige rij
// (opgeheven_op/door/reden) en opent een nieuwe → historiek. Opheffen = de
// actieve rij sluiten zonder nieuwe → status 'actief'.
// Fail-soft: zonder de kolommen is elke actieve rij 'bij_incasso' (het oude
// gedrag van de markering).
//
// De bestaande signalen (incassodossier, pipelinefase incasso, onboarding op
// incasso) zijn VOORSTELLEN, nooit automatisch een status.

export const STATUSSEN = ['actief', 'bij_incasso', 'incasso_regeling', 'afgesloten'];
export const AFGESLOTEN_ALS = ['betaald', 'oninbaar'];
export const STATUS_LABEL = {
  actief: 'Actief',
  bij_incasso: 'Bij incasso',
  incasso_regeling: 'Incasso-regeling',
  afgesloten: 'Afgesloten',
};
export const STATUS_KOLOMMEN = 'status, afgesloten_als, incasso_sinds';
const BASIS_KOLOMMEN = 'id, customer_id, deal_id, sinds, reden, bron, gezet_door, gezet_op, opgeheven_op, opgeheven_door, opheffen_reden';

const datum = (d) => (d ? String(d).slice(0, 10) : null);

/** Status van één markeringsrij (fail-soft: zonder kolom = bij_incasso). */
export const statusVan = (m) => (m && STATUSSEN.includes(m.status) ? m.status : 'bij_incasso');

/**
 * Vanaf welke datum tellen betalingen NIET voor de commissie? null = alles telt.
 *   bij_incasso          → sinds (stilstand)
 *   afgesloten/oninbaar  → begin van de incasso (incasso_sinds, anders sinds)
 *   incasso_regeling / afgesloten-betaald → null (echte betalingen tellen)
 */
export function commissieStop(m) {
  if (!m || m.opgeheven_op) return null;
  const s = statusVan(m);
  if (s === 'bij_incasso') return datum(m.sinds);
  if (s === 'afgesloten' && m.afgesloten_als === 'oninbaar') return datum(m.incasso_sinds || m.sinds);
  return null;
}

/** Huidige status van een klant uit zijn rijen (puur). */
export function huidigeStatus(rijen, customerId) {
  const actief = (rijen || []).find((m) => m && m.customer_id === customerId && !m.deal_id && !m.opgeheven_op);
  if (!actief) return { status: 'actief', label: STATUS_LABEL.actief, sinds: null, rij: null };
  const st = statusVan(actief);
  return {
    status: st,
    label: STATUS_LABEL[st] + (st === 'afgesloten' && actief.afgesloten_als ? ` (${actief.afgesloten_als})` : ''),
    sinds: datum(actief.sinds),
    incasso_sinds: datum(actief.incasso_sinds || actief.sinds),
    afgesloten_als: actief.afgesloten_als || null,
    reden: actief.reden || null,
    gezet_door: actief.gezet_door || null,
    gezet_op: actief.gezet_op || null,
    commissie_stop: commissieStop(actief),
    rij: actief,
  };
}

/**
 * Label voor de MENTOR per sale (geen dossierdetails, geen vrije tekst van
 * Maxim). code: bij_incasso | regeling | geannuleerd | weggevallen | null.
 */
export function mentorLabel({ marking = null, saleGeannuleerd = false } = {}) {
  if (saleGeannuleerd) {
    return { code: 'geannuleerd', tekst: 'Geannuleerd', reden: 'De sale is geannuleerd.', verwachting: 'Er komt geen commissie meer bij; wat al vrijgegeven is blijft van jou.' };
  }
  if (!marking || marking.opgeheven_op) return null;
  const st = statusVan(marking);
  const sinds = datum(marking.sinds);
  if (st === 'bij_incasso') {
    return { code: 'bij_incasso', tekst: `Bij incasso${sinds ? ' sinds ' + nlDatum(sinds) : ''}`, sinds,
      reden: 'De klant betaalt niet; het dossier ligt bij het incassobureau.',
      verwachting: 'Je commissie staat stil. Komt er een regeling, dan telt elke betaling weer mee.' };
  }
  if (st === 'incasso_regeling') {
    return { code: 'regeling', tekst: `Regeling${sinds ? ' sinds ' + nlDatum(sinds) : ''}`, sinds,
      reden: 'Na incasso is er een betalingsregeling met de klant.',
      verwachting: 'Je commissie loopt weer op wat effectief binnenkomt, tot je oorspronkelijke commissie.' };
  }
  if (st === 'afgesloten' && marking.afgesloten_als === 'oninbaar') {
    return { code: 'weggevallen', tekst: 'Weggevallen', sinds,
      reden: 'Het dossier is afgesloten als oninbaar.',
      verwachting: 'Er komt niets meer binnen; wat al vrijgegeven is blijft van jou.' };
  }
  return null; // afgesloten-betaald: gewoon zoals een betaalde sale
}

function nlDatum(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso || '');
}

function ontbreekt(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  return ['42P01', '42703', 'PGRST205', 'PGRST204'].includes(code) || /mentor_commissie_incasso|status|afgesloten_als|incasso_sinds/i.test(msg) && /does not exist|could not find|schema cache/i.test(msg);
}

/** Rijen (incl. historiek) voor een set klanten; fail-soft op de statuskolommen. */
export async function laadIncassoRijen(db, customerIds = [], { alleenActief = false } = {}) {
  const ids = [...new Set((customerIds || []).filter(Boolean))];
  if (!ids.length) return { ok: true, statusKolommen: true, rijen: [] };
  const vraag = (kolommen) => {
    let q = db.from('mentor_commissie_incasso').select(kolommen).in('customer_id', ids);
    if (alleenActief) q = q.is('opgeheven_op', null);
    return q;
  };
  let statusKolommen = true;
  let { data, error } = await vraag(`${BASIS_KOLOMMEN}, ${STATUS_KOLOMMEN}`);
  if (error && ontbreekt(error)) {
    statusKolommen = false;
    ({ data, error } = await vraag(BASIS_KOLOMMEN));
  }
  if (error) {
    if (!ontbreekt(error)) console.warn('[klant-incassostatus] lezen:', error.message);
    return { ok: false, statusKolommen: false, rijen: [] };
  }
  return { ok: true, statusKolommen, rijen: data || [] };
}

/** Actieve status per klant voor een filter (alle klanten met een actieve rij). */
export async function klantenMetStatus(db, statussen = []) {
  const want = statussen.filter((s) => STATUSSEN.includes(s) && s !== 'actief');
  if (!want.length) return null;
  let { data, error } = await db.from('mentor_commissie_incasso').select(`customer_id, ${STATUS_KOLOMMEN}`).is('opgeheven_op', null).is('deal_id', null);
  if (error && ontbreekt(error)) ({ data, error } = await db.from('mentor_commissie_incasso').select('customer_id').is('opgeheven_op', null).is('deal_id', null));
  if (error) { console.warn('[klant-incassostatus] filter:', error.message); return []; }
  return [...new Set((data || []).filter((r) => want.includes(statusVan(r))).map((r) => r.customer_id))];
}

/** Voorstellen uit de bestaande signalen (nooit automatisch). Fail-soft per bron. */
export async function laadVoorstellen(db, customerIds = []) {
  const ids = [...new Set((customerIds || []).filter(Boolean))];
  const uit = new Map(); // customer_id → [{ bron, sinds, voorstel }]
  const voeg = (cid, bron, sinds, voorstel) => {
    if (!cid) return;
    if (!uit.has(cid)) uit.set(cid, []);
    uit.get(cid).push({ bron, sinds: datum(sinds), voorstel });
  };
  if (!ids.length) return uit;
  try {
    const { data } = await db.from('dunning_incasso_dossiers').select('customer_id, status, opened_at').in('customer_id', ids);
    for (const r of data || []) {
      const st = String(r.status || '').toLowerCase();
      if (st === 'betaald') { voeg(r.customer_id, 'Incassodossier betaald', r.opened_at, 'afgesloten'); continue; }
      if (['afgeschreven', 'oninbaar'].includes(st)) { voeg(r.customer_id, `Incassodossier ${st}`, r.opened_at, 'afgesloten'); continue; }
      if (st === 'geretourneerd') continue;
      voeg(r.customer_id, `Incassodossier (${r.status || 'open'})`, r.opened_at, /regeling/.test(st) ? 'incasso_regeling' : 'bij_incasso');
    }
  } catch (e) { console.warn('[klant-incassostatus] dossiers:', e?.message || e); }
  try {
    const { data } = await db.from('dunning_pipeline_customers').select('customer_id, stage_slug, stage_changed_at').in('customer_id', ids);
    for (const r of data || []) {
      if (r.stage_slug === 'incasso') voeg(r.customer_id, 'Wanbetalers-pipeline: incasso', r.stage_changed_at, 'bij_incasso');
      if (r.stage_slug === 'regeling') voeg(r.customer_id, 'Wanbetalers-pipeline: regeling', r.stage_changed_at, 'incasso_regeling');
      if (r.stage_slug === 'afschrijven') voeg(r.customer_id, 'Wanbetalers-pipeline: afschrijven', r.stage_changed_at, 'afgesloten');
    }
  } catch (e) { console.warn('[klant-incassostatus] pipeline:', e?.message || e); }
  try {
    const { data } = await db.from('onboardings').select('customer_id, incasso_op').in('customer_id', ids).not('incasso_op', 'is', null);
    for (const r of data || []) if (r.incasso_op) voeg(r.customer_id, 'Onboarding op incasso', r.incasso_op, 'bij_incasso');
  } catch (e) { console.warn('[klant-incassostatus] onboarding:', e?.message || e); }
  return uit;
}

/**
 * Status zetten (of opheffen met status 'actief'). Sluit de actieve rij en
 * opent een nieuwe. Gooit { status, code, message } bij een fout.
 */
export async function zetStatus(db, { customerId, status, afgeslotenAls = null, sinds, reden, actorId = null, bron = 'handmatig' }) {
  const fout = (s, code, message) => Object.assign(new Error(message), { status: s, code });
  if (!STATUSSEN.includes(status)) throw fout(400, 'STATUS', 'Status moet actief, bij_incasso, incasso_regeling of afgesloten zijn.');
  if (status === 'afgesloten' && !AFGESLOTEN_ALS.includes(afgeslotenAls)) throw fout(400, 'AFGESLOTEN_ALS', 'Kies: afgesloten als betaald of als oninbaar.');
  const dag = datum(sinds);
  if (status !== 'actief' && !/^\d{4}-\d{2}-\d{2}$/.test(String(dag || ''))) throw fout(400, 'DATUM', 'Datum (YYYY-MM-DD) vereist.');
  const r = String(reden || '').trim().slice(0, 500);
  if (r.length < 3) throw fout(400, 'REDEN', 'Geef een reden.');

  const { ok, statusKolommen, rijen } = await laadIncassoRijen(db, [customerId], { alleenActief: true });
  if (!ok) throw fout(503, 'MIGRATIE_ONTBREEKT', 'De tabel mentor_commissie_incasso ontbreekt (migratie 2026-10-22).');
  if (!statusKolommen && status !== 'bij_incasso' && status !== 'actief') {
    throw fout(503, 'MIGRATIE_ONTBREEKT', 'Migratie 2026-11-03-klant-incassostatus.sql is nog niet gedraaid: enkel "bij incasso" en opheffen werken.');
  }
  const huidig = huidigeStatus(rijen, customerId);
  if (huidig.status === status && status === 'actief') return { ok: true, ongewijzigd: true, status: huidig };
  if (huidig.status === status && status !== 'afgesloten') throw fout(409, 'AL_GEZET', `De klant staat al op "${STATUS_LABEL[status]}".`);

  const nu = new Date().toISOString();
  // 1) Huidige rij sluiten (historiek).
  if (huidig.rij) {
    const { error } = await db.from('mentor_commissie_incasso').update({
      opgeheven_op: nu, opgeheven_door: actorId, opheffen_reden: `→ ${STATUS_LABEL[status]}: ${r}`.slice(0, 500),
    }).eq('id', huidig.rij.id).is('opgeheven_op', null);
    if (error) throw new Error('status sluiten: ' + error.message);
  }
  if (status === 'actief') return { ok: true, status: { status: 'actief' } };

  // 2) Nieuwe rij. incasso_sinds = begin van de incasso-keten.
  const incassoSinds = huidig.rij ? (huidig.incasso_sinds || huidig.sinds) : dag;
  const rij = {
    customer_id: customerId, deal_id: null, sinds: dag, reden: r,
    bron: bron === 'voorstel' ? 'voorstel' : 'handmatig', gezet_door: actorId,
  };
  if (statusKolommen) Object.assign(rij, { status, afgesloten_als: status === 'afgesloten' ? afgeslotenAls : null, incasso_sinds: incassoSinds });
  const { data, error } = await db.from('mentor_commissie_incasso').insert(rij).select('id').single();
  if (error) {
    // Herstel: de vorige rij weer openen, zodat de klant nooit statusloos wordt.
    if (huidig.rij) await db.from('mentor_commissie_incasso').update({ opgeheven_op: null, opgeheven_door: null, opheffen_reden: null }).eq('id', huidig.rij.id);
    if (error.code === '23505') throw fout(409, 'AL_GEZET', 'Er staat al een actieve incassostatus voor deze klant.');
    throw new Error('status opslaan: ' + error.message);
  }
  return { ok: true, id: data?.id || null, status: { status, sinds: dag, incasso_sinds: incassoSinds } };
}
