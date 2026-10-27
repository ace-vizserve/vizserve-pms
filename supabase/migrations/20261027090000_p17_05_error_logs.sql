-- P17-05 — the error log (27 Oct 2026).
--
-- What FAILED, beside the audit trail's record of what succeeded. The audit
-- trail cannot hold this by construction: a failed write rolls back, and its
-- audit row is part of what rolls back. A page that crashes while rendering
-- changed nothing, so nothing is audited either.
--
-- WRITTEN ONLY BY THE SERVER, through the service role:
--   * `instrumentation.ts` — Next's `onRequestError`, for every server error
--     (a page render, a server action, a route handler, the proxy);
--   * `/api/errors` — a browser error that never reached the server, reported
--     by the error pages, and only for a signed-in person.
-- So `authenticated` holds SELECT and nothing else, and `anon` holds nothing.
--
-- READ BY THE ADMIN (IT) ROLE ONLY, the same person the screen is for —
-- equality on the acting role, not the ladder. A stack trace names files and
-- tables; it is a tool for whoever keeps the portal running, not an oversight
-- view.
--
-- ⚠️ `environment` IS THE POINT OF SEVERAL ROWS LOOKING ALIKE. Local dev and
-- the staging preview both point at this same project, so without it a broken
-- branch on somebody's laptop would read as a production outage.
--
-- PRUNED AFTER 30 DAYS by `/api/cron/prune-error-logs`. An error log is for
-- fixing things now; a month is long enough to see whether a fix held.
--
-- ⚠️ APPLY BY HAND in the SQL editor, like the other P17 files. Until it is
-- applied, recording fails quietly (the reporter never throws) and the screen
-- says the table is missing rather than erroring.


create table if not exists vizserve_pms_error_logs (
  id           uuid primary key default gen_random_uuid(),
  occurred_at  timestamptz not null default now(),
  -- Where it was caught: the server, or a browser that never reached it.
  source       text not null,
  -- Next's routeType for a server error ('render' | 'route' | 'action' |
  -- 'proxy'); 'client' for a browser one.
  kind         text not null,
  environment  text not null,
  method       text,
  -- The URL path, query stripped — a query can carry a token.
  path         text,
  -- The route FILE, e.g. /tasks/[id]. Groups one bug across every id.
  route        text,
  message      text not null,
  -- React's opaque handle; what the error page shows the person who hit it.
  digest       text,
  stack        text,
  user_id      uuid references vizserve_pms_users (id) on delete set null,
  user_agent   text,
  constraint vizserve_pms_error_logs_source_check check (source in ('server', 'client')),
  constraint vizserve_pms_error_logs_environment_check
    check (environment in ('production', 'preview', 'development')),
  constraint vizserve_pms_error_logs_message_check check (char_length(message) between 1 and 2000),
  constraint vizserve_pms_error_logs_stack_check check (stack is null or char_length(stack) <= 8000)
);

create index if not exists vizserve_pms_error_logs_occurred_idx
  on vizserve_pms_error_logs (occurred_at desc);

comment on table vizserve_pms_error_logs is
  'P17-05. Server and browser errors, written by the service role only, read by Admin (IT). Pruned after 30 days.';


-- Both gates (CLAUDE.md): privileges first, then policies.
alter table vizserve_pms_error_logs enable row level security;
revoke all on vizserve_pms_error_logs from anon;
revoke all on vizserve_pms_error_logs from authenticated;
grant select on vizserve_pms_error_logs to authenticated;
grant all on vizserve_pms_error_logs to service_role;

drop policy if exists "error logs read by admin" on vizserve_pms_error_logs;
create policy "error logs read by admin"
  on vizserve_pms_error_logs for select to authenticated
  using ((select vizserve_pms_current_role()) = 'admin');
