interface CloudTweetUserPayload {
  id: string;
  userName: string;
  name: string;
}

interface CloudTweetMetricsPayload {
  retweets: number | null;
  replies: number | null;
  likes: number | null;
  quotes: number | null;
  views: number | null;
  bookmarks: number | null;
}

interface CloudTweetMediaPayload {
  type?: string;
  url?: string;
  mediaUrl?: string;
  media_url?: string;
  media_url_https?: string;
  previewImageUrl?: string;
  preview_image_url?: string;
}

export interface CloudTweetPayload {
  id: string;
  url: string;
  text: string;
  createdAt: string;
  lang: string;
  isReply: boolean;
  author: CloudTweetUserPayload;
  metrics: CloudTweetMetricsPayload;
  media?: CloudTweetMediaPayload[];
  photos?: CloudTweetMediaPayload[];
  images?: CloudTweetMediaPayload[];
}

export type CloudTweetQueryType = "Latest" | "Top";

export interface CloudTweetSearchResponse {
  ticker?: string;
  cashtag?: string;
  query: string;
  queryType: CloudTweetQueryType;
  since: string;
  until: string;
  limit: number;
  offset?: number;
  /** More tweets sit behind this page. Absent on servers without paging. */
  hasMore?: boolean;
  hours: number;
  includeReplies?: boolean;
  cached: boolean;
  cacheTtlMs: number;
  asOf: string;
  tweets: CloudTweetPayload[];
}
