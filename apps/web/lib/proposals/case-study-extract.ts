/**
 * Case-study extraction (F1-003).
 *
 * Addresses the objection "manually uploading and tagging case studies just
 * moves the work": the consultant drags in old proposals (PDF / DOCX) or pastes
 * text, and this module turns the raw document into a structured case study —
 * client (anonymised unless marked public), industry, problem, approach,
 * outcomes with quantified metrics, duration, services.
 *
 * Extraction routes through the Nexus gateway to a Claude Sonnet-class model (no
 * fine-tuning, no self-hosted inference, and NEVER the OpenAI/Anthropic SDK —
 * those are banned in company apps; we call the gateway over HTTP). When the
 * gateway is unavailable the module degrades to a deterministic heuristic
 * extractor so the consultant always gets a draft they can correct inline.
 *
 * PII leakage is checked before indexing (flag_anomaly_in_dataset intent): the
 * narrative is scanned for emails, phone numbers, and government IDs; findings
 * are surfaced on the case study and the client name is anonymised unless the
 * consultant marked it public.
 */

/** Native document parsers are server-only; see extractDocumentText. */
export class UnreadableDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableDocumentError";
  }
}

export type QuantifiedMetric = {
  label: string;
  value: string;
};

export type PiiFinding = {
  kind: "email" | "phone" | "gov_id" | "ssn";
  sample: string;
  count: number;
};

export type ExtractedCaseStudy = {
  title: string | null;
  clientName: string | null;
  industry: string | null;
  problem: string | null;
  approach: string | null;
  outcomes: string | null;
  headlineMetric: string | null;
  metrics: QuantifiedMetric[];
  services: string[];
  duration: string | null;
  confidence: number;
  model: string;
};

export type ExtractDocumentInput = {
  bytes: Buffer;
  mimeType: string;
  filename: string;
};

const MAX_EXTRACT_CHARS = 60_000;

/**
 * Runtime-only module resolution, opaque to webpack AND the TypeScript type
 * checker. `unpdf` (ESM) and `mammoth` (CJS) are optional server-only parsers:
 * if a company has added them to apps/web/package.json they are used; if not,
 * the dynamic lookup throws at call time and we fall back to "paste the text
 * instead". Hiding the specifiers here keeps `next build` green either way (no
 * TS2307, no webpack bundling of Node-native parsers).
 */
// eslint-disable-next-line no-new-func
const runtimeImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<unknown>;

function runtimeRequire(specifier: string): unknown {
  // eslint-disable-next-line no-eval
  return (eval("require") as (m: string) => unknown)(specifier);
}

/**
 * Pull a plain-text layer out of an uploaded document.
 *
 * - text/* and JSON: decoded directly as UTF-8.
 * - PDF: parsed with `unpdf` (ESM) via runtimeImport so Next never bundles the
 *   server-only parser (and the build stays green when it isn't installed).
 * - DOCX: parsed with `mammoth` (CJS) via runtimeRequire for the same reason.
 *
 * Any failure (unsupported type, image-only scan, corrupt bytes, or a parser
 * that isn't installed) raises
 * UnreadableDocumentError so the UI can offer the "paste the text instead"
 * fallback.
 */
