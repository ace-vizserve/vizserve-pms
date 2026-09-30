-- P14-11 — CEO AND BUSINESS MANAGER ARE TOLD WHEN A PROCESS ENDS (30 Sep 2026).
--
-- Decided by Ace: the oversight roles are notified, in the app, whenever an
-- approval reaches its last step — approved, rejected, or closed with no client
-- response. Email starts OFF; Admin can switch it on per stage in
-- /admin/settings, or remove either role from any stage.
--
-- "Every CEO / every Business Manager" means everyone who HOLDS the role,
-- whatever they are acting as (vizserve_pms_emit resolves role rules through
-- vizserve_pms_user_roles).
--
-- ⚠️ APPLY BY HAND in the SQL editor, after p14_10. Never `db:push`.

insert into vizserve_pms_notification_rules (event_key, audience_kind, audience, in_app, email, locked)
select e.key, 'role', r.role, true, false, false
  from vizserve_pms_notification_events e
 cross join (values ('owner'), ('business_manager')) as r(role)
 where e.ends_flow
on conflict do nothing;
