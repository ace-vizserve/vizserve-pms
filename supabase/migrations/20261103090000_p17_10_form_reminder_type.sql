-- P17-10 — a notification type for "there is an internal form for you to answer".
--
-- ONE STATEMENT, ALONE, for the reason 20260917090000 records: Postgres forbids
-- using an enum value in the transaction that adds it. Everything that uses it
-- is in the next file.
--
-- ⚠️ APPLY BY HAND in the SQL editor, and run this file on its own first.

alter type vizserve_pms_notification_type add value if not exists 'form_reminder';
