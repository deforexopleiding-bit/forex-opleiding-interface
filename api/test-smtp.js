import nodemailer from 'nodemailer';

const SMTP_ACCOUNTS = [
  { user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
];

const SMTP_HOST = 'smtp.strato.com';
const SMTP_PORT = 465;

export default async function handler(req, res) {
  const results = await Promise.all(
    SMTP_ACCOUNTS.map(async ({ user, passEnv }) => {
      const password = process.env[passEnv];
      if (!password) {
        return { user, status: 'skipped', reason: `${passEnv} niet geconfigureerd` };
      }

      const transporter = nodemailer.createTransport({
        host:   SMTP_HOST,
        port:   SMTP_PORT,
        secure: true,
        auth:   { user, pass: password },
        connectionTimeout: 8000,
        socketTimeout:     8000,
      });

      try {
        await transporter.verify();
        return { user, status: 'ok', host: SMTP_HOST, port: SMTP_PORT };
      } catch (err) {
        return {
          user,
          status:  'error',
          error:   err.message,
          code:    err.code    || null,
          command: err.command || null,
          host:    SMTP_HOST,
          port:    SMTP_PORT,
        };
      }
    })
  );

  const allOk  = results.every((r) => r.status === 'ok' || r.status === 'skipped');
  const anyOk  = results.some((r)  => r.status === 'ok');
  const status = anyOk ? 200 : 500;

  return res.status(status).json({
    ok:      allOk,
    anyOk,
    host:    SMTP_HOST,
    port:    SMTP_PORT,
    results,
  });
}
