// api/iris-actie.js
//
// Eén stap uitvoeren.
//
//   POST { actie: 'klaarzetten',    opdracht_id?, contact_id?, type, parameters, idempotentie? }
//   POST { actie: 'uitvoeren',      id }
//   POST { actie: 'annuleren',      id }
//   POST { actie: 'plan_uitvoeren', opdracht_id, gesprek_id?, contact_id? }
//
// Recht: iris.post.beantwoorden voor klaarzetten, per type een eigen recht
// voor uitvoeren (zie RECHT_PER_TYPE).
//
// ── ÉÉN PLEK WAAR IETS ÉCHT GEBEURT ──────────────────────────────────────────
// De opdracht-module maakt plannen, de post-module maakt concepten, maar
// uitvoeren gebeurt alleen hier. Dat is geen ordelijkheid om de ordelijkheid:
// het betekent dat er precies één plaats is waar de rechten, de idempotentie
// en het logboek geregeld zijn. Twee plekken zouden betekenen dat de tweede de
// eerste na een half jaar stilletjes achterna hinkt.
//
// ── WAAROM plan_uitvoeren HIER STAAT EN NIET BIJ DE OPDRACHT ─────────────────
// Een opdracht komt met een plan van meerdere stappen, en tot nu toe was dat
// plan onuitvoerbaar: iris-opdracht maakte alleen de plan-jsonb en nooit een
// iris_acties-rij, en het scherm had geen knop die hiernaartoe wees. Je kreeg
// een plan te zien, met status "Wacht op jouw akkoord", en er was niets om op
// te drukken.
//
// Dat gat dichten kon op twee manieren. Het scherm per stap twee keer laten
// aankloppen (klaarzetten, dan uitvoeren) zou werken, maar dan ligt de
// volgorde, de halve mislukking en het afsluiten van de opdracht bij de
// browser — en een browser die halverwege wegklikt laat dan een opdracht
// achter waarvan niemand weet hoe ver hij kwam.
//
// Dus één aanroep, hier, in het bestand dat de rechten per staptype en de
// idempotentie al bewaakt. Eén plek waar iets écht gebeurt blijft eén plek.
//
// ── DE IDEMPOTENTIESLEUTEL ───────────────────────────────────────────────────
// UNIQUE op iris_acties. Een dubbele klik botst erop, en dat vangen we op als
// "al gedaan" met de bestaande rij terug. Dat is het enige waterdichte
// antwoord op dubbelklikken — een uitgeschakelde knop niet, want het eerste
// verzoek kan al onderweg zijn.
//
// De sleutel wordt gebouwd uit wat de stap UNIEK maakt, niet uit een
// toevalsgetal. Anders zou elke klik een nieuwe sleutel geven en beschermt de
// constraint nergens tegen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { STAPTYPES, NIET_VIA_OPDRACHT, verloopRegel } from './_lib/iris/opdracht.js';
import { voegHandmatigToe } from './_lib/iris/belrij-vullen.js';
import { haalHerkenningspunten, telefoonVormen, naamUit } from './_lib/iris/doel.js';
import { bouwOpvolging } from './_lib/iris/opvolging.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Welk recht welke stap vereist.
 *
 * Niet alles is even zwaar. Iemand op de belrij zetten is een notitie; iemands
 * toegang verlengen raakt wat een klant kan. Daarom per type een eigen sleutel
 * in plaats van één grove poort.
 */
export const RECHT_PER_TYPE = Object.freeze({
  wa_versturen: 'iris.versturen',
  mail_versturen: 'iris.versturen',
  lms_toegang_verlengen: 'iris.lms.acties',
  lms_uitnodiging: 'iris.lms.acties',
  lms_on_hold: 'iris.lms.acties',
  belofte_vastleggen: 'iris.post.beantwoorden',
  afbetalingsplan: 'iris.post.beantwoorden',
  taak_aanmaken: 'iris.post.beantwoorden',
  belrij_toevoegen: 'iris.belrij',
  factuur_nakijken: 'iris.post.beantwoorden',
  opvolging_instellen: 'iris.post.beantwoorden',
});

/**
 * Bouw een idempotentiesleutel uit wat een stap uniek maakt.
 *
 * Geen tijdstempel en geen toevalsgetal: die zouden elke klik uniek maken en
 * dan beschermt de constraint nergens tegen. Wel de dag erin, want dezelfde
 * stap morgen opnieuw doen is een geldige handeling.
 */
export function bouwSleutel({ type, contactId, opdrachtId, parameters, op = new Date() }) {
  const dag = op.toISOString().slice(0, 10);
  const kern = [
    type,
    contactId || 'geen-contact',
    opdrachtId || 'los',
    dag,
    stabielJson(parameters),
  ].join('|');
  return kern.slice(0, 400);
}

