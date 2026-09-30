-- P14-02a — BUSINESS MANAGER BECOMES A RUNG, directly under owner (CEO).
--
-- Business Manager is on par with the CEO. A ladder has no ties, so it sits one
-- step below `owner`: every `>= 'business_manager'` admits both, and an owner
-- still satisfies everything a Business Manager does.
--
-- ⚠️ PASTE THIS FILE ALONE, THEN p14_02b. A new enum value cannot be used in
-- the same transaction that adds it (55P04), which is the same split p8_01a/b
-- made for `owner`.
--
-- ⚠️ `ROLE_ORDER` in lib/auth/roles.ts must list the values in exactly this
-- order. It does: member, team_leader, manager, admin, business_manager, owner.

alter type vizserve_pms_user_role add value if not exists 'business_manager' before 'owner';
