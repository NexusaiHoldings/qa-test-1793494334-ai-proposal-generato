/**
 * Access control for the (proposals) carve-out.
 *
 * Session is resolved through the substrate's identity helper
 * (@/lib/admin-auth → @nexus/identity-and-access handleSession). Org scoping is
 * keyed on the organizationId the current consultant belongs to
 * (@nexus/organizations-and-teams tables), giving per-consultant isolation of
 * the practice profile, team bios, and rate card.
 *
 * Every (proposals) page + server action calls requireProposalAccess() first so
 * all domain queries are scoped to a single organizationId.
 */
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { buildDb } from "@/lib/db";

export type ProposalAccessContext = {
  userId: string;
  organizationId: string;
};

interface OrgIdRow {
  org_id: string;
}

/**
 * Resolve the organizationId for a user.
 *
 * Prefers an explicit membership row (org_members), then falls back to an org
 * the user owns (organizations.owner_user_id). When a solo consultant has no
 * org row yet, the user's own id is used as a stable personal-workspace key so
 * the practice surface never 500s for a signed-in user.
 */
async function resolveOrganizationId(userId: string): Promise<string> {
  const db = buildDb();

  const membership = await db.query<OrgIdRow>(
    `SELECT org_id
       FROM org_members
      WHERE user_id = $1
      ORDER BY joined_at ASC
      LIMIT 1`,
    userId,
  );
  if (membership.length > 0 && membership[0].org_id) {
    return membership[0].org_id;
  }

  const owned = await db.query<OrgIdRow>(
    `SELECT id AS org_id
       FROM organizations
      WHERE owner_user_id = $1
      ORDER BY created_at ASC
      LIMIT 1`,
    userId,
  );
  if (owned.length > 0 && owned[0].org_id) {
    return owned[0].org_id;
  }

  // Personal workspace fallback: the user's own UUID namespaces their data.
  return userId;
}

export async function requireProposalAccess(): Promise<ProposalAccessContext> {
  const user = await getSessionUser();
  if (!user || !user.id) {
    redirect("/login");
  }

  const organizationId = await resolveOrganizationId(user.id);

  return {
    userId: user.id,
    organizationId,
  };
}
