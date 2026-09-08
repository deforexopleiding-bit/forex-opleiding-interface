// api/cron/onboarding-lms-backfill.js
//
// EENMALIGE INHAALSLAG: studentrijen aanmaken in het LMS voor onboardings die
// er nog geen hebben.
//
// ── WAAROM DIT ER IS ──────────────────────────────────────────────────────
// Gemeten 7 september 2026: van de 24 lopende onboardings hebben er maar TWEE
// een `dfo_lms_student_id`. Provisioning was per klant een operator-vinkje en
// dat is zelden aangezet. Zonder inhaalslag ziet elke mentor morgen een leeg
// blok terwijl er elf klanten mét mentor op hem wachten — precies het lege
// scherm waar dit hele spoor over gaat.
//
// ── ER GAAT GEEN ENKELE MAIL UIT. DAT IS BEWEZEN, NIET BEWEERD ───────────
// Dit bestand roept `provisionDfoLmsStudent()` aan en verder niets. De
// uitnodiging is een aparte functie in een apart bestand
// (`api/_lib/dfo-lms-uitnodiging.js`) die hier NIET geïmporteerd wordt.
//
// `tests/onboarding-lms-backfill-geen-post.test.js` rekent de VOLLEDIGE
// import-afsluiting van dit bestand uit — alles wat het rechtstreeks of via
// via binnenhaalt — en valt om zodra daar een mail-, uitnodigings- of
// wachtwoordmodule in opduikt. Die test is er niet om vandaag gerust te
// stellen maar om te voorkomen dat iemand hier over een half jaar een
// `stuurLmsUitnodiging()` bij zet.
//
// ── DROOGLOOP IS DE STANDAARD ────────────────────────────────────────────
// Zonder parameters doet deze taak NIETS. Uitvoeren vraagt twee dingen:
//   ?uitvoeren=ja&aantal=<N>
// waarbij N exact het getal moet zijn dat de droogloop als `zou_aanmaken`
// gaf. Klopt dat niet, dan weigert hij. Zo kan niemand dit per ongeluk
// aanzetten en kan er niets veranderd zijn tussen kijken en doen.
//
// ── DUBBELE KLANTEN ──────────────────────────────────────────────────────
// Er is een klant die in beide systemen onder twee verschillende adressen
// staat. De droogloop meldt daarom per rij drie dingen:
//   - `bestaat_op_onboarding` : er is al een LMS-rij aan deze onboarding
//                               gekoppeld (crm_onboarding_id);
//   - `bestaat_op_email`      : er is een LMS-rij met dit e-mailadres;
//   - `naam_treffers`         : LMS-rijen met dezelfde naam maar een ANDER
//                               adres. Dat is geen automatische blokkade maar
//                               een waarschuwing voor een mens: op naam
//                               matchen is raden, en raden is precies wat we
//                               hier niet doen.
// Rijen met een naam-treffer worden bij uitvoeren OVERGESLAGEN. Wil je die
// alsnog, dan koppel je 'm met de hand — dat is een besluit, geen script.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder. Geen user-sessie:
// dit is geen knop in een scherm en hoort dat ook niet te zijn.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from '../_lib/dfo-lms-db.js';
import { provisionDfoLmsStudent } from '../_lib/dfo-lms-student.js';

// 24 lopende onboardings vandaag; deze grens is er tegen een runaway, niet
// tegen groei. Wordt hij geraakt, dan staat dat zichtbaar in de uitkomst.
const CAP = 200;

