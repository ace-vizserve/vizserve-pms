import {
  BarChart3,
  BriefcaseBusiness,
  CalendarCheck,
  CalendarDays,
  CalendarOff,
  CheckSquare,
  ClipboardList,
  Clock,
  FileText,
  History,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Settings,
  Tags,
  Timer,
  Users,
} from "lucide-react";

import type { NavIconName } from "@/lib/navigation";

const ICONS = {
  dashboard: LayoutDashboard,
  clock: Clock,
  check: CheckSquare,
  form: FileText,
  "inbox-stack": ClipboardList,
  tasks: ListChecks,
  timesheet: Timer,
  reports: BarChart3,
  inbox: Inbox,
  users: Users,
  "calendar-off": CalendarOff,
  "calendar-days": CalendarDays,
  settings: Settings,
  history: History,
  // P7-52. `hr` is unused by NAV_ITEMS today — every HR row picks a more
  // specific icon — but the name exists so the group has one if the sidebar
  // ever labels sections with an icon rather than text.
  hr: BriefcaseBusiness,
  "leave-type": Tags,
  attendance: CalendarCheck,
} satisfies Record<NavIconName, React.ComponentType<{ className?: string }>>;

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = ICONS[name];
  return <Icon className={className} />;
}
