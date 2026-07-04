// api/voys-call.js
//
// Fase 4 — cockpit click-to-call via de moderne Voys-API (holodeck).
// Exact request-contract nog niet 100% bevestigd — daarom zijn AUTH_STYLE
// en BODY_STYLE via env instelbaar en loggen we bij fout de ruwe Voys-
// response terug (max 800 chars) zodat we na de 1e live-test met 1
// env-wissel kunnen finetunen. Token/uuid ALLEEN uit env, NOOIT in logs
// of response terugsturen.
//
// POST body: { lead_id?: uuid, to_number: string, from_number?: string }
//
// Response:
//   200 { ok:true, call:<geparste voys-response of {status:'dialing'}> }
//   401 niet ingelogd; 403 geen rol
//   400 to_number ontbreekt / lead_id ongeldig
//   501 { code:'VOYS_NOT_CONFIGURED' } als token/uuid/a_number ontbreken
//   502 { ok:false, error, voys_status, voys_body } als Voys 4xx/5xx of throw
//
// Env-vars:
//   VOYS_API_TOKEN     — verplicht (Sensitive)
//   VOYS_CLIENT_UUID   — verplicht (Sensitive)
//   VOYS_A_NUMBER      — verplicht: intern nummer waarop de webphone
//                        rinkelt (bijv. +31201234567 of interne 202)
//   VOYS_CALL_URL      — default 'https://api.eu-production.holodeck.voys.nl/clicktodial/'
//   VOYS_AUTH_STYLE    — 'apitoken' (default) | 'bearer' | 'query'
//   VOYS_BODY_STYLE    — 'holodeck' (default) | 'voipgrid'

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Strip alles behalve digits + leading '+'. Voys accepteert internationale
// notatie (E.164). NL/BE-nummers zonder + krijgen geen automatische
// prefix — de aanroeper moet het correcte formaat aanleveren (uit lead-
// telefoon, die door sync-integraties in E.164 staat).
function normalizePhone(input) {
  if (!input) return '';
  let s = String(input).trim();
  // Verwijder haakjes, spaties, streepjes, punten.
  s = s.replace(/[\s()\-.]/g, '');
  // Alleen '+' toestaan aan de start.
  if (s.startsWith('+')) {
    return '+' + s.slice(1).replace(/\D/g, '');
  }
  return s.replace(/\D/g, '');
}

