// api/_lib/nieuwsbrief-render.js
//
// Contentmachine — de nieuwsbrief-HTML van een drop. PUUR (geen netwerk/DB).
// 600px tabel-layout, alles inline (Gmail/Outlook/Apple Mail), navy #0B1E2A /
// #112B3B met goud #D0A050, Inter met Arial-fallback — dezelfde look als
// training.deforexopleiding.nl (referentie: docs/contentmachine/nieuwsbrief-lt-22-10-26.html).
//
// Elk bloktype heeft een eigen render-functie (BLOKKEN). Beelden via de publieke
// Storage-URL. Alle links: utm_source=nieuwsbrief&utm_medium=email&
// utm_campaign=drop-<slug>&utm_content=<blok> + src=nieuwsbrief.
// Uitschrijflink = de merge-tag van de verzender (GHL); standaard UITSCHRIJF_TAG.
// Studentnamen enkel bij een beeld met toestemming (de renderer dwingt dat ook af).

export const TRAINING_ORIGIN = 'https://training.deforexopleiding.nl';
export const UITSCHRIJF_TAG = '{{unsubscribe_link}}';
export const DISCLAIMER = 'Dit is educatief materiaal en geen financieel advies. Traden houdt risico\'s in: je kan je inleg verliezen.';

const C = { bg: '#0B1E2A', kaart: '#112B3B', rand: '#1F455F', goud: '#D0A050', wit: '#FFFFFF', tekst: '#D9E3E8', zacht: '#8FA7B5', bull: '#3FC79A', bear: '#E5675C' };
const FONT = 'Inter,Arial,Helvetica,sans-serif';

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Tekst → veilige HTML: **vet** wordt wit/vet, lege regel = nieuwe alinea, enkele regel = <br>. */
export function opmaak(tekst, { vetKleur = C.wit } = {}) {
  return esc(tekst).replace(/\*\*(.+?)\*\*/g, `<b style="color:${vetKleur};">$1</b>`).replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
}
/** Citaat: het deel tussen **…** wordt goud. */
function goudAccent(tekst) {
  return esc(tekst).replace(/\*\*(.+?)\*\*/g, `<span style="color:${C.goud};">$1</span>`);
}

export function paginaUrl(slug) { return `${TRAINING_ORIGIN}/${slug}`; }

/** Link naar de drop-pagina met UTM + src. */
export function link(slug, blok, extra = '') {
  const q = new URLSearchParams({ src: 'nieuwsbrief', utm_source: 'nieuwsbrief', utm_medium: 'email', utm_campaign: `drop-${slug}`, utm_content: blok });
  return `${paginaUrl(slug)}?${q.toString()}${extra}`;
}

const rij = (inhoud, padding = '26px 36px 0 36px') => `<tr><td class="p" style="padding:${padding};font-family:${FONT};">${inhoud}</td></tr>`;
const kicker = (t) => (t ? `<div style="font-size:12px;font-weight:800;letter-spacing:2.5px;color:${C.goud};text-transform:uppercase;">${esc(t)}</div>` : '');
const titel = (t, size = 24) => (t ? `<div style="font-size:${size}px;line-height:${Math.round(size * 1.18)}px;font-weight:900;letter-spacing:-.5px;color:${C.wit};margin-top:8px;">${esc(t)}</div>` : '');
const alinea = (t, mt = 12) => (t ? `<div style="font-size:16px;line-height:25px;color:${C.tekst};margin-top:${mt}px;">${opmaak(t)}</div>` : '');

