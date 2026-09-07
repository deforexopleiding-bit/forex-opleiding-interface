// api/cron-brug-waakhond.js
//
// DE WAAKHOND. Draait elke 5 minuten en mailt zodra de brug stil valt.
//
// Dit is de tweede helft van het zelfherstel: de brug probeert het eerst zelf
// (opnieuw verbinden met oplopende wachttijd, daarna het proces verversen zodat
// systemd een verse Chromium start). Lukt dat allemaal niet, dan hoort er
// binnen een kwartier een mens te weten dat het mis is — niet de volgende
// ochtend om zeven uur.
//
// WAAROM DIT NIET VALS ALARM GEEFT, zie api/_lib/brug-waakhond.js: hartslag
// elke 2 min, drempel op 12 min stilte, en pas mailen na twee waarnemingen op
// rij. Er zit dus minstens een kwartier tussen het laatste levensteken en de
// eerste mail, en een trage of mislukte levering haalt die drempel nooit.
//
// EN HIJ MAILT MAAR EEN KEER PER STORING. Een waakhond die elke vijf minuten
// dezelfde mail stuurt, wordt een filterregel in Outlook en daarna niets meer.
// Zodra er weer een hartslag binnenkomt, wist de ontvangkant het meld-merk en
// mag hij bij een volgende storing opnieuw blaffen.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { beoordeelHartslag, bouwAlarmMail, STIL, LEEFT } from './_lib/brug-waakhond.js';
import { SLEUTEL } from './brug-hartslag.js';

const MAIL_VAN = 'leads@deforexopleiding.nl';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const nu = new Date();
  const { data, error } = await supabaseAdmin
    .from('app_settings').select('value').eq('key', SLEUTEL).maybeSingle();
  if (error) {
    console.error('[brug-waakhond] lezen faalde:', error.message);
    return res.status(500).json({ error: 'Lezen faalde' });
  }
  const stand = data?.value || {};
  const oordeel = beoordeelHartslag({
    nuMs: nu.getTime(),
    laatsteIso: stand.laatste_hartslag_iso || null,
    stilWaarnemingen: Number(stand.stil_waarnemingen) || 0,
    verbonden: typeof stand.verbonden === 'boolean' ? stand.verbonden : null,
  });

  // De teller bijhouden, ook als er nog niet gemaild wordt: hij is het geheugen
  // tussen twee cron-runs en daarmee de reden dat één hikje geen mail wordt.
  const nieuweStand = { ...stand, stil_waarnemingen: oordeel.staat === STIL ? oordeel.waarnemingen : 0 };

  let mail = { verstuurd: false, reden: 'geen alarm' };
  const alGemeld = !!stand.gemeld_op;
  if (oordeel.alarm && alGemeld) {
    mail = { verstuurd: false, reden: 'al gemeld op ' + stand.gemeld_op };
  } else if (oordeel.alarm) {
    const ontvanger = process.env.OPVOLGING_GEZONDHEID_MAIL_TO || '';
    if (!ontvanger) {
      console.error('[brug-waakhond] OPVOLGING_GEZONDHEID_MAIL_TO ontbreekt — alarm niet verstuurd');
      mail = { verstuurd: false, reden: 'geen ontvanger ingesteld' };
    } else {
      const { subject, text } = bouwAlarmMail({
        oordeel, nuIso: nu.toISOString(), laatsteIso: stand.laatste_hartslag_iso || null,
      });
      const r = await sendEmailViaSmtp({ fromMailbox: MAIL_VAN, to: ontvanger, subject, text });
      mail = r?.ok ? { verstuurd: true, to: ontvanger, subject } : { verstuurd: false, reden: r?.reason || 'onbekend' };
      if (r?.ok) nieuweStand.gemeld_op = nu.toISOString();
      else console.error('[brug-waakhond] mail faalde:', r?.reason);
    }
  }

  await supabaseAdmin.from('app_settings')
    .update({ value: nieuweStand, updated_at: nu.toISOString() }).eq('key', SLEUTEL);

  console.log('[brug-waakhond]', oordeel.staat, '—', oordeel.uitleg,
    '| alarm=' + oordeel.alarm, '| mail=' + mail.verstuurd);
  return res.status(200).json({ ok: true, oordeel, mail, leeft: oordeel.staat === LEEFT });
}
