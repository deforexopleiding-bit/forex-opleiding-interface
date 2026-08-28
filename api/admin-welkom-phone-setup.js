// api/admin-welkom-phone-setup.js
//
// Eenmalig super_admin-gated endpoint dat:
//   1) De WABA-nummers ophaalt via Meta Graph API
//      GET https://graph.facebook.com/v21.0/{WABA_ID}/phone_numbers
//   2) De volledige lijst teruggeeft (display_phone_number + id + verified_name).
//   3) De rij zoekt met display_phone_number = +31644642495 en, indien gevonden,
//      upsert't in whatsapp_module_config (module='welkom', phone_number_id=<id>,
//      display_label='Welkom (0644642495)', is_active=true).
//   4) Als +31644642495 NIET in de lijst staat → GEEN upsert, meld dat expliciet
//      in de response (het nummer is dan niet als Cloud-API-nummer aan onze
//      WABA gekoppeld; motor moet dan via GHL sturen i.p.v. Meta Cloud direct).
//
// Auth: Bearer JWT → profiles.role === 'super_admin'.
// Env: META_WHATSAPP_ACCESS_TOKEN (bestaand, Sensitive).
// WABA-ID: 990429800401598 (hardcoded — dit endpoint is eenmalig voor
//          setup van het welkom-nummer onder onze bestaande WABA).
//
// GET  ?dry_run=1  → lijst alleen tonen, geen upsert (voor eerste inspectie).
// POST             → lijst + upsert bij match.
//
// 0 incasso-writes. Raakt alleen public.whatsapp_module_config (module='welkom').

import { createUserClient, supabaseAdmin } from './supabase.js';
import fetch from 'node-fetch';

const WABA_ID           = '990429800401598';
const GRAPH_API_VERSION = 'v21.0';
const TARGET_NUMBER     = '+31644642495';
const WELKOM_LABEL      = 'Welkom (0644642495)';

function normalisePhone(v) {
  if (!v) return '';
  const s = String(v).trim();
  // Meta geeft soms al met '+', soms zonder — normaliseer naar +<digits>.
  const digits = s.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  return '+' + digits.replace(/^0+/, '');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET of POST only' });
  }

  // Auth: super_admin gate (zelfde pattern als admin-whatsapp-module-upsert).
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile, error: profErr } = await supabaseAdmin
    .from('profiles').select('id, role, is_active').eq('id', user.id).single();
  if (profErr || !profile)   return res.status(403).json({ error: 'Geen profiel gevonden' });
  if (!profile.is_active)    return res.status(403).json({ error: 'Account inactief' });
  if (profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin' });
  }

  const token = process.env.META_WHATSAPP_ACCESS_TOKEN || null;
  if (!token) return res.status(503).json({ error: 'META_WHATSAPP_ACCESS_TOKEN ontbreekt in env' });

  // Meta Graph API — nummers ophalen.
  let ghlBody = null;
  let ghlStatus = 0;
  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WABA_ID}/phone_numbers`;
    const r = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    ghlStatus = r.status;
    try { ghlBody = await r.json(); } catch (_) { ghlBody = null; }
    if (!r.ok) {
      return res.status(502).json({
        error: 'Meta Graph API fout',
        graph_status: ghlStatus,
        graph_body: ghlBody,
      });
    }
  } catch (e) {
    return res.status(502).json({ error: 'Meta Graph API exception', detail: e?.message || String(e) });
  }

  const rawList = Array.isArray(ghlBody?.data) ? ghlBody.data : [];
  const nummers = rawList.map((r) => ({
    display_phone_number: r.display_phone_number || null,
    id                  : r.id || null,
    verified_name       : r.verified_name || null,
    quality_rating      : r.quality_rating || null,
    code_verification_status: r.code_verification_status || null,
    platform_type       : r.platform_type || null,
  }));

  // Zoek target-nummer (+31644642495) via genormaliseerd formaat.
  const targetNorm = normalisePhone(TARGET_NUMBER);
  const match = nummers.find((n) => normalisePhone(n.display_phone_number) === targetNorm);

  const dryRun = req.method === 'GET' || String((req.query || {}).dry_run || '') === '1';

  if (!match) {
    return res.status(200).json({
      ok        : true,
      upserted  : false,
      reason    : `${TARGET_NUMBER} niet in de WABA-lijst — nummer is niet als Cloud-API-nummer aan WABA ${WABA_ID} gekoppeld. Voor deze funnel moet er via GHL Conversations gestuurd worden i.p.v. Meta Cloud direct.`,
      target    : TARGET_NUMBER,
      waba_id   : WABA_ID,
      nummers,
    });
  }

  if (dryRun) {
    return res.status(200).json({
      ok        : true,
      upserted  : false,
      dry_run   : true,
      target    : TARGET_NUMBER,
      matched   : match,
      would_upsert: {
        module         : 'welkom',
        phone_number_id: match.id,
        display_label  : WELKOM_LABEL,
        is_active      : true,
      },
      nummers,
    });
  }

  // POST + match → upsert.
  try {
    const { data: upserted, error: upErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .upsert({
        module          : 'welkom',
        phone_number_id : String(match.id),
        display_label   : WELKOM_LABEL,
        is_active       : true,
        updated_at      : new Date().toISOString(),
      }, { onConflict: 'module' })
      .select('id, module, phone_number_id, display_label, is_active, created_at, updated_at')
      .maybeSingle();
    if (upErr) throw upErr;

    return res.status(200).json({
      ok       : true,
      upserted : true,
      row      : upserted,
      matched  : match,
      nummers,
    });
  } catch (e) {
    console.error('[admin-welkom-phone-setup] upsert:', e?.message || e);
    return res.status(500).json({ error: 'Upsert whatsapp_module_config mislukt', detail: e?.message || String(e) });
  }
}
