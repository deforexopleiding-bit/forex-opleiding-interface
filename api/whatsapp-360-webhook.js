// api/whatsapp-360-webhook.js
//
// Inkomende WhatsApp via 360dialog (2026-10-05). 360dialog levert hetzelfde
// Cloud-API-formaat als Meta ({ object, entry:[{ changes:[{ field, value }] }] }),
// dus de verwerking is EXACT die van de Meta-webhook: verwerkWhatsAppWebhookBody
// uit api/inbox-webhook.js (gesprekken, berichten, statussen, media, opvolging,
// toegang, pipeline, Joost/Simone …). Niets opnieuw gebouwd.
//
// URL (per nummer, zie api/_lib/wa-nummers.js):
//   POST /api/whatsapp-360-webhook?nummer=hoofdnummer
//
// AUTH: 360dialog ondertekent Cloud-API-webhooks niet. Bij het instellen van de
// webhook (POST https://waba-v2.360dialog.io/v1/configs/webhook) geef je een
// eigen header mee; die controleren we hier:
//   header  X-D360-Webhook-Token: <waarde van D360_WEBHOOK_TOKEN_<NUMMER>>
// Terugval als je de URL alleen in de 360dialog-hub kunt invullen (zonder
// headers): ?token=<zelfde waarde> in de URL. Minder netjes (staat dan in
// logs van tussenpartijen), maar werkt. Vergelijking met timingSafeEqual.
//
// IDEMPOTENT: whatsapp_messages.meta_wamid is UNIQUE; een herhaalde levering
// (360dialog probeert opnieuw bij alles behalve 200, tot ~24 uur) geeft een
// duplicaat-skip en geen dubbele side-effects.
//
// ANTWOORD: altijd 200 na geslaagde auth (ook bij onzin/gedeeltelijke fouten),
// anders blijft 360dialog dezelfde batch herhalen. 401/503 alleen bij auth/config.

import { timingSafeEqual } from 'node:crypto';
import { verwerkWhatsAppWebhookBody } from './inbox-webhook.js';
import { actieveNummers, apiKeyVan, nummerOpSleutel, nummerOpTelefoon, phoneNumberIdUitEnv, webhookTokenVan } from './_lib/wa-nummers.js';

// Raw body zelf lezen (zelfde als inbox-webhook.js) — geen afhankelijkheid van Vercel's parser.
export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function leesRawBody(req) {
  return new Promise((resolve, reject) => {
    const delen = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY_BYTES) { reject(new Error('body te groot')); req.destroy?.(); return; }
      delen.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(delen)));
    req.on('error', reject);
  });
}

function gelijk(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  try { return timingSafeEqual(x, y); } catch { return false; }
}

/** Welk nummer bedient deze URL? ?nummer=<sleutel>, of het enige actieve 360dialog-nummer met een API-key. */
export function kiesNummer(query = {}) {
  const sleutel = typeof query.nummer === 'string' ? query.nummer.trim() : '';
  if (sleutel) return nummerOpSleutel(sleutel);
  const d360 = actieveNummers().filter((n) => n.provider === '360dialog' && apiKeyVan(n));
  return d360.length === 1 ? d360[0] : null;
}

/**
 * Cloud-API-body klaarzetten voor de gedeelde verwerking. Meta zet altijd
 * field:'messages' (ook voor statussen); bij 360dialog kan field ontbreken of
 * 'statuses' zijn — de verwerking slaat alles behalve 'messages' over.
 */
export function normaliseer360Body(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.entry)) return null;
  return {
    ...body,
    entry: body.entry.map((e) => ({
      ...e,
      changes: (Array.isArray(e?.changes) ? e.changes : []).map((c) => {
        const v = c?.value || {};
        const heeftBerichten = Array.isArray(v.messages) || Array.isArray(v.statuses);
        if (heeftBerichten && (!c.field || c.field === 'statuses')) return { ...c, field: 'messages' };
        return c;
      }),
    })),
  };
}

const gezienePnIds = new Set();   // één waarschuwing per instantie per afwijkende lijn

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    // Geen Meta-handshake bij 360dialog; GET is alleen een levensteken (zonder details).
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const nummer = kiesNummer(req.query || {});
  if (!nummer) return res.status(404).json({ error: 'onbekend nummer' });
  const verwacht = webhookTokenVan(nummer);
  if (!verwacht) {
    console.error('[whatsapp-360-webhook] geheim ontbreekt:', nummer.webhook_token_env);
    return res.status(503).json({ error: 'webhook niet geconfigureerd' });
  }
  const gegeven = req.headers['x-d360-webhook-token'] || (req.query && req.query.token) || '';
  if (!gelijk(gegeven, verwacht)) {
    console.warn('[whatsapp-360-webhook] token klopt niet voor', nummer.sleutel);
    return res.status(401).json({ error: 'unauthorized' });
  }

  let ruw;
  try { ruw = await leesRawBody(req); } catch (e) {
    console.error('[whatsapp-360-webhook] body lezen:', e?.message || e);
    return res.status(200).json({ ok: true, parsed: false });
  }
  let body = null;
  try { body = JSON.parse(ruw.toString('utf8')); } catch (e) {
    console.error('[whatsapp-360-webhook] JSON parse fail:', e?.message || e);
    return res.status(200).json({ ok: true, parsed: false });
  }
  const genorm = normaliseer360Body(body);
  if (!genorm) return res.status(200).json({ ok: true, parsed: false });

  // Controle: komt dit echt van ons nummer? Afwijkingen loggen, niet weigeren
  // (de verwerking koppelt gesprekken aan metadata.phone_number_id).
  try {
    const verwachtPnId = phoneNumberIdUitEnv(nummer);
    for (const e of genorm.entry) {
      for (const c of e.changes || []) {
        const md = c?.value?.metadata || {};
        const pnId = md.phone_number_id ? String(md.phone_number_id) : null;
        if (!pnId || gezienePnIds.has(pnId)) continue;
        gezienePnIds.add(pnId);
        if (!verwachtPnId) {
          console.warn(`[whatsapp-360-webhook] ${nummer.sleutel}: phone_number_id=${pnId} — zet ${nummer.phone_number_id_env}=${pnId} in Vercel`);
        } else if (verwachtPnId !== pnId) {
          console.warn(`[whatsapp-360-webhook] ${nummer.sleutel}: phone_number_id ${pnId} wijkt af van ${nummer.phone_number_id_env}=${verwachtPnId}`);
        }
        if (nummer.e164 && md.display_phone_number && nummerOpTelefoon(md.display_phone_number) !== nummer) {
          console.warn(`[whatsapp-360-webhook] ${nummer.sleutel}: display_phone_number ${md.display_phone_number} hoort niet bij ${nummer.e164}`);
        }
      }
    }
  } catch (e) {
    console.warn('[whatsapp-360-webhook] metadata-controle:', e?.message || e);
  }

  const stats = await verwerkWhatsAppWebhookBody(req, genorm, { bron: '360dialog', nummer });
  console.log('[whatsapp-360-webhook] POST processed', nummer.sleutel, JSON.stringify(stats));
  return res.status(200).json({ ok: true, ...stats });
}
