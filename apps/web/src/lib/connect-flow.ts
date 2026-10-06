import type { CompleteConnectOutput, ConnectionSummary, MailProvider } from '@effectief/shared';
import { ORPCError } from '@orpc/client';

// Texts and the waiting logic of the Koppelingen page (docs/integrations.md
// §2.1, §2.3, §5.3). Kept out of the component so they can be tested.

export const providerLabels: Record<ConnectionSummary['provider'], string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  moneybird: 'Moneybird',
  mollie: 'Mollie',
};

export const mailProviderList: readonly MailProvider[] = ['gmail', 'outlook'];

export type Notice = { tone: 'success' | 'error' | 'info'; text: string };

export const notices = {
  connecting: { tone: 'info', text: 'Koppeling wordt afgerond…' },
  connected: { tone: 'success', text: 'Je mailbox is gekoppeld.' },
  cancelled: { tone: 'info', text: 'Koppelen afgebroken. Er is niets gekoppeld.' },
  failed: { tone: 'error', text: 'Koppelen is mislukt. Probeer het opnieuw.' },
  duplicate: {
    tone: 'error',
    text: 'Deze mailbox is al gekoppeld. Werkt die koppeling niet meer? Kies dan "Koppeling vernieuwen" bij die mailbox.',
  },
  slow: {
    tone: 'info',
    text: 'Het koppelen duurt langer dan verwacht. Kijk over een paar minuten opnieuw op deze pagina.',
  },
  reconnected: {
    tone: 'success',
    text: 'Koppeling vernieuwd. Het kan een minuut duren voor de status bijgewerkt is.',
  },
  reconnectFailed: {
    tone: 'error',
    text: 'Opnieuw koppelen is mislukt. Log in met hetzelfde account als bij het eerste koppelen.',
  },
  disconnected: {
    tone: 'success',
    text: 'Ontkoppeld. De mail die via deze koppeling binnenkwam, wordt binnen een paar minuten verwijderd.',
  },
  unavailable: { tone: 'error', text: 'Koppelen lukt nu niet. Probeer het later opnieuw.' },
  forbidden: {
    tone: 'error',
    text: 'Alleen wie deze koppeling maakte of een eigenaar kan dit doen.',
  },
} as const satisfies Record<string, Notice>;

/** A failed call as a notice; the API's own codes, never its messages. */
export function noticeForError(error: unknown): Notice {
  if (error instanceof ORPCError) {
    if (error.status === 403) return notices.forbidden;
    if (error.status === 503) return notices.unavailable;
  }
  return notices.failed;
}

export function noticeForOutcome(outcome: CompleteConnectOutput): Notice | undefined {
  if (outcome.status === 'connected') return notices.connected;
  if (outcome.status === 'failed') {
    return outcome.failureCode === 'duplicate_account' ? notices.duplicate : notices.failed;
  }
  return undefined;
}

/**
 * Asks the API where the flow stands until it is done or `attempts` runs out.
 * The API itself finds the connection at Nango by the attempt's tag (§2.3).
 */
export async function waitForConnection(
  complete: () => Promise<CompleteConnectOutput>,
  { attempts = 20, intervalMs = 3000, sleep = defaultSleep } = {},
): Promise<CompleteConnectOutput | 'timeout'> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const outcome = await complete();
    if (outcome.status !== 'pending') return outcome;
    await sleep(intervalMs);
  }
  return 'timeout';
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What the status of a connection means for the user. */
export function statusText(connection: ConnectionSummary): string {
  switch (connection.status) {
    case 'active':
      return 'Actief';
    case 'expired':
      return connection.statusReason === 'account_mismatch'
        ? 'Werkt niet: opnieuw gekoppeld met een ander account'
        : 'Verlopen: er komt geen nieuwe mail binnen';
    case 'revoked':
      return 'Wordt ontkoppeld';
    case 'purged':
      return 'Ontkoppeld';
  }
}

/** The label of the button that renews an expired connection, here and on the home page. */
export const renewLabel = 'Koppeling vernieuwen';

/** What the user has to do now, or nothing when the connection just works. */
export function nextStepText(connection: ConnectionSummary): string | null {
  const provider = providerLabels[connection.provider];
  switch (connection.status) {
    case 'active':
    case 'purged':
      return null;
    case 'revoked':
      return 'De mail van deze koppeling wordt verwijderd. Dat duurt meestal een paar minuten.';
    case 'expired': {
      if (!connection.canManage) {
        return 'Vraag wie deze koppeling maakte, of een eigenaar, om de koppeling te vernieuwen.';
      }
      const account = connection.accountLabel ?? `hetzelfde ${provider}-account als eerst`;
      return connection.statusReason === 'account_mismatch'
        ? `Kies "${renewLabel}" en log in met ${account}. Een ander account kan niet in deze koppeling.`
        : `Kies "${renewLabel}" en log opnieuw in bij ${provider} met ${account}. Je mist geen mail: wat intussen binnenkwam, wordt daarna alsnog opgehaald.`;
    }
  }
}

/** Expired connections that need the user, for the notice on the home page. */
export const connectionsToRenew = (connections: ConnectionSummary[]) =>
  connections.filter((connection) => connection.status === 'expired');

export function renewNoticeText(connection: ConnectionSummary): string {
  const label = connection.accountLabel ? ` (${connection.accountLabel})` : '';
  return `De koppeling met ${providerLabels[connection.provider]}${label} werkt niet meer. Nieuwe mail komt niet binnen tot je de koppeling vernieuwt.`;
}

const dateTime = new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'Europe/Amsterdam',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function lastSyncText(lastSyncedAt: Date | null): string {
  return lastSyncedAt ? dateTime.format(lastSyncedAt) : 'nog niet';
}

const count = new Intl.NumberFormat('nl-NL');

export function receivedMailText(receivedMailCount: number): string {
  if (receivedMailCount === 1) return '1 mail binnengekomen';
  return `${count.format(receivedMailCount)} mails binnengekomen`;
}

/**
 * Shown before disconnecting. Google's grant is withdrawn on disconnecting;
 * Microsoft has no way for an app to withdraw its own consent for one user
 * (docs/integrations.md §5.3), so the user is shown where to do it.
 */
export function disconnectExplanation(provider: ConnectionSummary['provider']): string {
  const common =
    'EffectiefAI kan deze mailbox dan niet meer lezen, en de mail die via deze koppeling binnenkwam wordt verwijderd.';
  if (provider === 'outlook') {
    return `${common} Wil je de toegang ook bij Microsoft weghalen? Ga naar myapps.microsoft.com (werkaccount) of account.live.com/consent/Manage (persoonlijk account).`;
  }
  if (provider === 'gmail') {
    return `${common} De toegang van EffectiefAI in je Google-account wordt ook ingetrokken.`;
  }
  return common;
}
