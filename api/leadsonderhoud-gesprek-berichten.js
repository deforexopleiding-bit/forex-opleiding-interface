// api/leadsonderhoud-gesprek-berichten.js
// GET ?lead_id=<uuid>[&conversation_id=<uuid>][&mark_as_read=true]
//   -> de samengevoegde draad van één lead: WhatsApp-berichten én inkomende mail,
//      op tijd gesorteerd, met per bericht het kanaal. conversation_id = het
//      WA-gesprek dat de lijst al kent (sinds 2026-10-09; anders zoekt de server
//      direct op het telefoonnummer).
// GET ?conversation_id=<uuid>[&mark_as_read=true]   (zonder lead_id)
//   -> lead-loze rij: alleen de WhatsApp-berichten van dat gesprek.
//
// Alleen lezen. Gate: leads.view. De lead moet in een traject zitten (anders 403).
// Bij mark_as_read wordt alleen de WhatsApp-ongelezenteller op 0 gezet; de
// gelezen-status van de mail laten we met rust (dat is de gedeelde e-mailmodule).
//
// Item-vorm (voor de frontend): { id, channel:'whatsapp'|'mail',
//   direction:'in'|'out', body, subject?, ts, is_read? }
//
// Response: { conversation:{ lead_id, naam, phone_number, email, can_send_text,
//             has_wa }, items:[…] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
// BP2 v3 (2026-09-01): setter-scope VERWIJDERD — Romy doet alle threads.
import {
  haalLijn, trajectSlugs, normNummer, binnenVenster, postvakNaam, adresUit, mailAfzender,
} from './_lib/leadsonderhoud-gesprekken.js';
import { vulSjabloon } from './_lib/leadsonderhoud-sjabloon.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  // conversation_id ZONDER lead_id → lead-loze rij: alleen de WhatsApp-berichten
  // van die conv (geen mail-tak — een lead-loze conv heeft geen e-mail).
  // Autorisatie: de conv staat op de leadsonderhoud-lijn.
  // conversation_id MÉT lead_id (2026-10-09) → het lead-pad hieronder, met de
  // conv die de lijst al kende als directe verwijzing (WA + mail blijven samen).
  const convIdQ = String(req.query.conversation_id || '').trim();
  if (convIdQ && !UUID_RE.test(convIdQ)) return res.status(400).json({ error: 'conversation_id ongeldig' });
  const leadId = String(req.query.lead_id || '');
  if (convIdQ && !leadId) {
    return threadByConversation(res, { convId: convIdQ, markRead: String(req.query.mark_as_read || '') === 'true' });
  }

  if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ontbreekt of ongeldig' });
  const markRead = String(req.query.mark_as_read || '') === 'true';

  try {
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('id, voornaam, achternaam, email, telefoon_e164, traject')
      .eq('id', leadId).maybeSingle();
    if (leadErr) throw leadErr;
    if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });

    // Traject-type staat sinds Feature 2 in leads.traject (soort = herkomst);
    // trajectSlugs() is lowercase, dus case-insensitive vergelijken.
    const slugs = await trajectSlugs();
    if (!slugs.has((lead.traject || '').toLowerCase())) {
      return res.status(403).json({ error: 'Deze lead zit niet in een traject' });
    }

    const lijn = await haalLijn();
    const items = [];

    // ── WhatsApp ──────────────────────────────────────────────────────────
    // 2026-10-09: het gesprek werd gezocht in een ONGESORTEERDE .limit(500)
    // van de lijn (>1000 gesprekken) → ~55% van de draden opende leeg, en de
    // mark_as_read hieronder (binnen `if (conv)`) werd dan ook overgeslagen →
    // "gelezen" sprong via de 20s-poll terug. Nu: vindLeadConv (direct).
    const conv = await vindLeadConv(lijn, lead, convIdQ || null);
    if (!conv && lijn.phoneNumberId && lead.telefoon_e164) {
      console.warn('[leadsonderhoud-gesprek-berichten] geen WA-gesprek gevonden voor lead', { lead: lead.id, hint: convIdQ || null });
    }
    if (conv) {
      const { data: waMsgs, error: waErr } = await supabaseAdmin
        .from('whatsapp_messages')
        .select('id, direction, body, media_type, media_url, template_name, created_at')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: true })
        .limit(200);
      if (waErr) console.error('[leadsonderhoud-gesprek-berichten] WA-berichten lezen mislukt:', { conv: conv.id, fout: waErr.message });
      else if (!(waMsgs || []).length) console.warn('[leadsonderhoud-gesprek-berichten] WA-gesprek zonder berichten', { conv: conv.id, lead: lead.id });
      for (const m of waMsgs || []) {
        // 2026-09-08: body-fallback naar '[image]' etc. blijft voor placeholder-
        // detectie in renderChatBody; die triggert alleen als er OOK geen
        // media_url is (of media_url is 'meta-media-expired:...'). Zie
        // _shared-v2.js:362-378 voor de render-branches.
        const tekst = m.body || (m.template_name ? '[sjabloon] ' + m.template_name : '')
          || (m.media_type ? '[' + m.media_type + ']' : '') || '';
        items.push({
          id: 'wa:' + m.id,
          channel: 'whatsapp',
          direction: m.direction === 'out' ? 'out' : 'in',
          body: tekst,
          ts: m.created_at,
          // Gelijkgetrokken met inbox-v2/wanbetalers-v2: media-info in `meta`
          // zodat renderChatBody (_shared-v2.js) `<img>` kan tonen i.p.v.
          // "media niet beschikbaar". Endpoint viel eerder terug op de
          // placeholder-tekst en gooide media_url weg.
          media_type: m.media_type || null,
          media_url:  m.media_url || null,
          meta: { media_type: m.media_type || null, media_url: m.media_url || null },
        });
      }
      if (markRead && (conv.unread_count || 0) > 0) {
        const { error: updErr } = await supabaseAdmin
          .from('whatsapp_conversations').update({ unread_count: 0 }).eq('id', conv.id);
        if (updErr) console.error('[leadsonderhoud-gesprek-berichten] mark_as_read faalde:', updErr.message);
      }
    }

    // ── Mail: inkomende antwoorden (email_messages) + uitgaande motor-mails
    //    (berichten_log). Beide gekoppeld aan de lead op het e-mailadres. ──
    if (lead.email) {
      const email = lead.email.toLowerCase();

      // Inkomend: de antwoorden die in het motor-postvak (welkom@) binnenkwamen.
      const { data: mails } = await supabaseAdmin
        .from('email_messages')
        .select('id, from_address, subject, snippet, body_text, date_received, is_read')
        .eq('mailbox', postvakNaam())
        .ilike('from_address', '%' + email + '%')
        .order('date_received', { ascending: true })
        .limit(200);
      const teMarkeren = [];
      for (const m of mails || []) {
        if (adresUit(m.from_address) !== email) continue; // precieze match
        if (!m.is_read) teMarkeren.push(m.id);
        items.push({
          id: 'mail:' + m.id,
          channel: 'mail',
          direction: 'in',
          body: m.body_text || m.snippet || '',
          subject: m.subject || null,
          ts: m.date_received,
          is_read: !!m.is_read,
        });
      }

      // Uitgaand: wat de motor per mail verstuurde (berichten_log, status
      // 'verstuurd'). De body staat niet in de log; we verrijken met de
      // sjabloontekst uit onderhoud_sjablonen, zodat de bubbel toont wat er ging.
      // (Toelatings-/afwijzingsmail komen van de website, niet van de motor, en
      // staan dus niet in berichten_log — die laten we hier weg.)
      const { data: logs } = await supabaseAdmin
        .from('berichten_log')
        .select('id, soort, traject, verstuurd_op, naar')
        .eq('kanaal', 'mail')
        .eq('status', 'verstuurd')
        .neq('soort', 'handmatig-antwoord') // die bubbel komt uit email_replies (met body)
        .ilike('naar', email)
        .order('verstuurd_op', { ascending: true })
        .limit(200);
      if (logs && logs.length) {
        const trajecten = [...new Set(logs.map((l) => l.traject).filter(Boolean))];
        const { data: sjabs } = await supabaseAdmin
          .from('onderhoud_sjablonen')
          .select('traject_slug, soort, onderwerp, tekst, html')
          .in('traject_slug', trajecten.length ? trajecten : ['-'])
          .eq('kanaal', 'mail')
          .eq('actief', true);
        const sjabOp = new Map();
        for (const s of sjabs || []) {
          const k = s.traject_slug + '|' + s.soort;
          if (!sjabOp.has(k)) sjabOp.set(k, s);
        }
        for (const row of logs) {
          const sj = sjabOp.get(row.traject + '|' + row.soort);
          let onderwerp = row.soort;
          let tekst = '';
          if (sj) {
            const v = vulSjabloon(sj, lead, {}); // best-effort invullen (voornaam etc.)
            onderwerp = v.onderwerp || row.soort;
            tekst = v.tekst || '';
          }
          items.push({
            id: 'log:' + row.id,
            channel: 'mail',
            direction: 'out',
            body: tekst,
            subject: onderwerp,
            template_name: row.soort,
            ts: row.verstuurd_op,
          });
        }
      }

      // Uitgaand: handmatige mailantwoorden vanuit dit postvak. Die staan in
      // email_replies (mét body), verstuurd vanaf de leadsonderhoud-afzender naar
      // de lead. Zo verschijnt een verstuurd antwoord meteen in de draad.
      const { data: replies } = await supabaseAdmin
        .from('email_replies')
        .select('id, email_subject, final_reply, from_address, to_address, sent_at')
        .ilike('from_address', mailAfzender())
        .ilike('to_address', '%' + email + '%')
        .order('sent_at', { ascending: true })
        .limit(200);
      for (const r of replies || []) {
        if (adresUit(r.to_address) !== email) continue; // precieze match
        items.push({
          id: 'reply:' + r.id,
          channel: 'mail',
          direction: 'out',
          body: r.final_reply || '',
          subject: r.email_subject || null,
          template_name: 'antwoord',
          ts: r.sent_at,
        });
      }

      // Inkomende mail op gelezen zetten (drijft de ongelezen-mailteller in de
      // lijst, die op email_messages.is_read leunt). De sync overschrijft dit niet
      // (upsert met ignoreDuplicates), dus het blijft staan.
      if (markRead && teMarkeren.length) {
        const { error: mErr } = await supabaseAdmin
          .from('email_messages').update({ is_read: true }).in('id', teMarkeren);
        if (mErr) console.error('[leadsonderhoud-gesprek-berichten] mail mark-read faalde:', mErr.message);
      }
    }

    // Samenvoegen op tijd (oudste eerst). Alle tijdstippen zijn timestamptz/ISO
    // (UTC), dus deze vergelijking is tijdzone-veilig; pas bij het TONEN wordt
    // naar Europe/Amsterdam geformatteerd (frontend kortMoment).
    items.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    return res.status(200).json({
      conversation: {
        lead_id: lead.id,
        naam: [lead.voornaam, lead.achternaam].filter(Boolean).join(' ') || lead.email || 'Onbekend',
        phone_number: lead.telefoon_e164 || (conv ? conv.phone_number : null),
        email: lead.email || null,
        can_send_text: conv ? binnenVenster(conv.last_inbound_at) : false,
        has_wa: !!conv,
      },
      items,
    });
  } catch (e) {
    console.error('leadsonderhoud-gesprek-berichten mislukt:', e.message);
    return res.status(500).json({ error: 'Berichten laden mislukt' });
  }
}

