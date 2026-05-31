// api/_lib/teamleader-mail-substitution.js
// PAD 2B: TL quotations.send accepteert geen mail_template_id (bevestigd 400).
// Daarom halen we de template-content zelf op via mailTemplates.list en
// substitueren we de placeholders server-side, om die als inline subject/content
// mee te sturen.
//
// #LINK wordt BEWUST niet vervangen: TL-docs bevestigen dat #LINK de officiële
// shortcode is die quotations.send vervangt door de CloudSign onderteken-URL.

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
  // filter.type is VERPLICHT bij mailTemplates.list (anders TL 400).
  const r = await tlFetch('/mailTemplates.list', { method: 'POST', body: JSON.stringify({ filter: { type: 'quotation' } }) });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`TL mailTemplates.list HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  const tpl = (data.data || []).find(t => t.id === templateId);
  if (!tpl) throw new Error('Mail-template niet gevonden: ' + templateId);

  // TL-shape is genest: { id, name, content: { subject, body } }.
  // subject/body kunnen string of taal-object ({ nl, en }) zijn.
  const subject = tpl?.content?.subject;
  const body = tpl?.content?.body;
  if (!subject || !body) {
    console.warn('[mail-substitution] template content ontbreekt:', JSON.stringify(tpl).slice(0, 300));
    return null;
  }
  const pick = v => (typeof v === 'string' ? v : (v.nl || v.en || Object.values(v)[0] || ''));
  const outSubject = substitute(pick(subject), ctx);
  const outContent = substitute(pick(body), ctx);

  // Defensief: corrupte extractie (gestringificeerd object) → inline fallback.
  if (!outContent || /\[object/i.test(outContent) || outContent.trim().startsWith('{')) {
    console.warn('[mail-substitution] verdachte content na substitutie, fallback inline');
    return null;
  }
  return { subject: outSubject, content: outContent };
}