export async function extractDocumentText(input: ExtractDocumentInput): Promise<string> {
  const mime = (input.mimeType || "").toLowerCase();
  const name = (input.filename || "").toLowerCase();

  if (mime.startsWith("text/") || mime === "application/json" || name.endsWith(".txt") || name.endsWith(".md")) {
    const text = input.bytes.toString("utf-8").trim();
    if (text.length === 0) throw new UnreadableDocumentError("The file is empty.");
    return text.slice(0, MAX_EXTRACT_CHARS);
  }

  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    try {
      const unpdf = (await runtimeImport("unpdf")) as {
        extractText: (
          data: Uint8Array,
          opts?: { mergePages?: boolean },
        ) => Promise<{ text: string | string[] }>;
      };
      const result = await unpdf.extractText(new Uint8Array(input.bytes), { mergePages: true });
      const text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
      const trimmed = (text || "").trim();
      if (trimmed.length < 20) {
        throw new UnreadableDocumentError(
          "No text layer found — this looks like a scanned or image-only PDF.",
        );
      }
      return trimmed.slice(0, MAX_EXTRACT_CHARS);
    } catch (error) {
      if (error instanceof UnreadableDocumentError) throw error;
      throw new UnreadableDocumentError(
        "We couldn't read this PDF. Paste the text instead.",
      );
    }
  }

  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    try {
      // Inline require keeps the CJS parser out of the client bundle (the
      // substrate's next.config.js is off-limits, so serverExternalPackages is
      // unavailable — same pattern as @/lib/db's pg require).
      const mammoth = runtimeRequire("mammoth") as {
        extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
      };
      const result = await mammoth.extractRawText({ buffer: input.bytes });
      const trimmed = (result.value || "").trim();
      if (trimmed.length < 20) {
        throw new UnreadableDocumentError("The document had no readable text.");
      }
      return trimmed.slice(0, MAX_EXTRACT_CHARS);
    } catch (error) {
      if (error instanceof UnreadableDocumentError) throw error;
      throw new UnreadableDocumentError(
        "We couldn't read this Word document. Paste the text instead.",
      );
    }
  }

  throw new UnreadableDocumentError(
    `Unsupported file type (${input.mimeType || "unknown"}). Upload a PDF, DOCX, or text file, or paste the text.`,
  );
}

/** Resolve the Nexus gateway base URL + key from server-side env. */
function gatewayConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrl =
    process.env.NEXUS_GATEWAY_URL ||
    process.env.PORTFOLIO_RUNTIME_URL ||
    process.env.RUNTIME_BASE_URL ||
    "";
  const apiKey =
    process.env.NEXUS_GATEWAY_API_KEY ||
    process.env.PORTFOLIO_RUNTIME_API_KEY ||
    process.env.RUNTIME_AUTH_TOKEN ||
    "";
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

const EXTRACTION_SYSTEM_PROMPT = `You extract a single structured case study from a consulting proposal or project document.
Return ONLY a JSON object (no prose, no markdown fences) with these keys:
  "title": short descriptive title (string or null),
  "clientName": the client/company name if stated (string or null),
  "industry": the client's industry/sector (string or null),
  "problem": the business problem or objective (string or null),
  "approach": what the consultant did (string or null),
  "outcomes": the measurable results (string or null),
  "headlineMetric": the single most impressive quantified result, e.g. "+38% pipeline in 90 days" (string or null),
  "metrics": array of { "label": string, "value": string } quantified results,
  "services": array of service/offering names,
  "duration": engagement duration if stated, e.g. "90 days" (string or null),
  "confidence": your confidence 0..1 that this extraction is accurate.
Be faithful to the document. Do not invent metrics that are not present.`;

type ParsedModelJson = Record<string, unknown>;

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function asMetrics(value: unknown): QuantifiedMetric[] {
  if (!Array.isArray(value)) return [];
  const metrics: QuantifiedMetric[] = [];
  for (const raw of value) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const label = asText(record.label) ?? asText(record.name);
      const metricValue = asText(record.value) ?? asText(record.amount);
      if (label && metricValue) metrics.push({ label, value: metricValue });
    } else if (typeof raw === "string" && raw.trim().length > 0) {
      metrics.push({ label: raw.trim(), value: raw.trim() });
    }
  }
  return metrics;
}

function clampConfidence(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 100) / 100;
}

