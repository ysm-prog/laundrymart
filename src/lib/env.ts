import { z } from "zod";

/**
 * Fail-fast environment validation. A missing Supabase key should stop the
 * process at boot, not surface as a confusing 500 on the first query.
 */
const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  // Server-only: bypasses row-level security.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SENTRY_DSN: z.string().url().optional(),
  // Invoice delivery. Optional: the rest of the app runs without an email
  // provider configured, and the send action says so plainly instead of the
  // whole deployment refusing to boot over a feature most pages never touch.
  RESEND_API_KEY: z.string().min(10).optional(),
  INVOICE_FROM_EMAIL: z.string().email().optional(),
  INVOICE_FROM_NAME: z.string().min(1).optional(),
  INVOICE_REPLY_TO: z.string().email().optional(),
});

const parsed =
  process.env.SKIP_ENV_VALIDATION === "1"
    ? ({ success: true, data: process.env } as const)
    : schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  throw new Error("Environment validation failed. See .env.example.");
}

export const env = parsed.data as z.infer<typeof schema>;
