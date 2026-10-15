// api/_lib/dfo-lms-lab-account.js
//
// Het trial-account van een Lab-lead in het NIEUWE LMS (dfo-lms, hlms_*).
// Schrijft met de service-role uit dfo-lms-db.js — dezelfde weg waarlangs het
// CRM al studenten in het LMS zet.
//
// DE GRENS DIE HIER BEWAAKT WORDT
// -------------------------------
// Een aanmelding mag een bestaand account NOOIT verlagen of iets bijzetten.
// Elke bestaande LMS-identiteit — student, mentor, admin, een zaalaccount
// (event1..12@, rol trial zonder lab-lead-rij) of een studentrij die nog op
// koppeling wacht — levert 'heeft_toegang' op en wordt niet aangeraakt.
// Alleen een e-mail die het LMS nog nergens kent krijgt een nieuw account.
//
// Uitkomsten van zorgVoorLabAccount:
//   nieuw          — auth-user + hlms_lab_lead + hlms_rol 'trial' aangemaakt
//   bestaand_lab   — er was al een lab-lead-rij; niets veranderd
//   heeft_toegang  — bestaande LMS-identiteit; niets veranderd
// Gooit LabAccountFout bij een storing (code = 'lms_niet_geconfigureerd' |
// 'lms_fout').

import crypto from 'node:crypto';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { toegangTotVanaf } from './lab-config.js';

export class LabAccountFout extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** sha256 hex van een sleutel — zo staat hij in hlms_lab_sleutel. */
export function hashSleutel(sleutel) {
  return crypto.createHash('sha256').update(String(sleutel)).digest('hex');
}

/** 32 willekeurige bytes, url-veilig. */
export function nieuweSleutel() {
  return crypto.randomBytes(32).toString('base64url');
}

const STAF_OF_STUDENT = new Set(['student', 'mentor', 'hoofdmentor', 'admin', 'administratie']);

/**
 * Beslist uit wat we over een e-mail weten. PURE — de regels staan hier, de
 * bevragingen in zorgVoorLabAccount.
 *
 * @param {{ labLead: object|null, authId: string|null, rollen: string[], heeftStudentRij: boolean, heeftPersoneelRij: boolean }} s
 * @returns {'bestaand_lab'|'heeft_toegang'|'nieuw'|'koppel_bestaande_auth'}
 */
export function beslisAccount(s) {
  if (s.labLead) return 'bestaand_lab';
  if (s.heeftStudentRij || s.heeftPersoneelRij) return 'heeft_toegang';
  if ((s.rollen || []).some((r) => STAF_OF_STUDENT.has(r))) return 'heeft_toegang';
  // Alleen 'trial' zonder lab-lead-rij = een zaal- of demo-account. Afblijven.
  if ((s.rollen || []).includes('trial')) return 'heeft_toegang';
  if (s.authId) return 'koppel_bestaande_auth';
  return 'nieuw';
}

function lms() {
  const c = getDfoLmsClient();
  if (!c) throw new LabAccountFout('lms_niet_geconfigureerd', 'DFO_LMS_SUPABASE_* ontbreekt');
  return c;
}

async function leesLabLeadOpEmail(c, email) {
  const { data, error } = await c.from('hlms_lab_lead')
    .select('id, auth_id, email, voornaam, toegang_tot, crm_lead_id, sessie_geboekt_op')
    .ilike('email', email).limit(1);
  if (error) throw new LabAccountFout('lms_fout', 'hlms_lab_lead lezen: ' + error.message);
  return data?.[0] || null;
}

/**
 * Zoekt het auth-id bij een e-mail zonder een mail te versturen:
 * generateLink geeft de user terug. Wordt alleen aangeroepen nadat
 * createUser 'bestaat al' meldde, dus er wordt nooit een account gemaakt.
 */
async function authIdVoorBestaandeEmail(c, email) {
  const { data, error } = await c.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new LabAccountFout('lms_fout', 'auth-user opzoeken: ' + error.message);
  return data?.user?.id || null;
}

