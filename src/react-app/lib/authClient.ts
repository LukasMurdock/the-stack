import { createAuthClient } from "better-auth/react";
import { adminClient, organizationClient } from "better-auth/client/plugins";

const authClient = createAuthClient({
	plugins: [organizationClient(), adminClient()],
});

export { authClient };
