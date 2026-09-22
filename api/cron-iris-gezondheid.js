// api/cron-iris-gezondheid.js
//
// Elke ochtend: hoe staat Iris ervoor, en is er iets blijven liggen?
//
// Auth: Authorization: Bearer $CRON_SECRET.
// Ritme: dagelijks om 05:00 UTC, dus rond zeven uur 's ochtends in Brussel —
// vroeg genoeg om er vóór het werk naar te kijken.
//
// ── NOOIT STIL "OK" ──────────────────────────────────────────────────────────
// Elke meting die niet gelukt is, heet NIET GEMETEN. Niet nul, niet 'ok'. Een
// rapport dat bij een leesfout groen kleurt is erger dan geen rapport: dan denk
// je dat je kijkt terwijl je niets ziet. Dezelfde regel als
// cron-opvolging-gezondheid.
//
// De alarmmail gaat alleen weg als er echt iets is. Een dagelijkse mail die
// meestal "alles goed" zegt, wordt na twee weken niet meer gelezen — en dan
// mist hij de ene keer dat het wél mis was.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { sendMail } from './_lib/email.js';
import { irisAan } from './_lib/iris/instellingen.js';
import { GRENZEN, gemeten, nietGemeten, bouwOverzicht, alarmTekst } from './_lib/iris/ochtend.js';

