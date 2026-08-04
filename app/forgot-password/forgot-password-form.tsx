"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { requestPasswordReset } from "./actions";

/**
 * The success state does NOT confirm whether the address exists.
 *
 * A form that says "no account with that email" is an account-enumeration
 * oracle: anyone can walk a list of addresses and learn which colleagues work
 * here. The same message either way costs a real user nothing — they check their
 * inbox regardless — and tells an attacker nothing.
 */
export function ForgotPasswordForm() {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const result = await requestPasswordReset(email);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setSent(true);
    });
  }

  if (sent) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-success-subtle text-success">
          <Check className="size-5" />
        </div>
        <h2 className="text-base font-semibold">Check your email</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          If there is an account for {email}, a reset link is on its way. It expires in an hour.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" loading={pending} className="w-full">
        Send reset link
      </Button>
    </form>
  );
}
