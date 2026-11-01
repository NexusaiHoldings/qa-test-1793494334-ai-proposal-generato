/**
 * RFP text extraction (F1-004).
 *
 * The trigger-event surface: the consultant drops a PDF/DOCX or pastes text when
 * "a new RFP lands with a hard deadline". This module pulls the text layer out of
 * the uploaded document:
 *   - text/* and JSON: decoded directly as UTF-8.
 *   - PDF: parsed with `unpdf` (ESM) via a runtime import so Next never bundles
 *     the server-only parser (the substrate's next.config.js is off-limits, so
 *     serverExternalPackages is unavailable).
 *   - DOCX: parsed with `mammoth` (CJS) via an inline require for the same reason.
 *
 * Scanned / image-only PDFs have no text layer (feasibility key_technical_risk
 * #1: "highly variable RFP document formats"). Rather than adding an OCR library,
 * those are routed to the Nexus gateway with the PDF as a document input for
 * vision extraction. When the gateway can't help (or isn't configured) the caller
 * is told the document is scanned so the UI can fall back to "paste the text
 * instead".
 *
 * NEVER the OpenAI / Anthropic SDK (banned in company apps) — all model calls go
 * over HTTP through the Nexus gateway, keyed on server-side env.
 */

/** Raised when a document can't be turned into usable text. */
export class UnreadableRfpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableRfpError";
  }
}

export type ExtractRfpInput = {
  bytes: Buffer;
  mimeType: string;
  filename: string;
};

export type ExtractedRfpText = {
  text: string;
  /** True when the PDF had no usable text layer and vision extraction was used. */
  isScanned: boolean;
  /** Human-readable notes surfaced to the consultant (e.g. scanned-PDF route). */
  warnings: string[];
  /** Which path produced the text: "text" | "pdf" | "docx" | "vision". */
  source: string;
};

/** Upper bound on extracted text we keep for parsing (keeps token budgets sane). */
export const MAX_RFP_TEXT_CHARS = 120_000;

/** Below this many characters a PDF text layer is treated as "scanned". */
const MIN_TEXT_LAYER_CHARS = 40;

/**
 * Runtime-only module resolution, opaque to webpack AND the TypeScript type
 * checker. `unpdf` (ESM) and `mammoth` (CJS) are optional server-only parsers:
 * if the company added them to apps/web/package.json they are used; otherwise the
 * lookup throws at call time and we degrade gracefully (scanned-PDF route or the
 * paste fallback). Hiding the specifiers keeps `next build` green either way (no
 * TS2307, no webpack bundling of Node-native parsers). Mirrors the pattern in
 * case-study-extract.ts.
 */
// eslint-disable-next-line no-new-func
const runtimeImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<unknown>;

function runtimeRequire(specifier: string): unknown {
  // eslint-disable-next-line no-eval
  return (eval("require") as (m: string) => unknown)(specifier);
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

const VISION_SYSTEM_PROMPT = `You are an OCR/vision transcriber. Transcribe the full readable text of the attached RFP document verbatim, preserving headings, numbered requirements, tables (as readable rows), deadlines, and submission instructions. Return ONLY the transcribed text with no commentary.`;

/**
 * Route a scanned / image-only PDF to the gateway as a document input for vision
 * transcription. Returns the transcribed text, or null when the gateway is
 * unavailable or returns nothing usable (the caller then offers the paste
 * fallback).
 */
export async function extractScannedPdfViaGateway(
  bytes: Buffer,
  filename: string,
): Promise<string | null> {
  const config = gatewayConfig();
  if (!config) return null;

  const model = process.env.NEXUS_VISION_MODEL || process.env.NEXUS_LLM_MODEL || "claude-sonnet-class";
  const base64 = bytes.toString("base64");

  try {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: VISION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: base64 },
              },
              {
                type: "text",
                text: `Transcribe the full text of this RFP document (${filename}).`,
              },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          level: "warn",
          at: "rfp-text.extractScannedPdfViaGateway",
          msg: "gateway vision call returned non-OK",
          status: response.status,
        }),
      );
      return null;
    }
    const payload = (await response.json()) as {
      content?: ({ text?: string } | string)[];
      output_text?: string;
    };
    const raw =
      payload.output_text ??
      (Array.isArray(payload.content)
        ? payload.content
            .map((part) => (typeof part === "string" ? part : part.text ?? ""))
            .join("")
        : "");
    const trimmed = (raw || "").trim();
    return trimmed.length >= MIN_TEXT_LAYER_CHARS ? trimmed.slice(0, MAX_RFP_TEXT_CHARS) : null;
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        at: "rfp-text.extractScannedPdfViaGateway",
        msg: "gateway vision call failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/** Decode a plain-text / markdown / JSON upload directly. */
