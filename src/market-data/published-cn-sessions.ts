// Published SSE and SZSE equity closures (weekend dates omitted), not a holiday-rule engine.
// Sources (checked 2026-10-04):
// https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20251222_10802510.shtml
// https://investor.szse.cn/disclosure/notice/general/t20251222_618087.html
// https://investor.szse.cn/disclosure/notice/general/t20260917_622911.html
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
// Past dates also match the weekdays missing from Shanghai Composite daily bars.
// Weekend make-up working days are not exchange trading sessions.
const CN_CLOSURES: Record<number, readonly string[]> = {
  2026: [
    "01-01", "01-02", "02-16", "02-17", "02-18", "02-19", "02-20", "02-23",
    "04-06", "05-01", "05-04", "05-05", "06-19", "09-25", "10-01", "10-02",
    "10-05", "10-06", "10-07",
  ],
};

/** True only for a published full-day closure; unpublished years are unknown, not open. */
export function isPublishedCnClosure(date: string): boolean {
  return CN_CLOSURES[Number(date.slice(0, 4))]?.includes(date.slice(5)) ?? false;
}

/** True when the closures of that year are published. */
export function hasPublishedCnCalendar(year: number): boolean {
  return CN_CLOSURES[year] !== undefined;
}
