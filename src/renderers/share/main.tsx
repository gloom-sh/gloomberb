/** @jsxImportSource react */
import "./styles.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { deleteShare, getShare, openLiveShareUrl, parseShareId, type ShareRecord } from "../../shares/api";
import { ShareView } from "./view";

function ShareApp() {
  const id = parseShareId(window.location.pathname);
  const [state, setState] = useState<{
    share?: ShareRecord;
    error?: string;
    deleting?: boolean;
    deleted?: boolean;
  }>({});
  useEffect(() => {
    if (!id) return setState({ error: "Invalid share link." });
    const controller = new AbortController();
    getShare(id, (url, init) => fetch(url, { ...init, signal: controller.signal }))
      .then((share) => setState(share ? { share } : { error: "This share is unavailable or has expired." }))
      .catch(() => { if (!controller.signal.aborted) setState({ error: "This share could not be loaded." }); });
    return () => controller.abort();
  }, [id]);
  const remove = async () => {
    if (!id || !state.share?.ownedByViewer || state.deleting) return;
    setState((current) => ({ ...current, deleting: true, error: undefined }));
    try {
      await deleteShare(id);
      setState({ deleted: true });
    } catch (error) {
      setState((current) => ({
        ...current,
        deleting: false,
        error: error instanceof Error ? error.message : "Could not delete share.",
      }));
    }
  };
  if (state.deleted) return <main><h1>Share deleted</h1><p>This link is no longer available.</p></main>;
  if (state.share) {
    return (
      <ShareView
        share={state.share}
        openLiveUrl={id ? openLiveShareUrl(id) : undefined}
        deleting={state.deleting === true}
        deleteError={state.error}
        onDelete={state.share.ownedByViewer ? remove : undefined}
      />
    );
  }
  return <main><h1>Gloomberb</h1><p>{state.error ?? "Loading shared view..."}</p></main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<ShareApp />);
