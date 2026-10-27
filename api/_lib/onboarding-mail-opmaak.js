// api/_lib/onboarding-mail-opmaak.js
//
// OPMAAK VOOR DE MAILSTAP VAN DE ONBOARDING-AUTOMATIONS (27 okt 2026).
//
// De mailstap (api/_lib/onboarding-automation-engine.js, send_email) verstuurt
// platte tekst. Voor de nieuwe welkomstmail wil Maxim de startcode groot in
// beeld en een knop "Start je onboarding". Dat kan nu met twee regels die je
// gewoon in de tekst van de flow zet — elk op een EIGEN regel:
//
//   {{onboarding.startcode}}          → de code groot, in een kader
//   [knop: Start je onboarding]       → een knop naar de persoonlijke link
//
// Staat geen van beide in de tekst, dan verandert er NIETS: de mail ziet er
// exact uit zoals vroeger (<p> met <br>). Bestaande flows blijven dus gelijk.
// {{onboarding.startcode}} midden in een zin wordt gewoon de code als tekst.
//
// PURE functies, getoetst in tests/onboarding-link.test.js.

import { renderMailShell, escMailHtml as esc } from './mail-shell.js';

export const CODE_REGEL = '{{onboarding.startcode}}';
const KNOP_RE = /^\s*\[knop:\s*([^\]]{1,60}?)\s*\]\s*$/i;

/** Gebruikt deze tekst de opmaakregels? */
export function heeftOpmaak(body) {
  return String(body || '').split('\n').some((r) => r.trim() === CODE_REGEL || KNOP_RE.test(r));
}

function vervang(tekst, waarden) {
  let s = String(tekst);
  for (const [k, v] of Object.entries(waarden || {})) s = s.split(k).join(v);
  return s;
}

function metLinks(htmlVeilig) {
  return htmlVeilig.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#10284A">${u}</a>`);
}

/**
 * @param {{subject: string, body: string, waarden: Record<string,string>, link: string}} p
 *   waarden = de {{…}}-vervangingen (incl. {{onboarding.startcode}}); link = de
 *   persoonlijke link voor de knop.
 * @returns {{html: string, text: string}}
 */
export function bouwOpmaakMail({ subject, body, waarden, link }) {
  const code = waarden?.[CODE_REGEL] || '';
  const html = [];
  const tekst = [];
  let alinea = [];
  const sluitAlinea = () => {
    if (!alinea.length) return;
    html.push(`<p style="margin:0 0 14px">${alinea.map((r) => metLinks(esc(r))).join('<br>')}</p>`);
    tekst.push(alinea.join('\n'), '');
    alinea = [];
  };
  for (const regel of String(body || '').split('\n')) {
    const knop = KNOP_RE.exec(regel);
    if (regel.trim() === CODE_REGEL) {
      sluitAlinea();
      if (code) {
        html.push('<div style="margin:6px 0 18px;padding:16px 18px;border:2px dashed #C98B2E;border-radius:12px;text-align:center;background:#fdf8ef">'
          + '<div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#7a6a4f;margin-bottom:6px">Jouw startcode</div>'
          + `<div style="font-family:'Courier New',Courier,monospace;font-size:30px;font-weight:700;letter-spacing:.18em;color:#10284A">${esc(code)}</div>`
          + '</div>');
        tekst.push(`Jouw startcode: ${code}`, '');
      }
      continue;
    }
    if (knop) {
      sluitAlinea();
      if (link) {
        html.push('<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:4px 0 18px">'
          + `<a href="${esc(link)}" style="display:inline-block;background:#FFC21A;color:#10284A;text-decoration:none;font-weight:700;font-size:16px;line-height:1;padding:15px 30px;border-radius:8px">${esc(knop[1])}</a>`
          + '</td></tr></table>');
        tekst.push(`${knop[1]}: ${link}`, '');
      }
      continue;
    }
    if (!regel.trim()) { sluitAlinea(); continue; }
    alinea.push(vervang(regel, waarden));
  }
  sluitAlinea();
  return {
    html: renderMailShell({ titel: vervang(subject, waarden), inhoud_html: html.join('\n') }),
    text: tekst.join('\n').trim(),
  };
}
