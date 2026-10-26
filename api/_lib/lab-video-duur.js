// api/_lib/lab-video-duur.js
//
// "Je eerste video duurt X minuten" (opvolgmotor, stap niet-ingelogd-24u).
// De eerste video van het leerpad is die van de les "Market Structure"
// (dfo-lms src/features/studydesk/leerpad-regels.ts, voorkeursvolgorde).
// Volgorde van bronnen:
//   1. app_settings 'trial_eerste_video_min' (handmatig, wint altijd);
//   2. de duur uit Vimeo-oEmbed van die video (publiek, geen sleutel);
//   3. null → de mail zegt "maar een paar minuten".
// Gooit nooit.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { instelWaarde } from './leadsonderhoud-sjabloon.js';

export const EERSTE_LES = 'Market Structure';

/** Seconden → hele minuten (min 1). PURE. */
export function minutenUitSeconden(sec) {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n / 60)) : null;
}

export async function eersteVideoMinuten({ fetchFn = fetch } = {}) {
  try {
    const { data } = await supabaseAdmin.from('app_settings').select('value').eq('key', 'trial_eerste_video_min').maybeSingle();
    const handmatig = Number(instelWaarde(data));
    if (Number.isFinite(handmatig) && handmatig > 0) return Math.round(handmatig);
  } catch (e) { console.warn('[lab-video-duur] instelling (soft):', e?.message || e); }
  try {
    const lms = getDfoLmsClient();
    if (!lms) return null;
    const { data: les } = await lms.from('hlms_les').select('id').ilike('titel', EERSTE_LES).eq('trial_zichtbaar', true).limit(1);
    if (!les?.[0]) return null;
    const { data: mat } = await lms.from('hlms_les_materiaal').select('vimeo_id, url').eq('les_id', les[0].id).eq('soort', 'video').order('volgorde', { ascending: true }).limit(1);
    const m = mat?.[0];
    const url = m?.vimeo_id ? `https://vimeo.com/${m.vimeo_id}` : m?.url;
    if (!url) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetchFn(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
      if (!r.ok) return null;
      return minutenUitSeconden((await r.json())?.duration);
    } finally { clearTimeout(t); }
  } catch (e) {
    console.warn('[lab-video-duur] oEmbed (soft):', e?.message || e);
    return null;
  }
}
