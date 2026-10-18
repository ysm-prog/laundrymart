/**
 * The cutoff the test-data clean-up uses for "late assigned jobs" (brief 1.8:
 * "close the late `assigned` jobs from Aug–Sep") — jobs still waiting on a round
 * dated before 1 October 2026, the Xero cut-over. Its own module so the page,
 * the action and the tests read one value; a person can change it on the form.
 */
export const DEFAULT_LATE_CUTOFF = "2026-10-01";
