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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { from_mailbox, to, subject, text } = req.body || {};

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
    const info = await transporter.sendMail({
      from:     `"De Forex Opleiding" <${from_mailbox}>`,
      to,
      subject,
      text,
      replyTo:  from_mailbox,
    });

    console.log(`[send-email] Verstuurd — messageId: ${info.messageId} | geaccepteerd: ${info.accepted?.join(', ')}`);
    return res.status(200).json({
      ok: true,
      messageId: info.messageId,
      accepted:  info.accepted || [],
    });
  } catch (err) {
    console.error(`[send-email] SMTP fout (${from_mailbox} → ${to}):`, err.message, err.code || '');
    return res.status(500).json({
      error:   err.message || 'Onbekende SMTP fout',
      code:    err.code    || null,
      command: err.command || null,
    });
  }
}
