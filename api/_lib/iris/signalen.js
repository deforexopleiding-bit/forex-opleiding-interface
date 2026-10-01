// api/_lib/iris/signalen.js
//
// Wat de mentoren melden, overgenomen uit het LMS.
//
// ── ALLEEN LEZEN ─────────────────────────────────────────────────────────────
// De richting is CRM → LMS voor schrijven, en hier gaat het de andere kant op:
// wij lezen `hlms_signaal` met de sleutel die er al is. Deze module schrijft
// NOOIT naar het LMS. De mentormodule wordt in een andere sessie gebouwd; als
// wij daar iets in zouden zetten, zouden twee sessies dezelfde tabel
// beschrijven zonder van elkaar te weten.
//
// ── DE KOLOMNAMEN ZIJN GEMETEN, NIET BEDACHT (1 oktober 2026) ────────────────
// Deze module vroeg `hlms_signaal` om `created_at`. Die kolom bestaat niet. Het
// gevolg: elke vijf minuten een 400 in de LMS-logs, en Iris heeft NOOIT een
// mentorsignaal binnengekregen. Het heet `aangemaakt_op`, en het type heet
// `soort`.
//
// Er stonden ook drie veldnamen per veld te raden (`type` / `signaal_type`,
// `created_at` / `aangemaakt_op` / `signaal_op`). Dat was verdedigbaar toen de
// mentormodule nog niet bestond. Hij bestaat nu, de kolommen zijn bekend, en
// dan is raden geen voorzichtigheid meer maar een manier om een verkeerde naam
// te verbergen. Vandaar: één naam per veld, en een test die erop staat.
//
// ── DE VLOED DIE WE NIET BINNENLATEN ─────────────────────────────────────────
// `hlms_signaal` had op 1 oktober ~450 rijen, en bijna alles is
// `bron = lms_regel`: signalen die de nachtelijke motor van het LMS zelf maakt
// (59 open `geen_volgende_sessie`, 12 open `factuur_vervallen`). Die horen op
// het hoofdmentorbord in het LMS, want daar worden ze afgehandeld. Zou Iris ze
// overnemen, dan stonden er in één keer ruim honderd kaarten in de Post en was
// de dossierkaart onbruikbaar — en werd hetzelfde werk op twee borden bijgehouden.
//
// `bron = handmatig` is wat een MENS meldde (3 rijen, 1 open). Dat is precies
// waar deze koppeling voor is: een mentor die iets opmerkt wat de motor niet kan
// zien. `bron = crm_cron` komt van ons eigen systeem; die terugslepen zou een
// kringetje zijn.
//
// ── WAAROM HET TYPE VRIJE TEKST IS EN GEEN ENUM ──────────────────────────────
// De opdracht noemt drie types die er nog niet zijn: `uitstel`,
// `reageert_niet`, `halt`. Een CHECK-constraint op deze kolom zou betekenen
// dat de synchronisatie breekt op de dag dat het LMS er een vierde toevoegt —
// en die dag komt, want de mentormodule wordt parallel gebouwd.
//
// Een onbekend type is dus geen fout maar een kaart met een type dat we niet
// kennen. Die komt gewoon in de lijst, en een mens leest hem. Dat is beter dan
// een synchronisatie die stilvalt en waarvan niemand het merkt.
//
// Zie docs/iris/lms-signaalcontract.md voor wat we van het LMS verwachten.
//
// ── ÉÉN RIJ PER BRON-SIGNAAL ─────────────────────────────────────────────────
// `bron_id` is UNIQUE en draagt een voorvoegsel per bronsysteem. De
// synchronisatie mag dus zo vaak draaien als ze wil; een tweede poging botst
// op de constraint en wordt stil overgeslagen.

/** Welke signalen we ophalen en hoe ver terug. */
export const TERUGBLIK_DAGEN = 30;
export const MAX_PER_RONDE = 100;

/**
 * De enige bron die Iris overneemt: wat een mens zelf meldde.
 *
 * De drie bronnen die `hlms_signaal_bron_check` toelaat zijn `lms_regel`,
 * `crm_cron` en `handmatig`. Zie de toelichting bovenaan waarom het alleen de
 * laatste is.
 */
