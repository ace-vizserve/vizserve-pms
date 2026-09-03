"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInWithPassword, type LoginState } from "./actions";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

/**
 * No fill override any more.
 *
 * `--primary` IS the brand blue (Q15, settled), so `bg-brand text-brand-foreground`
 * repainted the button in its own colour — and in doing so threw away the
 * `grade-primary` face and the hover/active states the variant carries. The
 * default variant is the same colour and a lit one.
 *
 * `loading` is not optional on a submit: it sets `aria-busy` and disables the
 * button together, so the visual and the assistive-tech signal cannot drift (§4.2).
 */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" loading={pending}>
      {pending ? "Signing in" : "Sign in"}
    </Button>
  );
}

/**
 * NO MICROSOFT BUTTON, and its absence is deliberate rather than unbuilt.
 *
 * "Continue with Microsoft" and the `or` divider under it were removed on
 * request: email and password is the only way in. The `signInWithMicrosoft`
 * action went with them, so nothing here can start an Entra flow.
 *
 * `app/auth/callback/route.ts` stays too, and since P8-11 it has no live
 * caller at all: the reset email it was serving is withdrawn, and the route is
 * kept only because restoring Entra would need it back. See its own header.
 *
 * ⚠️ NO "FORGOT PASSWORD?" LINK EITHER, as of P8-11, and its absence is the
 * same kind of decision. There is no self-service reset any more — somebody
 * locked out asks an owner for a temporary password, which is a conversation
 * rather than a link. A link to a route that no longer exists is worse than no
 * link; so is one to a page that says "ask an admin", because it puts a dead
 * end where a working control used to be.
 */
export function LoginForm({ next, initialError }: { next: string; initialError?: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(signInWithPassword, {
    error: initialError,
  });

  const emailError = state.fieldErrors?.email?.[0];
  const passwordError = state.fieldErrors?.password?.[0];

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="next" value={next} />

        <div className="space-y-2">
          <Label htmlFor="email">Email address</Label>
          {/* No height or fill override. Both existed to survive the muted panel
              this form used to sit on; it sits on a card now, so the primitive's
              own 40px and its own fill are correct and stay on the control
              scale (§1.3) with every other field in the product. */}
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="name@vizserve.com"
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
            aria-invalid={Boolean(passwordError)}
            aria-describedby={passwordError ? "password-error" : undefined}
          />
          <FieldError id="password-error" message={passwordError} />
          {/* P8-11. Where the "Forgot password?" link was. Replaced by a
              sentence rather than removed outright: somebody who cannot get in
              needs to be told what to do, and silence sends them round the
              login form a fourth time. */}
          <p className="text-xs text-muted-foreground">
            Forgotten it? Ask an admin to issue you a temporary password.
          </p>
        </div>

        {state.error ? (
          <p
            role="alert"
            // The destructive TRIPLE (§1.2) — solid for text, `-subtle` fill,
            // `-border` hairline. `border-destructive/30 bg-destructive/5` was an
            // alpha of the solid, which is a different colour in dark mode and
            // measured nowhere.
            className="rounded-md border border-destructive-border bg-destructive-subtle px-3 py-2 text-xs text-destructive"
          >
            {state.error}
          </p>
        ) : null}

        <SubmitButton />
      </form>
    </div>
  );
}
