// api/leadsonderhoud-gesprek-mailantwoord.js
// POST { lead_id, subject, text, html?, origineel_email_id? }
//   -> stuur een e-mailantwoord aan de lead vanaf de leadsonderhoud-afzender
//      (welkom@), via Strato SMTP, met threading (In-Reply-To/References).
//
// Overgenomen uit de wanbetalers-antwoordfunctie (api/send-email.js), maar:
//   - afzender = welkom@ (LEADSONDERHOUD_MAIL_AFZENDER) i.p.v. administratie@,
//   - gate = leads.view (i.p.v. email.reply.send),
//   - logt naast email_replies (met de body) óók naar berichten_log, zodat het
//     antwoord in de gecombineerde leadsonderhoud-draad verschijnt.
//
// Het Re:-onderwerp en de geciteerde originele mail worden in de UI voorgevuld
// (net als bij wanbetalers); dit endpoint verstuurt subject/text zoals ontvangen.
//
// Response: 200 { ok:true, messageId }
//           4xx/5xx { error }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { trajectSlugs, mailAfzender } from './_lib/leadsonderhoud-gesprekken.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { tekstMetHandtekening } from './_lib/email-handtekening.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 50000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const body = req.body || {};
  const leadId = String(body.lead_id || '');
  const subject = String(body.subject || '').trim();
  const tekst = String(body.text || '').trim();
  const html = body.html ? String(body.html) : null;
  const origId = body.origineel_email_id ? String(body.origineel_email_id) : '';
  if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ontbreekt of ongeldig' });
  if (!subject) return res.status(400).json({ error: 'Onderwerp is leeg' });
  if (!tekst) return res.status(400).json({ error: 'Bericht is leeg' });
  if (tekst.length > MAX_BODY) return res.status(400).json({ error: 'Bericht te lang' });

  try {
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads').select('id, voornaam, achternaam, email, soort').eq('id', leadId).maybeSingle();
    if (leadErr) throw leadErr;
    if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });

    const slugs = await trajectSlugs();
    if (!slugs.has(lead.soort)) return res.status(403).json({ error: 'Deze lead zit niet in een traject' });
    if (!lead.email) return res.status(409).json({ error: 'Deze lead heeft geen e-mailadres' });

    const afzender = mailAfzender();
    const naar = lead.email;

    // Threading: zoek de message_id (en composite) van de mail waarop we
    // antwoorden. Fail-soft: geen origineel/geen message_id -> zonder headers.
    let inReplyTo = null;
    let composite = null;
    if (origId && UUID_RE.test(origId)) {
      const { data: orig } = await supabaseAdmin
        .from('email_messages')
        .select('id, message_id, mailbox, imap_uid')
        .eq('id', origId).maybeSingle();
      if (orig) {
        if (orig.message_id) inReplyTo = String(orig.message_id);
        if (orig.mailbox && orig.imap_uid != null) composite = orig.mailbox + ':' + orig.imap_uid;
      }
    }

    // Versturen via de gedeelde SMTP-kern, als welkom@ (SMTP-gebruiker + From +
    // reply-to), met threading-headers.
    // handtekening:true -> de send-core zet de vaste handtekening (HTML + logo)
    // er één keer onder. De modal heeft de platte-tekst-handtekening al voorgevuld;
    // de idempotente check voorkomt een dubbele.
    const res2 = await sendEmailViaSmtp({ fromMailbox: afzender, to: naar, subject, text: tekst, html, inReplyTo, handtekening: true });
    if (!res2.ok) {
      if (res2.code === 'SMTP_NOT_CONFIGURED') {
        return res.status(503).json({ error: 'Afzender-mailbox niet geconfigureerd', detail: res2.reason });
      }
      return res.status(502).json({ error: 'Versturen mislukt', detail: res2.reason });
    }

    const nu = new Date().toISOString();

    // 1) email_replies: de uitgaande reply mét body — dit is wat de draad toont.
    //    Sla de ondertekende tekst op zodat de bubbel gelijk is aan de mail.
    const { error: erErr } = await supabaseAdmin.from('email_replies').insert({
      email_id: composite,
      email_subject: subject,
      final_reply: tekstMetHandtekening(tekst),
      from_address: afzender,
      to_address: naar,
      sent_at: nu,
      sent_by_id: user.id,
    });
    if (erErr) console.error('[leadsonderhoud-gesprek-mailantwoord] email_replies insert faalde:', erErr.message);

    // 2) Originele mail markeren als gelezen + beantwoord (en uit 'te doen').
    if (origId && UUID_RE.test(origId)) {
      const { error: mErr } = await supabaseAdmin
        .from('email_messages')
        .update({ is_read: true, is_replied: true, reply_sent_at: nu, requires_action: false })
        .eq('id', origId);
      if (mErr) console.error('[leadsonderhoud-gesprek-mailantwoord] mail markeren faalde:', mErr.message);
    }

    // 3) berichten_log: registratie op de plek waar de motor-mail ook staat.
    //    soort 'handmatig-antwoord' zodat de draad deze niet dubbel toont (de
    //    bubbel komt uit email_replies, dat de body heeft). Best-effort.
    try {
      await supabaseAdmin.from('berichten_log').insert({
        lead_id: lead.id, soort: 'handmatig-antwoord', kanaal: 'mail', naar,
        traject: lead.soort, agent: 'handmatig', status: 'verstuurd',
        verstuurd_op: nu, extern_id: res2.messageId || null,
      });
    } catch (logEx) {
      console.error('[leadsonderhoud-gesprek-mailantwoord] berichten_log insert faalde:', logEx.message);
    }

    return res.status(200).json({ ok: true, messageId: res2.messageId || null });
  } catch (e) {
    console.error('leadsonderhoud-gesprek-mailantwoord mislukt:', e.message);
    return res.status(500).json({ error: 'Versturen mislukt' });
  }
}
