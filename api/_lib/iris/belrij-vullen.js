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

import { randomUUID } from 'node:crypto';

import { voorstelVoor } from './signalen.js';
import { haalInstellingen, eigenaarVoorBron } from './instellingen.js';
import {
  uitBeltaak, uitSignaal, uitOpvolging, voegSamen, vervallenRedenen,
} from './belrij-bronnen.js';

/** Zoveel per bron per ronde. Ruim boven wat er dagelijks bijkomt, en ver onder de 60 s van Vercel. */
export const PER_BRON_MAX = 500;

/** Statussen waarin een belrij-rij "nog werk" is. Gelijk aan idx_iris_belrij_open. */
export const OPEN_STATUS = Object.freeze(['open', 'bezig']);

/** Postgres: een unieke index die overtreden wordt. */
const DUBBELE_RIJ = '23505';

/**
 * De open rij aanmaken, en een 23505 lezen als "staat er al".
 *
 * ── WAAROM DIT NODIG IS ──────────────────────────────────────────────────────
 * Sinds 13 okt staat `idx_iris_belrij_een_open_per_contact` in productie: een
 * partiële unieke index op contact_id waar de status open of bezig is. Die
 * index kan geen ON CONFLICT-arbiter zijn (zie de kop van dit bestand), dus
 * zowel de vuller als de knop op het scherm doen SELECT-dan-UPDATE-of-INSERT.
 * Tussen die SELECT en die INSERT zit ruimte, en daar lopen twee schrijvers
 * elkaar tegen het lijf: de cron-ronde en een mens die op "op de lijst zetten"
 * klikt.
 *
 * Wie die race verliest, kreeg een 23505 als harde fout. In de ronde is dat
 * fail-soft (één foutregel, die persoon een ronde overgeslagen), maar op de
 * knop is het een 500 terwijl de rij er gewoon staat — precies de verwarring
 * die de index moest wegnemen. Een 23505 op déze index betekent niet "er ging
 * iets mis", het betekent "iemand anders was net sneller". Zelfde lijn als de
 * ontdubbeling van de supportmail: een 23505 op de index is "al verwerkt".
 *
 * Alleen 23505 vangen we; elke andere fout gooit door. En vinden we daarna
 * alsnog geen open rij (de ander heeft 'm meteen weer afgerond), dan gooien we
 * de oorspronkelijke fout — stil doen alsof het goed ging, zou een rij
 * verzinnen die niet bestaat.
 *
 * @returns {Promise<{ rij: object, nieuw: boolean }>} nieuw=false → de race verloren
 */
