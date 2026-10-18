import * as React from "react";
import {
	Body,
	Button,
	Container,
	Head,
	Heading,
	Hr,
	Html,
	Preview,
	Section,
	Text,
} from "react-email";

import { authEmailCopy, type AuthEmailType } from "./auth-email-copy";

type AuthEmailProps = {
	type: AuthEmailType;
	productName: string;
	url: string;
};

export function AuthEmail({ productName, url, type }: AuthEmailProps) {
	const copy = authEmailCopy(type, productName);
	const previewText = `${copy.heading} for ${productName}`;

	return (
		<Html lang="en">
			<Head />
			<Preview>{previewText}</Preview>
			<Body style={styles.body}>
				<Container style={styles.container}>
					<Section style={styles.header}>
						<Text style={styles.brand}>{productName}</Text>
					</Section>

					<Heading style={styles.h1}>{copy.heading}</Heading>
					<Text style={styles.p}>{copy.body}</Text>

					<Section style={styles.ctaRow}>
						<Button href={url} style={styles.button}>
							{copy.action}
						</Button>
					</Section>

					<Text style={styles.small}>
						If the button does not work, copy and paste this link
						into your browser:
					</Text>
					<Text style={styles.monoLink}>{url}</Text>

					<Hr style={styles.hr} />
					<Text style={styles.footer}>{copy.footer}</Text>
				</Container>
			</Body>
		</Html>
	);
}

const styles: Record<string, React.CSSProperties> = {
	body: {
		backgroundColor: "#f6f5f2",
		margin: 0,
		padding: "24px 0",
		fontFamily:
			'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
	},
	container: {
		backgroundColor: "#ffffff",
		borderRadius: 12,
		margin: "0 auto",
		padding: 24,
		width: "100%",
		maxWidth: 520,
		border: "1px solid #ece7df",
		boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
	},
	header: {
		marginBottom: 8,
	},
	brand: {
		fontSize: 14,
		letterSpacing: "0.06em",
		textTransform: "uppercase",
		color: "#5a4a3b",
		margin: 0,
	},
	h1: {
		fontSize: 26,
		lineHeight: "32px",
		margin: "16px 0 8px",
		color: "#1f2937",
	},
	p: {
		fontSize: 15,
		lineHeight: "22px",
		margin: "0 0 16px",
		color: "#374151",
	},
	ctaRow: {
		padding: "8px 0 18px",
	},
	button: {
		display: "inline-block",
		backgroundColor: "#b45309",
		color: "#ffffff",
		padding: "12px 16px",
		borderRadius: 10,
		textDecoration: "none",
		fontWeight: 600,
		fontSize: 15,
	},
	small: {
		fontSize: 12,
		lineHeight: "18px",
		margin: "0 0 6px",
		color: "#6b7280",
	},
	monoLink: {
		fontSize: 12,
		lineHeight: "18px",
		margin: 0,
		color: "#111827",
		wordBreak: "break-all",
		fontFamily:
			'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
	},
	hr: {
		borderColor: "#efe9e1",
		margin: "18px 0 14px",
	},
	footer: {
		fontSize: 12,
		lineHeight: "18px",
		margin: 0,
		color: "#6b7280",
	},
};
