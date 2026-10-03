import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { FormField } from '@/components/form-field';
import { authClient, organizationSlug } from '@/lib/auth-client';

export const Route = createFileRoute('/registreren')({
  component: RegisterPage,
});

const MIN_PASSWORD_LENGTH = 10;

function RegisterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (form: FormData) => {
    setPending(true);
    setError(null);
    const company = String(form.get('company')).trim();

    const signUp = await authClient.signUp.email({
      name: String(form.get('name')).trim(),
      email: String(form.get('email')).trim(),
      password: String(form.get('password')),
    });
    if (signUp.error) {
      setPending(false);
      setError(
        signUp.error.status === 429
          ? 'Te veel pogingen. Probeer het over een kwartier opnieuw.'
          : 'Registreren lukte niet. Controleer je gegevens, of log in als je al een account hebt.',
      );
      return;
    }

    // The new company becomes the session's tenant.
    const created = await authClient.organization.create({
      name: company,
      slug: organizationSlug(company),
    });
    setPending(false);
    if (created.error) {
      setError('Je account is aangemaakt, maar je bedrijf nog niet. Probeer het opnieuw.');
      return;
    }
    await queryClient.invalidateQueries();
    await navigate({ to: '/' });
  };

  return (
    <AuthCard
      title="Registreren"
      description="Maak een account aan voor jou en je bedrijf."
      submitLabel="Account aanmaken"
      pending={pending}
      error={error}
      onSubmit={submit}
      footer={
        <>
          Al een account?{' '}
          <Link to="/inloggen" className="underline">
            Inloggen
          </Link>
        </>
      }
    >
      <FormField name="name" label="Je naam" autoComplete="name" />
      <FormField name="company" label="Bedrijfsnaam" autoComplete="organization" />
      <FormField name="email" label="E-mailadres" type="email" autoComplete="email" />
      <FormField
        name="password"
        label={`Wachtwoord (minstens ${MIN_PASSWORD_LENGTH} tekens)`}
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
      />
    </AuthCard>
  );
}
