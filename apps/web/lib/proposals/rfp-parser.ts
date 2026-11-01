/**
 * RFP parsing + persistence (F1-004).
 *
 * rfp-text.ts gives us the raw text; this module turns it into the structured
 * intake the split view renders:
 *   - requirements (each with a relative weight, a per-field confidence, a
 *     mandatory flag, and the source span to highlight),
 *   - weighted evaluation criteria the buyer scores against,
 *   - the submission deadline, submission format, and page limit,
 * each with a confidence and a list of parse_warnings so a low-confidence parse
 * shows an amber banner with specific warnings rather than a generic error.
 *
 * Extraction routes through the Nexus gateway to a Claude Sonnet-class model (no
 * fine-tuning, no self-hosted inference, NEVER the OpenAI/Anthropic SDK — those
 * are banned in company apps; we call the gateway over HTTP). When the gateway is
 * unavailable the module degrades to a deterministic heuristic parser so the
 * consultant always gets a draft they can correct inline.
 *
 * Regulated-industry RFPs (legal / medical / financial, per the
 * liability_assessor) are detected here and flagged on the row.
 *
 * This module also owns the RFP data-access layer (raw SQL via @/lib/db buildDb,
 * every query parameterized and scoped to organizationId; all IDs UUID). It lives
 * here rather than a separate queries module because the (proposals) carve-out
 * for F1-004 keeps the RFP domain code in these three lib files.
 */
import { buildDb } from "@/lib/db";
import { mapRequirementsToSections } from "@/lib/proposals/section-mapper";

export type RfpStatus = "parsing" | "ready" | "drafted" | "error";

export type ParsedRequirement = {
  text: string;
  category: string | null;
  /** Relative importance 0..1 (used for the weight bar). */
  weight: number;
  /** Per-field extraction confidence 0..1 (drives the confidence pill). */
  confidence: number;
  mandatory: boolean;
  spanStart: number | null;
  spanEnd: number | null;
};

export type ParsedCriterion = {
  label: string;
  description: string | null;
  /** Evaluation weight 0..1 (as published by the buyer, normalised). */
  weight: number;
  confidence: number;
};

export type ParsedRfp = {
  title: string | null;
  issuer: string | null;
  submissionFormat: string | null;
  pageLimit: number | null;
  deadlineAt: string | null;
  deadlineText: string | null;
  requirements: ParsedRequirement[];
  criteria: ParsedCriterion[];
  confidence: number;
  warnings: string[];
  isRegulated: boolean;
  regulatedIndustry: string | null;
  model: string;
};

/** Below this overall confidence the UI shows the amber low-confidence banner. */
export const LOW_CONFIDENCE_THRESHOLD = 0.55;

const MAX_PARSE_CHARS = 120_000;

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

const PARSE_SYSTEM_PROMPT = `You extract the structured intake of a Request For Proposal (RFP) document.
Return ONLY a JSON object (no prose, no markdown fences) with these keys:
  "title": the RFP title (string or null),
  "issuer": the issuing organisation/buyer (string or null),
  "submissionFormat": how the proposal must be submitted, e.g. "PDF via email", "online portal" (string or null),
  "pageLimit": maximum page count as an integer if stated (number or null),
  "deadlineText": the submission deadline exactly as written (string or null),
  "deadlineAt": the deadline as an ISO-8601 datetime if you can resolve it (string or null),
  "requirements": array of objects, each { "text": the requirement, "category": one of overview|scope|approach|timeline|team|pricing|compliance|submission or null, "weight": 0..1 relative importance, "confidence": 0..1 how sure you are, "mandatory": boolean (true for "shall"/"must"/"required") },
  "criteria": array of objects, each { "label": the evaluation criterion, "description": string or null, "weight": 0..1 of the total score, "confidence": 0..1 },
  "confidence": 0..1 your overall confidence in this parse,
  "warnings": array of short strings describing anything ambiguous, missing, or low-confidence.
Be faithful to the document. Do not invent requirements, criteria, deadlines, or page limits that are not present. If a field is absent, use null and add a warning.`;

