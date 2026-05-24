// api/admin-lisa-backfill-names.js
// Backfill van contact-namen voor bestaande live-conversaties zonder naam, via de GHL Contacts API.
//   POST → verwerkt tot 100 conversaties (is_sandbox=false, contact_name IS NULL, ghl_contact_id aanwezig)
// Auth: verifyAdmin + requirePermissionFailOpen('lisa.config.publish').

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { getGhlContact } from './_lib/lisa-ghl-send.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = await verifyAdmin(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await requirePermissionFailOpen(req, 'lisa.config.publish'))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { data: convs } = await supabaseAdmin.from('lisa_conversations')
      .select('id, ghl_contact_id, contact_name')
      .eq('is_sandbox', false).is('contact_name', null).not('ghl_contact_id', 'is', null)
      .limit(100);

    if (!convs || convs.length === 0) {
      return res.status(200).json({ ok: true, processed: 0, updated: 0, failed: 0, message: 'Geen conversaties zonder naam' });
    }

    const results = { processed: 0, updated: 0, failed: 0, errors: [] };
    for (const conv of convs) {
      results.processed++;
      try {
        const c = await getGhlContact(conv.ghl_contact_id);
        if (!c) { results.failed++; continue; }
        const firstName = c.firstName || c.first_name || null;
        const lastName = c.lastName || c.last_name || null;
        const fullName = c.contactName || c.fullName || c.full_name || [firstName, lastName].filter(Boolean).join(' ').trim() || null;
        if (!fullName) { results.failed++; continue; }
        await supabaseAdmin.from('lisa_conversations')
          .update({ first_name: firstName, last_name: lastName, contact_name: fullName }).eq('id', conv.id);
        results.updated++;
      } catch (err) {
        results.failed++;
        results.errors.push({ id: conv.id, error: err?.message || 'onbekende fout' });
      }
    }

    return res.status(200).json({ ok: true, ...results });
  } catch (err) {
    console.error('backfill-names error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
