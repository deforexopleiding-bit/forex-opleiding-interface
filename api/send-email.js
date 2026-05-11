import nodemailer from 'nodemailer';

// Mailbox → wachtwoord env-var (zelfde als IMAP)
const SMTP_ACCOUNTS = {
  'leads@deforexopleiding.nl':         'IMAP_PASS',
  'info@deforexopleiding.nl':          'IMAP_PASS_INFO',
  'partners@deforexopleiding.nl':      'IMAP_PASS_PARTNERS',
  'administratie@deforexopleiding.nl': 'IMAP_PASS_ADMINISTRATIE',
};

const SMTP_HOST = 'smtp.strato.com';
const SMTP_PORT = 465;

async function saveToSupabase(record) {
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) { console.warn('[send-email] SUPABASE_URL/KEY niet geconfigureerd'); return; }
  try {
    const r = await fetch(`${url}/rest/v1/email_replies`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        key,
        'Authorization': `Bearer ${key}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(record),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn(`[send-email] email_replies insert mislukt (${r.status}):`, txt);
    } else {
      console.log('[send-email] email_replies opgeslagen');
    }
  } catch (e) {
    console.warn('[send-email] email_replies fetch fout:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { from_mailbox, to, subject, text, html, cc, bcc, email_id, category } = req.body || {};

  if (!from_mailbox || !to || !subject || !text) {
    return res.status(400).json({ error: 'from_mailbox, to, subject en text zijn vereist' });
  }

  const passEnv = SMTP_ACCOUNTS[from_mailbox.toLowerCase()];
  if (!passEnv) {
    return res.status(400).json({ error: `Onbekende mailbox: ${from_mailbox}` });
  }

  const password = process.env[passEnv];
  if (!password) {
    return res.status(500).json({
      error: `SMTP wachtwoord voor ${from_mailbox} niet geconfigureerd (env var: ${passEnv})`
    });
  }

  console.log(`[send-email] Van: ${from_mailbox} → Naar: ${to} | Onderwerp: ${subject} | SMTP: ${SMTP_HOST}:${SMTP_PORT}`);

  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   SMTP_PORT,
    secure: true,
    auth: {
      user: from_mailbox,
      pass: password,
    },
  });

  try {
    const mailOpts = {
      from:    `"De Forex Opleiding" <${from_mailbox}>`,
      to,
      subject,
      text,
      replyTo: from_mailbox,
    };
    if (html) mailOpts.html = html;
    if (cc)   mailOpts.cc   = cc;
    if (bcc)  mailOpts.bcc  = bcc;

    const info = await transporter.sendMail(mailOpts);
    console.log(`[send-email] Verstuurd — messageId: ${info.messageId} | geaccepteerd: ${info.accepted?.join(', ')}`);

    const sentAt = new Date().toISOString();
    await saveToSupabase({
      email_id:      email_id || null,
      email_subject: subject,
      final_reply:   text,
      from_address:  from_mailbox,
      to_address:    to,
      cc_address:    cc  || null,
      bcc_address:   bcc || null,
      sent_at:       sentAt,
    });

    return res.status(200).json({
      ok: true,
      messageId: info.messageId,
      accepted:  info.accepted || [],
    });
  } catch (err) {
    console.error(`[send-email] SMTP fout (${from_mailbox} → ${to}):`, err.message, 'code:', err.code || '—', 'responseCode:', err.responseCode || '—', 'response:', err.response || '—');
    return res.status(500).json({
      error:        err.message      || 'Onbekende SMTP fout',
      code:         err.code         || null,
      responseCode: err.responseCode || null,
      response:     err.response     || null,
      command:      err.command      || null,
    });
  }
}
