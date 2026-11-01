import { getServerSession } from "@nexus/identity-and-access";
import { getCurrentOrganizationContext } from "@nexus/organizations-and-teams";

export type ProposalAccessContext = {
  userId: string;
  organizationId: string;
};

export async function requireProposalAccess(): Promise<ProposalAccessContext> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const orgContext = await getCurrentOrganizationContext();
  const organizationId = orgContext?.organizationId;

  if (!organizationId) {
    throw new Error("Organization context required");
  }

  return {
    userId: session.user.id,
    organizationId,
  };
}
