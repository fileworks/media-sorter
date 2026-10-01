import { createRoot } from "react-dom/client";

import { Button } from "../../src/components/ui/button";
import { Input } from "../../src/components/ui/input";
import { Tooltip } from "../../src/components/ui/tooltip";
import "../../src/index.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark",
);
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <main className="space-y-4 p-4">
    <h1>UI control regression fixture</h1>
    <label htmlFor="destination">Destination folder</label>
    <Input id="destination" />
    <div style={{ position: "fixed", bottom: 8, left: 8 }}>
      <Tooltip
        side="bottom"
        label={`/photos/${"a-long-original-folder-name/".repeat(64)}IMG_0001.jpg`}
      >
        <Button aria-label="Explain output">Explain output</Button>
      </Tooltip>
    </div>
  </main>,
);
