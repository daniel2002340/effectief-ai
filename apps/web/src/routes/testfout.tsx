import { MonitoringTestError } from '@effectief/shared';
import { ORPCError } from '@orpc/client';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { env } from '@/lib/env';
import { testClient } from '@/lib/orpc';
import { requireTenant } from '@/lib/session';
import { requireTestErrors } from '@/lib/test-errors';

/** Test errors for checking Sentry; not in production (decision #069). */
export const Route = createFileRoute('/testfout')({
  beforeLoad: async ({ context }) => {
    requireTestErrors(env.VITE_SENTRY_ENVIRONMENT);
    await requireTenant(context.queryClient);
  },
  component: TestErrorPage,
});

function TestErrorPage() {
  const [status, setStatus] = useState<string | null>(null);

  const callApi = async (target: 'api' | 'worker') => {
    setStatus(null);
    try {
      await testClient.test.error({ target });
      setStatus('De job staat klaar. De worker laat hem twee keer mislukken.');
    } catch (error) {
      const status = error instanceof ORPCError ? error.status : undefined;
      if (status === 403) setStatus('Alleen de eigenaar van het bedrijf kan een testfout maken.');
      else if (target === 'api' && status === 500) setStatus('De api gaf de verwachte fout.');
      else setStatus('Dat lukte niet. Probeer het later opnieuw.');
    }
  };

  return (
    <>
      <PageHeader
        title="Testfout"
        description="Controleer of fouten in Sentry aankomen, zonder persoonsgegevens."
      />
      <section className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={() => {
            // Thrown in an event handler: Sentry's global handler reports it.
            throw new MonitoringTestError('web');
          }}
        >
          Fout in de browser
        </Button>
        <Button variant="outline" onClick={() => callApi('api')}>
          Fout in de api
        </Button>
        <Button variant="outline" onClick={() => callApi('worker')}>
          Fout in de worker
        </Button>
      </section>
      {status ? <p className="mt-4 text-sm text-muted-foreground">{status}</p> : null}
    </>
  );
}
