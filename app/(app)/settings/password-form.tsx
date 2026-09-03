"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { changeOwnPassword } from "./actions";

/**
 * P8-11 — the form that replaced the reset email.
 *
 * TWO MODES, ONE COMPONENT. `requireCurrent` is false only on
 * `/change-password`, where the person is holding a temporary password an owner
 * handed them minutes ago and is being made to replace it — asking them to
 * retype it is friction with nothing behind it.
 *
 * ⚠️ THE PROP IS A LAYOUT DECISION, NOT A SECURITY ONE. Which mode actually
 * applies is decided server-side in `changeOwnPassword` by reading
 * `must_change_password` from the database, so a browser that lied about this
 * prop would simply be asked for a current password it did not send. The prop
 * only decides whether to render a field.
 */
export function PasswordForm({
  requireCurrent = true,
  onChanged,
}: {
  requireCurrent?: boolean;
  /** Where to send them afterwards. Defaults to staying put. */
  onChanged?: "home" | "stay";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  function submit() {
    startTransition(async () => {
      setErrors({});

      const result = await changeOwnPassword(
        requireCurrent
          ? { currentPassword, password, confirmPassword }
          : { password, confirmPassword },
      );

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }

      // Cleared rather than left on screen. The fields hold a live credential,
      // and a form that stays filled in is one shoulder-surf away from handing
      // it over — the same reason the temporary password is shown once.
      setCurrentPassword("");
      setPassword("");
      setConfirmPassword("");

      toast.success("Password changed. Use the new one next time you sign in.");

      /*
       * ⚠️ `router.refresh()` BEFORE the push, and both are needed on the
       * forced path. `requireAuthContext` re-reads `must_change_password` on
       * every render, so without the refresh the redirect lands back on
       * /change-password from a cached layout that still believes the flag is
       * set — a loop that looks exactly like the change having failed.
       */
      router.refresh();
      if (onChanged === "home") router.push("/");
    });
  }

  const currentErrors = errors.currentPassword ?? [];
  const passwordErrors = errors.password ?? [];
  const confirmErrors = errors.confirmPassword ?? [];

  return (
    <form className="space-y-4" action={submit}>
      {requireCurrent ? (
        <div className="space-y-2">
          <Label htmlFor="currentPassword">Current password</Label>
          <Input
            id="currentPassword"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            aria-invalid={currentErrors.length > 0}
          />
          {currentErrors.map((message) => (
            <p key={message} className="text-xs text-destructive">
              {message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={passwordErrors.length > 0}
          aria-describedby="password_hint"
        />
        {passwordErrors.map((message) => (
          <p key={message} className="text-xs text-destructive">
            {message}
          </p>
        ))}
        {/* The policy said BEFORE it is failed, not after. `passwordSchema` is
            the authority; this sentence restates it so nobody has to discover
            the rules one rejection at a time. */}
        <p id="password_hint" className="text-xs text-muted-foreground">
          At least 12 characters, with upper and lower case letters and a number.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          aria-invalid={confirmErrors.length > 0}
        />
        {confirmErrors.map((message) => (
          <p key={message} className="text-xs text-destructive">
            {message}
          </p>
        ))}
      </div>

      <Button type="submit" loading={pending}>
        Change password
      </Button>
    </form>
  );
}