export const LMS_BRON = 'handmatig';

/**
 * De statussen waarin een signaal in het LMS DICHT staat.
 *
 * ── WAAROM DE GESLOTEN KANT EN NIET DE OPEN KANT ────────────────────────────
 * Het LMS heeft `hlms_signaal_open_statussen()` — één functie, zodat de telling
 * en het sluiten daar niet uit elkaar kunnen lopen. Vandaag geeft die
 * ['nieuw','opgepakt','wacht_op_mentor','on_hold','wacht'], en de CHECK laat
 * daarnaast alleen 'afgehandeld' en 'auto_gesloten' toe.
 *
 * Die lijst hier overschrijven zou precies de drift opleveren waar die functie
 * tegen gemaakt is. Daarom filteren we op de GESLOTEN kant, en dat is een
 * bewuste keuze over de richting van het falen:
 *
 *   · Zet het LMS er een nieuwe OPEN status bij en wij noemen de open kant op,
 *     dan valt die status stil weg. Een mentorkaart die nooit aankomt — exact
 *     de bug die deze wijziging repareert.
 *   · Zet het LMS er een nieuwe GESLOTEN status bij, dan komt er een kaart
 *     binnen die al afgehandeld is. Zichtbaar, hinderlijk, en in één klik weg.
 *
 * De tweede fout is de goedkope. Zie docs/iris/lms-signaalcontract.md.
 */
export const LMS_GESLOTEN_STATUSSEN = Object.freeze(['afgehandeld', 'auto_gesloten']);

/** De kolommen die we op hlms_signaal lezen. Alle gemeten op 1 oktober 2026. */
export const SIGNAAL_KOLOMMEN =
  'id, onderwerp, student_id, mentor_id, soort, zwaarte, status, bron, bak, ' +
  'bewijs, eerste_op, laatst_gezien_op, aangemaakt_op';

/** Bouw de bron-sleutel. Eén plek, zodat de twee kanten niet uit elkaar lopen. */
export function bronSleutel(systeem, id) {
  return `${systeem === 'crm' ? 'crm' : 'lms'}:${String(id)}`;
}

/**
 * Wat moet er met dit signaal gebeuren?
 *
 * De vertaling van een signaaltype naar een voorstel. Onbekende types krijgen
 * een neutraal voorstel — "laat een mens kijken" — in plaats van niets. Een
 * kaart zonder voorstel is een kaart waar niemand iets mee doet.
 */
export const VOORSTEL_PER_TYPE = Object.freeze({
  uitstel: {
    voorstel: 'on hold met reden, einddatum schuift mee',
    actie: 'lms_on_hold',
    toelichting: 'Bij ziekte of vakantie schuift de einddatum mee. Bij betaling of geen contact niet.',
  },
  reageert_niet: {
    voorstel: 'op de belrij bij Dave',
    actie: 'belrij_toevoegen',
    toelichting: 'Eerst bellen. Pas na een paar dagen zonder contact een bericht.',
  },
  halt: {
    voorstel: 'stopzetten bespreken — altijd een mens',
    actie: null,
    toelichting: 'Een student die wil stoppen, is een gesprek en geen handeling.',
  },
  no_show: {
    voorstel: 'op de belrij',
    actie: 'belrij_toevoegen',
    toelichting: 'Twee keer niet komen opdagen na elkaar is een signaal, geen toeval.',
  },
  factuur: {
    voorstel: 'dossier nakijken in de Post',
    actie: null,
    toelichting: 'De factuurstand komt al via hlms_crm_factuurstand; dit is de mentor die het opmerkt.',
  },
  taken_niet_gedaan: {
    voorstel: 'op de belrij',
    actie: 'belrij_toevoegen',
    toelichting: 'Een student die zijn taken niet doet, haakt meestal af voordat hij het zelf zegt.',
  },
});

