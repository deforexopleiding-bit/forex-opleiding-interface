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
  // Response-delay (F10.2)
  'response_delay_mode',
  'response_delay_fixed_seconds',
  'response_delay_min_seconds',
  'response_delay_max_seconds',
  'response_delay_per_phase',
  'typing_indicator_enabled',
  // Post-link follow-up (F13)
  'post_link_followup_enabled',
  'post_link_step1_hours',
  'post_link_step2_hours',
  'post_link_step3_hours',
];

const POST_LINK_HOUR_FIELDS = ['post_link_step1_hours', 'post_link_step2_hours', 'post_link_step3_hours'];

const DELAY_SECONDS_FIELDS = ['response_delay_fixed_seconds', 'response_delay_min_seconds', 'response_delay_max_seconds'];

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

      // ── Validatie response-delay (F10.2) ──
      if (updates.response_delay_mode !== undefined && !['fixed', 'random', 'per_phase'].includes(updates.response_delay_mode)) {
        return res.status(400).json({ error: 'Ongeldige response_delay_mode' });
      }
      for (const f of DELAY_SECONDS_FIELDS) {
        if (updates[f] !== undefined) {
          const n = parseInt(updates[f], 10);
          if (isNaN(n)) return res.status(400).json({ error: f + ' moet een getal zijn' });
          updates[f] = Math.max(0, Math.min(600, n));
        }
      }
      if (updates.response_delay_per_phase !== undefined) {
        const obj = updates.response_delay_per_phase;
        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
          return res.status(400).json({ error: 'response_delay_per_phase moet een object zijn' });
        }
        const clamped = {};
        for (const [k, v] of Object.entries(obj)) {
          const n = parseInt(v, 10);
          clamped[k] = isNaN(n) ? 45 : Math.max(0, Math.min(600, n));
        }
        updates.response_delay_per_phase = clamped;
      }
      if (updates.typing_indicator_enabled !== undefined) updates.typing_indicator_enabled = updates.typing_indicator_enabled === true;
      // Post-link (F13): uren 1-168, boolean.
      for (const f of POST_LINK_HOUR_FIELDS) {
        if (updates[f] !== undefined) {
          const n = parseInt(updates[f], 10);
          if (isNaN(n)) return res.status(400).json({ error: f + ' moet een getal zijn' });
          updates[f] = Math.max(1, Math.min(168, n));
        }
      }
      if (updates.post_link_followup_enabled !== undefined) updates.post_link_followup_enabled = updates.post_link_followup_enabled === true;
      // Consistentie: min ≤ max
      if (updates.response_delay_min_seconds !== undefined && updates.response_delay_max_seconds !== undefined
          && updates.response_delay_min_seconds > updates.response_delay_max_seconds) {
        const t = updates.response_delay_min_seconds; updates.response_delay_min_seconds = updates.response_delay_max_seconds; updates.response_delay_max_seconds = t;
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
