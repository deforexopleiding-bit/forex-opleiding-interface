// api/_lib/lab-berichten.js
//
// Mail en WhatsApp voor The Lab. Eén plek voor de verzending, zodat de
// aanmelding, de nieuwe-link-aanvraag en de opvolgcron hetzelfde loggen:
//
//   * mail      — welkom@ (mailAfzender), huisstijl-shell, gelogd in
//                 email_replies (de Gesprekken-draad) en berichten_log.
//   * WhatsApp  — ALLEEN via een goedgekeurd template op de lead-lijn. Een
//                 lead heeft ons nog nooit geschreven, dus vrije tekst valt
//                 buiten het 24u-venster en wordt door Meta geweigerd. Welk
//                 template bij welke stap hoort, staat in onderhoud_sjablonen
//                 (traject_slug 'the-lab', kanaal 'whatsapp', meta_template)
//                 en is daar in de module zelf aan te passen. Geen template →
//                 geen WhatsApp, met een duidelijke status.

import { supabaseAdmin } from '../supabase.js';
import { sendEmailViaSmtp } from './send-email-core.js';
import { renderLeadMail, htmlNaarTekst } from './mail-shell-lead.js';
import { haalLijn, mailAfzender } from './leadsonderhoud-gesprekken.js';
import { sendTemplate, goedgekeurdeTemplatesOpLijn } from './meta-whatsapp.js';
import { logOutboundWa } from './wa-outbound-log.js';
import { LAB_SLUG, LAB_TOEGANG_DAGEN, lmsBasisUrl } from './lab-config.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Eén knop, mailclient-proof (tabel + inline opmaak). PURE. */
export function knop(href, tekst) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 18px"><tr><td style="background:#1a2f3e;border-radius:10px">`
    + `<a href="${esc(href)}" style="display:inline-block;padding:14px 26px;color:#ffffff;font-weight:700;font-size:16px;text-decoration:none;font-family:Arial,Helvetica,sans-serif">${esc(tekst)}</a>`
    + `</td></tr></table>`;
}

// ── Mailteksten (PURE) ──────────────────────────────────────────────────────
// Toon: direct, warm, Vlaams-Nederlands, geen verkooppraat. Eén knop.

export function mailWelkom({ voornaam, link }) {
  const v = esc(voornaam || 'daar');
  return {
    onderwerp: 'Je toegang tot The Lab staat klaar',
    html: `<p>Hey ${v},</p>
<p>Je eigen account staat klaar. In The Lab plaats je je eerste trade met onze strategie — stap voor stap, in een echte chart. Reken op een twintigtal minuten.</p>
${knop(link, 'Start The Lab')}
<p>Inloggen hoeft niet: de knop doet dat voor je. Je hebt ${LAB_TOEGANG_DAGEN} dagen toegang.</p>
<p>Werkt de knop niet meer? Ga naar <a href="${esc(lmsBasisUrl())}">${esc(lmsBasisUrl().replace(/^https:\/\//, ''))}</a> en vraag een nieuwe link aan met je e-mailadres.</p>`,
  };
}

export function mailNieuweLink({ voornaam, link, verlopen = false }) {
  const v = esc(voornaam || 'daar');
  return {
    onderwerp: 'Je nieuwe link voor The Lab',
    html: verlopen
      ? `<p>Hey ${v},</p>
<p>Je toegang tot The Lab is afgelopen, maar je strategiesessie kan je nog altijd inplannen. Met deze knop kom je meteen op de juiste plek.</p>
${knop(link, 'Plan mijn strategiesessie')}`
      : `<p>Hey ${v},</p>
<p>Hier is je nieuwe link. Je komt meteen terug waar je gebleven was.</p>
${knop(link, 'Verder met The Lab')}`,
  };
}

export function mailAlToegang({ voornaam }) {
  const v = esc(voornaam || 'daar');
  const basis = lmsBasisUrl();
  return {
    onderwerp: 'Je hebt al toegang bij De Forex Opleiding',
    html: `<p>Hey ${v},</p>
<p>Je vroeg toegang tot The Lab aan, maar met dit e-mailadres heb je al een account bij ons. We hebben daar niets aan veranderd.</p>
${knop(basis, 'Naar het leerplatform')}
<p>Wachtwoord kwijt? Op het inlogscherm kan je een inloglink naar dit adres laten sturen.</p>`,
  };
}

// ── Verzending ──────────────────────────────────────────────────────────────

async function logBericht({ leadId, soort, kanaal, naar, status, fout = null, externId = null }) {
  const { error } = await supabaseAdmin.from('berichten_log').insert({
    lead_id: leadId || null, soort, kanaal, naar, traject: LAB_SLUG, agent: LAB_SLUG,
    status, fout, verstuurd_op: new Date().toISOString(), extern_id: externId,
  });
  if (error) console.warn('[lab-berichten] berichten_log (soft):', error.message);
}

/**
 * Verstuurt één Lab-mail. Gooit nooit: geeft { ok, status, fout? } terug.
 * @param {{ leadId?: string|null, email: string, soort: string, onderwerp: string, html: string }} p
 */
