import {
  DEFAULT_MAX_READ_IDS,
  markPersistedReadId,
  normalizePersistedReadIdState,
  usePersistedReadIds,
  type PersistedReadIdAdapter,
} from "../../shared/read-state";

export interface NewsReadState {
  articleIds: string[];
}

const NEWS_READ_STATE_SCHEMA_VERSION = 1;
export const MAX_READ_ARTICLE_IDS = DEFAULT_MAX_READ_IDS;

const READ_STATE_KEY = "read-articles";
const EMPTY_READ_STATE: NewsReadState = { articleIds: [] };
const NEWS_READ_STATE_ADAPTER: PersistedReadIdAdapter<NewsReadState> = {
  getIds: (state) => state.articleIds,
  withIds: (_state, articleIds) => ({ articleIds }),
  maxIds: MAX_READ_ARTICLE_IDS,
};

export function normalizeNewsReadState(state: NewsReadState): NewsReadState {
  return normalizePersistedReadIdState(state, NEWS_READ_STATE_ADAPTER);
}

export function markNewsArticleRead(
  state: NewsReadState,
  articleId: string,
): NewsReadState {
  return markPersistedReadId(state, articleId, NEWS_READ_STATE_ADAPTER);
}

export function useNewsReadState() {
  const { readIds, markRead } = usePersistedReadIds({
    key: READ_STATE_KEY,
    fallback: EMPTY_READ_STATE,
    schemaVersion: NEWS_READ_STATE_SCHEMA_VERSION,
    adapter: NEWS_READ_STATE_ADAPTER,
  });
  return { readArticleIds: readIds, markArticleRead: markRead };
}
