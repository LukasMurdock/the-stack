import { render, toPlainText } from "react-email";

export async function renderEmail(component: React.ReactElement) {
	const html = await render(component);
	return {
		html: html,
		text: toPlainText(html),
	};
}
