// api/_lib/email.js
//
// Dunne fail-soft helper rond Resend. Bedoeld voor transactionele mail (bv.
// payout-approve naar mentor). Gooit nooit — een ontbrekende key of HTTP-fout
// wordt teruggemeld via { sent:false, reason } zodat de caller een hint kan
// tonen ("mail niet verzonden") zonder dat de business-actie zelf faalt.
//
// Auth: Authorization: Bearer process.env.RESEND_API_KEY.
// From: 'De Forex Opleiding <noreply@deforexopleiding.nl>' (vast).
//
// Gebruik:
//   const result = await sendMail({ to, subject, html });
//   if (!result.sent) console.warn('mail miste:', result.reason);

const FROM = 'De Forex Opleiding <noreply@deforexopleiding.nl>';
const RESEND_URL = 'https://api.resend.com/emails';

export async function sendMail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY || null;
  if (!apiKey) {
    return { sent: false, reason: 'RESEND_API_KEY ontbreekt' };
  }
  if (!to || (Array.isArray(to) && to.length === 0)) {
    return { sent: false, reason: 'to ontbreekt' };
  }
  if (!subject) return { sent: false, reason: 'subject ontbreekt' };
  if (!html)    return { sent: false, reason: 'html ontbreekt' };

  let resp;
  try {
    resp = await fetch(RESEND_URL, {
      method : 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type' : 'application/json',
      },
      body: JSON.stringify({
        from   : FROM,
        to     : Array.isArray(to) ? to : [to],
        subject,
        html,
      }),
    });
  } catch (e) {
    return { sent: false, reason: 'netwerk-fout: ' + (e?.message || e) };
  }

  const text = await resp.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!resp.ok) {
    const msg = json?.message || json?.error || text.slice(0, 200) || ('HTTP ' + resp.status);
    return { sent: false, reason: 'Resend ' + resp.status + ': ' + msg };
  }
  return { sent: true, id: json?.id || null };
}
