/**
 * /library — Case-Study Library grid (F1-003).
 *
 * A masonry card grid where each card's focal point is the headline outcome
 * metric in display type ("+38% pipeline in 90 days"), with an industry pill, a
 * client lockup (initials avatar when anonymised), and an extraction-confidence
 * badge. Cards lift on hover. The empty state is an illustration of three
 * stacked documents with the dropzone CTA — the only accented control on the
 * page — inviting "Drop your last three proposals — we extract the case studies
 * for you". Unreadable files fall back to a paste-the-text form.
 */
import type { JSX } from "react";
import Link from "next/link";
import { requireProposalAccess } from "@/lib/proposals/access";
import { listCaseStudies, type CaseStudy } from "@/lib/proposals/library-queries";
import { clientInitials } from "@/lib/proposals/case-study-extract";
import { ingestCaseStudyAction } from "./actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function confidenceTier(confidence: number): { label: string; pct: number } {
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.7) return { label: "High confidence", pct };
  if (confidence >= 0.45) return { label: "Medium confidence", pct };
  return { label: "Review suggested", pct };
}

const PAGE_STYLES = `
.cs-masonry { column-gap: 1rem; column-width: 18rem; }
.cs-masonry > * { break-inside: avoid; margin-bottom: 1rem; display: inline-block; width: 100%; }
.cs-card { transition: transform 120ms ease, box-shadow 120ms ease; }
.cs-card:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
.cs-metric { font-size: 1.9rem; font-weight: 800; line-height: 1.1; letter-spacing: -0.01em; }
.cs-avatar { display:inline-flex; align-items:center; justify-content:center; width:2.25rem; height:2.25rem; border-radius:999px; border:1px solid var(--substrate-border, currentColor); font-weight:700; flex-shrink:0; font-size:0.85rem; }
.cs-pill { display:inline-block; border:1px solid var(--substrate-border, currentColor); border-radius:999px; padding:0.1rem 0.6rem; font-size:0.8rem; }
.cs-badge { font-size:0.75rem; border:1px solid var(--substrate-border, currentColor); border-radius:0.4rem; padding:0.05rem 0.4rem; }
.cs-dropzone { border:2px dashed var(--accent, #4f46e5); border-radius:0.75rem; padding:1.5rem; text-align:center; }
.cs-cta { background: var(--accent, #4f46e5); color:#fff; border-color: var(--accent, #4f46e5); }
.cs-docs { display:flex; justify-content:center; margin-bottom:0.75rem; }
`;

function ErrorBanner({ error }: { error: string | undefined }): JSX.Element | null {
  if (!error) return null;
  const messages: Record<string, string> = {
    unreadable:
      "We couldn't read that file (it may be a scanned or image-only document). Paste the text instead below.",
    empty: "Add a file or paste some text before extracting.",
    notfound: "That case study no longer exists.",
  };
  const message = messages[error] ?? "Something went wrong. Please try again.";
  return (
    <p className="card" role="alert" style={{ borderColor: "var(--accent, #b91c1c)" }}>
      {message}
    </p>
  );
}

function ThreeDocsIllustration(): JSX.Element {
  return (
    <span className="cs-docs" aria-hidden="true">
      <svg width="96" height="72" viewBox="0 0 96 72" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="10" y="20" width="40" height="48" rx="4" opacity="0.4" />
        <rect x="24" y="12" width="40" height="52" rx="4" opacity="0.7" />
        <rect x="40" y="6" width="40" height="56" rx="4" />
        <line x1="47" y1="20" x2="73" y2="20" />
        <line x1="47" y1="30" x2="73" y2="30" />
        <line x1="47" y1="40" x2="66" y2="40" />
      </svg>
    </span>
  );
}

