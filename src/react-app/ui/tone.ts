// What a state means, as color. Every toned surface reads from here; the
// colors themselves are tokens in index.css (light and dark). Tailwind only
// sees literal class names, so each use is spelled out per tone.
export type Tone = "neutral" | "waiting" | "working" | "done" | "stopped";

export const toneClasses = {
	pill: {
		neutral: "bg-tone-neutral text-tone-neutral-foreground",
		waiting: "bg-tone-waiting text-tone-waiting-foreground",
		working: "bg-tone-working text-tone-working-foreground",
		done: "bg-tone-done text-tone-done-foreground",
		stopped: "bg-tone-stopped text-tone-stopped-foreground",
	},
} satisfies Record<string, Record<Tone, string>>;
