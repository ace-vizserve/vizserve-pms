import { CircleCheck, Eye, Heart, Laugh, PartyPopper, ThumbsUp } from "lucide-react";

import type { ReactionOption } from "@/components/ui/reactions";

/**
 * The six reactions, in picker order — shared by a task comment (P17-03) and an
 * announcement (P17-06), so the two bars offer the same thing.
 *
 * The ids are the database's: both reaction tables carry the same CHECK
 * constraint, mirrored by `COMMENT_REACTIONS` and `ANNOUNCEMENT_REACTIONS`. The
 * icons and words live only here.
 */
export const REACTION_OPTIONS = [
  { id: "like", label: "Like", icon: ThumbsUp },
  { id: "love", label: "Love", icon: Heart },
  { id: "celebrate", label: "Celebrate", icon: PartyPopper },
  { id: "laugh", label: "Haha", icon: Laugh },
  { id: "seen", label: "Seen", icon: Eye },
  { id: "done", label: "Done", icon: CircleCheck },
] as const satisfies readonly ReactionOption[];