async function bestaandeIdentiteit(c, email, authId) {
  const [rollen, student, personeel] = await Promise.all([
    authId
      ? c.from('hlms_rol').select('rol').eq('auth_id', authId)
      : Promise.resolve({ data: [], error: null }),
    c.from('hlms_student').select('id').ilike('email', email).limit(1),
    c.from('hlms_personeel').select('id').ilike('email', email).limit(1),
  ]);
  if (rollen.error) throw new LabAccountFout('lms_fout', 'hlms_rol lezen: ' + rollen.error.message);
  if (student.error) throw new LabAccountFout('lms_fout', 'hlms_student lezen: ' + student.error.message);
  // hlms_personeel kan in een oudere opzet ontbreken — dat is geen reden om te stoppen.
  if (personeel.error) console.warn('[dfo-lms-lab-account] hlms_personeel lezen (soft):', personeel.error.message);
  return {
    rollen: (rollen.data || []).map((r) => r.rol),
    heeftStudentRij: (student.data || []).length > 0,
    heeftPersoneelRij: (personeel.data || []).length > 0,
  };
}

/**
 * @param {object} p
 * @param {string} p.email
 * @param {string} p.voornaam
 * @param {string|null} [p.achternaam]
 * @param {string|null} [p.telefoon]
 * @param {string|null} [p.crmLeadId]
 * @param {string|null} [p.hook]
 * @param {object} [p.utm]
 * @param {boolean} [p.isTest]
 * @returns {Promise<{ soort: 'nieuw'|'bestaand_lab'|'heeft_toegang', authId: string|null, labLead: object|null }>}
 */
export async function zorgVoorLabAccount(p) {
  const c = lms();
  const email = String(p.email).trim().toLowerCase();

  const bestaandLab = await leesLabLeadOpEmail(c, email);
  if (bestaandLab) {
    // Koppel de CRM-lead als die er nog niet aan hing; verder niets.
    if (p.crmLeadId && !bestaandLab.crm_lead_id) {
      const { error } = await c.from('hlms_lab_lead').update({ crm_lead_id: p.crmLeadId }).eq('id', bestaandLab.id);
      if (error) console.warn('[dfo-lms-lab-account] crm_lead_id bijzetten (soft):', error.message);
    }
    return { soort: 'bestaand_lab', authId: bestaandLab.auth_id, labLead: bestaandLab };
  }

  // Een studentrij of personeelsrij met dit adres = bestaande identiteit,
  // ook als er nog geen auth-user aan hangt (de student-koppeling bij de
  // eerste login doet dat). Vóór we iets aanmaken.
  const opEmail = await bestaandeIdentiteit(c, email, null);
  if (opEmail.heeftStudentRij || opEmail.heeftPersoneelRij) {
    return { soort: 'heeft_toegang', authId: null, labLead: null };
  }

  // Dan proberen aan te maken: lukt dat, dan bestond het adres nergens.
  let authId = null;
  let zelfGemaakt = false;
  const { data: gemaakt, error: maakFout } = await c.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { voornaam: p.voornaam, achternaam: p.achternaam || null, herkomst: 'lab_lead' },
  });
  if (gemaakt?.user?.id) {
    authId = gemaakt.user.id;
    zelfGemaakt = true;
  } else {
    const bestaat = /already|exists|registered/i.test(String(maakFout?.message || '')) || maakFout?.code === 'email_exists';
    if (!bestaat) throw new LabAccountFout('lms_fout', 'auth createUser: ' + (maakFout?.message || 'onbekend'));
    authId = await authIdVoorBestaandeEmail(c, email);
    if (!authId) throw new LabAccountFout('lms_fout', 'auth-user bestaat maar is niet terug te vinden');
    const ident = await bestaandeIdentiteit(c, email, authId);
    const besluit = beslisAccount({ labLead: null, authId, ...ident });
    if (besluit === 'heeft_toegang') return { soort: 'heeft_toegang', authId, labLead: null };
  }

  // nieuw of koppel_bestaande_auth (een auth-user zonder enige LMS-rol).
  const { data: lead, error: leadFout } = await c.from('hlms_lab_lead').insert({
    auth_id: authId,
    email,
    voornaam: p.voornaam,
    achternaam: p.achternaam || null,
    telefoon: p.telefoon || null,
    crm_lead_id: p.crmLeadId || null,
    hook: p.hook || null,
    utm: p.utm || {},
    toegang_tot: toegangTotVanaf(new Date()),
    is_test: !!p.isTest,
  }).select('id, auth_id, email, voornaam, toegang_tot, crm_lead_id, sessie_geboekt_op').single();

  if (leadFout) {
    // Een vers account zonder lab-lead-rij zou een trial zonder einddatum
    // worden. Dat account hebben we net zelf gemaakt, dus we ruimen het op.
    if (zelfGemaakt) {
      const { error: wegFout } = await c.auth.admin.deleteUser(authId);
      if (wegFout) console.error('[dfo-lms-lab-account] opruimen na mislukte lab-lead-rij:', wegFout.message);
    }
    throw new LabAccountFout('lms_fout', 'hlms_lab_lead insert: ' + leadFout.message);
  }

  const { error: rolFout } = await c.from('hlms_rol').insert({ auth_id: authId, rol: 'trial' });
  if (rolFout && String(rolFout.code) !== '23505') {
    throw new LabAccountFout('lms_fout', 'hlms_rol trial: ' + rolFout.message);
  }

  return { soort: 'nieuw', authId, labLead: lead };
}

