import type { CSSProperties } from "react";

type CSSPropertiesWithVariables = CSSProperties & {
	[key: `--${string}`]: string | number | undefined;
};

export function cssProperties(
	value: CSSPropertiesWithVariables
): CSSPropertiesWithVariables {
	return value;
}
