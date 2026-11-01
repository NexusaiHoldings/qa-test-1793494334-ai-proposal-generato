import {
  addTeamMemberAction,
  removeTeamMemberAction,
  savePracticeProfileAction,
  saveRateBandAction,
} from "./actions";
import {
  getPracticeProfile,
  listRateCardBands,
  listTeamMembers,
  getPracticeCompleteness,
} from "@/lib/proposals/practice";
import { requireOrganizationContext } from "@/lib/proposals/access";

export default async function PracticePage(): Promise<JSX.Element> {
  const { organizationId } = await requireOrganizationContext();
  const [profile, teamMembers, rateBands] = await Promise.all([
    getPracticeProfile(organizationId),
    listTeamMembers(organizationId),
    listRateCardBands(organizationId),
  ]);

  const completeness = getPracticeCompleteness({
    profile,
    teamMembers,
    rateBands,
  });

  return (
    <main>
      <h1>Practice Profile</h1>
      <p>
        Define the verified source of truth your proposals can cite: team bios, rate card, vertical,
        methodology, and voice sample.
      </p>

      <section className="card" style={{ marginBottom: 16 }}>
        <h2>Profile completeness</h2>
        <p className="muted">
          {completeness.percent}% complete ({completeness.completed} of {completeness.total} sections)
        </p>
        <progress value={completeness.percent} max={100} style={{ width: "100%" }} />
      </section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "220px 1fr",
          gap: 16,
        }}
      >
        <aside className="card">
          <nav aria-label="Sections">
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
              <li>
                <a href="#team" className="btn secondary" style={{ width: "100%" }}>
                  Team
                </a>
              </li>
              <li>
                <a href="#rates" className="btn secondary" style={{ width: "100%" }}>
                  Rates
                </a>
              </li>
              <li>
                <a href="#voice" className="btn secondary" style={{ width: "100%" }}>
                  Voice
                </a>
              </li>
              <li>
                <a href="#vertical" className="btn secondary" style={{ width: "100%" }}>
                  Vertical
                </a>
              </li>
            </ul>
          </nav>
        </aside>

        <section style={{ display: "grid", gap: 16 }}>
          <section id="team" className="card">
            <h2>Team</h2>
            <p className="muted">
              Add yourself first — proposals can only cite people on this list.
            </p>

            {teamMembers.length === 0 ? (
              <div className="empty">
                <article className="card" style={{ maxWidth: 420, margin: "0 auto" }}>
                  <p className="muted">[avatar]</p>
                  <h3>Example Team Member</h3>
                  <p className="muted">Principal Consultant</p>
                  <p>
                    Credential chips: PMP • MBA • AWS Solutions Architect
                  </p>
                </article>
                <p>Add yourself first — proposals can only cite people on this list.</p>
              </div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
                {teamMembers.map((member) => (
                  <li key={member.id} className="card">
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <div
                        aria-hidden="true"
                        style={{
                          width: 56,
                          height: 56,
                          borderRadius: "50%",
                          border: "1px solid var(--border, #444)",
                          display: "grid",
                          placeItems: "center",
                          fontSize: 12,
                        }}
                      >
                        {member.avatarFileId ? "IMG" : "No Avatar"}
                      </div>
                      <div style={{ flex: 1 }}>
                        <h3 style={{ marginTop: 0 }}>{member.fullName}</h3>
                        <p className="muted">{member.roleTitle}</p>
                        <p>{member.bioVerbatim}</p>
                        <p className="muted">
                          {(member.credentials ?? "")
                            .split(",")
                            .map((chip) => chip.trim())
                            .filter(Boolean)
                            .join(" • ")}
                        </p>
                      </div>
                      <form action={removeTeamMemberAction}>
                        <input type="hidden" name="memberId" value={member.id} />
                        <button type="submit">Remove</button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <h3>Add team member</h3>
            <form action={addTeamMemberAction}>
              <label htmlFor="fullName">Full name</label>
              <input id="fullName" name="fullName" required />

              <label htmlFor="roleTitle">Role title</label>
              <input id="roleTitle" name="roleTitle" required />

              <label htmlFor="credentials">Credentials (comma-separated)</label>
              <input id="credentials" name="credentials" required />

              <label htmlFor="bioVerbatim">Bio (verbatim)</label>
              <textarea id="bioVerbatim" name="bioVerbatim" required rows={5} />

              <label htmlFor="avatarFileId">Avatar file ID (optional)</label>
              <input id="avatarFileId" name="avatarFileId" />

              <button type="submit">Add team member</button>
            </form>
          </section>

          <section id="rates" className="card">
            <h2>Rates</h2>
            <p className="muted">Maintain your hourly/day/fixed fee bands for pricing suggestions.</p>

            {rateBands.length === 0 ? (
              <div className="empty">No rate bands yet. Add your first band below.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Band</th>
                    <th>Cadence</th>
                    <th style={{ textAlign: "right" }}>Price</th>
                    <th>Currency</th>
                  </tr>
                </thead>
                <tbody>
                  {rateBands.map((band) => (
                    <tr key={band.id}>
                      <td>
                        <strong>{band.name}</strong>
                      </td>
                      <td>{band.cadence}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {band.amount.toFixed(2)}
                      </td>
                      <td>{band.currency}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>Add or update rate band</h3>
            <form action={saveRateBandAction}>
              <label htmlFor="name">Band name</label>
              <input id="name" name="name" placeholder="Senior Consultant" required />

              <label htmlFor="cadence">Cadence</label>
              <select id="cadence" name="cadence" defaultValue="hourly">
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="fixed">Fixed fee</option>
              </select>

              <label htmlFor="amount">Amount</label>
              <input id="amount" name="amount" type="number" min="0" step="0.01" required />

              <label htmlFor="currency">Currency</label>
              <input id="currency" name="currency" defaultValue="USD" />

              <button type="submit">Save rate band</button>
            </form>
          </section>

          <section id="voice" className="card">
            <h2>Voice & Methodology</h2>
            <form action={savePracticeProfileAction}>
              <label htmlFor="methodology">Methodology blurb</label>
              <textarea
                id="methodology"
                name="methodology"
                defaultValue={profile?.methodology ?? ""}
                rows={5}
                required
              />

              <label htmlFor="voiceSample">Voice sample paragraph</label>
              <textarea
                id="voiceSample"
                name="voiceSample"
                defaultValue={profile?.voiceSample ?? ""}
                rows={6}
                required
              />

              <section id="vertical">
                <label htmlFor="verticalSelect">Vertical</label>
                <select id="verticalSelect" name="vertical" defaultValue={profile?.vertical ?? "management"}>
                  <option value="management">Management</option>
                  <option value="marketing">Marketing</option>
                  <option value="it">IT</option>
                  <option value="hr">HR</option>
                </select>
              </section>

              <button type="submit">Save profile</button>
            </form>
          </section>
        </section>
      </div>
    </main>
  );
}
