import { OpenApi } from "./OpenApi";
import { System } from "./System";
import { ApiServiceCockpit } from "./ApiServiceCockpit";
import type { AdminDrawer } from "./common";
import "./admin.css";

export function AdminPages({
  view,
  onDrawer,
  onChanged,
  onNavigate,
}: {
  view: "services" | "providers" | "open-api" | "system";
  onDrawer: (d: AdminDrawer) => void;
  onChanged?: () => void;
  onNavigate?: (view: "mcp") => void;
}) {
  return (
    <section className="admin-pages">
      <div className="admin-inner">
        {view === "services" || view === "providers" ? (
          <ApiServiceCockpit
            initialTab={view === "providers" ? "providers" : "overview"}
            onDrawer={onDrawer}
            onChanged={onChanged}
            onNavigate={onNavigate}
          />
        ) : view === "open-api" ? (
          <OpenApi />
        ) : (
          <System />
        )}
      </div>
    </section>
  );
}