/** Find and parse the first balanced JSON object in a model response. */
function parseFirstJsonObject(text: string): ParsedModelJson | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as ParsedModelJson;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeExtraction(parsed: ParsedModelJson, model: string, baseConfidence: number): ExtractedCaseStudy {
  const metrics = asMetrics(parsed.metrics);
  const headline = asText(parsed.headlineMetric) ?? (metrics[0] ? `${metrics[0].value} ${metrics[0].label}`.trim() : null);
  return {
    title: asText(parsed.title),
    clientName: asText(parsed.clientName) ?? asText(parsed.client),
    industry: asText(parsed.industry),
    problem: asText(parsed.problem),
    approach: asText(parsed.approach),
    outcomes: asText(parsed.outcomes),
    headlineMetric: headline,
    metrics,
    services: asStringArray(parsed.services),
    duration: asText(parsed.duration),
    confidence: clampConfidence(parsed.confidence, baseConfidence),
    model,
  };
}

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  "Technology / SaaS": ["saas", "software", "platform", "api", "cloud", "developer"],
  "Healthcare": ["health", "clinic", "patient", "hospital", "medical", "care"],
  "Financial Services": ["bank", "fintech", "finance", "insurance", "lending", "payments"],
  "Retail / E-commerce": ["retail", "ecommerce", "e-commerce", "store", "shopper", "merchandising"],
  "Manufacturing": ["manufactur", "factory", "supply chain", "production", "plant"],
  "Professional Services": ["consult", "agency", "law firm", "accounting", "advisory"],
  "Education": ["education", "university", "school", "student", "learning"],
  "Nonprofit": ["nonprofit", "ngo", "charity", "foundation"],
};

/** Heuristic metric detector: percentages, currency, multipliers, and counts. */
function detectMetrics(text: string): QuantifiedMetric[] {
  const metrics: QuantifiedMetric[] = [];
  const seen = new Set<string>();
  const patterns: { regex: RegExp; label: string }[] = [
    { regex: /([+\-]?\d+(?:\.\d+)?\s?%)/g, label: "Change" },
    { regex: /(\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|bn|billion|million|thousand)?)/gi, label: "Value" },
    { regex: /(\d+(?:\.\d+)?x)\b/gi, label: "Multiple" },
  ];
  for (const { regex, label } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const value = match[1].trim();
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Grab a short phrase of context after the metric for the label.
      const tail = text.slice(match.index, match.index + 80).replace(/\s+/g, " ");
      metrics.push({ label: tail.split(/[.;,\n]/)[0].trim() || label, value });
      if (metrics.length >= 8) return metrics;
    }
  }
  return metrics;
}

