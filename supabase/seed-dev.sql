-- Dev bootstrap — paste into the Supabase SQL editor.
--
-- Use this when you do not want to hand the service-role key to a script.
-- The scripted equivalent is `npm run seed`, which seeds the full P0-12
-- account set instead of just one admin.
--
-- STEP 1 (dashboard, not SQL):
--   Authentication > Users > Add user
--     Email:    test.admin@example.com
--     Password: VizServe2026!dev
--     [x] Auto Confirm User
--
--   That insert fires the trigger which creates the vizserve_pms_users row with
--   role 'member'. This file promotes it.
--
-- STEP 2: run everything below.

-- --- promote to admin -------------------------------------------------------
-- Admin with an empty managed-departments set = sees everything without being
-- anyone's Team Leader. That is the intended shape for a build account (D15).
update vizserve_pms_users
   set role = 'admin',
       full_name = 'Test Admin',
       is_active = true
 where email = 'test.admin@example.com';

-- The role trigger mirrors this into auth.users.raw_user_meta_data for display
-- and routing. Nothing in the authorization path reads it (D18) — this is just
-- so the shell renders the right nav.

-- --- a public form to look at ----------------------------------------------
-- DEV FIXTURE, not the P1-16 deliverable. P1-16 requires a form built *through
-- the builder* end to end (build -> publish -> submit -> land in a TL queue);
-- this exists so /request/collateral-request renders before the builder is finished.
insert into vizserve_pms_forms
  (id, name, slug, description, department_id, reference_prefix,
   is_public, is_active, requires_attachment, sla_minutes)
values (
  'b1000000-0000-4000-8000-000000000001',
  'Collateral Request',
  'collateral-request',
  'Request design collateral from the VizServe team. Complete every required field — we cannot start work on a partial request.',
  'a1000000-0000-4000-8000-000000000004',  -- VizMedia
  'COL',
  true,
  true,
  false,   -- flip to true once attachment upload (P1-09) is wired
  2400     -- P7-31: minutes, 1d = 480. Five working days.
)
on conflict (id) do update
  set is_active = excluded.is_active,
      department_id = excluded.department_id;

insert into vizserve_pms_form_fields
  (form_id, label, field_key, field_type, help_text, options, is_required, sort_order)
values
  ('b1000000-0000-4000-8000-000000000001', 'Requesting school or department', 'requesting_unit', 'select', '',
   '["HFSE Marketing","HFSE Admissions","HFSE Academics","HFSE Operations"]'::jsonb, true, 10),

  ('b1000000-0000-4000-8000-000000000001', 'Collateral type', 'collateral_type', 'select', '',
   '["Poster","Banner","Social media set","Brochure","Video"]'::jsonb, true, 20),

  ('b1000000-0000-4000-8000-000000000001', 'Sizes / formats needed', 'formats', 'multiselect', 'Pick every format you need.',
   '["A3 print","A4 print","Instagram square","Instagram story","Facebook cover","Email header"]'::jsonb, true, 30),

  ('b1000000-0000-4000-8000-000000000001', 'Specifications', 'specs', 'textarea',
   'Dimensions, copy, brand constraints, anything the designer must not guess.', '[]'::jsonb, true, 40),

  ('b1000000-0000-4000-8000-000000000001', 'Approved by (client-side)', 'client_approver', 'text',
   'Who on your side has already signed this off? We start once your internal approval is done.',
   '[]'::jsonb, true, 50),

  ('b1000000-0000-4000-8000-000000000001', 'Reference link', 'reference_link', 'text',
   'Optional: a link to brand assets or an example.', '[]'::jsonb, false, 60)
on conflict (form_id, field_key) do nothing;

-- --- check ------------------------------------------------------------------
select u.email, u.role, u.is_active from vizserve_pms_users u where u.email like 'test.%';
select f.slug, f.is_public, f.is_active, count(ff.id) as fields
  from vizserve_pms_forms f
  left join vizserve_pms_form_fields ff on ff.form_id = f.id
 group by f.id;
