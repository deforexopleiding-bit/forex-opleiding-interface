// api/teamleader-webhook-register.js
// Beheer van TL-webhook-registraties. Permission: admin.integrations.manage.
//   GET    → { webhooks: <lokale rijen>, url: WEBHOOK_URL,
//              tl_webhooks: <TL's echte webhooks>, tl_list_error?: string }
//              — laat lokale rijen ÉN wat TL zelf geregistreerd heeft naast
//              elkaar zien zodat we niet blind zijn voor drift.
//   POST   → SCHONE her-registratie:
//              1. Haal TL's bestaande webhooks op.
//              2. Unregister ALLES bij TL dat naar onze WEBHOOK_URL wijst
//                 (stale registraties van vorige koppelingen wegvegen).
//              3. Registreer opnieuw met WEBHOOK_URL + EVENT_TYPES.
//              4. Haal /webhooks.list OPNIEUW op en retourneer als
//                 `tl_webhooks_after` — zwart-op-wit bewijs.
//              5. Werk teamleader_webhooks bij op basis van de echte
//                 TL-respons (niet blind insert).
//   DELETE ?event_type=deal.won → de-registreert dat event bij TL.
//
// TL kent geen quotation.* events; deal.won + deal.moved zijn het realtime
// "offerte getekend"-signaal (de offerte hangt onder een deal die bij
// acceptatie naar 'won' gaat; TL vuurt daar vaak alleen deal.moved bij).
// Bij een TL-call-fout retourneren we de EXACTE TL-foutmelding + HTTP-status
// zodat de UI 'm kan tonen — niet stil falen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';

const EVENT_TYPES = ['deal.won', 'deal.moved', 'deal.lost'];
const WEBHOOK_URL = (process.env.PUBLIC_BASE_URL || 'https://forex-opleiding-interface.vercel.app') + '/api/teamleader-webhook';

/**
 * Haal TL's echte geregistreerde webhooks op via /webhooks.list.
 * Fail-soft: retourneert `{ list: [], error: string }` bij fout, `{ list: [...] }`
 * bij succes. Gaat NOOIT throwen — de caller beslist wat te doen met de fout.
 * @returns {Promise<{ list: Array, error?: string, http_status?: number }>}
 */
