// api/cron-leadsonderhoud.js
//
// De motor van het leadsonderhoud. Draait als cron elk kwartier (zie
// vercel.json). Leest de wachtrij, past de vaste regels toe, en stuurt via de
// bestaande verzendcode. Schrijft altijd naar berichten_log — ook bij een fout.
//
// DROOGLOOPSTAND staat standaard AAN: dan doet de motor alles behalve
// versturen, en rapporteert alleen wat er zou zijn gegaan. Zo zie je de eerste
// dagen of de juiste mensen het juiste bericht zouden krijgen zonder risico.
// Live gaat pas als env LEADSONDERHOUD_LIVE === '1' (stap 4/5). De UI-schuif in
// het Instellingen-scherm koppelt later aan deze vlag.
//
// De regels (uit de opdracht):
//  - Niets tussen 21:00 en 08:00 (Amsterdamse tijd) — wacht tot de ochtend.
//  - Maximaal één bericht per persoon per dag, over alle kanalen samen.
//  - Nooit WhatsApp zonder toestemming (de view filtert al; we checken nog eens).
//  - WhatsApp buiten het 24u-venster mag alleen met een goedgekeurd sjabloon;
//    een niet-goedgekeurd sjabloon slaan we zichtbaar over i.p.v. te falen.
//  - Bij een verzendfout: één keer opnieuw (volgende cron-ronde), daarna mislukt.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { sendTemplate } from './_lib/meta-whatsapp.js';

// Afzender-mailbox voor deze module (opdracht: onboarding@, of info@).
const MAIL_AFZENDER = 'onboarding@deforexopleiding.nl';

// Amsterdamse klok — nodig voor de stille uren en de "één per dag"-grens.
function amsterdam(nu) {
  const uur = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }).format(nu));
  const datum = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(nu); // YYYY-MM-DD
  return { uur, datum };
}

/**
 * De sjabloontekst per soort. Die staat straks in een sjabloontabel in de
 * database (stap 4/5), zodat de teksten aanpasbaar zijn zonder uitrol. Zolang
 * die tabel er niet is, geeft dit null terug en slaat de live-motor het bericht
 * zichtbaar over (status 'geen sjabloontekst'). De droogloop heeft dit niet
 * nodig — die verstuurt toch niets.
 */
async function haalSjabloon(/* soort, kanaal */) {
  return null;
}

