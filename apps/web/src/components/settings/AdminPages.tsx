import { Services } from "../ops/Services";
import { Providers } from "./Providers";
import { OpenApi } from "./OpenApi";
import { System } from "./System";
import type { AdminDrawer } from "./common";
import "./admin.css";

export function AdminPages({
  view,
  onDrawer,
  onChanged,
}: {
  view: "services" | "providers" | "open-api" | "system";
  onDrawer: (d: AdminDrawer) => void;
  onChanged?: () => void;
}) {
  return (
    <section className="admin-pages">
      <div className="admin-inner">
        {view === "services" ? (
          <Services onDrawer={onDrawer} />
        ) : view === "providers" ? (
          <Providers onChanged={onChanged} />
        ) : view === "open-api" ? (
          <OpenApi />
        ) : (
          <System />
        )}
      </div>
    </section>
  );
}
