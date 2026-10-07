-- P16-03a — CANCELLED, a task status (7 Oct 2026).
--
-- On its own because a new enum value cannot be used in the transaction that
-- adds it, and the SQL editor runs a paste as one transaction. Run this, then
-- 20261007110100_p16_03b_task_cancel_archive_delete.sql.
--
-- ⚠️ APPLY BY HAND in the SQL editor. Never `db:push`.

alter type vizserve_pms_task_status add value if not exists 'CANCELLED';