function firstSentencesMatching(text: string, keywords: string[], limit = 2): string | null {
  const sentences = text
    .split(/(?<=[.!?])\s+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const matched = sentences.filter((s) => keywords.some((k) => s.toLowerCase().includes(k)));
  const chosen = matched.slice(0, limit);
  return chosen.length > 0 ? chosen.join(" ") : null;
}

/**
 * Deterministic fallback extractor used when the gateway is unavailable. Pulls
 * metrics via regex and assembles problem/approach/outcome prose from keyword
 * heuristics. Confidence is intentionally low so the consultant knows to review.
 */
export function heuristicExtract(text: string): ExtractedCaseStudy {
  const metrics = detectMetrics(text);
  const headline = metrics[0] ? `${metrics[0].value} ${metrics[0].label}`.trim() : null;

  let industry: string | null = null;
  const lower = text.toLowerCase();
  for (const [name, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) {
      industry = name;
      break;
    }
  }

  const durationMatch = text.match(/\b(\d+\s?(?:days?|weeks?|months?|years?))\b/i);

  return {
    title: null,
    clientName: null,
    industry,
    problem: firstSentencesMatching(text, ["problem", "challenge", "needed", "objective", "goal", "struggl"]),
    approach: firstSentencesMatching(text, ["we ", "implemented", "approach", "delivered", "built", "designed", "strategy"]),
    outcomes: firstSentencesMatching(text, ["result", "outcome", "increased", "reduced", "grew", "improved", "achieved"]),
    headlineMetric: headline,
    metrics,
    services: [],
    duration: durationMatch ? durationMatch[1] : null,
    confidence: 0.35,
    model: "heuristic-fallback",
  };
}

/**
 * Extract a structured case study from raw document text. Tries the Nexus
 * gateway (Claude Sonnet-class) first, falling back to the heuristic extractor.
 */
export async function extractCaseStudy(documentText: string): Promise<ExtractedCaseStudy> {
  const text = documentText.trim().slice(0, MAX_EXTRACT_CHARS);
  if (text.length === 0) {
    throw new UnreadableDocumentError("There is no text to extract from.");
  }

  const config = gatewayConfig();
  const model = process.env.NEXUS_LLM_MODEL || "claude-sonnet-class";

  if (config) {
    try {
      const response = await fetch(`${config.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Extract the case study from this document:\n\n${text}`,
            },
          ],
        }),
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          content?: ({ text?: string } | string)[];
          output_text?: string;
          model?: string;
        };
        const raw =
          payload.output_text ??
          (Array.isArray(payload.content)
            ? payload.content
                .map((part) => (typeof part === "string" ? part : part.text ?? ""))
                .join("")
            : "");
        const parsed = raw ? parseFirstJsonObject(raw) : null;
        if (parsed) {
          return normalizeExtraction(parsed, payload.model || model, 0.75);
        }
      }
      console.warn(
        JSON.stringify({
          level: "warn",
          at: "case-study-extract.extractCaseStudy",
          msg: "gateway extraction unusable; using heuristic fallback",
          status: response.status,
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          at: "case-study-extract.extractCaseStudy",
          msg: "gateway extraction failed; using heuristic fallback",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return heuristicExtract(text);
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const GOV_ID_RE = /\b(?:[A-Z]{2}\d{6,9}|\d{9})\b/g;

function collectMatches(text: string, regex: RegExp): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    out.push(match[0]);
    if (out.length > 50) break;
  }
  return out;
}

/** Mask the middle of a PII sample so findings can be shown without leaking it. */
function maskSample(sample: string): string {
  const trimmed = sample.trim();
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}${"•".repeat(Math.min(6, trimmed.length - 4))}${trimmed.slice(-2)}`;
}

/**
 * PII leakage check (flag_anomaly_in_dataset intent). Scans narrative text for
 * emails, phone numbers, SSNs, and government-ID-shaped tokens before indexing.
 * Returns masked findings; the caller decides whether to anonymise.
 */
export function flagPiiAnomalies(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];

  const ssns = collectMatches(text, SSN_RE);
  if (ssns.length > 0) findings.push({ kind: "ssn", sample: maskSample(ssns[0]), count: ssns.length });

  const emails = collectMatches(text, EMAIL_RE);
  if (emails.length > 0) findings.push({ kind: "email", sample: maskSample(emails[0]), count: emails.length });

  const phones = collectMatches(text, PHONE_RE);
  if (phones.length > 0) findings.push({ kind: "phone", sample: maskSample(phones[0]), count: phones.length });

  const govIds = collectMatches(text, GOV_ID_RE).filter((id) => !ssns.includes(id));
  if (govIds.length > 0) findings.push({ kind: "gov_id", sample: maskSample(govIds[0]), count: govIds.length });

  return findings;
}

/** Redact raw PII from text before it is embedded into the RAG corpus. */
export function redactPii(text: string): string {
  return text
    .replace(SSN_RE, "[redacted-id]")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, "[redacted-phone]");
}

/** Initials for an anonymised client lockup (e.g. "Acme Corp" → "AC"). */
export function clientInitials(name: string | null): string {
  if (!name) return "••";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "••";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Compose the narrative that gets chunked + embedded. Client identity is only
 * included when the consultant marked the case study public; otherwise it is
 * replaced with a generic anonymised label so no confidential client name
 * enters the RAG corpus. Raw PII is always redacted.
 */
export function buildNarrative(
  study: Pick<
    ExtractedCaseStudy,
    "clientName" | "industry" | "problem" | "approach" | "outcomes" | "duration" | "services" | "metrics"
  >,
  clientIsPublic: boolean,
): string {
  const clientLabel = clientIsPublic && study.clientName ? study.clientName : "an anonymised client";
  const sections: string[] = [];

  sections.push(
    `Engagement with ${clientLabel}${study.industry ? ` in the ${study.industry} sector` : ""}.`,
  );
  if (study.problem) sections.push(`Problem: ${study.problem}`);
  if (study.approach) sections.push(`Approach: ${study.approach}`);
  if (study.outcomes) sections.push(`Outcomes: ${study.outcomes}`);
  if (study.metrics.length > 0) {
    sections.push(`Quantified results: ${study.metrics.map((m) => `${m.value} ${m.label}`.trim()).join("; ")}.`);
  }
  if (study.services.length > 0) sections.push(`Services delivered: ${study.services.join(", ")}.`);
  if (study.duration) sections.push(`Duration: ${study.duration}.`);

  return redactPii(sections.join("\n\n"));
}