type ParsedModelJson = Record<string, unknown>;

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded > 0 ? rounded : null;
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 100) / 100;
}

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "yes", "1", "mandatory", "required"].includes(value.toLowerCase());
  return false;
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
        try {
          return JSON.parse(text.slice(start, i + 1)) as ParsedModelJson;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Locate a requirement's source span in the raw text so the split view can
 * highlight it. Tries an exact match, then the first distinctive run of words.
 * Returns null spans when the requirement was paraphrased beyond recognition.
 */
export function locateSpan(rawText: string, requirement: string): { start: number | null; end: number | null } {
  const needle = requirement.trim();
  if (needle.length === 0) return { start: null, end: null };

  const exact = rawText.indexOf(needle);
  if (exact >= 0) return { start: exact, end: exact + needle.length };

  // Fall back to the first ~8 words as an anchor.
  const words = needle.split(/\s+/).slice(0, 8).join(" ");
  if (words.length >= 12) {
    const idx = rawText.toLowerCase().indexOf(words.toLowerCase());
    if (idx >= 0) return { start: idx, end: idx + words.length };
  }
  return { start: null, end: null };
}

/** Normalise criteria weights to sum to 1 when the published weights don't. */
function normaliseCriteriaWeights(criteria: ParsedCriterion[]): ParsedCriterion[] {
  const total = criteria.reduce((sum, c) => sum + (c.weight > 0 ? c.weight : 0), 0);
  if (total <= 0) {
    if (criteria.length === 0) return criteria;
    const even = Math.round((1 / criteria.length) * 100) / 100;
    return criteria.map((c) => ({ ...c, weight: even }));
  }
  // If weights already look like fractions summing to ~1, keep them; else scale.
  if (Math.abs(total - 1) <= 0.1) return criteria;
  return criteria.map((c) => ({ ...c, weight: Math.round((c.weight / total) * 100) / 100 }));
}

const REGULATED_INDUSTRIES: { industry: string; keywords: string[] }[] = [
  {
    industry: "Medical / Healthcare",
    keywords: ["hipaa", "phi", "patient", "clinical", "medical device", "fda", "healthcare", "ehr", "hl7"],
  },
  {
    industry: "Financial / Banking",
    keywords: ["sox", "pci dss", "pci-dss", "finra", "sec ", "aml", "kyc", "basel", "gramm-leach", "financial services", "fdic"],
  },
  {
    industry: "Legal / Government",
    keywords: ["far clause", "dfars", "cjis", "gdpr", "legal counsel", "statute", "litigation", "public records", "foia"],
  },
];

/**
 * Detect whether an RFP is in a regulated industry (legal / medical / financial)
 * so the row can be flagged. Returns the matched industry label, or null.
 */
export function detectRegulatedIndustry(text: string): string | null {
  const lower = text.toLowerCase();
  for (const { industry, keywords } of REGULATED_INDUSTRIES) {
    if (keywords.some((keyword) => lower.includes(keyword))) return industry;
  }
  return null;
}

function normaliseRequirements(value: unknown, rawText: string): ParsedRequirement[] {
  if (!Array.isArray(value)) return [];
  const requirements: ParsedRequirement[] = [];
  for (const raw of value) {
    const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const text = record ? asText(record.text) ?? asText(record.requirement) : asText(raw);
    if (!text) continue;
    const span = locateSpan(rawText, text);
    requirements.push({
      text,
      category: record ? asText(record.category) : null,
      weight: record ? clamp01(record.weight, 0.5) : 0.5,
      confidence: record ? clamp01(record.confidence, 0.6) : 0.6,
      mandatory: record ? asBool(record.mandatory) : /\b(shall|must|required)\b/i.test(text),
      spanStart: span.start,
      spanEnd: span.end,
    });
    if (requirements.length >= 200) break;
  }
  return requirements;
}

function normaliseCriteria(value: unknown): ParsedCriterion[] {
  if (!Array.isArray(value)) return [];
  const criteria: ParsedCriterion[] = [];
  for (const raw of value) {
    const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const label = record ? asText(record.label) ?? asText(record.name) : asText(raw);
    if (!label) continue;
    criteria.push({
      label,
      description: record ? asText(record.description) : null,
      weight: record ? clamp01(record.weight, 0) : 0,
      confidence: record ? clamp01(record.confidence, 0.6) : 0.6,
    });
    if (criteria.length >= 50) break;
  }
  return normaliseCriteriaWeights(criteria);
}

function buildWarnings(parsed: ParsedRfp, modelWarnings: string[]): string[] {
  const warnings = new Set<string>(modelWarnings);
  if (parsed.requirements.length === 0) warnings.add("No requirements were detected — review the source text and add them manually.");
  if (!parsed.deadlineAt && !parsed.deadlineText) warnings.add("No submission deadline was found — confirm the due date before relying on the countdown.");
  if (!parsed.submissionFormat) warnings.add("Submission format was not detected.");
  if (parsed.pageLimit === null) warnings.add("No page limit was detected.");
  if (parsed.criteria.length === 0) warnings.add("No weighted evaluation criteria were detected.");
  const lowConf = parsed.requirements.filter((r) => r.confidence < 0.5).length;
  if (lowConf > 0) warnings.add(`${lowConf} requirement${lowConf === 1 ? "" : "s"} were extracted with low confidence — verify them.`);
  return Array.from(warnings);
}

function normaliseParse(parsed: ParsedModelJson, rawText: string, model: string, baseConfidence: number): ParsedRfp {
  const requirements = normaliseRequirements(parsed.requirements, rawText);
  const criteria = normaliseCriteria(parsed.criteria);
  const regulatedIndustry = detectRegulatedIndustry(rawText);
  const modelWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.map((w) => asText(w)).filter((w): w is string => Boolean(w))
    : [];

  const result: ParsedRfp = {
    title: asText(parsed.title),
    issuer: asText(parsed.issuer) ?? asText(parsed.buyer),
    submissionFormat: asText(parsed.submissionFormat),
    pageLimit: asInt(parsed.pageLimit),
    deadlineAt: coerceDeadline(asText(parsed.deadlineAt), asText(parsed.deadlineText)),
    deadlineText: asText(parsed.deadlineText),
    requirements,
    criteria,
    confidence: clamp01(parsed.confidence, baseConfidence),
    warnings: [],
    isRegulated: regulatedIndustry !== null,
    regulatedIndustry,
    model,
  };
  result.warnings = buildWarnings(result, modelWarnings);
  return result;
}

/** Coerce a deadline into an ISO string, trying the model value then the text. */
function coerceDeadline(deadlineAt: string | null, deadlineText: string | null): string | null {
  for (const candidate of [deadlineAt, deadlineText]) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Heuristic fallback parser (used when the gateway is unavailable).
// ---------------------------------------------------------------------------

const REQUIREMENT_TRIGGERS = /\b(shall|must|required to|is required|will provide|should|responsible for|at a minimum|the vendor|the contractor|the proposer|the bidder)\b/i;
const MANDATORY_TRIGGERS = /\b(shall|must|required|mandatory)\b/i;

const CATEGORY_HINTS: { category: string; pattern: RegExp }[] = [
  { category: "pricing", pattern: /\b(price|pricing|cost|budget|fee|rate|payment)\b/i },
  { category: "timeline", pattern: /\b(timeline|schedule|milestone|deadline|deliver(?:y|ed) by|weeks|months)\b/i },
  { category: "team", pattern: /\b(team|staff|personnel|qualification|experience|references|resume|cv|certification)\b/i },
  { category: "compliance", pattern: /\b(comply|compliance|regulation|hipaa|gdpr|soc 2|security|privacy|insurance|liability|confidential)\b/i },
  { category: "submission", pattern: /\b(submit|submission|format|page limit|font|due|deliver to|email to)\b/i },
  { category: "approach", pattern: /\b(approach|methodology|technical|architecture|implementation|process)\b/i },
  { category: "scope", pattern: /\b(scope|deliverable|service|task|functionality)\b/i },
];

function categoryFor(text: string): string | null {
  for (const { category, pattern } of CATEGORY_HINTS) {
    if (pattern.test(text)) return category;
  }
  return null;
}

/** Split raw text into candidate requirement lines (bullets, numbered, "shall"). */
function candidateLines(text: string): string[] {
  const lines: string[] = [];
  const rawLines = text.split(/\r?\n/);
  for (const line of rawLines) {
    const trimmed = line.trim().replace(/^[-*••]\s*/, "").replace(/^\d+[.)]\s*/, "").replace(/^[a-z][.)]\s*/i, "");
    if (trimmed.length >= 20 && trimmed.length <= 600) lines.push(trimmed);
  }
  // Also mine sentences containing requirement triggers from long paragraphs.
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim());
  for (const sentence of sentences) {
    if (sentence.length >= 20 && sentence.length <= 600 && REQUIREMENT_TRIGGERS.test(sentence)) {
      lines.push(sentence);
    }
  }
  return lines;
}

