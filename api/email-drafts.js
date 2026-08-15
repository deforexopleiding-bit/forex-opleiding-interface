// api/email-drafts.js
//
// v2 E-mail Fase 2B — Concepten-CRUD (autosave + delete).
//
// GET  ?id=<uuid>              → 1 concept
// GET                          → user's concepten (updated_at DESC, limit 100)
// POST { id?, from_mailbox, to_address, cc_address, bcc_address, subject,
//        body_html, in_reply_to_email_id }
//                              → upsert; returnt volledige row
// DELETE { id }                → verwijderen
//
// Permission: email.module.access voor GET; email.reply.send voor mutaties.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function assertTable() {
  try {
    const probe = await supabaseAdmin.from('email_drafts').select('id').limit(1);
    if (probe.error && /relation.*email_drafts.*does not exist/i.test(probe.error.message || '')) {
      return { ok: false, error: 'Migratie 2026-08-15-email-v2-fase-2b.sql moet eerst gedraaid worden (tabel email_drafts ontbreekt).' };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message || 'db check fail' }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const t = await assertTable();
  if (!t.ok) return res.status(503).json({ error: t.error, migration_required: '2026-08-15-email-v2-fase-2b.sql' });

  try {
    if (req.method === 'GET') {
      if (!(await requirePermission(req, 'email.module.access'))) {
        return res.status(403).json({ error: 'Geen rechten (email.module.access)' });
      }
      const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
      if (id) {
        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id niet uuid' });
        const { data, error } = await supabaseAdmin
          .from('email_drafts').select('*').eq('id', id).eq('user_id', user.id).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Concept niet gevonden' });
        return res.status(200).json({ item: data });
      }
      const { data, error } = await supabaseAdmin
        .from('email_drafts').select('*')
        .eq('user_id', user.id).order('updated_at', { ascending: false }).limit(100);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ items: data || [] });
    }

    if (req.method === 'POST') {
      if (!(await requirePermission(req, 'email.reply.send'))) {
        return res.status(403).json({ error: 'Geen rechten (email.reply.send)' });
      }
      const b = req.body || {};
      const draft = {
        user_id: user.id,
        from_mailbox:        b.from_mailbox ? String(b.from_mailbox).slice(0, 200) : null,
        to_address:          b.to_address   ? String(b.to_address).slice(0, 500)   : null,
        cc_address:          b.cc_address   ? String(b.cc_address).slice(0, 500)   : null,
        bcc_address:         b.bcc_address  ? String(b.bcc_address).slice(0, 500)  : null,
        subject:             b.subject      ? String(b.subject).slice(0, 500)      : null,
        body_html:           b.body_html    ? String(b.body_html).slice(0, 500000) : null,
        in_reply_to_email_id:b.in_reply_to_email_id ? String(b.in_reply_to_email_id).slice(0, 300) : null,
        updated_at:          new Date().toISOString(),
      };
      const id = b.id ? String(b.id).trim() : '';
      let result;
      if (id) {
        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id niet uuid' });
        const { data, error } = await supabaseAdmin
          .from('email_drafts').update(draft).eq('id', id).eq('user_id', user.id).select('*').maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Concept niet gevonden' });
        result = data;
      } else {
        const { data, error } = await supabaseAdmin
          .from('email_drafts').insert(draft).select('*').maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        result = data;
      }
      return res.status(200).json({ item: result });
    }

    if (req.method === 'DELETE') {
      if (!(await requirePermission(req, 'email.reply.send'))) {
        return res.status(403).json({ error: 'Geen rechten (email.reply.send)' });
      }
      const b = req.body || {};
      const id = b.id ? String(b.id).trim() : (typeof req.query?.id === 'string' ? req.query.id.trim() : '');
      if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) verplicht' });
      const { error, count } = await supabaseAdmin
        .from('email_drafts').delete({ count: 'exact' }).eq('id', id).eq('user_id', user.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, deleted: count || 0 });
    }

    return res.status(405).json({ error: 'GET / POST / DELETE only' });
  } catch (e) {
    console.error('[email-drafts]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
