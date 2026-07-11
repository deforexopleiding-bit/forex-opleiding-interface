-- 2026-07-11 · Crediteerronde PR-2
-- Registratie van gecrediteerde schuld tijdens de kwartaal-crediteerronde.
-- Eén rij per gecrediteerde factuur (dus N rijen als een klant N facturen
-- laat crediteren in dezelfde ronde). Snapshot: bedragen op moment van
-- crediteren; latere factuur-updates raken deze tabel niet.
--
-- customer_id + invoice_id + created_at samen leveren voldoende histoire
-- voor kwartaal-audit ("welke schuld is in Q3 gecrediteerd?"). Geen unique
-- constraint op invoice_id — een factuur kán meerdere keren in aparte
-- credit-rondes voorkomen als er tussentijds een nieuwe openstaande stand
-- is (edge case, maar niet uit te sluiten).

CREATE TABLE IF NOT EXISTS dunning_credited_debt (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL,
  invoice_id        uuid,
  tl_credit_note_id text,
  amount_incl       numeric,        -- bedrag incl. BTW (open bedrag op moment van crediteren)
  vat_amount        numeric,        -- BTW-bedrag van de factuur
  credited_on       date NOT NULL DEFAULT CURRENT_DATE,
  quarter           text,           -- 'YYYY-Qn' berekend uit credited_on (best-effort door caller)
  subscription_id   uuid,           -- welk abo verlengd is (NULL als er geen abo gekozen was)
  months_extended   int NOT NULL DEFAULT 0,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dunning_credited_debt_customer_id
  ON dunning_credited_debt(customer_id);

CREATE INDEX IF NOT EXISTS idx_dunning_credited_debt_credited_on
  ON dunning_credited_debt(credited_on DESC);

-- RLS: tabel is administratief; alleen server-side inserts via
-- service-role. Client-side reads gebeuren via geauthoriseerde endpoints
-- die zelf de RLS-bypass regelen (supabaseAdmin). Enable RLS zonder
-- policies zodat niemand direct via anon/authenticated kan lezen.
ALTER TABLE dunning_credited_debt ENABLE ROW LEVEL SECURITY;
