// api/cron-support-mail.js
//
// Elke vijf minuten. De mailkant van de supportmodule, twee richtingen.
//
//   IN  — een klant antwoordt op onze mail. Die mail komt binnen op info@ en
//         belandde tot nu toe alleen in de e-mailmodule; het gesprek bleef op
//         'wacht_op_klant' staan en niemand in de wachtrij zag iets. Nu komt
//         de tekst terug in de thread en gaat het gesprek weer naar ons.
//
//   UIT — twee antwoorden kort na elkaar werden twee losse mails. De eerste
//         gaat direct de deur uit (support-antwoord.js doet dat zelf); wat
//         daar binnen drie minuten op volgt blijft liggen en gaat hier in één
//         mail mee.
//
// Idempotent. De IN-kant herkent een al verwerkte mail aan
// meta->bron_email_id op het bericht; de UIT-kant claimt per bericht met een
// voorwaardelijke update (alleen als meta nog precies zo staat als gelezen) en
// zet meta->mail_status om. Twee keer draaien binnen vijf minuten doet niets
// dubbel.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { schrijfBericht } from './_lib/support-sessie.js';
import { stuurAntwoordMail } from './_lib/support-mail.js';
import { kenmerkUitOnderwerp, strookCitaat, afzenderHoortBij } from './_lib/support-mailbrug.js';
import { createNotification, resolveOntvangersVoorRecht } from './_lib/notify.js';

// Hoe ver terug we kijken in de mailbox. Ruim genoeg om een sync-hapering te
// overleven, kort genoeg om de query klein te houden.
const TERUGBLIK_MS = 6 * 60 * 60 * 1000;

// Hoe lang een antwoord mag wachten op een mogelijk vervolgbericht.
const BUNDEL_WACHT_MS = 3 * 60 * 1000;

// Een bericht dat al zo lang op 'direct' of 'versturen' staat, hoort bij een
// run die niet meer bestaat (Vercel kapt na 60s af). Dan pakken we het opnieuw
// op: liever één mail te veel dan een antwoord dat nooit aankomt.
const HANGT_MS = 15 * 60 * 1000;

// Na zoveel mislukte pogingen (één per run, dus ruim een uur) stoppen we. Een
// adres dat blijvend weigert mag de wachtrij niet eeuwig bezet houden.
const MAX_POGINGEN = 12;

export default async function handler(req, res) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const uit = { binnengekomen: 0, genegeerd: 0, gebundeld: 0, gemaild: 0, fouten: [] };

  await verwerkInkomendeMail(uit);
  await verstuurWachtendeAntwoorden(uit);

  return res.status(200).json(uit);
}

/* ── IN: mailantwoorden terug in het gesprek ──────────────────────────────── */