export function voorstelVoor(type) {
  const t = String(type || '').trim().toLowerCase();
  return VOORSTEL_PER_TYPE[t] || {
    voorstel: 'laat een mens kijken',
    actie: null,
    toelichting: `Type "${type || 'onbekend'}" kennen we nog niet. Dat is geen fout — het LMS krijgt er types bij.`,
    onbekend: true,
  };
}

/**
 * Maak van een LMS-rij de vorm die iris_signalen verwacht.
 *
 * ── WAT ER UIT WELKE KOLOM KOMT ─────────────────────────────────────────────
 *   type       ← `soort`          (niet `type`; die kolom bestaat niet)
 *   signaal_op ← `aangemaakt_op`  (niet `created_at`; idem)
 *
 * ── EN WAT ER NIET OP DE RIJ STAAT ──────────────────────────────────────────
 * `hlms_signaal` heeft GEEN toelichting, omschrijving of notitie, en geen
 * mentor_naam. Dat is geen vergetelheid aan LMS-kant:
 *
 *   · De tekst die de mentor schreef ("wat heb je geprobeerd") staat in
 *     `hlms_signaal_gebeurtenis` met soort 'geopend'. Die tabel is ALLEEN
 *     TOEVOEGEN, dus de eerste regel blijft staan wat hij was.
 *   · Er is alleen een `mentor_id` (een auth-uid). De naam staat in
 *     `hlms_personeel.naam`.
 *
 * Allebei worden ze door de aanroeper opgezocht en hier MEEGEGEVEN. Deze functie
 * blijft zuiver: geen opvragingen erin, zodat elke regel na te rekenen is zonder
 * databank. Komt er niets mee, dan is het veld null — en null is eerlijker dan
 * een veld dat uit een kolom komt die niet bestaat.
 */
export function vormSignaal(rij, { systeem = 'dfo_lms', mentorNaam = null, toelichting = null, contactId = null } = {}) {
  const type = String(rij?.soort || 'onbekend').trim().toLowerCase();
  return {
    bron_id: bronSleutel(systeem === 'crm' ? 'crm' : 'lms', rij.id),
    bron_systeem: systeem === 'crm' ? 'crm' : 'dfo_lms',
    contact_id: contactId || null,
    type,
    mentor_naam: mentorNaam || null,
    toelichting: toelichting || null,
    gevraagde_actie: voorstelVoor(type).voorstel,
    // Geen terugval op `new Date()`. Een signaal zonder tijdstempel bestaat niet
    // -- `aangemaakt_op` is NOT NULL in het LMS -- en "nu" invullen zou een
    // kaart van drie weken oud als verse melding tonen.
    signaal_op: rij.aangemaakt_op || null,
  };
}

/** Welke bron-sleutels staan er nog niet in? Hetzelfde verzamelverschil als opname.js. */
export function filterNieuw(rijen, bekende, systeem = 'dfo_lms') {
  const bekend = bekende instanceof Set ? bekende : new Set(bekende || []);
  const uit = [];
  for (const r of (rijen || [])) {
    if (!r || !r.id) continue;
    const sleutel = bronSleutel(systeem === 'crm' ? 'crm' : 'lms', r.id);
    if (bekend.has(sleutel)) continue;
    uit.push(r);
  }
  return uit;
}

/**
 * De naam van de mentor achter een auth-uid.
 *
 * `hlms_signaal.mentor_id` is de auth-uid van wie meldde (de RLS-policy
 * vergelijkt hem met `auth.uid()`), en `hlms_personeel.id` is diezelfde uid --
 * zo joint `hlms_mentorrapport_overzicht` er ook op.
 *
 * Faalt dit, of staat er geen rij, dan blijft de naam leeg. Een kaart zonder
 * naam is bruikbaar; een kaart die er niet is, niet. Dus nooit blokkerend.
 */
export async function haalMentorNamen(lmsClient, ids) {
  const uit = new Map();
  const lijst = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!lijst.length) return uit;
  try {
    const { data, error } = await lmsClient
      .from('hlms_personeel').select('id, naam').in('id', lijst);
    if (error) throw new Error(error.message);
    for (const r of (data || [])) if (r?.id && r.naam) uit.set(String(r.id), r.naam);
  } catch (e) {
    console.warn('[iris/signalen] mentornamen niet gelezen:', e?.message || e);
  }
  return uit;
}