function knop(href, tekst, { klein = false } = {}) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:18px;"><tr>
    <td align="center" bgcolor="${C.goud}" style="border-radius:14px;">
      <a href="${esc(href)}" style="display:block;padding:${klein ? '13px 20px' : '17px 24px'};font-family:${FONT};font-size:${klein ? 16 : 18}px;font-weight:900;color:${C.bg};text-decoration:none;border-radius:14px;">${esc(tekst)} &rarr;</a>
    </td></tr></table>`;
}

function beeld(asset, href, alt) {
  if (!asset || !asset.publieke_url) return '';
  const img = `<img src="${esc(asset.publieke_url)}" width="528" alt="${esc(alt || asset.bijschrift || '')}" style="display:block;width:100%;max-width:528px;height:auto;border:0;border-radius:14px;">`;
  return `<div style="margin-top:16px;">${href ? `<a href="${esc(href)}" style="text-decoration:none;">${img}</a>` : img}</div>`;
}

/** Naam van een persoon op een beeld — enkel met toestemming. */
export function publiekeNaam(asset) {
  return asset && asset.persoon_naam && asset.toestemming_publiek === true ? asset.persoon_naam : null;
}

// ── Bloktypes ───────────────────────────────────────────────────────────────
export const BLOKKEN = {
  opener(b) {
    return rij(`${kicker(b.kicker)}${titel(b.titel, 30)}${alinea(b.tekst, b.titel ? 14 : 4)}`, '34px 36px 0 36px');
  },
  video(b, ctx) {
    const i = ctx.drop.input || {};
    const thumb = i.vimeo_thumbnail
      ? `<a href="${esc(link(ctx.slug, 'video'))}" style="text-decoration:none;display:block;margin-top:16px;">
          <img src="${esc(i.vimeo_thumbnail)}" width="528" alt="${esc(i.vimeo_titel || 'Opname van de live training')}" style="display:block;width:100%;max-width:528px;height:auto;border:0;border-radius:14px;">
          <div style="font-family:${FONT};font-size:13px;font-weight:800;color:${C.goud};margin-top:8px;">&#9654; Speel de opname af${i.duur ? ' · ' + Math.round(i.duur / 60) + ' min' : ''}</div></a>`
      : '';
    return rij(`${kicker(b.kicker || 'De opname')}${titel(b.titel)}${alinea(b.tekst)}${thumb}${knop(link(ctx.slug, 'video'), b.knop_tekst || 'Bekijk de opname')}`);
  },
  chart(b, ctx) {
    return rij(`${kicker(b.kicker || 'Op de chart')}${titel(b.titel)}${beeld(ctx.asset(b.beeld_asset_id), link(ctx.slug, 'chart'))}${alinea(b.tekst, 14)}`);
  },
  trade_ontleed(b, ctx) {
    const stappen = (b.stappen || []).map((s, i) => `<tr>
      <td valign="top" style="width:38px;padding:10px 0;font-size:18px;font-weight:900;color:${C.goud};${i ? `border-top:1px solid ${C.rand};` : ''}">${String(i + 1).padStart(2, '0')}</td>
      <td style="padding:10px 0;font-size:15px;line-height:22px;color:${C.tekst};${i ? `border-top:1px solid ${C.rand};` : ''}"><b style="color:${C.wit};">${esc(s.titel)}.</b> ${opmaak(s.tekst)}</td></tr>`).join('');
    return rij(`${kicker(b.kicker || 'De trade ontleed')}${titel(b.titel)}${alinea(b.tekst)}${beeld(ctx.asset(b.beeld_asset_id), link(ctx.slug, 'trade'))}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">${stappen}</table>
      ${knop(link(ctx.slug, 'trade'), b.knop_tekst || 'Zie de volledige uitleg', { klein: true })}`);
  },
  quiz(b, ctx) {
    const opties = (b.opties || []).map((o, i) => `<tr><td style="padding:5px 0;">
      <a href="${esc(link(ctx.slug, 'quiz-' + (i + 1), '#quiz'))}" style="display:block;padding:13px 16px;border:1px solid ${C.rand};border-radius:12px;background:${C.bg};font-family:${FONT};font-size:15px;font-weight:700;color:${C.wit};text-decoration:none;">
      <span style="color:${C.goud};">${String.fromCharCode(65 + i)}.</span> ${esc(o)}</a></td></tr>`).join('');
    return rij(`${kicker(b.kicker || 'Wat zou jij doen?')}${titel(b.titel || b.vraag)}${b.titel && b.vraag ? alinea(b.vraag) : ''}${alinea(b.tekst)}
      ${beeld(ctx.asset(b.beeld_asset_id), link(ctx.slug, 'quiz'))}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">${opties}</table>
      <div style="font-size:13px;color:${C.zacht};margin-top:8px;">Kies je antwoord — het juiste antwoord en de uitleg staan op de pagina.</div>`);
  },
  payout(b, ctx) {
    const a = ctx.asset(b.beeld_asset_id);
    const naam = publiekeNaam(a);
    return rij(`${kicker(b.kicker || 'Het bewijs')}${titel(b.titel)}${beeld(a, link(ctx.slug, 'payout'), naam ? `Payout van ${naam}` : 'Payout van een student')}
      ${naam ? `<div style="font-size:13px;color:${C.zacht};margin-top:8px;">${esc(naam)} · ${esc(a.bijschrift || 'payout')}</div>` : ''}${alinea(b.tekst, 12)}`);
  },
  tip_van_de_week(b) {
    return rij(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 22px;border-left:3px solid ${C.goud};background:${C.bg};border-radius:0 14px 14px 0;font-family:${FONT};">
      ${kicker(b.kicker || 'Tip van de week')}${titel(b.titel, 20)}${alinea(b.tekst, 8)}</td></tr></table>`);
  },
  mythe(b) {
    return rij(`${kicker(b.kicker || 'Mythe')}${b.titel ? `<div style="font-size:20px;line-height:26px;font-weight:800;color:${C.zacht};margin-top:8px;text-decoration:line-through;">${esc(b.titel)}</div>` : ''}${alinea(b.tekst)}`);
  },
  vooruitblik(b, ctx) {
    return rij(`${kicker(b.kicker || 'Volgende week')}${titel(b.titel)}${alinea(b.tekst)}${beeld(ctx.asset(b.beeld_asset_id), link(ctx.slug, 'vooruitblik'))}`);
  },
  cijfers(b) {
    return rij(`<div style="text-align:center;padding:8px 0;">${kicker(b.kicker)}
      <div style="font-size:64px;line-height:68px;font-weight:900;letter-spacing:-2px;color:${C.goud};margin-top:6px;">${esc(b.getal)}</div>
      ${b.getal_label ? `<div style="font-size:15px;font-weight:700;color:${C.wit};margin-top:4px;">${esc(b.getal_label)}</div>` : ''}
      ${b.tekst ? `<div style="font-size:15px;line-height:23px;color:${C.tekst};margin-top:10px;">${opmaak(b.tekst)}</div>` : ''}</div>`);
  },
  cadeau(b, ctx) {
    return rij(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 22px;border:1px solid ${C.goud};border-radius:16px;background:${C.bg};font-family:${FONT};">
      ${kicker(b.kicker || 'Cadeau deze week')}${titel(b.titel || 'Gratis strategiesessie met Dave', 22)}
      <div style="font-size:15px;color:${C.zacht};margin-top:6px;"><span style="text-decoration:line-through;">t.w.v. €100</span> &nbsp;<b style="color:${C.goud};font-size:17px;">nu €0</b></div>
      ${alinea(b.tekst, 10)}${knop(link(ctx.slug, 'cadeau', '#cadeau'), b.knop_tekst || 'Plan je sessie', { klein: true })}</td></tr></table>`);
  },
  ps(b) {
    return rij(`<div style="font-size:15px;line-height:23px;color:${C.tekst};"><b style="color:${C.goud};">PS</b> ${opmaak(b.tekst || b.titel || '')}</div>`);
  },
};

