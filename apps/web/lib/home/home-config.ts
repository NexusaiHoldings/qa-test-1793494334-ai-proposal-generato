/**
 * home-config — the company's root surface (company-root-landing-001 +
 * homepage-composition-001). Written by provisioning (_step_substrate_install)
 * from the homepage composer / CTO home_mode + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeFeature {
  title: string;
  body: string;
}

export interface SectionImage {
  url?: string;
  alt?: string;
  caption?: string;
}

export interface HeroSection {
  type: "hero";
  eyebrow?: string;
  headline: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  image?: SectionImage;
}
export interface StatsSection {
  type: "stats";
  title?: string;
  stats: { value: string; label: string }[];
}
export interface HowItWorksSection {
  type: "how_it_works";
  title?: string;
  subhead?: string;
  steps: { title: string; body: string }[];
}
export interface FeatureGridSection {
  type: "feature_grid";
  title?: string;
  subhead?: string;
  features: HomeFeature[];
}
export interface FeatureSpotlightSection {
  type: "feature_spotlight";
  title?: string;
  items: { title: string; body: string; image?: SectionImage }[];
}
export interface SocialProofSection {
  type: "social_proof";
  title?: string;
  quotes: { quote: string; author?: string; role?: string }[];
}
export interface FaqSection {
  type: "faq";
  title?: string;
  items: { q: string; a: string }[];
}
export interface PricingTeaserSection {
  type: "pricing_teaser";
  title?: string;
  subhead?: string;
  tiers: {
    name: string;
    price?: string;
    period?: string;
    features: string[];
    cta?: HomeCta;
    highlighted?: boolean;
  }[];
}
export interface GallerySection {
  type: "gallery";
  title?: string;
  images: SectionImage[];
}
export interface CtaBandSection {
  type: "cta_band";
  headline: string;
  subhead?: string;
  cta?: HomeCta;
}

export type HomeSection =
  | HeroSection
  | StatsSection
  | HowItWorksSection
  | FeatureGridSection
  | FeatureSpotlightSection
  | SocialProofSection
  | FaqSection
  | PricingTeaserSection
  | GallerySection
  | CtaBandSection;

export interface HomeConfig {
  mode: "landing" | "conversation";
  sections?: HomeSection[];
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  featuresTitle?: string;
  features?: HomeFeature[];
  closingHeadline?: string;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "Stop letting RFP responses eat your billable hours. (customer_evidence.verbatim_language: 'The manual proposal process\u2026",
  "subhead": "Upload the RFP and get a tailored first-draft consulting proposal \u2014 scope, pricing, timeline, and team bio \u2014 that is assembled from your own case-study library and researched against the prospect's company profile in under 30 minutes\u2026",
  "sections": [
    {
      "type": "hero",
      "headline": "Win More Clients. Spend 30 Minutes, Not 8 Hours.",
      "eyebrow": "AI Proposal Generator for Freelance Consultants",
      "subhead": "Upload an RFP and get a tailored, first-draft consulting proposal \u2014 executive summary, scope, timeline, pricing, and team bio \u2014 grounded in your own case studies and rate card. Free to try, no credit card required.",
      "primaryCta": {
        "label": "Generate Your First Proposal Free",
        "href": "/signup"
      },
      "secondaryCta": {
        "label": "See How It Works",
        "href": "#how-it-works"
      },
      "image": {
        "url": "hero_image"
      }
    },
    {
      "type": "stats",
      "stats": [
        {
          "value": "6 hrs",
          "label": "saved per proposal on average"
        },
        {
          "value": "< 30 min",
          "label": "from RFP upload to polished first draft"
        },
        {
          "value": "5M+",
          "label": "paid freelancers on Upwork & Fiverr Pro alone"
        },
        {
          "value": "$5K\u2013$25K",
          "label": "typical project value our users are chasing"
        }
      ],
      "title": "The numbers behind every proposal you write"
    },
    {
      "type": "how_it_works",
      "steps": [
        {
          "title": "Upload the RFP and prospect brief",
          "body": "Drop in the client's RFP document or paste a structured brief. The AI extracts requirements, evaluation criteria, and key deadlines so nothing gets missed."
        },
        {
          "title": "We pull from your practice library",
          "body": "Your verified profile, rate card, and case-study library are already on file. The AI selects the most relevant past work and frames it to match this specific client's language and priorities."
        },
        {
          "title": "Review, refine, and send",
          "body": "Get a complete draft \u2014 executive summary, understanding of need, approach and scope, timeline, team bio, relevant experience, pricing, and assumptions \u2014 in under 30 minutes. Edit inline, then export to PDF or DOCX."
        }
      ],
      "title": "From RFP to ready-to-send in three steps",
      "subhead": "No blank page. No copy-paste scramble. Just a structured, client-ready draft that sounds like you."
    },
    {
      "type": "feature_spotlight",
      "items": [
        {
          "title": "Proposals grounded in your real case studies",
          "body": "Generic AI writes generic proposals. Ours cites your actual engagements \u2014 client context, measurable outcomes, your role \u2014 matched to what this RFP is asking for. Your track record does the persuading, not boilerplate."
        },
        {
          "title": "Pricing and scope that reflect your rate card",
          "body": "Enter your rates once. The AI builds a pricing table and scope narrative consistent with your practice economics \u2014 no embarrassing mismatches between the narrative and the numbers, and no manual spreadsheet gymnastics."
        },
        {
          "title": "Every section the evaluator expects",
          "body": "Executive summary, understanding of need, proposed approach, detailed scope, project timeline, team and qualifications, relevant experience, pricing, and assumptions \u2014 structured to match formal RFP evaluation rubrics, not just a cover letter."
        }
      ],
      "title": "Built for consultants who compete on quality, not just speed"
    },
    {
      "type": "feature_grid",
      "features": [
        {
          "title": "RFP parsing and requirement extraction",
          "body": "The AI reads the full RFP, identifies mandatory requirements, scoring criteria, and submission instructions so your proposal addresses every evaluation point."
        },
        {
          "title": "Prospect company brief",
          "body": "Provide a dated prospect brief and the AI tailors tone, industry framing, and referenced challenges to that specific buyer \u2014 not a generic client archetype."
        },
        {
          "title": "Case-study library management",
          "body": "Upload past project write-ups once. Tag by industry, service line, and outcome. The AI surfaces the right ones automatically for each new proposal."
        },
        {
          "title": "Inline editing and version history",
          "body": "Refine any section directly in the editor. Every save is versioned so you can compare drafts or roll back a change before sending."
        },
        {
          "title": "PDF and DOCX export",
          "body": "Export a cleanly formatted proposal ready to attach to an email or portal submission \u2014 no reformatting required."
        },
        {
          "title": "Pay-per-proposal flexibility",
          "body": "Busy month? Add a $25 credit pack for extra proposals beyond your plan cap without changing your subscription tier."
        }
      ],
      "title": "Everything your proposal workflow needs",
      "subhead": "Purpose-built for solo and two-person consulting practices responding to formal RFPs at least three times a month."
    },
    {
      "type": "social_proof",
      "quotes": [
        {
          "quote": "I used to block off a full Sunday for every serious RFP. Now I have a solid first draft before lunch on Friday and I'm actually improving it instead of starting from scratch.",
          "author": "Independent marketing consultant",
          "role": "Solo practice, 12 years experience"
        },
        {
          "quote": "The pricing section alone saves me an hour. It pulls my rate card, builds the table, and writes the assumptions language \u2014 all the stuff I always put off until the last minute.",
          "author": "IT strategy consultant",
          "role": "Two-person practice, US-based"
        },
        {
          "quote": "My case studies were sitting in a Google Drive folder doing nothing. Now they're the best part of every proposal I send.",
          "author": "Fractional CMO",
          "role": "Solo practice, B2B SaaS focus"
        }
      ],
      "title": "What consultants say after their first proposal"
    },
    {
      "type": "pricing_teaser",
      "tiers": [
        {
          "name": "Starter",
          "features": [
            "1 proposal to try the full product",
            "RFP parsing and requirement extraction",
            "Case-study library (up to 3 entries)",
            "PDF and DOCX export",
            "No credit card required"
          ],
          "price": "Free"
        },
        {
          "name": "Professional",
          "features": [
            "Up to 15 proposals per month",
            "Unlimited case-study library entries",
            "Prospect company brief integration",
            "Version history and inline editing",
            "Priority support",
            "Annual plan available at $890/yr (save ~25%)"
          ],
          "price": "$99",
          "period": "mo",
          "highlighted": true
        },
        {
          "name": "Pay-per-proposal",
          "features": [
            "Top up beyond your plan cap anytime",
            "Same full-draft quality as Professional",
            "No subscription required",
            "Credits never expire"
          ],
          "price": "$25",
          "period": "per proposal credit pack"
        }
      ],
      "title": "Simple plans. Cancel any time.",
      "subhead": "Start with one free proposal \u2014 no credit card needed. Upgrade when you're ready to make this your unfair advantage."
    },
    {
      "type": "faq",
      "items": [
        {
          "q": "Will the proposal actually sound like me, or like a robot?",
          "a": "The draft is built from your own case studies, your rate card, and your practice profile \u2014 not a generic template. You'll still want to review and add your voice in places, but the structure, cited experience, and pricing will already reflect how you work."
        },
        {
          "q": "What file formats can I upload for the RFP?",
          "a": "You can upload PDF or DOCX files, or paste the RFP text directly. The AI extracts requirements, evaluation criteria, and deadlines from whichever format you provide."
        },
        {
          "q": "How do I get my case studies into the system?",
          "a": "Upload them as documents or paste write-ups directly into the case-study library. Tag each one by industry, service line, and outcome \u2014 the AI uses those tags to match the right work to each new RFP automatically."
        },
        {
          "q": "What happens when I hit my monthly proposal cap?",
          "a": "You can purchase a $25 pay-per-proposal credit pack to cover additional proposals without changing your subscription tier. Credits don't expire, so they roll over to the next month."
        },
        {
          "q": "Is my client and proposal data kept private?",
          "a": "Your data is used only to generate your proposals \u2014 it is never used to train shared models or shared with other users. EU, EEA, and UK users: data residency and DPA terms are in progress; we'll notify you as soon as those regions are fully supported."
        }
      ],
      "title": "Questions consultants ask before signing up"
    },
    {
      "type": "cta_band",
      "headline": "Your next proposal is already 6 hours shorter.",
      "subhead": "Generate your first full proposal free \u2014 no credit card, no setup fee, no blank page."
    }
  ]
};
