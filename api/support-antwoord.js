// api/support-antwoord.js
//
// POST — een medewerker antwoordt in een gesprek.
//
// Twee dingen gebeuren er altijd samen: het bericht komt in de chat én, als
// de bezoeker niet meer meekijkt, per mail. Dat tweede is geen luxe — een
// bezoeker die de tab gesloten heeft ziet anders nooit dat er geantwoord is,
// en belt de volgende dag alsnog.
//
// "Kijkt niet meer mee" leiden we af uit de tijd sinds het laatste bericht
// van de klant. Binnen twee minuten gaan we ervan uit dat de chat openstaat;
// daarna sturen we de mail. Liever één mail te veel dan een antwoord dat
// niemand leest.
//
// Eén uitzondering: ging er voor dit gesprek net al een antwoordmail uit, dan
// versturen we niet meteen opnieuw. Twee berichten die een collega kort na
// elkaar typt ("Hallo Paulien" — "Kan je me je nummer doorgeven?") zijn voor
// de ontvanger één antwoord, geen twee mails veertig seconden na elkaar. Het
// bericht krijgt meta->mail_status 'wacht'; cron-support-mail.js stuurt het
// een paar minuten later gebundeld mee.

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';
import { schrijfBericht } from './_lib/support-sessie.js';
import { stuurAntwoordMail } from './_lib/support-mail.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE_VENSTER_MS = 2 * 60 * 1000;
const BUNDEL_VENSTER_MS = 3 * 60 * 1000;

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, 'POST')) return;

  const staff = await staffUit(req, res, 'support.reply');
  if (!staff) return;

  const id = String(req.body?.gesprek_id || '');
  const tekst = String(req.body?.tekst || '').trim().slice(0, 8000);
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Ongeldig gesprek_id' });
  if (!tekst) return res.status(400).json({ error: 'Leeg antwoord' });

  const { data: gesprek } = await supabaseAdmin
    .from('support_gesprekken').select('*').eq('id', id).maybeSingle();
  if (!gesprek) return res.status(404).json({ error: 'Gesprek niet gevonden' });

  // Wel of niet mailen bepalen we vóór het schrijven: zodra het bericht
  // bestaat, moet meta al kloppen, anders pakt de cron 'm niet op.
  const laatsteKlant = Date.parse(gesprek.laatste_klant_bericht_op || '') || 0;
  const kijktMee = Date.now() - laatsteKlant <= LIVE_VENSTER_MS;
  const mailNodig = !!gesprek.email && !kijktMee;
  const recentGemaild = mailNodig ? await ergensRecentGemaild(id) : false;
  const mailStatus = !mailNodig ? 'niet_nodig' : (recentGemaild ? 'wacht' : 'direct');

  const bericht = await schrijfBericht({
    gesprekId: id,
    afzender: 'medewerker',
    afzenderUserId: staff.user.id,
    tekst,
    meta: { afzender_naam: staff.naam, mail_status: mailStatus },
  });
  if (!bericht) return res.status(500).json({ error: 'Antwoord kon niet opgeslagen worden.' });

  // Wie antwoordt, pakt het gesprek op — tenzij iemand anders het al heeft.
  const patch = { status: 'wacht_op_klant' };
  if (!gesprek.toegewezen_aan) {
    patch.toegewezen_aan = staff.user.id;
    patch.toegewezen_op = new Date().toISOString();
  }
  await supabaseAdmin.from('support_gesprekken').update(patch).eq('id', id);

  let gemaild = false;
  if (mailStatus === 'direct') {
    const uit = await stuurAntwoordMail({
      naar: gesprek.email,
      naam: gesprek.naam,
      kenmerk: gesprek.kenmerk,
      antwoord: tekst,
      medewerker: staff.naam,
    }).catch((e) => { console.warn('[support-antwoord] mail mislukt:', e?.message || e); return null; });
    gemaild = !!uit?.ok;
    // Mislukt de mail, dan blijft 'ie niet liggen: de cron probeert het
    // opnieuw in plaats van dat de klant op een antwoord wacht dat wel in de
    // chat staat maar nergens aankomt.
    await zetMailStatus(bericht.id, bericht.meta, gemaild ? 'gemaild' : 'wacht');
  }

  return res.status(200).json({ bericht, gemaild, mail_status: mailStatus });
}

/**
 * Ging er voor dit gesprek in de afgelopen minuten al een antwoordmail uit?
 *
 * Fail-open: bij twijfel mailen we gewoon. Een mail te veel is vervelend, een
 * antwoord dat nooit aankomt is erger.
 */
async function ergensRecentGemaild(gesprekId) {
  try {
    const grens = new Date(Date.now() - BUNDEL_VENSTER_MS).toISOString();
    const { data } = await supabaseAdmin
      .from('support_berichten')
      .select('id')
      .eq('gesprek_id', gesprekId)
      .eq('afzender', 'medewerker')
      .contains('meta', { mail_status: 'gemaild' })
      .gte('created_at', grens)
      .limit(1);
    return (data || []).length > 0;
  } catch (_) {
    return false;
  }
}

async function zetMailStatus(berichtId, meta, status) {
  try {
    await supabaseAdmin
      .from('support_berichten')
      .update({ meta: { ...(meta || {}), mail_status: status, mail_op: new Date().toISOString() } })
      .eq('id', berichtId);
  } catch (e) {
    console.warn('[support-antwoord] mail_status bijwerken mislukt:', e?.message || e);
  }
}
