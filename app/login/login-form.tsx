"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInWithMicrosoft, signInWithPassword, type LoginState } from "./actions";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      className="h-11 w-full bg-brand text-base text-brand-foreground hover:bg-brand/90 active:bg-brand/80"
      loading={pending}
    >
      {pending ? "Signing in" : "Sign In"}
    </Button>
  );
}

function SsoButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" className="h-11 w-full bg-background" loading={pending}>
      {pending ? null : (
        <svg viewBox="0 0 23 23" aria-hidden className="size-4">
          <path fill="#f35325" d="M1 1h10v10H1z" />
          <path fill="#81bc06" d="M12 1h10v10H12z" />
          <path fill="#05a6f0" d="M1 12h10v10H1z" />
          <path fill="#ffba08" d="M12 12h10v10H12z" />
        </svg>
      )}
      Continue with Microsoft
    </Button>
  );
}

export function LoginForm({ next, initialError }: { next: string; initialError?: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(signInWithPassword, {
    error: initialError,
  });

  const emailError = state.fieldErrors?.email?.[0];
  const passwordError = state.fieldErrors?.password?.[0];

  return (
    <div className="space-y-6">
      <form action={signInWithMicrosoft}>
        <input type="hidden" name="next" value={next} />
        <SsoButton />
      </form>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-2xs tracking-wide text-muted-foreground uppercase">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <form action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="next" value={next} />

        <div className="space-y-2">
          <Label htmlFor="email">Email address</Label>
          {/* bg-background, not the Input default of transparent: the panel
              behind this form is muted, and a transparent field would dissolve
              into it. */}
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="name@vizserve.com"
            className="h-11 bg-background"
            aria-invalid={Boolean(emailError)}
            aria-describedby={emailError ? "email-error" : undefined}
          />
          <FieldError id="email-error" message={emailError} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            className="h-11 bg-background"
            aria-invalid={Boolean(passwordError)}
            aria-describedby={passwordError ? "password-error" : undefined}
          />
          <FieldError id="password-error" message={passwordError} />
          <div className="flex justify-end">
            <a
              href="/forgot-password"
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Forgot password?
            </a>
          </div>
        </div>

        {state.error ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {state.error}
          </p>
        ) : null}

        <SubmitButton />
      </form>
    </div>
  );
}
