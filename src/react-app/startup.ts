import { turretCorrelationHeaders } from "../contracts/turret-correlation";
import { setApiRequestHeaders } from "./api";
import { captureInvitationLink } from "./features/organizations/invitationToken";
import { getTurretContext } from "./features/turret/context";
import { initErrorTracking } from "./features/turret/error-tracker";

// Scrub invitation secrets before the router or recorder observes the URL.
captureInvitationLink();
setApiRequestHeaders((): Record<string, string> => {
	const turret = getTurretContext();
	if (!turret) return {};
	return turretCorrelationHeaders(turret, Date.now());
});
initErrorTracking();