/**
 * De tekst die de mentor erbij schreef.
 *
 * Die staat NIET op het signaal maar op de tijdlijn: `hlms_signaal_gebeurtenis`
 * met soort 'geopend'. Zonder deze opvraging komt er een rode kaart in de Post
 * te staan waarop alleen "start_niet_op" staat -- en dan moet degene die hem
 * leest alsnog in het LMS gaan kijken wat er aan de hand is.
 *
 * De oudste 'geopend'-regel per signaal wint. De tabel is alleen-toevoegen, dus
 * dat is de regel die de melder zelf schreef.
 */
export async function haalOpeningsnotities(lmsClient, signaalIds) {
  const uit = new Map();
  const lijst = [...new Set((signaalIds || []).filter(Boolean).map(String))];
  if (!lijst.length) return uit;
  try {
    const { data, error } = await lmsClient
      .from('hlms_signaal_gebeurtenis')
      .select('signaal_id, soort, tekst, op')
      .in('signaal_id', lijst)
      .eq('soort', 'geopend')
      .order('op', { ascending: true });
    if (error) throw new Error(error.message);
    for (const r of (data || [])) {
      const sleutel = String(r?.signaal_id || '');
      if (!sleutel || !r.tekst) continue;
      if (!uit.has(sleutel)) uit.set(sleutel, String(r.tekst).trim().slice(0, 1000));
    }
  } catch (e) {
    console.warn('[iris/signalen] openingsnotities niet gelezen:', e?.message || e);
  }
  return uit;
}

/**
 * Welk Iris-contact hoort bij welke LMS-student?
 *
 * ── WAAROM DIT ERBIJ MOEST ──────────────────────────────────────────────────
 * `iris_signalen.contact_id` werd nooit gevuld, en de dossierkaart is de ENIGE
 * plek die deze tabel leest -- op `contact_id`. Een signaal zonder contact
 * belandde dus in de databank en verscheen nergens. Alleen de kolomnamen
 * repareren had betekend dat de kaart aankomt en nog steeds onzichtbaar is.
 *
 * De weg loopt via het e-mailadres: `hlms_student.email` naar
 * `iris_contacten.emails`. Bij 0 of meer dan 1 treffer blijft het leeg -- dat is
 * dezelfde regel als bij de telefoon-koppeling: ambiguïteit is geen "kies de
 * eerste". Een kaart aan de verkeerde persoon hangen is erger dan een kaart
 * zonder dossier.
 *
 * Dit zoekt alleen OP. Er wordt geen contact aangemaakt: een student die ons
 * nooit geschreven heeft, hoort geen gespreksdossier te krijgen omdat zijn
 * mentor iets meldde.
 */
export async function haalContactIds(lmsClient, crmDb, studentIds) {
  const uit = new Map();
  const lijst = [...new Set((studentIds || []).filter(Boolean).map(String))];
  if (!lijst.length) return uit;

  let studenten = [];
  try {
    const { data, error } = await lmsClient
      .from('hlms_student').select('id, email').in('id', lijst);
    if (error) throw new Error(error.message);
    studenten = data || [];
  } catch (e) {
    console.warn('[iris/signalen] studenten niet gelezen:', e?.message || e);
    return uit;
  }

  for (const st of studenten) {
    const mail = String(st?.email || '').trim().toLowerCase();
    if (!st?.id || !mail) continue;
    try {
      // limit(2): we hoeven niet te weten HOEVEEL treffers er zijn, alleen of
      // het er meer dan één is.
      const { data, error } = await crmDb
        .from('iris_contacten').select('id').contains('emails', [mail]).limit(2);
      if (error) throw new Error(error.message);
      if ((data || []).length === 1) uit.set(String(st.id), data[0].id);
    } catch (e) {
      console.warn('[iris/signalen] contact zoeken mislukte voor student', st.id, '-', e?.message || e);
    }
  }
  return uit;
}

