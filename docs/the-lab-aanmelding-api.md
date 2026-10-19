# The Lab — aanmeldings-API (voor de landingspagina)

Eén endpoint. Een landingspagina die dit aanroept, geeft de lead meteen een
eigen trial-account in het LMS, een loginmail (en een WhatsApp als er
toestemming is), een lead in Leadsonderhoud met bron **The Lab**, en een
Meta-`Lead`-event. Aansluiten duurt tien minuten: kopieer het fragment onderaan.

Een werkende voorbeeldpagina staat live op **https://lms.deforexopleiding.nl/the-lab/**
(broncode: `src/features/lab-lead/lab-landing.tsx` in `dfo-lms-prototype`).

## Endpoint

```
POST https://crm.deforexopleiding.nl/api/lab-aanmelding
Content-Type: application/json
```

Rechtstreeks vanuit de browser (CORS). Toegelaten origins: `www.` en kaal
`deforexopleiding.nl`, `lms.` en `crm.deforexopleiding.nl`, en de previews van
het LMS en de website. **Een ander domein** (de landingspagina van de collega)
komt erbij via de env-variabele `LAB_LANDING_ORIGINS` in het CRM-project op
Vercel — komma-gescheiden, volledige origins, bv.
`https://lab.deforexopleiding.nl,https://start.voorbeeld.be`. Geen deploy nodig
behalve het opslaan van de variabele (Vercel herstart de functies).

## Body

| Veld | Verplicht | Uitleg |
|---|---|---|
| `voornaam` | ja | max 60 tekens |
| `achternaam` | nee | |
| `email` | ja | |
| `gsm` | ja | vrij formaat; `04…` → België, `06…` → Nederland, `+…` wint altijd. Optioneel `land: "BE"\|"NL"` |
| `toestemming` | nee (boolean) | **verplicht voor WhatsApp en opvolgberichten**. Zonder: alleen de loginmail (daar vroeg de lead zelf om) |
| `hook` | nee | bv. `H01`…`H10`. Leeg → `utm_content` wordt gebruikt |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` | nee | gewoon doorgeven uit de URL |
| `landingspagina` | nee | `location.href` — de querystring wordt server-side weggeknipt |
| `fbclid` | nee | uit de URL |
| `fbp`, `fbc` | nee | de cookies `_fbp` / `_fbc` als de pixel draait |
| `website` | — | **honeypot**: een verborgen veld dat LEEG moet blijven |
| `bron` | nee | funnel op deforexopleiding.nl: `the-lab-v1` of `the-lab-v2`. Een NIEUWE lead krijgt dan `leads.bron` = die variant (Leadsonderhoud > Funnels), traject blijft `the-lab`. Al de rest (of niets) = `the-lab`. Een bestaande lead houdt zijn bron. |
| `session_id` | nee | funnel-tracking-sessie (uuid) van de website: het CRM hangt de `funnel_events` van die sessie aan de lead (zoals `/api/lead` op de website doet) |

## Antwoord

```json
200 { "ok": true, "event_id": "lab_lead_<uuid>", "bericht": "Gelukt! Check je mailbox: je link naar The Lab is onderweg." }
400 { "ok": false, "code": "ongeldig", "veld": "email", "fout": "Vul een geldig e-mailadres in." }
429 { "ok": false, "code": "te_veel", "fout": "Even geduld — probeer het over een paar minuten opnieuw." }
```

- Het 200-antwoord is **voor elk adres hetzelfde**, ook als die persoon al
  student of mentor is (dan krijgt hij een mail "je hebt al toegang" en wordt
  er niets aan zijn account veranderd). Zo verklapt het endpoint niet wie er
  klant is.
- **Idempotent op e-mail**: een tweede aanmelding geeft geen tweede account,
  maar een nieuwe loginlink — en de nieuwe touch (hook, UTM's) wordt wél
  geteld in de statistieken.
- `event_id`: geef die mee aan de pixel (`fbq('track','Lead',{}, {eventID})`),
  dan telt Meta browser en server samen één keer.

## Fragment om te plakken

```html
<form id="lab-form">
  <input name="voornaam" required placeholder="Voornaam" autocomplete="given-name">
  <input name="email" type="email" required placeholder="E-mailadres" autocomplete="email">
  <input name="gsm" type="tel" required placeholder="Gsm-nummer" autocomplete="tel">
  <label><input name="toestemming" type="checkbox"> Ja, De Forex Opleiding mag me via WhatsApp en e-mail berichten sturen over The Lab en mijn strategiesessie. Afmelden kan altijd.</label>
  <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
  <button type="submit">Geef me toegang tot The Lab</button>
  <p id="lab-melding" role="alert"></p>
