import { createRouter } from "@tanstack/react-router";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { reportError } from "./lib/error-tracker";

// Router context is created here so route loaders can prefetch via TanStack Query.

const queryClient = new QueryClient({
	queryCache: new QueryCache({
		onError: (error, query) => {
			reportError(error, {
				source: "react-query",
				extra: {
					queryKey: query.queryKey,
				},
			});
		},
	}),
	mutationCache: new MutationCache({
		onError: (error, _variables, _context, mutation) => {
			reportError(error, {
				source: "react-query",
				extra: {
					mutationKey: mutation.options.mutationKey,
				},
			});
		},
	}),
});

const router = createRouter({
	routeTree,
	basepath: "/app",
	context: {
		queryClient,
	},
	defaultPreload: "intent",
	defaultPreloadStaleTime: 0,
	scrollRestoration: true,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

export { queryClient, router };
