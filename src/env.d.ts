import "../.astro/types.d.ts";

import type { z } from "zod";
import type { headerSessionSchema } from "./contracts/auth";

declare global {
	namespace App {
		interface Locals {
			session: z.infer<typeof headerSessionSchema>;
		}
	}
}
