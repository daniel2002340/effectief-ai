import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { connectionsToRenew, renewLabel, renewNoticeText } from '@/lib/connect-flow';
import { orpc } from '@/lib/orpc';
import { requireTenant } from '@/lib/session';

export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => requireTenant(context.queryClient),
  component: HomePage,
});

function HomePage() {
  const { data: tenant } = useSuspenseQuery(orpc.tenant.current.queryOptions());
  // Until the feed is built (session 5), the card "Koppeling vernieuwen" shows
  // here. Not suspending: the page never waits for or fails on this notice.
  const { data: connections } = useQuery(orpc.connections.list.queryOptions());
  const toRenew = connectionsToRenew(connections ?? []);
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
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/koppelingen">Koppelingen</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={signOut}>
              Uitloggen
            </Button>
          </div>
        }
      />
      {toRenew.map((connection) => (
        <section
          key={connection.id}
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-600/30 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p>{renewNoticeText(connection)}</p>
          <Button size="sm" asChild>
            <Link to="/koppelingen">{renewLabel}</Link>
          </Button>
        </section>
      ))}
      <section className="rounded-lg border p-4 text-sm">
        <p>Hier verschijnen straks je kaarten.</p>
      </section>
    </>
  );
}