async function verwerkInkomendeMail(uit) {
  // Nieuwste eerst: verwerkte mails blijven zes uur in het venster staan. Met
  // de oudste eerst zou een drukke middag de limiet vullen met mails die al
  // binnen zijn, en kwam de nieuwe mail pas aan de beurt als de oude uit het
  // venster vielen.
  let mails = [];
  try {
    const grens = new Date(Date.now() - TERUGBLIK_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from('email_messages')
      .select('id, subject, from_address, body_text, snippet, date_received')
      .gte('date_received', grens)
      .ilike('subject', '%SUP-%')
      .order('date_received', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    mails = data || [];
  } catch (e) {
    uit.fouten.push('mail lezen: ' + (e?.message || e));
    return;
  }

  for (const mail of mails) {
    try {
      const kenmerk = kenmerkUitOnderwerp(mail.subject);
      if (!kenmerk) continue;

      // Al verwerkt? Dan is er niets te doen. Dit is de idempotentie-grendel:
      // de cron draait vaker dan de terugblik lang is, dus elke mail komt
      // gegarandeerd meerdere keren langs.
      // Een fout hier is géén "nog niet verwerkt": dan slaan we de mail over
      // en proberen het de volgende run opnieuw. Anders zou een haperende
      // query elke keer een dubbel bericht in de thread zetten.
      const { data: bestaand, error: bestaandErr } = await supabaseAdmin
        .from('support_berichten')
        .select('id')
        .contains('meta', { bron_email_id: mail.id })
        .limit(1);
      if (bestaandErr) {
        uit.fouten.push(`idempotentie-check ${mail.id}: ${bestaandErr.message}`);
        continue;
      }
      if ((bestaand || []).length) continue;

      const { data: gesprek } = await supabaseAdmin
        .from('support_gesprekken')
        .select('*')
        .eq('kenmerk', kenmerk)
        .maybeSingle();
      if (!gesprek) { uit.genegeerd++; continue; }

      // De enige toegangscontrole op deze route. Zie support-mailbrug.js.
      if (!afzenderHoortBij(mail.from_address, gesprek.email)) {
        console.warn(
          `[cron-support-mail] ${kenmerk}: afzender ${mail.from_address} hoort niet bij dit gesprek — genegeerd`,
        );
        uit.genegeerd++;
        continue;
      }

      const tekst = strookCitaat(mail.body_text || mail.snippet || '');
      if (!tekst) { uit.genegeerd++; continue; }

      const bericht = await schrijfBericht({
        gesprekId: gesprek.id,
        afzender: 'klant',
        tekst,
        meta: { via: 'mail', bron_email_id: mail.id },
      });
      if (!bericht) { uit.fouten.push(`${kenmerk}: bericht schrijven mislukt`); continue; }

      // De bal ligt weer bij ons. Ook als het gesprek al afgehandeld was: een
      // klant die terugschrijft heeft een vervolgvraag, en die hoort in de
      // wachtrij en niet in het archief.
      await supabaseAdmin
        .from('support_gesprekken')
        .update({ status: 'wacht_op_ons' })
        .eq('id', gesprek.id);

      await meldWachtrij(gesprek, uit);
      uit.binnengekomen++;
    } catch (e) {
      uit.fouten.push('mail verwerken: ' + (e?.message || e));
    }
  }
}

async function meldWachtrij(gesprek, uit) {
  try {
    const { userIds } = await resolveOntvangersVoorRecht('support.reply');
    for (const userId of (userIds || []).slice(0, 25)) {
      await createNotification({
        toUserId: userId,
        type: 'support.mailantwoord',
        title: `Mailantwoord op ${gesprek.kenmerk}`,
        body: `${gesprek.naam || 'Een bezoeker'} heeft per mail geantwoord (${gesprek.onderwerp}).`,
        linkUrl: `/modules/klanten-v2/?mod=support&gesprek=${gesprek.id}`,
        entityType: 'support_gesprek',
        entityId: gesprek.id,
        priority: 'normal',
      });
    }
  } catch (e) {
    uit.fouten.push('notificatie: ' + (e?.message || e));
  }
}

/* ── UIT: wachtende antwoorden gebundeld versturen ────────────────────────── */

async function verstuurWachtendeAntwoorden(uit) {
  let kandidaten = [];
  try {
    const { data, error } = await supabaseAdmin
      .from('support_berichten')
      .select('id, gesprek_id, tekst, meta, created_at')
      .eq('afzender', 'medewerker')
      .in('meta->>mail_status', ['wacht', 'direct', 'versturen'])
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    kandidaten = data || [];
  } catch (e) {
    uit.fouten.push('wachtende antwoorden lezen: ' + (e?.message || e));
    return;
  }
  if (!kandidaten.length) return;

  const nu = Date.now();
  const hangt = (b) => nu - (Date.parse(b.meta?.mail_op || b.created_at) || 0) > HANGT_MS;
  const klaar = (b) => b.meta?.mail_status === 'wacht' || hangt(b);

  // Per gesprek bundelen: één mail met alles wat er sinds de vorige mail bij
  // gekomen is, in de volgorde waarin de collega het typte. Het gesprek gaat
  // pas de deur uit als het oudste wachtende bericht zijn drie minuten gehad
  // heeft; dan gaan ook de jongere mee, anders knipt de cron een reeks van
  // drie zinnen alsnog in twee mails.
  const perGesprek = new Map();
  for (const b of kandidaten) {
    if (!klaar(b)) continue;
    if (!perGesprek.has(b.gesprek_id)) perGesprek.set(b.gesprek_id, []);
    perGesprek.get(b.gesprek_id).push(b);
  }

  for (const [gesprekId, alle] of perGesprek) {
    try {
      const oudste = Date.parse(alle[0].created_at) || 0;
      if (nu - oudste < BUNDEL_WACHT_MS && !alle.some(hangt)) continue;

      // Claimen. Alleen wat wij daadwerkelijk omzetten gaat mee; een parallelle
      // run die hetzelfde las krijgt niets terug en stuurt dus niets.
      const berichten = [];
      for (const b of alle) {
        const geclaimd = await zetStatus(b, 'versturen', { vereist: true });
        if (geclaimd) berichten.push(geclaimd);
      }
      if (!berichten.length) continue;

      const { data: gesprek } = await supabaseAdmin
        .from('support_gesprekken')
        .select('kenmerk, naam, email')
        .eq('id', gesprekId)
        .maybeSingle();

      // Geen mailadres (meer)? Dan is er niets te versturen, maar de berichten
      // moeten wel uit de wachtrij — anders blijven ze elke run terugkomen.
      if (!gesprek?.email) {
        for (const b of berichten) await zetStatus(b, 'geen_adres');
        continue;
      }

      const tekst = berichten.map((b) => b.tekst).join('\n\n');
      const medewerker = berichten[berichten.length - 1]?.meta?.afzender_naam || null;

      const verstuurd = await stuurAntwoordMail({
        naar: gesprek.email,
        naam: gesprek.naam,
        kenmerk: gesprek.kenmerk,
        antwoord: tekst,
        medewerker,
      }).catch((e) => {
        console.warn('[cron-support-mail] bundelmail mislukt:', e?.message || e);
        return null;
      });

      if (verstuurd?.ok) {
        for (const b of berichten) await zetStatus(b, 'gemaild');
        uit.gebundeld += berichten.length;
        uit.gemaild++;
      } else {
        // Terug op 'wacht'; de volgende run probeert het opnieuw. Een
        // tijdelijke SMTP-storing kost dan vijf minuten, geen bericht. Na
        // MAX_POGINGEN geven we het op, zodat een blijvend weigerend adres de
        // wachtrij niet eeuwig bezet houdt.
        for (const b of berichten) {
          const pogingen = (Number(b.meta?.mail_pogingen) || 0) + 1;
          const opgeven = pogingen >= MAX_POGINGEN;
          if (opgeven) {
            console.error(`[cron-support-mail] ${gesprek.kenmerk}: bericht ${b.id} na ${pogingen} pogingen niet gemaild — opgegeven`);
          }
          await zetStatus(b, opgeven ? 'mislukt' : 'wacht', { extra: { mail_pogingen: pogingen } });
        }
        uit.fouten.push(`${gesprek.kenmerk}: bundelmail niet verstuurd`);
      }
    } catch (e) {
      uit.fouten.push('bundelen: ' + (e?.message || e));
    }
  }
}

/**
 * meta->mail_status omzetten, met behoud van de rest van meta.
 *
 * Met `vereist` is het een claim: de update slaagt alleen als mail_status en
 * mail_op nog precies zo staan als wij ze lazen. Geeft de bijgewerkte rij
 * terug, of null als een ander ons voor was (of de update faalde).
 */
async function zetStatus(b, status, { vereist = false, extra = {} } = {}) {
  const meta = { ...(b.meta || {}), ...extra, mail_status: status, mail_op: new Date().toISOString() };
  try {
    let q = supabaseAdmin.from('support_berichten').update({ meta }).eq('id', b.id);
    if (vereist) {
      const zoalsGelezen = { mail_status: b.meta?.mail_status };
      if (b.meta?.mail_op) zoalsGelezen.mail_op = b.meta.mail_op;
      q = q.contains('meta', zoalsGelezen);
    }
    const { data, error } = await q.select('id, gesprek_id, tekst, meta, created_at');
    if (error) throw new Error(error.message);
    return (data || [])[0] || null;
  } catch (e) {
    console.warn('[cron-support-mail] mail_status bijwerken mislukt:', e?.message || e);
    return null;
  }
}
