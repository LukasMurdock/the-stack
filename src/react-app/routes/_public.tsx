import { createFileRoute } from "@tanstack/react-router";

// Public pages share the app header, which the root draws.
export const Route = createFileRoute("/_public")({});
