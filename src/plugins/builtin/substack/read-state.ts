import {
  DEFAULT_MAX_READ_IDS,
  usePersistedReadIds,
  type PersistedReadIdAdapter,
} from "../shared/read-state";

interface SubstackReadState {
  articleIds: string[];
}

const SUBSTACK_READ_STATE_SCHEMA_VERSION = 1;
const READ_STATE_KEY = "read-articles";
const EMPTY_READ_STATE: SubstackReadState = { articleIds: [] };

const MAX_READ_SUBSTACK_ARTICLE_IDS = DEFAULT_MAX_READ_IDS;
const SUBSTACK_READ_STATE_ADAPTER: PersistedReadIdAdapter<SubstackReadState> = {
  getIds: (state) => state.articleIds,
  withIds: (_state, articleIds) => ({ articleIds }),
  maxIds: MAX_READ_SUBSTACK_ARTICLE_IDS,
};

export function useSubstackReadState() {
  const { readIds, markRead } = usePersistedReadIds({
    key: READ_STATE_KEY,
    fallback: EMPTY_READ_STATE,
    schemaVersion: SUBSTACK_READ_STATE_SCHEMA_VERSION,
    adapter: SUBSTACK_READ_STATE_ADAPTER,
  });
  return { readArticleIds: readIds, markArticleRead: markRead };
}
