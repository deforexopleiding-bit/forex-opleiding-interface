// api/_lib/dfo-lms-uitnodiging.js
//
// Uitnodiging voor het nieuwe LMS (dfo-lms). Twee stappen, in deze volgorde:
//
//   STAP 1  POST <basis>/api/admin/studenten/
//           headers: x-dfo-secret + content-type: application/json
//           body:    { email, herkomst: 'crm' }
//           Het CRM heeft de hlms_student-rij zelf al aangemaakt (zie
//           dfo-lms-student.js), dus alleen `email` is verplicht; de rest
//           wordt aan LMS-kant enkel op vorm gecontroleerd.
//
//   STAP 2  POST <basis>/api/admin/studenten/<student-id>/uitnodiging/
//           headers: alleen x-dfo-secret. GEEN body, GEEN content-type.
//           <student-id> komt uit data.student.id van stap 1.
//
// ── DRIE DINGEN DIE HIER FOUT KUNNEN GAAN ────────────────────────────────
//
// 1. AFSLUITENDE SCHUINE STREEP — VERPLICHT.
//    Op het LMS staat `trailingSlash` aan. Een pad zonder afsluitende streep
//    krijgt een 308-omleiding, en veel HTTP-clients (fetch inbegrepen, bij
//    een cross-origin redirect) laten custom headers zoals x-dfo-secret bij
//    zo'n omleiding vallen. Het gevolg is een 403 die NIETS met het geheim
//    te maken heeft en je uren de verkeerde kant op stuurt. Beide paden
//    hieronder eindigen daarom op '/', en bouwUrl() dwingt dat af.
//
// 2. PROGRAMMEER OP `code`, NOOIT op de HTTP-status of op `message`.
//    De statuscode en de tekst zijn niet het contract; het veld `code` in de
//    body wel. Een 200 met een foutcode is mogelijk, en andersom.
//
// 3. DE GRENDEL op data.student.uitnodiging_verstuurd_op.
//    Staat daar een tijdstip, dan is er al gemaild en slaan we stap 2 OVER.
//    Doen we dat niet, dan krijgt de student een tweede mail EN werkt zijn
//    eerste wachtwoord niet meer — schade die je pas hoort als hij belt.
//
// Alles is faalzacht: deze module gooit nooit. Een mislukte uitnodiging mag
// de aanmelding niet raken. Een klant zonder mail is herstelbaar, een
// mislukte aanmelding niet.
//
// Env:
//   DFO_LMS_PUSH_SECRET  gedeeld geheim (Vercel, teamniveau, type Secret).
//                        Wordt NOOIT gelogd — ook niet in foutmeldingen.
//   DFO_LMS_BASE_URL     optioneel; default https://lms.deforexopleiding.nl

const STANDAARD_BASIS = 'https://lms.deforexopleiding.nl';
const TIMEOUT_MS = 10000;

// Stap 1 — codes die betekenen "het account staat er, ga door".
// `gekoppeld_aan_bestaande_rij` is ons normale geval: het CRM maakte de
// hlms_student-rij al aan.
const STAP1_OK = new Set([
  'aangemaakt',
  'gekoppeld_aan_bestaande_rij',
  'gekoppeld_aan_bestaand_account',
  'bestaat_al',
]);

// Stap 1 — het account staat er, maar een vervolgstap aan LMS-kant mislukte.
// data.auth_id zegt om welk account het gaat; opnieuw proberen koppelt daaraan.
// Geen uitnodiging sturen: we weten niet of het dossier compleet is.
const STAP1_HALF = 'half_aangemaakt';

// Stap 2 — de twee foutcodes die WEZENLIJK verschillen.
//   mail_mislukt  → er is NIETS veranderd. Het oude wachtwoord van de student
//                   werkt door. Veilig om opnieuw te proberen.
//   mail_verstuurd_wachtwoord_niet_gezet
//                 → de mail is de deur uit MET een wachtwoord dat niet werkt.
//                   De student kan er nu NIET in. Opnieuw versturen is geen
//                   optie maar een noodzaak.
export const MAIL_MISLUKT = 'mail_mislukt';
export const MAIL_VERSTUURD_WACHTWOORD_NIET_GEZET = 'mail_verstuurd_wachtwoord_niet_gezet';

// Stabiele voorvoegsels voor dfo_lms_provision_error, zodat het detailscherm
// de twee gevallen exact uit elkaar kan houden zonder op Nederlandse tekst te
// moeten matchen.
export const FOUT_PREFIX_HERSTELBAAR = 'UITNODIGING_MAIL_MISLUKT:';
export const FOUT_PREFIX_ACTIE_VEREIST = 'UITNODIGING_WACHTWOORD_NIET_GEZET:';

function basisUrl() {
  return (process.env.DFO_LMS_BASE_URL || STANDAARD_BASIS).trim().replace(/\/+$/, '');
}

/**
 * Bouwt een URL en dwingt de afsluitende schuine streep af — zie punt 1 in
 * de kop. Nooit een pad samenstellen zonder deze helper.
 */
export function bouwUrl(pad) {
  const p = String(pad || '').replace(/^\/+/, '');
  const met = p.endsWith('/') ? p : p + '/';
  return basisUrl() + '/' + met;
}

/** Leest het geheim. Retourneert null wanneer het niet gezet is. */
function geheim() {
  const s = (process.env.DFO_LMS_PUSH_SECRET || '').trim();
  return s || null;
}

/**
 * Eén HTTP-aanroep naar het LMS. Retourneert altijd een object, gooit nooit.
 * Het geheim komt alleen in de header terecht en nergens in de log.
 */
