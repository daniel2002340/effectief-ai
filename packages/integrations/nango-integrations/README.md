# nango-integrations

De functions die Nango voor ons draait (beslissing #079, docs/integrations.md §7.5): per integratie `syncs/`, `actions/` en `on-events/`, plus `helpers/` voor gedeelde code. `index.ts` importeert alles wat Nango compileert en deployt.

| Integratie | Function | Wat |
|---|---|---|
| `gmail` | `syncs/inbox-messages` | Nieuwe mail in de inbox, elke 5 minuten (§3.1–§3.2) |
| `gmail`, `outlook` | `actions/account-info` | Welk account een connectie leest (§2.4) |
| `gmail`, `outlook` | `on-events/validate-connection` | Opnieuw koppelen alleen met hetzelfde account (§2.4) |

## Commando's

Draai ze in deze map, met Node 24.

```
pnpm compile    nango compile: typecheck, bouwen, en .nango/nango.json bijwerken
pnpm test       Vitest-tests van de functions (zonder Nango of Google)
```

Commit `.nango/nango.json` na elke wijziging aan een function: de app test zijn recordmodellen ertegen (`packages/shared/src/domain/inbox-message.test.ts`), en CI faalt als het bestand niet bij de code past.

Deployen naar Nango-staging gebeurt **alleen via CI** na een merge naar `main` (`.github/workflows/deploy-staging.yml`). Vanaf je laptop alleen na expliciet akkoord van Daniël (#073).

## Zelf een dry run draaien

Een dry run voert een function lokaal uit tegen een echte connectie op Nango-staging. Hij schrijft niets in Nango's cache en zet geen checkpoint; provider-calls gaan wel echt naar Google of Microsoft (alleen lezen).

**Eenmalig: een key.** Maak in het Nango-dashboard (environment `staging` → Environment Settings → API Keys → Custom) een key `dev-dryrun` met alleen deze scopes:

- `environment:connections:read`
- `environment:integrations:read`
- `environment:proxy`

Zet hem in `packages/integrations/nango-integrations/.env` (staat in `.gitignore`):

```
NANGO_SECRET_KEY_STAGING=<de key>
```

Gebruik nooit een key van `prod` en geen full-access-key. Trek de key in zodra je hem niet meer nodig hebt.

**Een connectie kiezen.** Alleen je eigen mailbox of een testaccount (staging bevat nooit klantdata). Het connectie-ID staat in het Nango-dashboard onder Connections, of vraag het op met de Management MCP (`connections_list`).

**Draaien:**

```
pnpm exec nango dryrun inbox-messages <connectie-id> -e staging --integration-id gmail
```

De eerste keer begint hij met de backfill (14 dagen). Om het incrementele deel te testen, geef je een checkpoint mee met een oudere `historyId` (bijvoorbeeld de `historyId` van een mail van een uur geleden):

```
pnpm exec nango dryrun inbox-messages <connectie-id> -e staging --integration-id gmail \
  --checkpoint '{"phase":"history","historyId":"<id>","pageToken":""}'
```

De uitvoer bevat **echte mail**. Kopieer hem niet naar issues, PR's of chats.

**Fixtures maken (`--save`).** Met `--save` schrijft de CLI alle API-antwoorden en records naar `gmail/tests/inbox-messages.test.json`. Dat bestand bevat echte mail en mag zo **nooit** in git:

1. Draai de dry run met `--save`.
2. Verplaats het bestand meteen buiten de repo, bijvoorbeeld naar `/tmp/inbox-messages.raw.json`.
3. Anonimiseer het met `node scripts/anonymize-gmail-mocks.ts /tmp/inbox-messages.raw.json tests/fixtures/<naam>.json`. Het script vervangt namen, adressen, onderwerpen, tekst, bestandsnamen, linkdoelen en afbeeldingen door neutrale waarden met dezelfde structuur, laat alleen de headers staan die de function leest, en laat de records weg (de tests berekenen ze uit de geanonimiseerde antwoorden).
4. Kijk het resultaat na (`git diff`) op resten van echte gegevens vóór je commit. gitleaks draait bij de commit, maar kent geen namen of adressen.
5. Verwijder het ruwe bestand.

Zie CLAUDE.md, "Externe accounts", voor de regels rond fixtures uit echte data.
