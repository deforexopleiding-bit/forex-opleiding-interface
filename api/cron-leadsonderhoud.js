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
import { vulSjabloon, instelWaarde } from './_lib/leadsonderhoud-sjabloon.js';

// Afzender-mailbox voor deze module. Standaard welkom@deforexopleiding.nl, maar
// via env LEADSONDERHOUD_MAIL_AFZENDER later om te zetten zonder codewijziging
// (zelfde gedachte als het WhatsApp-nummer als instelling). sendEmailViaSmtp
// gebruikt deze mailbox als SMTP-inloggebruiker én als From én als reply-to — de
// mail gaat dus écht via deze bus (goed voor SPF/DMARC), niet alleen als label.
// Vereist: de mailbox staat in SMTP_ACCOUNTS (send-email-core.js) en het
// wachtwoord in de bijbehorende env (welkom@ -> IMAP_PASS_WELKOM). Ontbreekt dat,
// dan faalt de send zichtbaar (SMTP_NOT_CONFIGURED) en belandt in berichten_log.
const MAIL_AFZENDER =
  process.env.LEADSONDERHOUD_MAIL_AFZENDER || 'welkom@deforexopleiding.nl';

// Is een env-vlag "aan"? Ruim: 1/true/aan/on/ja tellen als aan.
function aanUit(v) {
  return ['1', 'true', 'aan', 'on', 'ja'].includes(String(v || '').trim().toLowerCase());
}

// Amsterdamse klok — nodig voor de stille uren en de "één per dag"-grens.
function amsterdam(nu) {
  const uur = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }).format(nu));
  const datum = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(nu); // YYYY-MM-DD
  return { uur, datum };
}

/**
 * Haal het sjabloon voor (traject, soort) uit onderhoud_sjablonen en kies de
 * variant die bij de warmtescore past (score_min <= score < score_max). Geeft
 * null als er geen actief sjabloon is.
 */
async function haalSjabloon(traject, soort, score) {
  const { data } = await supabaseAdmin
    .from('onderhoud_sjablonen').select('*')
    .eq('traject_slug', traject).eq('soort', soort).eq('actief', true);
  const rijen = data || [];
  const s = Number(score) || 0;
  const past = rijen.filter((r) =>
    (r.score_min == null || s >= r.score_min) && (r.score_max == null || s < r.score_max));
  return past[0] || rijen[0] || null;
}