async function bel(url, { body = null } = {}) {
  const secret = geheim();
  if (!secret) return { ok: false, netwerkfout: 'DFO_LMS_PUSH_SECRET ontbreekt' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { 'x-dfo-secret': secret };
    // Stap 2 stuurt bewust GEEN body en GEEN content-type mee.
    if (body !== null) headers['content-type'] = 'application/json';

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual', // een 308 mag NOOIT stil gevolgd worden: zie punt 1.
      signal: ctrl.signal,
    });

    if (resp.status === 307 || resp.status === 308 || resp.status === 301 || resp.status === 302) {
      return {
        ok: false,
        netwerkfout: 'omleiding ' + resp.status + ' op ' + url
          + ' — pad mist waarschijnlijk de afsluitende schuine streep',
      };
    }

    let json = null;
    try { json = await resp.json(); } catch { json = null; }
    return { ok: true, status: resp.status, json };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
    return { ok: false, netwerkfout: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stuur de LMS-uitnodiging voor één klant.
 *
 * @param {{ email: string }} arg
 * @returns {Promise<{
 *   ok: boolean,
 *   verstuurd?: boolean,        // stap 2 daadwerkelijk uitgevoerd
 *   overgeslagen?: boolean,     // grendel: er was al eerder gemaild
 *   student_id?: string|null,
 *   uitnodiging_verstuurd_op?: string|null,
 *   code?: string|null,         // laatste code van het LMS
 *   actie_vereist?: boolean,    // mail eruit, wachtwoord niet gezet
 *   herstelbaar?: boolean,      // veilig opnieuw te proberen
 *   fout?: string|null,
 * }>}
 */
export async function stuurLmsUitnodiging({ email }) {
  const mail = String(email || '').trim().toLowerCase();
  if (!mail) return { ok: false, fout: 'e-mailadres ontbreekt' };
  if (!geheim()) {
    // Configuratie-toestand van de omgeving, geen fout van deze klant.
    return { ok: false, overgeslagen: true, fout: 'DFO_LMS_PUSH_SECRET ontbreekt' };
  }

  // ── STAP 1 — account en dossier ─────────────────────────────────────────
  const r1 = await bel(bouwUrl('/api/admin/studenten/'), {
    body: { email: mail, herkomst: 'crm' },
  });
  if (!r1.ok) return { ok: false, fout: 'stap 1: ' + r1.netwerkfout };

  const code1 = r1.json?.code ? String(r1.json.code) : null;
  const data1 = r1.json?.data || {};
  const student = data1.student || null;
  const studentId = student?.id ? String(student.id) : null;
  const alGemaild = student?.uitnodiging_verstuurd_op || null;

  if (code1 === STAP1_HALF) {
    // Account bestaat, maar het dossier is niet compleet. Geen uitnodiging:
    // opnieuw proberen koppelt aan het account uit data.auth_id.
    return {
      ok: false, code: code1, student_id: studentId, herstelbaar: true,
      fout: 'stap 1: half_aangemaakt (auth_id=' + (data1.auth_id || 'onbekend')
        + ') — opnieuw proberen koppelt aan dat account',
    };
  }
  if (!code1 || !STAP1_OK.has(code1)) {
    return {
      ok: false, code: code1, student_id: studentId,
      fout: 'stap 1: onverwachte code ' + JSON.stringify(code1),
    };
  }

  // ── DE GRENDEL ──────────────────────────────────────────────────────────
  // Er is al eerder gemaild. Stap 2 nogmaals doen zou de student een tweede
  // mail bezorgen én zijn bestaande wachtwoord ongeldig maken.
  if (alGemaild) {
    return {
      ok: true, overgeslagen: true, verstuurd: false,
      student_id: studentId, uitnodiging_verstuurd_op: alGemaild, code: code1,
    };
  }

  if (!studentId) {
    return { ok: false, code: code1, fout: 'stap 1: geen data.student.id in het antwoord' };
  }

  // ── STAP 2 — de welkomstmail ────────────────────────────────────────────
  const r2 = await bel(
    bouwUrl('/api/admin/studenten/' + encodeURIComponent(studentId) + '/uitnodiging/'),
    // Bewust geen body: dan gaat er ook geen content-type mee.
  );
  if (!r2.ok) {
    // Netwerkfout: we weten niet of er gemaild is. Behandelen als het
    // gevaarlijke geval is te streng; als herstelbaar is te optimistisch.
    // We melden het onbeslist en laten de mens beslissen.
    return {
      ok: false, student_id: studentId,
      fout: 'stap 2: ' + r2.netwerkfout + ' — onbekend of er gemaild is, controleer in het LMS',
    };
  }

  const code2 = r2.json?.code ? String(r2.json.code) : null;

  if (code2 === MAIL_VERSTUURD_WACHTWOORD_NIET_GEZET) {
    return {
      ok: false, student_id: studentId, code: code2, actie_vereist: true,
      fout: FOUT_PREFIX_ACTIE_VEREIST
        + ' de mail is verstuurd met een wachtwoord dat niet werkt. De student'
        + ' kan nu NIET inloggen — opnieuw versturen is vereist.',
    };
  }
  if (code2 === MAIL_MISLUKT) {
    return {
      ok: false, student_id: studentId, code: code2, herstelbaar: true,
      fout: FOUT_PREFIX_HERSTELBAAR
        + ' de mail is niet verstuurd. Er is niets veranderd en het bestaande'
        + ' wachtwoord werkt door — veilig om opnieuw te proberen.',
    };
  }

  // Elke andere code beschouwen we als geslaagd, maar we geven 'm wél terug
  // zodat een onbekende uitkomst zichtbaar is in plaats van weggemoffeld.
  return { ok: true, verstuurd: true, student_id: studentId, code: code2 };
}
