import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

const authClient = createAuthClient({
	plugins: [organizationClient()],
});

export { authClient };
