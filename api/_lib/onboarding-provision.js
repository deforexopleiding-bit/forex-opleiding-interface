// api/_lib/onboarding-provision.js
//
// Fase 2 — Bubble-provisioning voor een onboarding-student.
// Aangeroepen vanuit /api/onboarding-create (na succesvolle insert) en
// vanuit /api/onboarding-provision-retry (na een eerdere fail). Splitst
// de flow in twee stappen:
//
//   STAP A — account: workflow 'create_student_basic' in Bubble. Verwacht
//            response.user_id of response.response.user_id; bij ontbreken
//            doen we een fallback-lookup op bubble user by email.
//   STAP B — velden zetten via PATCH op het user-object: membership /
//            learning_type / 1_call_alpha_total_number / login_boolean /
//            role / onboarding_status + 3 datum-velden.
//
// Alles fail-soft: gooit nooit door naar de caller. Bij fouten zetten we
// onboardings.bubble_provision_error en returnen {ok:false, ...} zodat de
// HTTP-respons van de signup niet kapot gaat door een Bubble-issue.
//
// Idempotent: al-provisioned (bubble_provisioned=true) → {ok:true, skipped}.
// PATCH-fail na succesvolle account-aanmaak → bubble_user_id wordt sowieso
// vastgelegd; bubble_provisioned blijft false zodat een retry alleen de
// PATCH overdoet.

import { supabaseAdmin } from '../supabase.js';
import {
  bubbleWorkflow,
  bubblePatch,
  bubbleFindUserByEmail,
} from './bubble.js';
import { sendCredentialsEmail } from './onboarding-credentials.js';

