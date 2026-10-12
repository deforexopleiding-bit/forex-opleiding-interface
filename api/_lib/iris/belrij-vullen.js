// api/_lib/iris/belrij-vullen.js
//
// De databankkant van taak 6, deel 1: de drie bronnen lezen en de belrij
// bijwerken. De regels zelf staan in belrij-bronnen.js (puur, los te toetsen);
// hier staat alleen wat een databank nodig heeft.
//
// ── WAT DIT NOOIT DOET ───────────────────────────────────────────────────────
//   · niets schrijven buiten iris_belrij en iris_belrij_redenen. De
//     wanbetalersmodule, iris_signalen en iris_opvolgingen worden ALLEEN gelezen.
//   · geen rij verwijderen. Een reden die niet meer geldt krijgt verwerkt_op;
//     dat is geschiedenis, niet afval.
//   · geen handmatig toegevoegde rij aanraken. Een rij zonder regels in
//     iris_belrij_redenen is door een mens gezet (api/iris-actie.js) en blijft
//     van die mens.
//   · geen bericht versturen. Dat is deel 3 (escalatie), en staat daar achter
//     een stand die uit staat.
//
// ── WAAROM GEEN upsert MET ON CONFLICT OP iris_belrij ────────────────────────
// "Eén open rij per persoon" is een PARTIËLE unieke index (alleen waar status in
// open/bezig), en een partiële index kan in PostgREST/supabase-js geen
// ON CONFLICT-arbiter zijn — dat is de les uit follow-up-ghl-appointment-poll.js
// van 20 mei. Daarom per persoon: SELECT de open rij, dan UPDATE of INSERT.
// Op iris_belrij_redenen kan het wél, want daar is de index volledig
// (belrij_id, bron_sleutel).

import { voorstelVoor } from './signalen.js';
import {
  uitBeltaak, uitSignaal, uitOpvolging, voegSamen, vervallenRedenen,
} from './belrij-bronnen.js';

/** Zoveel per bron per ronde. Ruim boven wat er dagelijks bijkomt, en ver onder de 60 s van Vercel. */
export const PER_BRON_MAX = 500;

/** Statussen waarin een belrij-rij "nog werk" is. Gelijk aan idx_iris_belrij_open. */
export const OPEN_STATUS = Object.freeze(['open', 'bezig']);

/* ── 1. Bel-taken van de wanbetalers ──────────────────────────────────────── */

/**
 * pending_actions met action_type='MANUAL_FOLLOWUP' en payload->>kind='call'.
 *
 * Dat filter dekt twee dingen tegelijk: de taken die iemand met de hand in de
 * inbox aanmaakt, én wat de aanmaanmotor als bellen markeert — die zet kind
 * 'call' zelf al zodra de titel met "Bel klant" begint
 * (api/_lib/dunning-step-executors.js). Eén lezer, geen tweede lijst met
 * titelpatronen die uit elkaar kan lopen.
 */
export async function leesBeltaken(db, { max = PER_BRON_MAX } = {}) {
  const { data, error } = await db
    .from('pending_actions')
    .select('id, customer_id, payload, scheduled_for, created_at')
    .eq('action_type', 'MANUAL_FOLLOWUP')
    .in('status', ['PENDING', 'APPROVED'])
    .filter('payload->>kind', 'eq', 'call')
    .not('customer_id', 'is', null)
    .order('scheduled_for', { ascending: true, nullsFirst: false })
    .limit(max);
  if (error) throw new Error(`bel-taken lezen: ${error.message}`);
  return data || [];
}

/**
 * customer_id → contact_id.
 *
 * Meerdere contacten op dezelfde klant komt voor (Andy heeft twee rijen met
 * hetzelfde adres). Dan is er geen enkele juiste keuze, dus valt die klant eruit
 * en blijft de bel-taak staan waar hij staat. Gokken zou betekenen dat de
 * verkeerde persoon gebeld wordt.
 */
export async function contactPerKlant(db, klantIds) {
  const uniek = [...new Set((klantIds || []).filter(Boolean))];
  if (!uniek.length) return { kaart: new Map(), meerdere: [] };

  const { data, error } = await db
    .from('iris_contacten')
    .select('id, customer_id')
    .in('customer_id', uniek);
  if (error) throw new Error(`contacten lezen: ${error.message}`);

  const perKlant = new Map();
  for (const r of (data || [])) {
    if (!r?.customer_id || !r.id) continue;
    const lijst = perKlant.get(r.customer_id) || [];
    lijst.push(r.id);
    perKlant.set(r.customer_id, lijst);
  }

  const kaart = new Map();
  const meerdere = [];
  for (const [klant, lijst] of perKlant.entries()) {
    if (lijst.length === 1) kaart.set(klant, lijst[0]);
    else meerdere.push(klant);
  }
  return { kaart, meerdere };
}

