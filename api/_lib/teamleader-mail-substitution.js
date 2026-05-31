// api/_lib/teamleader-mail-substitution.js
// PAD 2B: TL quotations.send accepteert geen mail_template_id (bevestigd 400).
// Daarom halen we de template-content zelf op via mailTemplates.list en
// substitueren we de placeholders server-side, om die als inline subject/content
// mee te sturen.
//
// #LINK wordt BEWUST niet vervangen: dat is TL's eigen placeholder die TL bij
// het verzenden zelf rendert naar de juiste onderteken-link. (Niet door ons live
// te verifiëren — TL nog niet verbonden; als blijkt dat TL #LINK in inline content
// niet rendert, moet hier een expliciete URL gegenereerd worden.)

import { tlFetch } from './teamleader-token.js';

function substitute(str, ctx) {
  return String(str || '')
    .split('#CONTACT_NAME').join(ctx.contact_name || '')
    .split('#MY_NAME').join(ctx.my_name || '')
    .split('#DEPARTMENT_NAME').join(ctx.department_name || '')
    .split('#DEAL_TITLE').join(ctx.deal_title || '');
  // #LINK blijft staan → TL rendert die.
}

// Haalt de template op (id-match uit mailTemplates.list) en substitueert.
// Returnt { subject, content } of throwt bij niet gevonden / fout.
export async function fetchAndSubstituteTemplate(templateId, ctx) {
  const r = await tlFetch('/mailTemplates.list', { method: 'POST', body: JSON.stringify({}) });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`TL mailTemplates.list HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  const tpl = (data.data || []).find(t => t.id === templateId);
  if (!tpl) throw new Error('Mail-template niet gevonden: ' + templateId);

  // Veldnamen defensief (content-veld niet hard geverifieerd).
  const rawSubject = tpl.subject || tpl.name || '';
  const rawBody = tpl.content || tpl.body || tpl.html || tpl.text || '';
  return {
    subject: substitute(rawSubject, ctx),
    content: substitute(rawBody, ctx),
  };
}