// ── Contentmachine 2.0: de teaser naar de Weekeditie ───────────────────────
// Kort (±150-220 woorden), één nugget, één beeld (frame van het interactieve blok,
// gerenderd in het CRM: output.social.bestanden.nieuwsbrief), een open lus en één
// hoofdknop "Lees de volledige weekeditie". Echt logo in de kop.
export const LOGO_WIT = 'https://www.deforexopleiding.nl/weekeditie/logo-wit.png';
export const KNOP_WEEKEDITIE = 'Lees de volledige weekeditie';

/** Is dit een nieuwsbrief van Contentmachine 2.0 (teaser)? */
export const isTeaser = (n) => !!(n && typeof n === 'object' && typeof n.opener === 'string' && n.nugget);

/** Woorden van de teaser (opener + nugget + open lus + ps), voor de lengtecontrole. */
export function teaserWoorden(n) {
  if (!isTeaser(n)) return 0;
  const t = [n.opener, n.nugget && n.nugget.titel, n.nugget && n.nugget.tekst, n.open_lus && n.open_lus.vraag, n.open_lus && n.open_lus.tekst, n.ps].filter(Boolean).join(' ');
  return t.replace(/\*\*/g, '').split(/\s+/).filter(Boolean).length;
}

export const TEASER_WOORDEN = [130, 240];