function Dropzone(): JSX.Element {
  return (
    <form action={ingestCaseStudyAction} className="card" encType="multipart/form-data">
      <div className="cs-dropzone">
        <ThreeDocsIllustration />
        <p style={{ fontWeight: 700, margin: "0 0 0.25rem" }}>
          Drop your last three proposals — we extract the case studies for you
        </p>
        <p className="muted" style={{ margin: "0 0 0.75rem" }}>
          PDF, DOCX, or plain text. We anonymise the client unless you mark it public.
        </p>
        <input type="file" name="file" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" />
      </div>

      <details style={{ marginTop: "0.75rem" }}>
        <summary className="muted">Can&apos;t upload? Paste the text instead</summary>
        <label>
          Proposal / project text
          <textarea name="pastedText" rows={6} placeholder="Paste the proposal or project write-up here…" />
        </label>
      </details>

      <div className="toolbar" style={{ marginTop: "0.75rem", alignItems: "center" }}>
        <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
          <input type="checkbox" name="clientIsPublic" value="on" />
          Client name is public (skip anonymisation)
        </label>
        <input name="clientName" placeholder="Client name (optional override)" />
        <button type="submit" className="btn cs-cta">Extract case study</button>
      </div>
    </form>
  );
}

function CaseStudyCard({ study }: { study: CaseStudy }): JSX.Element {
  const tier = confidenceTier(study.extractionConfidence);
  const displayName = study.clientIsPublic && study.clientName ? study.clientName : null;
  const headline = study.headlineMetric ?? study.title ?? "Case study";

  return (
    <Link href={`/library/${study.id}`} className="card cs-card" style={{ display: "block", textDecoration: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem" }}>
        {study.industry ? <span className="cs-pill">{study.industry}</span> : <span className="muted">Uncategorised</span>}
        <span className="cs-badge" title={`Extraction confidence ${tier.pct}%`}>
          {tier.label} · {tier.pct}%
        </span>
      </div>

      <p className="cs-metric" style={{ margin: "0.75rem 0" }}>{headline}</p>

      {study.outcomes ? (
        <p className="muted" style={{ margin: "0 0 0.75rem" }}>
          {study.outcomes.length > 160 ? `${study.outcomes.slice(0, 157)}…` : study.outcomes}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <span className="cs-avatar" title={displayName ?? "Anonymised client"}>
          {clientInitials(displayName ?? study.clientName)}
        </span>
        <span>
          <span style={{ display: "block", fontWeight: 600 }}>
            {displayName ?? "Anonymised client"}
          </span>
          {study.duration ? <span className="muted" style={{ fontSize: "0.8rem" }}>{study.duration}</span> : null}
        </span>
      </div>

      {study.piiFlagged ? (
        <p className="cs-badge" style={{ marginTop: "0.75rem", display: "inline-block" }}>
          ⚠ PII detected — redacted before indexing
        </p>
      ) : null}
    </Link>
  );
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: { error?: string };
}): Promise<JSX.Element> {
  const { organizationId } = await requireProposalAccess();
  const studies = await listCaseStudies(organizationId);

  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: PAGE_STYLES }} />
      <h1>Case-Study Library</h1>
      <p>
        Your reusable evidence base — the RAG corpus proposals quote from. Drop in old proposals and we
        extract the client, industry, problem, approach, and quantified outcomes for you.
      </p>

      <ErrorBanner error={searchParams?.error} />

      <Dropzone />

      {studies.length === 0 ? (
        <div className="empty" style={{ marginTop: "1.5rem" }}>
          <ThreeDocsIllustration />
          <p style={{ fontWeight: 600 }}>No case studies yet</p>
          <p className="muted">
            Extract your first above. We&apos;ll turn each proposal into a searchable case study.
          </p>
        </div>
      ) : (
        <section aria-label="Case studies" style={{ marginTop: "1.5rem" }}>
          <p className="muted">
            {studies.length} case stud{studies.length === 1 ? "y" : "ies"} indexed
          </p>
          <div className="cs-masonry">
            {studies.map((study) => (
              <CaseStudyCard key={study.id} study={study} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
