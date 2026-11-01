/**
 * /rfps/[id] — the split view (F1-004).
 *
 * Left: the RFP source text with requirement spans highlighted in a muted accent.
 * Right: requirement cards with weight bars and confidence pills (green/amber/red)
 * grouped under their mapped proposal section, a deadline countdown chip in the
 * header, and inline edit of any field. A low-confidence parse shows an amber
 * banner listing the specific parse_warnings rather than a generic error.
 */
import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProposalAccess } from "@/lib/proposals/access";
import {
  getRfp,
  getRfpRequirements,
  getRfpCriteria,
  LOW_CONFIDENCE_THRESHOLD,
  type Rfp,
  type RfpRequirement,
  type RfpCriterion,
} from "@/lib/proposals/rfp-parser";
import { groupBySection } from "@/lib/proposals/section-mapper";
import { DeadlineChip } from "../page";
import {
  updateRfpFieldAction,
  updateRfpPageLimitAction,
  updateRfpDeadlineAction,
  updateRequirementFieldAction,
  updateRequirementWeightAction,
  deleteRequirementAction,
  reparseRfpAction,
  deleteRfpAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DETAIL_STYLES = `
.rfp-split { display:grid; gap:1.5rem; grid-template-columns: 1fr 1fr; align-items:start; }
@media (max-width: 60rem) { .rfp-split { grid-template-columns: 1fr; } }
.rfp-source { position:sticky; top:1rem; max-height:80vh; overflow:auto; white-space:pre-wrap; font-size:0.85rem; line-height:1.5; }
.rfp-hl { background: rgba(79,70,229,0.14); border-bottom:1px solid rgba(79,70,229,0.5); border-radius:2px; }
.rfp-pill { display:inline-block; border:1px solid var(--substrate-border, currentColor); border-radius:999px; padding:0.05rem 0.55rem; font-size:0.75rem; font-weight:600; }
.conf-green { border-color:#15803d; color:#15803d; }
.conf-amber { border-color:#b45309; color:#b45309; }
.conf-red { border-color:#b91c1c; color:#b91c1c; }
.rfp-weightbar { height:0.5rem; border-radius:999px; background: var(--substrate-border, #e5e7eb); overflow:hidden; margin:0.35rem 0; }
.rfp-weightbar > span { display:block; height:100%; background: var(--accent, #4f46e5); }
.rfp-amber { border-color:#b45309; background: rgba(180,83,9,0.08); }
.rfp-reqcard { margin-bottom:0.85rem; }
.rfp-section-h { margin:1.25rem 0 0.5rem; }
.rfp-headergrid { display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap; }
.rfp-field { margin-bottom:0.6rem; }
.rfp-mand { font-size:0.72rem; border:1px solid #b91c1c; color:#b91c1c; border-radius:0.3rem; padding:0 0.35rem; }
`;

// Progressive enhancement: autosave each inline field on change. The explicit
// Save button in every form keeps editing functional without JavaScript.
const AUTOSAVE_SCRIPT = `
(function(){
  function wire(){
    var forms = document.querySelectorAll('form.rfp-autosave');
    for (var i=0;i<forms.length;i++){
      (function(form){
        var controls = form.querySelectorAll('input, textarea, select');
        for (var j=0;j<controls.length;j++){
          var c = controls[j];
          if (c.type === 'hidden' || c.type === 'submit') continue;
          c.addEventListener('change', function(){
            if (typeof form.requestSubmit === 'function') { form.requestSubmit(); }
            else { form.submit(); }
          });
        }
      })(forms[i]);
    }
  }
  if (document.readyState !== 'loading') wire();
  else document.addEventListener('DOMContentLoaded', wire);
})();
`;

type Span = { start: number; end: number };

/** Merge overlapping/adjacent spans so highlighting never double-wraps text. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans
    .filter((s) => s.start >= 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** Render raw text with the requirement spans wrapped in a muted-accent mark. */
function HighlightedSource({
  rawText,
  requirements,
}: {
  rawText: string;
  requirements: RfpRequirement[];
}): JSX.Element {
  const spans = mergeSpans(
    requirements
      .filter((r) => r.spanStart !== null && r.spanEnd !== null)
      .map((r) => ({ start: r.spanStart as number, end: r.spanEnd as number })),
  );

  if (spans.length === 0) {
    return <>{rawText}</>;
  }

  const nodes: JSX.Element[] = [];
  let cursor = 0;
  spans.forEach((span, idx) => {
    if (span.start > cursor) {
      nodes.push(<span key={`t-${idx}`}>{rawText.slice(cursor, span.start)}</span>);
    }
    nodes.push(
      <mark key={`h-${idx}`} className="rfp-hl">
        {rawText.slice(span.start, span.end)}
      </mark>,
    );
    cursor = span.end;
  });
  if (cursor < rawText.length) {
    nodes.push(<span key="t-last">{rawText.slice(cursor)}</span>);
  }
  return <>{nodes}</>;
}

function confidenceClass(confidence: number): string {
  if (confidence >= 0.7) return "conf-green";
  if (confidence >= 0.45) return "conf-amber";
  return "conf-red";
}

function ConfidencePill({ confidence }: { confidence: number }): JSX.Element {
  const pct = Math.round(confidence * 100);
  return <span className={`rfp-pill ${confidenceClass(confidence)}`} title={`Extraction confidence ${pct}%`}>{pct}%</span>;
}

function LowConfidenceBanner({ rfp }: { rfp: Rfp }): JSX.Element | null {
  const show = rfp.parseConfidence < LOW_CONFIDENCE_THRESHOLD || rfp.parseWarnings.length > 0;
  if (!show) return null;
  return (
    <div className="card rfp-amber" role="alert" style={{ marginTop: "1rem" }}>
      <p style={{ fontWeight: 700, margin: "0 0 0.4rem" }}>
        ⚠ Low-confidence parse ({Math.round(rfp.parseConfidence * 100)}%) — please review before drafting
      </p>
      {rfp.parseWarnings.length > 0 ? (
        <ul style={{ margin: 0 }}>
          {rfp.parseWarnings.map((warning, idx) => (
            <li key={idx}>{warning}</li>
          ))}
        </ul>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          The extractor wasn&apos;t fully confident about this document. Check the highlighted spans against each
          requirement.
        </p>
      )}
    </div>
  );
}

type InlineFieldProps = {
  action: (formData: FormData) => void | Promise<void>;
  hidden: Record<string, string>;
  name: string;
  label: string;
  value: string | null;
  multiline?: boolean;
  type?: string;
};

function InlineField({ action, hidden, name, label, value, multiline, type }: InlineFieldProps): JSX.Element {
  return (
    <form action={action} className="rfp-autosave rfp-field">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label>
        {label}
        {multiline ? (
          <textarea name={name} rows={3} defaultValue={value ?? ""} />
        ) : (
          <input name={name} type={type ?? "text"} defaultValue={value ?? ""} />
        )}
      </label>
      <button type="submit" className="btn secondary">Save</button>
    </form>
  );
}

function RequirementCard({ requirement }: { requirement: RfpRequirement }): JSX.Element {
  const weightPct = Math.round(requirement.weight * 100);
  return (
    <article className="card rfp-reqcard">
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "flex-start" }}>
        <span className="rfp-pill">{requirement.category ?? "general"}</span>
        <span style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
          {requirement.mandatory ? <span className="rfp-mand">Mandatory</span> : null}
          <ConfidencePill confidence={requirement.confidence} />
        </span>
      </div>

      <form action={updateRequirementFieldAction} className="rfp-autosave" style={{ marginTop: "0.5rem" }}>
        <input type="hidden" name="rfpId" value={requirement.rfpId} />
        <input type="hidden" name="requirementId" value={requirement.id} />
        <input type="hidden" name="field" value="text" />
        <textarea name="value" rows={2} defaultValue={requirement.text} aria-label="Requirement text" />
        <button type="submit" className="btn secondary">Save</button>
      </form>

      <div className="rfp-weightbar" title={`Weight ${weightPct}%`}>
        <span style={{ width: `${weightPct}%` }} />
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
        <form action={updateRequirementWeightAction} className="rfp-autosave" style={{ flex: "1 1 8rem" }}>
          <input type="hidden" name="rfpId" value={requirement.rfpId} />
          <input type="hidden" name="requirementId" value={requirement.id} />
          <input type="hidden" name="mandatory" value={requirement.mandatory ? "on" : ""} />
          <label style={{ fontSize: "0.78rem" }}>
            Weight ({weightPct}%)
            <input type="range" name="weight" min="0" max="100" defaultValue={weightPct} />
          </label>
        </form>
        <form action={updateRequirementFieldAction} className="rfp-autosave" style={{ flex: "1 1 10rem" }}>
          <input type="hidden" name="rfpId" value={requirement.rfpId} />
          <input type="hidden" name="requirementId" value={requirement.id} />
          <input type="hidden" name="field" value="sectionTitle" />
          <label style={{ fontSize: "0.78rem" }}>
            Proposal section
            <input name="value" defaultValue={requirement.sectionTitle ?? ""} />
          </label>
        </form>
        <form action={deleteRequirementAction}>
          <input type="hidden" name="rfpId" value={requirement.rfpId} />
          <input type="hidden" name="requirementId" value={requirement.id} />
          <button type="submit" className="btn secondary">Remove</button>
        </form>
      </div>
    </article>
  );
}

