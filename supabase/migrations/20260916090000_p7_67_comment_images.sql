-- P7-67 — an image pasted into a comment.
--
-- A third `kind` on the attachment table, and NOT a new table. The bytes are a
-- task attachment in every respect that matters: same bucket, same private
-- posture, same "the server measured them" rule, same cascade when the task
-- goes. What differs is only where it is DRAWN — inline in the comment body
-- rather than in the Outputs panel — and that is a read-side distinction, which
-- is exactly what `kind` already exists to express (`output` vs `reference`,
-- P3-13).
--
-- ⚠️ EVERY READER OF THIS TABLE NOW NEEDS A `kind` FILTER. Before this there
-- were two kinds and both belonged in the Outputs panel, so no query had to
-- say so. `app/(app)/tasks/[id]/page.tsx` and `lib/client-approval-server.ts`
-- are updated in the same commit; a reader that forgets draws every pasted
-- screenshot twice — once inline in the comment and once as a file in the panel.
--
-- ⚠️ THE POLICIES ARE DELIBERATELY UNTOUCHED. A comment image is visible to
-- whoever can see the task, insertable by a participant, removable by its
-- uploader or a lead — which is what the three P3-13 policies already say. A
-- fourth policy naming `kind = 'comment'` would be the same sentence written
-- again, and would drift.
--
-- ⚠️ NOTHING SWEEPS AN ORPHAN. A pasted image whose comment is never sent, or
-- whose `<img>` the author deletes before saving, leaves an object and a row
-- with no reference to them. `/api/cron/sweep-attachments` collects abandoned
-- PENDING rows (P1-09) and these are not pending — they are committed the
-- moment they are pasted, because there is no receipt handshake on a staff
-- upload. Accepted for now: an unsent screenshot costs a few hundred kilobytes.
-- Revisit if the bucket grows a tail.

alter table vizserve_pms_task_attachments
  drop constraint vizserve_pms_task_attachments_kind;

alter table vizserve_pms_task_attachments
  add constraint vizserve_pms_task_attachments_kind
  check (kind in ('output', 'reference', 'comment'));
