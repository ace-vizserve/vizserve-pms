-- P7-78 — a notification type for "QA sent your work back".
--
-- ONE STATEMENT, ALONE: Postgres forbids using an enum value in the transaction
-- that adds it. The settings row and the function are in the next file.

alter type vizserve_pms_notification_type add value if not exists 'qa_returned';
