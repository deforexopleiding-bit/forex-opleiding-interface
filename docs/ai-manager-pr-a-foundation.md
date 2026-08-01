# AI Manager — PR-A: Read-only fundament

**Status**: fundament klaar, wachtend op deploy.
**Wat dit levert**: een afgeschermde Postgres-rol + view-set. GEEN AI, GEEN endpoint, GEEN UI. Die komen pas in PR-B/PR-C.

## Waarom dit apart is

Dit is de veiligheidslaag. Voordat we een AI toegang geven tot de database moet **volstrekt duidelijk** zijn dat die AI:
1. Alleen kan lezen (geen INSERT/UPDATE/DELETE/DDL)
2. Alleen bij een expliciet whitelist-schema kan (`ai_readonly`)
3. Geen wachtwoord-hashes, tokens, IBAN, message-bodies of andere gevoelige data kan zien — ook niet als de AI prompt-injection ondergaat en dat probeert

Deze PR levert die 3 garanties op **DB-niveau** (rol-privileges), niet op app-niveau. Dat is de sterkere garantie: zelfs als de code van de AI-endpoint in PR-B/PR-C een bug heeft en per ongeluk verkeerde SQL doorlaat, kan die SQL niet meer dan wat de rol mag.

## Bestanden in deze PR

- `docs/sql-migrations/2026-08-01-ai-readonly-foundation.sql` — de migratie
- `docs/sql-migrations/_verify-ai-readonly.sql` — 8 tests (draai handmatig na deploy)
- `docs/ai-manager-pr-a-foundation.md` — dit bestand

Geen code-wijzigingen. Geen bestaande files geraakt.

## Views (allow-list)

| View | Doel | Kolommen | Bevat namen? | Filters |
|---|---|---|---|---|
| `v_wanbetalers_actief` | Actieve wanbetalers per klant | customer_id, klant_naam, stage_slug, stage_label, stage_changed_at, aantal_open_facturen, totaal_open_bedrag | Ja (voor+achternaam) | Excl. opgeloste/afgeschreven + geanonimiseerde klanten |
| `v_omzet_per_week` | Weekly getekende omzet | week_start, aantal_deals, omzet_excl_btw_totaal, gem_deal_waarde_excl_btw | Nee | Laatste 24 mnd, alleen tl_quotation_accepted_at |
| `v_omzet_per_maand` | Maandelijkse omzet | maand_start, aantal_deals, omzet_excl_btw_totaal | Nee | Laatste 36 mnd |
| `v_leads_per_soort` | Leads aggregatie per soort per dag | soort, dag, aantal | Nee (aggregaat) | Laatste 180 dagen |
| `v_events_upcoming` | Aankomende events + tellingen | event_id, title, starts_at, ends_at, capacity, niveau, location, aantal_vragenlijst_ingevuld, aantal_ingeschreven, aantal_gebeld, plaatsen_over | Nee (aantallen) | Excl. is_test attendees |
| `v_klanten_zonder_mentor` | Indicator klanten zonder mentor | customer_id, klant_naam, klant_sinds, heeft_actief_abonnement | Ja | Excl. geanonimiseerde |
| `v_schema_help` | Meta: welke views bestaan + kolomlijst | view_naam, beschrijving, kolommen | n.v.t. | — |

**Wat is er BEWUST NIET in de views** (uit recon 2026-08-01):
- Email, telefoon, adres, IBAN
- Wachtwoord-hashes, auth-tokens, OAuth-tokens, API-keys
- Message-bodies (WhatsApp, e-mail, Lisa, Joost, meetings)
- Vrije-tekst velden (notes, notitie, omschrijving, description, subject, body)
- BSN-achtige velden, betaal-IDs (Mollie/Stripe/PayPal), mandaten
- Ruwe attendee-lijst per event (aggregaties wel, individuele attendees niet)
- Ruwe leads-inhoud (antwoorden op quiz, notities)

## Deploy-stappen (jouw kant)

### Stap 1 — Migratie draaien in Supabase
1. Open Supabase → Project Settings → SQL Editor → New Query
2. Kopieer de volledige inhoud van `docs/sql-migrations/2026-08-01-ai-readonly-foundation.sql`
3. Druk **Run**
4. Verwacht: `NOTICE: Rol ai_readonly aangemaakt` (of "bestaat al" bij re-run)

