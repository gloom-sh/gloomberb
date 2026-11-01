/**
 * A Gloom Cloud story's short id: the first eight characters of its id
 * (`6067684e` for `6067684e-2e13-41c5-a7cf-5052b3cefc07`), which `news`
 * prints on each row and the story pane opens (`fn news-story-pane 6067684e`).
 * Gloom Cloud opens the one story whose id starts with it.
 */
const SHORT_STORY_ID_LENGTH = 8;

const STORY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID = /^[0-9a-f]{8}$/i;

/** The id a row prints: a Gloom Cloud story's short id, any other source's id as it is. */
export function shortStoryId(id: string): string {
  return STORY_UUID.test(id) ? id.slice(0, SHORT_STORY_ID_LENGTH).toLowerCase() : id;
}

/** Whether `id` is the story `wanted` names, by its full id or its short one, in any case. */
export function storyIdMatches(id: string, wanted: string): boolean {
  const typed = wanted.trim().toLowerCase();
  const own = id.toLowerCase();
  return own === typed || (SHORT_ID.test(typed) && STORY_UUID.test(own) && own.startsWith(typed));
}
