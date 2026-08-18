-- P7-07 — a notification type for task comments.
--
-- ONE STATEMENT, ALONE. Third time in this repo, and the reason has not changed:
-- Postgres forbids *using* an enum value in the transaction that adds it, and
-- each migration file here is applied as one transaction. The settings row that
-- names 'commented' is in the next file for exactly that reason.
--
-- See 20260804151000_p5_05_notification_type.sql and
-- 20260818100000_p7_03_overtime_type.sql for the same trap.

alter type vizserve_pms_notification_type add value if not exists 'commented';