async function maakOpenRij(db, velden) {
  const { data, error } = await db
    .from('iris_belrij')
    .insert(velden)
    .select('id')
    .single();
  if (!error) {
    return { rij: { id: data.id, prioriteit: velden.prioriteit, eigenaar: velden.eigenaar, status: velden.status, bron: velden.bron }, nieuw: true };
  }
  if (String(error.code || '') !== DUBBELE_RIJ) throw new Error(`belrij aanmaken: ${error.message}`);

  const { data: alsnog, error: leesFout } = await db
    .from('iris_belrij')
    .select('id, prioriteit, status, bron, eigenaar')
    .eq('contact_id', velden.contact_id)
    .in('status', OPEN_STATUS)
    .order('aangemaakt_op', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (leesFout) throw new Error(`belrij na dubbele rij lezen: ${leesFout.message}`);
  if (!alsnog?.id) throw new Error(`belrij aanmaken: ${error.message}`);
  console.warn('[iris/belrij-vullen] open rij bestond al (race); reden komt op de bestaande rij:', alsnog.id);
  return { rij: alsnog, nieuw: false };
}

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
export async function schrijfPersoon(db, rij, { nu = new Date(), eigenaren = {} } = {}) {
  const uit = { nieuw: 0, bijgewerkt: 0, redenen_nieuw: 0, redenen_verwerkt: 0, redenen_fout: null };
  if (!rij?.contact_id || !Array.isArray(rij.redenen) || !rij.redenen.length) return uit;

  const { data: bestaand, error: leesFout } = await db
    .from('iris_belrij')
    .select('id, prioriteit, status, bron, eigenaar')
    .eq('contact_id', rij.contact_id)
    .in('status', OPEN_STATUS)
    .order('aangemaakt_op', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (leesFout) throw new Error(`belrij lezen: ${leesFout.message}`);

  // Staat er nog niets, dan maken we de rij. Verliezen we daarbij de race met
  // een andere schrijver, dan geeft maakOpenRij de rij van die ander terug en
  // lopen we gewoon door naar de bijwerk-tak eronder — de redenen komen dan op
  // die rij, niet op een tweede.
  let huidig = bestaand || null;
  let isNieuw = false;
  if (!huidig) {
    const kop = rij.redenen[0];
    const gemaakt = await maakOpenRij(db, {
      contact_id: rij.contact_id,
      reden: String(kop.reden || 'bellen').slice(0, 200),
      reden_detail: kop.reden_detail || null,
      prioriteit: Number(rij.prioriteit) || 50,
      bron: rij.bron || 'hand',
      // Wie belt er. Null als de regel voor deze bron niet is ingesteld; dan
      // staat de rij onder "alle" en wacht hij daar op iemand. Dat is beter
      // dan hem aan de verkeerde persoon hangen.
      eigenaar: eigenaarVoorBron(eigenaren, rij.bron),
      // Expliciet, al staat er een DEFAULT op de kolom: de SELECT hierboven
      // zoekt op status, dus een rij die om wat voor reden ook zonder status
      // wordt aangemaakt, wordt de volgende ronde niet teruggevonden en
      // levert een tweede rij voor dezelfde persoon op.
      status: 'open',
    });
    huidig = gemaakt.rij;
    isNieuw = gemaakt.nieuw;
  }

  const belrijId = huidig.id;

  if (isNieuw) {
    uit.nieuw = 1;
  } else {
    const hoogste = Math.max(Number(huidig.prioriteit) || 0, Number(rij.prioriteit) || 0);
    const velden = { bijgewerkt_op: nu.toISOString() };
    if (hoogste !== Number(huidig.prioriteit)) velden.prioriteit = hoogste;
    // Een eigenaar die er al staat blijft staan -- ook als de regel nu iemand
    // anders aanwijst. Wie een rij heeft opgepakt, raakt hem niet kwijt doordat
    // er een tweede reden bij komt uit een bron met een andere eigenaar.
    if (!huidig.eigenaar) {
      const volgensRegel = eigenaarVoorBron(eigenaren, rij.bron);
      if (volgensRegel) velden.eigenaar = volgensRegel;
    }
    const { error } = await db.from('iris_belrij').update(velden).eq('id', belrijId);
    if (error) throw new Error(`belrij bijwerken: ${error.message}`);
    uit.bijgewerkt = 1;
  }

  // ── De redenen, fail-soft ───────────────────────────────────────────────────
  //
  // Hierboven staat de belrij-rij al in de databank. Gooien we hier, dan is de
  // rij er wél en de reden niet -- en dan probeert de volgende ronde hetzelfde
  // opnieuw en gooit opnieuw. Dat levert een belrij op die zich gewoon vult
  // (met de ene reden die in iris_belrij.reden staat, zoals vóór taak 6) plus
  // een foutmelding per persoon per ronde. Niemand leest dat, en het verbergt
  // elke ándere fout eronder.
  //
  // Het geval dat dit in de praktijk raakt: de migratie
  // docs/sql-migrations/2026-10-12-iris-belrij-redenen.sql is nog niet
  // gedraaid. Dan is de belrij nuttig-maar-beperkt in plaats van luidruchtig
  // kapot, en de ronde zegt ÉÉN keer wat eraan mankeert.
  //
  // Fail-soft is hier geen "fout wegslikken": de reden komt in het rapport en
  // in console.error, dus een echte bug in dit pad blijft zichtbaar. Alleen
  // blokkeert hij de rest van de ronde niet meer.
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
  if (redenFout) {
    uit.redenen_fout = redenFout.message;
    console.error('[iris/belrij-vullen] redenen opslaan:', redenFout.message);
    return uit;
  }
  uit.redenen_nieuw = (gezet || []).length;

  const { data: open, error: openFout } = await db
    .from('iris_belrij_redenen')
    .select('id, bron_sleutel')
    .eq('belrij_id', belrijId)
    .is('verwerkt_op', null);
  if (openFout) {
    uit.redenen_fout = openFout.message;
    console.error('[iris/belrij-vullen] open redenen lezen:', openFout.message);
    return uit;
  }

  const weg = vervallenRedenen(open, rij.redenen.map((r) => r.bron_sleutel));
  if (weg.length) {
    const { error } = await db
      .from('iris_belrij_redenen')
      .update({ verwerkt_op: nu.toISOString() })
      .in('id', weg);
    if (error) {
      uit.redenen_fout = error.message;
      console.error('[iris/belrij-vullen] redenen afvinken:', error.message);
      return uit;
    }
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
    // Eén keer per ronde, niet één keer per persoon: als de redenen-tabel er
    // niet is, is dat één probleem en geen honderd.
    redenen_fout: null, redenen_fout_aantal: 0,
    fouten: [], afgekapt: false,
  };

  const [beltaken, signalen, opvolgingen, instellingen] = await Promise.all([
    leesBeltaken(db, { max }),
    leesSignalen(db, { max }),
    leesVerlopenOpvolgingen(db, { max }),
    // Fail-soft: haalInstellingen geeft bij een leesfout de standaard terug, en
    // die is een LEGE eigenaarskaart. Dan komt een rij zonder eigenaar op de
    // lijst -- zichtbaar onder "alle". Niet aan de verkeerde persoon hangen.
    haalInstellingen(db),
  ]);
  const eigenaren = instellingen?.belrij_eigenaar || {};

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
      const uit = await schrijfPersoon(db, rij, { nu, eigenaren });
      rapport.nieuw += uit.nieuw;
      rapport.bijgewerkt += uit.bijgewerkt;
      rapport.redenen_nieuw += uit.redenen_nieuw;
      rapport.redenen_verwerkt += uit.redenen_verwerkt;
      if (uit.redenen_fout) {
        rapport.redenen_fout_aantal++;
        if (!rapport.redenen_fout) rapport.redenen_fout = uit.redenen_fout;
      }
    } catch (e) {
      const tekst = e?.message || String(e);
      console.error(`[iris/belrij-vullen] contact ${rij.contact_id}:`, tekst);
      if (rapport.fouten.length < 3) rapport.fouten.push(tekst);
    }
  }

  return rapport;
}

