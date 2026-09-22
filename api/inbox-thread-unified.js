// api/inbox-thread-unified.js
// GET → verenigde thread (WhatsApp + e-mail) chronologisch gesorteerd voor 1 klant.
//
// FASE 4 blok 3 — kern-endpoint van de unified inbox. Voedt de rendering
// achter de feature-flag `unified_inbox_enabled`. Fail-safe: als de flag UIT
// staat gebruikt de UI nog steeds /api/inbox-messages-list en raakt dit
// endpoint niet aan.
//
// Query:
//   ?conversation_id=<uuid>   (verplicht — WA-conv geeft ook meteen customer_id)
//   ?include_email=1|0        (default 1)
//   ?limit=200                (max items per bladzijde, oldest-first)
//   ?voor=<ISO-tijdstempel>   (optioneel — alleen wat op of vóór dit moment zit)
//
// Response 200:
//   {
//     items: [
//       { channel: 'whatsapp'|'email',
//         id, direction: 'inbound'|'outbound', body, at, meta: {...} },
//       ...
//     ],
//     conversation: { id, customer_id, can_send_text, phone_number },
//     counts: { whatsapp, email, total },
//     heeft_meer: boolean,      // er zit nog geschiedenis vóór items[0]
//     oudste_at: string|null    // de grens om mee door te vragen (?voor=)
//   }
//
// ── G8: één bladzijde tegelijk ───────────────────────────────────────────────
// Elke bron wordt NIEUWSTE-EERST opgehaald met één rij meer dan we tonen, en
// daarna omgedraaid. Voorheen haalde dit endpoint álles op om vervolgens
// alles weg te gooien behalve de laatste 200 — dat groeit mee met de
// geschiedenis, dus precies bij de klant met wie je het meest gepraat hebt
// loopt het als eerste tegen de tijdslimiet.
//
// LET OP bij `counts`: die tellen wat er in DEZE bladzijde zit, niet wat er in
// totaal bestaat. Voor "is er meer" is `heeft_meer` het antwoord; een telling
// van alles zou een tweede opvraging kosten die niemand gebruikt.
//
// `?voor=` is KLEINER-OF-GELIJK, niet kleiner. Bij mail is de tijdstempel op
// de seconde nauwkeurig, dus twee berichten in dezelfde seconde is geen
// bedenksel, en met "kleiner dan" zou zo'n bericht op de bladzijdegrens
// verdwijnen. Het scherm ontdubbelt op kanaal+id — zie nieuweDraadItems() in
// modules/shared/gesprekken-v2.js.
//
// Permission: finance.inbox.view (dezelfde als inbox-messages-list).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { gesprekkenV2Aan } from './_lib/gesprekken-vlag.js';
import { mailadressenVan, telefoonSleutels, viaContactZoeken, orReeks } from './_lib/gesprekken-mailkoppel.js';
import { pickEmailPreviewBody } from './_lib/email-body-strip.js';
import { leesGrens, ophaalAantal, venster } from './_lib/gesprekken-draadvenster.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.inbox.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.view)' });
  }

  const q = req.query || {};
  const convId = q.conversation_id ? String(q.conversation_id).trim() : '';
  if (!convId || !UUID_RE.test(convId)) {
    return res.status(400).json({ error: 'conversation_id (uuid) vereist' });
  }
  const includeEmail = String(q.include_email ?? '1') === '1';
  const limit = clampInt(q.limit, 200, 10, 500);
  // De grens voor de vorige bladzijde. Onleesbaar → null, en dan halen we
  // gewoon de nieuwste bladzijde op; NOOIT "dan maar alles".
  const grens = leesGrens(q.voor);
  const perBron = ophaalAantal(limit);

  try {
    // 1) Conv-details.
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, status, phone_number, last_inbound_at, unread_count')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conv: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // can_send_text: last_inbound_at < 24h geleden.
    let canSendText = false;
    if (conv.last_inbound_at) {
      const ms = new Date(conv.last_inbound_at).getTime();
      canSendText = (Date.now() - ms) < 24 * 3600 * 1000;
    }

    // 2) WhatsApp-messages voor deze conv.
    let waVraag = supabaseAdmin
      .from('whatsapp_messages')
      // failed_reason erbij (G9): zonder die kolom ziet een mislukt bericht er
      // in het scherm precies zo uit als een afgeleverd bericht.
      .select('id, direction, body, media_url, media_type, template_name, status, sent_at, delivered_at, read_at, failed_reason, meta_wamid, created_at')
      .eq('conversation_id', convId);
    if (grens) waVraag = waVraag.lte('created_at', grens);
    // Nieuwste eerst ophalen en daarna omdraaien (G8) — zie de kop van dit
    // bestand. De rest van de verwerking verwacht oplopend.
    const { data: waRuw, error: waErr } = await waVraag
      .order('created_at', { ascending: false })
      .limit(perBron);
    if (waErr) throw new Error('whatsapp: ' + waErr.message);
    const waMsgs = (waRuw || []).slice().reverse();

    // 3) Email-messages voor gekoppelde klant (indien any).
    // imap_uid + message_id worden meegegeven zodat de client de composite
    // email_id ('<mailbox>:<imap_uid>') kan bouwen voor /api/send-email
    // reply-modus, en het endpoint threading-headers kan zetten op basis van
    // message_id.
    let emailMsgs = [];
    // 3b) Email-replies (onze eigen verzonden mail). Werd voorheen NIET
    // meegenomen — sync-emails polt alleen INBOX, dus onze verzonden mail
    // stond alleen in email_replies (opgeslagen door send-email.js).
    // Zonder deze fetch was de thread eenzijdig (alleen inkomend).
    let emailReplies = [];

    // G6 — geen klant? Dan via het contact. Zie _lib/gesprekken-mailkoppel.js
    // voor waarom dat juist bij een ONgekoppeld gesprek uitmaakt. Levert deze
    // omweg niets op, dan gedraagt de draad zich als altijd.
    let contactAdressen = [];
    if (includeEmail && viaContactZoeken({
      customerId: conv.customer_id,
      telefoon: conv.phone_number,
      vlagAan: gesprekkenV2Aan(),
    })) {
      try {
        const sleutels = telefoonSleutels(conv.phone_number);
        let contact = null;
        for (const sleutel of [sleutels.volledig, sleutels.staart]) {
          if (!sleutel || contact) continue;
          const { data } = await supabaseAdmin
            .from('iris_contacten')
            .select('id, emails')
            .contains('telefoons', [sleutel])
            .limit(2);
          // Twee contacten op hetzelfde nummer hoort niet te kunnen. Gebeurt
          // het toch, dan kiezen we er geen — een draad vullen met de mail van
          // misschien-iemand-anders is erger dan een lege draad.
          if (Array.isArray(data) && data.length === 1) contact = data[0];
        }
        contactAdressen = mailadressenVan(contact);
      } catch (cEx) {
        // Faalzacht: de WhatsApp-draad staat hier niet op te wachten.
        console.warn('[inbox-thread-unified] contact-mailkoppeling:', cEx?.message || cEx);
      }
    }

    // De reeksen apart, en alleen zoeken als er echt iets te zoeken valt. Een
    // lege or() is een opvraging ZONDER filter, en die geeft alle mail van
    // iedereen terug — precies de fout die je pas merkt als er een vreemde in
    // de draad staat.
    const orInkomend = orReeks('from_address', contactAdressen);
    const orUitgaand = orReeks('to_address', contactAdressen);
    if (includeEmail && orInkomend && orUitgaand) {
      try {
        let cmVraag = supabaseAdmin
          .from('email_messages')
          .select('id, mailbox, imap_uid, from_address, from_name, subject, snippet, body_text, body_html, date_received, message_id, category, attachments')
          .or(orInkomend);
        if (grens) cmVraag = cmVraag.lte('date_received', grens);
        const { data: eMsgs, error: eErr } = await cmVraag
          .order('date_received', { ascending: false })
          .limit(perBron);
        if (eErr) console.warn('[inbox-thread-unified] contact-mail fetch:', eErr.message);
        else emailMsgs = (eMsgs || []).slice().reverse();

        let crVraag = supabaseAdmin
          .from('email_replies')
          .select('id, email_id, email_subject, final_reply, from_address, to_address, cc_address, sent_at, sent_by_id, attachments')
          .or(orUitgaand);
        if (grens) crVraag = crVraag.lte('sent_at', grens);
        const { data: replies, error: rErr } = await crVraag
          .order('sent_at', { ascending: false })
          .limit(perBron);
        if (rErr) console.warn('[inbox-thread-unified] contact-replies fetch:', rErr.message);
        else emailReplies = (replies || []).slice().reverse();
      } catch (mEx) {
        console.warn('[inbox-thread-unified] contact-mail uitzondering:', mEx?.message || mEx);
      }
    }

    if (includeEmail && conv.customer_id) {
      let kmVraag = supabaseAdmin
        .from('email_messages')
        .select('id, mailbox, imap_uid, from_address, from_name, subject, snippet, body_text, body_html, date_received, message_id, category, attachments')
        .eq('customer_id', conv.customer_id);
      if (grens) kmVraag = kmVraag.lte('date_received', grens);
      const { data: eMsgs, error: eErr } = await kmVraag
        .order('date_received', { ascending: false })
        .limit(perBron);
      if (eErr) {
        // Fail-soft: email-fetch mag WA-thread niet blokkeren.
        console.warn('[inbox-thread-unified] email fetch failed:', eErr.message);
      } else {
        emailMsgs = (eMsgs || []).slice().reverse();
      }

      // Onze verzonden replies. Match op customer.email (case-insensitive
      // to_address). Alternatief zou email_id-threading zijn, maar die is
      // best-effort en pakt geen "cold outbound" (mails die wij als eerste
      // sturen, niet als antwoord). email-matching is robuuster.
      try {
        const { data: custRow } = await supabaseAdmin
          .from('customers')
          .select('email')
          .eq('id', conv.customer_id)
          .maybeSingle();
        const custEmail = String(custRow?.email || '').trim().toLowerCase();
        if (custEmail) {
          let krVraag = supabaseAdmin
            .from('email_replies')
            .select('id, email_id, email_subject, final_reply, from_address, to_address, cc_address, sent_at, sent_by_id, attachments')
            .ilike('to_address', custEmail);
          if (grens) krVraag = krVraag.lte('sent_at', grens);
          const { data: replies, error: rErr } = await krVraag
            .order('sent_at', { ascending: false })
            .limit(perBron);
          if (rErr) {
            console.warn('[inbox-thread-unified] email_replies fetch failed:', rErr.message);
          } else {
            emailReplies = (replies || []).slice().reverse();
          }
        }
      } catch (rEx) {
        console.warn('[inbox-thread-unified] email_replies exception:', rEx?.message || rEx);
      }
    }

    // 4) Merge chronologisch.
    // ⚠ BUG-FIX: whatsapp_messages.direction is DB-kolom met CHECK IN ('in','out')
    // — NIET 'inbound'/'outbound' (zie migratie 2026-06-07-whatsapp-inbox-
    // foundation.sql:65). De endpoint-spec belooft 'inbound'|'outbound' zodat
    // de UI daar zonder ambiguïteit tegen kan checken. Normaliseer hier.
    const normalizeWaDirection = (d) => {
      const s = String(d || '').toLowerCase();
      if (s === 'out' || s === 'outbound') return 'outbound';
      return 'inbound';
    };
    // ⚠ Voor e-mail: from_address = onze SMTP-mailbox → outbound (wij hebben
    // dit verstuurd, IMAP heeft 'em ge-Sent-Items gemirrord); anders → inbound
    // (klant heeft naar ons gemaild). Hardcoded set van onze 6 mailboxen —
    // consistent met SMTP_ACCOUNTS in api/send-email.js.
    const OUR_MAILBOXES = new Set([
      'leads@deforexopleiding.nl',
      'info@deforexopleiding.nl',
      'partners@deforexopleiding.nl',
      'administratie@deforexopleiding.nl',
      'onboarding@deforexopleiding.nl',
      'events@deforexopleiding.nl',
      'welkom@deforexopleiding.nl',
    ]);
    const emailDirection = (fromAddr) => {
      const addr = String(fromAddr || '').toLowerCase().trim();
      return addr && OUR_MAILBOXES.has(addr) ? 'outbound' : 'inbound';
    };

    const items = [];
    for (const m of waMsgs || []) {
      items.push({
        channel: 'whatsapp',
        id: m.id,
        direction: normalizeWaDirection(m.direction), // 'in'/'out' → 'inbound'/'outbound'
        body: m.body || (m.template_name ? `[template] ${m.template_name}` : (m.media_type ? `[${m.media_type}]` : '')),
        at: m.created_at || m.sent_at,
        meta: {
          media_url: m.media_url,
          media_type: m.media_type,
          template_name: m.template_name,
          status: m.status,
          failed_reason: m.failed_reason || null,
          wamid: m.meta_wamid,
          raw_direction: m.direction, // voor debugging
        },
      });
    }
    for (const m of emailMsgs) {
      items.push({
        channel: 'email',
        id: m.id,
        // BUG-FIX: was hardcoded 'inbound'. E-mail_messages is IMAP-source
        // waaraan óók onze verzonden mail meelift (Strato mirrort Sent-items
        // via IMAP naar de bijbehorende INBOX). Als from_address = onze
        // mailbox → dat is een outbound (door ons verstuurde) mail.
        direction: emailDirection(m.from_address),
        // BUG-FIX (2026-07-31): fallback via pickEmailPreviewBody op body_html
        // → gestripte plain text als snippet én body_text beide NULL zijn.
        // Moderne HTML-only mails (Outlook, marketing, veel bedrijfsmail)
        // hebben geen text/plain part → rawText leeg in sync-emails.js:207 →
        // snippet + body_text staan op NULL, alleen body_html is gevuld.
        // Zonder deze fallback toonde de unified UI "(lege body)".
        body: pickEmailPreviewBody(m, { maxLen: 4000 }),
        at: m.date_received,
        meta: {
          subject: m.subject,
          mailbox: m.mailbox,
          imap_uid: m.imap_uid,                    // voor composite email_id
          email_id_composite: (m.mailbox && m.imap_uid) ? `${m.mailbox}:${m.imap_uid}` : null,
          from_address: m.from_address,
          from_name: m.from_name,
          category: m.category,
          message_id: m.message_id,                // voor In-Reply-To / References
          has_html: !!m.body_html,
          // Attachments — array van {filename, mime_type, size_bytes, path,
          // public_url, uploaded_at}. NULL = nog niet verwerkt (pre-migratie
          // rows). [] = expliciet 0 bijlagen. Zie
          // api/_lib/email-attachment-upload.js voor shape.
          attachments: Array.isArray(m.attachments) ? m.attachments : null,
        },
      });
    }
    // Onze eigen verzonden mails (email_replies). Altijd 'outbound' — deze
    // rijen worden pas geschreven bij een succesvolle sendMail-call, dus
    // per definitie door ons uitgestuurd. Body = final_reply (plain text).
    for (const r of emailReplies) {
      items.push({
        channel: 'email',
        id: `reply:${r.id}`, // prefix om ID-conflict met email_messages te voorkomen
        direction: 'outbound',
        body: String(r.final_reply || '').slice(0, 4000),
        at: r.sent_at,
        meta: {
          subject: r.email_subject || null,
          from_address: r.from_address,
          to_address: r.to_address,
          cc_address: r.cc_address || null,
          sent_by_id: r.sent_by_id || null,
          in_reply_to_email_id: r.email_id || null, // composite '<mailbox>:<uid>' als reply op iets
          attachments: Array.isArray(r.attachments) ? r.attachments : null,
          source: 'email_replies', // onderscheidbaar van INBOX-mirror items
        },
      });
    }
    items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

    // Eén bladzijde: de nieuwste `limit`, plus het antwoord op "zit er nog
    // meer vóór?". Dat laatste komt uit de extra rij die per bron is
    // opgehaald — geen tweede opvraging die alleen maar telt.
    const { zichtbaar: trimmed, heeftMeer, oudsteAt } = venster(items, limit);

    return res.status(200).json({
      items: trimmed,
      conversation: {
        id: conv.id,
        customer_id: conv.customer_id,
        can_send_text: canSendText,
        // last_inbound_at erbij (G3): can_send_text is een ja/nee, en daarmee
        // kan het scherm niet uitrekenen hoeveel venster er nog is. Dat is
        // precies het verschil tussen "je loopt tegen een muur" en "je ziet de
        // muur aankomen".
        last_inbound_at: conv.last_inbound_at || null,
        phone_number: conv.phone_number,
      },
      counts: {
        whatsapp: (waMsgs || []).length,
        email: emailMsgs.length,
        email_replies: emailReplies.length,       // onze verzonden mails
        email_total: emailMsgs.length + emailReplies.length, // inbound + outbound samen
        // LET OP: dit telt wat er in DEZE bladzijde zit, niet wat er in totaal
        // bestaat. Voor "is er meer" is heeft_meer het antwoord.
        total: items.length,
        returned: trimmed.length,
      },
      heeft_meer: heeftMeer,
      oudste_at: oudsteAt,
    });
  } catch (e) {
    console.error('[inbox-thread-unified]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
