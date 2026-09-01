// api/leadsonderhoud-gesprekken.js
// GET -> het gecombineerde postvak van leadsonderhoud: één regel per lead-in-een-
// traject die contact heeft gehad, met WhatsApp én mail samengevoegd.
//
// Waarom lead-gesleuteld (en niet per WhatsApp-gesprek): veel leads hebben (nog)
// geen telefoonnummer, en de afwijzings-/verlopen-mails nodigen uit tot antwoorden
// per mail. Zou het postvak op WhatsApp-gesprekken sleutelen, dan zouden die mail-
// only leads onzichtbaar zijn. Dubbele lead-rijen met hetzelfde e-mailadres worden
// tot één regel samengevoegd.
//
// Kanalen:
//   - WhatsApp: gesprek op de ingestelde lijn, gematcht op telefoonnummer.
//   - Mail:     inkomende mail in het motor-postvak (welkom@ -> mailbox 'welkom'),
//               gematcht op from_address == lead.email.
//
// Alleen lezen. Gate: leads.view (filter zit server-side).
//
// Response: { configured, wa_configured, module, label, postvak,
//   items:[{ lead_id, naam, phone_number, email, last_activity_at, last_preview,
//            unread, can_send_text, has_wa, has_mail, afspraak_op }] }
//
// v=6 fixes (BROK 2):
//   FIX 3: has_mail was altijd false voor leads waar wij WEL mail naartoe stuurden
//     maar zij niet inbound reageerden — de bron keek alleen naar email_messages
//     (inbound). We tellen nu ook outbound mee: berichten_log (soort=mail) EN
//     email_replies waar to_address == lead.email → has_mail true.
//   FIX 4: afspraak_op meegeleverd zodat de Gesprekken-pane header de call-
//     status badge (✓geboekt/nog niet) kan tonen, consistent met Contacten.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
// BP2 v3 (2026-09-01): setter-scope VERWIJDERD — Romy doet alle gesprekken.
import {
  haalLijn, leadsInTraject, normNummer, binnenVenster, postvakNaam, adresUit, mailAfzender,
} from './_lib/leadsonderhoud-gesprekken.js';

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

  try {
    const lijn = await haalLijn();
    const leads = await leadsInTraject();
    const postvak = postvakNaam();

    // Index de leads op telefoonnummer (voor WhatsApp) en verzamel de e-mailadressen.
    const leadOpNummer = new Map();
    const emailSet = new Set();
    for (const l of leads) {
      if (l.telefoon_e164) leadOpNummer.set(normNummer(l.telefoon_e164), l);
      if (l.email) emailSet.add(l.email.toLowerCase());
    }

    // v=6 FIX 4: lookup afspraak_op per lead (kern-metric 'call geboekt').
    // leadsInTraject() haalt niet alle leads-kolommen op → aparte batch-query.
    // Fail-soft: bij fout gaan we door met lege map, alle items krijgen dan
    // afspraak_op=null (badge = 'nog niet').
    const afspraakByLeadId = new Map();
    try {
      const leadIds = leads.map(l => l.id).filter(Boolean);
      if (leadIds.length) {
        const { data: afspraken } = await supabaseAdmin
          .from('leads')
          .select('id, afspraak_op')
          .in('id', leadIds);
        for (const a of afspraken || []) {
          if (a.afspraak_op) afspraakByLeadId.set(a.id, a.afspraak_op);
        }
      }
    } catch (e) {
      console.warn('[ls-gesprekken] afspraak-lookup soft-fail:', e?.message || e);
    }

    // WhatsApp-gesprekken op de lijn, gekoppeld aan een lead via het nummer.
    // v=9 FIX-FLAG (has_wa): een conv zonder ANY whatsapp_messages telt niet
    // als has_wa=true (Anne Janssens: WA-conv geregistreerd, 0 berichten →
    // spookbadge zonder inhoud). We haalt daarom eerst de conv-ids op en
    // filteren dan op conv-ids die minstens 1 message hebben. Één extra
    // batch-query, geen N+1.
    const waOpLeadId = new Map();
    if (lijn.phoneNumberId && leadOpNummer.size) {
      const { data: convs } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, phone_number, last_message_at, last_message_preview, unread_count, last_inbound_at')
        .eq('phone_number_id', lijn.phoneNumberId)
        .limit(500);
      // Kandidaat-convs = convs waarvan het nummer matcht met een lead-telnr.
      const kandidaatMap = new Map(); // convId -> {conv, lead}
      for (const c of convs || []) {
        if (!c.phone_number || c.phone_number.startsWith('+99999')) continue;
        const lead = leadOpNummer.get(normNummer(c.phone_number));
        if (lead) kandidaatMap.set(c.id, { conv: c, lead });
      }
      // Batch-check: welke van deze conv-ids heeft ≥1 whatsapp_messages?
      const convIds = Array.from(kandidaatMap.keys());
      if (convIds.length) {
        const { data: msgIds } = await supabaseAdmin
          .from('whatsapp_messages')
          .select('conversation_id')
          .in('conversation_id', convIds);
        const nonEmpty = new Set((msgIds || []).map(m => m.conversation_id));
        for (const [cid, entry] of kandidaatMap.entries()) {
          if (nonEmpty.has(cid)) waOpLeadId.set(entry.lead.id, entry.conv);
        }
      }
    }

    // v=9 FIX-FLAG (has_mail): filters spiegelen -berichten precies zodat
    // een badge ALTIJD hoort bij ≥1 renderbaar bericht in de draad:
    //   inbound  = email_messages.mailbox=postvak & from_address ilike email
    //              & adresUit(from) === email (strikt na ilike).
    //   outbound handmatig = email_replies met from_address ilike mailAfzender()
    //              & to_address ilike email & adresUit(to) === email.
    //   outbound motor = berichten_log met kanaal='mail' & status='verstuurd'
    //              & soort != 'handmatig-antwoord' & naar ilike email.
    // Verschillen met v=6/v=8 (die false-positives opleverde):
    //   - berichten_log status = 'verstuurd' (NIET 'ok') + from_address ilike
    //     op mail-afzender is nu geen filter meer (want die kolom bestaat niet
    //     op berichten_log).
    //   - berichten_log soort != 'handmatig-antwoord' (spiegel -berichten
    //     regel 133: die bubbel komt uit email_replies, niet uit log).
    //   - email_replies from_address moet mail-afzender zijn (mailAfzender()).
    const mailOpEmail = new Map();
    const bump = (adres, dateIso, isUnread, tekst) => {
      if (!emailSet.has(adres)) return;
      let agg = mailOpEmail.get(adres);
      if (!agg) { agg = { count: 0, unread: 0, last_date: null, last_tekst: '' }; mailOpEmail.set(adres, agg); }
      agg.count++;
      if (isUnread) agg.unread++;
      if (!agg.last_date || (dateIso && new Date(dateIso) > new Date(agg.last_date))) {
        agg.last_date = dateIso;
        if (tekst) agg.last_tekst = tekst;
      }
    };
    if (emailSet.size) {
      const emails = Array.from(emailSet);
      const afzender = (mailAfzender() || '').toLowerCase();
      // 1. Inbound in het motor-postvak.
      const { data: mails } = await supabaseAdmin
        .from('email_messages')
        .select('from_address, date_received, is_read, snippet, subject')
        .eq('mailbox', postvak)
        .order('date_received', { ascending: false })
        .limit(3000);
      for (const m of mails || []) {
        const adr = adresUit(m.from_address);
        if (!emailSet.has(adr)) continue; // strikte match
        bump(adr, m.date_received, !m.is_read, m.snippet || m.subject || '');
      }
      // 2. Outbound handmatig-antwoord (email_replies vanaf mailAfzender).
      const { data: replies } = await supabaseAdmin
        .from('email_replies')
        .select('to_address, from_address, email_subject, sent_at, final_reply')
        .in('to_address', emails)
        .order('sent_at', { ascending: false })
        .limit(2000);
      for (const r of replies || []) {
        const fromAdr = String(r.from_address || '').toLowerCase();
        if (afzender && !fromAdr.includes(afzender)) continue; // alleen van welkom@
        const toAdr = adresUit(r.to_address);
        if (!emailSet.has(toAdr)) continue;
        bump(toAdr, r.sent_at, false, r.email_subject || (r.final_reply || '').slice(0, 120));
      }
      // 3. Outbound motor-mails (berichten_log kanaal=mail, status='verstuurd',
      //    NIET 'handmatig-antwoord' — die zit in email_replies).
      const { data: motorMails } = await supabaseAdmin
        .from('berichten_log')
        .select('naar, verstuurd_op, soort, status')
        .eq('kanaal', 'mail')
        .eq('status', 'verstuurd')
        .neq('soort', 'handmatig-antwoord')
        .in('naar', emails)
        .order('verstuurd_op', { ascending: false })
        .limit(3000);
      for (const b of motorMails || []) {
        const adr = adresUit(b.naar);
        if (!emailSet.has(adr)) continue;
        // BP3 v4 (2026-09-01): geen "motor: <soort>"-preview meer in de lijst.
        // De interne campagne-naam ("uitnodiging-gesprek" etc.) is ruis voor
        // de gesprekkenlijst — datum wordt nog wel bijgehouden voor sortering.
        bump(adr, b.verstuurd_op, false, '');
      }
    }

    // Groepeer de leads op identiteit (e-mail als die er is, anders nummer, anders
    // de lead-id) zodat dubbele lead-rijen tot één postvakregel samensmelten.
    const groepen = new Map();
    for (const l of leads) {
      const key = l.email ? 'mail:' + l.email.toLowerCase()
        : (l.telefoon_e164 ? 'tel:' + normNummer(l.telefoon_e164) : 'id:' + l.id);
      if (!groepen.has(key)) groepen.set(key, []);
      groepen.get(key).push(l);
    }

    const items = [];
    for (const rijen of groepen.values()) {
      // WhatsApp uit de eerste rij die een gesprek heeft; mail via het e-mailadres.
      let wa = null, waLead = null;
      for (const l of rijen) { const c = waOpLeadId.get(l.id); if (c) { wa = c; waLead = l; break; } }
      const email = (rijen.find((l) => l.email)?.email || '').toLowerCase() || null;
      const mail = email ? mailOpEmail.get(email) : null;
      if (!wa && !mail) continue;

      // Representatieve lead: liefst degene met het WhatsApp-nummer (die heeft in de
      // praktijk ook het e-mailadres), anders een rij met een naam.
      const rep = waLead || rijen.find((l) => l.voornaam || l.achternaam) || rijen[0];
      const waTijd = wa?.last_message_at ? new Date(wa.last_message_at).getTime() : 0;
      const mailTijd = mail?.last_date ? new Date(mail.last_date).getTime() : 0;
      const laatste = Math.max(waTijd, mailTijd);
      const preview = (mailTijd >= waTijd ? mail?.last_tekst : wa?.last_message_preview) || '';

      // v=6 FIX 4: afspraak_op — kijk over alle rijen in de groep, kies de meest
      // recente niet-null afspraak (dubbele lead-rijen kunnen elk hun eigen
      // afspraak-status hebben).
      let afspraakOp = null;
      for (const l of rijen) {
        const a = afspraakByLeadId.get(l.id);
        if (a && (!afspraakOp || new Date(a) > new Date(afspraakOp))) afspraakOp = a;
      }
      items.push({
        lead_id: rep.id,
        conversation_id: wa?.id || null,
        naam: [rep.voornaam, rep.achternaam].filter(Boolean).join(' ') || email || (wa ? wa.phone_number : '') || 'Onbekend',
        phone_number: rep.telefoon_e164 || (wa ? wa.phone_number : null),
        email: email,
        last_activity_at: laatste ? new Date(laatste).toISOString() : null,
        last_preview: preview,
        unread: (wa?.unread_count || 0) + (mail?.unread || 0),
        can_send_text: wa ? binnenVenster(wa.last_inbound_at) : false,
        has_wa: !!wa,
        has_mail: !!mail,
        afspraak_op: afspraakOp,
        _t: laatste,
      });
    }

    items.sort((a, b) => b._t - a._t);
    const schoon = items.map(({ _t, ...rest }) => rest);

    return res.status(200).json({
      configured: true,
      wa_configured: !!lijn.phoneNumberId,
      module: lijn.module,
      label: lijn.label,
      postvak,
      afzender: mailAfzender(),
      items: schoon,
    });
  } catch (e) {
    console.error('leadsonderhoud-gesprekken mislukt:', e.message);
    return res.status(500).json({ error: 'Gesprekken laden mislukt' });
  }
}