### Stap 2 — Wachtwoord instellen voor de rol
Genereer een sterk wachtwoord (bv. `openssl rand -base64 32` of via 1Password) en draai in SQL-editor:
```sql
ALTER ROLE ai_readonly WITH PASSWORD '<jouw-sterke-wachtwoord>';
```
**Bewaar het wachtwoord in 1Password** onder een nieuwe entry `AI_READONLY_DATABASE_URL`.

### Stap 3 — Connectiestring samenstellen
1. Supabase → Project Settings → Database → Connection Pooling
2. Kopieer de **Session-mode pooled connection string** (poort 6543 met pgbouncer)
3. Vervang `postgres.<projectref>` door `ai_readonly` en het wachtwoord door dat uit stap 2
4. Resultaat: `postgres://ai_readonly:<PASSWORD>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`
   (jouw specifieke host kan afwijken — pak wat Supabase je geeft)

### Stap 4 — Env-var in Vercel toevoegen
Vercel → Project → Settings → Environment Variables → Add New:
- **Name**: `AI_READONLY_DATABASE_URL`
- **Value**: connectiestring uit stap 3
- **Environments**: Production + Preview + Development (allemaal aan)
- **Sensitive**: ✅ ja

### Stap 5 — Verificatie draaien
Open `docs/sql-migrations/_verify-ai-readonly.sql` en draai het geheel in de SQL-editor. Verwacht:
- **TEST 1**: rol/schema bestaan, 7 views geteld
- **TEST 2**: 0 verdachte kolommen (email/phone/iban/token/body/etc)
- **TEST 3**: 6× "leest N rijen" zonder error (positieve test)
- **TEST 4**: 3× "geblokkeerd" (INSERT/UPDATE/DELETE — negatieve test)
- **TEST 5**: 4× "geblokkeerd" (auth.users / teamleader_oauth_tokens / customers / whatsapp_messages)
- **TEST 6**: service_role kan alles nog (bewijst dat we bestaande app niet gebroken hebben)
- **TEST 7**: alleen `ai_readonly` schema heeft USAGE, rest = false
- **TEST 8**: sample-rijen per view — visuele controle dat er geen PII in zit

Als één test faalt: STOP. Meld welke, ik pas de migratie aan vóór PR-B.

## Wat er NIET in deze PR zit (en waarom)

| Component | Reden om te wachten |
|---|---|
| `ai_readonly_query()` RPC | Niet nodig — user koos aparte connectiestring (route A). RPC is optioneel voor PR-B als we alsnog voor route B willen gaan. |
| AI-endpoint (`api/super-admin-ai-manager.js`) | Bouwt eerste in PR-B, ná bewezen fundament |
| Query-guard (`_lib/ai-query-guard.js`) | Idem PR-B |
| UI-koppeling (input+antwoord in dashboard) | PR-C, ná werkend endpoint |
| RBAC-key `super-admin.ai.use` | PR-B (samen met endpoint) |

## Wat kan er nu misgaan (en waarom is dat OK)

- **Verkeerd wachtwoord** → connectiestring werkt niet, maar dat blokkeert alleen PR-B/PR-C (die er nog niet zijn). Bestaande app draait door.
- **Rol heeft ergens meer rechten dan bedoeld** → TEST 5 vangt dat op. Rollback = `DROP ROLE ai_readonly; DROP SCHEMA ai_readonly CASCADE;` (of PR reverten).
- **View toont per ongeluk een PII-kolom** → TEST 2 vangt dat automatisch op (naam-pattern grep).
- **View is te breed** (bv. `v_klanten_zonder_mentor` returnt te veel omdat mentor-koppeling ander schema is) → false positive in de output, niet gevaarlijk. Aanpassing in follow-up PR.

## Rollback

```sql
DROP SCHEMA ai_readonly CASCADE;
DROP ROLE ai_readonly;
-- (rollen kunnen niet gedropt worden als ze objecten bezitten — DROP SCHEMA CASCADE dropt eerst de views)
```

Bestaande tabellen, rollen, RLS-policies zijn niet aangeraakt — 100% reversibel.

## Beslissingen die nog open staan voor PR-B

- **Retry-strategie** bij guard-reject: 1x met reason, of hard fail
- **Rate-limit**: 10 calls/uur per super_admin (default aanbevolen)
- **Cost-cap**: 500k tokens/dag per user, hard-stop
- **Query-guard implementatie**: `node-sql-parser` als hoofdlaag + RegExp als tripwire

Deze staan in het PR-A oorspronkelijke bouwplan. Beslis in PR-B, niet nu.
