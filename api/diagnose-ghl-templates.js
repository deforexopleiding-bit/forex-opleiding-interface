// TIJDELIJK diagnose-endpoint — verwijder na gebruik.
// Roept GHL Conversations API aan om alle templates voor onze location
// op te halen. Output via console.log naar Vercel logs.
//
// Auth: alleen super_admin om misbruik te voorkomen.

import { createUserClient } from './supabase.js';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  // Rol-check
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin.' });
  }

  if (!process.env.GHL_API_KEY || !process.env.GHL_LOCATION_ID) {
    return res.status(500).json({ error: 'GHL env vars niet geconfigureerd.' });
  }

  // Probeer meerdere mogelijke endpoints voor templates
  const endpoints = [
    `${GHL_API_BASE}/conversations/templates?locationId=${process.env.GHL_LOCATION_ID}`,
    `${GHL_API_BASE}/whatsapp/templates?locationId=${process.env.GHL_LOCATION_ID}`,
    `${GHL_API_BASE}/locations/${process.env.GHL_LOCATION_ID}/templates`,
    `${GHL_API_BASE}/locations/${process.env.GHL_LOCATION_ID}/conversations/templates`,
    `${GHL_API_BASE}/sms/templates?locationId=${process.env.GHL_LOCATION_ID}`,
    `${GHL_API_BASE}/marketing/templates?locationId=${process.env.GHL_LOCATION_ID}`,
  ];

  const results = [];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          Version: '2021-04-15',
          Accept: 'application/json',
        },
      });
      const body = await r.text();
      const summary = {
        url,
        status: r.status,
        bodyPreview: body.slice(0, 500),
      };
      results.push(summary);
      console.log('[diagnose-templates]', JSON.stringify(summary));
    } catch (err) {
      results.push({ url, error: err.message });
      console.error('[diagnose-templates] fetch error:', url, err.message);
    }
  }

  return res.status(200).json({ tested: endpoints.length, results });
}
