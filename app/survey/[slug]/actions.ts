"use server";

import { headers } from "next/headers";

import type { Json } from "@/lib/database.types";
import { FormSchemaError, parseFormSchema } from "@/lib/form-builder/schema";
import { validateFieldValues } from "@/lib/form-builder/values";
import { externalResponseSubmissionSchema, type FormResponseResult } from "@/lib/schemas/forms";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P17-15 — an answer from somebody with no login.
 *
 * The service role, because `anon` holds no table privileges. So everything this
 * accepts is checked here against a form it re-reads, and the function behind it is
 * granted to the service role only: nobody reaches it without this validation.
 * `is_anonymous` comes from the form, never the payload, as on /respond.
 */
export async function submitExternalResponse(input: unknown): Promise<FormResponseResult> {
  const parsed = externalResponseSubmissionSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: "That answer could not be read. Reload the page and retry." };
  }

  const supabase = createAdminClient();

  const { data: form, error: formError } = await supabase
    .from("vizserve_pms_forms")
    .select("schema, is_anonymous")
    .eq("slug", parsed.data.slug)
    .eq("purpose", "INTERNAL")
    .eq("accepts_external", true)
    .eq("is_active", true)
    .maybeSingle();

  if (formError) return { ok: false, error: "This form could not be read. Please try again shortly." };
  if (!form) return { ok: false, error: "This form is no longer accepting answers." };

  // The page said which it was. If that has changed, they have not agreed to the new one.
  if (parsed.data.promised_anonymous !== form.is_anonymous) {
    return { ok: false, error: "This form has changed since you opened it. Reload the page before answering. Nothing was saved." };
  }

  let schema;

  try {
    schema = await parseFormSchema(form.schema);
  } catch (cause) {
    if (!(cause instanceof FormSchemaError)) throw cause;
    console.error("[P17-15] refused a form schema on /survey", { slug: parsed.data.slug, reason: cause.reason.code });
    return { ok: false, error: "This form could not be opened. Tell whoever sent you the link." };
  }

  const validation = await validateFieldValues(schema, parsed.data.field_values);

  if (!validation.ok) {
    return {
      ok: false,
      error: validation.formError ?? "Please correct the highlighted answers.",
      field_errors: validation.fieldErrors,
    };
  }

  const headerList = await headers();
  const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? headerList.get("x-real-ip");

  const { data, error } = await supabase.rpc("vizserve_pms_submit_external_response", {
    p_slug: parsed.data.slug,
    p_field_values: validation.values as Json,
    p_name: parsed.data.respondent_name ?? null,
    p_email: parsed.data.respondent_email ?? null,
    p_ip: ip,
  });

  if (error) {
    console.error("[P17-15] an external answer was refused", { slug: parsed.data.slug, code: error.code });
    return { ok: false, error: "Your answer could not be saved. Please try again." };
  }

  const result = data as { ok: boolean; error?: string };

  if (result.ok) return { ok: true };

  switch (result.error) {
    case "closed":
      return { ok: false, error: "This form has closed. Nothing was saved." };
    case "rate_limited":
      return { ok: false, error: "Too many answers from this connection. Please try again in an hour." };
    case "identity_required":
      return { ok: false, error: "Please give your name and a valid email." };
    default:
      return { ok: false, error: "This form is no longer accepting answers." };
  }
}