/* ── 2. Mentorsignalen ────────────────────────────────────────────────────── */

/**
 * Onverwerkte mentorsignalen waarvan het voorstel 'belrij_toevoegen' is.
 *
 * Het filteren op type gebeurt in JS en niet in de query: iris_signalen.type is
 * met opzet vrije tekst (het LMS krijgt er types bij), en welke types op de
 * belrij horen staat in VOORSTEL_PER_TYPE in signalen.js. Die lijst hier nog een
 * keer in een .in() zetten levert twee lijsten op die uit elkaar lopen.
 */
export async function leesSignalen(db, { max = PER_BRON_MAX } = {}) {
  const { data, error } = await db
    .from('iris_signalen')
    .select('id, contact_id, type, mentor_naam, toelichting, signaal_op')
    .is('verwerkt_op', null)
    .not('contact_id', 'is', null)
    .order('signaal_op', { ascending: false })
    .limit(max);
  if (error) throw new Error(`signalen lezen: ${error.message}`);
  return (data || []).filter((r) => voorstelVoor(r?.type)?.actie === 'belrij_toevoegen');
}

/* ── 3. Verlopen opvolgingen ──────────────────────────────────────────────── */

export async function leesVerlopenOpvolgingen(db, { max = PER_BRON_MAX } = {}) {
  const { data, error } = await db
    .from('iris_opvolgingen')
    .select('id, contact_id, gesprek_id, omschrijving, tot, status')
    .eq('status', 'verlopen')
    .order('tot', { ascending: true })
    .limit(max);
  if (error) throw new Error(`opvolgingen lezen: ${error.message}`);
  return data || [];
}

/** Een opvolging op een gesprek heeft niet altijd een contact_id. Vul die aan uit het gesprek. */
export async function contactPerGesprek(db, gesprekIds) {
  const uniek = [...new Set((gesprekIds || []).filter(Boolean))];
  if (!uniek.length) return new Map();
  const { data, error } = await db
    .from('iris_gesprekken')
    .select('id, contact_id')
    .in('id', uniek);
  if (error) throw new Error(`gesprekken lezen: ${error.message}`);
  const kaart = new Map();
  for (const r of (data || [])) if (r?.id && r.contact_id) kaart.set(r.id, r.contact_id);
  return kaart;
}

/* ── 4. Eén persoon wegschrijven ──────────────────────────────────────────── */

/**
 * Zorg dat deze persoon één open belrij-rij heeft, en hang zijn redenen eronder.
 *
 * Stappen, in deze volgorde en met opzet:
 *   1. SELECT de open rij (geen ON CONFLICT — zie de kop van dit bestand).
 *   2. UPDATE of INSERT. Bij UPDATE schuift de prioriteit alleen OMHOOG: een
 *      mens die een rij handmatig hoger zette, mag daar niet door een ronde
 *      overheen gereden worden.
 *   3. De redenen erbij, met upsert op (belrij_id, bron_sleutel) — idempotent.
 *   4. Redenen die de bronnen niet meer aanleveren krijgen verwerkt_op.
 *
 * Geeft terug wat er gebeurd is, zodat de cron-ronde kan tellen zonder zelf te
 * hoeven kijken.
 */
