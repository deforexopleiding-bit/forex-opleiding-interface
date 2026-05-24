// api/lisa-settings.js
// Singleton runtime-settings voor Lisa (lisa_settings, id=1 — migratie 005).
//   GET                → huidige settings
//   POST/PATCH {...}   → live_mode_enabled / office_hours_* / ghl_webhook_active bijwerken
//
// Auth: verifyAdmin (hard). Schrijven achter requirePermissionFailOpen('lisa.config.publish')
// (live-mode aan/uit is een publicatie-niveau actie) via supabaseAdmin (RLS = super_admin only).

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

const ALLOWED_FIELDS = [
  'live_mode_enabled',
  'office_hours_start',
  'office_hours_end',
  'office_hours_timezone',
  'ghl_webhook_active',
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = await verifyAdmin(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin.from('lisa_settings').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      return res.status(200).json({ settings: data });
    }

    if (req.method === 'POST' || req.method === 'PATCH') {
      if (!(await requirePermissionFailOpen(req, 'lisa.config.publish'))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const body = req.body || {};
      const updates = {};
      for (const f of ALLOWED_FIELDS) if (body[f] !== undefined) updates[f] = body[f];
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Geen velden om bij te werken' });

      if ('live_mode_enabled' in updates) {
        updates.live_mode_enabled = !!updates.live_mode_enabled;
        updates.live_mode_changed_by = auth.user.id;
      }

      const { data, error } = await supabaseAdmin.from('lisa_settings').update(updates).eq('id', 1).select().single();
      if (error) throw error;
      return res.status(200).json({ settings: data });
    }

    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('lisa-settings error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
