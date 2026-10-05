export function getRequestLocation(request: Request) {
	const cf = request.cf;
	return {
		country: typeof cf?.country === "string" ? cf.country : undefined,
		colo: typeof cf?.colo === "string" ? cf.colo : undefined,
	};
}
