# Bekende gaten — aanmaanmotor en inbox

Drie dingen die we tijdens het repareren van de no-reply-cyclus (PR #1568) en
het gelezen-probleem (PR #1579) hebben gevonden, **maar bewust niet gebouwd**.
Ze zijn allemaal met de code in de hand vastgesteld, niet vermoed. Opgeschreven
zodat de volgende die hier komt ze niet opnieuw hoeft te vinden.

Stand: 11 september 2026.

---

## 1. Een gesprek ontkoppelen laat de aanmaanladder eeuwig bevroren achter

**Waar:** `api/inbox-unlink-conversation-from-customer.js` (zet
`whatsapp_conversations.customer_id = null`) en
`api/inbox-link-conversation-to-customer.js:155` (zet hem op een andere klant).
Een grep op `dunning`, `paused_by_conversation_id` en `unpauseRuns` over beide
bestanden geeft **nul treffers**.

**Wat er gebeurt.** Reageert een klant, dan pauzeert zijn aanmaan-run met
`paused_by_conversation_id` naar dat gesprek (`api/inbox-webhook.js:1682`).
Ontkoppelt iemand daarna dat gesprek in de inbox, dan bestaat het gesprek nog
steeds — dus de `ON DELETE SET NULL` op de kolom doet niets — maar het hoort
niet meer bij die klant. De run blijft gepauzeerd met een pointer naar een
gesprek dat niet meer van hem is, en in zijn tijdlijn staat geen enkel
WhatsApp-bericht. Er is geen opruimpad: `_lib/conv-less-resume.js` pakt alleen
pauzes **zonder** conversation-id.

**Waarom dit geld kost.** Zo'n run staat stil terwijl de facturen doorlopen.
Gemeten op 10 sep 2026: drie runs stonden gespreksgepauzeerd zonder enig
WhatsApp-bericht bij de klant — 44, 64 en 70 dagen te laat, al twee maanden
bevroren.

**Wat er wél is gebeurd.** PR #1568 maakt de no-reply-cyclus fail-closed bij een
ontbrekende inbound (`geen_gesprek` in `_lib/conv-reminder-stage.js`), dus zo'n
run krijgt geen herinneringen meer en valt op in de cron-log. Maar de ladder
komt er niet vanzelf weer uit.

**Wat de reparatie zou zijn.** Beide endpoints de gespreks-pauze laten opheffen
voor de vorige klant (`unpauseRunsForConversation`, of alleen
`paused_by_conversation_id` leegmaken zodat de engine de run weer oppakt).

**Om te vinden welke runs dit zijn:** `audit_log` op actie
`whatsapp.customer_unlinked` of `whatsapp.customer_linked`, met de
conversation-id in `after_json`.

---

## 2. Geen unique index op `dunning_workflow_runs` — de race blijft mogelijk

**Waar:** de guard tegen dubbele runs staat op twee plekken en is een
lees-dan-schrijf zonder databasegrendel:
`api/_lib/dunning-engine.js:966-974` (`.eq('customer_id', …)
.in('status', ['active','paused'])`, bij een treffer `continue`) en
`api/wanbetalers-bulk-start-workflow.js:230-245` (zelfde guard, skip-redenen
`already_active_run` / `already_paused_run`).

Een grep over alle migraties in `docs/sql-migrations/` geeft **geen enkele**
unique index op `dunning_workflow_runs`.

**Wat er kan gebeuren.** Twee gelijktijdige aanroepen — de cron en een
handmatige bulk-start, of twee overlappende tikken — lezen allebei "geen run"
en inserten allebei. Dat dit vóórkomt is geen theorie: `dedupRunsByConversation`
in `api/cron-dunning-conversation-reminders.js` bestaat er expliciet voor (met
in het commentaar het geval Benny Veys, twee runs op dezelfde conversatie), en
`_lib/conv-less-resume.js:250-260` sluit dubbele siblings af met
`completion_reason = 'superseded_duplicate'`.

**Let op bij het meten.** "Twee runs in de laatste dertig dagen" is iets anders
dan twee gelijktijdige runs: een afgeronde run plus een nieuwe geeft ook twee
id's, en dat is normaal. Deze query scheidt de twee:

```sql
select r.customer_id,
       count(*) filter (where r.status in ('active','paused')) as lopend,
       count(*)                                                as totaal_30d
  from dunning_workflow_runs r
 where r.updated_at > now() - interval '30 days'
 group by r.customer_id having count(*) > 1
 order by lopend desc;
```

Staat `lopend` overal op 1, dan is er niets aan de hand. Staat er ergens 2, dan
is de race echt.

**Wat de reparatie zou zijn.** Een partial unique index:

```sql
create unique index concurrently if not exists uq_dunning_run_lopend_per_klant
  on public.dunning_workflow_runs (customer_id)
  where status in ('active', 'paused');
```

Draai 'm pas als de query hierboven schoon is — bestaande dubbelen laten de
index falen. En let op de bestaande afspraak: een partial unique index kan geen
`ON CONFLICT`-arbiter zijn (zie Lessons Learned in `CLAUDE.md`), dus de code
moet de 23505 opvangen in plaats van er een upsert van te maken.

---

## 3. Ongelezen markeren kan niet voor e-mail, en dat is geen bug

**Waar:** `api/inbox-mark-unread.js:66-73` zet `whatsapp_conversations.unread_count`
op `max(1, huidige)` — alleen WhatsApp. De e-mailteller in de lijst komt uit de
`\Seen`-vlag op IMAP (`api/inbox-conversations-list.js:296`,
`total_unread = unread_count + email_unread_count` op regel 404).

**Waarom het niet kan.** Wij zetten die vlag niet; de mailclient doet dat.
`api/email-actions.js:22` kent alleen `mark-read` en geen `mark-unread`, en
`api/inbox-email-mark-read.js` gaat maar één kant op. Een gesprek weer op
ongelezen zetten is daarom een WhatsApp-signaal, niet meer.

**Wat er wél is gebeurd.** PR #1579 maakt dat eerlijk: de optimistische update
laat de e-mailteller staan in plaats van hem op 1 te zetten en hem daarna door
de eerstvolgende verversing terug te laten springen naar de echte waarde. De
bevestiging zegt het er ook bij zodra er ongelezen mails zijn.

**Wat een echte oplossing zou vragen.** Een eigen "todo"-vlag op de conversatie
die los staat van IMAP, met een eigen kolom en een eigen plek in de
badge-berekening. Dat is een ontwerpkeuze, geen reparatie — nu is de badge per
definitie wat de mailbox zegt.