const CONV_VELDEN = 'id, phone_number, phone_number_id, last_inbound_at, unread_count';

/** Telefoonnummer-varianten zoals ze in whatsapp_conversations.phone_number kunnen staan. PURE. */
export function nummerVarianten(e164) {
  const d = normNummer(e164);
  return d ? [...new Set(['+' + d, d, '00' + d])] : [];
}

/**
 * Het WhatsApp-gesprek van een lead op de leadsonderhoud-lijn (2026-10-09).
 *   1. De conv die de lijst al kende (hint): alleen als hij op de lijn staat
 *      en het nummer bij de lead hoort — anders loggen en terugvallen.
 *   2. Anders DIRECT op phone_number_id + de nummervarianten, nieuwste eerst.
 * Nooit meer "pak N gesprekken en zoek erin" (dat miste >50% op >1000 convs).
 */
export async function vindLeadConv(lijn, lead, hintId = null) {
  if (!lijn?.phoneNumberId) return null;
  const doel = normNummer(lead?.telefoon_e164);
  if (hintId) {
    const { data, error } = await supabaseAdmin.from('whatsapp_conversations')
      .select(CONV_VELDEN).eq('id', hintId).maybeSingle();
    if (error) {
      console.error('[leadsonderhoud-gesprek-berichten] conv-hint lezen mislukt:', { hint: hintId, fout: error.message });
    } else if (data && String(data.phone_number_id) === String(lijn.phoneNumberId) && (!doel || normNummer(data.phone_number) === doel)) {
      return data;
    } else {
      console.warn('[leadsonderhoud-gesprek-berichten] conv-hint past niet bij lead/lijn — zoek op nummer', { hint: hintId, lead: lead?.id, gevonden: !!data });
    }
  }
  if (!doel) return null;
  const { data, error } = await supabaseAdmin.from('whatsapp_conversations')
    .select(CONV_VELDEN)
    .eq('phone_number_id', lijn.phoneNumberId)
    .in('phone_number', nummerVarianten(lead.telefoon_e164))
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1);
  if (error) {
    console.error('[leadsonderhoud-gesprek-berichten] conv op nummer zoeken mislukt:', { lead: lead?.id, fout: error.message });
    return null;
  }
  return (data || [])[0] || null;
}

