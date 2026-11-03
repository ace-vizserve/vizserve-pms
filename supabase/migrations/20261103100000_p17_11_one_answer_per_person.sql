-- P17-11 — one answer per person on every internal form, anonymous ones included
-- (3 Nov 2026).
--
-- REVERSES a decision in `app/(app)/respond/actions.ts` (P7-66), which allowed
-- repeat answers on purpose. The user decided this: kudos and sign-up forms, and
-- answering again to correct a mistake, no longer work. A form reused for a new
-- round has to be a new form.
--
-- ⚠️ THIS CHANGES WHAT "ANONYMOUS" MEANS, AND THE SCREENS NOW SAY SO. An anonymous
-- form cannot refuse a second answer without knowing who gave the first. So the
-- system now keeps a note that a person answered, in a table of its own:
--   - The answer row still has no name. Screens and exports cannot link the two.
--   - The note has no timestamp and no reference to the answer.
--   - Nobody signed in can read it. No grant, no policy, only the functions below.
-- But it is written in the same transaction as the answer, so somebody with direct
-- SQL access could line the two up through Postgres's own row metadata (`xmin`).
-- That is why the page no longer claims "nothing that identifies you" without the
-- second sentence, and why the two must not be joined by any screen or report.
--
-- A TRIGGER, NOT A CHECK IN THE SERVER ACTION: `authenticated` holds INSERT on
-- `vizserve_pms_form_responses`, so the action can be bypassed. The trigger runs
-- for every insert, and the note and the answer commit together or not at all.
--
-- ⚠️ ANSWERS ALREADY GIVEN ON AN ANONYMOUS FORM CANNOT BE BACKFILLED: nothing says
-- who wrote them, so each of those people can answer that form once more. Named
-- forms are backfilled. Duplicates already stored on a named form stay as they are.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after 20261103090100. Never `db:push`. Safe
-- to paste twice.


create table if not exists vizserve_pms_form_answered (
  form_id uuid not null references vizserve_pms_forms (id) on delete cascade,
  user_id uuid not null references vizserve_pms_users (id) on delete cascade,
  primary key (form_id, user_id)
);

comment on table vizserve_pms_form_answered is
  'P17-11. Who has answered which internal form, kept apart from the answers so an '
  'anonymous answer carries no name. Deliberately no timestamp and no response id. '
  'Never join this to vizserve_pms_form_responses.';

-- Both gates (CLAUDE.md). `authenticated` gets no privilege and no policy at all.
alter table vizserve_pms_form_answered enable row level security;
revoke all on vizserve_pms_form_answered from anon, authenticated;
grant all privileges on vizserve_pms_form_answered to service_role;

insert into vizserve_pms_form_answered (form_id, user_id)
select distinct r.form_id, r.submitted_by
  from vizserve_pms_form_responses r
 where r.submitted_by is not null
on conflict do nothing;


create or replace function vizserve_pms_form_responses_one_per_person()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  -- No session means the service role: a script or a test, not a person answering.
  if auth.uid() is null then
    return new;
  end if;

  insert into vizserve_pms_form_answered (form_id, user_id)
  values (new.form_id, auth.uid())
  on conflict do nothing;

  if not found then
    raise exception 'You have already answered this form.';
  end if;

  return new;
end;
$$;

drop trigger if exists vizserve_pms_form_responses_one_per_person on vizserve_pms_form_responses;
create trigger vizserve_pms_form_responses_one_per_person
  before insert on vizserve_pms_form_responses
  for each row execute function vizserve_pms_form_responses_one_per_person();


-- The fill page asks this before drawing the questions. Only ever about the caller.
create or replace function vizserve_pms_i_answered_form(p_form_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_form_answered a
     where a.form_id = p_form_id
       and a.user_id = auth.uid()
  )
$$;

revoke all on function vizserve_pms_i_answered_form(uuid) from public, anon;
grant execute on function vizserve_pms_i_answered_form(uuid) to authenticated;


