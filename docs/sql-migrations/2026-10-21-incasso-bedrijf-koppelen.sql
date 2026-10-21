-- ============================================================================
--  HET BEDRIJF VAN E.R. = DE LMS-STUDENT E.R. (Maxim, 21 oktober 2026) — DATA, op het CRM
-- ============================================================================
--  Eenmalig en herhaalbaar. Hoort bij de LMS-rechtzetting
--  supabase/rechtzetting_incasso_21okt.sql in dfo-lms-prototype (die koppelt
--  de LMS-kant: hlms_student.crm_onboarding_id, het merkteken en de kaarten).
--  Volgorde maakt niet uit; draai ze allebei.
--
--  Namen als initialen (regel van 15 okt in het LMS: geen klantnamen in een repo).
--
--  GEMETEN: de onboarding 49398887-f87e-4686-8451-3923dae0d865 (een bedrijf
--  van E.R.) staat sinds 7 okt in incasso zonder LMS-student. Maxim bevestigde
--  dat het de LMS-student E.R. is (id hieronder): naam en telefoon gelijk, het
--  e-mailadres verschilt tussen CRM en LMS.
--
--  Dit doet precies wat de knop "Koppel aan LMS-student" doet
--  (koppelBestaandeStudent → markeerGekoppeld): dfo_lms_student_id + de
--  provisioning-vlag, zodat er GEEN nieuwe student en GEEN uitnodiging komt.
--  Plus een regel op de tijdlijn. De onboarding blijft in incasso; er gaat
--  NIETS naar de klant. Joost (aanmaningen) loopt gewoon door.

-- ── CONTROLE VÓÓR (alleen lezen) — verwacht: 1 rij, dfo_lms_student_id leeg, in incasso
-- select id, dfo_lms_student_id, incasso_op, incasso_terug_op
--   from public.onboardings where id = '49398887-f87e-4686-8451-3923dae0d865';

do $$
declare
  v_ob constant uuid := '49398887-f87e-4686-8451-3923dae0d865';
  v_student constant uuid := 'ad5228fa-7ec3-429c-a8f5-16c62692f90c';
  v_huidig uuid;
begin
  select dfo_lms_student_id into v_huidig from public.onboardings where id = v_ob;
  if not found then
    raise exception 'onboarding % bestaat niet — niets gewijzigd', v_ob;
  end if;
  if v_huidig is not null and v_huidig <> v_student then
    raise exception 'deze onboarding hangt al aan LMS-student % — niets gewijzigd', v_huidig;
  end if;
  if exists (select 1 from public.onboardings where dfo_lms_student_id = v_student and id <> v_ob) then
    raise exception 'LMS-student % hangt al aan een andere onboarding — niets gewijzigd', v_student;
  end if;
  if v_huidig is null then
    update public.onboardings
       set dfo_lms_student_id = v_student,
           dfo_lms_provisioned = true,
           dfo_lms_provisioned_at = now(),
           dfo_lms_provision_error = null
     where id = v_ob and dfo_lms_student_id is null;
    insert into public.onboarding_mentor_updates (onboarding_id, kind, status, note, created_by)
    values (v_ob, 'note', null,
            'Gekoppeld aan de LMS-student van deze klant (bedrijf = student, bevestigd door Maxim op 21-10-2026; '
            || 'rechtzetting incasso). Blijft in incasso-opvolging.', null);
  end if;
end;
$$;

-- ── CONTROLE NA (alleen lezen) — verwacht: dfo_lms_student_id = ad5228fa…, provisioned true, nog in incasso
select id, dfo_lms_student_id, dfo_lms_provisioned, incasso_op, incasso_terug_op
  from public.onboardings where id = '49398887-f87e-4686-8451-3923dae0d865';
