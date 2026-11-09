import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	turretFeedbackKindSchema,
	turretFeedbackStatusSchema,
} from "@/contracts/turret";
import { FeedbackInbox } from "../../../../features/turret/feedback/FeedbackInbox";

// The inbox's filters and open report. Unknown values fall back to the
// defaults instead of failing the page.
const searchSchema = z.object({
	status: turretFeedbackStatusSchema.default("open").catch("open"),
	kind: turretFeedbackKindSchema.optional().catch(undefined),
	q: z.string().default("").catch(""),
	id: z.string().optional().catch(undefined),
	offset: z.number().int().min(0).default(0).catch(0),
});

const Route = createFileRoute("/ts_admin/turret/feedback/")({
	validateSearch: searchSchema,
	component: TurretFeedbackPage,
});

function TurretFeedbackPage() {
	return <FeedbackInbox search={Route.useSearch()} />;
}

export { Route };
