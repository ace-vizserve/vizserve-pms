-- P7-77 — a notification type for "a request in your department was approved".
--
-- ONE STATEMENT, ALONE, for the reason 20260917090000 records: Postgres forbids
-- using an enum value in the transaction that adds it. The settings row and the
-- function that raises it are in the next file.

alter type vizserve_pms_notification_type add value if not exists 'request_approved';
