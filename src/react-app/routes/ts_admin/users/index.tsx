import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { authClient } from "../../../lib/authClient";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

type UserRow = {
	id: string;
	name?: string | null;
	email?: string | null;
	role?: string | null;
	banned?: boolean | null;
	banReason?: string | null;
	banExpires?: string | number | Date | null;
	createdAt?: string | number | Date | null;
};

type ListUsersResponse = {
	users: UserRow[];
	total?: number;
	limit?: number;
	offset?: number;
};

const Route = createFileRoute("/ts_admin/users/")({
	component: TsAdminUsersPage,
});

function formatDate(v: unknown): string {
	if (!v) return "-";
	try {
		if (v instanceof Date) return v.toLocaleString();
		if (typeof v === "number") return new Date(v).toLocaleString();
		if (typeof v === "string") {
			const ms = Date.parse(v);
			if (!Number.isNaN(ms)) return new Date(ms).toLocaleString();
			return v;
		}
		return String(v);
	} catch {
		return "-";
	}
}

function normalizeRole(role: unknown): "admin" | "user" | "other" {
	if (!role || typeof role !== "string") return "user";
	const roles = role
		.split(",")
		.map((r) => r.trim())
		.filter(Boolean);
	if (roles.includes("admin")) return "admin";
	if (roles.length === 0) return "user";
	if (roles.length === 1 && roles[0] === "user") return "user";
	return "other";
}

function TsAdminUsersPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [searchValue, setSearchValue] = useState("");
	const [offset, setOffset] = useState(0);
	const limit = 50;

	const listInput = useMemo(
		() => ({
			searchValue: searchValue.trim() || undefined,
			searchField: "email" as const,
			searchOperator: "contains" as const,
			limit,
			offset,
			sortBy: "createdAt",
			sortDirection: "desc" as const,
		}),
		[searchValue, limit, offset]
	);

	const usersQuery = useQuery({
		queryKey: ["ts_admin", "users", listInput],
		retry: false,
		queryFn: async (): Promise<ListUsersResponse> => {
			const { data, error } = await authClient.admin.listUsers({
				query: listInput as any,
			});
			if (error) throw new Error(error.message ?? "Failed to list users");
			return (data ?? { users: [] }) as unknown as ListUsersResponse;
		},
	});

	const setRoleMutation = useMutation({
		mutationFn: async (args: {
			userId: string;
			role: "admin" | "user";
		}) => {
			const { error } = await authClient.admin.setRole({
				userId: args.userId,
				role: args.role,
			});
			if (error) throw new Error(error.message ?? "Failed to set role");
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["ts_admin", "users"],
			});
		},
	});

	const banMutation = useMutation({
		mutationFn: async (args: { userId: string; banned: boolean }) => {
			if (args.banned) {
				const { error } = await authClient.admin.banUser({
					userId: args.userId,
				});
				if (error)
					throw new Error(error.message ?? "Failed to ban user");
			} else {
				const { error } = await authClient.admin.unbanUser({
					userId: args.userId,
				});
				if (error)
					throw new Error(error.message ?? "Failed to unban user");
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["ts_admin", "users"],
			});
		},
	});

	const rows = usersQuery.data?.users ?? [];
	const total = usersQuery.data?.total;

	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Users</h1>
				<p className="text-sm text-muted-foreground">
					Admin-only user management.
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Search</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-wrap items-center gap-2">
					<Input
						className="min-w-[260px] flex-1"
						placeholder="Search email contains..."
						value={searchValue}
						onChange={(e) => {
							setSearchValue(e.target.value);
							setOffset(0);
						}}
					/>
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							setSearchValue("");
							setOffset(0);
						}}
						disabled={!searchValue}
					>
						Clear
					</Button>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>All Users</CardTitle>
				</CardHeader>
				<CardContent>
					{usersQuery.isLoading ? (
						<div className="text-sm text-muted-foreground">
							Loading…
						</div>
					) : usersQuery.isError ? (
						<div className="text-sm text-destructive">
							Failed to load users.
						</div>
					) : rows.length === 0 ? (
						<div className="text-sm text-muted-foreground">
							No users found.
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Email</TableHead>
									<TableHead>Name</TableHead>
									<TableHead>Role</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Created</TableHead>
									<TableHead className="text-right">
										Actions
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((u) => {
									const roleNorm = normalizeRole(u.role);
									const isAdmin = roleNorm === "admin";
									const isBanned = Boolean(u.banned);
									return (
										<TableRow
											key={u.id}
											className="cursor-pointer"
											onClick={() =>
												navigate({
													to: "/ts_admin/users/$userId",
													params: { userId: u.id },
												})
											}
											title="Open user details"
										>
											<TableCell className="max-w-[300px] truncate">
												<div className="truncate font-medium">
													{u.email ?? "-"}
												</div>
												<div className="truncate text-xs text-muted-foreground">
													{u.id}
												</div>
											</TableCell>
											<TableCell className="max-w-[220px] truncate">
												{u.name ?? "-"}
											</TableCell>
											<TableCell>
												{isAdmin ? (
													<Badge>admin</Badge>
												) : (
													<Badge variant="secondary">
														user
													</Badge>
												)}
												{roleNorm === "other" ? (
													<div className="mt-1 text-xs text-muted-foreground">
														{u.role}
													</div>
												) : null}
											</TableCell>
											<TableCell>
												{isBanned ? (
													<Badge variant="destructive">
														banned
													</Badge>
												) : (
													<Badge variant="outline">
														active
													</Badge>
												)}
												{isBanned && u.banReason ? (
													<div
														className="mt-1 max-w-[260px] truncate text-xs text-muted-foreground"
														title={u.banReason}
													>
														{u.banReason}
													</div>
												) : null}
											</TableCell>
											<TableCell className="whitespace-nowrap text-sm text-muted-foreground">
												{formatDate(u.createdAt)}
											</TableCell>
											<TableCell
												className="text-right"
												onClick={(e) =>
													e.stopPropagation()
												}
											>
												<div className="inline-flex flex-wrap justify-end gap-2">
													<Button
														type="button"
														variant="outline"
														disabled={
															setRoleMutation.isPending
														}
														onClick={() =>
															setRoleMutation.mutate(
																{
																	userId: u.id,
																	role: isAdmin
																		? "user"
																		: "admin",
																}
															)
														}
													>
														{isAdmin
															? "Make user"
															: "Make admin"}
													</Button>
													<Button
														type="button"
														variant={
															isBanned
																? "outline"
																: "destructive"
														}
														disabled={
															banMutation.isPending
														}
														onClick={() =>
															banMutation.mutate({
																userId: u.id,
																banned: !isBanned,
															})
														}
													>
														{isBanned
															? "Unban"
															: "Ban"}
													</Button>
												</div>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					)}

					{usersQuery.data ? (
						<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
							<div className="text-sm text-muted-foreground">
								{typeof total === "number" ? (
									<>Total: {total.toLocaleString()}</>
								) : (
									<>Offset: {offset.toLocaleString()}</>
								)}
							</div>
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="outline"
									disabled={offset <= 0}
									onClick={() =>
										setOffset((v) => Math.max(0, v - limit))
									}
								>
									Prev
								</Button>
								<Button
									type="button"
									variant="outline"
									disabled={rows.length < limit}
									onClick={() => setOffset((v) => v + limit)}
								>
									Next
								</Button>
							</div>
						</div>
					) : null}
				</CardContent>
			</Card>
		</section>
	);
}

export { Route };
