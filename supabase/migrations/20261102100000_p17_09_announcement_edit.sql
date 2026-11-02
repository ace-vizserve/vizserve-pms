-- P17-09 — edit an announcement after posting it (2 Nov 2026).
--
-- REVERSES a line in P17-04, which granted only the archive columns so that
-- nobody would read a changed text under the original time. The user asked for
-- an edit button, so that concern is met another way: a changed notice says
-- "edited", and the trigger sets that, so it cannot be left off or backdated.
--
-- WHO EDITS: the same people who take one down — its author while still a lead,
-- or a Manager and above. `canEditAnnouncement` in `lib/auth/rules.ts` mirrors
-- this. The notice goes out under its author's name, so when somebody else
-- changes it the line says who: "edited by <name>".
--
-- ⚠️ `edited_by_name` IS STAMPED, NOT JOINED, for the reason `author_name` is:
-- `vizserve_pms_users` is department-scoped for a member, so a join would give
-- them a null editor. That is also why the trigger is SECURITY DEFINER.
--
-- ⚠️ GRANTING THESE COLUMNS WOULD ALSO OPEN THEM TO THE TAKE-DOWN POLICY, whose
-- WITH CHECK looks only at the archive columns. Without the guard in the trigger
-- a Manager could rewrite somebody's notice in the same UPDATE that archives it,
-- and the archived row is the record of what was said.
--
-- ⚠️ APPLY BY HAND in the SQL editor, like the other P17 files. Safe to paste
-- twice. Until it is pasted the home page still reads (see `loadAnnouncements`),
-- and saving an edit is refused.


alter table vizserve_pms_announcements
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by uuid references vizserve_pms_users (id),
  add column if not exists edited_by_name text;

comment on column vizserve_pms_announcements.edited_at is
  'P17-09. Last change to the title, message or last day. Set by a trigger; not granted to anyone.';


create or replace function vizserve_pms_announcements_stamp_edit()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.title is distinct from old.title
     or new.body is distinct from old.body
     or new.expires_on is distinct from old.expires_on then
    if new.archived_at is not null then
      raise exception 'An announcement that is down cannot be edited.';
    end if;
    new.edited_at := now();
    new.edited_by := auth.uid();
    select coalesce(u.full_name, u.email, '')
      into new.edited_by_name
      from vizserve_pms_users u
     where u.id = new.edited_by;
  end if;
  return new;
end;
$$;

drop trigger if exists vizserve_pms_announcements_stamp_edit on vizserve_pms_announcements;
create trigger vizserve_pms_announcements_stamp_edit
  before update on vizserve_pms_announcements
  for each row execute function vizserve_pms_announcements_stamp_edit();


-- Both gates (CLAUDE.md): privileges first, then policies. The `edited_*` columns
-- stay out of the grant; the trigger writes them.
grant update (title, body, expires_on) on vizserve_pms_announcements to authenticated;

-- Permissive policies OR together, so the take-down policy stays as it was and
-- this one adds the second legal shape: still live, and yours or you are a Manager.
drop policy if exists "announcements edited by author" on vizserve_pms_announcements;
drop policy if exists "announcements edited by author or manager" on vizserve_pms_announcements;
create policy "announcements edited by author or manager"
  on vizserve_pms_announcements for update to authenticated
  using (
    archived_at is null
    and (
      (created_by = auth.uid() and (select vizserve_pms_has_role('team_leader')))
      or (select vizserve_pms_has_role('manager'))
    )
  )
  with check (
    archived_at is null
    and (
      (created_by = auth.uid() and (select vizserve_pms_has_role('team_leader')))
      or (select vizserve_pms_has_role('manager'))
    )
  );
