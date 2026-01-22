import { Link, createFileRoute } from "@tanstack/react-router";

import { requireCoreAdmin } from "../../lib/requireCoreAdmin";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const Route = createFileRoute("/ts_admin/")({
	beforeLoad: requireCoreAdmin,
	component: TsAdminIndexPage,
});

function TsAdminIndexPage() {
	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
				<p className="text-sm text-muted-foreground">
					Internal tools for managing the app.
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Management</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-wrap gap-2">
					<Button asChild variant="outline">
						<Link to="/ts_admin/users">Users</Link>
					</Button>
				</CardContent>
			</Card>
		</section>
	);
}

export { Route };
