-- P7-03 — the OVERTIME request type.
--
-- THIS FILE CONTAINS ONE STATEMENT ON PURPOSE, and the next migration is the one
-- that uses it.
--
-- Postgres forbids *using* an enum value in the same transaction that adds it
-- ("unsafe use of new value"), and each migration file here is applied as one
-- transaction in the dashboard SQL editor (docs/13). Putting this ALTER and the
-- CHECK constraint that names 'OVERTIME' in one file would fail at apply time,
-- on a step that looks trivial.
--
-- Exactly the same trap, and the same one-line fix, as
-- 20260804151000_p5_05_notification_type.sql. It is written down twice because
-- it will be met a third time.

alter type vizserve_pms_internal_request_type add value if not exists 'OVERTIME';