// Maand-arithmetiek met clamp op laatste dag van de maand (15 → +1 = 15;
// 31 jan + 1 maand = 28/29 feb). Bubble-side wordt dit als datum opgeslagen
// — voor 1-op-1 / Alpha is dit slechts een placeholder die later bij echte
// activatie wordt bijgewerkt.
function addMonths(date, months) {
  const n = Math.max(0, Math.floor(Number(months) || 0));
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  // Clamp: als de doelmaand minder dagen heeft kan setUTCMonth doorrollen.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

// Bubble workflow-response kan op meerdere plaatsen het user-id zetten:
// soms { user_id: '...' } direct, soms genest in { response: { user_id }}.
// We ondersteunen beide.
function extractUserIdFromWf(wfResponse) {
  if (!wfResponse || typeof wfResponse !== 'object') return null;
  if (typeof wfResponse.user_id === 'string' && wfResponse.user_id.trim()) {
    return wfResponse.user_id.trim();
  }
  const r = wfResponse.response;
  if (r && typeof r === 'object' && typeof r.user_id === 'string' && r.user_id.trim()) {
    return r.user_id.trim();
  }
  return null;
}

// Idem voor het tijdelijke wachtwoord — Bubble-workflow stuurt 'm typisch
// onder response.temp_password OF direct als temp_password. Returnt null
// als beide ontbreken; in dat geval slaan we de credentials-mail/wa over.
// Geëxporteerd zodat api/onboarding-credentials-reset.js dezelfde extractie
// kan gebruiken op de reset_student_password-workflow-respons.
export function extractTempPasswordFromWf(wfResponse) {
  if (!wfResponse || typeof wfResponse !== 'object') return null;
  if (typeof wfResponse.temp_password === 'string' && wfResponse.temp_password.trim()) {
    return wfResponse.temp_password.trim();
  }
  const r = wfResponse.response;
  if (r && typeof r === 'object' && typeof r.temp_password === 'string' && r.temp_password.trim()) {
    return r.temp_password.trim();
  }
  return null;
}

async function writeProvisionError(onboardingId, msg) {
  // Best-effort: een fail in de error-write mag het hoofd-fail-pad niet
  // overschrijven. We loggen 'm alleen.
  try {
    await supabaseAdmin
      .from('onboardings')
      .update({ bubble_provision_error: String(msg || '').slice(0, 1000) })
      .eq('id', onboardingId);
  } catch (e) {
    console.error('[onboarding-provision] write-error fail:', e?.message || e);
  }
}

/**
 * @param {string} onboardingId
 * @returns {Promise<{ok:boolean, skipped?:boolean, bubble_user_id?:string, partial?:boolean, error?:string}>}
 */
export async function provisionOnboardingStudent(onboardingId) {
  if (!onboardingId || typeof onboardingId !== 'string') {
    return { ok: false, error: 'onboardingId ontbreekt' };
  }

  // 1) Onboarding laden.
  let onboarding;
  try {
    const { data, error } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, traject_id, status, bubble_provisioned, bubble_user_id, start_date')
      .eq('id', onboardingId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, error: 'Onboarding niet gevonden' };
    onboarding = data;
  } catch (e) {
    const msg = 'onboarding lookup: ' + (e?.message || e);
    console.error('[onboarding-provision]', msg);
    return { ok: false, error: msg };
  }

  if (onboarding.bubble_provisioned === true) {
    return { ok: true, skipped: true, bubble_user_id: onboarding.bubble_user_id || null };
  }

  // 2) Customer + traject laden.
  let customer, traject;
  try {
    const { data, error } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, email')
      .eq('id', onboarding.customer_id)
      .maybeSingle();
    if (error) throw error;
    customer = data;
  } catch (e) {
    const msg = 'customer lookup: ' + (e?.message || e);
    console.error('[onboarding-provision]', msg);
    await writeProvisionError(onboardingId, msg);
    return { ok: false, error: msg };
  }
  if (!customer || !customer.email || !String(customer.email).trim()) {
    const msg = 'Klant zonder e-mail — kan Bubble-account niet aanmaken';
    await writeProvisionError(onboardingId, msg);
    return { ok: false, error: msg };
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('onboarding_trajecten')
      .select('id, bubble_membership_option, bubble_learning_type, alpha_calls_total, type, duur_maanden')
      .eq('id', onboarding.traject_id)
      .maybeSingle();
    if (error) throw error;
    traject = data;
  } catch (e) {
    const msg = 'traject lookup: ' + (e?.message || e);
    console.error('[onboarding-provision]', msg);
    await writeProvisionError(onboardingId, msg);
    return { ok: false, error: msg };
  }
  if (!traject) {
    const msg = 'Traject niet gevonden voor onboarding';
    await writeProvisionError(onboardingId, msg);
    return { ok: false, error: msg };
  }
  if (!traject.bubble_membership_option || !traject.bubble_learning_type) {
    const msg = 'Traject mist bubble_membership_option of bubble_learning_type';
    await writeProvisionError(onboardingId, msg);
    return { ok: false, error: msg };
  }

  const firstName = String(customer.first_name || '').trim();
  const lastName  = String(customer.last_name  || '').trim();
  const email     = String(customer.email).trim().toLowerCase();

  // STAP A — account via workflow. Idempotent aan Bubble-zijde: workflow
  // hoort bij dubbele e-mail het bestaande user-id terug te geven, maar
  // we hebben een fallback voor het geval de workflow geen id retourneert
  // (oudere Bubble-versies stoppen na 'Sign up the user' en laten het
  // returnen aan een latere stap die per ongeluk ontbreekt).
  // Diagnostische capture: bewaar de ruwe workflow-respons + (eventueel)
  // de gevangen error-shape. Wordt alleen mee-geserialiseerd in de
  // bubble_provision_error wanneer ZOWEL workflow ALS e-mail-fallback geen
  // user-id opleverden, zodat we Bubble's response kunnen debuggen zonder
  // permanente noise. create_student_basic geeft alleen status + user_id
  // terug (geen secrets/tokens), dus dit is veilig om kort te dumpen.
  let bubbleUserId = null;
  let wfRaw    = null;       // ruwe workflow-respons indien fetch slaagde
  let wfError  = null;       // { code, message } indien workflow threw
  // Tijdelijk wachtwoord uit Bubble — alleen in memory; NIET in DB persisten.
  // Wordt na succesvolle provision gebruikt om sendCredentialsEmail aan
  // te roepen. Bij ontbreken slaan we de credentials-mail over en logt
  // de helper een 'reason'.
  let tempPassword = null;
  try {
    // Gedeeld secret voor de publieke Bubble-workflow (BUBBLE_WF_SECRET).
    // Bubble valideert dit straks server-side; vóór die check negeert
    // Bubble de extra param. Lege string bij ontbrekende env zodat we
    // nu niets breken; ná de Bubble-check is misconfig een terechte fail.
    // NB: het secret zit ALLEEN in de outbound body — bubble.js noch onze
    // diagnostics (wf_raw/wf_error) loggen de request-body, dus geen leak.
    wfRaw = await bubbleWorkflow('create_student_basic', {
      email,
      first_name: firstName,
      last_name : lastName,
      secret    : (process.env.BUBBLE_WF_SECRET || ''),
    });
    bubbleUserId = extractUserIdFromWf(wfRaw);
    tempPassword = extractTempPasswordFromWf(wfRaw);
  } catch (e) {
    wfError = {
      code:    (e && e.code)    ? String(e.code)    : null,
      message: (e && e.message) ? String(e.message) : String(e),
    };
    const msg = 'workflow create_student_basic: ' + (wfError.code || '') + ' ' + (wfError.message || '');
    console.error('[onboarding-provision] WF fail:', msg);
    // Workflow zelf faalde — accountcreatie onzeker. Probeer fallback-lookup;
    // mogelijk bestaat de user al en heeft de workflow alleen op een latere
    // stap een fout gegooid.
  }

  if (!bubbleUserId) {
    // Fallback: zoek de user op email. Geen hit → account is écht niet
    // aangemaakt, harde error.
    try {
      const u = await bubbleFindUserByEmail(email);
      if (u && typeof u._id === 'string' && u._id.trim()) {
        bubbleUserId = u._id.trim();
      } else if (u && typeof u.id === 'string' && u.id.trim()) {
        // Bubble Data API returnt meestal '_id'; defensieve fallback.
        bubbleUserId = u.id.trim();
      }
    } catch (e) {
      console.error('[onboarding-provision] find-by-email fail:', e?.message || e);
    }
  }

  if (!bubbleUserId) {
    // Voeg een veilige, beknopte JSON-dump van de workflow-respons (of de
    // gevangen error-shape) toe zodat we Bubble's gedrag kunnen debuggen
    // zonder een nieuwe code-deploy. Cap op 600 chars om DB-bloat te
    // voorkomen.
    let diag = '';
    if (wfError) {
      try { diag = ' | wf_error=' + JSON.stringify(wfError).slice(0, 600); } catch {}
    } else if (wfRaw !== null && wfRaw !== undefined) {
      try { diag = ' | wf_raw=' + JSON.stringify(wfRaw).slice(0, 600); } catch {}
    }
    const msg = 'Bubble-user kon niet worden aangemaakt of gevonden (' + email + ')' + diag;
    await writeProvisionError(onboardingId, msg);
    return { ok: false, error: msg };
  }

  // STAP B — velden zetten. We bouwen het patch-object stapsgewijs op
  // zodat niet-toepasselijke velden (alpha=0) gewoon weggelaten worden.
  const now = new Date();
  const nowIso = now.toISOString();
  const durationMonths = Number(traject.duur_maanden);

  // Einddatum-basis: pak start_date als die in de toekomst ligt; anders now.
  // Hiermee krijgt de klant de "gratis gap" tussen aanmelden en startdatum
  // bovenop de volle looptijd. Geen start_date / verleden → identiek aan
  // het oude gedrag (basis = now).
  //
  // onboardings.start_date is een Postgres date-kolom; supabaseAdmin geeft
  // 'm terug als 'yyyy-mm-dd'-string. Parse naar UTC-midnight om timezone-
  // verschuiving te voorkomen.
  let basis = now;
  const rawStart = onboarding && onboarding.start_date;
  if (rawStart) {
    const parsed = new Date(String(rawStart) + (String(rawStart).includes('T') ? '' : 'T00:00:00Z'));
    if (Number.isFinite(parsed.getTime()) && parsed.getTime() > now.getTime()) {
      basis = parsed;
    }
  }

  const endIso = (Number.isFinite(durationMonths) && durationMonths > 0)
    ? addMonths(basis, durationMonths).toISOString()
    : basis.toISOString(); // Defensieve fallback: 0/NULL → einddatum gelijk aan basis.

  const patch = {
    name_text                                           : firstName,
    last_name_text                                      : lastName,
    membership_option_os___membership                   : traject.bubble_membership_option,
    learning_type_option_os___learning_type             : traject.bubble_learning_type,
    login_student_boolean                               : true,
    role_option_os___roles                              : 'student',
    onboarding_status_option_os___onboarding_status     : 'Onboarding niet klaar',
    onboarding_date_date                                : nowIso,
    membership_state_date_date                          : nowIso,
    membership_end_date_date                            : endIso,
  };
  const alpha = Number(traject.alpha_calls_total);
  if (Number.isFinite(alpha) && alpha > 0) {
    patch['1_call_alpha_total_number'] = alpha;
  }

  try {
    await bubblePatch('user', bubbleUserId, patch);
  } catch (e) {
    // PATCH gefaald → account-id bewaren (zodat retry niet opnieuw probeert
    // create) en error logging, maar bubble_provisioned blijft false.
    const msg = 'patch user: ' + (e?.code || '') + ' ' + (e?.message || e);
    console.error('[onboarding-provision] PATCH fail:', msg);
    try {
      await supabaseAdmin
        .from('onboardings')
        .update({
          bubble_user_id        : bubbleUserId,
          bubble_provisioned    : false,
          bubble_provision_error: String(msg).slice(0, 1000),
        })
        .eq('id', onboardingId);
    } catch (dbE) {
      console.error('[onboarding-provision] partial-write fail:', dbE?.message || dbE);
    }
    return { ok: false, partial: true, bubble_user_id: bubbleUserId, error: msg };
  }

  // SUCCES.
  try {
    await supabaseAdmin
      .from('onboardings')
      .update({
        bubble_user_id        : bubbleUserId,
        bubble_provisioned    : true,
        bubble_provisioned_at : nowIso,
        bubble_provision_error: null,
      })
      .eq('id', onboardingId);
  } catch (e) {
    const msg = 'success-write: ' + (e?.message || e);
    console.error('[onboarding-provision]', msg);
    // Bubble-side is alles goed; DB-write faalde. Geef partial: caller weet
    // dan dat het Bubble-deel klaar is.
    return { ok: false, partial: true, bubble_user_id: bubbleUserId, error: msg };
  }

  // CREDENTIALS-MAIL — fail-soft, niet-blokkerend voor het ok:true-pad.
  // Alleen versturen wanneer Bubble's workflow een temp_password meegaf.
  // We persisten het wachtwoord NIET; alleen credentials_email_sent_at bij
  // succes als idempotentie-marker / zichtbaarheid in de admin-UI.
  if (tempPassword) {
    try {
      const credEmailRes = await sendCredentialsEmail({
        onboarding: { id: onboardingId },
        customer,
        tempPassword,
        // loginUrl: default uit env BUBBLE_LOGIN_URL
      });
      if (credEmailRes && credEmailRes.sent === true) {
        try {
          await supabaseAdmin
            .from('onboardings')
            .update({ credentials_email_sent_at: nowIso })
            .eq('id', onboardingId);
        } catch (dbE) {
          console.error('[onboarding-provision] cred-email mark fail:', dbE?.message || dbE);
        }
      } else {
        console.warn('[onboarding-provision] cred-email niet verzonden:',
          credEmailRes?.reason || 'unknown');
      }
    } catch (e) {
      console.error('[onboarding-provision] cred-email exception:', e?.message || e);
    }
  } else {
    console.warn('[onboarding-provision] geen temp_password in WF-respons — credentials-mail geskipt');
  }

  return { ok: true, bubble_user_id: bubbleUserId };
}
