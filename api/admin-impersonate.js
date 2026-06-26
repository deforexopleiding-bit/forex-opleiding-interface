// api/admin-impersonate.js
//
// Server-side endpoint voor admin-impersonation ("Login als <user>").
// Mintt een eenmalig magiclink-token voor de target-user dat de client via
// supabase.auth.verifyOtp inwisselt voor een sessie. Geen mail; geen
// uitlog-side-effects op bestaande target-sessies.
//
// POST /api/admin-impersonate
// Body: { target_user_id: string }
// Response 200: { ok:true, token_hash, type:'magiclink',
//                 target: { id, name, email, role } }
//
// SECURITY (autoritatief server-side; client-side knop-zichtbaarheid is
// uitsluitend UX):
//   1. Bearer-token + verifyAdmin → caller moet authenticated admin zijn.
//   2. Caller-rol moet expliciet super_admin OR manager zijn. 'admin'-rol
//      uit ADMIN_ROLES krijgt 403 hier; impersonation is voorbehouden aan
//      super_admin / manager. (verifyAdmin laat 'admin' wel door op andere
//      endpoints; deze tweede check is strikter.)
//   3. Target mag NIET de caller zelf zijn.
//   4. Target mag NOOIT super_admin zijn (anti-escalatie hard).
//   5. Als caller manager is: target.role MOET in { sales, mentor, marketing,
//      administratie, viewer } zitten. Manager kan geen admin/manager/
//      super_admin impersoneren (anti-laterale-escalatie).
//   6. Audit-log per succesvolle mint (action='admin.impersonate.start').
//      Fail-soft (audit-fout breekt business-actie niet, zelfde patroon
//      als audit-customer.js).
//
// generateLink met type='magiclink' via service-role mint een single-use
// token zonder mail; bestaande target-sessies blijven werken (alleen een
// nieuw token komt erbij). hashed_token wordt aan de client gegeven; de
// caller mint zelf geen sessie hier (alleen het token-hash).

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rollen die een MANAGER mag impersoneren. Sales/mentor/marketing/
// administratie/viewer. Bewust NIET admin/manager/super_admin.
const MANAGER_TARGET_ROLES = new Set([
  'sales', 'mentor', 'marketing', 'administratie', 'viewer',
]);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ── Auth ──────────────────────────────────────────────────────────────
  const admin = await verifyAdmin(req);
  if (!admin) {
    return res.status(401).json({ error: 'Niet geauthenticeerd of geen admin-rol' });
  }
  const callerRole = admin.profile.role;
  // Strikter dan ADMIN_ROLES: 'admin' is uitgesloten. Alleen super_admin en
  // manager mogen impersoneren.
  if (callerRole !== 'super_admin' && callerRole !== 'manager') {
    return res.status(403).json({ error: 'Alleen super_admin of manager mag impersoneren' });
  }
  const callerId = admin.user.id;

  // ── Body-validatie ────────────────────────────────────────────────────
  const body = req.body || {};
  const targetId = typeof body.target_user_id === 'string' ? body.target_user_id.trim() : '';
  if (!targetId) return res.status(400).json({ error: 'target_user_id vereist' });
  if (!UUID_RE.test(targetId)) {
    return res.status(400).json({ error: 'target_user_id moet geldige uuid zijn' });
  }
  if (targetId === callerId) {
    return res.status(400).json({ error: 'Kan jezelf niet impersoneren' });
  }

  try {
    // ── Target ophalen ──────────────────────────────────────────────────
    const { data: target, error: targetErr } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role, is_active')
      .eq('id', targetId)
      .maybeSingle();
    if (targetErr) {
      console.error('[admin-impersonate] target lookup:', targetErr.message);
      return res.status(500).json({ error: 'Target-lookup faalde' });
    }
    if (!target) return res.status(404).json({ error: 'Target niet gevonden' });
    if (!target.is_active) {
      return res.status(403).json({ error: 'Target-account is gedeactiveerd' });
    }
    if (!target.email) {
      // Een user zonder e-mail kan geen magiclink ontvangen; should-not-happen
      // in normale flow maar fail-closed bij ontbreken.
      return res.status(400).json({ error: 'Target heeft geen e-mailadres' });
    }

    // ── Anti-escalatie ──────────────────────────────────────────────────
    // (a) super_admin is NOOIT impersoneerbaar (ook niet door een super_admin).
    if (target.role === 'super_admin') {
      return res.status(403).json({ error: 'super_admin is niet impersoneerbaar' });
    }
    // (b) Manager mag alleen sales/mentor/marketing/administratie/viewer.
    if (callerRole === 'manager' && !MANAGER_TARGET_ROLES.has(target.role)) {
      return res.status(403).json({
        error: `Manager mag rol '${target.role}' niet impersoneren`,
      });
    }

    // ── Token minten (magiclink, single-use, zonder mail) ──────────────
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type:  'magiclink',
      email: target.email,
    });
    if (linkErr) {
      console.error('[admin-impersonate] generateLink:', linkErr.message);
      return res.status(500).json({ error: 'Token-mint faalde: ' + linkErr.message });
    }
    const tokenHash = linkData?.properties?.hashed_token;
    if (!tokenHash) {
      return res.status(500).json({ error: 'generateLink retourneerde geen hashed_token' });
    }

    // ── Audit-log (fail-soft) ───────────────────────────────────────────
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     callerId,
        action:      'admin.impersonate.start',
        entity_type: 'user',
        entity_id:   target.id,
        before_json: null,
        after_json: {
          caller_role:  callerRole,
          target_email: target.email,
          target_role:  target.role,
          target_name:  target.full_name || null,
        },
        reason_text: `Impersonation door ${callerRole} → ${target.role}`,
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.error('[admin-impersonate] audit insert failed:', e?.message || e);
      // Fail-soft: audit-fout breekt impersonation niet (consistent met
      // audit-customer.js-patroon).
    }

    // ── Return ──────────────────────────────────────────────────────────
    // Token_hash is de enige secret die naar de client gaat; verifyOtp
    // werkt single-use + kortlevend (Supabase default ~1h).
    return res.status(200).json({
      ok:    true,
      token_hash: tokenHash,
      type:  'magiclink',
      target: {
        id:    target.id,
        name:  target.full_name || target.email,
        email: target.email,
        role:  target.role,
      },
    });
  } catch (e) {
    console.error('[admin-impersonate] exception:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
