// api/cron/onboarding-reminders.js
//
// Onboarding Comms C2 — dagelijkse reminder-cron voor uitgenodigde klanten
// die de wizard nog niet hebben afgerond. Werkt 1-op-1 spiegel van
// api/cron/archive-completed-onboardings.js qua auth, dry-mode + per-rij
// fail-soft, maar verstuurt WhatsApp-templates (geen Bubble-reads).
//
// CONSERVATIVE-FIRST principes:
//   - Default UIT (joost_config.knowledge_base.reminders.enabled=false).
//   - Lege/ontbrekende schedule → no-op.
//   - max_reminders cap (default 1).
//   - only_if_not_started + stop_on_inbound + handoff-check → skip.
//   - Verstuurt UITSLUITEND geconfigureerde + Meta-APPROVED templates
//     (via api/_lib/onboarding-template-send.js).
//   - Per-rij fail-soft: één faal blokkeert de batch niet.
//
// AUTH: Authorization: Bearer ${CRON_SECRET} (zelfde patroon).
//
// Query (vereisen nog steeds het CRON_SECRET):
//   ?dry=1     → rapporteer zonder DB-mutatie + zonder Meta-send.
//   ?limit=N   → MAX_PER_RUN override (clamp 1..1000, default 300).
//
// Response 200:
//   { ok, dry, checked, eligible, sent:[ids],
//     skipped:{<reason>: count}, errors:[{onboarding_id, reason}] }

import { supabaseAdmin } from '../supabase.js';
import { sendOnboardingTemplateGeneric } from '../_lib/onboarding-template-send.js';

const DEFAULT_MAX_PER_RUN = 300;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function bumpSkip(map, key) { map[key] = (map[key] || 0) + 1; }

// E.164-+ normalisatie (zelfde patroon als in shared helper). Wordt
// gebruikt voor de stop_on_inbound conv-lookup (we matchen op exacte
// phone_number string die de webhook altijd in '+digits'-vorm schrijft).
function toE164Plus(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length < 8) return null;
  return '+' + digits;
}

