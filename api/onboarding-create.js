// api/onboarding-create.js
//
// ADMIN — maakt een nieuwe onboarding aan voor een bestaande customer +
// traject. Status start op 'aangemeld'. Token = crypto.randomUUID() →
// gebruikt door /modules/onboarding.html?t=<token> (publieke vragenlijst-
// pagina, komt in Fase 1).
//
// Permission: onboarding.create.
//
// Body:
//   { customer_id (uuid), traject_id (uuid),
//     start_date?  (yyyy-mm-dd; optioneel, ongeldig → null) }
//
// Validaties:
//   - customer_id en traject_id moeten bestaan → anders 400/404.
//   - Guard: er mag GEEN bestaande onboarding zijn voor (customer_id) waarvan
//     status != 'gearchiveerd'. Anders 409 met existing_id zodat de UI naar
//     die bestaande kan navigeren.
//
// Response 200:
//   { ok:true, onboarding:{id, token, status}, link }
//
// (Geen Bubble-call — provisioning komt in Fase 2.)

import crypto from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { provisionOnboardingStudent } from './_lib/onboarding-provision.js';
import { sendOnboardingInvite } from './_lib/onboarding-invite.js';
import { enrollForTrigger as enrollOnboardingAutomations } from './_lib/onboarding-automation-engine.js';
import { assertStartDateNotTooEarly } from './_lib/onboarding-start-date.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Normaliseer een start_date input. Accepteert yyyy-mm-dd OF een ISO-
// datetime; ongeldig/leeg → null. Returnt een yyyy-mm-dd-string (Postgres
// date-kolom verwacht dat formaat).
function normalizeStartDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // ISO-datum (yyyy-mm-dd) direct.
  if (DATE_RE.test(s)) {
    const d = new Date(s + 'T00:00:00Z');
    if (Number.isFinite(d.getTime())) return s;
    return null;
  }
  // ISO-datetime: pak het date-deel.
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function customerDisplayName(c) {
  if (!c) return null;
  if (c.is_company && c.company_name) return c.company_name;
  const fn = (c.first_name || '').trim();
  const ln = (c.last_name  || '').trim();
  const full = `${fn} ${ln}`.trim();
  return full || c.company_name || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'onboarding.create'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.create)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const customerId = typeof body.customer_id === 'string' ? body.customer_id.trim() : '';
  const trajectId  = typeof body.traject_id  === 'string' ? body.traject_id.trim()  : '';
  // start_date is optioneel: lege/ongeldige input → null (provisioning valt
  // dan terug op now, identiek aan het oude gedrag).
  const startDate  = normalizeStartDate(body.start_date);
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  if (!UUID_RE.test(trajectId))  return res.status(400).json({ error: 'traject_id (uuid) vereist' });

  // Ondergrens: startdatum moet >= vandaag + 3 kalenderdagen (NL-tijd) liggen.
  // Zonder deze gate belandde het abbo in Bubble op start = aanmeldmoment,
  // en Bubble past een payment-buffer toe die de membership_state_date_date
  // terug-shift → abbo in het verleden. Niet stil clampen: de user moet zien
  // dat 'ie te vroeg koos zodat 'ie bewust een andere datum kiest.
  const startTooEarly = assertStartDateNotTooEarly(startDate);
  if (startTooEarly) {
    return res.status(400).json({
      error: startTooEarly.message,
      code:  startTooEarly.code,
      min:   startTooEarly.min,
      got:   startTooEarly.got,
    });
  }

  try {
    // 1) Customer bestaat?
    const { data: cust, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company')
      .eq('id', customerId)
      .maybeSingle();
    if (custErr) throw new Error('customer lookup: ' + custErr.message);
    if (!cust)  return res.status(404).json({ error: 'Klant niet gevonden' });

    // 2) Traject bestaat (en is_active)?
    const { data: traj, error: trajErr } = await supabaseAdmin
      .from('onboarding_trajecten')
      .select('id, is_active')
      .eq('id', trajectId)
      .maybeSingle();
    if (trajErr) throw new Error('traject lookup: ' + trajErr.message);
    if (!traj)  return res.status(404).json({ error: 'Traject niet gevonden' });
    if (!traj.is_active) return res.status(400).json({ error: 'Traject is niet actief' });

    // 3) Guard: bestaande, niet-gearchiveerde onboarding voor deze klant?
    const { data: existing, error: existErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, status')
      .eq('customer_id', customerId)
      .neq('status', 'gearchiveerd')
      .limit(1)
      .maybeSingle();
    if (existErr) throw new Error('onboarding lookup: ' + existErr.message);
    if (existing) {
      return res.status(409).json({
        error       : 'Er bestaat al een actieve onboarding voor deze klant',
        existing_id : existing.id,
      });
    }

    // 4) Insert.
    const token = crypto.randomUUID();
    const customerName = customerDisplayName(cust) || '';
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('onboardings')
      .insert({
        customer_id  : customerId,
        customer_name: customerName,
        traject_id   : trajectId,
        token,
        status       : 'aangemeld',
        start_date   : startDate,
        created_by   : user.id,
      })
      .select('id, token, status')
      .single();
    if (insErr) throw new Error('onboarding insert: ' + insErr.message);

    // Fase 2 — Bubble-provisioning. Fail-soft: een Bubble-fout mag de
    // aanmelding NIET 500'en. De onboarding + token zijn al gemaakt; de
    // provisioning-status komt mee in de response zodat de admin-UI
    // direct kan tonen of er een retry nodig is.
    let provision = { ok: false, error: 'unknown' };
    try {
      provision = await provisionOnboardingStudent(inserted.id);
    } catch (e) {
      console.error('[onboarding-create] provision threw:', e?.message || e);
      provision = { ok: false, error: e?.message || 'provision-threw' };
    }

    // Fase C1 — Onboarding-invite (WhatsApp-template). Fail-soft: helper
    // gooit NOOIT door (alle fouten als {sent:false, reason}). Geen send
    // wanneer module of template niet geconfigureerd is — dat is verwacht
    // gedrag, geen error. Reden komt mee in response zodat de admin-UI
    // de status kan tonen.
    let invite = { sent: false, reason: 'unknown' };
    try {
      invite = await sendOnboardingInvite({
        onboardingId: inserted.id,
        force:        false,
        sentByUserId: user.id,
        source:       'auto-after-provision',
      });
    } catch (e) {
      console.error('[onboarding-create] invite threw:', e?.message || e);
      invite = { sent: false, reason: 'invite-threw', error: e?.message || 'unknown' };
    }

    // Fase 1 onboarding-automations — fire-and-forget hook voor
    // 'on_onboarding_created'. NIET awaited zodat een automation-fout
    // de aanmelding nooit kan vertragen. Cron-poll vangt eventuele
    // missers binnen 1 minuut alsnog op via enrollDueOnboardings().
    Promise.resolve(
      enrollOnboardingAutomations({
        onboardingId: inserted.id,
        triggerType:  'on_onboarding_created',
      }),
    ).catch((e) => {
      console.error('[onboarding-create] automation enroll fail:', e?.message || e);
    });

    return res.status(200).json({
      ok         : true,
      onboarding : inserted,
      link       : '/modules/onboarding.html?t=' + encodeURIComponent(inserted.token),
      provision  : provision,
      invite     : invite,
    });
  } catch (e) {
    console.error('[onboarding-create]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
