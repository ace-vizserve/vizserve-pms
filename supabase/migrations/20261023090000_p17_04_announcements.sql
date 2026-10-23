-- P17-04 — announcements on the home page (23 Oct 2026).
--
-- A Team Leader or anyone above posts a notice; everybody sees it on `/`, the
-- page they land on after signing in. Company-wide, no department targeting.
--
-- WHO POSTS: Team Leader and above, by the LADDER (`has_role('team_leader')`),
-- not by equality. Posting is not approving, so the P14-04 rule that Admin,
-- Business Manager and CEO approve nothing does not apply — the user asked for
-- "managers and TL and higher". `canPostAnnouncements` in `lib/auth/rules.ts`
-- mirrors this.
--
-- WHO TAKES ONE DOWN: its author, or a Manager and above. Taking down is a soft
-- archive (`archived_at`), never a DELETE — there is no DELETE grant, so the row
-- stays as the record of what was said.
--
-- ⚠️ `author_name` IS STAMPED BY A TRIGGER, NOT JOINED. `vizserve_pms_users` is
-- department-scoped for a member, so a member reading a notice posted by a lead
-- of another department would get a null author through a join. The trigger
-- copies the name from the poster's own row at insert time; the client cannot
-- supply it (the trigger overwrites whatever is sent).
--
-- ⚠️ APPLY BY HAND in the SQL editor, like the other P17 files. The home page
-- reads this table in its own query and draws no announcements cell until it
-- exists, so deploy and paste can happen in either order.


create table if not exists vizserve_pms_announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  -- Last day it shows, inclusive. Null means it stays until taken down.
  expires_on  date,
  created_by  uuid not null references vizserve_pms_users (id),
  author_name text not null default '',
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references vizserve_pms_users (id),
  constraint vizserve_pms_announcements_title_check
    check (char_length(btrim(title)) between 1 and 120),
  constraint vizserve_pms_announcements_body_check
    check (char_length(btrim(body)) between 1 and 2000)
);

create index if not exists vizserve_pms_announcements_live_idx
  on vizserve_pms_announcements (created_at desc)
  where archived_at is null;

comment on table vizserve_pms_announcements is
  'P17-04. Notices shown on the home page. Posted by Team Leader and above; '
  'read by every active user; archived, never deleted.';


-- The author's name, from their own row — see the note above.
create or replace function vizserve_pms_announcements_stamp_author()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  select coalesce(u.full_name, u.email, '')
    into new.author_name
    from vizserve_pms_users u
   where u.id = new.created_by;
  new.author_name := coalesce(new.author_name, '');
  return new;
end;
$$;

drop trigger if exists vizserve_pms_announcements_stamp_author on vizserve_pms_announcements;
create trigger vizserve_pms_announcements_stamp_author
  before insert on vizserve_pms_announcements
  for each row execute function vizserve_pms_announcements_stamp_author();


-- Both gates (CLAUDE.md): privileges first, then policies.
alter table vizserve_pms_announcements enable row level security;
revoke all on vizserve_pms_announcements from anon;
grant select on vizserve_pms_announcements to authenticated;
grant insert (title, body, expires_on, created_by) on vizserve_pms_announcements to authenticated;
-- Only the archive columns move after posting. A notice is not edited in place:
-- take it down and post a corrected one, so nobody reads a changed text under
-- the original time.
grant update (archived_at, archived_by) on vizserve_pms_announcements to authenticated;
grant all on vizserve_pms_announcements to service_role;


-- Every active user with access to this app. `current_role()` is null for a
-- deactivated or access-revoked account, which closes this with everything else.
drop policy if exists "announcements read by everyone" on vizserve_pms_announcements;
create policy "announcements read by everyone"
  on vizserve_pms_announcements for select to authenticated
  using ((select vizserve_pms_current_role()) is not null);

drop policy if exists "announcements posted by leads and above" on vizserve_pms_announcements;
create policy "announcements posted by leads and above"
  on vizserve_pms_announcements for insert to authenticated
  with check (
    created_by = auth.uid()
    and (select vizserve_pms_has_role('team_leader'))
    and archived_at is null
  );

drop policy if exists "announcements taken down by author or manager" on vizserve_pms_announcements;
create policy "announcements taken down by author or manager"
  on vizserve_pms_announcements for update to authenticated
  using (
    archived_at is null
    and (
      (created_by = auth.uid() and (select vizserve_pms_has_role('team_leader')))
      or (select vizserve_pms_has_role('manager'))
    )
  )
  with check (archived_by = auth.uid() and archived_at is not null);
