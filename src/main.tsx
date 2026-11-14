import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Setup } from "./Setup";
import { SessionView } from "./SessionView";
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/500.css";
import "@fontsource/ibm-plex-sans-jp/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

function App() {
  const [id, setId] = useState<string | null>(() => new URLSearchParams(location.search).get("s"));
  useEffect(() => {
    const url = id ? `?s=${id}` : location.pathname;
    history.replaceState(null, "", url);
  }, [id]);
  function exit() {
    if (id)
      void fetch(`/api/sessions/${id}`, { method: "DELETE", keepalive: true }).catch(console.error);
    setId(null);
  }
  return id ? <SessionView id={id} onExit={exit} /> : <Setup onStart={setId} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