async function logCallNote(leadId, userId, text) {
  if (!leadId || !UUID_RE.test(leadId)) return;
  const trimmed = String(text || '').slice(0, 4000);
  const p1 = { lead_id: leadId, note: trimmed, created_by_user_id: userId, entry_kind: 'call', outcome_code: 'call' };
  const p2 = { lead_id: leadId, note: trimmed, created_by_user_id: userId, entry_kind: 'call' };
  const p3 = { lead_id: leadId, note: trimmed, created_by_user_id: userId };
  for (const p of [p1, p2, p3]) {
    const { error } = await supabaseAdmin.from('follow_up_lead_notes').insert(p);
    if (!error) return;
    if (error.code !== '42703') { console.warn('[voys-call] note insert:', error.message); return; }
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  // ── Env-configuratie ── (niets hardcoden; sensitive keys NIET loggen)
  const token      = process.env.VOYS_API_TOKEN     || '';
  const clientUuid = process.env.VOYS_CLIENT_UUID   || '';
  const aNumber    = process.env.VOYS_A_NUMBER      || '';
  const url        = process.env.VOYS_CALL_URL      || 'https://api.eu-production.holodeck.voys.nl/clicktodial/';
  const authStyle  = String(process.env.VOYS_AUTH_STYLE || 'apitoken').toLowerCase();
  const bodyStyle  = String(process.env.VOYS_BODY_STYLE || 'holodeck').toLowerCase();

  if (!token || !clientUuid || !aNumber) {
    return res.status(501).json({
      code    : 'VOYS_NOT_CONFIGURED',
      error   : 'Voys nog niet geconfigureerd',
      missing : {
        VOYS_API_TOKEN  : !token,
        VOYS_CLIENT_UUID: !clientUuid,
        VOYS_A_NUMBER   : !aNumber,
      },
    });
  }

  const body   = (req.body && typeof req.body === 'object') ? req.body : {};
  const leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';
  if (leadId && !UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ongeldig' });
  const toNumber   = normalizePhone(body.to_number);
  const fromNumber = normalizePhone(body.from_number) || null;
  if (!toNumber) return res.status(400).json({ error: 'to_number vereist' });

  // ─────────────── VOYS REQUESTCONFIG (blok bewust hier + duidelijk
  // gemarkeerd zodat we na de 1e live-test snel kunnen finetunen door
  // env te wisselen of dit blokje aan te passen). ────────────────────
  //
  // AUTH-STYLE
  //   'apitoken' → Authorization: Api-Token <token>
  //                X-Client-UUID: <clientUuid>
  //   'bearer'   → Authorization: Bearer <token>
  //                X-Client-UUID: <clientUuid>
  //   'query'    → token+client_uuid als query-string (?api_token=...&client_uuid=...)
  //
  // BODY-STYLE
  //   'holodeck' → { caller: aNumber, callee: toNumber, caller_id: fromNumber|null, client_uuid: clientUuid }
  //   'voipgrid' → { a_number: aNumber, b_number: toNumber }
  // ────────────────────────────────────────────────────────────────
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  let effectiveUrl = url;
  if (authStyle === 'bearer') {
    headers['Authorization'] = 'Bearer ' + token;
    headers['X-Client-UUID'] = clientUuid;
  } else if (authStyle === 'query') {
    const sep = url.includes('?') ? '&' : '?';
    effectiveUrl = url + sep + 'api_token=' + encodeURIComponent(token) + '&client_uuid=' + encodeURIComponent(clientUuid);
  } else {
    // 'apitoken' — default
    headers['Authorization'] = 'Api-Token ' + token;
    headers['X-Client-UUID'] = clientUuid;
  }

  let requestBody;
  if (bodyStyle === 'voipgrid') {
    requestBody = { a_number: aNumber, b_number: toNumber };
  } else {
    // 'holodeck' — default
    requestBody = {
      caller     : aNumber,
      callee     : toNumber,
      caller_id  : fromNumber || null,
      client_uuid: clientUuid,
    };
  }

  // ── Uitvoer + error-mapping ──
  let voysStatus = 0;
  let voysBodyText = '';
  try {
    const resp = await fetch(effectiveUrl, {
      method : 'POST',
      headers,
      body   : JSON.stringify(requestBody),
    });
    voysStatus = resp.status;
    voysBodyText = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(voysBodyText); } catch (_) { /* keep raw */ }

    if (resp.ok) {
      // Best-effort call-note (fail-soft).
      try {
        await logCallNote(leadId, user.id, 'Uitgaand gebeld via Voys' + (fromNumber ? ` (caller-ID ${fromNumber})` : ''));
      } catch (nErr) { console.warn('[voys-call] note fail:', nErr?.message || nErr); }
      return res.status(200).json({
        ok       : true,
        call     : parsed || { status: 'dialing' },
        auth_style: authStyle,
        body_style: bodyStyle,
      });
    }

    // Voys returnde 4xx/5xx: log ruwe body voor debug (zonder token/uuid).
    console.error('[voys-call] Voys ' + voysStatus + ':', voysBodyText.slice(0, 800));
    return res.status(502).json({
      ok         : false,
      error      : 'Voys-call mislukt',
      voys_status: voysStatus,
      voys_body  : voysBodyText.slice(0, 800),
      auth_style : authStyle,
      body_style : bodyStyle,
    });
  } catch (e) {
    console.error('[voys-call] request error:', e?.message || e);
    return res.status(502).json({
      ok         : false,
      error      : 'Voys-call mislukt (network)',
      voys_status: voysStatus,
      voys_body  : (voysBodyText || String(e?.message || e || '')).slice(0, 800),
      auth_style : authStyle,
      body_style : bodyStyle,
    });
  }
}