function CriteriaTable({ criteria }: { criteria: RfpCriterion[] }): JSX.Element | null {
  if (criteria.length === 0) return null;
  return (
    <section className="card" style={{ marginTop: "1rem" }}>
      <h2>Weighted evaluation criteria</h2>
      <table>
        <thead>
          <tr><th>Criterion</th><th>Weight</th><th>Confidence</th></tr>
        </thead>
        <tbody>
          {criteria.map((criterion) => (
            <tr key={criterion.id}>
              <td>
                {criterion.label}
                {criterion.description ? (
                  <span className="muted" style={{ display: "block", fontSize: "0.8rem" }}>{criterion.description}</span>
                ) : null}
              </td>
              <td style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(criterion.weight * 100)}%</td>
              <td>{Math.round(criterion.confidence * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function HeaderEditors({ rfp }: { rfp: Rfp }): JSX.Element {
  const deadlineInputValue = rfp.deadlineAt && !Number.isNaN(Date.parse(rfp.deadlineAt))
    ? new Date(Date.parse(rfp.deadlineAt)).toISOString().slice(0, 10)
    : "";
  return (
    <details className="card" style={{ marginTop: "1rem" }}>
      <summary style={{ fontWeight: 600 }}>Edit RFP details</summary>
      <div style={{ marginTop: "0.75rem" }}>
        <InlineField
          action={updateRfpFieldAction}
          hidden={{ id: rfp.id, field: "title" }}
          name="value"
          label="Title"
          value={rfp.title}
        />
        <InlineField
          action={updateRfpFieldAction}
          hidden={{ id: rfp.id, field: "issuer" }}
          name="value"
          label="Issuer / buyer"
          value={rfp.issuer}
        />
        <InlineField
          action={updateRfpFieldAction}
          hidden={{ id: rfp.id, field: "submissionFormat" }}
          name="value"
          label="Submission format"
          value={rfp.submissionFormat}
        />
        <form action={updateRfpPageLimitAction} className="rfp-autosave rfp-field">
          <input type="hidden" name="id" value={rfp.id} />
          <label>
            Page limit
            <input name="pageLimit" type="number" min="1" defaultValue={rfp.pageLimit ?? ""} />
          </label>
          <button type="submit" className="btn secondary">Save</button>
        </form>
        <form action={updateRfpDeadlineAction} className="rfp-autosave rfp-field">
          <input type="hidden" name="id" value={rfp.id} />
          <label>
            Deadline date
            <input name="deadlineAt" type="date" defaultValue={deadlineInputValue} />
          </label>
          <label>
            Deadline (as written)
            <input name="deadlineText" defaultValue={rfp.deadlineText ?? ""} />
          </label>
          <button type="submit" className="btn secondary">Save</button>
        </form>
      </div>
    </details>
  );
}

export default async function RfpDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const { organizationId } = await requireProposalAccess();
  const rfp = await getRfp(organizationId, params.id);
  if (!rfp) notFound();

  const [requirements, criteria] = await Promise.all([
    getRfpRequirements(organizationId, rfp.id),
    getRfpCriteria(organizationId, rfp.id),
  ]);
  const sections = groupBySection(
    requirements.map((r) => ({ ...r, sectionKey: r.sectionKey ?? "scope_of_work", sectionTitle: r.sectionTitle ?? "Scope of Work" })),
  );
  const pct = Math.round(rfp.parseConfidence * 100);

  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: DETAIL_STYLES }} />
      <p>
        <Link href="/rfps" className="btn secondary">← Back to RFPs</Link>
      </p>

      <div className="rfp-headergrid">
        <h1 style={{ margin: 0 }}>{rfp.title ?? "Untitled RFP"}</h1>
        <DeadlineChip deadlineAt={rfp.deadlineAt} />
        {rfp.isRegulated ? (
          <span className="rfp-pill conf-amber" title="Regulated-industry RFP">
            ⚖ {rfp.regulatedIndustry ?? "Regulated industry"}
          </span>
        ) : null}
      </div>
      <p className="muted">
        {rfp.issuer ? `${rfp.issuer} · ` : ""}
        {requirements.length} requirement{requirements.length === 1 ? "" : "s"} · {criteria.length} criteria · parse
        confidence {pct}%
        {rfp.submissionFormat ? ` · ${rfp.submissionFormat}` : ""}
        {rfp.pageLimit ? ` · ${rfp.pageLimit}-page limit` : ""}
        {rfp.isScanned ? " · transcribed from a scanned PDF" : ""}
      </p>

      <LowConfidenceBanner rfp={rfp} />

      <HeaderEditors rfp={rfp} />

      <div className="rfp-split" style={{ marginTop: "1.5rem" }}>
        <section aria-label="RFP source text">
          <h2>Source text</h2>
          <p className="muted" style={{ fontSize: "0.8rem" }}>
            Requirement spans are highlighted. Edit any requirement on the right.
          </p>
          <div className="card rfp-source">
            {rfp.rawText.trim().length > 0 ? (
              <HighlightedSource rawText={rfp.rawText} requirements={requirements} />
            ) : (
              <span className="muted">No source text stored.</span>
            )}
          </div>
        </section>

        <section aria-label="Requirements">
          <h2>Requirements</h2>
          {requirements.length === 0 ? (
            <div className="empty">
              <p className="muted">No requirements were extracted. Re-parse, or add them to the source and try again.</p>
            </div>
          ) : (
            sections.map((group) => (
              <div key={group.key}>
                <h3 className="rfp-section-h">{group.title} <span className="muted">({group.requirements.length})</span></h3>
                {group.requirements.map((requirement) => (
                  <RequirementCard key={requirement.id} requirement={requirement} />
                ))}
              </div>
            ))
          )}

          <CriteriaTable criteria={criteria} />

          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap" }}>
            <form action={reparseRfpAction}>
              <input type="hidden" name="id" value={rfp.id} />
              <button type="submit" className="btn secondary">Re-parse source</button>
            </form>
            <form action={deleteRfpAction}>
              <input type="hidden" name="id" value={rfp.id} />
              <button type="submit" className="btn secondary">Delete RFP</button>
            </form>
          </div>
        </section>
      </div>

      <script dangerouslySetInnerHTML={{ __html: AUTOSAVE_SCRIPT }} />
    </main>
  );
}
