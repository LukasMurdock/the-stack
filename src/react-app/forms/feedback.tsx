import { ApiError } from "../api";

function formError(error: unknown): string {
	return error instanceof Error
		? error.message
		: "The change could not be saved. Try again.";
}
export function MutationFeedback({
	error,
	success,
}: {
	error: unknown;
	success?: string;
}) {
	if (error) {
		const fields = error instanceof ApiError ? error.fields : undefined;
		return (
			<div role="alert" className="text-sm text-destructive">
				<p>{formError(error)}</p>
				{fields && (
					<ul>
						{Object.entries(fields).map(([field, message]) => (
							<li key={field}>
								{field}: {message}
							</li>
						))}
					</ul>
				)}
			</div>
		);
	}
	if (success)
		return (
			<p role="status" className="text-sm">
				{success}
			</p>
		);
	return null;
}
