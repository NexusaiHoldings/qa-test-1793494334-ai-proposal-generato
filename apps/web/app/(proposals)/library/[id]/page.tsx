/**
 * /library/[id] — Case-Study detail + chunks preview (F1-003).
 *
 * The left column previews the extracted case study and the pgvector chunks it
 * was indexed into (the RAG corpus a proposal would retrieve from). The
 * right-side drawer edits any extracted field inline; each field autosaves (a
 * small progressive-enhancement script submits the field on change, and an
 * explicit Save button keeps it working without JavaScript). Visibility can be
 * toggled between anonymised and public, which re-indexes the narrative.
 */
import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProposalAccess } from "@/lib/proposals/access";
import {
  getCaseStudy,
  getCaseStudyChunks,
  type CaseStudy,
  type CaseStudyChunkRow,
} from "@/lib/proposals/library-queries";
import { clientInitials } from "@/lib/proposals/case-study-extract";
import {
  updateCaseStudyFieldAction,
  updateServicesAction,
  togglePublicAction,
  reindexCaseStudyAction,
  deleteCaseStudyAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DETAIL_STYLES = `
.cs-detail { display:grid; gap:1.5rem; grid-template-columns: 1fr minmax(18rem, 22rem); align-items:start; }
@media (max-width: 52rem) { .cs-detail { grid-template-columns: 1fr; } }
.cs-drawer { position:sticky; top:1rem; }
.cs-chunk { font-size:0.9rem; }
.cs-metric { font-size:1.6rem; font-weight:800; line-height:1.1; }
.cs-pill { display:inline-block; border:1px solid var(--substrate-border, currentColor); border-radius:999px; padding:0.1rem 0.6rem; font-size:0.8rem; }
.cs-avatar { display:inline-flex; align-items:center; justify-content:center; width:2.5rem; height:2.5rem; border-radius:999px; border:1px solid var(--substrate-border, currentColor); font-weight:700; flex-shrink:0; }
.cs-field { margin-bottom:0.75rem; }
.cs-saved { font-size:0.75rem; }
`;

// Progressive enhancement: autosave each inline field on change. The explicit
// Save button in every form keeps editing functional without JavaScript.
const AUTOSAVE_SCRIPT = `
(function(){
  function wire(){
    var forms = document.querySelectorAll('form.cs-autosave');
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

type EditableFieldProps = {
  caseStudyId: string;
  field: string;
  label: string;
  value: string | null;
  multiline?: boolean;
};

function EditableField({ caseStudyId, field, label, value, multiline }: EditableFieldProps): JSX.Element {
  return (
    <form action={updateCaseStudyFieldAction} className="cs-autosave cs-field">
      <input type="hidden" name="id" value={caseStudyId} />
      <input type="hidden" name="field" value={field} />
      <label>
        {label}
        {multiline ? (
          <textarea name="value" rows={4} defaultValue={value ?? ""} />
        ) : (
          <input name="value" defaultValue={value ?? ""} />
        )}
      </label>
      <button type="submit" className="btn secondary">Save</button>
    </form>
  );
}

function ChunkList({ chunks }: { chunks: CaseStudyChunkRow[] }): JSX.Element {
  if (chunks.length === 0) {
    return (
      <div className="empty">
        <p className="muted">No chunks indexed yet. Save edits, then re-index to rebuild the RAG corpus.</p>
      </div>
    );
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.75rem" }}>
      {chunks.map((chunk) => (
        <li key={chunk.id} className="card cs-chunk">
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
            <strong>Chunk {chunk.chunkIndex + 1}</strong>
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              ~{chunk.tokenEstimate} tokens · {chunk.embeddingModel ?? "unembedded"}
            </span>
          </div>
          <p style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}>{chunk.content}</p>
        </li>
      ))}
    </ul>
  );
}

function Header({ study }: { study: CaseStudy }): JSX.Element {
  const displayName = study.clientIsPublic && study.clientName ? study.clientName : null;
  const pct = Math.round(study.extractionConfidence * 100);
  return (
    <section className="card">
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <span className="cs-avatar" title={displayName ?? "Anonymised client"}>
          {clientInitials(displayName ?? study.clientName)}
        </span>
        <div>
          <p style={{ margin: 0, fontWeight: 700 }}>{displayName ?? "Anonymised client"}</p>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            {study.industry ?? "Uncategorised"}
            {study.duration ? ` · ${study.duration}` : ""} · extraction confidence {pct}%
          </p>
        </div>
      </div>
      {study.headlineMetric ? <p className="cs-metric" style={{ margin: "0.75rem 0 0" }}>{study.headlineMetric}</p> : null}
      {study.piiFlagged ? (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          ⚠ PII was detected in the source. Raw emails/phones/IDs are redacted before indexing
          {study.piiFindings.length > 0
            ? ` (${study.piiFindings.map((f) => `${f.count} ${f.kind}`).join(", ")}).`
            : "."}
        </p>
      ) : null}
    </section>
  );
}

export default async function CaseStudyDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const { organizationId } = await requireProposalAccess();
  const study = await getCaseStudy(organizationId, params.id);
  if (!study) notFound();

  const chunks = await getCaseStudyChunks(organizationId, study.id);

  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: DETAIL_STYLES }} />
      <p>
        <Link href="/library" className="btn secondary">← Back to library</Link>
      </p>
      <h1>{study.title ?? "Case study"}</h1>
      <p>Review and correct the extracted fields. Edits autosave; re-index to refresh the RAG corpus.</p>

      <Header study={study} />

      <div className="cs-detail" style={{ marginTop: "1.5rem" }}>
        <div style={{ display: "grid", gap: "1.5rem" }}>
          <section className="card">
            <h2>Extracted summary</h2>
            {study.problem ? (<><h3>Problem</h3><p style={{ whiteSpace: "pre-wrap" }}>{study.problem}</p></>) : null}
            {study.approach ? (<><h3>Approach</h3><p style={{ whiteSpace: "pre-wrap" }}>{study.approach}</p></>) : null}
            {study.outcomes ? (<><h3>Outcomes</h3><p style={{ whiteSpace: "pre-wrap" }}>{study.outcomes}</p></>) : null}

            {study.metrics.length > 0 ? (
              <>
                <h3>Quantified metrics</h3>
                <table>
                  <thead>
                    <tr><th>Metric</th><th>Value</th></tr>
                  </thead>
                  <tbody>
                    {study.metrics.map((metric, idx) => (
                      <tr key={`${metric.label}-${idx}`}>
                        <td>{metric.label}</td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{metric.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}

            {study.services.length > 0 ? (
              <>
                <h3>Services</h3>
                <p style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                  {study.services.map((service) => (
                    <span key={service} className="cs-pill">{service}</span>
                  ))}
                </p>
              </>
            ) : null}
          </section>

          <section className="card">
            <h2>Indexed chunks ({chunks.length})</h2>
            <p className="muted">
              The narrative split into pgvector embeddings — this is what proposal generation retrieves from.
            </p>
            <ChunkList chunks={chunks} />
          </section>
        </div>

        <aside className="card cs-drawer" aria-label="Edit case study">
          <h2>Edit fields</h2>
          <p className="muted">Changes autosave. Re-index after edits to rebuild the corpus.</p>

          <EditableField caseStudyId={study.id} field="title" label="Title" value={study.title} />
          <EditableField caseStudyId={study.id} field="clientName" label="Client name" value={study.clientName} />
          <EditableField caseStudyId={study.id} field="industry" label="Industry" value={study.industry} />
          <EditableField caseStudyId={study.id} field="headlineMetric" label="Headline metric" value={study.headlineMetric} />
          <EditableField caseStudyId={study.id} field="duration" label="Duration" value={study.duration} />
          <EditableField caseStudyId={study.id} field="problem" label="Problem" value={study.problem} multiline />
          <EditableField caseStudyId={study.id} field="approach" label="Approach" value={study.approach} multiline />
          <EditableField caseStudyId={study.id} field="outcomes" label="Outcomes" value={study.outcomes} multiline />

          <form action={updateServicesAction} className="cs-field">
            <input type="hidden" name="id" value={study.id} />
            <label>
              Services (comma separated)
              <input name="services" defaultValue={study.services.join(", ")} />
            </label>
            <button type="submit" className="btn secondary">Save services</button>
          </form>

          <form action={togglePublicAction} className="cs-field">
            <input type="hidden" name="id" value={study.id} />
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input type="checkbox" name="clientIsPublic" value="on" defaultChecked={study.clientIsPublic} />
              Client name is public (skip anonymisation)
            </label>
            <button type="submit" className="btn secondary">Apply &amp; re-index</button>
          </form>

          <form action={reindexCaseStudyAction} className="cs-field">
            <input type="hidden" name="id" value={study.id} />
            <button type="submit" className="btn">Re-index narrative</button>
          </form>

          <form action={deleteCaseStudyAction} className="cs-field">
            <input type="hidden" name="id" value={study.id} />
            <button type="submit" className="btn secondary">Delete case study</button>
          </form>
        </aside>
      </div>

      <script dangerouslySetInnerHTML={{ __html: AUTOSAVE_SCRIPT }} />
    </main>
  );
}