/** JSON met gesorteerde sleutels, zodat dezelfde inhoud dezelfde tekst geeft. */
function stabielJson(o) {
  if (!o || typeof o !== 'object') return String(o ?? '');
  if (Array.isArray(o)) return '[' + o.map(stabielJson).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => `${k}:${stabielJson(o[k])}`).join(',') + '}';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Alleen POST' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });

  const actie = String(req.body?.actie || '').trim();

  try {
    if (actie === 'klaarzetten') return await klaarzetten(req, res, user);
    if (actie === 'uitvoeren') return await uitvoeren(req, res, user);
    if (actie === 'annuleren') return await annuleren(req, res, user);
    if (actie === 'plan_uitvoeren') return await planUitvoeren(req, res, user);
    return res.status(400).json({ error: `onbekende actie: ${actie || '(leeg)'}` });
  } catch (e) {
    console.error('[iris-actie]', actie, e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// ── Klaarzetten ──────────────────────────────────────────────────────────────

async function klaarzetten(req, res, user) {
  if (!(await requirePermission(req, 'iris.post.beantwoorden'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.post.beantwoorden)' });
  }

  const type = String(req.body?.type || '').trim();
  if (!STAPTYPES.includes(type)) {
    return res.status(400).json({ error: `onbekend type: ${type || '(leeg)'}`, toegestaan: STAPTYPES });
  }
  const contactId = String(req.body?.contact_id || '').trim() || null;
  const opdrachtId = String(req.body?.opdracht_id || '').trim() || null;
  if (contactId && !UUID_RE.test(contactId)) return res.status(400).json({ error: 'contact_id moet een geldige uuid zijn' });
  if (opdrachtId && !UUID_RE.test(opdrachtId)) return res.status(400).json({ error: 'opdracht_id moet een geldige uuid zijn' });

  const parameters = (req.body?.parameters && typeof req.body.parameters === 'object' && !Array.isArray(req.body.parameters))
    ? req.body.parameters : {};
  const sleutel = String(req.body?.idempotentie || '').trim()
    || bouwSleutel({ type, contactId, opdrachtId, parameters });

  const uit = await zetKlaar({ type, contactId, opdrachtId, parameters, sleutel });
  return res.status(200).json({ actie: uit.actie, al_gedaan: uit.al_gedaan });
}

/**
 * Eén stap als rij neerzetten.
 *
 * Apart van het endpoint omdat plan_uitvoeren hem ook nodig heeft, en twee
 * inserts met elk hun eigen behandeling van de unieke sleutel is precies hoe
 * de tweede na een half jaar anders gaat werken dan de eerste.
 *
 * @returns {Promise<{actie: object, al_gedaan: boolean}>}
 */
async function zetKlaar({ type, contactId = null, opdrachtId = null, parameters = {}, sleutel }) {
  const key = sleutel || bouwSleutel({ type, contactId, opdrachtId, parameters });
  const { data, error } = await supabaseAdmin
    .from('iris_acties')
    .insert({
      opdracht_id: opdrachtId,
      contact_id: contactId,
      type,
      parameters,
      status: 'klaar',
      idempotentie: key,
    })
    .select('*')
    .single();

  if (!error) return { actie: data, al_gedaan: false };

  if (String(error.code) === '23505') {
    // Al klaargezet. Dat is geen fout: de gebruiker wilde deze stap, en die
    // staat er. Geef de bestaande rij terug zodat het scherm "✓ gedaan" kan
    // tonen met een verwijzing naar wat er al is.
    const { data: bestaand } = await supabaseAdmin
      .from('iris_acties').select('*').eq('idempotentie', key).maybeSingle();
    return { actie: bestaand, al_gedaan: true };
  }
  throw new Error('actie opslaan: ' + error.message);
}

// ── Uitvoeren ────────────────────────────────────────────────────────────────

async function uitvoeren(req, res, user) {
  const id = String(req.body?.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });

  const { data: actie, error } = await supabaseAdmin
    .from('iris_acties').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('actie: ' + error.message);
  if (!actie) return res.status(404).json({ error: 'Stap niet gevonden' });

  const recht = RECHT_PER_TYPE[actie.type];
  if (!recht || !(await requirePermission(req, recht))) {
    return res.status(403).json({ error: `Geen rechten (${recht || 'onbekend type'})` });
  }

  // De claim. Van klaar/goedgekeurd naar uitgevoerd lukt één keer. Zou dit een
  // gewone update zijn, dan kon dezelfde stap bij een samenloop twee keer
  // gedaan worden — en twee keer toegang verlengen is twee keer zo lang.
  const geclaimd = await claimStap(id, user);
  if (!geclaimd) {
    return res.status(409).json({
      error: 'Deze stap is al opgepakt',
      status: actie.status,
      uitleg: actie.status === 'uitgevoerd' ? 'Hij is al uitgevoerd.' : `Status is "${actie.status}".`,
    });
  }

  const uit = await doeStap(geclaimd, user);
  if (uit.ok) return res.status(200).json({ ok: true, resultaat: uit.resultaat });
  return res.status(502).json({ error: 'Stap mislukt', uitleg: uit.fout });
}

/**
 * Een geclaimde stap daadwerkelijk doen, en de uitkomst wegschrijven.
 *
 * Gooit NIET: een stap die misgaat is een uitkomst, geen uitzondering. Dat is
 * wat plan_uitvoeren nodig heeft — daar mag één mislukte stap de rest van het
 * plan niet meesleuren (de les uit CLAUDE.md over lussen).
 *
 * @returns {Promise<{ok: true, resultaat: object} | {ok: false, fout: string}>}
 */
async function doeStap(geclaimd, user) {
  try {
    const resultaat = await voerUit(geclaimd, user);
    await supabaseAdmin.from('iris_acties').update({ resultaat, fout: null }).eq('id', geclaimd.id);
    await logStap(user, geclaimd, 'ok', null);
    return { ok: true, resultaat };
  } catch (e) {
    const tekst = e?.message || String(e);
    console.error('[iris-actie] uitvoeren mislukt:', geclaimd.type, tekst);
    // Terug naar 'mislukt', niet naar 'klaar'. Anders blijft iets wat
    // structureel niet kan, eindeloos opnieuw geprobeerd worden.
    await supabaseAdmin
      .from('iris_acties')
      .update({ status: 'mislukt', fout: tekst.slice(0, 500) })
      .eq('id', geclaimd.id);
    await logStap(user, geclaimd, 'mislukt', tekst);
    return { ok: false, fout: tekst };
  }
}

/** Claim één stap van klaar/goedgekeurd naar uitgevoerd. Null als een ander 'm had. */
async function claimStap(id, user) {
  const { data, error } = await supabaseAdmin
    .from('iris_acties')
    .update({ status: 'uitgevoerd', uitgevoerd_op: new Date().toISOString(), uitgevoerd_door: user.id })
    .eq('id', id)
    .in('status', ['klaar', 'goedgekeurd'])
    .select('*')
    .maybeSingle();
  if (error) throw new Error('claim: ' + error.message);
  return data || null;
}

async function annuleren(req, res, user) {
  if (!(await requirePermission(req, 'iris.post.beantwoorden'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.post.beantwoorden)' });
  }
  const id = String(req.body?.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });

  const { data, error } = await supabaseAdmin
    .from('iris_acties')
    .update({ status: 'geannuleerd' })
    .eq('id', id)
    .in('status', ['klaar', 'goedgekeurd'])
    .select('id, status')
    .maybeSingle();
  if (error) throw new Error('annuleren: ' + error.message);
  if (!data) return res.status(409).json({ error: 'Deze stap is niet meer te annuleren' });
  return res.status(200).json({ ok: true });
}

/**
 * Welke staptypes zonder doel niet kunnen.
 *
 * Niet verzonnen maar afgelezen uit voerUit(): die gooit er zelf op
 * ("belofte zonder contact", "belrij zonder contact", en bouwOpvolging()
 * weigert een opvolging zonder gesprek of contact, want die zou ALTIJD afgaan).
 * lms_toegang_verlengen zoekt de student op via het contact, tenzij het
 * student_id al in de parameters staat.
 *
 * Deze lijst bestaat om de weigering VOORAF te doen in plaats van halverwege.
 * Een plan van drie stappen waarvan de tweede omvalt op een ontbrekend doel,
 * laat een opdracht achter die half gedaan is — en dat is erger dan een plan
 * dat niet begint en zegt waarom.
 */
const DOEL_NODIG = Object.freeze(['belofte_vastleggen', 'belrij_toevoegen', 'opvolging_instellen']);

/** Standen waarin een opdracht niets meer hoort uit te voeren. */
const OPDRACHT_KLAAR = Object.freeze(['geregeld', 'afgebroken']);

/**
 * Zoek het gesprek waar deze stap op slaat.
 *
 * ── DE VOLGORDE IS DE HELE VEILIGHEID ────────────────────────────────────────
 * Eerst op e-mailadres of telefoonnummer uit de plantekst: die zijn uniek
 * genoeg om zeker van te zijn. Pas als die er niet in staan, op naam — en een
 * naam is nooit genoeg om op te handelen, want twee studenten kunnen Jan
 * Jansen heten.
 *
 * ── WAAROM OP GESPREK EN NIET OP CONTACT ─────────────────────────────────────
 * In productie bestaan dubbele contacten: dezelfde persoon, hetzelfde adres,
 * twee rijen, allebei in hetzelfde gesprek. Tellen op contacten zou daar "twee
 * treffers, dus vragen" van maken terwijl het één en dezelfde draad is. Tellen
 * op gesprekken geeft er één, en dat is ook wat de opvolging nodig heeft
 * (waarop = 'gesprek' is het scherpste spoor dat er is).
 *
 * Nul of meer dan één gesprek is GEEN uitkomst om op te handelen. Dan is het
 * een vraag, en kiest een mens. Er wordt ook nooit een contact aangemaakt: dat
 * zou een persoon verzinnen op grond van een stuk tekst.
 *
 * @returns {Promise<{gesprekId: string|null, hoe: string, kandidaten: number}>}
 */
async function zoekDoelGesprek({ wie, vraag, omschrijving }) {
  const { emails, telefoons } = haalHerkenningspunten(wie, vraag, omschrijving);

  /** Van contact-ids naar de gesprekken eronder, ontdubbeld. */
  const gesprekkenVan = async (contactIds) => {
    if (!contactIds.length) return [];
    const { data, error } = await supabaseAdmin
      .from('iris_gesprekken')
      .select('id')
      .in('contact_id', contactIds)
      .limit(25);
    if (error) throw new Error('gesprekken zoeken: ' + error.message);
    return [...new Set((data || []).map((g) => g.id))];
  };

  /** Contacten op een arraykolom die een van deze waarden bevat. */
  const contactenOp = async (kolom, waarden) => {
    if (!waarden.length) return [];
    const { data, error } = await supabaseAdmin
      .from('iris_contacten')
      .select('id')
      .overlaps(kolom, waarden)
      .limit(25);
    if (error) throw new Error(`contacten op ${kolom}: ` + error.message);
    return (data || []).map((c) => c.id);
  };

  // 1. e-mail
  if (emails.length) {
    const ids = await contactenOp('emails', emails);
    const g = await gesprekkenVan(ids);
    if (g.length === 1) return { gesprekId: g[0], hoe: 'email', kandidaten: 1 };
    if (g.length > 1) return { gesprekId: null, hoe: 'email', kandidaten: g.length };
  }

  // 2. telefoon
  if (telefoons.length) {
    const vormen = [...new Set(telefoons.flatMap((t) => telefoonVormen(t)))];
    const ids = await contactenOp('telefoons', vormen);
    const g = await gesprekkenVan(ids);
    if (g.length === 1) return { gesprekId: g[0], hoe: 'telefoon', kandidaten: 1 };
    if (g.length > 1) return { gesprekId: null, hoe: 'telefoon', kandidaten: g.length };
  }

  // 3. naam — alleen als er geen adres en geen nummer was
  const naam = naamUit(wie);
  if (naam) {
    const { data, error } = await supabaseAdmin
      .from('iris_contacten')
      .select('id')
      .ilike('weergavenaam', `%${naam}%`)
      .limit(25);
    if (error) throw new Error('contacten op naam: ' + error.message);
    const g = await gesprekkenVan((data || []).map((c) => c.id));
    if (g.length === 1) return { gesprekId: g[0], hoe: 'naam', kandidaten: 1 };
    return { gesprekId: null, hoe: 'naam', kandidaten: g.length };
  }

  return { gesprekId: null, hoe: 'niets', kandidaten: 0 };
}

/**
 * Het hele plan van een opdracht uitvoeren.
 *
 * ── WAT HIER NIET GEBEURT: GOKKEN OP WIE ─────────────────────────────────────
 * Het plan noemt mensen zoals een mens dat doet ("Andy De Landtsheer
 * (andy@dl-interieur.be)"), niet bij uuid — een taalmodel kent geen sleutels.
 * De eerste treffer op een naam pakken is precies het soort stille vergissing
 * die je pas ontdekt als er een opvolging op de verkeerde persoon loopt.
 *
 * Dus: het doel komt van de AANROEPER mee (gesprek_id of contact_id), óf het
 * wordt gezocht volgens zoekDoelGesprek() — eerst op adres of nummer, dan op
 * naam, en altijd met de eis dat het naar precies ÉÉN gesprek leidt. Nul of
 * meer: 409 met de vraag erbij, en het scherm laat kiezen. Er wordt dan nog
 * niets klaargezet, en er wordt nooit een contact aangemaakt.
 *
 * ── VOLGORDE: EERST KEUREN, DAN DOEN ─────────────────────────────────────────
 * Alle stappen worden eerst nagekeken (bestaat het type, mag deze medewerker
 * het, is er een doel als het nodig is). Pas als alles door die poort is, gaat
 * de eerste stap draaien. Een plan dat halverwege op een rechtenfout stukloopt
 * laat de klant met een halve afspraak zitten.
 *
 * ── EN DAARNA MAG ÉÉN STAP MISGAAN ───────────────────────────────────────────
 * Technisch misgaan kan altijd (het LMS ligt eruit, een datum is onzin). Dan
 * blijft de opdracht op wacht_op_ok staan met de fout per stap zichtbaar, en
 * is "nog eens proberen" een geldige handeling: de idempotentiesleutel bevat de
 * dag, dus een geslaagde stap wordt niet dubbel gedaan.
 */
async function planUitvoeren(req, res, user) {
  const opdrachtId = String(req.body?.opdracht_id || '').trim();
  if (!UUID_RE.test(opdrachtId)) return res.status(400).json({ error: 'opdracht_id moet een geldige uuid zijn' });

  const gesprekId = String(req.body?.gesprek_id || '').trim() || null;
  const contactIdIn = String(req.body?.contact_id || '').trim() || null;
  if (gesprekId && !UUID_RE.test(gesprekId)) return res.status(400).json({ error: 'gesprek_id moet een geldige uuid zijn' });
  if (contactIdIn && !UUID_RE.test(contactIdIn)) return res.status(400).json({ error: 'contact_id moet een geldige uuid zijn' });

  const { data: opdracht, error: oFout } = await supabaseAdmin
    .from('iris_opdrachten')
    .select('id, status, plan, na_uitvoeren, verloop')
    .eq('id', opdrachtId)
    .maybeSingle();
  if (oFout) throw new Error('opdracht: ' + oFout.message);
  if (!opdracht) return res.status(404).json({ error: 'Opdracht niet gevonden' });
  if (OPDRACHT_KLAAR.includes(String(opdracht.status))) {
    return res.status(409).json({ error: 'Deze opdracht is afgesloten', status: opdracht.status });
  }

  const plan = opdracht.plan && typeof opdracht.plan === 'object' && !Array.isArray(opdracht.plan)
    ? opdracht.plan : null;
  const stappen = Array.isArray(plan?.stappen) ? plan.stappen : [];
  if (plan?.vraag) {
    return res.status(409).json({
      error: 'vraag_open',
      uitleg: 'Iris heeft eerst een vraag. Beantwoord die; daarna staat het plan vast.',
      vraag: plan.vraag,
    });
  }
  if (!stappen.length) {
    return res.status(409).json({ error: 'geen_stappen', uitleg: 'Er staat geen enkele stap in dit plan.' });
  }

  // Een contact uit het meegegeven gesprek, zodat het scherm kan volstaan met
  // het gesprek dat je toch al open had.
  let contactId = contactIdIn;
  if (!contactId && gesprekId) {
    const { data: g } = await supabaseAdmin
      .from('iris_gesprekken').select('contact_id').eq('id', gesprekId).maybeSingle();
    contactId = g?.contact_id || null;
  }

  // ── Poort 1: het type ──────────────────────────────────────────────────────
  for (const stap of stappen) {
    const type = String(stap?.type || '');
    if (!STAPTYPES.includes(type)) {
      return res.status(422).json({
        error: 'onbekende_stap',
        uitleg: `Het plan bevat een stap die niet bestaat: ${type || '(leeg)'}.`,
      });
    }
    if (NIET_VIA_OPDRACHT.includes(type)) {
      return res.status(422).json({
        error: 'stap_niet_via_opdracht',
        uitleg: `De stap "${type}" loopt niet via een opdracht. Versturen gaat via de Post.`,
        type,
      });
    }
  }

  // ── Poort 2: de rechten, per staptype ──────────────────────────────────────
  for (const stap of stappen) {
    const recht = RECHT_PER_TYPE[String(stap.type)];
    if (!recht || !(await requirePermission(req, recht))) {
      return res.status(403).json({ error: `Geen rechten (${recht || 'onbekend type'})`, type: stap.type });
    }
  }

  // ── Poort 3: het doel ──────────────────────────────────────────────────────
  // Kwam er geen gesprek mee, dan mag ik er één zoeken — maar alleen op een
  // e-mailadres of telefoonnummer uit de plantekst, en alleen als dat naar
  // precies één gesprek leidt. Zie zoekDoelGesprek() voor waarom.
  let doelGesprek = gesprekId;
  let doelHoe = gesprekId ? 'meegegeven' : null;
  for (const stap of stappen) {
    const type = String(stap.type);
    if (!DOEL_NODIG.includes(type)) continue;
    if (contactId || doelGesprek || stap?.parameters?.gesprek_id) continue;

    const gevonden = await zoekDoelGesprek({
      wie: stap?.wie,
      vraag: opdracht.vraag,
      omschrijving: stap?.omschrijving || stap?.parameters?.omschrijving,
    });
    if (gevonden.gesprekId) {
      doelGesprek = gevonden.gesprekId;
      doelHoe = gevonden.hoe;
      continue;
    }
    return res.status(409).json({
      error: 'doel_onbekend',
      uitleg: gevonden.kandidaten > 1
        ? `Deze stap past bij ${gevonden.kandidaten} gesprekken. Open het juiste gesprek en druk daar op Uitvoeren.`
        : 'Ik vind geen gesprek bij deze persoon. Open het juiste gesprek en druk daar op Uitvoeren.',
      type,
      wie: stap?.wie || null,
      gezocht_op: gevonden.hoe,
      kandidaten: gevonden.kandidaten,
    });
  }

  // ── Doen ───────────────────────────────────────────────────────────────────
  const uitkomsten = [];
  for (const stap of stappen) {
    const type = String(stap.type);
    // Try per stap: één stap die omvalt mag de rest niet meesleuren.
    try {
      const parameters = (stap?.parameters && typeof stap.parameters === 'object' && !Array.isArray(stap.parameters))
        ? { ...stap.parameters } : {};
      if (type === 'opvolging_instellen' && doelGesprek && !parameters.gesprek_id) {
        parameters.gesprek_id = doelGesprek;
      }
      if (!parameters.omschrijving && stap?.omschrijving) parameters.omschrijving = String(stap.omschrijving);

      const gezet = await zetKlaar({ type, contactId, opdrachtId, parameters });
      if (!gezet.actie) {
        uitkomsten.push({ type, ok: false, fout: 'stap kon niet worden klaargezet' });
        continue;
      }
      if (gezet.al_gedaan && gezet.actie.status === 'uitgevoerd') {
        // Vandaag al gedaan. Dat is geen fout en ook geen tweede keer doen.
        uitkomsten.push({ type, ok: true, al_gedaan: true, actie_id: gezet.actie.id });
        continue;
      }

      const geclaimd = await claimStap(gezet.actie.id, user);
      if (!geclaimd) {
        uitkomsten.push({ type, ok: false, al_opgepakt: true, fout: `stap staat op "${gezet.actie.status}"` });
        continue;
      }
      const gedaan = await doeStap(geclaimd, user);
      uitkomsten.push(gedaan.ok
        ? { type, ok: true, actie_id: geclaimd.id, resultaat: gedaan.resultaat }
        : { type, ok: false, actie_id: geclaimd.id, fout: gedaan.fout });
    } catch (e) {
      const tekst = e?.message || String(e);
      console.error('[iris-actie] plan_uitvoeren stap mislukt:', opdrachtId, type, tekst);
      uitkomsten.push({ type, ok: false, fout: tekst });
    }
  }

  // ── De opdracht bijwerken ──────────────────────────────────────────────────
  // Alles gelukt? Dan is de opdracht uitgevoerd, of hij wacht nog op een
  // antwoord van de klant (dat zegt na_uitvoeren). Ging er iets mis, dan blijft
  // hij op wacht_op_ok staan: er is nog werk, en dan hoort hij in de werkbak te
  // blijven staan in plaats van er afgerond uit te zien.
  const mislukt = uitkomsten.filter((u) => !u.ok);
  const nieuweStatus = mislukt.length
    ? 'wacht_op_ok'
    : (opdracht.na_uitvoeren === 'wacht' ? 'wacht_op_antwoord' : 'uitgevoerd');

  const regel = mislukt.length
    ? `uitgevoerd: ${uitkomsten.length - mislukt.length} van ${uitkomsten.length} gelukt`
    : `uitgevoerd: ${uitkomsten.length} stap(pen)`;

  const { data: bijgewerkt, error: bFout } = await supabaseAdmin
    .from('iris_opdrachten')
    .update({
      status: nieuweStatus,
      verloop: [
        ...(Array.isArray(opdracht.verloop) ? opdracht.verloop : []),
        verloopRegel(regel, {
        wie: user.id,
        details: {
          gelukt: uitkomsten.length - mislukt.length,
          mislukt: mislukt.length,
          // Hoe het gesprek gevonden is, staat erbij. Anders is later niet na
          // te gaan of een opvolging op de juiste persoon loopt.
          ...(doelHoe ? { gesprek_gevonden_op: doelHoe } : {}),
        },
      }),
      ],
      bijgewerkt_op: new Date().toISOString(),
    })
    .eq('id', opdrachtId)
    .select('*')
    .single();
  if (bFout) throw new Error('opdracht bijwerken: ' + bFout.message);

  return res.status(200).json({
    ok: mislukt.length === 0,
    opdracht: bijgewerkt,
    stappen: uitkomsten,
    gelukt: uitkomsten.length - mislukt.length,
    mislukt: mislukt.length,
  });
}

// ── Wat elke stap doet ───────────────────────────────────────────────────────

async function voerUit(actie, user) {
  const p = actie.parameters || {};

  switch (actie.type) {
    case 'belofte_vastleggen': {
      if (!actie.contact_id) throw new Error('belofte zonder contact');
      if (!p.datum) throw new Error('belofte zonder datum');
      const { data: contact } = await supabaseAdmin
        .from('iris_contacten').select('customer_id').eq('id', actie.contact_id).maybeSingle();
      const { data, error } = await supabaseAdmin
        .from('iris_beloftes')
        .insert({
          contact_id: actie.contact_id,
          customer_id: contact?.customer_id || null,
          factuur_ids: Array.isArray(p.factuur_ids) ? p.factuur_ids : [],
          bedrag: p.bedrag != null ? Number(p.bedrag) : null,
          datum: p.datum,
          bron: ['klant', 'maxim', 'dave', 'iris'].includes(p.bron) ? p.bron : 'iris',
          notitie: p.notitie || null,
          aangemaakt_door: user.id,
        })
        .select('id, datum, bedrag')
        .single();
      if (error) throw new Error('belofte opslaan: ' + error.message);
      return { belofte_id: data.id, datum: data.datum, bedrag: data.bedrag };
    }

    case 'belrij_toevoegen': {
      // De poort blijft hier staan, ook al gooit voegHandmatigToe() zelf ook.
      // DOEL_NODIG wordt tegen DEZE regels afgelezen: staat de eis alleen nog
      // in de helper, dan kan niemand -- toets noch lezer -- meer zien dat
      // belrij_toevoegen een doel nodig heeft.
      if (!actie.contact_id) throw new Error('belrij zonder contact');
      // Deed een gewone INSERT en maakte dus een TWEEDE rij als die persoon er
      // al op stond. Nu langs hetzelfde pad als de vuller: één rij per persoon,
      // de reden erbij als regel.
      const uit = await voegHandmatigToe(supabaseAdmin, {
        contactId: actie.contact_id,
        reden: p.reden || 'handmatig toegevoegd',
        detail: p.detail || null,
        eigenaar: p.eigenaar || null,
        prioriteit: p.prioriteit,
        bron: ['wanbetaler', 'onboarding', 'mentorsignaal', 'geen_reactie', 'hand'].includes(p.bron) ? p.bron : 'hand',
      });
      return { belrij_id: uit.belrij_id, nieuw: uit.nieuw };
    }

    case 'lms_toegang_verlengen': {
      const client = getDfoLmsClient();
      if (!client) throw new Error('LMS-koppeling niet geconfigureerd');
      const dagen = Number(p.dagen);
      if (!Number.isInteger(dagen) || dagen < 1 || dagen > 365) {
        throw new Error('dagen moet tussen 1 en 365 liggen');
      }
      const studentId = p.student_id || (await zoekStudent(client, actie.contact_id));
      if (!studentId) throw new Error('geen student gevonden');

      const { data: student, error: lFout } = await client
        .from('hlms_student').select('id, eind_datum').eq('id', studentId).maybeSingle();
      if (lFout) throw new Error('student lezen: ' + lFout.message);
      if (!student) throw new Error('student niet gevonden');

      // Verlengen gaat altijd vooruit vanaf de HUIDIGE einddatum, of vanaf
      // vandaag als die al verstreken is. Vooruit vanaf een verlopen datum zou
      // betekenen dat iemand die drie maanden geleden afliep, na een verlenging
      // van twee weken nog steeds geen toegang heeft.
      const nu = new Date();
      const huidig = student.eind_datum ? new Date(student.eind_datum + 'T00:00:00') : nu;
      const basis = huidig.getTime() > nu.getTime() ? huidig : nu;
      const nieuw = new Date(basis.getTime() + dagen * 24 * 3600 * 1000);
      const nieuweDatum = nieuw.toISOString().slice(0, 10);

      const { error: sFout } = await client
        .from('hlms_student').update({ eind_datum: nieuweDatum }).eq('id', studentId);
      if (sFout) throw new Error('einddatum zetten: ' + sFout.message);

      return { student_id: studentId, was: student.eind_datum, wordt: nieuweDatum, dagen };
    }

    case 'factuur_nakijken': {
      // Iris zet NOOIT een factuur op betaald. Ze maakt er een taak van voor
      // een mens, in het bestaande takenbakje.
      const { data, error } = await supabaseAdmin
        .from('pending_actions')
        .insert({
          action_type: 'MANUAL_VERIFY_PAYMENT',
          status: 'PENDING',
          invoice_id: p.factuur_id || null,
          payload: {
            source: 'iris',
            iris_actie_id: actie.id,
            toelichting: p.toelichting || 'Klant zegt betaald te hebben.',
          },
        })
        .select('id')
        .single();
      if (error) throw new Error('taak aanmaken: ' + error.message);
      return { taak_id: data.id };
    }

    case 'taak_aanmaken': {
      const { data, error } = await supabaseAdmin
        .from('pending_actions')
        .insert({
          action_type: 'MANUAL_FOLLOWUP',
          status: 'PENDING',
          payload: {
            source: 'iris',
            iris_actie_id: actie.id,
            omschrijving: String(p.omschrijving || 'Taak vanuit Iris').slice(0, 500),
          },
        })
        .select('id')
        .single();
      if (error) throw new Error('taak aanmaken: ' + error.message);
      return { taak_id: data.id };
    }

    case 'opvolging_instellen': {
      // ── WAAROM DIT GEEN taak_aanmaken IS ──────────────────────────────
      // taak_aanmaken zette één regel in pending_actions: een omschrijving,
      // en verder niets. Geen datum, geen bewaking, geen bericht. Er werd om
      // drie dingen gevraagd en er gebeurde er nul van.
      //
      // Een opvolging legt alle drie vast, en cron-iris-opvolging kijkt
      // dagelijks of er iets binnenkwam.

      // Het adres wordt HIER vastgelegd, niet bij het melden opgezocht. Wie de
      // opvolging vroeg, krijgt het bericht -- ook als zijn rol of zijn plek
      // in de organisatie intussen veranderd is.
      const { data: profiel } = await supabaseAdmin
        .from('profiles').select('email').eq('id', user.id).maybeSingle();

      // Waarop gewacht wordt. Een gesprek is het scherpste spoor; staat dat er
      // niet bij, dan het contact, want daar hangen alle gesprekken onder.
      let gesprekId = p.gesprek_id || null;
      if (!gesprekId && actie.contact_id) {
        const { data: laatste } = await supabaseAdmin
          .from('iris_gesprekken')
          .select('id')
          .eq('contact_id', actie.contact_id)
          .order('laatste_inbound', { ascending: false, nullsFirst: false })
          .limit(1);
        gesprekId = laatste?.[0]?.id || null;
      }

      const gebouwd = bouwOpvolging({
        opdrachtId: actie.opdracht_id || null,
        actieId: actie.id,
        gesprekId,
        contactId: actie.contact_id || null,
        omschrijving: p.omschrijving || 'Opvolging vanuit Iris',
        dagen: p.dagen,
        verwittigEmail: profiel?.email || null,
        verwittigWie: user.id,
        aangemaaktDoor: user.id,
      });
      if (!gebouwd.ok) throw new Error(gebouwd.fout);

      const { data, error } = await supabaseAdmin
        .from('iris_opvolgingen')
        .insert(gebouwd.rij)
        .select('id, tot, waarop')
        .single();
      if (error) throw new Error('opvolging opslaan: ' + error.message);
      return { opvolging_id: data.id, tot: data.tot, waarop: data.waarop };
    }

    // Verzenden en de overige LMS-stappen komen in een volgende stap. Ze
    // staan hier uitdrukkelijk als "nog niet", zodat er geen stap is die
    // stilletjes niets doet en er in het scherm uitziet alsof hij lukte.
    case 'wa_versturen':
    case 'mail_versturen':
      throw new Error('Versturen loopt via de Post, niet via deze stap.');

    case 'lms_uitnodiging':
    case 'lms_on_hold':
    case 'afbetalingsplan':
      throw new Error(`Stap "${actie.type}" is nog niet ingebouwd.`);

    default:
      throw new Error(`Onbekend staptype: ${actie.type}`);
  }
}

async function zoekStudent(client, contactId) {
  if (!contactId) return null;
  const { data: contact } = await supabaseAdmin
    .from('iris_contacten').select('hlms_student_id, emails').eq('id', contactId).maybeSingle();
  if (contact?.hlms_student_id) return contact.hlms_student_id;
  const emails = (contact?.emails || []).map((e) => String(e).toLowerCase());
  if (!emails.length) return null;
  const { data } = await client.from('hlms_student').select('id').in('email', emails).limit(2);
  // Bij twee studenten op hetzelfde adres kiezen we er geen. Toegang verlengen
  // van de verkeerde persoon is niet terug te draaien zonder dat iemand het merkt.
  return (data || []).length === 1 ? data[0].id : null;
}

async function logStap(user, actie, resultaat, fout) {
  const { error } = await supabaseAdmin.from('iris_log').insert({
    wie: user.id,
    wat: `stap uitgevoerd: ${actie.type}`,
    contact_id: actie.contact_id,
    resultaat,
    fout: fout ? String(fout).slice(0, 500) : null,
    details: { actie_id: actie.id, opdracht_id: actie.opdracht_id },
  });
  if (error) console.warn('[iris-actie] logregel mislukt:', error.message);
}
