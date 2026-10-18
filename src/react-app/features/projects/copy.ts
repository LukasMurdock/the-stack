import { plural } from "../../ui/format";

// Every string the Projects example shows. Screens pick from here.
export const projectCopy = {
	projects: "Projects",
	projectCount: (count: number, organization: string) =>
		`${plural(count, "project")} in ${organization}`,
	noProjects: "No projects yet",
	newProject: "New project",
	name: "Project name",
	description: "Description",
	create: "Create project",
	creating: "Creating…",
};