function decodeText(bytes: Buffer): string {
  const text = bytes.toString("utf-8").trim();
  if (text.length === 0) throw new UnreadableRfpError("The file is empty.");
  return text.slice(0, MAX_RFP_TEXT_CHARS);
}

/** Parse a DOCX upload with mammoth (inline require keeps it server-only). */
async function extractDocx(bytes: Buffer): Promise<string> {
  try {
    const mammoth = runtimeRequire("mammoth") as {
      extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
    };
    const result = await mammoth.extractRawText({ buffer: bytes });
    const trimmed = (result.value || "").trim();
    if (trimmed.length < MIN_TEXT_LAYER_CHARS) {
      throw new UnreadableRfpError("The Word document had no readable text.");
    }
    return trimmed.slice(0, MAX_RFP_TEXT_CHARS);
  } catch (error) {
    if (error instanceof UnreadableRfpError) throw error;
    throw new UnreadableRfpError("We couldn't read this Word document. Paste the text instead.");
  }
}

/**
 * Extract the text layer from a PDF with unpdf. Returns null (not an error) when
 * no usable text layer is found so the caller can route the bytes to the gateway
 * for vision extraction before giving up.
 */
async function extractPdfTextLayer(bytes: Buffer): Promise<string | null> {
  try {
    const unpdf = (await runtimeImport("unpdf")) as {
      extractText: (
        data: Uint8Array,
        opts?: { mergePages?: boolean },
      ) => Promise<{ text: string | string[] }>;
    };
    const result = await unpdf.extractText(new Uint8Array(bytes), { mergePages: true });
    const text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
    const trimmed = (text || "").trim();
    return trimmed.length >= MIN_TEXT_LAYER_CHARS ? trimmed.slice(0, MAX_RFP_TEXT_CHARS) : null;
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        at: "rfp-text.extractPdfTextLayer",
        msg: "unpdf text-layer extraction failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/**
 * Pull usable text out of an uploaded RFP document, routing scanned PDFs to the
 * gateway for vision extraction. Raises UnreadableRfpError when nothing works so
 * the UI can offer the "paste the text instead" fallback.
 */
export async function extractRfpText(input: ExtractRfpInput): Promise<ExtractedRfpText> {
  const mime = (input.mimeType || "").toLowerCase();
  const name = (input.filename || "").toLowerCase();
  const warnings: string[] = [];

  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    name.endsWith(".txt") ||
    name.endsWith(".md")
  ) {
    return { text: decodeText(input.bytes), isScanned: false, warnings, source: "text" };
  }

  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    return { text: await extractDocx(input.bytes), isScanned: false, warnings, source: "docx" };
  }

  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    const textLayer = await extractPdfTextLayer(input.bytes);
    if (textLayer) {
      return { text: textLayer, isScanned: false, warnings, source: "pdf" };
    }

    // No text layer — route to the gateway as a document input for vision.
    const transcribed = await extractScannedPdfViaGateway(input.bytes, input.filename);
    if (transcribed) {
      warnings.push(
        "This looked like a scanned or image-only PDF, so the text was transcribed by vision extraction — double-check the parsed fields.",
      );
      return { text: transcribed, isScanned: true, warnings, source: "vision" };
    }

    throw new UnreadableRfpError(
      "This looks like a scanned or image-only PDF and we couldn't transcribe it. Paste the text instead.",
    );
  }

  throw new UnreadableRfpError(
    `Unsupported file type (${input.mimeType || "unknown"}). Upload a PDF, DOCX, or text file, or paste the text.`,
  );
}
