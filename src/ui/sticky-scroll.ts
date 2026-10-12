/**
 * How far from the bottom, in px, a scroller still counts as at the bottom.
 * A reader a few pixels short of it is following the list, not reading back.
 * The DOM scroll box follows the bottom by this rule, and a list that shows
 * "new below" controls reads the same line.
 */
export const STICKY_BOTTOM_THRESHOLD_PX = 4;
