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
