interface CloudJobsSeriesPoint {
  day: string;
  open: number;
  /** Null on the first observed day, when the whole board is seen for the first time. */
  new: number | null;
  closed: number;
  /** Open standing roles the company hires for continuously. */
  evergreen?: number;
  /** Open contract and temporary roles. */
  contract?: number;
}

export interface CloudJobsBucket {
  id: string;
  label: string;
  count: number;
  share: number;
  /** Count 30 days ago from the daily roll-up, when the history reaches back. */
  previous: number | null;
}

export interface CloudJobsPosting {
  id: number;
  title: string;
  function: string | null;
  seniority: string | null;
  location: string | null;
  country: string | null;
  remote: boolean | null;
  employmentKind?: string | null;
  /** A standing posting for a continuous-hiring role; null when unjudged. */
  evergreen?: boolean | null;
  postedAt: string | null;
  postedPrecision: "exact" | "approximate" | "floor" | null;
  firstSeenAt: string;
  url: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  tags: string[];
}

/** One posting as its detail view reads it. */
export interface CloudJobsPostingDetail extends CloudJobsPosting {
  /** The careers system's own id. */
  externalId: string;
  /** As the careers system writes it ("Full time", "FULL_TIME", "CDI"). */
  employmentType: string | null;
  /** The start of the role's description, as read from its page. */
  description: string | null;
  closedAt: string | null;
}

export interface CloudJobsChange {
  count: number;
  percent: number | null;
}

export interface CloudJobsSummaryPayload {
  status: "ok";
  ticker: string;
  companyName: string | null;
  coverage: {
    status: string;
    vendor: string | null;
    careersUrl: string | null;
    lastCollectedAt: string | null;
    firstObservedAt: string | null;
    daysObserved: number;
    employeeCount: number | null;
  };
  openCount: number;
  openPerThousandEmployees: number | null;
  new7d: number;
  new30d: number;
  closed30d: number;
  change30d: CloudJobsChange | null;
  change90d: CloudJobsChange | null;
  /** False when the careers system re-dates every role on refresh, so dates are withheld. */
  datesReliable?: boolean;
  /** Open postings the system dates within the last 30 days. */
  posted30d?: number | null;
  remoteShare: number | null;
  /**
   * Open roles that are standing postings for continuous-hiring positions
   * (baristas, servers, store associates, nurses). One more of those says
   * nothing about the company's plans; open minus evergreen is the count of
   * specific roles.
   */
  evergreenCount?: number;
  evergreenShare?: number | null;
  /** Share of open roles that are contract or temporary, among those known. */
  contractShare?: number | null;
  medianAgeDays: number | null;
  series: CloudJobsSeriesPoint[];
  /** The current backlog by how long each role has been posted. */
  ageBuckets?: Array<{ id: string; label: string; count: number }>;
  functions: CloudJobsBucket[];
  countries: CloudJobsBucket[];
  seniority: CloudJobsBucket[];
  tags: CloudJobsBucket[];
  salary: {
    count: number;
    currency: string;
    period: string;
    medianMin: number;
    medianMax: number;
    byFunction: Array<{ id: string; label: string; count: number; medianMin: number; medianMax: number }>;
  } | null;
  recent: CloudJobsPosting[];
}

interface CloudJobsPendingPayload {
  status: "pending";
  ticker: string;
  queued: boolean;
  message: string;
}

export type CloudJobsResponse = CloudJobsSummaryPayload | CloudJobsPendingPayload;

export interface CloudJobsPostingsPayload {
  postings: CloudJobsPosting[];
  total: number;
}

export interface CloudJobsMoverPayload {
  ticker: string;
  companyName: string | null;
  openCount: number;
  employeeCount: number | null;
  change30d: CloudJobsChange | null;
  /** Open roles the system dates within the last 30 days, null when its dates cannot be read. */
  posted30d?: number | null;
  new7d: number;
  topFunction: string | null;
  topCountry?: { code: string; share: number } | null;
}

export interface CloudJobsMoversPayload {
  asOf: string;
  covered: number;
  /** Companies in the ranking; `movers` is one page of them. */
  total?: number;
  movers: CloudJobsMoverPayload[];
}
