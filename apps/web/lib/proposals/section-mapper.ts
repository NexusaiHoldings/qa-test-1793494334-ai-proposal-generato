/**
 * Requirement → proposal-section mapping (F1-004).
 *
 * After rfp-parser.ts extracts the requirements, each one is mapped onto a
 * section of a standard consulting-proposal outline so the split view on
 * /rfps/[id] can show "this requirement belongs in that section" and the
 * downstream generator (F1-005) knows where each requirement's response lands.
 *
 * The mapping is keyword/heuristic driven and deterministic — no model call —
 * because it runs for every requirement and the outline is stable. The gateway
 * already assigned a `category` per requirement during parsing; we use that as a
 * strong hint and fall back to scanning the requirement text.
 */

export type ProposalSection = {
  key: string;
  title: string;
  /** Category hints emitted by the parser that route to this section. */
  categories: string[];
  /** Keywords scanned in the requirement text when the category is unknown. */
  keywords: string[];
};

/**
 * The standard outline. Order matters: it is the section order of the generated
 * proposal, and the first matching section wins when several could apply.
 */
export const PROPOSAL_OUTLINE: ProposalSection[] = [
  {
    key: "executive_summary",
    title: "Executive Summary",
    categories: ["overview", "summary", "objective", "background"],
    keywords: ["overview", "objective", "background", "introduction", "purpose", "summary"],
  },
  {
    key: "scope_of_work",
    title: "Scope of Work",
    categories: ["scope", "deliverable", "requirement", "functional", "service"],
    keywords: [
      "scope",
      "deliverable",
      "shall provide",
      "must provide",
      "services",
      "tasks",
      "responsibilities",
      "functionality",
    ],
  },
  {
    key: "approach_methodology",
    title: "Approach & Methodology",
    categories: ["approach", "methodology", "technical", "implementation", "solution"],
    keywords: [
      "approach",
      "methodology",
      "method",
      "implementation",
      "technical",
      "architecture",
      "process",
      "how",
    ],
  },
  {
    key: "timeline",
    title: "Timeline & Milestones",
    categories: ["timeline", "schedule", "milestone", "deadline"],
    keywords: ["timeline", "schedule", "milestone", "phase", "duration", "delivery date", "weeks", "months"],
  },
  {
    key: "team_qualifications",
    title: "Team & Qualifications",
    categories: ["team", "qualification", "experience", "personnel", "staffing", "references"],
    keywords: [
      "team",
      "qualification",
      "experience",
      "cv",
      "resume",
      "personnel",
      "staff",
      "references",
      "case stud",
      "past performance",
      "certification",
    ],
  },
  {
    key: "pricing",
    title: "Pricing & Commercials",
    categories: ["pricing", "cost", "budget", "commercial", "fee"],
    keywords: ["price", "pricing", "cost", "budget", "fee", "rate", "payment", "commercial", "$"],
  },
  {
    key: "compliance",
    title: "Compliance & Legal",
    categories: ["compliance", "legal", "regulatory", "security", "privacy", "insurance"],
    keywords: [
      "compliance",
      "comply",
      "legal",
      "regulation",
      "regulatory",
      "hipaa",
      "gdpr",
      "soc 2",
      "security",
      "privacy",
      "insurance",
      "liability",
      "confidential",
    ],
  },
  {
    key: "submission_logistics",
    title: "Submission & Logistics",
    categories: ["submission", "format", "logistics", "administrative"],
    keywords: ["submit", "submission", "format", "page limit", "font", "deadline", "due", "deliver to", "email to"],
  },
];

/** Fallback section when nothing matches — keeps every requirement placed. */
const DEFAULT_SECTION: ProposalSection = PROPOSAL_OUTLINE[1]; // Scope of Work

export type RequirementLike = {
  text: string;
  category?: string | null;
};

export type SectionAssignment = {
  sectionKey: string;
  sectionTitle: string;
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

/** Count keyword hits for a section in the requirement text. */
function scoreSection(section: ProposalSection, text: string): number {
  let score = 0;
  for (const keyword of section.keywords) {
    if (text.includes(keyword)) score += 1;
  }
  return score;
}

/**
 * Map a single requirement to a proposal section. The parser's category hint is
 * authoritative when it matches a section; otherwise the requirement text is
 * keyword-scored and the best-scoring section wins (ties break toward outline
 * order). Always returns a placement — nothing is left unmapped.
 */
export function mapRequirementToSection(requirement: RequirementLike): SectionAssignment {
  const category = normalize(requirement.category);
  const text = normalize(requirement.text);

  if (category) {
    for (const section of PROPOSAL_OUTLINE) {
      if (section.categories.some((c) => category.includes(c) || c.includes(category))) {
        return { sectionKey: section.key, sectionTitle: section.title };
      }
    }
  }

  let best: ProposalSection = DEFAULT_SECTION;
  let bestScore = 0;
  for (const section of PROPOSAL_OUTLINE) {
    const score = scoreSection(section, text);
    if (score > bestScore) {
      best = section;
      bestScore = score;
    }
  }

  return { sectionKey: best.key, sectionTitle: best.title };
}

/** Map a batch of requirements, preserving input order. */
export function mapRequirementsToSections<T extends RequirementLike>(
  requirements: T[],
): (T & SectionAssignment)[] {
  return requirements.map((requirement) => ({
    ...requirement,
    ...mapRequirementToSection(requirement),
  }));
}

/**
 * Group mapped requirements under their section, in outline order, dropping
 * empty sections. Used by the split view to render the right-hand outline.
 */
export function groupBySection<T extends SectionAssignment>(
  requirements: T[],
): { key: string; title: string; requirements: T[] }[] {
  const groups: { key: string; title: string; requirements: T[] }[] = [];
  for (const section of PROPOSAL_OUTLINE) {
    const matched = requirements.filter((r) => r.sectionKey === section.key);
    if (matched.length > 0) {
      groups.push({ key: section.key, title: section.title, requirements: matched });
    }
  }
  // Catch any requirement whose sectionKey isn't in the outline (defensive).
  const placedKeys = new Set(groups.map((g) => g.key));
  const orphans = requirements.filter((r) => !placedKeys.has(r.sectionKey));
  if (orphans.length > 0) {
    groups.push({ key: "other", title: "Other", requirements: orphans });
  }
  return groups;
}