/**
 * Maakt een loginsleutel voor deze lab-lead en geeft hem terug. In de database
 * komt alleen de hash.
 */
export async function maakLoginSleutel(labLeadId, doel = 'login') {
  const c = lms();
  const sleutel = nieuweSleutel();
  const { error } = await c.from('hlms_lab_sleutel').insert({
    lead_id: labLeadId, sleutel_hash: hashSleutel(sleutel), doel,
  });
  if (error) throw new LabAccountFout('lms_fout', 'hlms_lab_sleutel insert: ' + error.message);
  return sleutel;
}

/** Lab-lead-rij op e-mail (voor de nieuwe-link-aanvraag). Null = geen. */
export async function vindLabLead(email) {
  return leesLabLeadOpEmail(lms(), String(email || '').trim().toLowerCase());
}

/**
 * Wie zit er achter deze LMS-sessie? Valideert het bearer-token bij het
 * LMS-project zelf — het CRM kan LMS-tokens niet zelf controleren.
 * @returns {Promise<{ authId: string, labLead: object|null }|null>} null = geen geldige sessie
 */
export async function lmsGebruikerUitToken(token) {
  if (!token) return null;
  const c = lms();
  const { data, error } = await c.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  const { data: rij, error: lf } = await c.from('hlms_lab_lead')
    .select('id, auth_id, email, voornaam, achternaam, telefoon, crm_lead_id, hook, toegang_tot, sessie_geboekt_op, sessie_moment, sessie_afspraak_id, kwalificatie, is_test')
    .eq('auth_id', data.user.id).maybeSingle();
  if (lf) throw new LabAccountFout('lms_fout', 'hlms_lab_lead lezen: ' + lf.message);
  return { authId: data.user.id, email: data.user.email || null, labLead: rij || null };
}

/** Zet de boeking op de lab-lead-rij (service-role). */
export async function noteerBoeking(labLeadId, { moment, afspraakId }) {
  const c = lms();
  const { error } = await c.from('hlms_lab_lead').update({
    sessie_geboekt_op: new Date().toISOString(),
    sessie_moment: moment,
    sessie_afspraak_id: afspraakId || null,
  }).eq('id', labLeadId);
  if (error) throw new LabAccountFout('lms_fout', 'boeking noteren: ' + error.message);
}
