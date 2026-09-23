# Agendabrug CRM ↔ LMS (mentoragenda)

Het LMS (dfo-lms) toont in de agenda van elke mentor de **gepubliceerde** events
uit het CRM, en de hoofdmentor/admin kan in die agenda mentoren aan een event
koppelen. Wie op een event staat, staat in `event_mentors` (met `was_present`
en de eventbonus eraan) — dat blijft de **ene waarheid**. Het LMS houdt geen
eigen kopie bij; het leest en schrijft uitsluitend via deze route.

Code: `api/lms-agenda-events.js` (auth + HTTP) en `api/_lib/lms-agenda-brug.js`
(logica). Tests: `tests/lms-agenda-brug.test.js`.

## Toegang

- Route: `https://forex-opleiding-interface.vercel.app/api/lms-agenda-events`
- **Server-naar-server.** Geen CORS: het geheim mag nooit in een browser staan.
  Roep de route aan vanuit een LMS-serverfunctie, niet vanuit de frontend.
- Header `x-dfo-secret: <DFO_LMS_AGENDA_SECRET>` (dezelfde waarde aan beide kanten).
- **Wie mag schrijven beslist het LMS vóór de aanroep** (hoofdmentor/admin). Het
  CRM kent die LMS-rol niet en vertrouwt het geheim: iedereen met het geheim kan
  de bezetting wijzigen. Controleer de rol dus in het LMS, altijd server-side.

| Situatie | Status | `code` |
|---|---|---|
| `DFO_LMS_AGENDA_SECRET` niet gezet in het CRM (weg dicht) | 503 | `niet_geconfigureerd` |
| Geheim ontbreekt of klopt niet | 403 | `machine_toegang_dicht` |
| Andere methode dan GET/POST | 405 | `methode_niet_toegestaan` |
| Onverwachte fout (bv. database onbereikbaar) | 500 | `fout` |

## Antwoordvorm

Altijd, ook bij fouten:

```json
{ "ok": true, "code": "gelezen", "message": "Agenda gelezen.", "data": { } }
```

`Cache-Control: no-store`. `message` is Nederlands en bedoeld voor mensen;
beslis in code op `code`. Bij een fout is `data` `null`.

## GET — agenda lezen

`GET /api/lms-agenda-events?van=<ISO>&tot=<ISO>`

- `van`/`tot` ongeldig, of `tot` ≤ `van` → 400 `ongeldig_venster`
- venster > 200 dagen → 400 `venster_te_groot`
- anders 200 `gelezen`:

```json
{
  "events": [
    {
      "id": "uuid",
      "titel": "Live trading avond",
      "start": "2026-10-05T18:00:00+00:00",
      "eind": null,
      "locatie": "Utrecht",
      "capaciteit": 30,
      "niveau": "beginner",
      "aanmeldingen_dicht": false,
      "crm_pad": "/modules/events-detail.html?id=<uuid>",
      "bezetting": [
        { "team_member_id": "uuid", "naam": "Mo", "email": "mo@…", "was_aanwezig": false }
      ]
    }
  ],
  "mentoren": [
    { "team_member_id": "uuid", "naam": "Mo", "email": "mo@…" }
  ]
}
```

- `events`: alleen `status = 'published'`, `start` in `[van, tot)`, oplopend.
- `bezetting`: de rijen uit `event_mentors`; e-mail is getrimd en lowercase.
- `mentoren`: actieve `team_members` met type `mentor` — de kiezer. Mentoren
  zonder geldig e-mailadres ontbreken (die zijn niet aan het LMS te koppelen).
- **Een lege lijst betekent altijd "er is niets".** Mislukt een bevraging, dan
  krijg je 500 `fout`, nooit een lege lijst.

## POST — bezetting wijzigen

```json
{
  "actie": "toevoegen",
  "event_id": "uuid",
  "mentor_email": "mo@deforexopleiding.nl",
  "door": { "naam": "Hanna", "email": "hanna@…" }
}
```

`actie` is `toevoegen` of `verwijderen`. `door` is optioneel en komt in de
melding aan de mentor ("via de LMS-agenda door Hanna").

De mentor wordt gezocht op e-mail: actieve `team_members` met type `mentor`,
**exacte** vergelijking na trim + lowercase (geen LIKE — `_` is een joker én
een geldig e-mailteken).

| Situatie | Status | `code` |
|---|---|---|
| Ongeldige actie, uuid of e-mailadres | 400 | `ongeldig_verzoek` |
| Event bestaat niet | 404 | `event_onbekend` |
| Event is niet gepubliceerd | 409 | `event_niet_gepubliceerd` |
| Geen actieve mentor met dit e-mailadres | 404 | `mentor_onbekend` |
| Meer dan één actieve mentor met dit adres (niet gokken) | 409 | `mentor_dubbel` |
| **toevoegen** gelukt | 201 | `toegevoegd` |
| **toevoegen**, stond er al | 200 | `stond_er_al` |
| **verwijderen**, stond er niet | 200 | `stond_er_niet` |
| **verwijderen**, maar als aanwezig geregistreerd | 409 | `was_aanwezig_blijft` |
| **verwijderen** gelukt | 200 | `verwijderd` |

- Toevoegen schrijft `event_mentors { event_id, team_member_id, added_by_user_id: null }`
  en stuurt de mentor een CRM-melding (`event.mentor_assigned`). Een mislukte
  melding breekt de koppeling niet.
- Wie als aanwezig geregistreerd is (`was_present = true`), gaat er alleen in het
  CRM af: daar hangt geschiedenis en mogelijk een bonus aan.
- Bij succes bevat `data` `{ event_id, team_member_id }`.
- Toevoegen en verwijderen zijn idempotent: opnieuw sturen is veilig.

## Configuratie

Zet in Vercel (CRM-project, alle environments, **Sensitive**) de env-var
`DFO_LMS_AGENDA_SECRET` en dezelfde waarde aan LMS-kant. Zonder de env-var
antwoordt de route 503 en is de weg dicht.
