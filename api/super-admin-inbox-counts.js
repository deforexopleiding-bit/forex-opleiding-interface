// api/super-admin-inbox-counts.js
//
// GET → unread/onbeantwoord-tellers per postvak voor het super_admin-dashboard.
//
// Response 200:
//   {
//     counts: {
//       wanbetalers:    { count, deep_link },
//       leadsonderhoud: { count, deep_link },
//       onboarding:     { count, deep_link },
//       lisa:           { count, deep_link },
//       events:         { count, deep_link },
//       email:          { count, deep_link, per_mailbox: { leads, info, partners, administratie } }
//     },
//     total: N
//   }
//
// Tellingen:
//   * WhatsApp-inboxen (wanbetalers/leadsonderhoud/onboarding/events) — via
//     whatsapp_module_config phone_number_id lookup + count op
//     whatsapp_conversations waar status='open' AND unread_count>0.
//     module-keys: 'finance', 'leadsonderhoud' (fallback op app_settings),
//     'onboarding', 'events'.
//   * Lisa AI — lisa_conversations waar is_sandbox=false AND
//     (human_takeover=true OR followup_paused=true).
//     "Onbeantwoord" is niet 100% eenduidig te bepalen zonder message-side
//     query (last_user vs last_ai timestamps zitten niet op conv). We nemen
//     human_takeover + followup_paused als proxy voor "mens moet iets".
//   * E-mail — email_messages GROUP BY mailbox waar requires_action=true.
//     4 mailboxen: leads, info, partners, administratie.
//     NIET api/emails.js (live IMAP, 10s timeout-risico bij dashboard-refresh).
//
// Failure-mode: elk postvak faalt alleen zichzelf. Rest gaat door. Bij fout
// wordt count = null + error-string (zodat UI kan zien "onbekend" ipv "0").
//
// Permission: dashboard.module.access.

import { supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

// ── phone_number_id lookup per module ────────────────────────────────
async function getPnIdForModule(moduleKey) {
  const { data, error } = await supabaseAdmin
    .from('whatsapp_module_config')
    .select('phone_number_id')
    .eq('module', moduleKey)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw new Error(`whatsapp_module_config[${moduleKey}]: ${error.message}`);
  return data?.phone_number_id || null;
}

async function countWaUnread(moduleKey) {
  const pnId = await getPnIdForModule(moduleKey);
  if (!pnId) return { count: 0, note: `geen ${moduleKey}-config` };
  const { count, error } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id', { head: true, count: 'exact' })
    .eq('phone_number_id', pnId)
    .eq('status', 'open')
    .gt('unread_count', 0);
  if (error) throw new Error(`whatsapp[${moduleKey}]: ${error.message}`);
  return { count: count || 0 };
}

// Leadsonderhoud kan via een andere module-key lopen — fallback op 'onboarding'
// als er geen 'leadsonderhoud'-config bestaat (huidige productie-config; zie
// api/_lib/leadsonderhoud-gesprekken.js:36-46 waar dezelfde fallback zit).
async function countLeadsonderhoudInbox() {
  let key = 'leadsonderhoud';
  let pnId = await getPnIdForModule(key);
  if (!pnId) {
    // Fallback op app_settings.leadsonderhoud_wa_module → daar staat de
    // active-lijn-key (default 'onboarding').
    const { data: setting } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'leadsonderhoud_wa_module')
      .maybeSingle();
    const fallback = setting?.value?.module || 'onboarding';
    pnId = await getPnIdForModule(fallback);
    key = fallback;
  }
  if (!pnId) return { count: 0, note: 'geen actieve wa-lijn' };
  const { count, error } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id', { head: true, count: 'exact' })
    .eq('phone_number_id', pnId)
    .eq('status', 'open')
    .gt('unread_count', 0);
  if (error) throw new Error(`leadsonderhoud[${key}]: ${error.message}`);
  return { count: count || 0, note: `lijn: ${key}` };
}

async function countLisaUnread() {
  // Human_takeover OR followup_paused = mens moet actie ondernemen.
  const { count, error } = await supabaseAdmin
    .from('lisa_conversations')
    .select('id', { head: true, count: 'exact' })
    .eq('is_sandbox', false)
    .or('human_takeover.eq.true,followup_paused.eq.true');
  if (error) throw new Error(`lisa: ${error.message}`);
  return { count: count || 0 };
}

async function countEmailPerMailbox() {
  // 4 mailboxen — 4 parallelle head-counts. requires_action=true is de flag
  // die door de AI-classifier (sync-emails.js) wordt gezet voor iets dat
  // opvolging behoeft.
  const boxes = ['leads', 'info', 'partners', 'administratie'];
  const results = await Promise.all(boxes.map(async (box) => {
    try {
      const { count, error } = await supabaseAdmin
        .from('email_messages')
        .select('id', { head: true, count: 'exact' })
        .eq('mailbox', box)
        .eq('requires_action', true);
      if (error) throw new Error(error.message);
      return { box, count: count || 0 };
    } catch (e) {
      console.warn(`[super-admin-inbox-counts] email[${box}]: ${e?.message}`);
      return { box, count: null, error: e?.message };
    }
  }));
  const per = {};
  let total = 0;
  for (const r of results) {
    per[r.box] = r.count;
    if (typeof r.count === 'number') total += r.count;
  }
  return { count: total, per_mailbox: per };
}

async function safe(promise, key) {
  try {
    return { key, ...(await promise) };
  } catch (e) {
    console.warn(`[super-admin-inbox-counts] ${key}: ${e?.message}`);
    return { key, count: null, error: e?.message || String(e) };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await requirePermission(req, 'dashboard.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (dashboard.module.access)' });
  }

  try {
    const [wanb, leadsond, onbo, lisa, evts, mail] = await Promise.all([
      safe(countWaUnread('finance'),      'wanbetalers'),
      safe(countLeadsonderhoudInbox(),    'leadsonderhoud'),
      safe(countWaUnread('onboarding'),   'onboarding'),
      safe(countLisaUnread(),             'lisa'),
      safe(countWaUnread('events'),       'events'),
      safe(countEmailPerMailbox(),        'email'),
    ]);

    const counts = {
      wanbetalers:    { count: wanb.count,     deep_link: '/modules/finance.html?tab=wanbetalers&sub=inbox',       error: wanb.error || null,     note: wanb.note || null },
      leadsonderhoud: { count: leadsond.count, deep_link: '/modules/leadsonderhoud.html',                          error: leadsond.error || null, note: leadsond.note || null },
      onboarding:     { count: onbo.count,     deep_link: '/modules/onboarding-hub.html',                          error: onbo.error || null,     note: onbo.note || null },
      lisa:           { count: lisa.count,     deep_link: '/modules/lisa.html',                                    error: lisa.error || null },
      events:         { count: evts.count,     deep_link: '/modules/events.html',                                  error: evts.error || null,     note: evts.note || null },
      email:          { count: mail.count,     deep_link: '/modules/email.html',                                   error: mail.error || null,     per_mailbox: mail.per_mailbox || {} },
    };

    const total = Object.values(counts).reduce((a, c) => a + (typeof c.count === 'number' ? c.count : 0), 0);
    return res.status(200).json({ counts, total });
  } catch (e) {
    console.error('[super-admin-inbox-counts]', e?.message || e);
    return res.status(500).json({ error: 'Inbox-counts-fetch mislukt', detail: e?.message });
  }
}
