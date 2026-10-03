import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { orpc } from '@/lib/orpc';
import { requireTenant } from '@/lib/session';

export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => requireTenant(context.queryClient),
  component: HomePage,
});

function HomePage() {
  const { data: tenant } = useSuspenseQuery(orpc.tenant.current.queryOptions());
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/inloggen' });
  };

  return (
    <>
      <PageHeader
        title="Vandaag"
        description={tenant.name}
        actions={
          <Button variant="outline" size="sm" onClick={signOut}>
            Uitloggen
          </Button>
        }
      />
      <section className="rounded-lg border p-4 text-sm">
        <p>Hier verschijnen straks je kaarten.</p>
      </section>
    </>
  );
}