/* ── 6. Met de hand op de lijst zetten ────────────────────────────────────── */

/**
 * Eén persoon met de hand op de belrij, langs hetzelfde pad als de vuller.
 *
 * ── WAAROM DIT NIET MEER EEN GEWONE INSERT IS ────────────────────────────────
 * Er waren twee plekken die rechtstreeks in `iris_belrij` schreven:
 * `api/iris-actie.js` (de actie `belrij_toevoegen` uit een plan) en
 * `api/iris-belrij.js` (de knop op het scherm). Beide maakten een NIEUWE rij,
 * ook als die persoon er al op stond. Dan staat iemand twee keer op de lijst en
 * wordt hij twee keer gebeld — precies wat taak 6 moest oplossen.
 *
 * Nu: dezelfde SELECT-dan-UPDATE-of-INSERT als de vuller, en de reden komt als
 * regel in `iris_belrij_redenen` te staan met een `hand:`-sleutel. Daardoor
 * staat hij naast de redenen die uit de drie bronnen komen, in plaats van ze te
 * overschrijven.
 *
 * De `hand:`-prefix is ook wat hem beschermt: `vervallenRedenen()` vinkt alleen
 * sleutels af die de vuller beheert, dus een handmatige reden blijft staan tot
 * een mens hem weghaalt.
 *
 * @returns {{belrij_id: string, nieuw: boolean, reden_id: string|null}}
 */
