import { installAppBadgeHost } from "../../notifications/app-badge";

export function installBrowserAppBadgeHost(doc: Pick<Document, "title"> = document): () => void {
  const title = doc.title;
  const uninstall = installAppBadgeHost({
    setBadge(label) {
      doc.title = label ? `(${label}) ${title}` : title;
    },
  });
  return () => {
    uninstall();
    doc.title = title;
  };
}
