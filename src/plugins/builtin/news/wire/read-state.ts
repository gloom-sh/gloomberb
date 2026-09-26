import {
  DEFAULT_MAX_READ_IDS,
  usePersistedReadIds,
  type PersistedReadIdAdapter,
} from "../../shared/read-state";

interface NewsReadState {
  articleIds: string[];
}

const NEWS_READ_STATE_SCHEMA_VERSION = 1;

const READ_STATE_KEY = "read-articles";
const EMPTY_READ_STATE: NewsReadState = { articleIds: [] };
const NEWS_READ_STATE_ADAPTER: PersistedReadIdAdapter<NewsReadState> = {
  getIds: (state) => state.articleIds,
  withIds: (_state, articleIds) => ({ articleIds }),
  maxIds: DEFAULT_MAX_READ_IDS,
};

export function useNewsReadState() {
  const { readIds, markRead } = usePersistedReadIds({
    key: READ_STATE_KEY,
    fallback: EMPTY_READ_STATE,
    schemaVersion: NEWS_READ_STATE_SCHEMA_VERSION,
    adapter: NEWS_READ_STATE_ADAPTER,
  });
  return { readArticleIds: readIds, markArticleRead: markRead };
}
