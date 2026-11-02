import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { describeDbError } from "@/lib/actions";
import { loadOpenImportNumbers, runHistoryPage } from "@/lib/xero/history";

/**
 * The MYOB history out of Xero, one step at a time, for the screen on Settings ›
 * Bring in your books. `write: false` reads everything and writes nothing, so the
 * counts can be looked at first.
 *
 * `admin.write`, the same gate as uploading a MYOB export, because this writes the
 * same ledger. `0062`'s functions check the role again for themselves.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.discriminatedUnion("step", [
  z.object({
    step: z.literal("page"),
    phase: z.enum(["history", "opening"]),
    page: z.number().int().min(1).max(500),
    write: z.boolean(),
  }),
  z.object({ step: z.literal("open") }),
  z.object({
    step: z.literal("settle"),
    numbers: z.array(z.string().min(1).max(40)).max(5000),
    summary: z.string().max(500),
  }),
]);

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!can(session.role, "admin.write")) {
    return NextResponse.json({ ok: false, error: "Only an administrator can do this." }, { status: 403 });
  }

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "That request could not be read." }, { status: 400 });
  }

  const supabase = await createClient();
  const input = parsed.data;

  if (input.step === "open") {
    return NextResponse.json({ ok: true, numbers: await loadOpenImportNumbers(supabase, session.tenantId) });
  }

  if (input.step === "settle") {
    const { data, error } = await supabase.rpc("settle_invoice_history", {
      p_tenant: session.tenantId, p_numbers: input.numbers,
    });
    if (error) return NextResponse.json({ ok: false, error: describeDbError(error) }, { status: 500 });
    await recordAudit(session, {
      entity: "import", action: "sync",
      summary: `Invoice history from Xero: ${input.summary}`.slice(0, 500),
      metadata: { settled: data },
    });
    return NextResponse.json({ ok: true, settled: data });
  }

  const result = await runHistoryPage(supabase, session.tenantId, input);
  return NextResponse.json(result, { status: result.ok ? 200 : result.retryAfter ? 429 : 502 });
}
