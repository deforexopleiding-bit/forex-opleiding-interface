// api/r/[token].js
//
// Korte redirect voor de dagrapport-WhatsApp-knop: /r/<token> zoekt de bij de
// token horende PDF op, maakt een VERSE, kortlopende signed URL en stuurt de
// browser daarheen (302). Zo blijft de knop de volgende ochtend werken terwijl
// de PDF privé in Supabase Storage blijft.
//
// De token (32 hex, onraadbaar) is de enige sleutel; geen verdere auth. Read-only
// op dagrapport_links; mint een signed URL op het moment van klikken.
//
// Bereikbaar als /r/<token> via de rewrite in vercel.json, en als
// /api/r/<token> direct.

import { supabaseAdmin } from '../supabase.js';

const BUCKET = 'dagrapporten';
const SIGNED_TTL_SEC = 600; // 10 min - alleen voor de redirect zelf

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = String((req.query && req.query.token) || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(token)) {
    return res.status(400).send('Ongeldige link.');
  }

  try {
    const { data: row, error } = await supabaseAdmin
      .from('dagrapport_links')
      .select('storage_path')
      .eq('token', token)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row || !row.storage_path) {
      return res.status(404).send('Dit rapport is niet (meer) beschikbaar.');
    }

    const signed = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(row.storage_path, SIGNED_TTL_SEC);
    if (signed.error || !signed.data?.signedUrl) {
      throw new Error(signed.error?.message || 'geen signed URL');
    }

    res.statusCode = 302;
    res.setHeader('Location', signed.data.signedUrl);
    return res.end();
  } catch (e) {
    console.error('[r/token] fout:', e?.message || e);
    return res.status(500).send('Er ging iets mis bij het openen van het rapport.');
  }
}
