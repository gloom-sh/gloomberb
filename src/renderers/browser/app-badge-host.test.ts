import { expect, test } from "bun:test";
import { appBadgeLabel, getAppBadgeHost } from "../../notifications/app-badge";
import { installBrowserAppBadgeHost } from "./app-badge-host";

test("replaces the tab prefix with the shared unread label and restores the title at zero", () => {
  const doc = { title: "Gloom Terminal" };
  const uninstall = installBrowserAppBadgeHost(doc);
  try {
    const badge = getAppBadgeHost()!;
    badge.setBadge(appBadgeLabel(1));
    expect(doc.title).toBe("(1) Gloom Terminal");
    badge.setBadge(appBadgeLabel(3));
    expect(doc.title).toBe("(3) Gloom Terminal");
    badge.setBadge(appBadgeLabel(100));
    expect(doc.title).toBe("(99+) Gloom Terminal");
    badge.setBadge(appBadgeLabel(0));
    expect(doc.title).toBe("Gloom Terminal");
  } finally {
    uninstall();
  }
});
