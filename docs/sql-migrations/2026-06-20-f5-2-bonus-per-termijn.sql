-- Migration: parent_entry_id op mentor_ledger_entries.
-- F5.2 PR-3 — per termijn vrijgeven (forward-only, no clawback):
-- 1 bonus-obligatie (parent) wordt incrementeel verlaagd; per klantbetaling
-- wordt een nieuwe 'vrijgegeven' child-entry gespawnd die naar de parent
-- wijst via parent_entry_id. Payout-run blijft ongewijzigd want children
-- zijn normale 'vrijgegeven' bonus-entries.

BEGIN;

ALTER TABLE public.mentor_ledger_entries
  ADD COLUMN IF NOT EXISTS parent_entry_id uuid
    REFERENCES public.mentor_ledger_entries(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.mentor_ledger_entries.parent_entry_id IS
  'F5.2: bij per-termijn vrijgave wijst een child-entry (status=vrijgegeven) naar de oorspronkelijke obligatie-rij. Parent.amount wordt evenredig verlaagd; sum(child.amount) per parent <= parent.original_amount. ON DELETE SET NULL zodat verwijderen van een parent de child-geschiedenis niet kapotmaakt.';

CREATE INDEX IF NOT EXISTS idx_mentor_ledger_entries_parent
  ON public.mentor_ledger_entries (parent_entry_id)
  WHERE parent_entry_id IS NOT NULL;

COMMIT;
