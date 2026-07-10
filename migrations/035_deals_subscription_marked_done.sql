-- Migratie 035 — deals.subscription_marked_done
--
-- Handmatig vlaggetje voor de "Omzetten naar abonnement"-knop op
-- offerte-detail. Zodra deze op TRUE staat toont de UI "✓ Abbo al
-- ingevoerd" — ook als er (nog) geen row in subscriptions bestaat
-- voor deze deal.
--
-- Doel: eenmalige achterstand aan geaccepteerde offertes waarvan het
-- abonnement via TL-import binnenkwam (ghost-deal, source='tl_import')
-- kunnen afvinken zonder de omzet-knop te doorlopen. Toekomstige
-- offertes blijven default FALSE → knop toont gewoon "Omzetten".
--
-- Idempotent (IF NOT EXISTS). Jeffrey draait handmatig.

alter table public.deals
  add column if not exists subscription_marked_done boolean not null default false;

notify pgrst, 'reload schema';
