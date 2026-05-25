# Klanten-module — overzicht

Korte team-intro. Volledige specificatie: `docs/specs/01-klanten-module-spec.md`.

## Wat is de Klanten-module?
De centrale klantendatabase en het **kern-fundament** waarop andere modules bouwen:
Sales (Fase 2), Finance (Fase 3), Onboarding/Mentor/Marketing (later). Eén bron van
waarheid voor NAW-gegevens, tags, klant-historie en AVG-afhandeling.

## Architectuurkeuze: WhatsApp = gedeelde laag (Aanpak B)
De WhatsApp-infrastructuur (`whatsapp_numbers` / `whatsapp_templates` /
`whatsapp_messages`) woont **in** de Klanten-module en wordt straks gedeeld gebruikt door
Finance (wanbetalers), Follow-up en Lisa. Berichten dragen `source_module` +
`source_entity_*` zodat herkomst traceerbaar blijft.

## Fase 1 — fundament (afgerond)
- **Migratie 012** (`migrations/012_klanten_module_foundation.sql`): 10 tabellen —
  `customers`, `customer_tag_definitions` (+5 seeds) / `customer_tags`,
  `whatsapp_numbers/templates/messages`, `letter_templates` / `letters`,
  `avg_data_requests`, en een generieke `audit_log`. Inclusief RLS (migratie-003-pattern),
  herbruikbare `public.set_updated_at()`-trigger, en FK-beleid:
  CASCADE (tags), SET NULL (whatsapp_messages), **RESTRICT** (letters + avg_data_requests —
  incasso-/AVG-bewijs, dwingt anonimiseren i.p.v. hard delete).
- **24 RBAC feature-keys** in `modules/admin.html` FEATURE_REGISTRY (groepen Klanten/WhatsApp/Brieven).
- **Placeholder** `modules/klanten.html` + sidebar-entry (gegate op `customer.module.access`).

## Fase 2 — vervolg (open)
Klant-overzicht + klant-detailpagina, CRUD-endpoints, tag-toekenning-UI, TradersLeague
OAuth, duplicate-check, AVG-functionaliteit (export + anonymize), en de WhatsApp send-laag
(Twilio). Zie `TODO-VOLLEDIG.md` → sectie "Klanten-module".

## Belangrijke aandachtspunten
- **RLS = authenticated-read-all** op `customers` (PII): bewust consistent met migratie 003.
  Fijnmazige toegang (eigen vs alle klanten, AVG-acties) wordt in Fase 2 op de **API-laag**
  afgedwongen via `requirePermissionFailOpen` (zie CLAUDE.md → Bekende Beperkingen).
- **Manager-rechten** staan na Fase 1 nog UIT — Jeffrey zet de 24 keys aan in de admin-matrix
  (lockout-safe, geen SQL-seed). super_admin heeft alles via `is_super_admin()`.
