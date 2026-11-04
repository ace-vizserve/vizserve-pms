import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// P17-07 — the virtual office reads past the DTR policies on purpose, so the
// visibility rule in this function IS the access control. Pin its shape.
const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20261031090000_p17_07_office_presence.sql"), "utf8");

describe("vizserve_pms_office_presence", () => {
  it("is callable by signed-in users only", () => {
    expect(SQL).toMatch(/revoke all on function vizserve_pms_office_presence\(\) from public, anon;/);
    expect(SQL).toMatch(/grant execute on function vizserve_pms_office_presence\(\) to authenticated;/);
  });

  it("sees everyone in full for team leader and above, one's own department otherwise", () => {
    expect(SQL).toMatch(/vizserve_pms_has_role\('team_leader'\) as sees_all/);
    expect(SQL).toMatch(
      /coalesce\(\s+me\.sees_all\s+or p\.id = me\.id\s+or \(me\.primary_department_id is not null and p\.primary_department_id = me\.primary_department_id\),\s+false\s+\) as visible/,
    );
  });

  it("never returns a null visible — `false or NULL` is NULL, and that broke every member", () => {
    expect(SQL).toMatch(/select coalesce\(/);
  });

  it("withholds the name, the times and leave of anybody not visible", () => {
    expect(SQL).toMatch(/case when v\.visible then p\.full_name end/);
    expect(SQL).toMatch(/case when v\.visible then t\.time_in end/);
    expect(SQL).toMatch(/case when v\.visible then t\.time_out end/);
    expect(SQL).toMatch(/case when v\.visible then y\.time_in end/);
    expect(SQL).toMatch(/v\.visible and exists \(/);
  });

  it("answers nobody without access to this app", () => {
    expect(SQL).toMatch(/vizserve_pms_current_role\(\) is not null/);
  });

  it("returns presence, not the DTR — no corrections, requests or leave type", () => {
    const returns = SQL.slice(SQL.indexOf("returns table"), SQL.indexOf("language sql"));
    expect(returns).not.toMatch(/correct|reason|type|request/i);
  });
});

// P17-08 replaces the function, so the rule that matters from here on is this
// file's: lunch and the all-hands open the name of whoever is in, and nothing else.
const SHARED = readFileSync(join(process.cwd(), "supabase/migrations/20261102090000_p17_08_office_gatherings.sql"), "utf8");

// P17-13 replaces it again: a Manager or Business Manager's name goes to everyone,
// and still nothing else about them.
const ROAMERS = readFileSync(join(process.cwd(), "supabase/migrations/20261104090000_p17_13_office_roamers.sql"), "utf8");

describe("vizserve_pms_office_presence with roamers", () => {
  it("keeps the grants the drop took away", () => {
    expect(ROAMERS).toMatch(/revoke all on function vizserve_pms_office_presence\(\) from public, anon;/);
    expect(ROAMERS).toMatch(/grant execute on function vizserve_pms_office_presence\(\) to authenticated;/);
  });

  it("opens only the name for a roamer, not the times, the leave or `visible`", () => {
    expect(ROAMERS).toMatch(/case when v\.visible or s\.in_shared_room or r\.roams then p\.full_name end/);
    expect(ROAMERS).toMatch(/case when v\.visible then t\.time_in end/);
    expect(ROAMERS).toMatch(/case when v\.visible then t\.time_out end/);
    expect(ROAMERS).toMatch(/case when v\.visible then y\.time_in end/);
    expect(ROAMERS).toMatch(/v\.visible and l\.on_leave/);
    expect(ROAMERS).toMatch(/coalesce\(\s+me\.sees_all\s+or p\.id = me\.id\s+or \(me\.primary_department_id is not null and p\.primary_department_id = me\.primary_department_id\),\s+false\s+\) as visible/);
  });

  it("is keyed on the roles held, and stops for approved leave", () => {
    expect(ROAMERS).toMatch(/ur\.role in \('manager', 'business_manager'\)/);
    expect(ROAMERS).toMatch(/p\.is_business_manager/);
    expect(ROAMERS).toMatch(/not l\.on_leave/);
  });
});

// P17-14 replaces it once more: hair follows the staff record, and only where the name goes.
const HAIR = readFileSync(join(process.cwd(), "supabase/migrations/20261104100000_p17_14_office_hair.sql"), "utf8");

describe("vizserve_pms_office_presence with hair", () => {
  it("keeps the grants and the roamer rule", () => {
    expect(HAIR).toMatch(/grant execute on function vizserve_pms_office_presence\(\) to authenticated;/);
    expect(HAIR).toMatch(/case when v\.visible or s\.in_shared_room or r\.roams then p\.full_name end/);
    expect(HAIR).toMatch(/case when v\.visible then t\.time_in end/);
  });

  it("sends hair only where the name goes, and a boolean rather than the gender", () => {
    expect(HAIR).toMatch(/when v\.visible or s\.in_shared_room or r\.roams then\s+case p\.gender when 'FEMALE' then true when 'MALE' then false end/);
    const returns = HAIR.slice(HAIR.indexOf("returns table"), HAIR.indexOf("language sql"));
    expect(returns).not.toMatch(/gender/);
  });
});

describe("vizserve_pms_office_presence in the shared rooms", () => {
  it("keeps the grants the drop took away", () => {
    expect(SHARED).toMatch(/revoke all on function vizserve_pms_office_presence\(\) from public, anon;/);
    expect(SHARED).toMatch(/grant execute on function vizserve_pms_office_presence\(\) to authenticated;/);
  });

  it("opens the name of somebody who is in, and only during lunch and the Friday all-hands", () => {
    expect(SHARED).toMatch(/case when v\.visible or s\.in_shared_room then p\.full_name end/);
    expect(SHARED).toMatch(/manila::time >= time '12:00' and manila::time < time '13:00'/);
    expect(SHARED).toMatch(/extract\(isodow from manila\) = 5 and manila::time >= time '16:00' and manila::time < time '17:00'/);
    expect(SHARED).toMatch(/select today\.gathering\s+and \(\(t\.time_in is not null and t\.time_out is null\) or y\.time_in is not null\) as in_shared_room/);
  });

  it("still withholds the times and leave, and leaves the room closed", () => {
    expect(SHARED).toMatch(/case when v\.visible then t\.time_in end/);
    expect(SHARED).toMatch(/case when v\.visible then t\.time_out end/);
    expect(SHARED).toMatch(/case when v\.visible then y\.time_in end/);
    expect(SHARED).toMatch(/v\.visible and exists \(/);
    expect(SHARED).toMatch(/coalesce\(\s+me\.sees_all\s+or p\.id = me\.id\s+or \(me\.primary_department_id is not null and p\.primary_department_id = me\.primary_department_id\),\s+false\s+\) as visible/);
  });
});
