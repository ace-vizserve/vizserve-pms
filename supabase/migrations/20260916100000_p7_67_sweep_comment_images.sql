-- P7-67 — collecting the pictures nobody sent.
--
-- THE HOLE THIS CLOSES. An image pasted into a comment is committed the moment
-- it is pasted: there is no receipt handshake on a staff upload, and the
-- alternative is a comment box that cannot show you the picture until you press
-- Send. So paste a screenshot, change your mind, close the tab — and the bytes
-- and the row outlive the intention. Nothing referenced them and nothing ever
-- will.
--
-- `sweepCommentImages` in `lib/comment-images-server.ts` already handles the
-- other half: an image REMOVED from a comment that was saved. It cannot handle
-- this one, and deliberately — it is driven by the old body of a comment being
-- edited, and a draft has no body to compare against. A scan-everything version
-- would have deleted images out of drafts people were still typing into.
--
-- Which is what the age is for. Twenty-four hours is not a guess about storage
-- cost; it is the answer to "how long might somebody leave a comment half
-- written". Long enough to cover going home for the day, short enough that a
-- bot pasting all night is gone by morning. The same interval, for the same
-- reason, as `vizserve_pms_expire_pending_attachments` next door.
--
-- ⚠️ `kind = 'comment'` AND NOTHING ELSE. An `output` or a `reference` is
-- reachable through the Files panel whether or not any prose mentions it, so
-- "unreferenced" is not a defect there — it is the normal state of a file
-- somebody attached. Only a comment image is defined by the body that points at
-- it. Getting this wrong deletes the ClickUp import's 458 filed attachments.
--
-- ⚠️ AND IT MATCHES THE BODY THE SAME WAY THE SWEEP DOES. The id appears in a
-- body as `/api/task-images/<uuid>`; `like '%' || id || '%'` is looser than that
-- and deliberately so — a false MATCH keeps a file that could have gone, a
-- missed one deletes a picture somebody can still see. Loose in the safe
-- direction.

create or replace function vizserve_pms_expire_comment_images(
  p_older_than interval default interval '24 hours'
)
returns table (storage_path text)
language sql
security definer
set search_path = public, extensions
as $$
  delete from vizserve_pms_task_attachments a
   where a.kind = 'comment'
     and a.created_at < now() - p_older_than
     and not exists (
       select 1
         from vizserve_pms_task_comments c
        where c.task_id = a.task_id
          and c.body like '%' || a.id::text || '%'
     )
  returning a.storage_path
$$;

-- The cron route calls it with the service role, which bypasses policies but
-- still needs the privilege. Nothing else may: this deletes rows.
revoke all on function vizserve_pms_expire_comment_images(interval) from public, anon, authenticated;
grant execute on function vizserve_pms_expire_comment_images(interval) to service_role;