/**
 * Controle van een teaser (Contentmachine 2.0). `pagina` = de Weekeditie (voor het beeld-blok).
 * → [string]
 */
export function teaserFouten(n, pagina) {
  const f = [];
  const tekst = (x) => typeof x === 'string' && x.trim().length > 0;
  if (!isTeaser(n)) return ['nieuwsbrief: opener en nugget ontbreken'];
  const o = Array.isArray(n.onderwerpen) ? n.onderwerpen : [];
  if (o.length !== 3 || !o.every(tekst)) f.push('nieuwsbrief.onderwerpen: precies 3');
  else if (new Set(o.map((x) => x.trim().toLowerCase())).size !== 3) f.push('nieuwsbrief.onderwerpen: 3 verschillende varianten');
  o.forEach((x, i) => { if (tekst(x) && x.length > 70) f.push(`nieuwsbrief.onderwerpen[${i}] te lang (max 70)`); });
  if (!tekst(n.preheader)) f.push('nieuwsbrief.preheader ontbreekt');
  else if (n.preheader.length > 120) f.push('nieuwsbrief.preheader te lang (max 120)');
  if (!tekst(n.opener)) f.push('nieuwsbrief.opener ontbreekt');
  if (!n.nugget || !tekst(n.nugget.titel) || !tekst(n.nugget.tekst)) f.push('nieuwsbrief.nugget: titel en tekst');
  if (!n.open_lus || !tekst(n.open_lus.vraag)) f.push('nieuwsbrief.open_lus.vraag ontbreekt');
  if (!tekst(n.ps)) f.push('nieuwsbrief.ps ontbreekt (het cadeau)');
  else if (!/(sessie|cadeau|dave|€\s?0)/i.test(n.ps)) f.push('nieuwsbrief.ps: noem het cadeau (gratis strategiesessie)');
  const bl = (pagina && pagina.blokken) || [];
  if (bl.length && (!Number.isInteger(n.beeld_blok_index) || !bl[n.beeld_blok_index] || bl[n.beeld_blok_index].type === 'cadeau')) f.push('nieuwsbrief.beeld_blok_index: wijs een blok van de pagina aan (bij voorkeur interactief)');
  const w = teaserWoorden(n);
  if (w < TEASER_WOORDEN[0] || w > TEASER_WOORDEN[1]) f.push(`nieuwsbrief: ${w} woorden — hou het kort (${TEASER_WOORDEN[0]}–${TEASER_WOORDEN[1]})`);
  return f;
}

export function renderTeaser({ drop, output, onderwerpIndex = 0, uitschrijfLink = UITSCHRIJF_TAG }) {
  const n = output.nieuwsbrief;
  const slug = drop.slug;
  const bestanden = (output.social && output.social.bestanden) || {};
  const beeldUrl = bestanden.nieuwsbrief && /^https:\/\//.test(bestanden.nieuwsbrief.url || '') ? bestanden.nieuwsbrief.url : null;
  const onderwerp = (n.onderwerpen || [])[onderwerpIndex] || (n.onderwerpen || [])[0] || 'De Weekeditie';
  const preheader = n.preheader || '';
  const datumKort = (() => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(drop.datum || ''); return m ? `${m[3]}/${m[2]}` : ''; })();
  const knopUrl = link(slug, 'knop');
  const beeldHtml = beeldUrl ? rij(`<a href="${esc(link(slug, 'beeld'))}" style="text-decoration:none;display:block;">
      <img src="${esc(beeldUrl)}" width="528" alt="${esc((n.open_lus && n.open_lus.vraag) || 'Speel het af in de weekeditie')}" style="display:block;width:100%;max-width:528px;height:auto;border:0;border-radius:14px;">
      <div style="font-family:${FONT};font-size:14px;font-weight:800;color:${C.goud};margin-top:10px;">&#9654; Speel het zelf af in de weekeditie</div></a>`, '22px 36px 0 36px') : '';
  const lus = n.open_lus || {};
  const nugget = n.nugget || {};
  const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(onderwerp)}</title>
