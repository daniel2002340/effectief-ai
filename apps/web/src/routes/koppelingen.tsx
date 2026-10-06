import type { ConnectionSummary, MailProvider } from '@effectief/shared';
import Nango from '@nangohq/frontend';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  disconnectExplanation,
  lastSyncText,
  mailProviderList,
  type Notice,
  noticeForError,
  noticeForOutcome,
  notices,
  providerLabels,
  statusText,
  waitForConnection,
} from '@/lib/connect-flow';
import { orpc } from '@/lib/orpc';
import { requireTenant } from '@/lib/session';

export const Route = createFileRoute('/koppelingen')({
  beforeLoad: ({ context }) => requireTenant(context.queryClient),
  component: ConnectionsPage,
});

/**
 * Opens Nango's Connect UI and hands it the session token once the API made
 * one. `close` after a finished flow is not a cancel.
 */
function openConnectUI(
  sessionToken: () => Promise<string>,
  on: { connect: () => void; cancel: () => void; error: (cause?: unknown) => void },
) {
  let finished = false;
  const ui = new Nango().openConnectUI({
    lang: 'nl',
    onEvent: (event) => {
      if (event.type === 'connect') {
        finished = true;
        on.connect();
      } else if (event.type === 'error') {
        finished = true;
        on.error();
      } else if (event.type === 'close' && !finished) {
        on.cancel();
      }
    },
  });
  sessionToken().then(
    (token) => ui.setSessionToken(token),
    (cause: unknown) => {
      finished = true;
      ui.close();
      on.error(cause);
    },
  );
}

function ConnectionsPage() {
  const { data: connections } = useSuspenseQuery(orpc.connections.list.queryOptions());
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.connections.key() });

  const connect = (provider: MailProvider) => {
    setNotice(null);
    setBusy(true);
    let attemptId: string | undefined;
    openConnectUI(
      async () => {
        const started = await orpc.connections.startConnect.call({ provider });
        attemptId = started.attemptId;
        return started.sessionToken;
      },
      {
        connect: async () => {
          setNotice(notices.connecting);
          if (!attemptId) return;
          const id = attemptId;
          try {
            const outcome = await waitForConnection(() =>
              orpc.connections.complete.call({ attemptId: id }),
            );
            setNotice(outcome === 'timeout' ? notices.slow : (noticeForOutcome(outcome) ?? null));
          } catch (error) {
            setNotice(noticeForError(error));
          }
          setBusy(false);
          await refresh();
        },
        cancel: () => {
          setNotice(notices.cancelled);
          setBusy(false);
        },
        error: (cause) => {
          setNotice(cause ? noticeForError(cause) : notices.failed);
          setBusy(false);
        },
      },
    );
  };

  const reconnect = (connection: ConnectionSummary) => {
    setNotice(null);
    setBusy(true);
    openConnectUI(
      async () =>
        (await orpc.connections.reconnect.call({ connectionId: connection.id })).sessionToken,
      {
        connect: async () => {
          setNotice(notices.reconnected);
          setBusy(false);
          // The worker checks the account first; the status follows shortly.
          setTimeout(() => void refresh(), 5000);
        },
        cancel: () => {
          setNotice(notices.cancelled);
          setBusy(false);
        },
        error: (cause) => {
          setNotice(cause ? noticeForError(cause) : notices.reconnectFailed);
          setBusy(false);
        },
      },
    );
  };

  const disconnect = async (connection: ConnectionSummary) => {
    setNotice(null);
    setBusy(true);
    try {
      await orpc.connections.disconnect.call({ connectionId: connection.id });
      setNotice(notices.disconnected);
    } catch (error) {
      setNotice(noticeForError(error));
    }
    setBusy(false);
    await refresh();
  };

  return (
    <>
      <PageHeader
        title="Koppelingen"
        description="Koppel je mailbox, zodat EffectiefAI nieuwe mail kan voorbereiden."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/">Terug</Link>
          </Button>
        }
      />

      {notice ? <NoticeBanner notice={notice} /> : null}

      <section className="mb-8 flex flex-wrap gap-3">
        {mailProviderList.map((provider) => (
          <Button key={provider} disabled={busy} onClick={() => connect(provider)}>
            {providerLabels[provider]} koppelen
          </Button>
        ))}
      </section>

      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">Je hebt nog geen mailbox gekoppeld.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {connections.map((connection) => (
            <li key={connection.id}>
              <ConnectionCard
                connection={connection}
                busy={busy}
                onReconnect={() => reconnect(connection)}
                onDisconnect={() => disconnect(connection)}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NoticeBanner({ notice }: { notice: Notice }) {
  const tone = {
    success: 'border-green-600/30 bg-green-50 text-green-900',
    error: 'border-red-600/30 bg-red-50 text-red-900',
    info: 'border-border bg-muted text-foreground',
  }[notice.tone];
  return (
    <p role="status" className={`mb-6 rounded-lg border p-3 text-sm ${tone}`}>
      {notice.text}
    </p>
  );
}

function ConnectionCard({
  connection,
  busy,
  onReconnect,
  onDisconnect,
}: {
  connection: ConnectionSummary;
  busy: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const manageable =
    connection.canManage && (connection.status === 'active' || connection.status === 'expired');

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {providerLabels[connection.provider]}
          {connection.accountLabel ? ` · ${connection.accountLabel}` : ''}
        </CardTitle>
        <CardDescription>
          {statusText(connection)} · Laatste synchronisatie: {lastSyncText(connection.lastSyncedAt)}
        </CardDescription>
      </CardHeader>
      {manageable ? (
        <CardContent className="flex flex-col gap-4">
          {confirming ? (
            <div className="rounded-lg border p-4 text-sm">
              <p className="mb-4">{disconnectExplanation(connection.provider)}</p>
              <div className="flex gap-3">
                <Button variant="destructive" size="sm" disabled={busy} onClick={onDisconnect}>
                  Ja, ontkoppelen
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
                  Annuleren
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-3">
              {connection.status === 'expired' ? (
                <Button size="sm" disabled={busy} onClick={onReconnect}>
                  Opnieuw koppelen
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Ontkoppelen
              </Button>
            </div>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}
