import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { FormField } from '@/components/form-field';
import { authClient } from '@/lib/auth-client';

export const Route = createFileRoute('/inloggen')({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (form: FormData) => {
    setPending(true);
    setError(null);
    const { error: signInError } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    setPending(false);
    if (signInError) {
      setError(
        signInError.status === 429
          ? 'Te veel pogingen. Probeer het over een kwartier opnieuw.'
          : 'Dit e-mailadres en wachtwoord horen niet bij elkaar.',
      );
      return;
    }
    await queryClient.invalidateQueries();
    await navigate({ to: '/' });
  };

  return (
    <AuthCard
      title="Inloggen"
      description="Log in om je kaarten van vandaag te zien."
      submitLabel="Inloggen"
      pending={pending}
      error={error}
      onSubmit={submit}
      footer={
        <>
          Nog geen account?{' '}
          <Link to="/registreren" className="underline">
            Registreren
          </Link>
        </>
      }
    >
      <FormField name="email" label="E-mailadres" type="email" autoComplete="email" />
      <FormField
        name="password"
        label="Wachtwoord"
        type="password"
        autoComplete="current-password"
      />
    </AuthCard>
  );
}