function detectPageLimit(text: string): number | null {
  const patterns = [
    /\b(?:maximum|max\.?|no more than|not exceed(?:ing)?|limit(?:ed)? to|up to)\s+(\d{1,3})\s+pages\b/i,
    /\b(\d{1,3})[\s-]?page\s+(?:limit|maximum|max)\b/i,
    /\bpage\s+limit\s*[:\-]?\s*(\d{1,3})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > 0 && n < 1000) return n;
    }
  }
  return null;
}

function detectSubmissionFormat(text: string): string | null {
  const lower = text.toLowerCase();
  const signals: { label: string; test: RegExp }[] = [
    { label: "Online procurement portal", test: /\bportal\b|\be-?procurement\b|\bupload (?:to|via)\b/ },
    { label: "PDF via email", test: /\bpdf\b.*\bemail\b|\bemail\b.*\bpdf\b/ },
    { label: "Email submission", test: /\bemail (?:your |the )?(?:proposal|submission|response)\b|\bsubmit.*\bemail\b/ },
    { label: "PDF document", test: /\bpdf\b/ },
    { label: "Sealed physical copies", test: /\bsealed\b|\bhard cop(?:y|ies)\b|\bmail to\b|\bdeliver.*\baddress\b/ },
  ];
  for (const { label, test } of signals) {
    if (test.test(lower)) return label;
  }
  return null;
}

