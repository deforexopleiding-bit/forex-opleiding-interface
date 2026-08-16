// api/_lib/email-handtekening.js
//
// Eén bron voor de vaste e-mailhandtekening van dit project. Alle verzendpaden
// (motor via de send-core, de "Beantwoord per e-mail"-modals) gebruiken deze,
// zodat de handtekening overal gelijk is en precies één keer wordt toegevoegd.
//
//   Met vriendelijke groet,
//   Team - De Forex Opleiding
//   [logo]
//
// De platte-tekstversie heeft geen logo (tekstmail kan geen afbeelding tonen);
// de HTML-versie wel. Het logo is een statisch bestand op de repo-root, publiek
// serveerbaar op /dfo-logo-email.png. De URL is via env te overschrijven mocht
// het productiedomein anders zijn.

const LOGO_URL = process.env.MAIL_LOGO_URL
  || 'https://forex-opleiding-interface.vercel.app/dfo-logo-email.png';

// Detectiereeks tegen dubbele handtekening: uniek genoeg om vals-positief te
// vermijden, en aanwezig in zowel de tekst- als de HTML-versie.
export const HANDTEKENING_MARKER = 'Team - De Forex Opleiding';

// Platte-tekst-handtekening (voor het voorvullen van de modals en de tekstmail).
// Lege regel tussen de aanhef en de naam (correctie: witregel in de handtekening).
export const HANDTEKENING_TEKST = 'Met vriendelijke groet,\n\nTeam - De Forex Opleiding';

// Alleen het logo (als de tekstregels al in de HTML-body staan).
export function handtekeningLogoHtml() {
  return '<img src="' + LOGO_URL + '" alt="De Forex Opleiding" width="180" '
    + 'style="height:auto;display:block;margin-top:8px">';
}

// Volledige HTML-handtekening: de tekstregels + het logo. Witregel (<br><br>)
// tussen de aanhef en de naam; het logo staat direct onder de naam.
export function handtekeningHtml() {
  return '<div style="margin-top:16px;font-family:Arial,Helvetica,sans-serif;'
    + 'font-size:14px;color:#1b2430;line-height:1.5">'
    + 'Met vriendelijke groet,<br><br>Team - De Forex Opleiding'
    + handtekeningLogoHtml()
    + '</div>';
}

export function heeftHandtekening(s) {
  return String(s == null ? '' : s).includes(HANDTEKENING_MARKER);
}
function heeftLogo(s) {
  return String(s == null ? '' : s).includes(LOGO_URL);
}

// Voeg de platte-tekst-handtekening toe, tenzij die er al staat (idempotent).
export function tekstMetHandtekening(text) {
  const t = String(text == null ? '' : text);
  if (heeftHandtekening(t)) return t;
  return t.replace(/\s+$/, '') + '\n\n' + HANDTEKENING_TEKST;
}

// Zet platte tekst om naar veilige HTML (escape + newlines -> <br>).
export function tekstNaarHtml(text) {
  const esc = String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;'
    + 'color:#1b2430;line-height:1.6">' + esc.replace(/\n/g, '<br>') + '</div>';
}

// Voeg de HTML-handtekening toe, tenzij het logo er al in zit (idempotent).
export function htmlMetHandtekening(html) {
  const h = String(html == null ? '' : html);
  if (heeftLogo(h)) return h;
  return h + handtekeningHtml();
}

// Bouw HTML uit platte tekst en plaats het logo DIRECT ná de handtekeningregel
// ("Team - De Forex Opleiding"), niet aan het einde. Zo staat het logo bij een
// reply als onderdeel van het handtekening-blok, vóór het geciteerde origineel.
function htmlUitTekstMetLogoBijHandtekening(signedText) {
  const html = tekstNaarHtml(signedText);
  // Eerste voorkomen = de handtekening (die vóór een eventueel citaat staat).
  if (html.includes(HANDTEKENING_MARKER)) {
    return html.replace(HANDTEKENING_MARKER, HANDTEKENING_MARKER + handtekeningLogoHtml());
  }
  return html + handtekeningLogoHtml(); // fallback: geen handtekening gevonden
}

/**
 * Kern: zorg dat {text, html} beide de handtekening precies één keer hebben.
 *  - text  -> platte-tekst-handtekening (idempotent).
 *  - html meegegeven (bv. motor-sjabloon) -> volledige HTML-handtekening eronder.
 *  - geen html (bv. een reply) -> HTML uit de tekst, met het logo direct ná de
 *    handtekeningregel, dus vóór het citaat.
 * Geeft altijd zowel text als html terug (HTML-mail met platte-tekst-fallback).
 */