-- 20261103090100's function. The server can now answer for every form, so the
-- anonymous flag is gone from what it returns.
create or replace function vizserve_pms_forms_awaiting_me()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', f.id)
      order by f.closes_on nulls last, f.name
    ),
    '[]'::jsonb
  )
  from vizserve_pms_forms f
  where f.purpose = 'INTERNAL'
    and f.is_active
    and (f.closes_on is null or f.closes_on >= (now() at time zone 'Asia/Manila')::date)
    and vizserve_pms_current_role() is not null
    and vizserve_pms_form_targets_me(f.id)
    and vizserve_pms_form_has_questions(f.id)
    and not exists (
      select 1
        from vizserve_pms_form_answered a
       where a.form_id = f.id
         and a.user_id = auth.uid()
    )
$$;

revoke all on function vizserve_pms_forms_awaiting_me() from public, anon;
grant execute on function vizserve_pms_forms_awaiting_me() to authenticated;


-- 20261103090100's function. Whoever has answered is left out on every form now,
-- so an anonymous form no longer reminds everybody or needs to explain why.
create or replace function vizserve_pms_send_form_reminders()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_today     date := (now() at time zone 'Asia/Manila')::date;
  v_form      record;
  v_days      integer;
  v_stage     smallint;
  v_when      text;
  v_people    jsonb;
  v_announced integer := 0;
  v_reminded  integer := 0;
begin
  -- Nobody wants a survey reminder at three in the morning. Whatever is owed is
  -- still owed at the next run inside these hours.
  if extract(hour from now() at time zone 'Asia/Manila') not between 8 and 18 then
    return jsonb_build_object('skipped', 'outside working hours');
  end if;

  for v_form in
    select f.*
      from vizserve_pms_forms f
     where f.purpose = 'INTERNAL'
       and f.is_active
       and (f.closes_on is null or f.closes_on >= v_today)
       and (f.announced_at is null or f.closes_on is not null)
       and vizserve_pms_form_has_questions(f.id)
       for update of f skip locked
  loop
    v_days := v_form.closes_on - v_today;
    v_stage := case
      when v_days is null then 0
      when v_days <= 1 then 2
      when v_days <= 3 then 1
      else 0
    end;

    -- Announced already, and this stage's reminder has gone. The usual case.
    if v_form.announced_at is not null and v_stage <= v_form.reminders_sent then
      continue;
    end if;

    v_when := case
      when v_days = 0 then 'today'
      when v_days = 1 then 'tomorrow'
      else 'on ' || to_char(v_form.closes_on, 'FMDD Mon YYYY')
    end;

    -- `form_targets_me` asks about the caller; a cron has no caller, so the same
    -- rule is stated for everybody.
    select coalesce(jsonb_agg(u.id), '[]'::jsonb)
      into v_people
      from vizserve_pms_users u
     where u.is_active
       and (
         v_form.audience_is_all_departments
         or exists (
           select 1
             from vizserve_pms_form_audience_departments a
            where a.form_id = v_form.id
              and a.department_id = u.primary_department_id
         )
       )
       and not exists (
         select 1
           from vizserve_pms_form_answered d
          where d.form_id = v_form.id
            and d.user_id = u.id
       );

    if v_form.announced_at is null then
      perform vizserve_pms_emit(
        'form.published',
        jsonb_build_object('form_audience', v_people),
        'New internal survey: ' || v_form.name,
        'We have an internal survey for you to answer: ' || v_form.name || '.'
          || case
               when v_days is null then ''
               else ' It closes ' || v_when || '.'
             end,
        'form', v_form.id, '/respond/' || v_form.slug
      );
      v_announced := v_announced + 1;

      -- The announcement already states the deadline, so a form published close
      -- to it does not get a second email an hour later.
      update vizserve_pms_forms
         set announced_at = now(),
             reminders_sent = greatest(reminders_sent, v_stage)
       where id = v_form.id;
    else
      perform vizserve_pms_emit(
        'form.reminder',
        jsonb_build_object('form_audience', v_people),
        'Reminder: ' || v_form.name || ' closes ' || v_when,
        'We still need your answer to the internal survey ' || v_form.name || '. '
          || 'It closes ' || v_when || '.',
        'form', v_form.id, '/respond/' || v_form.slug
      );
      v_reminded := v_reminded + 1;

      update vizserve_pms_forms
         set reminders_sent = v_stage
       where id = v_form.id;
    end if;
  end loop;

  return jsonb_build_object('announced', v_announced, 'reminded', v_reminded);
end;
$$;

revoke all on function vizserve_pms_send_form_reminders() from public, anon, authenticated;
grant execute on function vizserve_pms_send_form_reminders() to service_role;
