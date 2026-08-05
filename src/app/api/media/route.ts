import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import {
  MAX_MEDIA_BYTES, MEDIA_BUCKET, MEDIA_KINDS, MEDIA_MIME_TYPES, MEDIA_SCOPES,
  MAX_PHOTOS, OWNER_REF_PATTERN, mediaPath,
} from "@/lib/media";

/**
 * Upload endpoint for run media (spec §7.8, §7.10).
 *
 * One file per request. The driver app calls this ahead of `/api/sync` so the
 * batch endpoint only ever carries storage paths — a queue of stops with photos
 * would otherwise be a single multi-megabyte request that fails as a unit on a
 * flaky connection, and would have to start over.
 *
 * Idempotent by construction: the object key is derived from the caller's tenant
 * and the record's client ref, and the upload upserts. Replaying a queue after a
 * dropped response rewrites the same object rather than duplicating it.
 *
 * The tenant segment of the path comes from the session and never from the
 * request, so a caller cannot address another tenant's folder even before the
 * storage policy gets a say.
 */

const meta = z.object({
  scope: z.enum(MEDIA_SCOPES),
  kind: z.enum(MEDIA_KINDS),
  ownerRef: z.string().regex(OWNER_REF_PATTERN, "Malformed owner reference"),
  index: z.coerce.number().int().min(0).max(MAX_PHOTOS - 1),
});

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!can(session.role, "operations.write")) {
    return NextResponse.json({ error: "Your role cannot upload run media." }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });

  const parsed = meta.safeParse({
    scope: form.get("scope"),
    kind: form.get("kind"),
    ownerRef: form.get("ownerRef"),
    index: form.get("index"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Malformed upload", issues: parsed.error.issues.slice(0, 5) },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file attached." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return NextResponse.json({ error: "That file is too large." }, { status: 413 });
  }

  const contentType = file.type;
  if (!(MEDIA_MIME_TYPES as readonly string[]).includes(contentType)) {
    return NextResponse.json({ error: "Only JPEG, PNG and WebP images are accepted." }, { status: 415 });
  }

  const path = mediaPath({ ...parsed.data, tenantId: session.tenantId, contentType });

  // RLS-bound client: the storage policy re-checks the tenant segment of the
  // key against the caller's memberships.
  const supabase = await createClient();
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, file, { contentType, upsert: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ path }, { status: 200 });
}