/** Naam-vergelijking: kleine letters, dubbele spaties weg. Geen fuzzy-matching. */
function normaliseerNaam(voor, achter) {
  return [voor, achter].filter(Boolean).join(' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const wilUitvoeren = String(req.query?.uitvoeren || '') === 'ja';
  const bevestigd    = Number(req.query?.aantal);

  const result = {
    ok: true,
    modus: wilUitvoeren ? 'UITVOEREN' : 'droogloop',
    // Expliciet in de uitkomst, zodat niemand hoeft te vertrouwen op een
    // belofte in een commit-tekst.
    verstuurt_mail: false,
    bekeken: 0, zou_aanmaken: 0, aangemaakt: 0,
    overgeslagen_bestaat_al: 0, overgeslagen_naam_treffer: 0,
    overgeslagen_geen_email: 0, mislukt: 0,
    geraakte_limiet: 0,
    rijen: [], errors: [],
  };

  try {
    const lms = getDfoLmsClient();
    if (!lms) {
      result.ok = false;
      result.error = 'DFO_LMS_SUPABASE_URL/KEY ontbreekt';
      return res.status(502).json(result);
    }

    // ── 1) De kandidaten: lopend, geen LMS-student ──────────────────────
    const { data: obs, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, customer_name, traject_id, status, start_date, mentor_user_id')
      .neq('status', 'geannuleerd')
      .is('archived_at', null)
      .is('dfo_lms_student_id', null)
      .order('start_date', { ascending: true, nullsFirst: false })
      .limit(CAP + 1);
    if (obErr) throw new Error('onboardings lezen: ' + obErr.message);

    let kandidaten = obs || [];
    if (kandidaten.length > CAP) {
      result.geraakte_limiet = kandidaten.length - CAP;
      kandidaten = kandidaten.slice(0, CAP);
    }
    result.bekeken = kandidaten.length;
    if (kandidaten.length === 0) return res.status(200).json(result);

    // ── 2) De bijbehorende klanten, trajecten en mentoren ───────────────
    const klantIds   = [...new Set(kandidaten.map((o) => o.customer_id).filter(Boolean))];
    const trajectIds = [...new Set(kandidaten.map((o) => o.traject_id).filter(Boolean))];
    const mentorIds  = [...new Set(kandidaten.map((o) => o.mentor_user_id).filter(Boolean))];

    const [klanten, trajecten, mentoren] = await Promise.all([
      (async () => {
        if (klantIds.length === 0) return new Map();
        const { data, error } = await supabaseAdmin
          .from('customers').select('id, first_name, last_name, email').in('id', klantIds);
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
      .select('id, email, voornaam, achternaam, crm_onboarding_id');
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
      if (alOpOnboarding)        besluit = 'bestaat_al_op_onboarding';
      else if (alOpEmail)        besluit = 'bestaat_al_op_email';
      else if (!email)           besluit = 'overslaan_geen_email';
      else if (naamTreffers.length > 0) besluit = 'overslaan_naam_treffer';
      else                       besluit = 'zou_aanmaken';

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

      if (besluit === 'zou_aanmaken')                 result.zou_aanmaken++;
      else if (besluit === 'overslaan_naam_treffer')  result.overgeslagen_naam_treffer++;
      else if (besluit === 'overslaan_geen_email')    result.overgeslagen_geen_email++;
      else                                            result.overgeslagen_bestaat_al++;

      result.rijen.push(regel);
    }

    // ── 5) Uitvoeren? Alleen met het juiste getal erbij ─────────────────
    if (!wilUitvoeren) return res.status(200).json(result);

    if (!Number.isInteger(bevestigd) || bevestigd !== result.zou_aanmaken) {
      result.ok = false;
      result.error = 'bevestiging klopt niet: droogloop zegt ' + result.zou_aanmaken
        + ' aan te maken, aanroep zegt ' + (req.query?.aantal ?? '(niets)')
        + '. Draai eerst de droogloop en geef dat getal mee als ?aantal=.';
      return res.status(409).json(result);
    }

    for (const regel of result.rijen) {
      if (regel.besluit !== 'zou_aanmaken') continue;
      try {
        // Dit is de ENIGE schrijfactie in dit bestand, en hij maakt een
        // studentrij aan. Geen uitnodiging, geen wachtwoord, geen bericht.
        const uit = await provisionDfoLmsStudent(regel.onboarding_id);
        if (uit?.ok) {
          result.aangemaakt++;
          regel.uitkomst = 'aangemaakt';
        } else {
          result.mislukt++;
          regel.uitkomst = 'mislukt: ' + (uit?.error || uit?.reason || 'onbekend');
          if (result.errors.length < 20) {
            result.errors.push({ onboarding_id: regel.onboarding_id, error: regel.uitkomst });
          }
        }
      } catch (e) {
        result.mislukt++;
        regel.uitkomst = 'mislukt: ' + (e?.message || e);
        console.error('[lms-backfill] rij mislukt', regel.onboarding_id, e?.message || e);
        if (result.errors.length < 20) {
          result.errors.push({ onboarding_id: regel.onboarding_id, error: e?.message || String(e) });
        }
      }
    }

    return res.status(200).json(result);
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[lms-backfill]', msg);
    result.ok = false;
    result.error = msg;
    return res.status(500).json(result);
  }
}
