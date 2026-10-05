import { useDraftValue } from "@/react-app/hooks/useDraftValue";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { authClient } from "../../../lib/authClient";
import { requireCoreAdmin } from "../../../lib/requireCoreAdmin";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

type AdminUser = {
	id: string;
	email?: string | null;
	name?: string | null;
	role?: string | null;
	banned?: boolean | null;
	banReason?: string | null;
	banExpires?: string | number | Date | null;
	emailVerified?: boolean | null;
	createdAt?: string | number | Date | null;
	updatedAt?: string | number | Date | null;
};

type AdminSession = {
	id: string;
	token?: string;
	createdAt?: string | number | Date | null;
	updatedAt?: string | number | Date | null;
	expiresAt?: string | number | Date | null;
	ipAddress?: string | null;
	userAgent?: string | null;
};

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

const Route = createFileRoute("/ts_admin/users/$userId")({
	beforeLoad: requireCoreAdmin,
	component: TsAdminUserDetailPage,
});

function TsAdminUserDetailPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { userId } = Route.useParams();

	const userQuery = useQuery({
		queryKey: ["ts_admin", "user", userId],
		retry: false,
		queryFn: async (): Promise<AdminUser> => {
			const { data, error } = await authClient.admin.getUser({
				query: { id: userId },
			});
			if (error) throw new Error(error.message ?? "Failed to load user");
			if (!data) throw new Error("User not found");
			return data;
		},
	});

	const sessionsQuery = useQuery({
		queryKey: ["ts_admin", "user", userId, "sessions"],
		retry: false,
		queryFn: async (): Promise<{ sessions: AdminSession[] }> => {
			const { data, error } = await authClient.admin.listUserSessions({
				userId,
			});
			if (error)
				throw new Error(error.message ?? "Failed to list sessions");
			return data ?? { sessions: [] };
		},
	});

	const {
		value: name,
		setValue: setName,
		reset: resetName,
	} = useDraftValue(userQuery.data?.name ?? "", userId);
	const {
		value: email,
		setValue: setEmail,
		reset: resetEmail,
	} = useDraftValue(userQuery.data?.email ?? "", userId);
	const {
		value: role,
		setValue: setRole,
		reset: resetRole,
	} = useDraftValue<"admin" | "user">(
		normalizeRole(userQuery.data?.role) === "admin" ? "admin" : "user",
		userId
	);
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");

	const updateUserMutation = useMutation({
		mutationFn: async () => {
			const payload: { name?: string; email?: string } = {};
			if (name.trim()) payload.name = name.trim();
			if (email.trim()) payload.email = email.trim().toLowerCase();

			const { error } = await authClient.admin.updateUser({
				userId,
				data: payload,
			});
			if (error)
				throw new Error(error.message ?? "Failed to update user");
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["ts_admin", "user", userId],
			});
			await queryClient.invalidateQueries({
				queryKey: ["ts_admin", "users"],
			});
			resetName();
			resetEmail();
		},
	});

	const setRoleMutation = useMutation({
		mutationFn: async () => {
			const { error } = await authClient.admin.setRole({
				userId,
				role,
			});
			if (error) throw new Error(error.message ?? "Failed to set role");
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["ts_admin", "user", userId],
			});
			await queryClient.invalidateQueries({
				queryKey: ["ts_admin", "users"],
			});
			resetRole();
		},
	});

	const setPasswordMutation = useMutation({
		mutationFn: async () => {
			if (!newPassword) throw new Error("Password is required");
			if (newPassword !== confirmPassword) {
				throw new Error("Passwords do not match");
			}
			const { error } = await authClient.admin.setUserPassword({
				userId,
				newPassword,
			});
			if (error)
				throw new Error(error.message ?? "Failed to set password");
		},
		onSuccess: () => {
			setNewPassword("");
			setConfirmPassword("");
		},
	});

	const revokeSessionMutation = useMutation({
		mutationFn: async (args: { sessionToken: string }) => {
			const { error } = await authClient.admin.revokeUserSession({
				sessionToken: args.sessionToken,
			});
			if (error)
				throw new Error(error.message ?? "Failed to revoke session");
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["ts_admin", "user", userId, "sessions"],
			});
		},
	});

	const revokeAllSessionsMutation = useMutation({
		mutationFn: async () => {
			const { error } = await authClient.admin.revokeUserSessions({
				userId,
			});
			if (error)
				throw new Error(error.message ?? "Failed to revoke sessions");
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["ts_admin", "user", userId, "sessions"],
			});
		},
	});

	const impersonateMutation = useMutation({
		mutationFn: async () => {
			const { error } = await authClient.admin.impersonateUser({
				userId,
			});
			if (error)
				throw new Error(error.message ?? "Failed to impersonate user");
		},
		onSuccess: () => {
			// After impersonation, this route will likely 403 (not admin anymore).
			// Send the user somewhere safe; the Root banner can stop impersonation.
			window.location.assign("/app");
		},
	});

	const user = userQuery.data;
	const sessions = sessionsQuery.data?.sessions ?? [];
	const roleNorm = normalizeRole(user?.role);
	const isBanned = Boolean(user?.banned);

	const headerTitle = user?.email ?? user?.id ?? userId;

	const passwordError = useMemo(() => {
		if (!newPassword && !confirmPassword) return null;
		if (newPassword && confirmPassword && newPassword !== confirmPassword) {
			return "Passwords do not match";
		}
		return null;
	}, [newPassword, confirmPassword]);

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						{headerTitle}
					</h1>
					<p className="text-sm text-muted-foreground">
						User ID: {userId}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() => navigate({ to: "/ts_admin/users" })}
					>
						Back
					</Button>
				</div>
			</div>

			{userQuery.isLoading ? (
				<div className="text-sm text-muted-foreground">Loading…</div>
			) : userQuery.isError ? (
				<div className="text-sm text-destructive">
					Failed to load user.
				</div>
			) : !user ? (
				<div className="text-sm text-muted-foreground">
					User not found.
				</div>
			) : (
				<Tabs defaultValue="profile">
					<TabsList>
						<TabsTrigger value="profile">Profile</TabsTrigger>
						<TabsTrigger value="access">Access</TabsTrigger>
						<TabsTrigger value="security">Security</TabsTrigger>
						<TabsTrigger value="sessions">Sessions</TabsTrigger>
						<TabsTrigger value="impersonate">
							Impersonate
						</TabsTrigger>
					</TabsList>

					<TabsContent value="profile" className="mt-4">
						<Card>
							<CardHeader>
								<CardTitle>Profile</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="grid gap-3 md:grid-cols-2">
									<div>
										<div className="text-sm font-medium">
											Name
										</div>
										<Input
											disabled={
												updateUserMutation.isPending
											}
											value={name}
											onChange={(e) =>
												setName(e.target.value)
											}
										/>
									</div>
									<div>
										<div className="text-sm font-medium">
											Email
										</div>
										<Input
											disabled={
												updateUserMutation.isPending
											}
											value={email}
											onChange={(e) =>
												setEmail(e.target.value)
											}
										/>
									</div>
								</div>

								<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3 text-sm">
									<div className="text-muted-foreground">
										Created: {formatDate(user.createdAt)} ·
										Updated: {formatDate(user.updatedAt)}
									</div>
									<div className="flex items-center gap-2">
										{user.emailVerified ? (
											<Badge>verified</Badge>
										) : (
											<Badge variant="secondary">
												unverified
											</Badge>
										)}
									</div>
								</div>

								<Button
									type="button"
									onClick={() => updateUserMutation.mutate()}
									disabled={updateUserMutation.isPending}
								>
									{updateUserMutation.isPending
										? "Saving…"
										: "Save changes"}
								</Button>
							</CardContent>
						</Card>
					</TabsContent>

					<TabsContent value="access" className="mt-4">
						<Card>
							<CardHeader>
								<CardTitle>Access</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="grid gap-3 md:grid-cols-2">
									<div>
										<div className="text-sm font-medium">
											Role
										</div>
										<Select
											disabled={setRoleMutation.isPending}
											value={role}
											onValueChange={(v) =>
												setRole(
													v === "admin"
														? "admin"
														: "user"
												)
											}
										>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select role" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="user">
													user
												</SelectItem>
												<SelectItem value="admin">
													admin
												</SelectItem>
											</SelectContent>
										</Select>
										<div className="mt-1 text-xs text-muted-foreground">
											Current:{" "}
											{roleNorm === "admin"
												? "admin"
												: roleNorm === "user"
													? "user"
													: user.role}
										</div>
									</div>
									<div>
										<div className="text-sm font-medium">
											Status
										</div>
										<div className="mt-2 flex flex-wrap items-center gap-2">
											{isBanned ? (
												<Badge variant="destructive">
													banned
												</Badge>
											) : (
												<Badge variant="outline">
													active
												</Badge>
											)}
											{user.banReason ? (
												<span
													className="text-xs text-muted-foreground"
													title={user.banReason}
												>
													reason: {user.banReason}
												</span>
											) : null}
										</div>
									</div>
								</div>

								<div className="flex flex-wrap items-center gap-2">
									<Button
										type="button"
										variant="outline"
										onClick={() => setRoleMutation.mutate()}
										disabled={setRoleMutation.isPending}
									>
										{setRoleMutation.isPending
											? "Updating…"
											: "Update role"}
									</Button>
								</div>
							</CardContent>
						</Card>
					</TabsContent>

					<TabsContent value="security" className="mt-4">
						<Card>
							<CardHeader>
								<CardTitle>Set Password</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="grid gap-3 md:grid-cols-2">
									<div>
										<div className="text-sm font-medium">
											New password
										</div>
										<Input
											type="password"
											value={newPassword}
											onChange={(e) =>
												setNewPassword(e.target.value)
											}
										/>
									</div>
									<div>
										<div className="text-sm font-medium">
											Confirm password
										</div>
										<Input
											type="password"
											value={confirmPassword}
											onChange={(e) =>
												setConfirmPassword(
													e.target.value
												)
											}
										/>
									</div>
								</div>

								{passwordError ? (
									<div className="text-sm text-destructive">
										{passwordError}
									</div>
								) : null}

								<Button
									type="button"
									variant="destructive"
									onClick={() => setPasswordMutation.mutate()}
									disabled={
										setPasswordMutation.isPending ||
										Boolean(passwordError) ||
										!newPassword
									}
								>
									{setPasswordMutation.isPending
										? "Updating…"
										: "Set password"}
								</Button>
							</CardContent>
						</Card>
					</TabsContent>

					<TabsContent value="sessions" className="mt-4">
						<Card>
							<CardHeader>
								<CardTitle>Sessions</CardTitle>
							</CardHeader>
							<CardContent className="space-y-3">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div className="text-sm text-muted-foreground">
										{sessions.length} session(s)
									</div>
									<Button
										type="button"
										variant="outline"
										onClick={() =>
											revokeAllSessionsMutation.mutate()
										}
										disabled={
											revokeAllSessionsMutation.isPending
										}
									>
										{revokeAllSessionsMutation.isPending
											? "Revoking…"
											: "Revoke all"}
									</Button>
								</div>

								{sessionsQuery.isLoading ? (
									<div className="text-sm text-muted-foreground">
										Loading…
									</div>
								) : sessionsQuery.isError ? (
									<div className="text-sm text-destructive">
										Failed to load sessions.
									</div>
								) : sessions.length === 0 ? (
									<div className="text-sm text-muted-foreground">
										No sessions.
									</div>
								) : (
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Created</TableHead>
												<TableHead>Expires</TableHead>
												<TableHead>IP</TableHead>
												<TableHead>
													User agent
												</TableHead>
												<TableHead className="text-right">
													Actions
												</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{sessions.map((s) => (
												<TableRow key={s.id}>
													<TableCell className="whitespace-nowrap">
														{formatDate(
															s.createdAt
														)}
													</TableCell>
													<TableCell className="whitespace-nowrap">
														{formatDate(
															s.expiresAt
														)}
													</TableCell>
													<TableCell className="whitespace-nowrap">
														{s.ipAddress ?? "-"}
													</TableCell>
													<TableCell
														className="max-w-[320px] truncate"
														title={
															s.userAgent ?? ""
														}
													>
														{s.userAgent ?? "-"}
													</TableCell>
													<TableCell className="text-right">
														<Button
															type="button"
															variant="outline"
															disabled={
																revokeSessionMutation.isPending ||
																!s.token
															}
															onClick={() => {
																if (!s.token)
																	return;
																revokeSessionMutation.mutate(
																	{
																		sessionToken:
																			s.token,
																	}
																);
															}}
														>
															Revoke
														</Button>
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								)}
							</CardContent>
						</Card>
					</TabsContent>

					<TabsContent value="impersonate" className="mt-4">
						<Card>
							<CardHeader>
								<CardTitle>Impersonate</CardTitle>
							</CardHeader>
							<CardContent className="space-y-3">
								<div className="rounded-md border bg-muted/20 p-3 text-sm">
									<div className="font-medium">Warning</div>
									<div className="mt-1 text-muted-foreground">
										Impersonating switches your cookies to
										the target user. You will lose admin
										access until you stop impersonating.
									</div>
								</div>
								<Button
									type="button"
									variant="destructive"
									onClick={() => impersonateMutation.mutate()}
									disabled={impersonateMutation.isPending}
								>
									{impersonateMutation.isPending
										? "Starting…"
										: "Impersonate user"}
								</Button>
							</CardContent>
						</Card>
					</TabsContent>
				</Tabs>
			)}
		</section>
	);
}

export { Route };
