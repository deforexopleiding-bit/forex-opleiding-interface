// api/sidebar-layout-save.js
//
// POST → schrijft de sidebar-layout config naar app_settings.
//
// Per-rol layouts:
//   - Body.role afwezig / leeg / 'default' → key = 'sidebar_layout' (globale
//     standaard; bestaand gedrag, backward-compatible).
//   - Body.role ∈ ALLOWED_ROLES              → key = 'sidebar_layout:<role>'.
//   - Andere body.role waarde                → 400.
// Sidebar.js leest de hoogste-rol-layout van de ingelogde user (precedence:
// super_admin > manager > sales > mentor > marketing > administratie) en valt
// fail-open terug op 'sidebar_layout' bij ontbreken.
//
// Gate: requirePermission('admin.sidebar') ÓF super_admin-rol.
//   - super_admin (bypass-rol, perms='*') mag altijd schrijven.
//   - Andere rollen alleen met expliciete feature_key 'admin.sidebar'.
//   - Endpoint is autoritatief; sidebar.js is fail-open op de lees-kant maar
//     vertrouwt op deze gate voor schrijf-veiligheid.
//
// Reads via /api/app-settings?key=sidebar_layout(:role) (al-aanwezige GET,
// elke ingelogde user). Geen aparte read-endpoint nodig.
//
// Body:
//   {
//     role?: 'default' | 'super_admin' | 'manager' | 'sales' | 'mentor'
//                      | 'marketing'   | 'administratie',
//     items: [
//       { key: 'dashboard', visible: true  },
//       { key: 'email',     visible: false, group: 'Klanten & Support' },
//       ...
//     ]
//   }
//
// Validatie:
//   - items is array (verplicht, max 64 entries).
//   - Per item: { key: string ≤ 64 chars, visible: boolean, group?: string }.
//     group is optioneel; als aanwezig moet het een string ≤ 48 chars zijn.
//     Leeg/ontbrekend group = item is ongegroepeerd (plat gerenderd).
//   - 'admin' wordt server-side ALTIJD op visible=true geforceerd (anti-
//     lockout: zonder admin-link kan een super_admin/admin niet meer naar
//     de manager om 'm weer aan te zetten).
//
// Audit-log fail-soft (zelfde patroon als app-settings.js).

import { createUserClient, supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const MAX_ITEMS = 64;
const MAX_KEY_LEN = 64;
const MAX_GROUP_LEN = 48;
const ALLOWED_ROLES = ['super_admin', 'manager', 'sales', 'mentor', 'marketing', 'administratie'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ── Auth + gate ─────────────────────────────────────────────────────────
  const supabase = createUserClient(req);
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Super_admin bypass; anders verplicht admin.sidebar.
  const admin = await verifyAdmin(req);
  const isSuperAdmin = !!(admin && admin.profile && admin.profile.role === 'super_admin');
  if (!isSuperAdmin) {
    const ok = await requirePermission(req, 'admin.sidebar');
    if (!ok) return res.status(403).json({ error: 'Geen rechten (admin.sidebar)' });
  }

  // ── Validatie ───────────────────────────────────────────────────────────
  const body = req.body || {};
  // Per-rol layout-key resolutie (leeg/'default' = globale standaard, backward-
  // compatible). Onbekende rol-string → 400.
  const rawRole = typeof body.role === 'string' ? body.role.trim() : '';
  let settingsKey;
  if (!rawRole || rawRole === 'default') {
    settingsKey = 'sidebar_layout';
  } else if (ALLOWED_ROLES.includes(rawRole)) {
    settingsKey = 'sidebar_layout:' + rawRole;
  } else {
    return res.status(400).json({ error: 'onbekende role' });
  }
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items) return res.status(400).json({ error: 'items: array vereist' });
  if (items.length > MAX_ITEMS) return res.status(400).json({ error: `Max ${MAX_ITEMS} items` });

  const seen = new Set();
  const normalized = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') {
      return res.status(400).json({ error: 'item moet object zijn' });
    }
    const key = String(raw.key || '').trim();
    if (!key || key.length > MAX_KEY_LEN || !/^[a-z0-9-]+$/i.test(key)) {
      return res.status(400).json({ error: `Ongeldige item-key: ${key || '(leeg)'}` });
    }
    if (seen.has(key)) {
      return res.status(400).json({ error: `Duplicate item-key: ${key}` });
    }
    seen.add(key);
    // Admin-entry kan nooit verborgen worden (anti-lockout); forceer visible=true.
    const visible = key === 'admin' ? true : raw.visible !== false;
    // Optionele groepen (Fase 1). Aanwezig maar niet-string → 400. Leeg
    // (na trim) = ongegroepeerd, dus dan slaan we het veld niet op.
    let group = null;
    if (raw.group !== undefined && raw.group !== null) {
      if (typeof raw.group !== 'string') {
        return res.status(400).json({ error: `Ongeldige item-group voor key ${key} (moet string zijn)` });
      }
      const g = raw.group.trim().slice(0, MAX_GROUP_LEN);
      if (g) group = g;
    }
    const entry = { key, visible };
    if (group) entry.group = group;
    normalized.push(entry);
  }

  const value = { items: normalized };

  // ── Schrijven (upsert; zelfde 2-staps patroon als app-settings.js) ──────
  try {
    const { data: existing } = await supabaseAdmin
      .from('app_settings')
      .select('key')
      .eq('key', settingsKey)
      .maybeSingle();
    const row = {
      key: settingsKey,
      value,
      updated_by_user_id: user.id,
    };
    if (existing) {
      const { error } = await supabaseAdmin
        .from('app_settings')
        .update(row)
        .eq('key', settingsKey);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabaseAdmin
        .from('app_settings')
        .insert(row);
      if (error) throw new Error(error.message);
    }

    // Audit-log (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'app_settings.' + settingsKey + '.update',
        entity_type: 'app_setting',
        entity_id:   null,
        after_json:  value,
        reason_text: `Sidebar-layout bijgewerkt (${normalized.length} items, key=${settingsKey})`,
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[sidebar-layout-save] audit', e?.message || e); }

    return res.status(200).json({ success: true, items: normalized.length, key: settingsKey });
  } catch (e) {
    console.error('[sidebar-layout-save]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
