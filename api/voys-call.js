// api/voys-call.js
//
// Fase 4 — cockpit click-to-call via de moderne Voys-API (holodeck).
// Exact request-contract nog niet 100% bevestigd — daarom zijn AUTH_STYLE
// en BODY_STYLE via env instelbaar en loggen we bij fout de ruwe Voys-
// response terug (max 800 chars) zodat we na de 1e live-test met 1
// env-wissel kunnen finetunen. Token/uuid ALLEEN uit env, NOOIT in logs
// of response terugsturen.
//
// Multi-account (NL + BE) sinds 2026-08-23:
// - Landroutering op basis van to_number (+32 / 0032 → BE, anders NL),
//   consistent met klx-softphone.detectLine.
// - Expliciete override via body.line ('nl' | 'be' | 'auto', default 'auto').
// - BE-account gebruikt eigen credentials (VOYS_BE_*). Als de gekozen lijn
//   niet geconfigureerd is → 501 VOYS_<LINE>_NOT_CONFIGURED. GEEN stille
//   fallback naar NL (verkeerde caller-ID naar buiten bellen = fout signaal).
//
// POST body: { lead_id?: uuid, to_number: string, from_number?: string,
//              line?: 'nl'|'be'|'auto' }
//
// Response:
//   200 { ok:true, call:<geparste voys-response of {status:'dialing'}>, line:'nl'|'be' }
//   401 niet ingelogd; 403 geen rol
//   400 to_number ontbreekt / lead_id ongeldig / line ongeldig
//   501 { code:'VOYS_NL_NOT_CONFIGURED' | 'VOYS_BE_NOT_CONFIGURED' }
//   502 { ok:false, error, voys_status, voys_body } als Voys 4xx/5xx of throw
//
// Env-vars per account:
//   NL — VOYS_API_TOKEN + VOYS_CLIENT_UUID + VOYS_A_NUMBER (verplicht,
//        Sensitive). Gedeelde tuning: VOYS_CALL_URL, VOYS_AUTH_STYLE,
//        VOYS_BODY_STYLE.
//   BE — VOYS_BE_API_TOKEN + VOYS_BE_CLIENT_UUID + VOYS_BE_A_NUMBER
//        (Sensitive). Optionele overrides: VOYS_BE_CALL_URL,
//        VOYS_BE_AUTH_STYLE, VOYS_BE_BODY_STYLE (vallen terug op NL-
//        tuning als niet gezet — Voys BE zit doorgaans op zelfde
//        holodeck-endpoint).

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

// Landdetectie identiek aan modules/shared/klx-softphone.js:168-171 —
// +32 / 0032 → BE, anders NL. Werkt op reeds genormaliseerde nummers.
function detectLine(phone) {
  const s = String(phone || '');
  if (s.startsWith('+32') || s.startsWith('0032')) return 'be';
  return 'nl';
}

// Bouwt de per-account credential-set. Backwards-compat: BE valt terug op
// NL-CALL_URL / AUTH_STYLE / BODY_STYLE als geen BE-override gezet is.
function loadCreds(line) {
  const isBe = line === 'be';
  const P = isBe ? 'VOYS_BE_' : 'VOYS_';
  return {
    line,
    token     : process.env[P + 'API_TOKEN']  || '',
    clientUuid: process.env[P + 'CLIENT_UUID'] || '',
    aNumber   : process.env[P + 'A_NUMBER']   || '',
    url       : process.env[P + 'CALL_URL']    || process.env.VOYS_CALL_URL
                  || 'https://api.eu-production.holodeck.voys.nl/clicktodial/',
    authStyle : String(process.env[P + 'AUTH_STYLE'] || process.env.VOYS_AUTH_STYLE || 'apitoken').toLowerCase(),
    bodyStyle : String(process.env[P + 'BODY_STYLE'] || process.env.VOYS_BODY_STYLE || 'holodeck').toLowerCase(),
  };
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

  // 2026-08-26: `softphone.use` toegevoegd als dedicated bel-key naast de
  // bestaande sales-scope keys. Zo kan Jeffrey per-user (via user_permissions)
  // iemand het bel-recht geven zonder een hele sales-scope te grant'en
  // (bv. Chesney × softphone.use). Bestaande grants blijven werken.
  let allowed = await requirePermission(req, 'softphone.use');
  if (!allowed) allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const body   = (req.body && typeof req.body === 'object') ? req.body : {};
  const leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';
  if (leadId && !UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ongeldig' });
  const toNumber   = normalizePhone(body.to_number);
  const fromNumber = normalizePhone(body.from_number) || null;
  if (!toNumber) return res.status(400).json({ error: 'to_number vereist' });

  // ── Landroutering (BE = apart Voys-account met eigen creds) ──
  // Expliciete override wint van auto-detect. 'auto' (default) = detect
  // op prefix van het genormaliseerde to_number.
  const rawLine = typeof body.line === 'string' ? body.line.trim().toLowerCase() : 'auto';
  if (rawLine && !['auto', 'nl', 'be'].includes(rawLine)) {
    return res.status(400).json({ error: "line ongeldig (verwacht 'auto' | 'nl' | 'be')" });
  }
  const line = rawLine === 'auto' || !rawLine ? detectLine(toNumber) : rawLine;

  // ── Env-configuratie per lijn ── (niets hardcoden; sensitive keys NIET loggen)
  const creds = loadCreds(line);
  const { token, clientUuid, aNumber, url, authStyle, bodyStyle } = creds;

  if (!token || !clientUuid || !aNumber) {
    const P = line === 'be' ? 'VOYS_BE_' : 'VOYS_';
    return res.status(501).json({
      code    : line === 'be' ? 'VOYS_BE_NOT_CONFIGURED' : 'VOYS_NL_NOT_CONFIGURED',
      error   : `Voys ${line.toUpperCase()}-account niet geconfigureerd`,
      line,
      missing : {
        [P + 'API_TOKEN']  : !token,
        [P + 'CLIENT_UUID']: !clientUuid,
        [P + 'A_NUMBER']   : !aNumber,
      },
    });
  }

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
        await logCallNote(leadId, user.id, `Uitgaand gebeld via Voys (${line.toUpperCase()}-lijn)` + (fromNumber ? ` (caller-ID ${fromNumber})` : ''));
      } catch (nErr) { console.warn('[voys-call] note fail:', nErr?.message || nErr); }
      return res.status(200).json({
        ok       : true,
        call     : parsed || { status: 'dialing' },
        line,
        auth_style: authStyle,
        body_style: bodyStyle,
      });
    }

    // Voys returnde 4xx/5xx: log ruwe body voor debug (zonder token/uuid).
    console.error('[voys-call] Voys ' + line.toUpperCase() + ' ' + voysStatus + ':', voysBodyText.slice(0, 800));
    return res.status(502).json({
      ok         : false,
      error      : 'Voys-call mislukt',
      line,
      voys_status: voysStatus,
      voys_body  : voysBodyText.slice(0, 800),
      auth_style : authStyle,
      body_style : bodyStyle,
    });
  } catch (e) {
    console.error('[voys-call] request error (' + line.toUpperCase() + '):', e?.message || e);
    return res.status(502).json({
      ok         : false,
      error      : 'Voys-call mislukt (network)',
      line,
      voys_status: voysStatus,
      voys_body  : (voysBodyText || String(e?.message || e || '')).slice(0, 800),
      auth_style : authStyle,
      body_style : bodyStyle,
    });
  }
}