/**
 * Haal de mentorsignalen op en zet ze klaar.
 *
 * Faalt dit, dan is dat een waarschuwing en geen fout: de rest van de ronde
 * hoort gewoon door te lopen. Een LMS dat even niet bereikbaar is, mag de
 * post niet stilleggen.
 *
 * @returns {Promise<{opgehaald: number, nieuw: number, fout: string|null}>}
 */
export async function haalSignalen({ crmDb, lmsClient, nu = new Date() } = {}) {
  if (!lmsClient) return { opgehaald: 0, nieuw: 0, fout: 'LMS-koppeling niet geconfigureerd' };
  if (!crmDb) return { opgehaald: 0, nieuw: 0, fout: 'geen CRM-client' };

  const sinds = new Date(nu.getTime() - TERUGBLIK_DAGEN * 24 * 3600 * 1000).toISOString();

  try {
    const { data, error } = await lmsClient
      .from('hlms_signaal')
      .select(SIGNAAL_KOLOMMEN)
      // Alleen wat een mens meldde. Zonder deze regel komt de hele oogst van de
      // nachtelijke LMS-motor mee -- ruim honderd open kaarten -- en dan houden
      // twee borden hetzelfde werk bij.
      .eq('bron', LMS_BRON)
      // En alleen wat nog open staat. `status` is NOT NULL in het LMS, dus een
      // kale `not.in` kan hier geen rijen laten wegvallen; bij een kolom die
      // NULL mag zijn zou dat wel gebeuren (NOT (NULL IN (...)) is NULL).
      .not('status', 'in', `(${LMS_GESLOTEN_STATUSSEN.join(',')})`)
      .gte('aangemaakt_op', sinds)
      .order('aangemaakt_op', { ascending: false })
      .limit(MAX_PER_RONDE);
    if (error) throw new Error(error.message);

    const rijen = data || [];
    if (!rijen.length) return { opgehaald: 0, nieuw: 0, fout: null };

    const { data: bestaand, error: bFout } = await crmDb
      .from('iris_signalen')
      .select('bron_id')
      .gte('signaal_op', sinds);
    if (bFout) throw new Error('bestaande signalen: ' + bFout.message);

    const bekend = new Set((bestaand || []).map((r) => r.bron_id));
    const nieuw = filterNieuw(rijen, bekend, 'dfo_lms');
    if (!nieuw.length) return { opgehaald: rijen.length, nieuw: 0, fout: null };

    // Drie opzoekingen voor de hele groep, niet per rij. Alle drie fail-zacht:
    // ze maken een kaart beter leesbaar en vindbaar, en geen van drieën mag de
    // reden zijn dat de kaart er niet komt.
    const [namen, notities, contacten] = await Promise.all([
      haalMentorNamen(lmsClient, nieuw.map((r) => r.mentor_id)),
      haalOpeningsnotities(lmsClient, nieuw.map((r) => r.id)),
      haalContactIds(lmsClient, crmDb, nieuw.map((r) => r.student_id)),
    ]);

    let gelukt = 0;
    for (const r of nieuw) {
      // Per signaal apart. Eén rij die struikelt mag de andere niet meenemen.
      try {
        const rij = vormSignaal(r, {
          mentorNaam: namen.get(String(r.mentor_id || '')) || null,
          toelichting: notities.get(String(r.id)) || null,
          contactId: contacten.get(String(r.student_id || '')) || null,
        });
        const { error: iFout } = await crmDb.from('iris_signalen').insert(rij);
        if (iFout) {
          if (String(iFout.code) === '23505') continue;  // gelijktijdige ronde was ons voor
          throw new Error(iFout.message);
        }
        gelukt++;
      } catch (e) {
        console.error('[iris/signalen] signaal', r.id, 'niet opgeslagen:', e?.message || e);
      }
    }

    return { opgehaald: rijen.length, nieuw: gelukt, fout: null };
  } catch (e) {
    console.error('[iris/signalen] ophalen mislukt:', e?.message || e);
    return { opgehaald: 0, nieuw: 0, fout: e?.message || String(e) };
  }
}
