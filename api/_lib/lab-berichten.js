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

/**
 * De belofte per product: onderwerp, de eerste zin en wat je krijgt. Zelfde
 * opbouw voor elk product, zodat de lead overal dezelfde weg ziet:
 * video's → The Lab → strategiesessie. Een onbekend product valt terug op
 * de algemene tekst ('website').
 */
export const WELKOM_BELOFTE = Object.freeze({
  minicursus: {
    onderwerp: 'Je minicursus staat klaar',
    intro: 'Je minicursus staat voor je klaar. Je krijgt de korte video\'s waarmee onze studenten zelf begonnen — hoe de markt écht beweegt — en daarna plaats je in The Lab je eerste (simulatie)trade met onze strategie.',
  },
  '7-daagse': {
    onderwerp: 'Je 7 dagen meekijken starten nu',
    intro: 'Vanaf vandaag kijk je 7 dagen mee in onze leeromgeving. Je ziet de video\'s die onze studenten krijgen, de opname van een live training, en in The Lab plaats je zelf je eerste (simulatie)trade.',
  },
  webinar: {
    onderwerp: 'Je toegang staat klaar — alvast vóór het webinar',
    intro: 'Je plek in het webinar staat vast. Wil je er het maximum uithalen? Dan kan je nu al beginnen: in je leeromgeving staan de video\'s waar we in het webinar op verder bouwen, en in The Lab plaats je je eerste (simulatie)trade.',
  },
  website: {
    onderwerp: 'Je toegang tot de leeromgeving staat klaar',
    intro: 'Je persoonlijke leeromgeving staat klaar. Je krijgt de video\'s waarmee onze studenten zelf begonnen, en in The Lab plaats je je eerste (simulatie)trade met onze strategie.',
  },
  'the-lab': {
    onderwerp: 'Je toegang tot The Lab staat klaar',
    intro: 'Je eigen account staat klaar. In The Lab plaats je je eerste trade met onze strategie — stap voor stap, in een echte chart. Reken op een twintigtal minuten.',
  },
});

/** De belofte voor dit product (onbekend → website). PURE. */
export function welkomBelofte(product) {
  return WELKOM_BELOFTE[product] || WELKOM_BELOFTE.website;
}

const DATUM_NL = new Intl.DateTimeFormat('nl-BE', { timeZone: 'Europe/Amsterdam', weekday: 'long', day: 'numeric', month: 'long' });

/** 'dinsdag 2 november' of null. PURE. */
export function leesbareDatum(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? DATUM_NL.format(new Date(t)) : null;
}

export function mailWelkom({ voornaam, link, product = 'the-lab', toegangTot = null }) {
  const v = esc(voornaam || 'daar');
  const b = welkomBelofte(product);
  const tot = leesbareDatum(toegangTot);
  return {
    onderwerp: b.onderwerp,
    html: `<p>Hey ${v},</p>
<p>${esc(b.intro)}</p>
${knop(link, 'Log in')}
<p><strong>Wat je eerst doet:</strong></p>
<ol style="padding-left:20px;margin:0 0 14px">
<li style="margin-bottom:6px"><strong>Kijk de video's</strong> — kort en to the point, je begint bij de eerste.</li>
<li style="margin-bottom:6px"><strong>Plaats je eerste trade in The Lab</strong> — een simulatie in een echte chart, een twintigtal minuten.</li>
<li><strong>Plan je strategiesessie</strong> — 30 minuten met ons team over jouw doelen. Normaal €100, voor jou gratis.</li>
</ol>
<p>Inloggen hoeft niet: de knop doet dat voor je. Je toegang loopt ${LAB_TOEGANG_DAGEN} dagen${tot ? `, tot ${esc(tot)}` : ''}.</p>
<p>Werkt de knop niet meer? Ga naar <a href="${esc(lmsBasisUrl())}">${esc(lmsBasisUrl().replace(/^https:\/\//, ''))}</a> en vraag een nieuwe link aan met je e-mailadres.</p>`,
  };
}

export function mailNieuweLink({ voornaam, link, verlopen = false, product = 'the-lab' }) {
  const v = esc(voornaam || 'daar');
  const lab = product === 'the-lab' || !product;
  return {
    onderwerp: lab ? 'Je nieuwe link voor The Lab' : 'Je nieuwe inloglink',
    html: verlopen
      ? `<p>Hey ${v},</p>
<p>Je toegang ${lab ? 'tot The Lab' : 'tot je leeromgeving'} is afgelopen, maar je strategiesessie kan je nog altijd inplannen. Met deze knop kom je meteen op de juiste plek.</p>
${knop(link, 'Plan mijn strategiesessie')}`
      : `<p>Hey ${v},</p>
<p>Hier is je nieuwe link. Je komt meteen terug waar je gebleven was.</p>
${knop(link, lab ? 'Verder met The Lab' : 'Log in')}`,
  };
}

/** Wat de lead aanvroeg, in de zin "Je vroeg … aan". PURE. */
const AANGEVRAAGD = Object.freeze({
  minicursus: 'de minicursus', '7-daagse': 'de 7 dagen meekijken', webinar: 'toegang tot onze leeromgeving',
  website: 'toegang tot onze leeromgeving', 'the-lab': 'toegang tot The Lab',
});

export function mailAlToegang({ voornaam, product = 'the-lab' }) {
  const v = esc(voornaam || 'daar');
  const basis = lmsBasisUrl();
  return {
    onderwerp: 'Je hebt al toegang bij De Forex Opleiding',
    html: `<p>Hey ${v},</p>
<p>Je vroeg ${esc(AANGEVRAAGD[product] || AANGEVRAAGD.website)} aan, maar met dit e-mailadres heb je al een account bij ons. We hebben daar niets aan veranderd.</p>
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
