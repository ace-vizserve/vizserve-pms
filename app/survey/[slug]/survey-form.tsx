"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RespondForm } from "@/app/(app)/respond/[slug]/respond-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ParsedFormSchema } from "@/lib/form-builder/schema";

import { submitExternalResponse } from "./actions";

/**
 * The same form as /respond, with this page's own way of sending it. A named form asks
 * who is answering first, since there is no login to say. The query client is only
 * here because `RespondForm` refreshes the staff sidebar, and this page has neither.
 */
export function SurveyForm({
  formId,
  formSlug,
  formName,
  isAnonymous,
  schema,
}: {
  formId: string;
  formSlug: string;
  formName: string;
  isAnonymous: boolean;
  schema: ParsedFormSchema;
}) {
  const [queryClient] = useState(() => new QueryClient());
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  return (
    <QueryClientProvider client={queryClient}>
      {isAnonymous ? null : (
        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="respondent_name">Your name</Label>
            <Input id="respondent_name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="respondent_email">Your email</Label>
            <Input
              id="respondent_email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        </div>
      )}
      <RespondForm
        formId={formId}
        formSlug={formSlug}
        formName={formName}
        isAnonymous={isAnonymous}
        schema={schema}
        doneNote="You can close this page."
        submit={(fieldValues) =>
          submitExternalResponse({
            slug: formSlug,
            field_values: fieldValues,
            promised_anonymous: isAnonymous,
            respondent_name: isAnonymous ? undefined : name,
            respondent_email: isAnonymous ? undefined : email,
          })
        }
      />
    </QueryClientProvider>
  );
}
