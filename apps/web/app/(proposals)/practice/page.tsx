import { getPracticeSettings } from "@/lib/proposals/practice";
import { requireProposalAccess } from "@/lib/proposals/access";
import {
  deleteRateBandAction,
  deleteTeamMemberAction,
  saveProfileAction,
  saveRateBandAction,
  saveTeamMemberAction,
} from "./actions";

export default async function PracticePage(): Promise<JSX.Element> {
  const { organizationId } = await requireProposalAccess();
  const settings = await getPracticeSettings(organizationId);

  return (
    <main>
      <h1>Practice Profile</h1>
      <p>Manage the verified team bios, rate card, vertical, methodology, and voice used for proposal generation.</p>

      <section className="card">
        <h2>Profile completeness: {settings.completionPercent}%</h2>
        <progress max={100} value={settings.completionPercent} style={{ width: "100%" }} />
      </section>

      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "1fr 3fr" }}>
        <aside className="card">
          <h3>Sections</h3>
          <ul>
            <li>Team</li>
            <li>Rates</li>
            <li>Voice</li>
            <li>Vertical</li>
          </ul>
        </aside>

        <div style={{ display: "grid", gap: "1rem" }}>
          <section className="card">
            <h2>Team</h2>
            {settings.team.length === 0 ? (
              <div className="empty">
                <p>Add yourself first — proposals can only cite people on this list.</p>
              </div>
            ) : (
              <ul>
                {settings.team.map((member) => (
                  <li key={member.id} className="card">
                    <p>
                      <strong>{member.fullName}</strong>
                      {member.title ? ` — ${member.title}` : ""}
                    </p>
                    <p className="muted">{member.credentials.join(" • ")}</p>
                    <p>{member.bioVerbatim}</p>
                    <form action={deleteTeamMemberAction}>
                      <input type="hidden" name="id" value={member.id} />
                      <button type="submit">Remove</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}

            <form action={saveTeamMemberAction}>
              <h3>Add team member</h3>
              <label>
                Full name
                <input name="fullName" required />
              </label>
              <label>
                Title
                <input name="title" />
              </label>
              <label>
                Avatar file id
                <input name="avatarFileId" />
              </label>
              <label>
                Credentials (comma separated)
                <input name="credentials" />
              </label>
              <label>
                Bio (verbatim)
                <textarea name="bioVerbatim" required rows={5} />
              </label>
              <button type="submit">Add member</button>
            </form>
          </section>

          <section className="card">
            <h2>Rate card</h2>
            {settings.rates.length === 0 ? (
              <div className="empty">
                <p>No rate bands yet.</p>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Band</th>
                    <th>Model</th>
                    <th>Currency</th>
                    <th style={{ textAlign: "right" }}>Price</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {settings.rates.map((rate) => (
                    <tr key={rate.id}>
                      <td>
                        <strong>{rate.bandName}</strong>
                      </td>
                      <td>{rate.pricingModel}</td>
                      <td>{rate.currency}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {(rate.amountCents / 100).toFixed(2)}
                      </td>
                      <td>
                        <form action={deleteRateBandAction}>
                          <input type="hidden" name="id" value={rate.id} />
                          <button type="submit">Delete</button>
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
                <input name="bandName" required />
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
                <input name="currency" defaultValue="USD" />
              </label>
              <label>
                Price
                <input name="amount" type="number" step="0.01" min="0" required />
              </label>
              <button type="submit">Add rate</button>
            </form>
          </section>

          <section className="card">
            <h2>Voice & vertical</h2>
            <form action={saveProfileAction}>
              <label>
                Vertical
                <select name="vertical" defaultValue={settings.profile?.vertical ?? ""}>
                  <option value="">Select one</option>
                  <option value="management">Management</option>
                  <option value="marketing">Marketing</option>
                  <option value="it">IT</option>
                  <option value="hr">HR</option>
                </select>
              </label>
              <label>
                Methodology blurb
                <textarea name="methodologyBlurb" rows={4} defaultValue={settings.profile?.methodologyBlurb ?? ""} />
              </label>
              <label>
                Voice sample
                <textarea name="voiceSample" rows={5} defaultValue={settings.profile?.voiceSample ?? ""} />
              </label>
              <button type="submit">Save profile</button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
