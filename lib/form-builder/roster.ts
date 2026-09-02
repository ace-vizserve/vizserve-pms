/**
 * P7-66 Phase 6 — WHO HAS NOT ANSWERED.
 *
 * Pure, because the two rules that make this screen a LIE rather than merely
 * wrong are both invisible once it is rendered: a name that should not be on the
 * list, and a list that should not exist at all.
 */

/** One person in the form's audience. */
export type RosterMember = {
  id: string;
  full_name: string;
  /** Null is legal, and only reachable when the form is open to everyone. */
  primary_department_id: string | null;
};

/**
 * The audience, minus the people who answered.
 *
 * ⚠️ `answeredIds` MUST BE THE DISTINCT AUTHORS, NOT THE ANSWER COUNT. The same
 * colleague may answer twice — there is deliberately no unique index on
 * (form_id, submitted_by) — so subtracting a COUNT from a roster size would
 * report that somebody has not answered because somebody else answered twice.
 * A Set of ids cannot make that mistake, which is why one is taken rather than a
 * number.
 *
 * ⚠️ ORDER IS THE ROSTER'S OWN, which is `full_name` from the query. Preserved
 * rather than re-sorted here so the two lists on the tab — who answered, who has
 * not — are not sorted by different rules for no reason a reader could see.
 *
 * ⚠️ AN AUTHOR WHO IS NOT IN THE ROSTER IS IGNORED, and that is correct rather
 * than a case to handle. It is reachable: somebody answers, and is then moved to
 * another department, or deactivated, or the audience is narrowed underneath
 * their answer. Their answer still exists and still counts — this function is
 * asked who is MISSING, and a person outside the audience cannot be missing from
 * it. The count of answers on the page is read from the database and is
 * unaffected either way, so the two numbers do not have to agree and the screen
 * must not imply they do.
 */
export function pendingAnswerers(
  roster: ReadonlyArray<RosterMember>,
  answeredIds: Iterable<string>,
): RosterMember[] {
  const answered = new Set(answeredIds);

  return roster.filter((member) => !answered.has(member.id));
}

/**
 * ⚠️ WHETHER THE QUESTION CAN BE ASKED AT ALL.
 *
 * An ANONYMOUS form has no answer to this and must not appear to. `submitted_by`
 * is NULL on every one of its rows — the INSERT policy refused to let a name be
 * written — so the set of authors is empty, and "who has not answered" would
 * return THE ENTIRE ROSTER. Rendered, that is a page telling an admin that
 * nobody in the company has answered a survey with four hundred answers in it,
 * beside a count saying four hundred.
 *
 * That is not a degraded view, it is a false one, and it is false in the
 * direction somebody would act on: chasing people who already answered, on a
 * form that promised them anonymity.
 *
 * ⚠️ THE ARGUMENT IS THE FORM'S FLAG, NEVER A PROPERTY OF THE ROWS. The
 * shortcut — "no rows have an author, so treat it as anonymous" — is satisfied
 * by a form nobody has answered yet, which would then hide the roster on exactly
 * the form where it is most useful.
 *
 * A function rather than a ternary inside the component, so the rule is pinned
 * by a test on a machine with no DOM, and so its signature can say what it
 * depends on: a boolean, and nothing else.
 */
export function canShowPendingAnswerers(isAnonymous: boolean): boolean {
  return !isAnonymous;
}