// Thread op basis van conversation_id (lead-loze rij). Alleen WhatsApp;
// de WA-berichten-mapping is identiek aan het lead-pad hierboven. Autorisatie:
// de conv moet op de leadsonderhoud-lijn staan.
async function threadByConversation(res, { convId, markRead }) {
  try {
    const lijn = await haalLijn();
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id, last_inbound_at, unread_count')
      .eq('id', convId).maybeSingle();
    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ error: 'Gesprek niet gevonden' });
    if (String(conv.phone_number_id) !== String(lijn.phoneNumberId)) {
      return res.status(403).json({ error: 'Gesprek hoort niet bij de leadsonderhoud-lijn' });
    }

    const items = [];
    const { data: waMsgs, error: waErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .select('id, direction, body, media_type, media_url, template_name, created_at')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: true })
      .limit(200);
    if (waErr) console.error('[leadsonderhoud-gesprek-berichten] WA-berichten lezen mislukt (conv):', { conv: conv.id, fout: waErr.message });
    for (const m of waMsgs || []) {
      const tekst = m.body || (m.template_name ? '[sjabloon] ' + m.template_name : '')
        || (m.media_type ? '[' + m.media_type + ']' : '') || '';
      items.push({
        id: 'wa:' + m.id,
        channel: 'whatsapp',
        direction: m.direction === 'out' ? 'out' : 'in',
        body: tekst,
        ts: m.created_at,
        media_type: m.media_type || null,
        media_url:  m.media_url || null,
        meta: { media_type: m.media_type || null, media_url: m.media_url || null },
      });
    }
    if (markRead && (conv.unread_count || 0) > 0) {
      const { error: updErr } = await supabaseAdmin
        .from('whatsapp_conversations').update({ unread_count: 0 }).eq('id', conv.id);
      if (updErr) console.error('[leadsonderhoud-gesprek-berichten] mark_as_read faalde (conv):', updErr.message);
    }

    items.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    return res.status(200).json({
      conversation: {
        lead_id: null,
        conversation_id: conv.id,
        naam: conv.phone_number || 'Onbekend',
        phone_number: conv.phone_number || null,
        email: null,
        can_send_text: binnenVenster(conv.last_inbound_at),
        has_wa: true,
      },
      items,
    });
  } catch (e) {
    console.error('leadsonderhoud-gesprek-berichten (conv) mislukt:', e.message);
    return res.status(500).json({ error: 'Berichten laden mislukt' });
  }
}
