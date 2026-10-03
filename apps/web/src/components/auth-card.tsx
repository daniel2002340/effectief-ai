import type { FormEvent, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface AuthCardProps {
  title: string;
  description: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (form: FormData) => void;
  children: ReactNode;
  footer: ReactNode;
}

/** Shared layout for the login and registration forms. */
export function AuthCard({
  title,
  description,
  submitLabel,
  pending,
  error,
  onSubmit,
  children,
  footer,
}: AuthCardProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  };

  return (
    <Card className="mx-auto max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl font-semibold">{title}</h1>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={handleSubmit} noValidate={false}>
          {children}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? 'Even geduld…' : submitLabel}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">{footer}</p>
      </CardContent>
    </Card>
  );
}