// v2 email-round v=20: placement-marker patroon.
// Compose (email-v2.js) plaatst bij reply/forward een marker tussen de
// eigen-tekst-zone en het quote/doorstuur-blok. Server (deze helper)
// vervangt de marker door de handtekening. Bij nieuwe mails zonder
// marker → append aan het eind (huidig, correct gedrag).
//
// HTML-marker: <div data-sig-marker="1"> … </div>  (attribute-based, robuust
//              door contenteditable/HTML-sanitizers heen).
// Text-marker: regel met alleen `__SIG_HERE__` (met omringende witregels).
export const SIG_MARKER_HTML_RE = /<div[^>]*data-sig-marker=["']1["'][^>]*>[\s\S]*?<\/div>/i;
export const SIG_MARKER_TEXT_RE = /\n?\s*__SIG_HERE__\s*\n?/;

export function metHandtekening(text, html) {
  const t = String(text == null ? '' : text);
  const h = String(html == null ? '' : html);
  const hasHtmlMarker = SIG_MARKER_HTML_RE.test(h);
  const hasTextMarker = SIG_MARKER_TEXT_RE.test(t);
  if (hasHtmlMarker || hasTextMarker) {
    // Placement-mode: replace marker (idempotent — marker verdwijnt na
    // vervanging dus tweede aanroep append niet nogmaals).
    const sigHtmlBlock = handtekeningHtml();
    const sigTextBlock = '\n\n' + HANDTEKENING_TEKST;
    const outText = hasTextMarker
      ? t.replace(SIG_MARKER_TEXT_RE, sigTextBlock)
      : tekstMetHandtekening(t); // fallback: append aan text als alleen HTML marker
    const outHtml = h
      ? (hasHtmlMarker ? h.replace(SIG_MARKER_HTML_RE, sigHtmlBlock) : htmlMetHandtekening(h))
      : tekstNaarHtml(outText);
    return { text: outText, html: outHtml };
  }
  // Legacy path: nieuwe mail (geen quote/marker) — append aan eind.
  const signedText = tekstMetHandtekening(text);
  const signedHtml = html
    ? htmlMetHandtekening(html)
    : htmlUitTekstMetLogoBijHandtekening(signedText);
  return { text: signedText, html: signedHtml };
}

/**
 * v2 email-round DEEL 3: per-mailbox handtekening uit DB laden.
 *
 * Query-order (per-mailbox rij wint van global):
 *   SELECT * FROM email_signatures
 *   WHERE (mailbox = $1 OR mailbox IS NULL) AND is_active = true
 *   ORDER BY mailbox NULLS LAST LIMIT 1
 *
 * Als de tabel niet bestaat (migratie nog niet gedraaid) OF de query faalt,
 * valt hij fail-soft terug op de bestaande hardcoded metHandtekening().
 * Idempotent: als de handtekening-tekst al in de body zit, geen dubbeling.
 *
 * Aanroepen vanuit send-endpoints:
 *   const { text, html } = await metHandtekeningAsync(text, html, {
 *     mailbox: fromMailboxSlug, // 'info' | 'leads' | ... (NIET full addr)
 *     supabaseAdmin: <admin client>,
 *   });
 *
 * Als `supabaseAdmin` niet meegegeven: skip DB-lookup en fallback op sync-variant.
 */
export async function metHandtekeningAsync(text, html, opts) {
  const mailbox = String(opts?.mailbox || '').trim().toLowerCase() || null;
  const supabaseAdmin = opts?.supabaseAdmin || null;
  if (!supabaseAdmin) return metHandtekening(text, html);
  let sig = null;
  try {
    // Per-mailbox eerst (mailbox=X); global (mailbox IS NULL) als fallback.
    if (mailbox) {
      const q = await supabaseAdmin
        .from('email_signatures')
        .select('body_html, body_text, logo_url')
        .eq('mailbox', mailbox)
        .eq('is_active', true)
        .maybeSingle();
      if (!q.error && q.data) sig = q.data;
    }
    if (!sig) {
      const q = await supabaseAdmin
        .from('email_signatures')
        .select('body_html, body_text, logo_url')
        .is('mailbox', null)
        .eq('is_active', true)
        .maybeSingle();
      if (!q.error && q.data) sig = q.data;
    }
  } catch (e) {
    console.warn('[email-handtekening] DB-lookup failed:', e?.message || e);
    return metHandtekening(text, html); // fallback
  }
  if (!sig || (!sig.body_html && !sig.body_text)) {
    // Geen DB-rij gevonden — fallback op hardcoded.
    return metHandtekening(text, html);
  }
  const inText = String(text || '');
  const inHtml = String(html || '');
  const hasHtmlMarker = SIG_MARKER_HTML_RE.test(inHtml);
  const hasTextMarker = SIG_MARKER_TEXT_RE.test(inText);
  const sigTextBlock = sig.body_text ? ('\n\n' + sig.body_text) : '';
  const sigHtmlBlock = sig.body_html || (sig.body_text ? tekstNaarHtml(sig.body_text) : '');
  // v2 email-round v=20: placement-marker (analoog aan metHandtekening).
  if (hasHtmlMarker || hasTextMarker) {
    const outText = hasTextMarker
      ? inText.replace(SIG_MARKER_TEXT_RE, sigTextBlock)
      : (inText.replace(/\s+$/, '') + sigTextBlock);
    let outHtml;
    if (inHtml) {
      outHtml = hasHtmlMarker ? inHtml.replace(SIG_MARKER_HTML_RE, sigHtmlBlock) : (inHtml + sigHtmlBlock);
    } else {
      outHtml = tekstNaarHtml(outText).replace(sigTextBlock.trim(), sigHtmlBlock);
    }
    return { text: outText, html: outHtml };
  }
  // Geen marker → append aan het eind (nieuwe mail, geen quote).
  // Idempotent-check: als DB-body_text al in de body zit, skip.
  const dbMarker = String(sig.body_text || sig.body_html || '').slice(0, 60);
  const alreadyInText = dbMarker && inText.includes(dbMarker);
  const alreadyInHtml = dbMarker && inHtml.includes(dbMarker.slice(0, 40));
  const outText = alreadyInText ? inText : (inText.replace(/\s+$/, '') + sigTextBlock);
  let outHtml;
  if (inHtml) {
    outHtml = alreadyInHtml ? inHtml : (inHtml + sigHtmlBlock);
  } else {
    outHtml = tekstNaarHtml(outText).replace(sigTextBlock.trim(), '') + sigHtmlBlock;
  }
  return { text: outText, html: outHtml };
}
