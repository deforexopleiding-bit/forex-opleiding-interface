// api/teamleader-webhook-register.js
// Beheer van TL-webhook-registraties. Permission: admin.integrations.manage.
//   POST   → registreert deal.won + deal.moved bij TL voor onze receiver-URL
//   GET    → lijst onze geregistreerde webhooks (uit teamleader_webhooks)
//   DELETE ?event_type=deal.won → de-registreert dat event bij TL
//
// TL kent geen quotation.* events; deal.won is het realtime "offerte getekend"
// signaal (de offerte hangt onder een deal die bij acceptatie naar 'won' gaat).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';

const EVENT_TYPES = ['deal.won', 'deal.moved'];
const WEBHOOK_URL = (process.env.PUBLIC_BASE_URL || 'https://forex-opleiding-interface.vercel.app') + '/api/teamleader-webhook';

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
      const { data } = await supabaseAdmin.from('teamleader_webhooks')
        .select('*').order('registered_at', { ascending: true });
      return res.status(200).json({ webhooks: data || [], url: WEBHOOK_URL });
    }

    if (req.method === 'POST') {
      const tok = await getActiveToken();
      if (!tok) return res.status(503).json({ error: 'Geen TL-token actief' });

      const r = await tlFetch('/webhooks.register', {
        method: 'POST',
        body: JSON.stringify({ url: WEBHOOK_URL, types: EVENT_TYPES }),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`TL webhooks.register HTTP ${r.status}: ${txt.slice(0, 200)}`);
      }

      // Response-shape kan variëren; parse defensief. (Vaak 204/leeg → geen id.)
      let tlData = {};
      try { tlData = await r.json(); } catch { tlData = {}; }
      console.log('[webhook-register] TL response:', JSON.stringify(tlData));
      const tlWebhookId = tlData?.data?.id || tlData?.id || null;

      // We tracken per event_type een rij.
      for (const ev of EVENT_TYPES) {
        await supabaseAdmin.from('teamleader_webhooks')
          .delete().eq('event_type', ev).eq('url', WEBHOOK_URL);
        await supabaseAdmin.from('teamleader_webhooks').insert({
          tl_webhook_id: tlWebhookId, event_type: ev, url: WEBHOOK_URL, active: true, registered_at: new Date().toISOString(),
        });
      }
      const { data } = await supabaseAdmin.from('teamleader_webhooks').select('*');
      return res.status(200).json({ success: true, webhooks: data || [] });
    }

    if (req.method === 'DELETE') {
      const ev = req.query?.event_type;
      if (!ev) return res.status(400).json({ error: 'event_type vereist' });
      const tok = await getActiveToken();
      if (!tok) return res.status(503).json({ error: 'Geen TL-token actief' });

      const r = await tlFetch('/webhooks.unregister', {
        method: 'POST',
        body: JSON.stringify({ url: WEBHOOK_URL, types: [ev] }),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`TL webhooks.unregister HTTP ${r.status}: ${txt.slice(0, 200)}`);
      }
      await supabaseAdmin.from('teamleader_webhooks').delete().eq('event_type', ev).eq('url', WEBHOOK_URL);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'GET, POST of DELETE' });
  } catch (e) {
    console.error('[tl-webhook-register]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