export async function voegHandmatigToe(db, {
  contactId,
  reden = 'handmatig toegevoegd',
  detail = null,
  eigenaar = null,
  prioriteit = 50,
  bron = 'hand',
  nu = new Date(),
} = {}) {
  if (!contactId) throw new Error('belrij zonder contact');

  const { data: bestaand, error: leesFout } = await db
    .from('iris_belrij')
    .select('id, prioriteit, eigenaar')
    .eq('contact_id', contactId)
    .in('status', OPEN_STATUS)
    .order('aangemaakt_op', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (leesFout) throw new Error('belrij lezen: ' + leesFout.message);

  const gevraagd = Number.isFinite(Number(prioriteit)) ? Number(prioriteit) : 50;
  let huidig = bestaand || null;
  let nieuw = false;

  if (!huidig) {
    const gemaakt = await maakOpenRij(db, {
      contact_id: contactId,
      reden: String(reden || 'handmatig toegevoegd').slice(0, 200),
      reden_detail: detail ? String(detail).slice(0, 500) : null,
      eigenaar: eigenaar || null,
      prioriteit: gevraagd,
      bron,
      status: 'open',
    });
    huidig = gemaakt.rij;
    nieuw = gemaakt.nieuw;
  }

  const belrijId = huidig.id;

  // Ook ná een verloren race: de prioriteit en de eigenaar die dit mens
  // meegeeft, horen alsnog op de rij te komen. Anders kost een cron-ronde die
  // er net tussendoor fietste de klik z'n betekenis, en dat is niet te zien.
  if (!nieuw) {
    // Een mens die een rij hoger zet, mag dat. Omlaag niet: dan verdwijnt
    // iemand naar onderen doordat er nóg een reden bij kwam.
    const velden = { bijgewerkt_op: nu.toISOString() };
    const hoogste = Math.max(Number(huidig.prioriteit) || 0, gevraagd);
    if (hoogste !== Number(huidig.prioriteit)) velden.prioriteit = hoogste;
    // Wie expliciet een eigenaar meegeeft, wijst toe — ook als er al iemand
    // staat. Dit is een mens die het zegt, geen regel die het afleidt.
    if (eigenaar) velden.eigenaar = eigenaar;
    const { error } = await db.from('iris_belrij').update(velden).eq('id', belrijId);
    if (error) throw new Error('belrij bijwerken: ' + error.message);
  }

  // De reden erbij. Een eigen sleutel per toevoeging: twee keer met de hand
  // dezelfde persoon toevoegen met een andere reden hoort twee regels te geven,
  // anders overschrijft de tweede de eerste.
  let redenId = null;
  const { data: gezet, error: redenFout } = await db
    .from('iris_belrij_redenen')
    .insert({
      belrij_id: belrijId,
      bron,
      bron_sleutel: `hand:${randomUUID()}`,
      reden: String(reden || 'hand').slice(0, 200),
      reden_detail: detail ? String(detail).slice(0, 500) : null,
      bron_link: null,
    })
    .select('id')
    .single();
  // Fail-soft: staat de migratie nog niet, dan is de rij er wel en de regel
  // niet. De kaart valt dan terug op iris_belrij.reden, zoals vóór taak 6.
  if (redenFout) console.warn('[iris/belrij-vullen] handmatige reden niet opgeslagen:', redenFout.message);
  else redenId = gezet?.id || null;

  return { belrij_id: belrijId, nieuw, reden_id: redenId };
}