export async function stuurLabMail({ leadId = null, email, soort, onderwerp, html }) {
  const afzender = mailAfzender();
  const tekst = htmlNaarTekst(html) + '\n\nMet vriendelijke groet,\n\nTeam - De Forex Opleiding';
  let r;
  try {
    r = await sendEmailViaSmtp({ fromMailbox: afzender, to: email, subject: onderwerp, text: tekst, html: renderLeadMail({ bodyHtml: html }) });
  } catch (e) {
    r = { ok: false, reason: e?.message || String(e) };
  }
  if (!r?.ok) {
    console.error('[lab-berichten] mail mislukt', { soort, lead: leadId, fout: r?.reason });
    await logBericht({ leadId, soort, kanaal: 'mail', naar: email, status: 'fout', fout: String(r?.reason || '').slice(0, 300) });
    return { ok: false, status: 'fout', fout: r?.reason || 'onbekend' };
  }
  const nu = new Date().toISOString();
  const { error: erErr } = await supabaseAdmin.from('email_replies').insert({
    email_id: null, email_subject: onderwerp, final_reply: tekst,
    from_address: afzender, to_address: email, sent_at: nu, sent_by_id: null,
  });
  if (erErr) console.warn('[lab-berichten] email_replies (soft):', erErr.message);
  await logBericht({ leadId, soort, kanaal: 'mail', naar: email, status: 'verstuurd', externId: r.messageId || null });
  return { ok: true, status: 'verstuurd' };
}

/**
 * Het WhatsApp-sjabloon voor een stap: onderhoud_sjablonen met traject_slug
 * 'the-lab', deze soort, kanaal whatsapp, actief en met een meta_template.
 * Null = er is (nog) niets ingesteld.
 */
export async function labWaSjabloon(soort) {
  const { data, error } = await supabaseAdmin.from('onderhoud_sjablonen')
    .select('id, meta_template, variabele_volgorde, tekst')
    .eq('traject_slug', LAB_SLUG).eq('soort', soort).eq('kanaal', 'whatsapp').eq('actief', true)
    .not('meta_template', 'is', null).limit(1);
  if (error) { console.warn('[lab-berichten] sjabloon lezen (soft):', error.message); return null; }
  return data?.[0] || null;
}

/** Variabelen in de volgorde van het sjabloon. Onbekend/leeg → null. PURE. */
export function waVariabelenVolgens(volgorde, waarden) {
  const lijst = Array.isArray(volgorde) ? volgorde : [];
  const uit = lijst.map((k) => String(waarden?.[String(k).replace(/^lead\./, '')] ?? '').trim());
  return uit.some((v) => !v) ? null : uit;
}

/**
 * Eén WhatsApp via het ingestelde template. Gooit nooit.
 * Statussen: verstuurd | geen_toestemming | geen_nummer | geen_template |
 * niet_goedgekeurd | variabele_leeg | geen_lijn | fout
 */
export async function stuurLabWhatsApp({ leadId = null, telefoon, toestemming, soort, waarden }) {
  if (!toestemming) return { ok: false, status: 'geen_toestemming' };
  if (!/^\+[1-9]\d{7,14}$/.test(String(telefoon || ''))) return { ok: false, status: 'geen_nummer' };
  try {
    const sj = await labWaSjabloon(soort);
    if (!sj) return { ok: false, status: 'geen_template' };
    const vars = waVariabelenVolgens(sj.variabele_volgorde, waarden);
    if (!vars) return { ok: false, status: 'variabele_leeg' };
    const lijn = await haalLijn();
    if (!lijn.phoneNumberId) return { ok: false, status: 'geen_lijn' };
    const live = await goedgekeurdeTemplatesOpLijn(lijn.phoneNumberId);
    const t = live.ok ? live.templates.find((x) => x.name === sj.meta_template) : null;
    if (!t) return { ok: false, status: 'niet_goedgekeurd' };
    const r = await sendTemplate({
      to: telefoon.replace(/^\+/, ''), templateName: t.name, languageCode: t.language,
      variables: vars, phoneNumberId: lijn.phoneNumberId,
    });
    const wamid = r?.wamid || null;
    const log = await logOutboundWa(supabaseAdmin, {
      toPhone: telefoon, phoneNumberId: lijn.phoneNumberId, body: sj.tekst || t.name, wamid,
      templateName: t.name, templateVariables: Object.fromEntries(vars.map((x, i) => [i + 1, x])), source: 'the-lab',
    });
    if (!log?.ok) console.warn('[lab-berichten] WA in draad loggen (soft):', log?.error);
    await logBericht({ leadId, soort, kanaal: 'whatsapp', naar: telefoon, status: 'verstuurd', externId: wamid });
    return { ok: true, status: 'verstuurd' };
  } catch (e) {
    console.error('[lab-berichten] WA mislukt', { soort, lead: leadId, fout: e?.message || e });
    await logBericht({ leadId, soort, kanaal: 'whatsapp', naar: telefoon, status: 'fout', fout: String(e?.message || e).slice(0, 300) });
    return { ok: false, status: 'fout' };
  }
}