export default async function handler(req, res) {
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const droogloop = process.env.LEADSONDERHOUD_LIVE !== '1';
  const nu = new Date();
  const { uur, datum } = amsterdam(nu);

  // Stille uren: tussen 21:00 en 08:00 sturen we niets.
  if (uur >= 21 || uur < 8) {
    return res.status(200).json({ ok: true, overgeslagen: 'stille uren', uur, droogloop });
  }

  try {
    // 1) De wachtrij, over alle trajecten heen. De view zit alle voorwaarden al
    //    in (toestemming, welk bericht, of het al gestuurd is).
    const { data: wachtrij, error: wErr } = await supabaseAdmin
      .from('onderhoud_wachtrij')
      .select('*')
      .order('urgentie', { ascending: true })
      .order('dag', { ascending: true });
    if (wErr) throw wErr;

    // 2) Wie kreeg vandaag (Amsterdamse dag) al een bericht? Voor de één-per-dag-
    //    regel. In droogloop tellen de 'droog'-regels mee als "zou zijn gegaan",
    //    zodat het rapport precies laat zien wat er live zou gebeuren.
    const sinds = new Date(nu.getTime() - 36 * 3600 * 1000).toISOString();
    const { data: recent } = await supabaseAdmin
      .from('berichten_log')
      .select('gebruiker_id, soort, status, verstuurd_op')
      .gte('verstuurd_op', sinds);
    const teltAlsVerstuurd = droogloop ? ['verstuurd', 'droog'] : ['verstuurd'];
    const alVandaag = new Set();
    const foutenVandaag = {}; // key gebruiker_id|soort -> aantal 'fout' vandaag
    for (const r of recent || []) {
      const d = amsterdam(new Date(r.verstuurd_op)).datum;
      if (d !== datum) continue;
      if (teltAlsVerstuurd.includes(r.status)) alVandaag.add(r.gebruiker_id);
      if (r.status === 'fout') {
        const k = r.gebruiker_id + '|' + r.soort;
        foutenVandaag[k] = (foutenVandaag[k] || 0) + 1;
      }
    }

    // In droogloop: welke (wie|soort) al een 'droog'-regel hebben. Zo schrijven
    // we niet elke ronde opnieuw dezelfde regel — spiegel van de view, die
    // alleen 'verstuurd' uitsluit; wij sluiten hier 'droog' uit voor de simulatie.
    const alDroog = new Set();
    if (droogloop) {
      const { data: droogRijen } = await supabaseAdmin
        .from('berichten_log').select('gebruiker_id, lead_id, soort').eq('status', 'droog');
      for (const r of droogRijen || []) alDroog.add((r.gebruiker_id || r.lead_id) + '|' + r.soort);
    }

    // 3) Goedgekeurde WhatsApp-sjablonen, voor de template-gate.
    const { data: templates } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('name, status');
    const goedgekeurd = new Set((templates || []).filter((t) => t.status === 'APPROVED').map((t) => t.name));

    const rapport = { verstuurd: 0, overgeslagen: 0, mislukt: 0, regels: [] };

    for (const r of wachtrij || []) {
      const naar = r.kanaal === 'mail' ? r.email : r.telefoon_e164;
      const meld = (status, reden) => {
        rapport.regels.push({ gebruiker_id: r.gebruiker_id, traject: r.traject, soort: r.soort, kanaal: r.kanaal, naar, status, reden: reden || null });
      };

      // één per dag
      if (alVandaag.has(r.gebruiker_id)) { rapport.overgeslagen++; meld('overgeslagen', 'al bericht vandaag'); continue; }
      // toestemming (dubbelcheck; de view doet dit ook al)
      if (r.kanaal === 'whatsapp' && !r.toestemming) { rapport.overgeslagen++; meld('overgeslagen', 'geen toestemming'); continue; }
      // WhatsApp-sjabloon moet goedgekeurd zijn
      if (r.kanaal === 'whatsapp' && !goedgekeurd.has(r.soort)) { rapport.overgeslagen++; meld('overgeslagen', 'sjabloon niet goedgekeurd'); continue; }
      // te vaak gefaald vandaag -> definitief mislukt, niet blijven proberen
      if ((foutenVandaag[r.gebruiker_id + '|' + r.soort] || 0) >= 2) { rapport.overgeslagen++; meld('overgeslagen', 'na herhaalde fout gestopt'); continue; }

      // DROOGLOOP: niet echt versturen, maar wél een 'droog'-regel loggen zodat
      // je kunt terugkijken wat er zou zijn gegaan. Die regel blokkeert de
      // wachtrij niet (de view sluit alleen 'verstuurd' uit). Precies één keer
      // per (persoon, soort), zodat het beeld gelijk is aan live.
      if (droogloop) {
        const sleutel = (r.gebruiker_id || r.lead_id) + '|' + r.soort;
        if (alDroog.has(sleutel)) { rapport.overgeslagen++; meld('overgeslagen', 'al in droogloop gelogd'); continue; }
        await supabaseAdmin.from('berichten_log').insert({
          gebruiker_id: r.gebruiker_id, lead_id: r.lead_id, soort: r.soort, kanaal: r.kanaal,
          naar, agent: r.agent, traject: r.traject, status: 'droog', verstuurd_op: new Date().toISOString(),
        });
        alDroog.add(sleutel);
        alVandaag.add(r.gebruiker_id); // ook in droog de één-per-dag-grens respecteren
        rapport.verstuurd++; meld('zou versturen');
        continue;
      }

      // LIVE: de tekst komt uit de sjabloontabel (stap 4/5). Nog niet aanwezig?
      // Dan zichtbaar overslaan i.p.v. iets leegs te sturen.
      const sjabloon = await haalSjabloon(r.soort, r.kanaal);
      if (!sjabloon) { rapport.overgeslagen++; meld('overgeslagen', 'geen sjabloontekst (sjabloontabel volgt)'); continue; }

      // Versturen via de bestaande kanaal-code, en het resultaat wegschrijven.
      const logRij = {
        gebruiker_id: r.gebruiker_id, lead_id: r.lead_id, soort: r.soort,
        kanaal: r.kanaal, naar, agent: r.agent, traject: r.traject, verstuurd_op: new Date().toISOString(),
      };
      try {
        if (r.kanaal === 'mail') {
          const res2 = await sendEmailViaSmtp({ fromMailbox: MAIL_AFZENDER, to: naar, subject: sjabloon.onderwerp, text: sjabloon.tekst, html: sjabloon.html || null });
          if (!res2.ok) throw new Error(res2.reason || 'mail mislukt');
          logRij.extern_id = res2.messageId || null;
        } else {
          const res2 = await sendTemplate({ to: naar, templateName: r.soort, variables: sjabloon.variabelen || [] });
          logRij.extern_id = res2.wamid || null;
        }
        logRij.status = 'verstuurd';
        await supabaseAdmin.from('berichten_log').insert(logRij);
        alVandaag.add(r.gebruiker_id);
        rapport.verstuurd++; meld('verstuurd');
      } catch (e) {
        logRij.status = 'fout';
        logRij.fout = e?.message || String(e);
        await supabaseAdmin.from('berichten_log').insert(logRij);
        rapport.mislukt++; meld('mislukt', logRij.fout);
      }
    }

    return res.status(200).json({ ok: true, droogloop, uur, ...rapport });
  } catch (e) {
    console.error('cron-leadsonderhoud mislukt:', e.message);
    return res.status(500).json({ error: 'Motor mislukt', detail: e.message });
  }
}
