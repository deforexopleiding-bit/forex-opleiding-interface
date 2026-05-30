import { categorize } from './email-agent.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';
import { supabaseAdmin } from './supabase.js';

const CLASSIFIER_VERSION = 'v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // RBAC (fail-open): alleen 403 bij bewezen-geen-permission.
  if (!(await requirePermissionFailOpen(req, 'email.heranalyseer.run'))) {
    return res.status(403).json({ error: 'Insufficient permissions', feature: 'email.heranalyseer.run' });
  }

  const { emails } = req.body || {};
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'emails array vereist' });
  }

  // ── Groepeer op sender_email (of sender_domain als fallback) ──────────────
  const groups = new Map();
  for (const email of emails) {
    const key = email.sender_email || email.sender_domain || email.from || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(email);
  }

  const results = [];
  let analyzed  = 0;
  let errors    = 0;
  const originalCategories = new Map(emails.map((e) => [e.uid, e.category]));

  // ── Analyseer één representative per groep ─────────────────────────────────
  for (const [, groupEmails] of groups) {
    const rep = groupEmails[0]; // eerste email is de representative
    let result;

    try {
      result = await categorize({
        from:        rep.from || rep.sender_email || '',
        subject:     rep.subject || '',
        bodySnippet: rep.body_snippet || '',
        date:        rep.date || ''
      });
      analyzed++;
    } catch (err) {
      console.error('[reanalyze-all] AI fout voor', rep.sender_email, err.message);
      errors++;
      result = {
        category: rep.category || 'Overig',
        requires_action: false,
        priority: 'laag',
        confidence: 40,
        source: 'error'
      };
    }

    // Pas resultaat toe op ALLE emails in de groep
    for (const email of groupEmails) {
      results.push({
        uid:             email.uid,
        category:        result.category,
        requires_action: result.requires_action,
        priority:        result.priority,
        confidence:      result.confidence,
        source:          result.source,
        reasoning:       result.reasoning || '',
        key_signals:     result.key_signals || [],
        needs_review:    result.needs_review || false
      });
    }
  }

  // ── Bereken hoeveel categorieën gewijzigd zijn ────────────────────────────
  let changed = 0;
  for (const r of results) {
    const original = originalCategories.get(r.uid);
    if (original && original !== r.category) changed++;
  }

  console.log(`[reanalyze-all] ${emails.length} mails, ${groups.size} groepen, ${analyzed} AI-aanroepen, ${changed} gewijzigd, ${errors} fouten`);

  // Fase 2: bulk-persist classifications. Mailbox per uid uit input.
  const mailboxByUid = new Map(emails.filter(e => e.uid && e.mailbox).map(e => [e.uid, e.mailbox]));
  const upsertRows = results
    .filter(r => mailboxByUid.has(r.uid))
    .map(r => ({
      email_uid:          r.uid,
      mailbox:            mailboxByUid.get(r.uid),
      category:           r.category || null,
      requires_action:    typeof r.requires_action === 'boolean' ? r.requires_action : null,
      confidence:         typeof r.confidence === 'number' ? Math.round(r.confidence) : null,
      source:             r.source || null,
      priority:           r.priority || null,
      reasoning:          r.reasoning || null,
      key_signals:        Array.isArray(r.key_signals) && r.key_signals.length ? r.key_signals : null,
      classified_at:      new Date().toISOString(),
      classifier_version: CLASSIFIER_VERSION,
    }));
  if (upsertRows.length) {
    // Fire-and-forget. Bij fout: gelogd, response niet geblokkeerd.
    supabaseAdmin.from('email_classifications').upsert(upsertRows, { onConflict: 'email_uid' })
      .then(({ error }) => {
        if (error) console.warn('[reanalyze-all] bulk classification upsert fout:', error.message);
        else console.log(`[reanalyze-all] ${upsertRows.length} classifications persisted`);
      });
  }

  return res.status(200).json({
    results,
    summary: {
      total:    emails.length,
      analyzed: groups.size,
      grouped:  emails.length - groups.size,
      changed,
      errors
    }
  });
}