function isWizardAlreadyStarted(ob) {
  if (!ob) return false;
  // status 'bezig' / current_step > 0 / answers met sleutels → student is
  // begonnen met de wizard. only_if_not_started → niet meer pushen.
  if (ob.status && ob.status !== 'aangemeld') return true;
  if (Number.isFinite(Number(ob.current_step)) && Number(ob.current_step) > 0) return true;
  if (ob.answers && typeof ob.answers === 'object' && Object.keys(ob.answers).length > 0) return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // AUTH — mirror archive-completed-onboardings.js.
  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dry = req.query?.dry === '1' || req.query?.dry === 'true';
  let maxPerRun = DEFAULT_MAX_PER_RUN;
  if (req.query?.limit) {
    const n = Number(req.query.limit);
    if (Number.isFinite(n) && n >= 1) maxPerRun = Math.min(1000, Math.floor(n));
  }

  const sent    = [];
  const errors  = [];
  const skipped = {};
  let checked   = 0;
  let eligible  = 0;

  try {
    // ── 1) Config-gate: joost_config.knowledge_base.reminders ──
    const { data: jcfg, error: jcfgErr } = await supabaseAdmin
      .from('joost_config')
      .select('knowledge_base, is_enabled')
      .eq('module', 'onboarding')
      .maybeSingle();
    if (jcfgErr) throw new Error('joost_config lookup: ' + jcfgErr.message);
    const kb = (jcfg?.knowledge_base && typeof jcfg.knowledge_base === 'object') ? jcfg.knowledge_base : {};
    const cfg = (kb.reminders && typeof kb.reminders === 'object') ? kb.reminders : {};
    const remindersEnabled  = cfg.enabled === true;
    const schedule = Array.isArray(cfg.schedule)
      ? cfg.schedule.filter((s) => s && typeof s === 'object'
          && Number.isFinite(Number(s.day_offset))
          && typeof s.template_name === 'string'
          && s.template_name.trim())
      : [];
    const maxReminders = Number.isFinite(Number(cfg.max_reminders)) && Number(cfg.max_reminders) >= 1
      ? Math.min(20, Math.floor(Number(cfg.max_reminders)))
      : 1;
    const onlyIfNotStarted = cfg.only_if_not_started !== false; // default true
    const stopOnInbound    = cfg.stop_on_inbound    !== false;   // default true
    if (!remindersEnabled || schedule.length === 0) {
      return res.status(200).json({
        ok: true, dry,
        reason: !remindersEnabled ? 'reminders-uit' : 'lege-schedule',
        checked: 0, eligible: 0, sent: [], skipped, errors: [],
      });
    }

    // ── 2) Module-config voor onboarding (phone_number_id voor stop_on_inbound) ──
    const { data: modCfg, error: modErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id, is_active')
      .eq('module', 'onboarding')
      .eq('is_active', true)
      .maybeSingle();
    if (modErr) throw new Error('module-config lookup: ' + modErr.message);
    if (!modCfg?.phone_number_id) {
      return res.status(200).json({
        ok: true, dry,
        reason: 'geen-module-config',
        checked: 0, eligible: 0, sent: [], skipped, errors: [],
      });
    }
    const onboardingPnId = modCfg.phone_number_id;

    // ── 3) Kandidaten ophalen ──
    // Alleen onboardings die we ÚITGENODIGD hebben (invite_sent_at NOT NULL),
    // niet afgerond, niet gearchiveerd, en reminder_count < cap.
    // Sorteer op invite_sent_at asc zodat oudste eerst aan de beurt zijn.
    const { data: rows, error: rowErr } = await supabaseAdmin
      .from('onboardings')
      .select(
        'id, customer_id, status, current_step, answers, archived_at, ' +
        'invite_sent_at, reminder_count, last_reminder_at'
      )
      .not('invite_sent_at', 'is', null)
      .neq('status', 'afgerond')
      .neq('status', 'gearchiveerd')
      .order('invite_sent_at', { ascending: true })
      .limit(2000);
    if (rowErr) throw new Error('onboardings fetch: ' + rowErr.message);

    const list = Array.isArray(rows) ? rows : [];
    const candidates = list.filter((r) => {
      const rc = Number(r.reminder_count) || 0;
      return rc < maxReminders;
    });
    eligible = candidates.length;
    const capped = candidates.slice(0, maxPerRun);
    checked = capped.length;

    const nowMs = Date.now();

    // Customer-phones in bulk → conv-lookup per phone (stop_on_inbound).
    const customerIds = Array.from(new Set(capped.map((r) => r.customer_id).filter(Boolean)));
    let phoneByCustomer = new Map();
    if (customerIds.length > 0) {
      const { data: custs, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('id, phone')
        .in('id', customerIds);
      if (custErr) throw new Error('customers fetch: ' + custErr.message);
      for (const c of (custs || [])) phoneByCustomer.set(c.id, c.phone || null);
    }

    // Conv-lookup voor stop_on_inbound. We zoeken op (phone_number,
    // phone_number_id) tuple zodat we alleen conversaties op de
    // ONBOARDING-lijn meetellen (niet finance/events op hetzelfde nummer).
    const phonesPlus = Array.from(new Set(
      capped.map((r) => toE164Plus(phoneByCustomer.get(r.customer_id))).filter(Boolean)
    ));
    let convByPhone = new Map();
    if (stopOnInbound && phonesPlus.length > 0) {
      const { data: convs, error: convErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, phone_number, last_inbound_at, unread_count')
        .in('phone_number', phonesPlus)
        .eq('phone_number_id', onboardingPnId);
      if (convErr) throw new Error('conversations fetch: ' + convErr.message);
      for (const c of (convs || [])) {
        if (c.phone_number) convByPhone.set(c.phone_number, c);
      }
    }

    // Joost-suggestions handoff-check: voor elke unieke conv kijken we naar de
    // meest recente suggestie van module=onboarding (laatste 24u) met
    // context_snapshot.handoff.needs_human=true. Skip bij true.
    const convIds = Array.from(new Set([...convByPhone.values()].map((c) => c.id).filter(Boolean)));
    let handoffByConv = new Map();
    if (convIds.length > 0) {
      const cutoff = new Date(nowMs - MS_PER_DAY).toISOString();
      const { data: sugs, error: sugErr } = await supabaseAdmin
        .from('joost_suggestions')
        .select('id, conversation_id, context_snapshot, created_at')
        .eq('module', 'onboarding')
        .in('conversation_id', convIds)
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(1000);
      if (sugErr) {
        // Niet fataal — we behandelen geen-handoff-info als 'niet-handmatig'.
        console.warn('[cron onboarding-reminders] joost_suggestions:', sugErr.message);
      } else {
        for (const s of (sugs || [])) {
          if (handoffByConv.has(s.conversation_id)) continue; // alleen de NIEUWSTE telt
          const handoff = s?.context_snapshot?.handoff;
          if (handoff && handoff.needs_human === true) {
            handoffByConv.set(s.conversation_id, true);
          } else {
            handoffByConv.set(s.conversation_id, false);
          }
        }
      }
    }

    // ── 4) Per-rij beslissen + (eventueel) versturen ──
    for (const ob of capped) {
      try {
        const stepIndex = Number(ob.reminder_count) || 0;
        if (stepIndex >= schedule.length) { bumpSkip(skipped, 'schedule-uitgeput'); continue; }
        const step = schedule[stepIndex];
        const dayOffset = Number(step.day_offset);
        if (!Number.isFinite(dayOffset) || dayOffset < 0) {
          bumpSkip(skipped, 'ongeldige-day-offset'); continue;
        }
        const inviteMs = new Date(ob.invite_sent_at).getTime();
        if (!Number.isFinite(inviteMs)) { bumpSkip(skipped, 'ongeldige-invite-ts'); continue; }
        const dueAtMs = inviteMs + (dayOffset * MS_PER_DAY);
        if (nowMs < dueAtMs) { bumpSkip(skipped, 'nog-niet-aan-de-beurt'); continue; }

        // only_if_not_started.
        if (onlyIfNotStarted && isWizardAlreadyStarted(ob)) {
          bumpSkip(skipped, 'al-gestart'); continue;
        }

        // Phone check + stop_on_inbound + handoff.
        const phonePlus = toE164Plus(phoneByCustomer.get(ob.customer_id));
        if (!phonePlus) { bumpSkip(skipped, 'geen-telefoon'); continue; }
        const conv = convByPhone.get(phonePlus) || null;
        if (stopOnInbound && conv && conv.last_inbound_at) {
          bumpSkip(skipped, 'gesprek-actief'); continue;
        }
        if (conv && handoffByConv.get(conv.id) === true) {
          bumpSkip(skipped, 'handmatig'); continue;
        }

        const templateName = String(step.template_name || '').trim();
        const languageCode = typeof step.language === 'string' && step.language.trim()
          ? step.language.trim().toLowerCase() : 'nl';

        // Generic send-pipeline aanroepen. postSendUpdate update onboarding-row
        // ALLEEN in non-dry mode (zelf doet de helper sowieso geen Meta-send
        // bij dry).
        const result = await sendOnboardingTemplateGeneric({
          onboardingId : ob.id,
          templateName,
          languageCode,
          source       : `reminder-step-${stepIndex + 1}`,
          sentByUserId : null,
          auditAction  : 'onboarding.reminder.sent',
          dry,
          postSendUpdate: dry ? null : async (_obRow, _res) => {
            const nowIso = new Date().toISOString();
            try {
              await supabaseAdmin
                .from('onboardings')
                .update({
                  reminder_count   : stepIndex + 1,
                  last_reminder_at : nowIso,
                })
                .eq('id', ob.id);
            } catch (e) {
              console.error('[cron onboarding-reminders] mark reminder fail:', ob.id, e?.message || e);
            }
          },
        });

        if (result?.sent === true) {
          sent.push(ob.id);
        } else {
          const reason = result?.reason || 'unknown';
          bumpSkip(skipped, 'send-' + reason);
          if (result?.error) {
            errors.push({ onboarding_id: ob.id, reason: String(result.error).slice(0, 300) });
          }
        }
      } catch (e) {
        const msg = (e?.message || String(e)).slice(0, 300);
        console.error('[cron onboarding-reminders] row fail:', ob.id, msg);
        errors.push({ onboarding_id: ob.id, reason: msg });
      }
    }

    return res.status(200).json({
      ok: true, dry,
      checked, eligible,
      sent, skipped, errors,
    });
  } catch (e) {
    console.error('[cron onboarding-reminders]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
