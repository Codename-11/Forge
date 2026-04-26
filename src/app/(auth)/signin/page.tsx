import { redirect } from "next/navigation";
import { signIn } from "@/server/auth";
import { AuthError } from "next-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8">
        <header className="space-y-1 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/forge-app-icon-v2-ember.svg"
            alt="Forge"
            width={48}
            height={48}
            className="mx-auto rounded-md"
          />
          <h1 className="text-lg font-semibold tracking-tight">Sign in to Forge</h1>
          <p className="text-xs text-muted-foreground">
            Fast, quiet, keyboard-driven project management.
          </p>
        </header>

        <form
          action={async (formData) => {
            "use server";
            try {
              await signIn("credentials", {
                email: String(formData.get("email") ?? ""),
                password: String(formData.get("password") ?? ""),
                redirectTo: callbackUrl || "/dashboard",
              });
            } catch (err) {
              if (err instanceof AuthError) {
                redirect(`/signin?error=${encodeURIComponent(err.type)}`);
              }
              throw err;
            }
          }}
          className="space-y-2"
        >
          <Input name="email" type="email" placeholder="you@company.com" required autoFocus />
          <Input name="password" type="password" placeholder="Password" required />
          {error && (
            <p className="text-xs text-danger">
              {error === "CredentialsSignin"
                ? "Invalid email or password."
                : "Sign-in failed. Try again."}
            </p>
          )}
          <Button type="submit" className="w-full" variant="ember">
            Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