export default async function handler(req, res) {
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  // Noodstop: een env-vlag die alles blokkeert, ongeacht de database. Zo kun je
  // bij een probleem alles stilzetten zonder in te loggen; de UI-schuif blijft
  // voor het dagelijkse aan/uit.
  if (aanUit(process.env.LEADSONDERHOUD_UIT)) {
    return res.status(200).json({ ok: true, overgeslagen: 'noodstop (LEADSONDERHOUD_UIT)' });
  }

  const nu = new Date();
  const { uur, datum } = amsterdam(nu);

  try {
    // Live of droogloop? Uit de database, maar met een eigen schuif PER OMGEVING
    // (leadsonderhoud_live_production / _preview). Zo zet je live op de preview
    // niet per ongeluk productie aan — de cron draait immers alleen op productie.
    // Standaard droogloop als de rij ontbreekt.
    const omgeving = process.env.VERCEL_ENV || 'development';
    const { data: setting } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', 'leadsonderhoud_live_' + omgeving).maybeSingle();
    const droogloop = !(instelWaarde(setting) === 'true');

    // Logo-URL uit de instelling (niet hardgecodeerd in de sjablonen).
    const { data: logoRow } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', 'leadsonderhoud_logo_url').maybeSingle();
    const logoUrl = instelWaarde(logoRow);

    // Stille uren (21:00–08:00 Amsterdamse tijd) zijn standaard AAN, maar via
    // app_settings.leadsonderhoud_stille_uren = false 24/7 uit te zetten zonder
    // deploy. Afwezig of 'true' → venster blijft aan (huidige gedrag). Consistent
    // met hoe de live-/logo-instellingen hierboven gelezen worden.
    const { data: stilleSetting } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', 'leadsonderhoud_stille_uren').maybeSingle();
    const stilleUrenAan = !(instelWaarde(stilleSetting) === 'false');
    if (stilleUrenAan && (uur >= 21 || uur < 8)) {
      return res.status(200).json({ ok: true, overgeslagen: 'stille uren', uur });
    }

    // WhatsApp-afzendlijn voor leadsonderhoud: de Esmee/leads-lijn uit
    // whatsapp_module_config (module='leadsonderhoud'), consistent met hoe
    // onboarding-invite/-template-send hun modCfg.phone_number_id gebruiken.
    // BEWUST geen terugval op de globale (finance) default: is de lijn niet
    // geconfigureerd, dan slaan we WhatsApp-sends over met een zichtbare fout
    // (zie de guard in de loop), zodat een misconfig opvalt i.p.v. dat er
    // stilletjes van de finance-lijn wordt gestuurd.
    const { data: waCfg } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'leadsonderhoud')
      .eq('is_active', true)
      .maybeSingle();
    const leadsonderhoudPnId = waCfg?.phone_number_id || null;
    if (!leadsonderhoudPnId) {
      console.error('[cron-leadsonderhoud] Geen actieve leadsonderhoud-afzendlijn in whatsapp_module_config (module=leadsonderhoud) — WhatsApp-sends worden overgeslagen; GEEN finance-fallback.');
    }

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
      .select('name, status, meta_param_mapping');
    const goedgekeurd = new Set((templates || []).filter((t) => t.status === 'APPROVED').map((t) => t.name));
    // ÉÉN bron van waarheid voor de positional-volgorde: de goedgekeurde
    // Meta-template-body (meta_param_mapping.body). De motor leidt de volgorde
    // hieruit af i.p.v. uit variabele_volgorde, zodat de manager (die de body-
    // volgorde bepaalt) en de motor niet uit elkaar kunnen lopen. Naam ->
    // { "1":"lead.voornaam", ... }. Ontbreekt de mapping, dan valt vulSjabloon
    // terug op variabele_volgorde.
    const mappingByName = new Map();
    for (const t of templates || []) {
      const body = t && t.meta_param_mapping && t.meta_param_mapping.body;
      if (body && typeof body === 'object') mappingByName.set(t.name, body);
    }

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
      // WhatsApp-sjabloon-gate is verhuisd naar NA haalSjabloon (line ~192)
      // zodat we op sjabloon.meta_template kunnen matchen i.p.v. r.soort.
      // Reden: r.soort heeft streepjes ('niet-ingelogd'); meta_template
      // heeft underscores ('niet_ingelogd'). Meta-templates in de DB staan
      // op de underscore-naam, dus de oude gate op r.soort miste 7 van de 8.
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

      // LIVE. De toelatingsmail stuurt de website zelf — die heeft een inloglink
      // van maar een uur, dus die moet direct bij goedkeuring de deur uit, niet
      // als de cron toevallig draait. De motor doet alleen de opvolging.
      if (r.soort === 'toelating') { rapport.overgeslagen++; meld('overgeslagen', 'toelating: de website stuurt deze'); continue; }

      const sjabloon = await haalSjabloon(r.traject, r.soort, r.score);
      if (!sjabloon) { rapport.overgeslagen++; meld('overgeslagen', 'geen sjabloon in de tabel'); continue; }

      // WhatsApp-goedkeurings-gate op meta_template (post-haalSjabloon).
      // sjabloon.meta_template is de underscore-naam ('niet_ingelogd') die
      // matcht met whatsapp_meta_templates.name; r.soort heeft streepjes
      // ('niet-ingelogd') dus die matchte niet. Fallback op sjabloon.soort
      // voor sjablonen zonder expliciete meta_template (identiek aan de
      // fallback in vulSjabloon).
      const metaNaam = sjabloon.meta_template || sjabloon.soort;
      if (r.kanaal === 'whatsapp') {
        if (!goedgekeurd.has(metaNaam)) {
          rapport.overgeslagen++;
          meld('overgeslagen', 'sjabloon niet goedgekeurd (' + metaNaam + ')');
          continue;
        }
      }

      // Eén invul-functie voor beide kanalen; de agendalink komt uit het traject,
      // de logo-URL uit de instelling. Voor WhatsApp bepaalt de goedgekeurde
      // Meta-template-body (meta_param_mapping) de volgorde; ontbreekt die, dan
      // valt vulSjabloon terug op variabele_volgorde.
      const metaMap = r.kanaal === 'whatsapp' ? (mappingByName.get(metaNaam) || null) : null;
      const ingevuld = vulSjabloon(sjabloon, r, { agendalink: r.agenda_link, logo: logoUrl }, metaMap);

      // Staat er onverhoopt nog een {inloglink} in, dan hoort dit bericht bij de
      // website — niet met een lege link versturen.
      if (ingevuld.kanaal === 'mail' &&
          (String(ingevuld.tekst || '').includes('{inloglink}') || String(ingevuld.html || '').includes('{inloglink}'))) {
        rapport.overgeslagen++; meld('overgeslagen', 'bevat inloglink — hoort bij de website'); continue;
      }

      // WhatsApp kan alleen via de geconfigureerde leadsonderhoud-lijn. Ontbreekt
      // die, dan NIET van de globale (finance) default sturen — overslaan + loggen.
      if (ingevuld.kanaal === 'whatsapp' && !leadsonderhoudPnId) {
        rapport.overgeslagen++;
        meld('overgeslagen', 'leadsonderhoud-afzendlijn niet geconfigureerd (whatsapp_module_config) — geen finance-fallback');
        continue;
      }

      // Defensieve guard: WhatsApp-templates weigert Meta bij een lege
      // parameter ("param {{N}} is empty"). Voorkom crash-sends en log
      // welke variabele-index leeg was + welke naam die had volgens
      // variabele_volgorde, zodat het rapport zichtbaar maakt welke
      // template-variabele nog gevuld moet worden (bv. lessen_gezien /
      // trades in de wachtrij-view, of tijd voor gesprek_herinnering).
      if (ingevuld.kanaal === 'whatsapp') {
        const varr = Array.isArray(ingevuld.variabelen) ? ingevuld.variabelen : [];
        const leegIdx = varr.findIndex((v) => v == null || String(v).trim() === '');
        if (leegIdx >= 0) {
          // Naam van de lege variabele volgens de gebruikte volgorde-bron
          // (meta_param_mapping of variabele_volgorde) — via ingevuld.namen.
          const namen = Array.isArray(ingevuld.namen) ? ingevuld.namen : [];
          const naam = namen[leegIdx] || `#${leegIdx + 1}`;
          rapport.overgeslagen++;
          meld('overgeslagen', `template-variabele leeg: {{${leegIdx + 1}}} (${naam}) — vul de bron in wachtrij/motor`);
          continue;
        }
      }

      // Versturen via de bestaande kanaal-code, en het resultaat wegschrijven.
      const logRij = {
        gebruiker_id: r.gebruiker_id, lead_id: r.lead_id, soort: r.soort,
        kanaal: r.kanaal, naar, agent: r.agent, traject: r.traject, verstuurd_op: new Date().toISOString(),
      };
      try {
        if (ingevuld.kanaal === 'mail') {
          const res2 = await sendEmailViaSmtp({ fromMailbox: MAIL_AFZENDER, to: naar, subject: ingevuld.onderwerp, text: ingevuld.tekst, html: ingevuld.html, handtekening: true });
          if (!res2.ok) throw new Error(res2.reason || 'mail mislukt');
          logRij.extern_id = res2.messageId || null;
        } else {
          const res2 = await sendTemplate({ to: naar, templateName: ingevuld.meta_template, variables: ingevuld.variabelen, phoneNumberId: leadsonderhoudPnId });
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