function detectDeadline(text: string): { iso: string | null; text: string | null } {
  const patterns = [
    /\b(?:due|deadline|submission[s]?\s+due|proposals?\s+due|closing\s+date|responses?\s+due)\b[^.\n]{0,40}?((?:\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}|(?:\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}))/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const rawDate = match[1].trim();
      const parsed = Date.parse(rawDate);
      return {
        iso: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
        text: match[0].trim(),
      };
    }
  }
  return { iso: null, text: null };
}

function detectCriteria(text: string): ParsedCriterion[] {
  const criteria: ParsedCriterion[] = [];
  const seen = new Set<string>();
  // Lines like "Technical approach — 40%" or "Price (30 points)".
  const pattern = /([A-Z][A-Za-z /&-]{3,60}?)\s*[\-—:(]*\s*(\d{1,3})\s*(%|points?|pts)\)?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const label = match[1].trim().replace(/\s+/g, " ");
    const value = Number(match[2]);
    const key = label.toLowerCase();
    if (seen.has(key) || label.length < 4 || !Number.isFinite(value)) continue;
    seen.add(key);
    criteria.push({ label, description: null, weight: value > 1 ? value / 100 : value, confidence: 0.4 });
    if (criteria.length >= 20) break;
  }
  return normaliseCriteriaWeights(criteria);
}

/**
 * Deterministic fallback parser. Mines requirement-like lines, evaluation
 * criteria, deadline, page limit, and submission format with regex heuristics.
 * Confidence is intentionally low so the consultant knows to review.
 */
export function heuristicParse(rawText: string): ParsedRfp {
  const text = rawText.slice(0, MAX_PARSE_CHARS);
  const lines = candidateLines(text);

  const seen = new Set<string>();
  const requirements: ParsedRequirement[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    // Keep only lines that read like requirements.
    if (!REQUIREMENT_TRIGGERS.test(line) && !/^[A-Z0-9]/.test(line)) continue;
    seen.add(key);
    const span = locateSpan(text, line);
    requirements.push({
      text: line,
      category: categoryFor(line),
      weight: MANDATORY_TRIGGERS.test(line) ? 0.75 : 0.4,
      confidence: REQUIREMENT_TRIGGERS.test(line) ? 0.45 : 0.3,
      mandatory: MANDATORY_TRIGGERS.test(line),
      spanStart: span.start,
      spanEnd: span.end,
    });
    if (requirements.length >= 120) break;
  }

  const deadline = detectDeadline(text);
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 6) ?? null;

  const result: ParsedRfp = {
    title: firstLine ? firstLine.slice(0, 160) : null,
    issuer: null,
    submissionFormat: detectSubmissionFormat(text),
    pageLimit: detectPageLimit(text),
    deadlineAt: deadline.iso,
    deadlineText: deadline.text,
    requirements,
    criteria: detectCriteria(text),
    confidence: requirements.length > 0 ? 0.4 : 0.2,
    warnings: [],
    isRegulated: detectRegulatedIndustry(text) !== null,
    regulatedIndustry: detectRegulatedIndustry(text),
    model: "heuristic-fallback",
  };
  result.warnings = buildWarnings(result, [
    "Parsed with the offline heuristic parser (the AI gateway was unavailable) — please review every field.",
  ]);
  return result;
}

