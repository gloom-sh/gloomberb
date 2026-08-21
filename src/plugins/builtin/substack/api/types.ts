import type {
  SubstackArticleDetail,
  SubstackArticleSummary,
  SubstackPublication,
} from "../types";

export interface SubstackAuthState {
  email: string;
  sid: string;
  lli: string | null;
  loggedInAt: number;
}

export interface SubstackHomeData {
  subscriptions: SubstackPublication[];
  feed: SubstackArticleSummary[];
  fetchedAt: number;
  stale: boolean;
  hasMore?: boolean;
  nextCursor?: string | null;
}

export interface SubstackPublicationFeedPage {
  items: SubstackArticleSummary[];
  nextOffset: number | null;
  hasMore: boolean;
}

export interface SubstackCachedData<T> {
  data: T;
  fetchedAt: number;
  stale: boolean;
}

export class SubstackAuthError extends Error {
  constructor(message = "Substack login required") {
    super(message);
    this.name = "SubstackAuthError";
  }
}

export type { SubstackArticleDetail, SubstackArticleSummary, SubstackPublication };