</form>
<script>
(function () {
  var f = document.getElementById('lab-form'), m = document.getElementById('lab-melding');
  var q = new URLSearchParams(location.search);
  var koek = function (n) { var x = document.cookie.match('(?:^|; )' + n + '=([^;]*)'); return x ? decodeURIComponent(x[1]) : null; };
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var d = new FormData(f), knop = f.querySelector('button');
    var body = {
      voornaam: d.get('voornaam'), email: d.get('email'), gsm: d.get('gsm'),
      toestemming: d.get('toestemming') === 'on', website: d.get('website'),
      hook: q.get('hook'), fbclid: q.get('fbclid'),
      utm_source: q.get('utm_source'), utm_medium: q.get('utm_medium'), utm_campaign: q.get('utm_campaign'),
      utm_content: q.get('utm_content'), utm_term: q.get('utm_term'),
      landingspagina: location.href, fbp: koek('_fbp'), fbc: koek('_fbc')
    };
    knop.disabled = true; m.textContent = '';
    fetch('https://crm.deforexopleiding.nl/api/lab-aanmelding', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (a) {
      if (a.ok) {
        if (window.fbq) fbq('track', 'Lead', {}, { eventID: a.event_id });
        f.innerHTML = '<p><strong>Check je mailbox.</strong> Je link naar The Lab is onderweg.</p>';
      } else { m.textContent = a.fout || 'Er ging iets mis. Probeer het nog eens.'; knop.disabled = false; }
    }).catch(function () { m.textContent = 'Geen verbinding. Probeer het opnieuw.'; knop.disabled = false; });
  });
})();
</script>
```

## Wat er achter het endpoint gebeurt

1. Lead in Leadsonderhoud via `upsert_lead`. **Nieuwe** lead: `bron = traject = 'the-lab'`,
   `soort` = herkomstkanaal (facebook/instagram/…). **Bestaande** lead: herkomst blijft
   staan, alleen contactgegevens worden aangevuld.
2. De touch in `lab_aanmeldingen` (hook, UTM's, fbclid, uitkomst, mail- en WA-status).
3. Trial-account in het LMS (`hlms_lab_lead` + `hlms_rol 'trial'`), 7 dagen toegang
   (`LAB_TOEGANG_DAGEN` in `api/_lib/lab-config.js`).
4. Loginmail vanaf welkom@ met één knop. De link bevat alleen een willekeurige sleutel
   (`/the-lab/start/?s=…`) — nooit een e-mailadres of naam.
5. WhatsApp: alleen met toestemming, via het template dat in Leadsonderhoud → Sjablonen
   staat onder traject `the-lab`, soort `welkom`, kanaal WhatsApp (variabelen
   `voornaam`, `loginlink`). Staat daar (nog) niets goedgekeurd, dan gaat er geen
   WhatsApp en staat er `geen_template` bij de aanmelding.
6. Meta Conversions API: `Lead` — **uit** zolang `META_PIXEL_ID` en `META_CAPI_TOKEN`
   leeg zijn in het CRM.

## Env-variabelen

| Waar | Variabele | Wat |
|---|---|---|
| CRM | `META_PIXEL_ID` | pixel/dataset-id; leeg = CAPI uit |
| CRM | `META_CAPI_TOKEN` | access token voor de Conversions API; leeg = uit |
| CRM | `META_CAPI_TEST_EVENT_CODE` | optioneel, voor de testweergave in Events Manager |
| CRM | `LAB_LANDING_ORIGINS` | extra landingsdomeinen (CORS) |
| LMS | `NEXT_PUBLIC_META_PIXEL_ID` | dezelfde pixel-id voor de browser; leeg = geen pixel |
| LMS | `NEXT_PUBLIC_CRM_URL` | optioneel; standaard `https://crm.deforexopleiding.nl` |