async function fetchTlWebhooks() {
  try {
    const r = await tlFetch('/webhooks.list', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const txt = await r.text();
    if (!r.ok) {
      console.error('[webhook-register] webhooks.list HTTP', r.status, txt.slice(0, 500));
      return { list: [], error: txt.slice(0, 500) || `HTTP ${r.status}`, http_status: r.status };
    }
    let parsed = {};
    try { parsed = JSON.parse(txt); } catch { parsed = {}; }
    console.log('[webhook-register] webhooks.list respons:', JSON.stringify(parsed).slice(0, 2000));
    const list = Array.isArray(parsed?.data) ? parsed.data : [];
    return { list };
  } catch (e) {
    console.error('[webhook-register] webhooks.list exception:', e?.message || e);
    return { list: [], error: e?.message || 'exception' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.integrations.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.integrations.manage)' });
  }

  try {
    if (req.method === 'GET') {
      // Lokale rijen ophalen.
      const { data: localRows } = await supabaseAdmin.from('teamleader_webhooks')
        .select('*').order('registered_at', { ascending: true });

      // TL's ECHTE webhooks — fail-soft. Bij geen actief token skippen we de
      // TL-call (return empty + info-veld) zodat de GET niet 503't.
      let tlWebhooks = [];
      let tlListError = null;
      const tok = await getActiveToken();
      if (!tok) {
        tlListError = 'Geen TL-token actief';
      } else {
        const tl = await fetchTlWebhooks();
        tlWebhooks = tl.list;
        if (tl.error) tlListError = tl.error;
      }

      const payload = {
        webhooks:    localRows || [],
        url:         WEBHOOK_URL,
        tl_webhooks: tlWebhooks,
      };
      if (tlListError) payload.tl_list_error = tlListError;
      return res.status(200).json(payload);
    }

    if (req.method === 'POST') {
      const tok = await getActiveToken();
      if (!tok) return res.status(503).json({ error: 'Geen TL-token actief' });

      // Stap 1 — huidige TL-webhooks ophalen (baseline vóór opruimen).
      const beforeTl = await fetchTlWebhooks();
      if (beforeTl.error) {
        return res.status(502).json({
          error:        'TL webhooks.list mislukt (kan niet herregistreren): ' + beforeTl.error,
          http_status:  beforeTl.http_status || null,
        });
      }

      // Stap 2 — unregister ALLES bij TL dat naar onze WEBHOOK_URL wijst.
      // Stale registraties uit vorige koppelingen (andere client-id/andere
      // deployment) worden zo verwijderd. TL /webhooks.unregister neemt
      // { url, types } — één call per unieke (url, types)-combi.
      const staleToOurUrl = (beforeTl.list || []).filter((w) => w?.url === WEBHOOK_URL);
      const unregisterResults = [];
      for (const w of staleToOurUrl) {
        const types = Array.isArray(w?.types) ? w.types : [];
        try {
          const ur = await tlFetch('/webhooks.unregister', {
            method: 'POST',
            body:   JSON.stringify({ url: WEBHOOK_URL, types }),
          });
          const urTxt = await ur.text();
          console.log('[webhook-register] webhooks.unregister ' + JSON.stringify(types),
                      'HTTP', ur.status, urTxt.slice(0, 500));
          if (!ur.ok) {
            return res.status(502).json({
              error:       'TL webhooks.unregister mislukt voor types=' + JSON.stringify(types) +
                           ': ' + (urTxt.slice(0, 500) || `HTTP ${ur.status}`),
              http_status: ur.status,
              stale:       staleToOurUrl,
            });
          }
          unregisterResults.push({ types, ok: true });
        } catch (e) {
          return res.status(502).json({
            error: 'TL webhooks.unregister exception voor types=' + JSON.stringify(types) +
                   ': ' + (e?.message || e),
          });
        }
      }

      // Stap 3 — schoon registreren met EVENT_TYPES.
      let registerResponse = null;
      try {
        const rr = await tlFetch('/webhooks.register', {
          method: 'POST',
          body:   JSON.stringify({ url: WEBHOOK_URL, types: EVENT_TYPES }),
        });
        const rrTxt = await rr.text();
        console.log('[webhook-register] webhooks.register HTTP', rr.status, rrTxt.slice(0, 500));
        if (!rr.ok) {
          return res.status(502).json({
            error:       'TL webhooks.register mislukt: ' + (rrTxt.slice(0, 500) || `HTTP ${rr.status}`),
            http_status: rr.status,
          });
        }
        try { registerResponse = JSON.parse(rrTxt); } catch { registerResponse = rrTxt; }
      } catch (e) {
        return res.status(502).json({
          error: 'TL webhooks.register exception: ' + (e?.message || e),
        });
      }

      // Stap 4 — /webhooks.list opnieuw ophalen als bevestiging.
      const afterTl = await fetchTlWebhooks();
      if (afterTl.error) {
        // Register lijkt gelukt, maar we kunnen de nieuwe stand niet lezen.
        return res.status(502).json({
          error:            'Register OK, maar TL webhooks.list na registratie faalde: ' + afterTl.error,
          http_status:      afterTl.http_status || null,
          register_response: registerResponse,
        });
      }

      // Stap 5 — sync lokale teamleader_webhooks op basis van de ECHTE
      // TL-stand ná registratie. We schrijven één rij per event_type die
      // TL nu daadwerkelijk kent voor onze URL. `tl_webhook_id` = het TL-id
      // van het webhook-object (kan per event_type gedeeld zijn afhankelijk
      // van TL-implementatie; we pakken het eerste passende).
      const ourWebhooksAfter = (afterTl.list || []).filter((w) => w?.url === WEBHOOK_URL);
      const nowIso = new Date().toISOString();
      // Verwijder alle bestaande lokale rijen voor onze URL — we bouwen ze
      // opnieuw op vanuit de TL-stand.
      await supabaseAdmin.from('teamleader_webhooks')
        .delete().eq('url', WEBHOOK_URL);

      // Bouw per event_type een rij als TL 'm bevestigd heeft.
      const tlKnownTypes = new Set();
      for (const w of ourWebhooksAfter) {
        for (const t of (Array.isArray(w?.types) ? w.types : [])) tlKnownTypes.add(t);
      }
      const rowsToInsert = EVENT_TYPES
        .filter((ev) => tlKnownTypes.has(ev))
        .map((ev) => {
          const matching = ourWebhooksAfter.find((w) => (w?.types || []).includes(ev));
          return {
            tl_webhook_id: matching?.id || null,
            event_type:    ev,
            url:           WEBHOOK_URL,
            active:        true,
            registered_at: nowIso,
          };
        });
      if (rowsToInsert.length > 0) {
        await supabaseAdmin.from('teamleader_webhooks').insert(rowsToInsert);
      }
      const { data: localAfter } = await supabaseAdmin.from('teamleader_webhooks').select('*');

      return res.status(200).json({
        success:              true,
        url:                  WEBHOOK_URL,
        types_requested:      EVENT_TYPES,
        types_registered:     Array.from(tlKnownTypes),
        stale_unregistered:   staleToOurUrl,
        register_response:    registerResponse,
        tl_webhooks_after:    ourWebhooksAfter,
        tl_webhooks_all:      afterTl.list,
        webhooks:             localAfter || [],
      });
    }

    if (req.method === 'DELETE') {
      const ev = req.query?.event_type;
      if (!ev) return res.status(400).json({ error: 'event_type vereist' });
      const tok = await getActiveToken();
      if (!tok) return res.status(503).json({ error: 'Geen TL-token actief' });

      const r = await tlFetch('/webhooks.unregister', {
        method: 'POST',
        body:   JSON.stringify({ url: WEBHOOK_URL, types: [ev] }),
      });
      const txt = await r.text();
      console.log('[webhook-register] DELETE webhooks.unregister', ev, 'HTTP', r.status, txt.slice(0, 500));
      if (!r.ok) {
        return res.status(502).json({
          error:       `TL webhooks.unregister mislukt: ${txt.slice(0, 500) || 'HTTP ' + r.status}`,
          http_status: r.status,
        });
      }
      await supabaseAdmin.from('teamleader_webhooks').delete().eq('event_type', ev).eq('url', WEBHOOK_URL);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'GET, POST of DELETE' });
  } catch (e) {
    console.error('[tl-webhook-register]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
