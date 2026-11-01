/**
 * /rfps — RFP intake list (F1-004).
 *
 * The consultant's queue of incoming RFPs, each with a status pill
 * (Parsing / Ready / Drafted), a deadline countdown chip, the parse-confidence
 * summary, and a regulated-industry flag when applicable. The primary action is
 * the single-screen dropzone intake at /rfps/new — the deliberate contrast to a
 * template builder.
 */
import type { JSX } from "react";
import Link from "next/link";
import { requireProposalAccess } from "@/lib/proposals/access";
import { listRfps, type Rfp } from "@/lib/proposals/rfp-parser";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_STYLES = `
.rfp-row { display:flex; justify-content:space-between; gap:1rem; align-items:flex-start; flex-wrap:wrap; }
.rfp-pill { display:inline-block; border:1px solid var(--substrate-border, currentColor); border-radius:999px; padding:0.1rem 0.6rem; font-size:0.78rem; font-weight:600; }
.rfp-pill.parsing { opacity:0.75; }
.rfp-pill.ready { border-color:#15803d; color:#15803d; }
.rfp-pill.drafted { border-color:#4f46e5; color:#4f46e5; }
.rfp-pill.error { border-color:#b91c1c; color:#b91c1c; }
.rfp-chip { display:inline-block; border-radius:0.4rem; padding:0.1rem 0.5rem; font-size:0.78rem; border:1px solid var(--substrate-border, currentColor); }
.rfp-chip.urgent { border-color:#b91c1c; color:#b91c1c; font-weight:700; }
.rfp-chip.soon { border-color:#b45309; color:#b45309; }
.rfp-chip.passed { opacity:0.6; text-decoration:line-through; }
.rfp-meta { display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-top:0.4rem; }
.rfp-reg { border-color:#b45309; color:#b45309; }
`;

function statusLabel(status: string): string {
  if (status === "parsing") return "Parsing";
  if (status === "ready") return "Ready";
  if (status === "drafted") return "Drafted";
  if (status === "error") return "Error";
  return status;
}

/** Days-until-deadline, rounded toward the nearest whole day. */
function daysUntil(deadlineIso: string): number {
  const ms = Date.parse(deadlineIso) - Date.now();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

export function DeadlineChip({ deadlineAt }: { deadlineAt: string | null }): JSX.Element | null {
  if (!deadlineAt) return null;
  const parsed = Date.parse(deadlineAt);
  if (Number.isNaN(parsed)) return null;
  const days = daysUntil(deadlineAt);
  const date = new Date(parsed).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  let cls = "rfp-chip";
  let label: string;
  if (days < 0) {
    cls += " passed";
    label = `Due ${date} (passed)`;
  } else if (days === 0) {
    cls += " urgent";
    label = `Due today · ${date}`;
  } else if (days <= 3) {
    cls += " urgent";
    label = `${days} day${days === 1 ? "" : "s"} left · ${date}`;
  } else if (days <= 10) {
    cls += " soon";
    label = `${days} days left · ${date}`;
  } else {
    label = `${days} days left · ${date}`;
  }
  return <span className={cls} title={new Date(parsed).toLocaleString()}>⏱ {label}</span>;
}

function ErrorBanner({ error }: { error: string | undefined }): JSX.Element | null {
  if (!error) return null;
  const messages: Record<string, string> = {
    notfound: "That RFP no longer exists.",
  };
  return (
    <p className="card" role="alert" style={{ borderColor: "#b91c1c" }}>
      {messages[error] ?? "Something went wrong. Please try again."}
    </p>
  );
}

function RfpCard({ rfp }: { rfp: Rfp }): JSX.Element {
  const pct = Math.round(rfp.parseConfidence * 100);
  return (
    <li className="card">
      <div className="rfp-row">
        <div>
          <Link href={`/rfps/${rfp.id}`} style={{ fontWeight: 700, fontSize: "1.05rem" }}>
            {rfp.title ?? "Untitled RFP"}
          </Link>
          <div className="rfp-meta">
            <span className={`rfp-pill ${rfp.status}`}>{statusLabel(rfp.status)}</span>
            <DeadlineChip deadlineAt={rfp.deadlineAt} />
            {rfp.isRegulated ? (
              <span className="rfp-chip rfp-reg" title="Regulated-industry RFP">
                ⚖ {rfp.regulatedIndustry ?? "Regulated"}
              </span>
            ) : null}
          </div>
          <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
            {rfp.issuer ? `${rfp.issuer} · ` : ""}
            {rfp.requirementCount} requirement{rfp.requirementCount === 1 ? "" : "s"} · parse confidence {pct}%
            {rfp.submissionFormat ? ` · ${rfp.submissionFormat}` : ""}
          </p>
        </div>
        <Link href={`/rfps/${rfp.id}`} className="btn secondary">Open</Link>
      </div>
    </li>
  );
}

export default async function RfpListPage({
  searchParams,
}: {
  searchParams: { error?: string };
}): Promise<JSX.Element> {
  const { organizationId } = await requireProposalAccess();
  const rfps = await listRfps(organizationId);

  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: PAGE_STYLES }} />
      <h1>RFPs</h1>
      <p>
        Every RFP that lands, with its deadline countdown and parse status. Drop a new one in and we extract
        the requirements, weighted criteria, deadline, and submission format for you.
      </p>

      <p>
        <Link href="/rfps/new" className="btn">+ New RFP</Link>
      </p>

      <ErrorBanner error={searchParams?.error} />

      {rfps.length === 0 ? (
        <div className="empty">
          <p style={{ fontWeight: 600 }}>No RFPs yet</p>
          <p className="muted">
            Drop your first RFP — PDF, DOCX, or pasted text — and we&apos;ll turn it into a working requirement
            checklist in seconds.
          </p>
          <p>
            <Link href="/rfps/new" className="btn">Add your first RFP</Link>
          </p>
        </div>
      ) : (
        <section aria-label="RFPs" style={{ marginTop: "1rem" }}>
          <p className="muted">
            {rfps.length} RFP{rfps.length === 1 ? "" : "s"}
          </p>
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.75rem" }}>
            {rfps.map((rfp) => (
              <RfpCard key={rfp.id} rfp={rfp} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