export async function schrijfPersoon(db, rij, { nu = new Date() } = {}) {
  const uit = { nieuw: 0, bijgewerkt: 0, redenen_nieuw: 0, redenen_verwerkt: 0 };
  if (!rij?.contact_id || !Array.isArray(rij.redenen) || !rij.redenen.length) return uit;

  const { data: bestaand, error: leesFout } = await db
    .from('iris_belrij')
    .select('id, prioriteit, status, bron')
    .eq('contact_id', rij.contact_id)
    .in('status', OPEN_STATUS)
    .order('aangemaakt_op', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (leesFout) throw new Error(`belrij lezen: ${leesFout.message}`);

  let belrijId = bestaand?.id || null;

  if (belrijId) {
    const hoogste = Math.max(Number(bestaand.prioriteit) || 0, Number(rij.prioriteit) || 0);
    const velden = { bijgewerkt_op: nu.toISOString() };
    if (hoogste !== Number(bestaand.prioriteit)) velden.prioriteit = hoogste;
    const { error } = await db.from('iris_belrij').update(velden).eq('id', belrijId);
    if (error) throw new Error(`belrij bijwerken: ${error.message}`);
    uit.bijgewerkt = 1;
  } else {
    const kop = rij.redenen[0];
    const { data, error } = await db
      .from('iris_belrij')
      .insert({
        contact_id: rij.contact_id,
        reden: String(kop.reden || 'bellen').slice(0, 200),
        reden_detail: kop.reden_detail || null,
        prioriteit: Number(rij.prioriteit) || 50,
        bron: rij.bron || 'hand',
        // Expliciet, al staat er een DEFAULT op de kolom: de SELECT hierboven
        // zoekt op status, dus een rij die om wat voor reden ook zonder status
        // wordt aangemaakt, wordt de volgende ronde niet teruggevonden en
        // levert een tweede rij voor dezelfde persoon op.
        status: 'open',
      })
      .select('id')
      .single();
    if (error) throw new Error(`belrij aanmaken: ${error.message}`);
    belrijId = data.id;
    uit.nieuw = 1;
  }

  const { data: gezet, error: redenFout } = await db
    .from('iris_belrij_redenen')
    .upsert(
      rij.redenen.map((r) => ({
        belrij_id: belrijId,
        bron: r.bron,
        bron_sleutel: r.bron_sleutel,
        reden: r.reden,
        reden_detail: r.reden_detail,
        bron_link: r.bron_link,
        verwerkt_op: null,
      })),
      { onConflict: 'belrij_id,bron_sleutel' }
    )
    .select('id');
  if (redenFout) throw new Error(`redenen opslaan: ${redenFout.message}`);
  uit.redenen_nieuw = (gezet || []).length;

  const { data: open, error: openFout } = await db
    .from('iris_belrij_redenen')
    .select('id, bron_sleutel')
    .eq('belrij_id', belrijId)
    .is('verwerkt_op', null);
  if (openFout) throw new Error(`open redenen lezen: ${openFout.message}`);

  const weg = vervallenRedenen(open, rij.redenen.map((r) => r.bron_sleutel));
  if (weg.length) {
    const { error } = await db
      .from('iris_belrij_redenen')
      .update({ verwerkt_op: nu.toISOString() })
      .in('id', weg);
    if (error) throw new Error(`redenen afvinken: ${error.message}`);
    uit.redenen_verwerkt = weg.length;
  }

  return uit;
}

/* ── 5. De hele ronde ─────────────────────────────────────────────────────── */

/**
 * Lees de drie bronnen, voeg samen en schrijf weg.
 *
 * Per persoon een eigen try/catch: één contact waar iets misgaat mag de rest van
 * de ronde niet blokkeren (les 3). De telling en de eerste paar fouten komen in
 * het rapport; de rest alleen in console.error, zodat een stille faalronde niet
 * bestaat.
 */
export async function vulBelrij(db, { nu = new Date(), max = PER_BRON_MAX, opTijd = () => true } = {}) {
  const rapport = {
    kandidaten: 0, personen: 0,
    nieuw: 0, bijgewerkt: 0,
    redenen_nieuw: 0, redenen_verwerkt: 0,
    zonder_contact: 0, meerdere_contacten: 0,
    fouten: [], afgekapt: false,
  };

  const [beltaken, signalen, opvolgingen] = await Promise.all([
    leesBeltaken(db, { max }),
    leesSignalen(db, { max }),
    leesVerlopenOpvolgingen(db, { max }),
  ]);

  const { kaart: perKlant, meerdere } = await contactPerKlant(db, beltaken.map((t) => t.customer_id));
  rapport.meerdere_contacten = meerdere.length;

  const zonderContact = opvolgingen.filter((o) => !o.contact_id && o.gesprek_id);
  const perGesprek = await contactPerGesprek(db, zonderContact.map((o) => o.gesprek_id));

  const kandidaten = [];
  for (const t of beltaken) {
    const k = uitBeltaak(t, { contactId: perKlant.get(t.customer_id) || null });
    if (k) kandidaten.push(k); else rapport.zonder_contact++;
  }
  for (const s of signalen) {
    const k = uitSignaal(s);
    if (k) kandidaten.push(k); else rapport.zonder_contact++;
  }
  for (const o of opvolgingen) {
    const k = uitOpvolging(o, { contactId: perGesprek.get(o.gesprek_id) || null });
    if (k) kandidaten.push(k); else rapport.zonder_contact++;
  }
  rapport.kandidaten = kandidaten.length;

  const rijen = voegSamen(kandidaten);
  rapport.personen = rijen.length;

  for (const rij of rijen) {
    if (!opTijd()) { rapport.afgekapt = true; break; }
    try {
      const uit = await schrijfPersoon(db, rij, { nu });
      rapport.nieuw += uit.nieuw;
      rapport.bijgewerkt += uit.bijgewerkt;
      rapport.redenen_nieuw += uit.redenen_nieuw;
      rapport.redenen_verwerkt += uit.redenen_verwerkt;
    } catch (e) {
      const tekst = e?.message || String(e);
      console.error(`[iris/belrij-vullen] contact ${rij.contact_id}:`, tekst);
      if (rapport.fouten.length < 3) rapport.fouten.push(tekst);
    }
  }

  return rapport;
}
