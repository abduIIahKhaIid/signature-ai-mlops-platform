import { lazy, Suspense } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { usePolling } from "./lib/hooks";
import type { ModelInfo } from "./lib/api";
import { short, versionDate } from "./lib/format";
import DetectPage from "./pages/DetectPage";
import VerifyPage from "./pages/VerifyPage";
import { Logo } from "./components/Logo";

// the dashboard (with its chart library) loads only when it is opened
const PipelinePage = lazy(() => import("./pages/PipelinePage"));

interface Ready {
  status: string;
  workers?: number;
  reason?: string;
}

function ServiceStatus() {
  // /ready answers 503 when no worker is online; usePolling turns that into `error`.
  const ready = usePolling<Ready>("/ready", 15_000);
  const model = usePolling<{ status: string; result?: ModelInfo }>("/v1/model", 60_000);
  const online = !!ready.data && ready.data.status === "ready";
  const info = model.data?.result;
  const when = versionDate(info?.detector_version);
  return (
    <div className="flex items-center gap-3 text-[13px]" aria-live="polite">
      <span className="flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-full ${ready.loading && !ready.data ? "bg-desk-line" : online ? "bg-verified" : "bg-fault"}`}
          aria-hidden
        />
        <span className="font-bold">
          {ready.loading && !ready.data ? "Checking service" : online ? `${ready.data?.workers} worker${ready.data?.workers === 1 ? "" : "s"} online` : "Workers offline"}
        </span>
      </span>
      {info && (
        <span className="hidden text-ink-faint md:inline" title={info.detector_version}>
          Model {when ? `trained ${when}` : short(info.detector_version, 22)}
        </span>
      )}
    </div>
  );
}

const tabs = [
  { to: "/", label: "Detect" },
  { to: "/verify", label: "Verify" },
  { to: "/pipeline", label: "Pipeline" },
];

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-desk-line/70 bg-desk/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-8 gap-y-2 px-5 py-3">
          <NavLink to="/" className="flex items-center gap-2.5" aria-label="SignatureAI home">
            <Logo />
            <span className="font-display text-[19px] font-bold tracking-tight">SignatureAI</span>
          </NavLink>
          <nav className="flex gap-1" aria-label="Main">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.to === "/"}
                className={({ isActive }) =>
                  `rounded-lg px-3.5 py-1.5 text-[15px] font-bold transition-colors ${isActive ? "bg-ink text-white" : "text-ink-soft hover:bg-desk-deep"}`
                }
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <ServiceStatus />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-5 pb-16 pt-6">
        <Routes>
          <Route path="/" element={<DetectPage />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route
            path="/pipeline"
            element={
              <Suspense fallback={<p className="text-ink-soft">Loading the dashboard</p>}>
                <PipelinePage />
              </Suspense>
            }
          />
          <Route path="*" element={<p className="text-ink-soft">This page does not exist. Use the tabs above.</p>} />
        </Routes>
      </main>
    </div>
  );
}
