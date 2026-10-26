// api/tv.js
//
// Korte URL voor het Live Kantoorbord: /tv → 302 redirect naar
// /display?key=<tv-token>&theme=light&zoom=0.9. Zo hoef je op de kantoor-TV
// alleen "crm.deforexopleiding.nl/tv" in te typen; de token komt server-side,
// nooit uit de getypte URL.
//
// Token-bron (de eerste die gezet is wint):
//   1. env DISPLAY_TV_KEY              (Vercel-env; volledig privé)
//   2. app_setting 'display_tv_token'  (in te stellen vanaf een computer via SQL,
//                                        zonder Vercel-toegang)
// Dit is de PLAINTEXT display-token: dezelfde waarde als ?key=, die
// /api/display-metrics SHA-256-hasht tegen display_tokens (migratie 043).
// /tv gebruikt ALTIJD alleen deze ene aangewezen token; een meegegeven ?key=
// wordt overschreven, dus /tv is geen manier om willekeurige tokens te proberen.
//
// Standaard theme=light en zoom=0.9, allebei overschrijfbaar voor fijnregeling
// (/tv?theme=dark, /tv?zoom=0.85). Overige params worden doorgegeven.

import { supabaseAdmin } from './supabase.js';

async function tvToken() {
  // 1) Env wint (backwards-compatible + volledig privé).
  if (process.env.DISPLAY_TV_KEY) return String(process.env.DISPLAY_TV_KEY).trim();
  // 2) App-setting (jsonb). Waarde is een JSON-string met de plaintext token,
  //    of (voor de zekerheid) een object { token }. Fail-soft → ''.
  try {
    const { data } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', 'display_tv_token').maybeSingle();
    if (data && data.value != null) {
      const v = (typeof data.value === 'string') ? data.value : (data.value.token || '');
      return String(v).trim();
    }
  } catch (e) {
    console.error('[tv] app_settings lezen mislukt:', e?.message || e);
  }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = await tvToken();
  if (!key) {
    res.status(500).send('Geen TV-token ingesteld. Zet env DISPLAY_TV_KEY of app_setting display_tv_token.');
    return;
  }
  const params = new URLSearchParams(req.query);        // overige params (bv. zoom/theme) behouden
  if (!params.has('theme')) params.set('theme', 'light'); // standaard licht, overschrijfbaar
  if (!params.has('zoom')) params.set('zoom', '0.9');     // standaard marge voor overscan-TV's, overschrijfbaar
  params.set('key', key);                                 // token ALTIJD server-side (overschrijft een meegegeven key)
  res.redirect(302, '/display?' + params.toString());
}
