/**
 * /rfps/new — the single-screen dropzone hero (F1-004).
 *
 * The deliberate contrast to a template builder (incumbent_gripes): one large
 * dashed drop target, a "paste instead" toggle, and the reassurance line
 * "Never used to train models. Deleted on your schedule." The consultant drops a
 * PDF/DOCX (or pastes the RFP text) and createRfpAction extracts + parses it,
 * then redirects to the split view.
 */
import type { JSX } from "react";
import Link from "next/link";
import { requireProposalAccess } from "@/lib/proposals/access";
import { createRfpAction } from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_STYLES = `
.rfp-hero { max-width: 44rem; margin: 0 auto; }
.rfp-drop { border:2px dashed var(--accent, #4f46e5); border-radius:0.9rem; padding:2.5rem 1.5rem; text-align:center; }
.rfp-drop input[type=file] { margin-top:0.75rem; }
.rfp-reassure { text-align:center; margin-top:1rem; font-size:0.9rem; }
.rfp-cta { background: var(--accent, #4f46e5); color:#fff; border-color: var(--accent, #4f46e5); }
.rfp-toggle { margin-top:1rem; }
.rfp-cloud { display:flex; justify-content:center; margin-bottom:0.75rem; }
`;

// Progressive enhancement: the "paste instead" toggle swaps the dropzone for a
// textarea without JS via <details>; this script also wires drag-over styling.
const HERO_SCRIPT = `
(function(){
  function wire(){
    var drop = document.getElementById('rfp-drop');
    var input = document.getElementById('rfp-file');
    if (!drop || !input) return;
    ['dragenter','dragover'].forEach(function(ev){
      drop.addEventListener(ev, function(e){ e.preventDefault(); drop.style.opacity='0.7'; });
    });
    ['dragleave','drop'].forEach(function(ev){
      drop.addEventListener(ev, function(e){ e.preventDefault(); drop.style.opacity='1'; });
    });
    drop.addEventListener('drop', function(e){
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
      }
    });
  }
  if (document.readyState !== 'loading') wire();
  else document.addEventListener('DOMContentLoaded', wire);
})();
`;

function ErrorBanner({ error }: { error: string | undefined }): JSX.Element | null {
  if (!error) return null;
  const messages: Record<string, string> = {
    unreadable:
      "We couldn't read that file — it may be a scanned or image-only document we couldn't transcribe. Paste the text instead below.",
    empty: "Add a file or paste the RFP text before continuing.",
  };
  return (
    <p className="card" role="alert" style={{ borderColor: "#b91c1c" }}>
      {messages[error] ?? "Something went wrong. Please try again."}
    </p>
  );
}

function UploadCloud(): JSX.Element {
  return (
    <span className="rfp-cloud" aria-hidden="true">
      <svg width="72" height="56" viewBox="0 0 72 56" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 42 a12 12 0 0 1 1 -24 a16 16 0 0 1 30 4 a10 10 0 0 1 -1 20 Z" opacity="0.5" />
        <line x1="36" y1="46" x2="36" y2="26" />
        <polyline points="28,34 36,26 44,34" />
      </svg>
    </span>
  );
}

export default async function NewRfpPage({
  searchParams,
}: {
  searchParams: { error?: string };
}): Promise<JSX.Element> {
  await requireProposalAccess();

  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: PAGE_STYLES }} />
      <div className="rfp-hero">
        <p>
          <Link href="/rfps" className="btn secondary">← Back to RFPs</Link>
        </p>
        <h1>A new RFP landed?</h1>
        <p>
          Drop it here. We extract the requirements, weighted evaluation criteria, deadline, submission format
          and page limits — with a confidence score on every field — in seconds. No template to fill in.
        </p>

        <ErrorBanner error={searchParams?.error} />

        <form action={createRfpAction} encType="multipart/form-data">
          <div className="rfp-drop" id="rfp-drop">
            <UploadCloud />
            <p style={{ fontWeight: 700, margin: "0 0 0.25rem", fontSize: "1.1rem" }}>
              Drop your RFP here
            </p>
            <p className="muted" style={{ margin: 0 }}>
              PDF, DOCX, or plain text. Scanned PDFs are transcribed automatically.
            </p>
            <input
              type="file"
              name="file"
              id="rfp-file"
              accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            />
          </div>

          <details className="rfp-toggle">
            <summary className="muted">Paste the text instead</summary>
            <label>
              RFP text
              <textarea
                name="pastedText"
                rows={10}
                placeholder="Paste the full RFP text here — requirements, evaluation criteria, deadline, submission instructions…"
              />
            </label>
          </details>

          <p style={{ marginTop: "1rem", textAlign: "center" }}>
            <button type="submit" className="btn rfp-cta">Extract requirements</button>
          </p>
        </form>

        <p className="rfp-reassure muted">
          🔒 Never used to train models. Deleted on your schedule.
        </p>
      </div>

      <script dangerouslySetInnerHTML={{ __html: HERO_SCRIPT }} />
    </main>
  );
}
