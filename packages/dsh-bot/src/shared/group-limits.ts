/** Hard roster ceiling. Stored legacy groups remain readable without trimming their members. */
export const GROUP_MEMBER_LIMIT = 6;

/** Historical settings up to 16 remain loadable; smaller owner limits still apply. */
export const effectiveGroupMemberLimit = (configured: number): number => Math.min(configured, GROUP_MEMBER_LIMIT);
