import { z } from "zod";

/**
 * Auth contracts.
 *
 * Schemas live in lib/schemas/ and are the handoff artefact between the two
 * tracks (D3a) — agreed at the start of a phase, imported by both the client
 * form and the server action so a rule is never written twice.
 */

export const loginSchema = z.object({
  email: z.email({ message: "Enter a valid email address." }),
  password: z.string().min(1, { message: "Enter your password." }),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Password policy. Email + password is enabled alongside Entra SSO (D7), which
 * means this team owns a password policy and a reset flow — Entra does not
 * absorb them (P0-03).
 */
export const passwordSchema = z
  .string()
  .min(12, { message: "Use at least 12 characters." })
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value), {
    message: "Include both upper and lower case letters.",
  })
  .refine((value) => /\d/.test(value), { message: "Include at least one number." });

export const requestPasswordResetSchema = z.object({
  email: z.email({ message: "Enter a valid email address." }),
});

export const updatePasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type UpdatePasswordInput = z.infer<typeof updatePasswordSchema>;

/**
 * P8-11 — changing your OWN password, from `/settings`.
 *
 * `updatePasswordSchema` above was written for the reset-email screen that was
 * never built and is now withdrawn: a person arriving on a one-time link had
 * already proved who they were by opening their inbox, so it asks for the new
 * password alone. Signed in, that proof is missing — a session is a laptop left
 * unlocked as often as it is the person it belongs to — so the current password
 * is required as well.
 *
 * ⚠️ THE CURRENT PASSWORD IS NOT VALIDATED AGAINST `passwordSchema`, and that is
 * not an oversight. It is a credential that ALREADY EXISTS, possibly predating
 * the policy, and the only question worth asking about it is whether GoTrue
 * accepts it. Running the policy over it would refuse a legitimate person their
 * only route to a compliant password.
 */
export const changeOwnPasswordSchema = z
  .object({
    currentPassword: z.string().min(1, { message: "Enter your current password." }),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  })
  /**
   * A "new" password identical to the old one is a form somebody filled in
   * without changing anything, and it is worth catching HERE rather than
   * letting GoTrue accept it silently. It matters most in the forced-change
   * flow: retyping the temporary password an owner just read out would clear
   * `must_change_password` while leaving the handed-over credential in place,
   * which is precisely the state the flag exists to end.
   */
  .refine((values) => values.password !== values.currentPassword, {
    message: "That is your current password. Choose a different one.",
    path: ["password"],
  });

export type ChangeOwnPasswordInput = z.infer<typeof changeOwnPasswordSchema>;

/**
 * The forced-change variant — no current password.
 *
 * Somebody held at `/change-password` was handed a temporary password by an
 * owner minutes ago and is being asked to replace it. Demanding they retype it
 * is friction with nothing behind it: they are already signed in WITH it, so
 * the session is the proof, and the "different from current" check above cannot
 * run because there is nothing to compare against.
 */
export const forcedPasswordChangeSchema = updatePasswordSchema;
