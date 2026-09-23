import type {
  FeedbackListResponse,
  FeedbackReportSummary,
  FeedbackSubmitRequest,
  FeedbackSubmitResponse,
} from "../feedback/types";
import { withDeadline } from "../utils/async-deadline";

type CloudApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

/** Long enough for a screenshot on a slow uplink, short enough that Send never hangs. */
const SUBMIT_TIMEOUT_MS = 45_000;

export class CloudFeedbackApi {
  constructor(private readonly request: CloudApiRequest) {}

  submitFeedback(report: FeedbackSubmitRequest): Promise<FeedbackSubmitResponse> {
    const controller = new AbortController();
    return withDeadline(
      this.request<FeedbackSubmitResponse>("/feedback", {
        method: "POST",
        body: JSON.stringify(report),
        signal: controller.signal,
      }),
      SUBMIT_TIMEOUT_MS,
      "Sending took too long. Check your connection and try again.",
      (error) => controller.abort(error),
    );
  }

  async listFeedback(): Promise<FeedbackReportSummary[]> {
    const body = await this.request<FeedbackListResponse>("/feedback");
    return body.reports;
  }
}
