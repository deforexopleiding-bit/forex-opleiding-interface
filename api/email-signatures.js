// api/email-signatures.js
//
// v2 email-round DEEL 3 — Handtekening CRUD (globale + per-mailbox).
//
// GET                              → alle handtekeningen (global + per-mailbox)
// GET  ?mailbox=<slug>             → één handtekening (per-mailbox, met fallback
//                                    naar global als er geen per-mailbox is)
// POST { mailbox?, name, body_html, body_text, logo_url, is_active }
//                                  → upsert; alleen super_admin/admin/manager
// DELETE ?mailbox=<slug>           → verwijder per-mailbox (global blijft)
//
// mailbox = short-label ('info' / 'leads' / 'partners' / 'administratie' /
// 'onboarding' / 'events' / 'welkom'); leeg/null = globale default.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const KNOWN_MAILBOXES = ['info', 'leads', 'partners', 'administratie', 'onboarding', 'events', 'welkom'];

function normalizeMailbox(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  // Sta zowel 'info' als 'info@deforexopleiding.nl' toe.
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}

async function assertTable() {
  try {
    const probe = await supabaseAdmin.from('email_signatures').select('id').limit(1);
    if (probe.error && /relation.*email_signatures.*does not exist/i.test(probe.error.message || '')) {
      return { ok: false, error: 'Migratie 2026-08-16-email-templates-and-signatures.sql moet eerst gedraaid worden (tabel email_signatures ontbreekt).' };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message || 'db check fail' }; }
}

async function isElevatedRole(user) {
  try {
    const { data } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).maybeSingle();
    return !!data && ['super_admin', 'admin', 'manager'].includes(data.role);
  } catch (_) { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const t = await assertTable();
  if (!t.ok) return res.status(503).json({ error: t.error, migration_required: '2026-08-16-email-templates-and-signatures.sql' });

  try {
    if (req.method === 'GET') {
      if (!(await requirePermission(req, 'email.module.access'))) {
        return res.status(403).json({ error: 'Geen rechten (email.module.access)' });
      }
      const mailbox = normalizeMailbox(req.query?.mailbox);
      if (mailbox) {
        // Fallback-flow: per-mailbox rij wint van global.
        const { data, error } = await supabaseAdmin
          .from('email_signatures').select('*')
          .or(`mailbox.eq.${mailbox},mailbox.is.null`)
          .eq('is_active', true)
          .order('mailbox', { ascending: true, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ item: data || null });
      }
      const { data, error } = await supabaseAdmin
        .from('email_signatures').select('*').order('mailbox', { ascending: true, nullsFirst: true });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ items: data || [], mailboxes: KNOWN_MAILBOXES });
    }

    if (req.method === 'POST') {
      if (!(await isElevatedRole(user))) {
        return res.status(403).json({ error: 'Alleen super_admin/admin/manager mag handtekeningen beheren' });
      }
      const b = req.body || {};
      const mailbox = normalizeMailbox(b.mailbox);
      if (mailbox && !KNOWN_MAILBOXES.includes(mailbox)) {
        return res.status(400).json({ error: `Onbekende mailbox: ${mailbox}. Geldig: ${KNOWN_MAILBOXES.join(', ')} (of leeg voor globaal).` });
      }
      const payload = {
        mailbox: mailbox || null,
        name:      b.name      ? String(b.name).slice(0, 100) : 'Standaard',
        body_html: b.body_html ? String(b.body_html).slice(0, 100000) : '',
        body_text: b.body_text ? String(b.body_text).slice(0, 100000) : '',
        logo_url:  b.logo_url  ? String(b.logo_url).slice(0, 2000)   : null,
        is_active: b.is_active === false ? false : true,
        updated_by_user_id: user.id,
        updated_at: new Date().toISOString(),
      };
      // Upsert op mailbox-key (unique index enforced 1 rij per mailbox + 1
      // global). Voor global (mailbox=null) matched onze partial unique index
      // eq true. supabase.upsert accepteert alleen non-NULL onConflict — we
      // splitsen daarom: eerst SELECT, dan INSERT of UPDATE.
      const existing = await supabaseAdmin.from('email_signatures').select('id')
        .is('mailbox', mailbox === null ? null : undefined)
        .eq('mailbox', mailbox === null ? undefined : mailbox);
      // Bovenstaande query is niet 100% helder met .is + .eq afhankelijk van null;
      // gebruik expliciete branches:
      let existingId = null;
      if (mailbox === null) {
        const q = await supabaseAdmin.from('email_signatures').select('id').is('mailbox', null).maybeSingle();
        if (q.error) return res.status(500).json({ error: q.error.message });
        existingId = q.data?.id || null;
      } else {
        const q = await supabaseAdmin.from('email_signatures').select('id').eq('mailbox', mailbox).maybeSingle();
        if (q.error) return res.status(500).json({ error: q.error.message });
        existingId = q.data?.id || null;
      }
      let result;
      if (existingId) {
        result = await supabaseAdmin.from('email_signatures').update(payload).eq('id', existingId).select('*').maybeSingle();
      } else {
        result = await supabaseAdmin.from('email_signatures').insert(payload).select('*').maybeSingle();
      }
      if (result.error) return res.status(500).json({ error: result.error.message });
      return res.status(200).json({ item: result.data });
    }

    if (req.method === 'DELETE') {
      if (!(await isElevatedRole(user))) {
        return res.status(403).json({ error: 'Alleen super_admin/admin/manager mag handtekeningen verwijderen' });
      }
      const mailbox = normalizeMailbox(req.query?.mailbox);
      if (!mailbox) return res.status(400).json({ error: 'Globale default kan niet verwijderd worden (alleen bewerkt).' });
      if (!KNOWN_MAILBOXES.includes(mailbox)) {
        return res.status(400).json({ error: `Onbekende mailbox: ${mailbox}` });
      }
      const { error } = await supabaseAdmin.from('email_signatures').delete().eq('mailbox', mailbox);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[email-signatures] fail:', e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
