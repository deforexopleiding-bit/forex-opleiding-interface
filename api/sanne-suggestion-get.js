// api/sanne-suggestion-get.js
// GET ?email_id=<uuid> -> laatste sanne_suggestions rij voor die mail (of null).
// Alleen voor reader-card in email-v2 (Fase 2.1).
// Permission: email.module.access.
//
// Response 200: { suggestion: {...} | null, sanne_enabled: bool, mailbox_in_scope: bool }
// De extra flags maken client-side rendering trivial (kaart alleen tonen als
// sanne_reactive_suggest=true én mailbox in scope én suggestion in PROPOSED/DRAFT_SAVED).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'email.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (email.module.access)' });
  }

  const emailId = typeof req.query?.email_id === 'string' ? req.query.email_id.trim() : '';
  if (!emailId || !UUID_RE.test(emailId)) return res.status(400).json({ error: 'email_id (uuid) verplicht' });

  try {
    // Config eerst — zonder is_enabled + sanne_reactive_suggest is de kaart-render
    // niet aan de orde; UI kan direct beslissen 'em te verbergen.
    const { data: config } = await supabaseAdmin.from('joost_config')
      .select('is_enabled, feature_flags, autonomy_config').eq('module', 'email').maybeSingle();
    const flags = config?.feature_flags || {};
    const autonomy = config?.autonomy_config || {};
    const reactiveOn = flags.sanne_reactive_suggest === true;
    const mailboxScope = Array.isArray(autonomy.mailbox_scope) ? autonomy.mailbox_scope : [];

    const { data: sug, error } = await supabaseAdmin.from('sanne_suggestions')
      .select('id, email_id, mailbox, detected_intent, confidence, draft_subject, draft_body_text, draft_body_html, status, autonomy_decision, linked_draft_id, linked_reply_id, created_at, outcome_at, outcome_notes')
      .eq('email_id', emailId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) return res.status(500).json({ error: error.message });

    const suggestion = Array.isArray(sug) && sug.length ? sug[0] : null;
    const mailboxInScope = suggestion ? mailboxScope.includes(suggestion.mailbox) : false;

    return res.status(200).json({
      suggestion,
      sanne_enabled: !!(config && config.is_enabled !== false),
      reactive_suggest_flag: reactiveOn,
      mailbox_in_scope: mailboxInScope,
    });
  } catch (e) {
    console.error('[sanne-suggestion-get]', e?.message);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