const ALARM_NAAR = process.env.PROVISIONING_ALARM_EMAIL || 'biemoldjeffrey@gmail.com';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Alleen GET en POST' });
  }
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const nu = new Date();
  const gisteren = new Date(nu.getTime() - 24 * 3600 * 1000).toISOString();
  const vandaag = nu.toISOString().slice(0, 10);
  const metingen = [];

  // Elke meting apart, met zijn eigen try. Eén meting die faalt mag de andere
  // niet meeslepen — dan zou één leesfout het hele rapport wegvagen.
  const meet = async (wat, fn, opties) => {
    try {
      const waarde = await fn();
      const m = gemeten(wat, waarde, opties);
      metingen.push(m);
      return waarde;
    } catch (e) {
      console.error(`[cron-iris-gezondheid] ${wat} niet gemeten:`, e?.message || e);
      metingen.push(nietGemeten(wat, e?.message || 'onbekend'));
      return null;
    }
  };

  const tel = async (tabel, opbouw) => {
    const vraag = opbouw(supabaseAdmin.from(tabel).select('id', { count: 'exact', head: true }));
    const { count, error } = await vraag;
    if (error) throw new Error(error.message);
    return count || 0;
  };

  try {
    // ── Wat deed Iris? ───────────────────────────────────────────────────────
    const verstuurd = await meet('verstuurd sinds gisteren',
      () => tel('iris_concepten', (q) => q.eq('status', 'verzonden').gte('verzonden_op', gisteren)));
    const ingedeeld = await meet('ingedeeld sinds gisteren',
      () => tel('iris_berichten', (q) => q.not('verwerkt_op', 'is', null).gte('verwerkt_op', gisteren)));

    // ── Wat wacht er? ────────────────────────────────────────────────────────
    const concepten = await meet('antwoorden die op een ok wachten',
      () => tel('iris_concepten', (q) => q.eq('status', 'klaar')));
    const opdrachten = await meet('opdrachten die op een antwoord wachten',
      () => tel('iris_opdrachten', (q) => q.eq('status', 'wacht_op_ok')));
    const nietGekoppeld = await meet('gesprekken zonder persoon',
      () => tel('iris_gesprekken', (q) => q.is('contact_id', null)),
      { grens: GRENZEN.niet_gekoppeld });

    // ── De belrij ────────────────────────────────────────────────────────────
    const belrij = await meet('mensen op de belrij',
      () => tel('iris_belrij', (q) => q.in('status', ['open', 'bezig'])));

    // ── Beloftes die vandaag vervallen ───────────────────────────────────────
    const beloftesVandaag = await meet('betaalafspraken die vandaag verlopen',
      () => tel('iris_beloftes', (q) => q.eq('status', 'actief').eq('datum', vandaag)));

    // ── Is er iets blijven liggen? ───────────────────────────────────────────
    // Drie dingen die stil kunnen vastlopen, elk met een eigen grens.
    const grensUren = (u) => new Date(nu.getTime() - u * 3600 * 1000).toISOString();

    await meet('antwoorden die al meer dan 18 uur klaarstaan',
      () => tel('iris_concepten', (q) => q.eq('status', 'klaar').lt('aangemaakt_op', grensUren(GRENZEN.concept_uren))),
      { grens: 0 });

    await meet('berichten die al meer dan 2 uur niet ingedeeld zijn',
      () => tel('iris_berichten', (q) => q.is('verwerkt_op', null).eq('richting', 'in').lt('ontvangen_op', grensUren(GRENZEN.onverwerkt_uren))),
      { grens: 0 });

    // Dit is de gevaarlijkste: een goedgekeurd concept dat na een kwartier nog
    // niet weg is, betekent dat zowel de wachtende taak als de cron het heeft
    // laten liggen. Iemand denkt dat hij geantwoord heeft.
    await meet('goedgekeurde berichten die na een kwartier nog niet weg zijn',
      () => tel('iris_concepten', (q) => q.eq('status', 'goedgekeurd')
        .lt('verstuur_na', new Date(nu.getTime() - GRENZEN.goedgekeurd_minuten * 60000).toISOString())),
      { grens: 0 });

    await meet('berichten die niet verstuurd konden worden',
      () => tel('iris_concepten', (q) => q.eq('status', 'mislukt').gte('bijgewerkt_op', gisteren)),
      { grens: 0 });

    // ── Komt er nog wel iets binnen? ─────────────────────────────────────────
    // Nul nieuwe berichten in 24 uur is op zichzelf geen fout — het kan een
    // rustige zondag zijn. Maar het is wél het eerste teken dat een webhook of
    // de mailsync stilgevallen is, dus het staat in het rapport.
    await meet('nieuwe berichten in de laatste 24 uur',
      () => tel('iris_berichten', (q) => q.gte('ontvangen_op', gisteren)),
      { grens: 1, hoger_is_slechter: false });

    const overzicht = bouwOverzicht({
      gedaan: { verstuurd, ingedeeld },
      wacht: { concepten, opdrachten, niet_gekoppeld: nietGekoppeld },
      bellen: { open: belrij },
      beloftes: { vandaag: beloftesVandaag },
      metingen,
    });

    console.log('[cron-iris-gezondheid]', JSON.stringify({
      gezond: overzicht.gezond,
      problemen: overzicht.problemen.length,
      aan: irisAan(),
    }));

    const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
      wat: 'ochtendoverzicht',
      resultaat: overzicht.gezond ? 'ok' : 'let_op',
      details: { samenvatting: overzicht.samenvatting, problemen: overzicht.problemen },
    });
    if (logFout) console.warn('[cron-iris-gezondheid] logregel mislukt:', logFout.message);

    // De mail gaat alleen weg als er iets is.
    const tekst = alarmTekst(overzicht);
    let gemaild = false;
    if (tekst) {
      const r = await sendMail({
        to: ALARM_NAAR,
        subject: `Iris — ${overzicht.problemen.length} punt(en) die aandacht vragen`,
        html: `<pre style="font-family:ui-monospace,monospace;font-size:13px;white-space:pre-wrap">${
          tekst.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
        }</pre>`,
      });
      gemaild = !!r?.sent;
      if (!r?.sent) console.warn('[cron-iris-gezondheid] alarmmail niet verstuurd:', r?.reason);
    }

    return res.status(200).json({ ok: true, overzicht, gemaild });
  } catch (e) {
    console.error('[cron-iris-gezondheid] afgebroken:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Interne fout', metingen });
  }
}
