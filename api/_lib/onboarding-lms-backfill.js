// api/_lib/onboarding-lms-backfill.js
//
// DE inhaalslag-logica. Eén implementatie, twee ingangen.
//
// ── WAAROM DIT EEN LIB IS ─────────────────────────────────────────────────
// Deze inhaalslag zat eerst alleen achter `CRON_SECRET`, en dat betekende dat
// iemand met een sleutel een commando moest typen. Zo werkt het hier niet:
// Maxim werkt met knoppen. Een geheim in een terminal is precies de plek waar
// het misgaat.
//
// Daarom staat de logica hier en zijn er twee dunne ingangen:
//   - `api/onboarding-lms-backfill-run.js` — de KNOP. Ingelogde admin,
//     dezelfde rechtencontrole als de rest van de adminschermen.
//   - `api/cron/onboarding-lms-backfill.js` — het cron-pad met het geheim.
//     Blijft bestaan voor later; het is niet wat wij gebruiken.
//
// Beide ingangen roepen dezelfde functie aan met dezelfde regels. Er is geen
// tweede implementatie die kan afwijken.
//
// ── ER GAAT GEEN ENKELE MAIL UIT. DAT IS BEWEZEN, NIET BEWEERD ───────────
// `tests/onboarding-lms-backfill-geen-post.test.js` rekent de VOLLEDIGE
// import-afsluiting van DIT bestand uit — en die van allebei de ingangen —
// en valt om zodra daar iets in opduikt dat een uitgaande verbinding kan
// maken. De uitnodiging leeft in `api/_lib/dfo-lms-uitnodiging.js` en wordt
// hier niet geïmporteerd.
//
// ── DROOGLOOP IS DE STANDAARD ────────────────────────────────────────────
// `uitvoeren` staat standaard uit. Uitvoeren vraagt bovendien de twee
// getallen uit de droogloop (`bevestigKoppel`, `bevestigMaak`); kloppen die
// niet exact, dan gebeurt er niets. Zo bestaat er geen weg waarlangs
// uitgevoerd wordt zonder dat de droogloop eerst is uitgerekend en getoond.
//
// ── KOPPELEN IS IETS ANDERS DAN AANMAKEN ─────────────────────────────────
// Van de 22 lopende onboardings zonder koppeling bestaan er ZESTIEN al als
// hlms_student (imported_from_bubble, met auth-account). Die worden
// vastgeknoopt, niet aangemaakt. Bij koppelen wordt PRECIES één kolom
// aangeraakt: `crm_onboarding_id`. Naam, traject en aantal calls komen uit de
// Bubble-migratie en worden niet overschreven.
//
// ── IDEMPOTENT ───────────────────────────────────────────────────────────
// Twee keer draaien verandert niets extra: na de eerste ronde heeft elke
// verwerkte onboarding een `dfo_lms_student_id` en valt hij uit de
// kandidaten-selectie. De tweede droogloop toont dan 0 en 0.
//
// ── TESTRIJEN DOEN NIET MEE ──────────────────────────────────────────────
// `onboardings.is_test` EN `customers.is_test`, en die check staat vóór alle
// andere besluiten.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { provisionDfoLmsStudent, koppelBestaandeStudent } from './dfo-lms-student.js';
import { spiegelNaActie, SPIEGEL_GESCHREVEN } from './onboarding-spiegel.js';

// 24 lopende onboardings vandaag; deze grens is er tegen een runaway, niet
// tegen groei. Wordt hij geraakt, dan staat dat zichtbaar in de uitkomst.
const CAP = 200;

