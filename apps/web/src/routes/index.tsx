import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { orpc } from '@/lib/orpc';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const status = useQuery(orpc.system.status.queryOptions());

  return (
    <>
      <PageHeader title="Vandaag" description="Hier verschijnen straks je kaarten." />
      <section className="rounded-lg border p-4 text-sm" aria-live="polite">
        {status.isPending ? <p>Verbinding maken…</p> : null}
        {status.isSuccess ? <p>Verbonden met EffectiefAI.</p> : null}
        {status.isError ? (
          <div className="flex items-center justify-between gap-4">
            <p>De server is even niet bereikbaar.</p>
            <Button variant="outline" size="sm" onClick={() => status.refetch()}>
              Opnieuw proberen
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
}
