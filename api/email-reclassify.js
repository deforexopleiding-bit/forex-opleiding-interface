// api/email-reclassify.js
// Herclassificeer bestaande mails in email_messages met de huidige classifier.
//
// POST body:
//   mode             'preview' (dry-run, schrijft niets) | 'execute' (DB-update)   default 'preview'
//   scope            'test-batch' (geen categorie-filter) | 'old-categories'
//                    (Factuurvraag/Klantvraag/Overig) | 'custom' (categories[])    default 'test-batch'
//   categories       string[]  — alleen bij scope 'custom'
//   limit            getal — mails per request (klein houden i.v.m. Vercel-timeout)  default 5
//   offset           getal — alleen zinvol in preview-paging                         default 0
//   skipReclassified true → sla mails over die al gemarkeerd zijn                     default true
//
// Resumable: in execute-mode krijgt elke verwerkte mail de marker in category_reason
// ([bron: reclassify-2026-05-22] …). Met skipReclassified=true schuift elke vervolg-
// call automatisch op naar de nog niet verwerkte mails — herhaal tot processed === 0.

import { supabaseAdmin } from './supabase.js';
import { categorize } from './email-agent.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

const MARKER          = 'reclassify-2026-05-22';
const OLD_CATEGORIES  = ['Factuurvraag', 'Klantvraag', 'Overig'];
const DEFAULT_LIMIT   = 5;
const MAX_LIMIT       = 50;
const PAUSE_MS        = 200; // kleine pauze tussen classificaties

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // RBAC (fail-open): alleen 403 bij bewezen-geen-permission.
  if (!(await requirePermissionFailOpen(req, 'email.reclassify.run'))) {
    return res.status(403).json({ error: 'Insufficient permissions', feature: 'email.reclassify.run' });
  }

  const {
    mode             = 'preview',
    scope            = 'test-batch',
    categories,
    limit,
    offset           = 0,
    skipReclassified = true,
  } = req.body || {};

  const batch = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const from  = Math.max(0, Number(offset) || 0);

  try {
    // ── Query opbouwen (alleen kolommen die de live-writers gebruiken) ──────
    let query = supabaseAdmin
      .from('email_messages')
      .select('id, mailbox, imap_uid, subject, from_address, from_name, snippet, category, requires_action, category_reason, date_received')
      .order('date_received', { ascending: false })
      .range(from, from + batch - 1);

    if (scope === 'old-categories') {
      query = query.in('category', OLD_CATEGORIES);
    } else if (scope === 'custom' && Array.isArray(categories) && categories.length > 0) {
      query = query.in('category', categories);
    }

    // Al-gemarkeerde mails overslaan (NULL category_reason telt als 'nog niet gedaan')
    if (skipReclassified) {
      query = query.or(`category_reason.is.null,category_reason.not.ilike.*${MARKER}*`);
    }

    const { data: emails, error: queryError } = await query;
    if (queryError) {
      return res.status(500).json({ error: queryError.message });
    }
    if (!emails || emails.length === 0) {
      return res.status(200).json({
        mode, scope, processed: 0, total: 0, results: [],
        message: 'Geen mails meer te herclassificeren voor deze scope.',
      });
    }

    const results = [];

    // Sequentieel: 1 mail tegelijk (rate-limit-vriendelijk)
    for (const email of emails) {
      try {
        const cat = await categorize({
          from:        email.from_address || '',
          subject:     email.subject      || '',
          bodySnippet: email.snippet      || '',
          date:        email.date_received || '',
        });

        const newCategory       = cat.category        || email.category;
        const newRequiresAction = cat.requires_action ?? email.requires_action;
        const changed =
          newCategory !== email.category ||
          newRequiresAction !== email.requires_action;

        if (mode === 'execute') {
          // Altijd schrijven (ook ongewijzigd) zodat de marker de mail markeert
          // als verwerkt — dat maakt skipReclassified resumable.
          const { error: updErr } = await supabaseAdmin
            .from('email_messages')
            .update({
              category:            newCategory,
              requires_action:     newRequiresAction,
              category_confidence: cat.confidence ?? null,
              category_reason:     `[bron: ${MARKER}] ${cat.reasoning || cat.source || ''}`.trim(),
            })
            .eq('id', email.id);
          if (updErr) throw new Error(updErr.message);
        }

        results.push({
          id:                email.id,
          mailbox:           email.mailbox,
          imap_uid:          email.imap_uid,
          subject:           email.subject,
          oldCategory:       email.category,
          newCategory,
          oldRequiresAction: email.requires_action,
          newRequiresAction,
          changed,
          source:            cat.source,
          confidence:        cat.confidence,
        });
      } catch (err) {
        results.push({ id: email.id, subject: email.subject, error: err.message });
      }

      if (PAUSE_MS) await new Promise((r) => setTimeout(r, PAUSE_MS));
    }

    const ok = results.filter((r) => !r.error);
    return res.status(200).json({
      mode,
      scope,
      processed: results.length,
      total:     emails.length,
      results,
      summary: {
        changed:   ok.filter((r) => r.changed).length,
        unchanged: ok.filter((r) => !r.changed).length,
        errors:    results.filter((r) => r.error).length,
        byCategory: ok.reduce((acc, r) => {
          acc[r.newCategory] = (acc[r.newCategory] || 0) + 1;
          return acc;
        }, {}),
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
