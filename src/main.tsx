import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Setup } from "./Setup";
import { SessionView } from "./SessionView";
import "./styles.css";

function App() {
  const [id, setId] = useState<string | null>(() => new URLSearchParams(location.search).get("s"));
  useEffect(() => {
    const url = id ? `?s=${id}` : location.pathname;
    history.replaceState(null, "", url);
  }, [id]);
  return id ? <SessionView id={id} onExit={() => setId(null)} /> : <Setup onStart={setId} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
