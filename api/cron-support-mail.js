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
// meta->bron_email_id op het bericht; de UIT-kant claimt per bericht en zet
// meta->mail_status om. Twee keer draaien binnen vijf minuten doet niets
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
  let mails = [];
  try {
    const grens = new Date(Date.now() - TERUGBLIK_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from('email_messages')
      .select('id, subject, from_address, body_text, snippet, date_received')
      .gte('date_received', grens)
      .ilike('subject', '%SUP-%')
      .order('date_received', { ascending: true })
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
      const { data: bestaand } = await supabaseAdmin
        .from('support_berichten')
        .select('id')
        .contains('meta', { bron_email_id: mail.id })
        .limit(1);
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
  let wachtend = [];
  try {
    const grens = new Date(Date.now() - BUNDEL_WACHT_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from('support_berichten')
      .select('id, gesprek_id, tekst, meta, created_at')
      .eq('afzender', 'medewerker')
      .contains('meta', { mail_status: 'wacht' })
      .lt('created_at', grens)
      .order('created_at', { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);
    wachtend = data || [];
  } catch (e) {
    uit.fouten.push('wachtende antwoorden lezen: ' + (e?.message || e));
    return;
  }
  if (!wachtend.length) return;

  // Per gesprek bundelen: één mail met alles wat er sinds de vorige mail bij
  // gekomen is, in de volgorde waarin de collega het typte.
  const perGesprek = new Map();
  for (const b of wachtend) {
    if (!perGesprek.has(b.gesprek_id)) perGesprek.set(b.gesprek_id, []);
    perGesprek.get(b.gesprek_id).push(b);
  }

  for (const [gesprekId, berichten] of perGesprek) {
    try {
      const { data: gesprek } = await supabaseAdmin
        .from('support_gesprekken')
        .select('kenmerk, naam, email')
        .eq('id', gesprekId)
        .maybeSingle();

      // Geen mailadres (meer)? Dan is er niets te versturen, maar de berichten
      // moeten wel uit de wachtrij — anders blijven ze elke run terugkomen.
      if (!gesprek?.email) {
        await markeer(berichten, 'geen_adres');
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
        await markeer(berichten, 'gemaild');
        uit.gebundeld += berichten.length;
        uit.gemaild++;
      } else {
        // Blijft op 'wacht' staan; de volgende run probeert het opnieuw. Een
        // tijdelijke SMTP-storing kost dan vijf minuten, geen bericht.
        uit.fouten.push(`${gesprek.kenmerk}: bundelmail niet verstuurd`);
      }
    } catch (e) {
      uit.fouten.push('bundelen: ' + (e?.message || e));
    }
  }
}

/** meta->mail_status omzetten, met behoud van de rest van meta. */
async function markeer(berichten, status) {
  for (const b of berichten) {
    try {
      await supabaseAdmin
        .from('support_berichten')
        .update({ meta: { ...(b.meta || {}), mail_status: status, mail_op: new Date().toISOString() } })
        .eq('id', b.id);
    } catch (e) {
      console.warn('[cron-support-mail] markeren mislukt:', e?.message || e);
    }
  }
}
