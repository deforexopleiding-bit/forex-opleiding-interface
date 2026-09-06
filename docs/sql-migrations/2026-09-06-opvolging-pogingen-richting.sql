-- ═══════════════════════════════════════════════════════════════════════════
-- Opvolging · richting op opvolging_pogingen
-- 6 september 2026
--
-- WAAROM DEZE KOLOM BESTAAT
-- Op de kaart van één lead stond '12 van de 2, met 11 keer WhatsApp', terwijl
-- er die dag zes dingen gebeurd waren. Eén van de oorzaken: een antwoord van de
-- lead werd als whatsapp-poging weggeschreven en telde mee in wa_vandaag. Maar
-- die teller gaat over de MOEITE DIE DAVE DOET, en een antwoord van de lead is
-- geen moeite van Dave — dat is het resultaat ervan.
--
-- Een binnenkomend bericht moet wél geregistreerd blijven: het is echt contact
-- en het telt mee voor de archiveerregel. Alleen niet als poging.
--
-- Voor dat onderscheid had de tabel niets. `soort` zit vast in een CHECK, en de
-- richting was alleen af te lezen aan de tekst van `resultaat` — een parser op
-- een zin die iemand ooit anders formuleert. Dan telt de kaart weer iets anders
-- dan wat er gebeurd is. Vandaar een kolom: de betekenis hoort in de data te
-- staan, niet in een woord.
--
-- WAAROM EEN KOLOM EN GEEN UITGEBREIDE CHECK OP `soort`
-- Richting en soort zijn twee onafhankelijke vragen. Een 'whatsapp_in' naast
-- 'whatsapp' zou elke bestaande query op soort stilzwijgend half maken, en bij
-- elke nieuwe soort verdubbelt de lijst. Een aparte kolom laat `soort` met rust.
--
-- Puur additief. Geen bestaande kolom, index, policy of constraint aangeraakt.
-- Idempotent: veilig om opnieuw te draaien.
--
-- ⚠ VOLGORDE: draai deze migratie VÓÓR de opruim-query. Die zet de richting van
-- de rijen die er nu al staan, en heeft deze kolom dus nodig.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1 · De kolom ───────────────────────────────────────────────────────────
-- NOT NULL met default 'uit': dat is de historische aanname en die klopt voor
-- verreweg de meeste bestaande rijen (belpogingen en verstuurde berichten). De
-- inkomende rijen die er nu staan worden in de opruim-query expliciet op 'in'
-- gezet — één keer, met een mens die meekijkt, en niet door code die elke dag
-- opnieuw een zin staat te ontleden.
ALTER TABLE public.opvolging_pogingen
  ADD COLUMN IF NOT EXISTS richting text NOT NULL DEFAULT 'uit';

-- ── 2 · De waarden vastleggen ──────────────────────────────────────────────
ALTER TABLE public.opvolging_pogingen
  DROP CONSTRAINT IF EXISTS opvolging_pogingen_richting_chk;

ALTER TABLE public.opvolging_pogingen
  ADD CONSTRAINT opvolging_pogingen_richting_chk CHECK (richting IN ('uit', 'in'));

-- ── 3 · Index ──────────────────────────────────────────────────────────────
-- De telling per taak filtert hierop, en dat is de query die op elke kaart
-- draait.
CREATE INDEX IF NOT EXISTS opvolging_pogingen_richting_idx
  ON public.opvolging_pogingen (taak_id, richting);

-- ── CONTROLE (los te draaien) ──────────────────────────────────────────────
-- Verwacht: de kolom bestaat, staat op NOT NULL met default 'uit', en de
-- constraint noemt allebei de waarden.
--
-- SELECT column_name, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'opvolging_pogingen' AND column_name = 'richting';
--
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.opvolging_pogingen'::regclass
--   AND conname = 'opvolging_pogingen_richting_chk';

-- ── ROLLBACK (indien nodig) ────────────────────────────────────────────────
-- Werkt altijd; de kolom draagt geen gegevens die elders bewaard worden.
--
-- DROP INDEX IF EXISTS public.opvolging_pogingen_richting_idx;
-- ALTER TABLE public.opvolging_pogingen DROP CONSTRAINT IF EXISTS opvolging_pogingen_richting_chk;
-- ALTER TABLE public.opvolging_pogingen DROP COLUMN IF EXISTS richting;
