-- P17-06 — reactions on an announcement (30 Oct 2026).
--
-- So a reader can say "seen" without a reply, and the poster can see who has
-- read it. The same six reactions as a task comment (P17-03), drawn by the same
-- bar (`components/ui/reactions.tsx`).
--
-- THE SHAPE. One row per (announcement, person, reaction). Pressing the same
-- one again deletes the row; there is no UPDATE grant.
--
-- ⚠️ A FIXED SET, ENFORCED HERE — the same six ids as
-- `vizserve_pms_task_comment_reactions`. `ANNOUNCEMENT_REACTIONS` in
-- `lib/schemas/announcements.ts` mirrors this list; change both or neither.
--
-- ⚠️ `user_name` IS STAMPED BY A TRIGGER, NOT JOINED — the same reason as
-- `author_name` on the announcement itself (P17-04). `vizserve_pms_users` is
-- department-scoped for a member, so "seen by" would come back nameless for
-- anybody outside the reader's department, which is most of the company on a
-- company-wide notice. The trigger overwrites whatever the client sends.
--
-- WHO SEES AND WHO REACTS: every active user, the same rule as reading the
-- announcement. Only a live (not taken down) announcement takes a new reaction.
-- You remove only your own.
--
-- No audit trigger and no notification. A reaction changes nobody's work.
--
-- ⚠️ APPLY BY HAND in the SQL editor, like the other P17 files. The page reads
-- this table in its own query and simply draws no reaction bar until it exists,
-- so deploy and paste can happen in either order.


create table if not exists vizserve_pms_announcement_reactions (
  announcement_id uuid not null references vizserve_pms_announcements (id) on delete cascade,
  user_id         uuid not null references vizserve_pms_users (id) on delete cascade,
  user_name       text not null default '',
  reaction        text not null,
  created_at      timestamptz not null default now(),
  primary key (announcement_id, user_id, reaction),
  constraint vizserve_pms_announcement_reactions_reaction_check
    check (reaction in ('like', 'love', 'celebrate', 'laugh', 'seen', 'done'))
);

comment on table vizserve_pms_announcement_reactions is
  'P17-06. Reactions on an announcement. One row per announcement, person and '
  'reaction; un-reacting deletes it. Readable by every active user.';


-- The reactor's name, from their own row — see the note above.
create or replace function vizserve_pms_announcement_reactions_stamp_name()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  select coalesce(u.full_name, u.email, '')
    into new.user_name
    from vizserve_pms_users u
   where u.id = new.user_id;
  new.user_name := coalesce(new.user_name, '');
  return new;
end;
$$;

drop trigger if exists vizserve_pms_announcement_reactions_stamp_name on vizserve_pms_announcement_reactions;
create trigger vizserve_pms_announcement_reactions_stamp_name
  before insert on vizserve_pms_announcement_reactions
  for each row execute function vizserve_pms_announcement_reactions_stamp_name();


-- Both gates (CLAUDE.md): privileges first, then policies.
alter table vizserve_pms_announcement_reactions enable row level security;
revoke all on vizserve_pms_announcement_reactions from anon;
grant select, delete on vizserve_pms_announcement_reactions to authenticated;
-- Not `user_name` — the trigger writes it.
grant insert (announcement_id, user_id, reaction) on vizserve_pms_announcement_reactions to authenticated;
grant all on vizserve_pms_announcement_reactions to service_role;


drop policy if exists "announcement reactions read by everyone" on vizserve_pms_announcement_reactions;
create policy "announcement reactions read by everyone"
  on vizserve_pms_announcement_reactions for select to authenticated
  using ((select vizserve_pms_current_role()) is not null);

drop policy if exists "announcement reactions added by the reader" on vizserve_pms_announcement_reactions;
create policy "announcement reactions added by the reader"
  on vizserve_pms_announcement_reactions for insert to authenticated
  with check (
    user_id = auth.uid()
    and (select vizserve_pms_current_role()) is not null
    and exists (
      select 1 from vizserve_pms_announcements a
       where a.id = announcement_id and a.archived_at is null
    )
  );

drop policy if exists "announcement reactions removed by their author" on vizserve_pms_announcement_reactions;
create policy "announcement reactions removed by their author"
  on vizserve_pms_announcement_reactions for delete to authenticated
  using (user_id = auth.uid());
