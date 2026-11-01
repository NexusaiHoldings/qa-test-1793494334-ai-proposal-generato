/**
 * /practice — Practice Profile + Rate Card (F1-002).
 *
 * The consultant's verified source of truth that proposal generation may quote
 * from: team bios (verbatim), a rate card, the practice vertical, a methodology
 * blurb, and a voice sample. A two-column settings canvas — a left rail of
 * sections (Team · Rates · Voice · Vertical) and the editable panels — with a
 * completion meter driving the first-run onboarding checklist. The rail
 * collapses to a segmented control at narrow widths.
 */
import type { JSX } from "react";
import { getPracticeSettings, type TeamMember } from "@/lib/proposals/practice";
import { requireProposalAccess } from "@/lib/proposals/access";
import {
  deleteRateBandAction,
  deleteTeamMemberAction,
  saveProfileAction,
  saveRateBandAction,
  saveTeamMemberAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VERTICAL_LABELS: Record<string, string> = {
  management: "Management",
  marketing: "Marketing",
  it: "IT",
  hr: "HR",
};

const PRICING_LABELS: Record<string, string> = {
  hourly: "Hourly",
  day: "Day",
  fixed_fee: "Fixed fee",
};

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatPrice(amountCents: number, currency: string): string {
  const amount = (amountCents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${amount}`;
}

function BioCard({ member }: { member: TeamMember }): JSX.Element {
  return (
    <li className="card">
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "2.75rem",
            height: "2.75rem",
            borderRadius: "999px",
            border: "1px solid var(--substrate-border, currentColor)",
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {initials(member.fullName)}
        </span>
        <div>
          <p style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>{member.fullName}</p>
          {member.title ? <p className="muted" style={{ margin: 0 }}>{member.title}</p> : null}
        </div>
      </div>

      {member.credentials.length > 0 ? (
        <p style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.5rem" }}>
          {member.credentials.map((credential) => (
            <span
              key={credential}
              style={{
                border: "1px solid var(--substrate-border, currentColor)",
                borderRadius: "999px",
                padding: "0.1rem 0.6rem",
                fontSize: "0.85rem",
              }}
            >
              {credential}
            </span>
          ))}
        </p>
      ) : null}

      <p style={{ whiteSpace: "pre-wrap" }}>{member.bioVerbatim}</p>

      <form action={deleteTeamMemberAction}>
        <input type="hidden" name="id" value={member.id} />
        <button type="submit" className="btn secondary">Remove</button>
      </form>
    </li>
  );
}

export default async function PracticePage(): Promise<JSX.Element> {
  const { organizationId } = await requireProposalAccess();
  const settings = await getPracticeSettings(organizationId);

  return (
    <main>
      <h1>Practice Profile</h1>
      <p>
        The verified source of truth proposals may quote from — team bios, rate card, vertical,
        methodology, and voice. Bios are cited verbatim, never paraphrased.
      </p>

      <section className="card" aria-label="Profile completeness">
        <p style={{ margin: 0, fontWeight: 600 }}>Profile completeness: {settings.completionPercent}%</p>
        <progress max={100} value={settings.completionPercent} style={{ width: "100%" }} />
        <p className="muted" style={{ margin: "0.25rem 0 0" }}>
          Complete your profile to unlock proposal generation.
        </p>
      </section>

      <div
        style={{
          display: "grid",
          gap: "1.5rem",
          gridTemplateColumns: "minmax(10rem, 14rem) 1fr",
          alignItems: "start",
        }}
      >
        <nav className="toolbar" aria-label="Sections" style={{ flexWrap: "wrap" }}>
          <a className="btn secondary" href="#team">Team</a>
          <a className="btn secondary" href="#rates">Rates</a>
          <a className="btn secondary" href="#voice">Voice</a>
          <a className="btn secondary" href="#vertical">Vertical</a>
        </nav>

        <div style={{ display: "grid", gap: "1.5rem" }}>
          <section id="team" className="card">
            <h2>Team</h2>
            <p className="muted">People proposals are allowed to cite. Avatars upload via your media library.</p>

            {settings.team.length === 0 ? (
              <div className="empty">
                <p style={{ fontWeight: 600 }}>Add yourself first</p>
                <p className="muted">Proposals can only cite people on this list.</p>
                <a className="btn" href="#add-member">Add your first bio</a>
              </div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.75rem" }}>
                {settings.team.map((member) => (
                  <BioCard key={member.id} member={member} />
                ))}
              </ul>
            )}

            <form id="add-member" action={saveTeamMemberAction}>
              <h3>Add team member</h3>
              <label>
                Full name
                <input name="fullName" required />
              </label>
              <label>
                Title
                <input name="title" placeholder="Principal Consultant" />
              </label>
              <label>
                Avatar file id
                <input name="avatarFileId" placeholder="Optional — from your media library" />
              </label>
              <label>
                Credentials (comma separated)
                <input name="credentials" placeholder="PMP, MBA, CPA" />
              </label>
              <label>
                Bio (quoted verbatim in proposals)
                <textarea name="bioVerbatim" required rows={5} />
              </label>
              <button type="submit">Add member</button>
            </form>
          </section>

          <section id="rates" className="card">
            <h2>Rate card</h2>
            <p className="muted">Hourly, day, and fixed-fee bands used to derive pricing suggestions.</p>

            {settings.rates.length === 0 ? (
              <div className="empty">
                <p className="muted">No rate bands yet. Add your first band below.</p>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Band</th>
                    <th>Model</th>
                    <th style={{ textAlign: "right" }}>Price</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {settings.rates.map((rate) => (
                    <tr key={rate.id}>
                      <td><strong>{rate.bandName}</strong></td>
                      <td>{PRICING_LABELS[rate.pricingModel] ?? rate.pricingModel}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {formatPrice(rate.amountCents, rate.currency)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <form action={deleteRateBandAction}>
                          <input type="hidden" name="id" value={rate.id} />
                          <button type="submit" className="btn secondary">Delete</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <form action={saveRateBandAction}>
              <h3>Add rate band</h3>
              <label>
                Band name
                <input name="bandName" required placeholder="Senior Advisory" />
              </label>
              <label>
                Pricing model
                <select name="pricingModel" defaultValue="hourly">
                  <option value="hourly">Hourly</option>
                  <option value="day">Day</option>
                  <option value="fixed_fee">Fixed fee</option>
                </select>
              </label>
              <label>
                Currency
                <input name="currency" defaultValue="USD" maxLength={3} />
              </label>
              <label>
                Price
                <input name="amount" type="number" step="0.01" min="0" required />
              </label>
              <button type="submit">Add rate</button>
            </form>
          </section>

          <section id="voice" className="card">
            <h2 id="vertical">Voice &amp; vertical</h2>
            <p className="muted">
              Steers tone so generated proposals reflect your voice and methodology.
            </p>
            <form action={saveProfileAction}>
              <label>
                Vertical
                <select name="vertical" defaultValue={settings.profile?.vertical ?? ""}>
                  <option value="">Select one</option>
                  {Object.entries(VERTICAL_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                Methodology blurb
                <textarea
                  name="methodologyBlurb"
                  rows={4}
                  defaultValue={settings.profile?.methodologyBlurb ?? ""}
                />
              </label>
              <label>
                Voice sample
                <textarea
                  name="voiceSample"
                  rows={5}
                  defaultValue={settings.profile?.voiceSample ?? ""}
                />
              </label>
              <button type="submit">Save profile</button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