/** Naam-vergelijking: kleine letters, dubbele spaties weg. Geen fuzzy-matching. */
function normaliseerNaam(voor, achter) {
  return [voor, achter].filter(Boolean).join(' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Draai de inhaalslag.
 *
 * @param {{uitvoeren?: boolean, bevestigKoppel?: number, bevestigMaak?: number,
 *          door?: string}} opties
 *   `door` is alleen voor de logregel: wie drukte er op de knop.
 * @returns {Promise<{status: number, result: object}>}
 */
export async function draaiLmsBackfill(opties = {}) {
  const wilUitvoeren   = opties.uitvoeren === true;
  const bevestigKoppel = Number(opties.bevestigKoppel);
  const bevestigMaak   = Number(opties.bevestigMaak);
  const door           = opties.door || 'onbekend';

  const result = {
    ok: true,
    modus: wilUitvoeren ? 'UITVOEREN' : 'droogloop',
    door,
    // Expliciet in de uitkomst, zodat niemand hoeft te vertrouwen op een
    // belofte in een commit-tekst.
    verstuurt_mail: false,
    bekeken: 0,
    // Koppelen en aanmaken apart geteld — het zijn verschillende dingen.
    zou_koppelen: 0, gekoppeld: 0,
    zou_aanmaken: 0, aangemaakt: 0,
    overgeslagen_al_gekoppeld: 0, overgeslagen_naam_treffer: 0,
    overgeslagen_geen_email: 0, overgeslagen_testrij: 0, mislukt: 0,
    // De spiegel apart van de koppeling: die twee kunnen los van elkaar
    // lukken en mislukken, en dat moet in de uitkomst te zien zijn.
    spiegel_geschreven: 0, spiegel_mislukt: 0,
    geraakte_limiet: 0,
    rijen: [], errors: [],
  };

  try {
    const lms = getDfoLmsClient();
    if (!lms) {
      result.ok = false;
      result.error = 'DFO_LMS_SUPABASE_URL/KEY ontbreekt';
      return { status: 502, result };
    }

    // ── 1) De kandidaten: lopend, geen LMS-student ──────────────────────
    const { data: obs, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, customer_name, traject_id, status, start_date, mentor_user_id, is_test')
      .neq('status', 'geannuleerd')
      .is('archived_at', null)
      .is('dfo_lms_student_id', null)
      // Testrijen doen NIET mee. Zie de kop: de testonboarding stond er in de
      // eerste versie gewoon tussen.
      .eq('is_test', false)
      .order('start_date', { ascending: true, nullsFirst: false })
      .limit(CAP + 1);
    if (obErr) throw new Error('onboardings lezen: ' + obErr.message);

    let kandidaten = obs || [];
    if (kandidaten.length > CAP) {
      result.geraakte_limiet = kandidaten.length - CAP;
      kandidaten = kandidaten.slice(0, CAP);
    }
    result.bekeken = kandidaten.length;
    if (kandidaten.length === 0) return { status: 200, result };

    // ── 2) De bijbehorende klanten, trajecten en mentoren ───────────────
    const klantIds   = [...new Set(kandidaten.map((o) => o.customer_id).filter(Boolean))];
    const trajectIds = [...new Set(kandidaten.map((o) => o.traject_id).filter(Boolean))];
    const mentorIds  = [...new Set(kandidaten.map((o) => o.mentor_user_id).filter(Boolean))];

    const [klanten, trajecten, mentoren] = await Promise.all([
      (async () => {
        if (klantIds.length === 0) return new Map();
        const { data, error } = await supabaseAdmin
          .from('customers').select('id, first_name, last_name, email, is_test').in('id', klantIds);
        if (error) throw new Error('customers lezen: ' + error.message);
        return new Map((data || []).map((r) => [r.id, r]));
      })(),
      (async () => {
        if (trajectIds.length === 0) return new Map();
        const { data, error } = await supabaseAdmin
          .from('onboarding_trajecten').select('id, label, type').in('id', trajectIds);
        if (error) throw new Error('trajecten lezen: ' + error.message);
        return new Map((data || []).map((r) => [r.id, r]));
      })(),
      (async () => {
        if (mentorIds.length === 0) return new Map();
        const { data, error } = await supabaseAdmin
          .from('team_members').select('user_id, name, email').in('user_id', mentorIds);
        if (error) throw new Error('team_members lezen: ' + error.message);
        return new Map((data || []).map((r) => [r.user_id, r]));
      })(),
    ]);

    // ── 3) Wat staat er AL in het LMS ───────────────────────────────────
    // In één keer ophalen in plaats van per rij: 300 rijen is niets, en zo
    // kunnen we ook op naam vergelijken zonder N bevragingen.
    const { data: lmsRijen, error: lmsErr } = await lms
      .from('hlms_student')
      .select('id, email, voornaam, achternaam, crm_onboarding_id, mentor_id, herkomst');
    if (lmsErr) throw new Error('hlms_student lezen: ' + lmsErr.message);

    const lmsOpEmail      = new Map();
    const lmsOpOnboarding = new Map();
    const lmsOpNaam       = new Map();
    for (const r of (lmsRijen || [])) {
      const e = String(r.email || '').trim().toLowerCase();
      if (e) lmsOpEmail.set(e, r);
      if (r.crm_onboarding_id) lmsOpOnboarding.set(String(r.crm_onboarding_id), r);
      const n = normaliseerNaam(r.voornaam, r.achternaam);
      if (n) {
        if (!lmsOpNaam.has(n)) lmsOpNaam.set(n, []);
        lmsOpNaam.get(n).push(r);
      }
    }

    // ── 4) Per kandidaat: wat zou er gebeuren ───────────────────────────
    for (const ob of kandidaten) {
      const klant   = klantIds.length ? klanten.get(ob.customer_id) : null;
      const traject = trajecten.get(ob.traject_id) || null;
      const mentor  = mentoren.get(ob.mentor_user_id) || null;
      const email   = String(klant?.email || '').trim().toLowerCase() || null;
      const naam    = normaliseerNaam(klant?.first_name, klant?.last_name)
                   || String(ob.customer_name || '').toLowerCase().trim();

      const alOpOnboarding = lmsOpOnboarding.get(String(ob.id)) || null;
      const alOpEmail      = email ? (lmsOpEmail.get(email) || null) : null;
      // Naam-treffers met een ANDER adres — de dubbele-klant-vraag.
      const naamTreffers = (lmsOpNaam.get(naam) || [])
        .filter((r) => String(r.email || '').trim().toLowerCase() !== email);

      let besluit;
      if (klant?.is_test === true)      besluit = 'overslaan_testrij';
      else if (alOpOnboarding)          besluit = 'al_gekoppeld';
      // Bestaat er een rij op dit e-mailadres, dan is dat GEEN reden om over
      // te slaan maar de reden om te KOPPELEN. Zestien van de tweeëntwintig
      // zitten in dit geval.
      else if (alOpEmail)               besluit = 'zou_koppelen';
      else if (!email)                  besluit = 'overslaan_geen_email';
      else if (naamTreffers.length > 0) besluit = 'overslaan_naam_treffer';
      else                              besluit = 'zou_aanmaken';

      const regel = {
        onboarding_id : ob.id,
        naam          : ob.customer_name || [klant?.first_name, klant?.last_name].filter(Boolean).join(' ') || null,
        email,
        status        : ob.status,
        start_datum   : ob.start_date || null,
        traject       : traject ? (traject.label || traject.type || null) : null,
        mentor        : mentor ? (mentor.name || mentor.email || null) : null,
        besluit,
        bestaat_op_onboarding : alOpOnboarding ? alOpOnboarding.id : null,
        bestaat_op_email      : alOpEmail ? alOpEmail.id : null,
        naam_treffers         : naamTreffers.map((r) => ({ id: r.id, email: r.email })),
      };

      // OPEN VRAAG, bewust niet zelf beantwoord. Bij koppelen raken we alleen
      // crm_onboarding_id aan, dus een LMS-rij zonder mentor blijft zonder
      // mentor — ook als het CRM er wél een weet. Dat staat hier zodat Maxim
      // per klant kan zien of dat erg is, in plaats van dat een script het
      // stilletjes invult.
      if (besluit === 'zou_koppelen') {
        regel.lms_mentor_leeg  = !alOpEmail?.mentor_id;
        regel.crm_kent_mentor  = !!ob.mentor_user_id;
      }

      if      (besluit === 'zou_aanmaken')            result.zou_aanmaken++;
      else if (besluit === 'zou_koppelen')            result.zou_koppelen++;
      else if (besluit === 'overslaan_naam_treffer')  result.overgeslagen_naam_treffer++;
      else if (besluit === 'overslaan_geen_email')    result.overgeslagen_geen_email++;
      else if (besluit === 'overslaan_testrij')       result.overgeslagen_testrij++;
      else                                            result.overgeslagen_al_gekoppeld++;

      result.rijen.push(regel);
    }

    // ── 5) Uitvoeren? Alleen met het juiste getal erbij ─────────────────
    if (!wilUitvoeren) return { status: 200, result };

    const koppelOk = Number.isInteger(bevestigKoppel) && bevestigKoppel === result.zou_koppelen;
    const maakOk    = Number.isInteger(bevestigMaak)   && bevestigMaak   === result.zou_aanmaken;
    if (!koppelOk || !maakOk) {
      result.ok = false;
      result.error = 'bevestiging klopt niet: droogloop zegt '
        + result.zou_koppelen + ' te koppelen en ' + result.zou_aanmaken
        + ' aan te maken; aanroep zegt koppelen=' + (Number.isFinite(bevestigKoppel) ? bevestigKoppel : '(niets)')
        + ' en aanmaken=' + (Number.isFinite(bevestigMaak) ? bevestigMaak : '(niets)')
        + '. Draai eerst de droogloop en geef beide getallen mee.';
      return { status: 409, result };
    }

    for (const regel of result.rijen) {
      const koppelen = regel.besluit === 'zou_koppelen';
      const maken    = regel.besluit === 'zou_aanmaken';
      if (!koppelen && !maken) continue;

      try {
        // Twee verschillende acties, en de logregel zegt welke het was. Een
        // gekoppelde klant en een nieuw aangemaakte klant zien er in de
        // databank straks hetzelfde uit; in het logboek niet.
        const uit = koppelen
          ? await koppelBestaandeStudent(regel.onboarding_id, regel.bestaat_op_email)
          : await provisionDfoLmsStudent(regel.onboarding_id);

        if (uit?.ok) {
          if (koppelen) { result.gekoppeld++;  regel.uitkomst = 'gekoppeld aan bestaande rij ' + regel.bestaat_op_email; }
          else          { result.aangemaakt++; regel.uitkomst = 'nieuwe studentrij aangemaakt'; }
          console.log('[lms-backfill/' + door + '] ' + (koppelen ? 'GEKOPPELD' : 'AANGEMAAKT') + ' — '
            + (regel.naam || 'zonder naam') + ' <' + (regel.email || 'geen adres') + '> '
            + 'onboarding=' + regel.onboarding_id
            + (koppelen ? (' student=' + regel.bestaat_op_email) : ''));

          // De spiegelvelden bijwerken. Die staan in hlms_crm_onboarding en
          // NIET op hlms_student, dus dit raakt de Bubble-waarden niet aan.
          //
          // DE UITKOMST TELT MEE. spiegelNaActie() is faalzacht en schreef
          // zijn reden alleen naar de log. Op 10 september 2026 stond de
          // spiegel daardoor op NUL rijen terwijl deze knop 23 koppelingen
          // als geslaagd rapporteerde: de koppeling lukte, de spiegel faalde,
          // en van buiten zag dat er identiek uit. Een knop die "gelukt" zegt
          // over werk dat maar half gebeurd is, is erger dan geen knop.
          const sp = await spiegelNaActie(regel.onboarding_id, 'lms-backfill');
          if (sp?.resultaat === SPIEGEL_GESCHREVEN) {
            result.spiegel_geschreven++;
            regel.spiegel = 'geschreven';
          } else {
            result.spiegel_mislukt++;
            regel.spiegel = 'MISLUKT: ' + (sp?.fout || sp?.resultaat || 'onbekend');
            if (result.errors.length < 20) {
              result.errors.push({
                onboarding_id: regel.onboarding_id,
                error: 'spiegel niet geschreven: ' + (sp?.fout || sp?.resultaat || 'onbekend'),
              });
            }
          }
        } else {
          result.mislukt++;
          regel.uitkomst = (koppelen ? 'koppelen' : 'aanmaken') + ' mislukt: '
            + (uit?.error || uit?.reason || 'onbekend');
          console.error('[lms-backfill/' + door + '] ' + regel.uitkomst + ' — onboarding=' + regel.onboarding_id);
          if (result.errors.length < 20) {
            result.errors.push({ onboarding_id: regel.onboarding_id, error: regel.uitkomst });
          }
        }
      } catch (e) {
        result.mislukt++;
        regel.uitkomst = (koppelen ? 'koppelen' : 'aanmaken') + ' mislukt: ' + (e?.message || e);
        console.error('[lms-backfill] rij mislukt', regel.onboarding_id, e?.message || e);
        if (result.errors.length < 20) {
          result.errors.push({ onboarding_id: regel.onboarding_id, error: e?.message || String(e) });
        }
      }
    }

    return { status: 200, result };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[lms-backfill]', msg);
    result.ok = false;
    result.error = msg;
    return { status: 500, result };
  }
}