/**
 * Parse an RFP from raw text. Tries the Nexus gateway (Claude Sonnet-class)
 * first, falling back to the heuristic parser on any error or missing config.
 */
export async function parseRfp(rawText: string): Promise<ParsedRfp> {
  const text = rawText.trim().slice(0, MAX_PARSE_CHARS);
  if (text.length === 0) {
    return {
      title: null,
      issuer: null,
      submissionFormat: null,
      pageLimit: null,
      deadlineAt: null,
      deadlineText: null,
      requirements: [],
      criteria: [],
      confidence: 0,
      warnings: ["The document had no text to parse."],
      isRegulated: false,
      regulatedIndustry: null,
      model: "none",
    };
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
          max_tokens: 4000,
          system: PARSE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: `Parse this RFP document:\n\n${text}` }],
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
            ? payload.content.map((part) => (typeof part === "string" ? part : part.text ?? "")).join("")
            : "");
        const parsed = raw ? parseFirstJsonObject(raw) : null;
        if (parsed) {
          return normaliseParse(parsed, text, payload.model || model, 0.7);
        }
      }
      console.warn(
        JSON.stringify({
          level: "warn",
          at: "rfp-parser.parseRfp",
          msg: "gateway parse unusable; using heuristic fallback",
          status: response.status,
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          at: "rfp-parser.parseRfp",
          msg: "gateway parse failed; using heuristic fallback",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return heuristicParse(text);
}

// ---------------------------------------------------------------------------
// Persistence / data-access layer (raw SQL via @/lib/db, scoped to org).
// ---------------------------------------------------------------------------

export type Rfp = {
  id: string;
  organizationId: string;
  sourceFileId: string | null;
  sourceKind: string;
  title: string | null;
  issuer: string | null;
  rawText: string;
  status: string;
  submissionFormat: string | null;
  pageLimit: number | null;
  deadlineAt: string | null;
  deadlineText: string | null;
  parseConfidence: number;
  parseWarnings: string[];
  isScanned: boolean;
  isRegulated: boolean;
  regulatedIndustry: string | null;
  extractionModel: string | null;
  requirementCount: number;
  createdAt: string;
  updatedAt: string;
};

export type RfpRequirement = {
  id: string;
  rfpId: string;
  requirementIndex: number;
  text: string;
  category: string | null;
  weight: number;
  confidence: number;
  mandatory: boolean;
  spanStart: number | null;
  spanEnd: number | null;
  sectionKey: string | null;
  sectionTitle: string | null;
};

export type RfpCriterion = {
  id: string;
  rfpId: string;
  criterionIndex: number;
  label: string;
  description: string | null;
  weight: number;
  confidence: number;
};

interface RawRfpRow {
  id: string;
  organizationId: string;
  sourceFileId: string | null;
  sourceKind: string;
  title: string | null;
  issuer: string | null;
  rawText: string | null;
  status: string;
  submissionFormat: string | null;
  pageLimit: number | string | null;
  deadlineAt: string | null;
  deadlineText: string | null;
  parseConfidence: number | string;
  parseWarnings: unknown;
  isScanned: boolean;
  isRegulated: boolean;
  regulatedIndustry: string | null;
  extractionModel: string | null;
  requirementCount: number | string;
  createdAt: string;
  updatedAt: string;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function coerceWarnings(value: unknown): string[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === "string");
}

function mapRfpRow(row: RawRfpRow): Rfp {
  return {
    id: row.id,
    organizationId: row.organizationId,
    sourceFileId: row.sourceFileId,
    sourceKind: row.sourceKind,
    title: row.title,
    issuer: row.issuer,
    rawText: row.rawText ?? "",
    status: row.status,
    submissionFormat: row.submissionFormat,
    pageLimit: row.pageLimit === null ? null : Number(row.pageLimit),
    deadlineAt: row.deadlineAt,
    deadlineText: row.deadlineText,
    parseConfidence: Number(row.parseConfidence) || 0,
    parseWarnings: coerceWarnings(row.parseWarnings),
    isScanned: Boolean(row.isScanned),
    isRegulated: Boolean(row.isRegulated),
    regulatedIndustry: row.regulatedIndustry,
    extractionModel: row.extractionModel,
    requirementCount: Number(row.requirementCount) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const RFP_SELECT = `
  r.id,
  r.organization_id AS "organizationId",
  r.source_file_id AS "sourceFileId",
  r.source_kind AS "sourceKind",
  r.title,
  r.issuer,
  r.raw_text AS "rawText",
  r.status,
  r.submission_format AS "submissionFormat",
  r.page_limit AS "pageLimit",
  r.deadline_at AS "deadlineAt",
  r.deadline_text AS "deadlineText",
  r.parse_confidence AS "parseConfidence",
  r.parse_warnings AS "parseWarnings",
  r.is_scanned AS "isScanned",
  r.is_regulated AS "isRegulated",
  r.regulated_industry AS "regulatedIndustry",
  r.extraction_model AS "extractionModel",
  r.created_at AS "createdAt",
  r.updated_at AS "updatedAt",
  (SELECT COUNT(*) FROM proposals_rfp_requirements req WHERE req.rfp_id = r.id) AS "requirementCount"
`;

export async function listRfps(organizationId: string): Promise<Rfp[]> {
  const db = buildDb();
  const rows = await db.query<RawRfpRow>(
    `SELECT ${RFP_SELECT}
       FROM proposals_rfps r
      WHERE r.organization_id = $1
      ORDER BY r.created_at DESC`,
    organizationId,
  );
  return rows.map(mapRfpRow);
}

export async function getRfp(organizationId: string, id: string): Promise<Rfp | null> {
  const db = buildDb();
  const rows = await db.query<RawRfpRow>(
    `SELECT ${RFP_SELECT}
       FROM proposals_rfps r
      WHERE r.organization_id = $1 AND r.id = $2
      LIMIT 1`,
    organizationId,
    id,
  );
  return rows.length > 0 ? mapRfpRow(rows[0]) : null;
}

interface RawRequirementRow {
  id: string;
  rfpId: string;
  requirementIndex: number | string;
  text: string;
  category: string | null;
  weight: number | string;
  confidence: number | string;
  mandatory: boolean;
  spanStart: number | string | null;
  spanEnd: number | string | null;
  sectionKey: string | null;
  sectionTitle: string | null;
}

export async function getRfpRequirements(
  organizationId: string,
  rfpId: string,
): Promise<RfpRequirement[]> {
  const db = buildDb();
  const rows = await db.query<RawRequirementRow>(
    `SELECT
        id,
        rfp_id AS "rfpId",
        requirement_index AS "requirementIndex",
        text,
        category,
        weight,
        confidence,
        mandatory,
        span_start AS "spanStart",
        span_end AS "spanEnd",
        section_key AS "sectionKey",
        section_title AS "sectionTitle"
       FROM proposals_rfp_requirements
      WHERE organization_id = $1 AND rfp_id = $2
      ORDER BY requirement_index ASC`,
    organizationId,
    rfpId,
  );
  return rows.map((row) => ({
    id: row.id,
    rfpId: row.rfpId,
    requirementIndex: Number(row.requirementIndex),
    text: row.text,
    category: row.category,
    weight: Number(row.weight) || 0,
    confidence: Number(row.confidence) || 0,
    mandatory: Boolean(row.mandatory),
    spanStart: row.spanStart === null ? null : Number(row.spanStart),
    spanEnd: row.spanEnd === null ? null : Number(row.spanEnd),
    sectionKey: row.sectionKey,
    sectionTitle: row.sectionTitle,
  }));
}

interface RawCriterionRow {
  id: string;
  rfpId: string;
  criterionIndex: number | string;
  label: string;
  description: string | null;
  weight: number | string;
  confidence: number | string;
}

export async function getRfpCriteria(
  organizationId: string,
  rfpId: string,
): Promise<RfpCriterion[]> {
  const db = buildDb();
  const rows = await db.query<RawCriterionRow>(
    `SELECT
        id,
        rfp_id AS "rfpId",
        criterion_index AS "criterionIndex",
        label,
        description,
        weight,
        confidence
       FROM proposals_rfp_criteria
      WHERE organization_id = $1 AND rfp_id = $2
      ORDER BY criterion_index ASC`,
    organizationId,
    rfpId,
  );
  return rows.map((row) => ({
    id: row.id,
    rfpId: row.rfpId,
    criterionIndex: Number(row.criterionIndex),
    label: row.label,
    description: row.description,
    weight: Number(row.weight) || 0,
    confidence: Number(row.confidence) || 0,
  }));
}

export type CreateRfpInput = {
  organizationId: string;
  createdByUserId: string;
  sourceFileId: string | null;
  sourceKind: string;
  rawText: string;
  isScanned: boolean;
  parsed: ParsedRfp;
  extraWarnings?: string[];
};

/**
 * Persist a parsed RFP plus its requirements and evaluation criteria. Each
 * requirement is mapped to a proposal section before insert. Returns the new RFP
 * id. The RFP lands in status 'ready' (it has been parsed synchronously).
 */
export async function createRfpWithDetails(input: CreateRfpInput): Promise<string> {
  const db = buildDb();
  const warnings = Array.from(new Set([...(input.extraWarnings ?? []), ...input.parsed.warnings]));

  const rows = await db.query<{ id: string }>(
    `INSERT INTO proposals_rfps
       (organization_id, source_file_id, source_kind, title, issuer, raw_text,
        status, submission_format, page_limit, deadline_at, deadline_text,
        parse_confidence, parse_warnings, is_scanned, is_regulated,
        regulated_industry, extraction_model, created_by_user_id)
     VALUES
       ($1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13::jsonb, $14, $15,
        $16, $17, $18)
     RETURNING id`,
    input.organizationId,
    input.sourceFileId,
    input.sourceKind,
    input.parsed.title,
    input.parsed.issuer,
    input.rawText,
    "ready",
    input.parsed.submissionFormat,
    input.parsed.pageLimit,
    input.parsed.deadlineAt,
    input.parsed.deadlineText,
    input.parsed.confidence,
    JSON.stringify(warnings),
    input.isScanned,
    input.parsed.isRegulated,
    input.parsed.regulatedIndustry,
    input.parsed.model,
    input.createdByUserId,
  );
  const rfpId = rows[0].id;

  await insertRequirements(input.organizationId, rfpId, input.parsed.requirements);
  await insertCriteria(input.organizationId, rfpId, input.parsed.criteria);

  return rfpId;
}

/** Insert the mapped requirements for an RFP (replacing any existing ones). */
export async function insertRequirements(
  organizationId: string,
  rfpId: string,
  requirements: ParsedRequirement[],
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `DELETE FROM proposals_rfp_requirements WHERE organization_id = $1 AND rfp_id = $2`,
    organizationId,
    rfpId,
  );

  const mapped = mapRequirementsToSections(requirements);
  for (let i = 0; i < mapped.length; i += 1) {
    const req = mapped[i];
    await db.execute(
      `INSERT INTO proposals_rfp_requirements
         (rfp_id, organization_id, requirement_index, text, category, weight,
          confidence, mandatory, span_start, span_end, section_key, section_title)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      rfpId,
      organizationId,
      i,
      req.text,
      req.category,
      req.weight,
      req.confidence,
      req.mandatory,
      req.spanStart,
      req.spanEnd,
      req.sectionKey,
      req.sectionTitle,
    );
  }
}

/** Insert the evaluation criteria for an RFP (replacing any existing ones). */
export async function insertCriteria(
  organizationId: string,
  rfpId: string,
  criteria: ParsedCriterion[],
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `DELETE FROM proposals_rfp_criteria WHERE organization_id = $1 AND rfp_id = $2`,
    organizationId,
    rfpId,
  );
  for (let i = 0; i < criteria.length; i += 1) {
    const criterion = criteria[i];
    await db.execute(
      `INSERT INTO proposals_rfp_criteria
         (rfp_id, organization_id, criterion_index, label, description, weight, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      rfpId,
      organizationId,
      i,
      criterion.label,
      criterion.description,
      criterion.weight,
      criterion.confidence,
    );
  }
}

/** Editable top-level RFP text fields a consultant can correct inline. */
const EDITABLE_RFP_FIELDS: Record<string, string> = {
  title: "title",
  issuer: "issuer",
  submissionFormat: "submission_format",
  deadlineText: "deadline_text",
  regulatedIndustry: "regulated_industry",
};

export async function updateRfpField(
  organizationId: string,
  id: string,
  field: string,
  value: string | null,
): Promise<boolean> {
  const column = EDITABLE_RFP_FIELDS[field];
  if (!column) return false;
  const db = buildDb();
  await db.execute(
    `UPDATE proposals_rfps SET ${column} = $1, updated_at = now()
      WHERE id = $2 AND organization_id = $3`,
    value,
    id,
    organizationId,
  );
  return true;
}

/** Update the page limit (integer) or deadline (timestamptz) on an RFP. */
export async function updateRfpPageLimit(
  organizationId: string,
  id: string,
  pageLimit: number | null,
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE proposals_rfps SET page_limit = $1, updated_at = now()
      WHERE id = $2 AND organization_id = $3`,
    pageLimit,
    id,
    organizationId,
  );
}

export async function updateRfpDeadline(
  organizationId: string,
  id: string,
  deadlineAt: string | null,
  deadlineText: string | null,
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE proposals_rfps SET deadline_at = $1, deadline_text = $2, updated_at = now()
      WHERE id = $3 AND organization_id = $4`,
    deadlineAt,
    deadlineText,
    id,
    organizationId,
  );
}

export async function setRfpStatus(
  organizationId: string,
  id: string,
  status: RfpStatus,
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE proposals_rfps SET status = $1, updated_at = now()
      WHERE id = $2 AND organization_id = $3`,
    status,
    id,
    organizationId,
  );
}

export async function setRfpRegulated(
  organizationId: string,
  id: string,
  isRegulated: boolean,
  regulatedIndustry: string | null,
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE proposals_rfps SET is_regulated = $1, regulated_industry = $2, updated_at = now()
      WHERE id = $3 AND organization_id = $4`,
    isRegulated,
    regulatedIndustry,
    id,
    organizationId,
  );
}

/** Editable fields on an individual requirement (inline edit in the cards). */
const EDITABLE_REQUIREMENT_FIELDS: Record<string, string> = {
  text: "text",
  category: "category",
  sectionTitle: "section_title",
  sectionKey: "section_key",
};

export async function updateRequirementTextField(
  organizationId: string,
  requirementId: string,
  field: string,
  value: string | null,
): Promise<boolean> {
  const column = EDITABLE_REQUIREMENT_FIELDS[field];
  if (!column) return false;
  const db = buildDb();
  await db.execute(
    `UPDATE proposals_rfp_requirements SET ${column} = $1, updated_at = now()
      WHERE id = $2 AND organization_id = $3`,
    value,
    requirementId,
    organizationId,
  );
  return true;
}

export async function updateRequirementWeight(
  organizationId: string,
  requirementId: string,
  weight: number,
  mandatory: boolean,
): Promise<void> {
  const db = buildDb();
  const clamped = weight < 0 ? 0 : weight > 1 ? 1 : weight;
  await db.execute(
    `UPDATE proposals_rfp_requirements SET weight = $1, mandatory = $2, updated_at = now()
      WHERE id = $3 AND organization_id = $4`,
    clamped,
    mandatory,
    requirementId,
    organizationId,
  );
}

export async function deleteRequirement(
  organizationId: string,
  requirementId: string,
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `DELETE FROM proposals_rfp_requirements WHERE id = $1 AND organization_id = $2`,
    requirementId,
    organizationId,
  );
}

export async function deleteRfp(organizationId: string, id: string): Promise<void> {
  const db = buildDb();
  await db.execute(
    `DELETE FROM proposals_rfp_requirements WHERE organization_id = $1 AND rfp_id = $2`,
    organizationId,
    id,
  );
  await db.execute(
    `DELETE FROM proposals_rfp_criteria WHERE organization_id = $1 AND rfp_id = $2`,
    organizationId,
    id,
  );
  await db.execute(
    `DELETE FROM proposals_rfps WHERE organization_id = $1 AND id = $2`,
    organizationId,
    id,
  );
}

/** Update the raw text + re-parsed intake of an existing RFP (re-parse flow). */
export async function updateRfpParse(
  organizationId: string,
  id: string,
  rawText: string,
  parsed: ParsedRfp,
  isScanned: boolean,
): Promise<void> {
  const db = buildDb();
  const warnings = JSON.stringify(parsed.warnings);
  await db.execute(
    `UPDATE proposals_rfps
        SET raw_text = $1, title = COALESCE($2, title), issuer = COALESCE($3, issuer),
            submission_format = $4, page_limit = $5, deadline_at = $6, deadline_text = $7,
            parse_confidence = $8, parse_warnings = $9::jsonb, is_scanned = $10,
            is_regulated = $11, regulated_industry = $12, extraction_model = $13,
            status = 'ready', updated_at = now()
      WHERE id = $14 AND organization_id = $15`,
    rawText,
    parsed.title,
    parsed.issuer,
    parsed.submissionFormat,
    parsed.pageLimit,
    parsed.deadlineAt,
    parsed.deadlineText,
    parsed.confidence,
    warnings,
    isScanned,
    parsed.isRegulated,
    parsed.regulatedIndustry,
    parsed.model,
    id,
    organizationId,
  );
  await insertRequirements(organizationId, id, parsed.requirements);
  await insertCriteria(organizationId, id, parsed.criteria);
}
