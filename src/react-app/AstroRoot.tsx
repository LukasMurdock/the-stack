import { StrictMode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import "./index.css";

import { queryClient, router } from "./router";
import { initErrorTracking } from "./lib/error-tracker";

initErrorTracking();

function AstroRoot() {
	return (
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</StrictMode>
	);
}

export { AstroRoot };
