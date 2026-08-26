// api/display-token-admin.js
//
// Super_admin-only beheer van display_tokens (tv-dashboard-tokens).
//
// GET  ?action=list   → [{id, label, created_at, revoked_at, last_used_at, hit_count}]
// POST body: {action:'create', label:string}
//   → { id, label, plaintext } — plaintext ALLEEN in deze response, niet meer
//     ophaalbaar; server slaat SHA-256-hash op.
// POST body: {action:'revoke', id:uuid}
//   → { ok:true }
//
// Plaintext = 32 bytes random hex (64 chars). Rotatie: create nieuwe →
// tv-URL updaten → revoke oude. Nooit plaintext loggen.

import crypto from 'crypto';
import { supabaseAdmin, verifyAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const admin = await verifyAdmin(req);
  if (!admin || admin.profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin.' });
  }

  if (req.method === 'GET') {
    const action = String(req.query?.action || 'list');
    if (action !== 'list') return res.status(400).json({ error: 'Onbekende action' });
    const { data, error } = await supabaseAdmin
      .from('display_tokens')
      .select('id, label, created_at, created_by, revoked_at, last_used_at, hit_count')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ tokens: data || [] });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET of POST' });

  const body = req.body || {};
  const action = String(body.action || '');

  if (action === 'create') {
    const label = String(body.label || '').trim();
    if (!label || label.length > 60) return res.status(400).json({ error: 'label vereist (1-60 chars)' });
    const plaintext = crypto.randomBytes(32).toString('hex');
    const token_hash = crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
    const { data, error } = await supabaseAdmin
      .from('display_tokens')
      .insert({ token_hash, label, created_by: admin.user.id })
      .select('id, label, created_at')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    // Log ZONDER plaintext.
    console.log('[display-token-admin] created token id=' + data.id + ' label=' + label + ' by=' + admin.profile.email);
    return res.status(200).json({ id: data.id, label: data.label, created_at: data.created_at, plaintext });
  }

  if (action === 'revoke') {
    const id = String(body.id || '').trim();
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
    const { error } = await supabaseAdmin
      .from('display_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .is('revoked_at', null);
    if (error) return res.status(500).json({ error: error.message });
    console.log('[display-token-admin] revoked id=' + id + ' by=' + admin.profile.email);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'action moet list|create|revoke zijn' });
}
