import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next =
    params.next?.startsWith("/") && !params.next.startsWith("//") ? params.next : "/dashboard";

  return (
    /*
      Muted page wash with the card on the raised surface — the tonal step is
      what separates the two, with shadow.1's hairline ring bounding the card.
      No heavy drop shadow: elevation above the ring is reserved for overlays.
    */
    <main className="flex min-h-svh flex-col bg-muted/40 px-4 py-12">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-sm bg-primary text-xs font-semibold text-primary-foreground">
            V
          </span>
          <span className="text-sm font-semibold tracking-tight">VizServe PMS</span>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-ring">
          <div className="mb-6 space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-xs text-muted-foreground">
              Use your VizServe account to continue.
            </p>
          </div>

          <LoginForm next={next} initialError={params.error} />
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Accounts are created by an administrator. Ask your team leader if you need access.
        </p>
      </div>
    </main>
  );
}
