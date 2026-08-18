import {
  BarChart3,
  CheckSquare,
  ClipboardList,
  Clock,
  FileText,
  Inbox,
  LayoutDashboard,
  ListChecks,
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
} satisfies Record<NavIconName, React.ComponentType<{ className?: string }>>;

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = ICONS[name];
  return <Icon className={className} />;
}
