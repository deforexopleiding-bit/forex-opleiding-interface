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
    const waOpLeadId = new Map();
    if (lijn.phoneNumberId && leadOpNummer.size) {
      const { data: convs } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, phone_number, last_message_at, last_message_preview, unread_count, last_inbound_at')
        .eq('phone_number_id', lijn.phoneNumberId)
        .limit(500);
      for (const c of convs || []) {
        if (!c.phone_number || c.phone_number.startsWith('+99999')) continue;
        const lead = leadOpNummer.get(normNummer(c.phone_number));
        if (lead) waOpLeadId.set(lead.id, c);
      }
    }

    // Mail-aggregatie per e-mailadres. v=6 FIX 3: telt ZOWEL inbound (email_messages)
    // ALS outbound (email_replies + berichten_log soort=mail) mee. Vroeger was
    // has_mail=false voor leads waar wij WEL naartoe stuurden maar die niet
    // inbound reageerden (drip-mails van de motor). Nu toont has_mail=true zodra
    // er langs beide kanten óók maar één mail-uitwisseling is.
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
      // Inbound in het motor-postvak.
      const { data: mails } = await supabaseAdmin
        .from('email_messages')
        .select('from_address, date_received, is_read, snippet, subject')
        .eq('mailbox', postvak)
        .order('date_received', { ascending: false })
        .limit(3000);
      for (const m of mails || []) {
        bump(adresUit(m.from_address), m.date_received, !m.is_read, m.snippet || m.subject || '');
      }
      // Outbound handmatig-antwoord (email_replies met to_address==lead.email).
      const emails = Array.from(emailSet);
      const { data: replies } = await supabaseAdmin
        .from('email_replies')
        .select('to_address, email_subject, sent_at, final_reply')
        .in('to_address', emails)
        .order('sent_at', { ascending: false })
        .limit(2000);
      for (const r of replies || []) {
        const adr = adresUit(r.to_address);
        // Preview alleen als 'ie nieuwer is dan bestaande last_date; anders wel tellen
        // maar preview niet overschrijven (bump doet dat via new Date-vergelijking).
        bump(adr, r.sent_at, false, r.email_subject || (r.final_reply || '').slice(0, 120));
      }
      // Outbound motor-mails uit berichten_log (soort=mail).
      const { data: motorMails } = await supabaseAdmin
        .from('berichten_log')
        .select('naar, verstuurd_op, soort, status')
        .eq('kanaal', 'mail')
        .eq('status', 'ok')
        .in('naar', emails)
        .order('verstuurd_op', { ascending: false })
        .limit(3000);
      for (const b of motorMails || []) {
        bump(adresUit(b.naar), b.verstuurd_op, false, b.soort ? ('motor: ' + b.soort) : '');
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
