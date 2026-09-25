import Link from "next/link";

export default function AuthenticationErrorPage() {
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-error-heading">
        <p className="eyebrow">RepCoach sign-in</p>
        <h1 id="auth-error-heading">We couldn&apos;t complete sign-in.</h1>
        <p>
          Your session was not created. Return to RepCoach and try signing in again. If this
          continues, contact your administrator.
        </p>
        <Link className="auth-primary-action" href="/">Return to RepCoach</Link>
      </section>
    </main>
  );
}