<style>
  body{margin:0;padding:0;background:${C.bg}}
  a{color:${C.goud}}
  @media (max-width:620px){
    .w{width:100%!important}
    .p{padding-left:22px!important;padding-right:22px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg};">${esc(preheader)}${'&#8199;&#847;'.repeat(20)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" class="w" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

  <tr><td class="p" style="padding:0 36px 22px 36px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td><a href="https://www.deforexopleiding.nl" style="text-decoration:none;"><img src="${LOGO_WIT}" width="112" height="56" alt="De Forex Opleiding" style="display:block;width:112px;height:auto;border:0;"></a></td>
      <td align="right" style="font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:2px;color:${C.goud};text-transform:uppercase;">De Weekeditie${datumKort ? ' · ' + datumKort : ''}</td>
    </tr></table>
  </td></tr>

  <tr><td style="background:${C.kaart};border:1px solid ${C.rand};border-radius:20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rij(`<div style="font-size:16px;line-height:25px;color:${C.tekst};">${opmaak(n.opener)}</div>`, '32px 36px 0 36px')}
${rij(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 22px;border-left:3px solid ${C.goud};background:${C.bg};border-radius:0 14px 14px 0;font-family:${FONT};">
      ${kicker(nugget.kicker || 'De nugget van de week')}${titel(nugget.titel, 22)}${alinea(nugget.tekst, 8)}</td></tr></table>`)}
${beeldHtml}
${rij(`${kicker(lus.kicker || 'Wat zou jij doen?')}${titel(lus.vraag, 22)}${alinea(lus.tekst, 8)}${knop(knopUrl, KNOP_WEEKEDITIE)}`)}
${n.ps ? rij(`<div style="font-size:15px;line-height:23px;color:${C.tekst};border-top:1px solid ${C.rand};padding-top:18px;"><b style="color:${C.goud};">PS</b> ${opmaak(n.ps)}</div>`, '26px 36px 32px 36px') : rij('', '0 0 32px 0')}
    </table>
  </td></tr>

  <tr><td class="p" style="padding:26px 36px 0 36px;font-family:${FONT};text-align:center;">
    <div style="font-size:14px;color:${C.zacht};">Maxim · De Forex Opleiding</div>
  </td></tr>

  <tr><td class="p" style="padding:22px 36px 10px 36px;font-family:${FONT};font-size:12px;line-height:19px;color:${C.zacht};text-align:center;">
    Je ontvangt deze mail omdat je je hebt ingeschreven voor een training of de wekelijkse marktanalyse van De Forex Opleiding.<br>
    ${esc(DISCLAIMER)} Rekenvoorbeelden zijn geen beloftes.<br><br>
    <a href="${esc(uitschrijfLink)}" style="color:${C.zacht};text-decoration:underline;">Uitschrijven</a> &nbsp;·&nbsp; <a href="https://deforexopleiding.nl" style="color:${C.zacht};text-decoration:underline;">deforexopleiding.nl</a>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
  const tekst = [
    onderwerp, '', n.opener, '',
    [nugget.kicker || 'De nugget van de week', nugget.titel, nugget.tekst].filter(Boolean).join('\n'), '',
    [lus.vraag, lus.tekst].filter(Boolean).join('\n'), '',
    `${KNOP_WEEKEDITIE}: ${knopUrl}`, '',
    n.ps ? 'PS ' + n.ps : '',
    '', DISCLAIMER, `Uitschrijven: ${uitschrijfLink}`,
  ].filter((x) => x !== '').join('\n\n').replace(/\*\*/g, '');
  return { html, onderwerp, preheader, tekst, beeld: !!beeldUrl };
}

/**
 * → { html, onderwerp, preheader, tekst }
 * ctx: { drop:{slug,datum,soort,input}, output, assets:[…] | {id:asset}, onderwerpIndex, uitschrijfLink }
 * Een teaser (Contentmachine 2.0) gaat naar renderTeaser; anders de blokken-nieuwsbrief (v1).
 */
export function renderNieuwsbrief({ drop, output, assets = [], onderwerpIndex = 0, uitschrijfLink = UITSCHRIJF_TAG }) {
  if (output && isTeaser(output.nieuwsbrief)) return renderTeaser({ drop, output, onderwerpIndex, uitschrijfLink });
  const n = (output && output.nieuwsbrief) || {};
  const p = (output && output.pagina) || {};
  const slug = drop.slug;
  const map = Array.isArray(assets) ? Object.fromEntries(assets.map((a) => [a.id, a])) : assets;
  const ctx = { drop, slug, asset: (id) => (id ? map[id] || null : null) };
  const onderwerp = (n.onderwerpen || [])[onderwerpIndex] || (n.onderwerpen || [])[0] || p.og_titel || 'De Forex Opleiding';
  const preheader = n.preheader || '';

  const blokken = Array.isArray(n.blokken) ? n.blokken : [];
  const heeftPs = blokken.some((b) => b && b.type === 'ps');
  const inhoud = blokken.map((b) => {
    const f = b && BLOKKEN[b.type];
    if (!f) return '';
    if (b.type === 'video' && !(drop.input && drop.input.vimeo_id)) return '';
    try { return f(b, ctx); } catch (e) { return ''; }
  }).join('\n');
  const slotKnop = rij(knop(link(slug, 'knop'), p.knop || 'Bekijk het op de pagina'), '28px 36px 36px 36px');
  const ps = !heeftPs && n.ps ? BLOKKEN.ps({ tekst: n.ps }) : '';
  const datumKort = (() => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(drop.datum || ''); return m ? `${m[3]}/${m[2]}` : ''; })();

  const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(onderwerp)}</title>
<style>
  body{margin:0;padding:0;background:${C.bg}}
  a{color:${C.goud}}
  @media (max-width:620px){
    .w{width:100%!important}
    .p{padding-left:22px!important;padding-right:22px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg};">${esc(preheader)}${'&#8199;&#847;'.repeat(20)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" class="w" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

  <tr><td class="p" style="padding:0 36px 22px 36px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:2px;color:${C.wit};">
        <span style="display:inline-block;background:${C.goud};color:${C.bg};border-radius:8px;padding:6px 7px;margin-right:8px;font-weight:900;letter-spacing:0;">DFO</span>DE FOREX OPLEIDING
      </td>
      <td align="right" style="font-family:${FONT};font-size:12px;color:${C.zacht};">Wekelijkse marktanalyse${datumKort ? ' · ' + datumKort : ''}</td>
    </tr></table>
  </td></tr>

  <tr><td style="background:${C.kaart};border:1px solid ${C.rand};border-radius:20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${inhoud}
${ps}
${slotKnop}
    </table>
  </td></tr>

  <tr><td class="p" style="padding:26px 36px 0 36px;font-family:${FONT};text-align:center;">
    <div style="font-size:14px;color:${C.zacht};">Maxim · De Forex Opleiding</div>
  </td></tr>

  <tr><td class="p" style="padding:22px 36px 10px 36px;font-family:${FONT};font-size:12px;line-height:19px;color:${C.zacht};text-align:center;">
    Je ontvangt deze mail omdat je je hebt ingeschreven voor een training of de wekelijkse marktanalyse van De Forex Opleiding.<br>
    ${esc(DISCLAIMER)}<br><br>
    <a href="${esc(uitschrijfLink)}" style="color:${C.zacht};text-decoration:underline;">Uitschrijven</a> &nbsp;·&nbsp; <a href="https://deforexopleiding.nl" style="color:${C.zacht};text-decoration:underline;">deforexopleiding.nl</a>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  // Platte-tekstversie (voor de testmail / tekstweergave).
  const tekst = [
    onderwerp, '',
    ...blokken.map((b) => [b.kicker, b.titel, b.vraag, b.tekst, (b.stappen || []).map((s, i) => `${i + 1}. ${s.titel}: ${s.tekst}`).join('\n'), (b.opties || []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n'), b.getal ? `${b.getal} ${b.getal_label || ''}` : '']
      .filter(Boolean).join('\n')).filter(Boolean),
    n.ps && !heeftPs ? 'PS ' + n.ps : '',
    '', `${p.knop || 'Bekijk het op de pagina'}: ${link(slug, 'knop')}`,
    '', DISCLAIMER, `Uitschrijven: ${uitschrijfLink}`,
  ].filter((x) => x !== '').join('\n\n').replace(/\*\*/g, '');

  return { html, onderwerp, preheader, tekst };
}
