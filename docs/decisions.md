# Architectuurbeslissingen

Nieuwe entries onderaan. Oude entries niet inhoudelijk wijzigen; bij een achterhaalde beslissing een nieuwe entry toevoegen en de status van de oude aanpassen.

Status: `voorgesteld` · `geaccepteerd` · `vervangen door #NNN`

Format:

```
## #NNN Titel
- **Datum:** JJJJ-MM-DD
- **Status:** voorgesteld | geaccepteerd | vervangen door #NNN
- **Context:** waarom dit speelde
- **Beslissing:** wat er gekozen is
- **Alternatieven:** wat overwogen is en waarom niet
- **Gevolgen:** wat dit betekent voor verder werk
```

---

## #001 Nieuwe codebase voor 2.0
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** v1 bestond uit losse tools (chatbot, inbox-assistent, contentgenerator) die als kleine losse verbeteringen voelden. 2.0 is één dashboard dat veel tools koppelt.
- **Beslissing:** Opnieuw beginnen in een nieuwe repo. De v1-repo wordt gearchiveerd en dient alleen als referentie; losse onderdelen (encryptiemodule, billing, prompts) worden gericht gekopieerd wanneer nodig.
- **Alternatieven:** v1 ombouwen op een branch. Niet gekozen omdat oude patronen en losse tools dan blijven sturen.
- **Gevolgen:** Geen legacy-code in de repo; geleerde lessen (o.a. tenant-isolatie) staan als regels in CLAUDE.md.

## #002 TypeScript end-to-end in een pnpm/Turborepo-monorepo
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** Solo-ontwikkeling; Nango-integratiefuncties zijn TypeScript.
- **Beslissing:** Eén taal van integratie tot UI: Fastify (api), BullMQ (worker), React + Vite (web), gedeelde Zod-schema's.
- **Alternatieven:** Next.js full-stack (onnodige SSR voor een dashboard achter login, neiging tot Vercel-lock-in).
- **Gevolgen:** Types en validatie worden gedeeld via packages/shared.

## #003 Tenant-isolatie met Postgres Row Level Security
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** In v1 vond een audit IDOR-lekken tussen tenants.
- **Beslissing:** Elke tabel met klantdata heeft tenant_id en een RLS-policy; toegang alleen via withTenant().
- **Alternatieven:** Alleen applicatiechecks (één vergeten WHERE is een lek); database per tenant (te veel beheer).
- **Gevolgen:** Elke nieuwe tabel krijgt een isolatietest.

## #004 Alle externe schrijfacties via een actiepijplijn met akkoord
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** De AI leest onvertrouwde input (mail, berichten) en kan schrijven in boekhouding en betalingen; risico op prompt-injection.
- **Beslissing:** proposeAction → approve → execute, met idempotency_key en audit_log. Het model stelt alleen voor.
- **Alternatieven:** Automatisch uitvoeren bij hoge zekerheid. Uitgesteld tot er vertrouwen en data is.
- **Gevolgen:** Akkoordkaarten zijn het centrale UX-patroon.

## #005 Nango Cloud als integratielaag (start)
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** De gratis self-hosted editie van Nango dekt alleen auth en proxy; syncs, functies en webhooks vereisen Nango Cloud of Enterprise.
- **Beslissing:** Starten met Nango Cloud voor snelheid. Integratiecode staat in de eigen repo zodat overstappen mogelijk blijft.
- **Alternatieven:** Gratis self-hosted met eigen sync-logica (meer werk, tokens in eigen EU-omgeving).
- **Gevolgen:** Nango op de subverwerkerslijst; hostingregio en DPA controleren. Herzien na pilotgesprekken over EU-hosting.

## #006 Workflows eerst simpel, durable engine later
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Ketens (akkoord → factuur → betaling → review) kunnen dagen duren.
- **Beslissing:** In de MVP: status in Postgres + BullMQ delayed jobs.
- **Alternatieven:** DBOS of Temporal vanaf dag één (extra complexiteit voordat ketens bewezen zijn).
- **Gevolgen:** Overstap naar DBOS overwegen zodra er meerdere lange ketens zijn.

## #007 LLM: Claude via AWS Bedrock (EU) met Vercel AI SDK
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Klantdata moet zo veel mogelijk in de EU verwerkt worden; providerwissel moet mogelijk blijven.
- **Beslissing:** Claude via Bedrock in een EU-regio; Vercel AI SDK als abstractie; Langfuse voor tracing.
- **Alternatieven:** Directe Anthropic API; LangChain (zware abstractie).
- **Gevolgen:** Mistral blijft optie als EU-fallback.

## #008 MVP-keten: mail → kaart → Moneybird-offerte → Mollie-betaling
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Waarde zit in de keten, niet in losse koppelingen.
- **Beslissing:** MVP met vier integraties: Outlook, Gmail, Moneybird, Mollie. Exact Online, agenda en Google Maps in de tweede golf.
- **Alternatieven:** Breder starten met de volledige MVP-lijst uit het integratieoverzicht.
- **Gevolgen:** Pilot met 3–5 klanten die Outlook of Gmail plus Moneybird gebruiken.

## #009 Lessen uit v1 als regels in CLAUDE.md
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** Analyse van v1 (606 commits, 161 fixes) in LESSONS.md: tenant-lekken aan de randen, auth met uitzonderingen, secrets met fallbacks, migratie-drift, geen CI, werk verloren door parallelle agents, te veel planning en scope.
- **Beslissing:** De lessen zijn vertaald naar harde regels, conventies en werkwijze in CLAUDE.md. LESSONS.md zelf gaat niet mee naar de nieuwe repo (bevat v1-paden en -commits).
- **Gevolgen:** Afwijken van die regels vereist een nieuwe entry hier.

## #010 Typed API-contract met ts-rest
- **Datum:** 2026-10-03
- **Status:** vervangen door #014
- **Context:** In v1 kwamen veldnamen van API en UI niet overeen ("undefinedx"); dat bleek pas in productie.
- **Beslissing:** ts-rest-contract met Zod in packages/shared, gebruikt door Fastify en door TanStack Query in web.
- **Alternatieven:** tRPC (minder REST, lastiger voor webhooks en externe clients); OpenAPI genereren uit Zod (extra codegen-stap).
- **Gevolgen:** Een mismatch tussen api en web faalt bij typecheck.

## #011 Deny-by-default route-authenticatie
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** In v1 groeide een lijst van ~20 uitzonderingen op login, bij elke "fix 401" één meer.
- **Beslissing:** Elke route declareert zijn auth-type; de server weigert te starten als een route er geen heeft.
- **Alternatieven:** Globale auth met uitzonderingslijst (v1-aanpak).
- **Gevolgen:** Startup-smoketest in CI controleert dit.

## #012 Build: ESM, gebundeld met tsup, eigen Dockerfile
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** v1 draaide in productie met tsx, had CJS/ESM-problemen en twee React-versies in één workspace.
- **Beslissing:** Alleen ESM; api en worker gebundeld met tsup tot één artifact dat met node draait; eigen Dockerfile; `--frozen-lockfile` overal; één React- en TypeScript-versie.
- **Alternatieven:** tsx in productie; vertrouwen op build-caching van de host.
- **Gevolgen:** De marketingsite komt later in deze workspace met dezelfde versies, of in een eigen repo.

## #013 Webhooks via een inbox: eerst opslaan, dan verwerken
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** In v1 werd een mislukte Mollie-webhook met 200 beantwoord en nooit opnieuw verwerkt; idempotency was niet atomair.
- **Beslissing:** Handtekening checken op de ruwe body, webhook opslaan als uniek event, 200 teruggeven, verwerken in een job met retries; verwerking en effecten in één transactie.
- **Alternatieven:** Synchroon verwerken in de request.
- **Gevolgen:** Geldt voor Nango, Mollie en elke toekomstige webhookbron.

## #014 Typed API-contract met oRPC in plaats van ts-rest
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** ts-rest kreeg sinds juni 2025 geen release meer en ondersteunt volgens zijn peer-dependencies alleen Fastify 4, React ≤18 en Zod 3; wij gebruiken Fastify 5, React 19 en Zod 4.
- **Beslissing:** Contract-first met oRPC (`@orpc/contract` in packages/shared, OpenAPI-handler in api, client + TanStack Query in web). Elke procedure declareert `meta.auth`; de api controleert dat bij opstarten.
- **Alternatieven:** ts-rest met peer-overrides (niet onderhouden, risico op breuk); alleen `@ts-rest/core` met eigen Fastify-koppeling (meer lijmcode op een stilstaande kern).
- **Gevolgen:** Doel van #010 blijft: een mismatch tussen api en web faalt bij typecheck. Webhooks blijven gewone Fastify-routes.

## #015 TypeScript 6 in plaats van 7
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** TypeScript 7 (native compiler) is uit, maar tooling die de JS-API van TypeScript gebruikt en editorondersteuning lopen nog achter.
- **Beslissing:** TypeScript 6.0.3 via de pnpm-catalog, voor de hele workspace één versie.
- **Alternatieven:** 7.0.x nu al (sneller, kans op tooling- en editorproblemen).
- **Gevolgen:** Overstap naar 7 via Renovate zodra tsup, knip en de editor het ondersteunen.

## #016 Interne packages zonder eigen build
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** Een build-stap per package (`.d.ts`, dist) vertraagt typecheck en dev en kan uit sync raken.
- **Beslissing:** packages/* exporteren hun `.ts`-bron direct. tsup bundelt ze mee in api en worker; Vite in web. Versies van gedeelde dependencies staan in de pnpm-catalog.
- **Alternatieven:** Elk package apart bouwen met project references.
- **Gevolgen:** Packages zijn alleen bruikbaar binnen deze workspace; publiceren vereist later een build.

## #017 Database-driver: node-postgres met Drizzle 0.45
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** withTenant() zet de tenant per transactie met `set_config(..., true)`; dat vraagt een pool met echte transacties.
- **Beslissing:** `pg` (node-postgres) als driver, drizzle-orm 0.45 (stabiel). Migraties via drizzle-kit; pgvector staat in migratie 0000.
- **Alternatieven:** postgres.js (ook goed, minder gangbaar met drizzle-kit); Drizzle 1.0 (nog RC).
- **Gevolgen:** Overstap naar Drizzle 1.0 zodra die stabiel is.

## #018 Aparte databaserol zonder BYPASSRLS (uitgesteld)
- **Datum:** 2026-10-03
- **Status:** vervangen door #026
- **Context:** RLS geldt niet voor superusers en tabeleigenaren. De lokale en CI-database draaien nu als superuser, dus RLS-policies zouden daar niets afdwingen.
- **Beslissing:** Bij de eerste tabel met klantdata: een rol zonder BYPASSRLS en zonder eigendom van de tabellen (bijv. via `SET LOCAL ROLE` in withTenant() of een aparte login), plus `FORCE ROW LEVEL SECURITY`. Nu nog niet, want er zijn geen tabellen.
- **Gevolgen:** De isolatietests van de eerste tabel moeten draaien onder die rol, anders bewijzen ze niets.

## #019 api en worker als één gebundeld artifact zonder node_modules
- **Datum:** 2026-10-03
- **Status:** vervangen door #028
- **Context:** Workspace-packages exporteren TypeScript-bron (#016) en hun dependencies (bijv. `pg`) zijn geen directe dependencies van de app; extern laten gaf runtime-fouten.
- **Beslissing:** tsup bundelt alles (`noExternal: /.*/`) tot één ESM-bestand, met een `createRequire`-banner voor CommonJS-dependencies. Het image bevat alleen Node en `dist/`. In dev draait Node de TypeScript-bron direct (type stripping), zonder tsx.
- **Alternatieven:** Third-party extern houden en `pnpm deploy --prod` in het image (groter image, dependencies dubbel declareren).
- **Gevolgen:** Een dependency met native addons of losse bestanden (bijv. pino-transports) moet expliciet extern worden gezet en in het image komen. Zie ook `erasableSyntaxOnly` in de tsconfig.

## #020 Webhooks alleen via registerWebhookRoutes()
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** Handtekeningen moeten op de exacte ontvangen bytes worden gecontroleerd (#013).
- **Beslissing:** Eén eigen scope onder `/webhooks` waarin elke body een ruwe `Buffer` blijft; geen extra dependency. `auth: 'hmac'` vereist `config.hmac.verify` en is alleen binnen deze scope toegestaan; anders start de server niet. Handlers parsen de body zelf met Zod na de check.
- **Alternatieven:** `fastify-raw-body` (extra dependency, bewaart body dubbel).
- **Gevolgen:** Elke nieuwe webhookbron (Nango, Mollie) is een route in deze scope met een eigen verify-functie.

## #021 Web en api op dezelfde origin, geen CORS
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** De CORS-plugin registreert een eigen `OPTIONS *`-route zonder auth-type; bovendien maakt cross-origin sessiecookies lastiger.
- **Beslissing:** Web roept de api relatief aan onder `/api` (`VITE_API_BASE_PATH`). In dev proxyt Vite naar de api; in productie routeert één reverse proxy `/api` en `/webhooks` naar de api en de rest naar web.
- **Alternatieven:** Aparte api-domeinnaam met `@fastify/cors`.
- **Gevolgen:** De hostingkeuze moet path-based routing ondersteunen. Sessiecookies kunnen `SameSite=Strict` zijn.

## #022 Route-auth: type `contract` voor oRPC en sessies voorlopig dicht
- **Datum:** 2026-10-03
- **Status:** vervangen door #029
- **Context:** Alle oRPC-procedures lopen via één Fastify-route; auth moet per procedure gelden.
- **Beslissing:** Die ene route heeft `auth: 'contract'`; elke procedure declareert `meta.auth` (`session` of `public`), gecontroleerd bij opstarten en afgedwongen in middleware. `session` weigert alles (401) totdat er een sessiesysteem is.
- **Gevolgen:** Het sessiesysteem vult de bestaande `session`-checks in; er komt geen nieuwe uitzonderingsroute.

## #023 Rate limiting in Valkey
- **Datum:** 2026-10-03
- **Status:** vervangen door #027
- **Context:** Meerdere api-instanties moeten dezelfde tellers delen.
- **Beslissing:** `@fastify/rate-limit` met Valkey als store, globaal 300 verzoeken per minuut per IP, fail-closed als Valkey weg is.
- **Gevolgen:** Achter een proxy moet `trustProxy` goed staan, anders delen alle gebruikers één IP. Strengere limieten per route (login, webhooks) later.

## #024 shadcn/ui op Radix, met het `cn`-package van shadcn
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** shadcn/ui biedt nu Radix, Base UI en React Aria als basis, en levert `cn` als eigen package (vervangt clsx + tailwind-merge).
- **Beslissing:** Radix als basis (stijl new-york, kleur neutral), componenten in `apps/web/src/components/ui`, `cn` via `@/lib/utils`. Gedeelde paginaonderdelen zoals `PageHeader` in `apps/web/src/components`.
- **Alternatieven:** Base UI (nieuwer, minder ervaring mee).
- **Gevolgen:** Nieuwe componenten via `pnpm dlx shadcn add <naam>` in apps/web; pin daarna de versies.

## #025 CI en dependency-updates
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** v1 had geen CI; supply-chain-aanvallen via verse releases komen vaker voor.
- **Beslissing:** Eén GitHub Actions-workflow met Postgres en Valkey als services: typecheck, Biome, knip, migraties + drift, tests, build, startup-smoketest, Playwright. gitleaks als binary met checksum (geen gitleaks-action, die vraagt een licentie voor organisaties). Renovate pint alles, wacht 3 dagen na een release, groepeert per ecosysteem en blijft op Node 24 en TypeScript 6.
- **Alternatieven:** Dependabot (minder groeperings- en wachtopties).
- **Gevolgen:** Renovate moet als GitHub-app op de repo worden geïnstalleerd. Docker-images worden in CI nog niet gebouwd.

## #026 Aparte databaserol zonder BYPASSRLS, al in sessie 1
- **Datum:** 2026-10-03
- **Status:** vervangen door #031
- **Context:** #018 stelde dit uit tot de eerste tabel. Zolang app en tests als superuser of tabeleigenaar draaien, dwingt RLS niets af en bewijzen isolatietests niets.
- **Beslissing:** Migraties draaien als eigenaar; app en tests als een aparte rol zonder BYPASSRLS en zonder eigenaarschap. Elke tenant-tabel heeft `FORCE ROW LEVEL SECURITY`. Een test faalt als de app-rol eigenaar is of BYPASSRLS heeft. Sessie 1 (de eerste tabel) is pas klaar als dit allemaal staat.
- **Alternatieven:** Uitstellen tot later (#018); te riskant, want dan bestaan er al tabellen en tests die onder de verkeerde rol groen zijn.
- **Gevolgen:** Twee database-URL's (eigenaar voor migraties, app-rol voor runtime en tests), ook in CI en docker-compose.

## #027 Rate limiting: proxy-instelling en uitzonderingen
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** #023 liet `trustProxy` en uitzonderingen open; zonder `/health` buiten de limiet valt de healthcheck weg als Valkey stuk is.
- **Beslissing:** Globale limiet per IP in Valkey. `API_TRUST_PROXY` is verplicht en Zod-gevalideerd: `false`, een aantal hops, of een lijst proxy-IP's/CIDR's; `true` wordt geweigerd. `/health` (via `rateLimit: false` op de route) en webhookroutes (`auth: 'hmac'`) vallen buiten de limiet. Is Valkey onbereikbaar, dan blijft `/health` werken en worden gelimiteerde verzoeken geweigerd (500).
- **Alternatieven:** Uitzonderingen op pad (`allowList`); niet gekozen, de uitzondering hoort bij de routedeclaratie.
- **Gevolgen:** Bij hosting achter een proxy moet `API_TRUST_PROXY` precies de proxy beschrijven. Strengere limieten per route (login) later.

## #028 Alleen eigen code bundelen; npm-dependencies via pnpm deploy
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** #019 bundelde alles. pino-transports en mogelijk BullMQ laden bestanden of threads van schijf, wat in een bundel stuk kan gaan.
- **Beslissing:** tsup bundelt eigen code en workspace-packages (`noExternal: /^@effectief\//`); alle andere imports blijven extern. `scripts/deploy-app.sh` zet bundel en productie-`node_modules` samen met `pnpm deploy --prod` (vanuit de gedeelde lockfile, offline, `node-linker=hoisted`, `inject-workspace-packages` alleen voor die opdracht). Dockerfiles en CI gebruiken hetzelfde script. De CI-smoketest start de gebouwde api en laat de gebouwde worker één job verwerken.
- **Alternatieven:** `pnpm deploy --legacy` (leest de lockfile niet, dus geen vaste versies); `inject-workspace-packages` voor de hele workspace (Node draait dan geen TS-bron meer in dev).
- **Gevolgen:** De artifacts draaien niet direct vanuit `apps/*/dist` in de workspace, alleen na `deploy-app.sh`. Images zijn groter (api ±200 MB).

## #029 oRPC-procedures vereisen standaard een sessie
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** #022 liet elke procedure `meta.auth` declareren in het contract, met een check bij opstarten. CLAUDE.md legt nu vast dat de sessie de standaard is.
- **Beslissing:** `createBuilders()` in apps/api levert `procedure` (sessie-middleware, standaard) en `publicProcedure` (expliciet benoemde uitzondering). Het contract in packages/shared beschrijft alleen vormen, geen auth. De Fastify-route die oRPC serveert houdt `auth: 'contract'`.
- **Alternatieven:** `meta.auth` per procedure (#022): een vergeten declaratie werd pas bij opstarten gevangen, en auth stond in het gedeelde contract.
- **Gevolgen:** Een nieuwe procedure is zonder extra werk afgeschermd. Het sessiesysteem vult de middleware in `apps/api/src/orpc/builders.ts` in.

## #030 Authenticatie met Better Auth (organisatie = tenant)
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** Sessie-middleware (#029) en tenants hebben een auth-systeem nodig. Eigen auth bouwen is foutgevoelig; een externe dienst (Clerk, Auth0) zet persoonsgegevens buiten de EU en buiten onze database.
- **Beslissing:** `better-auth` 1.7.7 in apps/api, met de Drizzle-adapter (geverifieerd met drizzle-orm 0.45.3, drizzle-kit 0.31.11, Zod 4.6.5, Fastify 5 en Node 24). Organization-plugin: tenant = organisatie, rollen owner/member, `tenantId` = `session.activeOrganizationId`. ID's als uuid. E-mail + wachtwoord nu; passkeys (`@better-auth/passkey`) en 2FA (`twoFactor`) later als plugin. Sessies in een httpOnly-cookie, `SameSite=Strict`, op dezelfde origin onder `/api/auth` (#021). Rate limiting en logging via onze eigen Fastify-plugins; de ingebouwde rate limiter en telemetrie van Better Auth staan uit. Tabellen via `auth generate` naar packages/db en daarna via gewone Drizzle-migraties.
- **Alternatieven:** Lucia (sinds 2025 alleen nog een leerbron); Auth.js (minder geschikt buiten Next.js, geen organisaties); Clerk/WorkOS (data buiten eigen database en EU).
- **Gevolgen:** Auth-tabellen zijn geen tenant-tabellen (een gebruiker kan lid zijn van meerdere tenants) en vragen een eigen toegangsregel (#031). Mails (verificatie, wachtwoord vergeten, uitnodigingen) wachten op een mailprovider.

## #031 Drie databaserollen: eigenaar, app en auth
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** #026 koos twee rollen. Better Auth (#030) moet over tenants heen lezen (inloggen, lidmaatschappen), dus RLS per tenant past niet op de auth-tabellen.
- **Beslissing:** Migraties als eigenaar (`DATABASE_MIGRATION_URL`). Groepsrollen `app_runtime` en `auth_runtime` (NOLOGIN, migratie 0001); login-rollen met wachtwoord worden er lid van buiten migraties (`pnpm db:roles` voor dev en CI). Better Auth gebruikt `DATABASE_AUTH_URL` en mag alleen de auth-tabellen. De app (`DATABASE_URL`) heeft geen rechten op `user`, `session`, `account`, `verification` en `invitation`, en leest `organization` en `member` alleen voor de eigen tenant via RLS. Elke tenant-tabel: `tenantIsolation()`-policy, `FORCE ROW LEVEL SECURITY` en expliciete grants in de migratie, geen default privileges.
- **Alternatieven:** Twee rollen met volledige app-rechten op de auth-tabellen (alleen met conventie af te dwingen).
- **Gevolgen:** Drie database-URL's. Tests draaien als app- en auth-rol en falen als een runtime-rol superuser, BYPASSRLS of (via lidmaatschap) eigenaar is, of als een tabel met `tenant_id` geen geforceerde RLS heeft. In productie moeten de login-rollen bij de hosting worden aangemaakt.

## #032 CSRF: wijzigingen alleen als JSON
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** #021 maakt `SameSite=Strict`-cookies mogelijk. Een tweede laag is nodig voor browsers of situaties waarin dat niet volstaat, ook voor oRPC, dat zelf geen origin-check heeft.
- **Beslissing:** De plugin `jsonOnly` weigert elk verzoek behalve GET/HEAD/OPTIONS zonder `Content-Type: application/json` met 415, voor alle routes behalve `auth: 'hmac'` (webhooks). Browsers kunnen cross-site geen JSON sturen zonder CORS-preflight, en die staan we niet toe. De origin-check van Better Auth staat expliciet aan, ook in tests (Better Auth zet hem anders uit bij `NODE_ENV=test`).
- **Alternatieven:** CSRF-tokens (extra state en client-code); alleen vertrouwen op SameSite.
- **Gevolgen:** Schrijvende procedures zijn altijd POST met een JSON-body, ook zonder input (`{}`). GET-procedures mogen niets wijzigen.

## #033 UUIDv7 als primaire sleutel en samengestelde tenant-FK's
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Het datamodel (docs/data-model.md) krijgt ±25 tenant-tabellen met veel onderlinge verwijzingen.
- **Beslissing:** Nieuwe tabellen krijgen `id uuid default gen_uuid_v7()` (eigen functie in een migratie; PG17 heeft geen `uuidv7()`). Elke tenant-tabel heeft `unique (tenant_id, id)`; verwijzingen zijn `(tenant_id, x_id)`, met `on delete set null (x_id)` waar nodig. Gebruikersverwijzingen gaan naar `member(organization_id, user_id)`. Altijd `timestamptz`; `occurred_at` los van `created_at`.
- **Alternatieven:** UUIDv4 (willekeurige index-inserts); ID's in de app genereren (ruwe SQL krijgt dan geen ID); enkelvoudige FK's (een bug kan rijen van verschillende tenants koppelen).
- **Gevolgen:** Handgeschreven SQL in migraties voor `set null (kolom)`. Bij PG18 de functie vervangen door de ingebouwde.

## #034 Koppeltabellen in plaats van uuid[]
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Events, kaarten, taken en documenten verwijzen naar meerdere entiteiten.
- **Beslissing:** Koppeltabellen met `tenant_id` (`event_entities`, `card_events`, `card_entities`, `task_entities`, `document_entities`), samengestelde FK's en `on delete cascade`.
- **Alternatieven:** `uuid[]`-kolommen: geen FK's, forgetEntity moet elke array bijwerken, geen rol per koppeling.
- **Gevolgen:** Meer rijen en joins; forgetEntity is grotendeels cascade.

## #035 Statusvelden als text met check-constraint
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Statussen en soorten zullen veranderen; Postgres-enums zijn lastig te wijzigen.
- **Beslissing:** `text` + `check (… in (…))`. De waarden staan één keer als `as const`-array in packages/shared en voeden Zod, TypeScript en de check. Statusovergangen in code; voor `actions` ook een trigger.
- **Alternatieven:** Postgres-enums (waarden niet te verwijderen of hernoemen, beperkt in transacties).
- **Gevolgen:** Een nieuwe status is een migratie die de constraint vervangt.

## #036 Embeddings in satelliettabellen per soort
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** HNSW vraagt een vaste dimensie; modelwissels moeten zonder downtime kunnen; forget moet embeddings meenemen.
- **Beslissing:** `fact_embeddings`, `playbook_embeddings`, `chunk_embeddings` met PK `(eigenaar_id, model)`, kolommen `model` en `dimensions`, FK met cascade. Per actief model een partiële HNSW-expressie-index in een migratie. Zoeken met `hnsw.iterative_scan` en een expliciet `tenant_id`-filter.
- **Alternatieven:** Vaste kolom per tabel (geen twee modellen naast elkaar); één generieke tabel (geen nette FK, grote gemengde index).
- **Gevolgen:** Herembedden = backfill-job, evalset, omschakelen in models.ts, oude rijen verwijderen.

## #037 Bron-inhoud apart met bewaartermijn
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Dataminimalisatie: mailtekst is alleen tijdelijk nodig; samenvatting en verwijzing blijven nuttig.
- **Beslissing:** `events` is de append-only tijdlijn (samenvatting, metadata). Volledige inhoud staat in `event_contents` met `retain_until`. Een dagelijkse job (per tenant via `list_tenant_ids()`) verwijdert verlopen inhoud, oude action-inputs, verwerkte webhooks en oude gesloten kaarten, en logt aantallen in `audit_log`.
- **Alternatieven:** Kolom op `events` die op `null` wordt gezet (UPDATE op een append-only tabel, grote rijen in de tijdlijn).
- **Gevolgen:** Nieuwe instelling `tenant_settings.content_retention_days`.

## #038 Webhook-inbox apart van events; tenant via SECURITY DEFINER-lookup
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** #013 en CLAUDE.md slaan een webhook op "als event". Een Nango-webhook ("sync klaar") is transport, geen gebeurtenis voor de tijdlijn. De ontvanger kent alleen een connectie-ID, en de app-rol mag niet over tenants heen zoeken.
- **Beslissing:** Webhooks gaan eerst naar `webhook_deliveries` (uniek per bron en delivery-ID, retries, 30 dagen bewaard); de job maakt daarna `events`. De tenant komt uit `resolve_connection(provider, connection_id)`, een smalle `SECURITY DEFINER`-functie die alleen ID's teruggeeft. Ook `list_tenant_ids()` voor de retentie-job.
- **Alternatieven:** Webhooks als event opslaan (vervuilt de tijdlijn en de bewaartermijnen); een tabel zonder RLS voor lookups.
- **Gevolgen:** Voorstel om de webhookregel in CLAUDE.md aan te passen ("opslaan als `webhook_delivery`").

## #039 Herleidbaarheid met getypte bronverwijzingen en onveranderlijke kennis
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Alles wat de AI weet moet een bron hebben, en kennis mag niet worden overschreven.
- **Beslissing:** `source_type` plus getypte FK's (`source_event_id`, `source_chunk_id`, `source_user_id`, `source_action_id`) met `set null`, en `ai_model`/`ai_trace_id`. `facts`, `relations` en `playbooks` krijgen alleen UPDATE-rechten op status- en geldigheidskolommen; corrigeren is een nieuwe rij. `playbooks.examples` wordt de tabel `playbook_examples`; tellers vervallen (af te leiden uit `actions.playbook_id`).
- **Alternatieven:** Eén `source_ref text` (geen FK, forget moet tekst doorzoeken); onveranderlijkheid alleen in code.
- **Gevolgen:** Kolomrechten per tabel in de migratie, en een test die ze vergelijkt met docs/data-model.md.

## #040 Persoonsgegevens: register per kolom en forget via cascade
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Recht op vergetelheid moet door alle tabellen werken; logs mogen geen persoonsgegevens bevatten.
- **Beslissing:** Register `packages/db/src/pii.ts` met per kolom klasse P/I/V/—; een test eist een klasse voor elke kolom van elke tenant-tabel. Persoonsgegevens worden hard verwijderd, nooit zacht. forgetEntity verwijdert gekoppelde kaarten, taken en events, en daarna de entiteit; de rest volgt via cascade. `audit_log` bevat alleen ID's, codes en aantallen (Zod staat geen vrije tekst toe), heeft geen FK's en blijft staan.
- **Alternatieven:** `deleted_at` overal (houdt persoonsgegevens vast); markering via `COMMENT ON COLUMN` (lastiger te gebruiken voor log-redaction).
- **Gevolgen:** Langfuse-traces krijgen event-ID's als metadata zodat ze mee verwijderd kunnen worden.

## #041 docs/data-model.md beschrijft het schema
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** Het datamodel is groot en hangt samen; de Drizzle-code alleen laat de motivatie, rechten en retentie niet zien.
- **Beslissing:** docs/data-model.md is de beschrijving van het schema. Elke schemawijziging werkt het bij in dezelfde PR.
- **Gevolgen:** Opgenomen in CLAUDE.md (Structuur en Conventies).

## #042 Verwijzende kolommen pas met hun doeltabel
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** Het kerngeheugen (entities, events, relations, tasks) is gebouwd vóór `connections`, `actions`, `cards` en `document_chunks`, waar het ontwerp naar verwijst.
- **Beslissing:** Kolommen naar een tabel die nog niet bestaat (`events.connection_id`, `caused_by_action_id`, `source_action_id`, `source_chunk_id`, `tasks.origin_card_id`) en `entity_external_refs` komen pas in de PR die de doeltabel aanmaakt, met hun samengestelde FK. Het Zod-bronschema accepteert tot dan alleen `event`, `user` en `system`.
- **Alternatieven:** Nu een kolom zonder FK (kan tijdelijk naar een rij van een andere tenant wijzen).
- **Gevolgen:** Elke volgende PR voegt zijn kolommen met `ALTER TABLE` toe; docs/data-model.md §3.10 houdt bij wat er nog mist.

## #043 tenant_id als default uit de transactie
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Repository-functies moesten anders een `tenantId` meekrijgen naast de transactie van `withTenant()`, met kans op een mismatch.
- **Beslissing:** Op nieuwe tenant-tabellen heeft `tenant_id` als default `nullif(current_setting('app.tenant_id', true), '')::uuid`. Repository-functies krijgen alleen een `TenantTransaction` en geven geen `tenant_id` mee. Buiten `withTenant()` is de default `null` en faalt de insert; RLS (`with check`) blijft de echte grens.
- **Alternatieven:** `tenantId` als parameter naast de transactie; een eigen transactietype dat de tenant draagt.
- **Gevolgen:** Helper `tenantId()` in `packages/db/src/schema/columns.ts` voor elke nieuwe tenant-tabel. `tenant_settings` (PK `tenant_id`) houdt een expliciete waarde.

## #044 Statusovergangen: één functie per tabel plus een trigger met dezelfde paren
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Statussen van `connections`, `cards` en `actions` sturen wat er naar buiten gaat; gelijktijdige wijzigingen (twee tabbladen, job en gebruiker) mogen elkaar niet overschrijven.
- **Beslissing:** Overgangslijsten in `packages/shared/src/domain/transitions.ts`. Per tabel één functie (`transitionConnection/Card/Action`) die de lijst controleert, `UPDATE … WHERE status = <verwacht>` doet en in dezelfde transactie één audit-regel schrijft; geen rij → `TransitionError` (`status_changed` of `not_found`). In de database een generieke trigger met dezelfde `from:to`-paren als argumenten (een test vergelijkt ze), en een trigger die de beginstatus bij INSERT afdwingt. Toegevoegd: `expired → active` (opnieuw autoriseren via Nango) en `expired → revoked`; kaarten `open ↔ snoozed`, beide → `done | dismissed | expired`.
- **Alternatieven:** Alleen in code (ruwe SQL kan dan elke overgang); alleen een trigger voor `actions`, zoals in het ontwerp (connections en cards zonder vangnet); `SELECT … FOR UPDATE` (twee queries, zelfde resultaat).
- **Gevolgen:** Een nieuwe status of overgang is een wijziging in de lijst én een migratie die de trigger vervangt. De API vertaalt `TransitionError` naar `CONFLICT`/`NOT_FOUND`.

## #045 audit_log append-only, ook voor de eigenaar
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** `audit_log` moet elke verwijdering overleven en niet te wijzigen zijn, maar mag het opzeggen van een tenant (cascade) niet blokkeren.
- **Beslissing:** De app-rol heeft alleen SELECT en INSERT, met policies `for select` en `for insert`. De trigger `audit_log_append_only` weigert UPDATE, DELETE en TRUNCATE voor elke rol en laat alleen een DELETE toe met `pg_trigger_depth() > 1`, dus vanuit de FK-cascade. Schrijven via `writeAudit()` met Zod-metadata per actie, zonder vrije tekst.
- **Alternatieven:** Alleen grants (de eigenaar kan dan wijzigen); geen cascade en audit van opgezegde tenants bewaren (open vraag 6 in data-model.md).
- **Gevolgen:** Een eigen trigger die uit `audit_log` verwijdert zou ook door de uitzondering vallen; zulke triggers zijn er niet en horen er niet te komen.

## #046 actions: akkoord op approved_at, onveranderlijk provider-object, alleen een concept invoegen
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Het ontwerp zette de akkoordcheck op `approved_by_user_id`, maar die kolom wordt `null` als het lid verdwijnt (`set null`); zo'n check blokkeert dan het verwijderen van het lid (zelfde probleem als `facts`, zie todo). Retentie moet `proposed_input` kunnen legen, maar die kolom had geen UPDATE-recht.
- **Beslissing:** Check `status in ('concept','rejected') or approved_at is not null`; dat het een gebruiker was dwingt `transitionAction()` af en staat in `audit_log`. `proposed_input` krijgt UPDATE-recht, maar `actions_guard` staat alleen legen samen met `input_purged_at` toe. `provider_object_id` is onveranderlijk zodra hij gezet is. Een nieuwe actie is altijd een onbevestigd concept met `input = proposed_input`. `idempotency_key = <card_id>:<type>:<ordinal>`, het volgnummer komt van de aanroeper. `proposeAction()` eist een actieve connectie van een passende provider.
- **Alternatieven:** `on delete restrict` op `approved_by_user_id` (een lid kan dan nooit weg); volgnummer tellen in de database (een herhaalde job maakt dan een tweede actie).
- **Gevolgen:** docs/data-model.md (`actions`, §5) aangepast.

## #047 Embeddings: Cohere Embed 5 via de Cohere API, 1024 dimensies
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** Open vraag 8 in docs/data-model.md. Embed 5 (`embed-v5.0-pro`/`-fast`) staat niet op Bedrock, alleen bij de Cohere API, Azure Foundry, SageMaker en Model Vault. HNSW in pgvector kan `vector` tot 2000 dimensies; de default van Embed 5 is 2048.
- **Beslissing:** Cohere Embed 5 via de Cohere API (`/v2/embed`), Matryoshka-uitvoer van 1024 dimensies, `vector` (float). Documenten met Pro (`search_document`), queries met Fast (`search_query`): ze delen één vectorruimte. Per rij: `model` (ruimte, `cohere-embed-v5`), `model_version` (providermodel) en `dimensions`. Wijkt voor embeddings af van #007 (Bedrock).
- **Alternatieven:** Titan v2 of Cohere Embed v4 via Bedrock EU (blijft in AWS, ouder model); 2048 als `halfvec`; SageMaker of Azure in een EU-regio (eigen endpoint of extra cloud).
- **Gevolgen:** Cohere komt op de subverwerkerslijst; EU-verwerking en DPA nog na te gaan. Een nieuw model of nieuwe dimensie is een migratie (check + HNSW-index) plus herembedden (§3.5).

## #048 Statusovergangen en vervangen van kennis in de database afgedwongen
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Feiten en playbooks mogen nooit worden overschreven, en alleen een gebruiker bevestigt (data-model §2).
- **Beslissing:** Zelfde aanpak als #044: `factTransitions` (`proposed → confirmed | rejected`) en `playbookTransitions` (plus `confirmed → retired`) in packages/shared, met dezelfde paren in een trigger en `proposed` als beginstatus. Vervangen van een feit (`replaceFact`, of `confirmFact` bij hetzelfde `attribute`) sluit het oude af met `valid_to` en `superseded_by_id`; trigger `facts_end_once` maakt die eenmalig. Checks op `confirmed_at`, niet op `confirmed_by_user_id`.
- **Alternatieven:** Alleen kolomrechten (een UPDATE van `status` of `valid_to` kan dan alles); een check op `confirmed_by_user_id` (blokkeert het verwijderen van een lid).
- **Gevolgen:** Nieuwe auditacties `fact.*` en `playbook.*`. Herstellen van een onterecht afgesloten feit is een nieuw feit.

## #049 Fase-3-tabellen nu, zonder logica
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** Open vraag 1 stelde fase 1 en 2 voor; de opdracht voor PR 4 vroeg ook `documents`, `document_chunks` en `insights`.
- **Beslissing:** Ook de kennistabellen van fase 3 (`documents`, `document_chunks`, `chunk_embeddings`, `document_entities`, `insights`) bestaan nu, met schema, RLS, grants, tests en repository-functies. Extractie, chunking, embedden, object storage en RAG volgen in latere sessies.
- **Gevolgen:** `source_chunk_id` en `actions.playbook_id` bestaan nu (#042 afgerond). `documents.storage_key` blijft leeg tot er object storage is.

## #050 Uitvoeren van acties: status `executing`, foutcodes, definitieve types
- **Datum:** 2026-10-04
- **Status:** geaccepteerd
- **Context:** Een dubbele approve of execute mag maar één effect bij de provider hebben, ook bij gelijktijdige jobs of een crash tussen de providerreactie en de commit. Een mislukte uitvoering mag niet stil verdwijnen. Een verstuurde mail is niet bij te werken.
- **Beslissing:** Nieuwe status `executing`: een job claimt `approved → executing` atomair met `execution_job_id`; alleen die job (of zijn retry) roept de adapter aan en rondt af. Adapters zijn idempotent op de key (opnieuw aanmaken geeft het eerste object terug). Fouten als gesloten lijst `actionErrorCodes` in `last_error_code`, met Nederlandse tekst in de UI, nooit de providermelding. `actionRegistry` per type met `afterExecute: 'update' | 'final'`; `email.reply` en `moneybird.invoice_reminder` zijn definitief, en trigger `actions_final_guard` weigert daar `executed → concept`. oRPC `actions.approve` en `actions.reject` horen bij deze PR.
- **Alternatieven:** Een rij-lock tijdens de provider-aanroep (bezette verbinding, na een crash niets te zien); alleen idempotency bij de provider (Moneybird en Gmail kennen geen idempotency-key); vrije tekst voor fouten (persoonsgegevens); `email.reply` als concept in de mailbox.
- **Gevolgen:** Uitbreiding van #044 en #046: overgangen `approved → executing → executed | failed`, `attempts` telt claims. Elke echte adapter moet uitleggen hoe hij dubbel aanmaken met dezelfde key voorkomt.

## #051 Adapter-interface en afhandeling van mislukte acties
- **Datum:** 2026-10-04
- **Status:** voorgesteld
- **Context:** PR 5 had een gedeelde adapter-interface, een fake provider en een kaart bij een mislukte actie nodig.
- **Beslissing:** `ActionAdapter.execute({ type, input, connection, idempotencyKey, providerObjectId })` in `packages/integrations/src/adapter.ts`; met `providerObjectId` werkt hij bij, anders maakt hij aan. `AdapterError` heeft `code` en `retryable`. Tijdelijke fouten worden door BullMQ herhaald; bij de laatste poging of bij een definitieve fout volgt `failed` met de kaartsoort `action_failed` (FK `cards.action_id`, dedupe per actie). Bij `auth_expired` wordt de connectie `expired` met een kaart `connection_problem`. Nieuw: `failed → concept` (bewerken na een fout). Testhulpen via de subpaden `@effectief/integrations/testing` en `@effectief/db/testing`.
- **Alternatieven:** De bestaande kaart van de actie heropenen (die kan al gesloten zijn, en een fout valt dan niet op); actie-ID in de payload (geen FK, blijft hangen na forget).
- **Gevolgen:** De worker draait zonder echte adapters, dus een goedgekeurde actie faalt voorlopig als `unsupported`. Er is nog geen sweeper voor acties die blijven hangen in `approved` of `executing` (docs/todo.md).

## #052 Datalevenscyclus: retentie, vergeten en ontkoppelen
- **Datum:** 2026-10-04
- **Status:** voorgesteld
- **Context:** PR 6 bouwt §6.3 en de retentie uit docs/data-model.md. Open vraag 3 (termijnen) en 5 (vrije tekst) zijn nog niet beantwoord.
- **Beslissing:** Functies in `packages/db/src/lifecycle/` met jobs in de worker. Retentie: queue `retention` met een dagelijkse `sweep` (03:00 Amsterdam), de enige job zonder tenant; hij zet per tenant een job via `list_tenant_ids()` (SECURITY DEFINER, alleen ID's). Termijnen voorlopig 90 dagen (per tenant) / 180 dagen / 12 maanden, als constanten. forgetEntity verwijdert ook samengevoegde dubbelen (`merged_into_id`). `purgeConnection` verwijdert naast events, refs en documenten ook de kaarten (met acties) van de connectie, en entiteiten die alleen via haar bestonden. Audit alleen met aantallen.
- **Alternatieven:** sweep die zelf alle tenants verwerkt (één lange job, geen isolatie per tenant); kaarten laten staan bij ontkoppelen (titels met persoonsgegevens, concepten op een dode connectie); restcontrole in vrije tekst nu al (vraagt een kaartsoort en een antwoord op open vraag 5).
- **Gevolgen:** CLAUDE.md "queue-jobs bevatten de tenant" krijgt een uitzondering voor fan-out-jobs die alleen tenant-ID's lezen (voorstel). Procedures om forget en ontkoppelen te starten, de restcontrole en het intrekken bij Nango staan in docs/todo.md.

## #053 Leesprocedures: samenvattingen, geen bron-inhoud; actie-input wel
- **Datum:** 2026-10-04
- **Status:** geaccepteerd
- **Context:** `cards.list`, `cards.get` en `entities.get` zijn de eerste procedures die klantdata lezen.
- **Beslissing:** De API geeft van events alleen type, bron, tijdstip en samenvatting, nooit `event_contents`. `cards.get` geeft de `input` van de acties mee, omdat de gebruiker moet zien wat hij goedkeurt. Een object van een andere tenant is `NOT_FOUND` (RLS), nooit `FORBIDDEN`. Tijdlijn per pagina met `before` (op `occurred_at`).
- **Alternatieven:** input alleen via een aparte procedure (extra round-trip voor elke kaart); bron-inhoud meesturen (persoonsgegevens in elke response, ook na het verlopen van de termijn niet beheersbaar in caches).
- **Gevolgen:** "Toon originele mail" wordt later een aparte procedure die de bron bij de provider ophaalt.

## #054 Railway als hosting voor staging
- **Datum:** 2026-10-04
- **Status:** geaccepteerd
- **Context:** Er is een staging-omgeving nodig met routering op pad (#021) en een privénetwerk; vanaf sessie 4 komt er echte mail binnen.
- **Beslissing:** Railway, regio EU West (Amsterdam), project `effectiefai`, environment `staging`. Productie wordt later een eigen environment. Opzet in docs/deployment.md.
- **Alternatieven:** Niet uitgewerkt in deze sessie; Railway is een Amerikaans bedrijf, dus data in Amsterdam maar onder Amerikaanse jurisdictie.
- **Gevolgen:** Heroverwegen voor productie na de pilotgesprekken over EU-jurisdictie. Geen Railway-specifieke code in de apps: Railway zit alleen in `.railway/`, de deploy-workflow, `scripts/deploy/` en Dockerfiles, zodat overstappen naar een andere host een dag werk is. Railway komt op de subverwerkerslijst.

## #055 Sentry in de EU-regio voor foutmonitoring
- **Datum:** 2026-10-04
- **Status:** geaccepteerd
- **Context:** Fouten in api, worker en web moeten zichtbaar worden zonder persoonsgegevens buiten de EU te zetten.
- **Beslissing:** Sentry-organisatie in de EU-regio (Frankfurt, `de.sentry.io`), projecten voor api, worker en web. Releases = git-SHA; source maps in CI geüpload en niet publiek. `sendDefaultPii` uit, scrubben in `beforeSend`, geen request-bodies (docs/deployment.md §6).
- **Alternatieven:** Alleen pino-logs (geen groepering, alerts of releases).
- **Gevolgen:** De regio is onomkeerbaar. Accounts en instellingen van Sentry staan altijd in de VS. Nieuwe dependencies `@sentry/node`, `@sentry/react`, `@sentry/cli`.

## #056 Domeinen: staging.effectiefai.nl, later app.effectiefai.nl
- **Datum:** 2026-10-04
- **Status:** geaccepteerd
- **Context:** Web en api delen één origin (#021); elk environment heeft een eigen domein nodig.
- **Beslissing:** Staging op `staging.effectiefai.nl`; productie later in een eigen environment, bijv. `app.effectiefai.nl`.
- **Gevolgen:** `APP_ORIGIN` per environment. De marketingsite blijft los van het app-domein.

## #057 Caddy als enige publieke service (edge)
- **Datum:** 2026-10-04
- **Status:** voorgesteld
- **Context:** #021 vraagt één reverse proxy voor `/api` en `/webhooks`; api, worker, database en Valkey mogen niet publiek zijn.
- **Beslissing:** Service `edge` met Caddy en de gebouwde web-app (vervangt nginx in `apps/web/Dockerfile`), het enige publieke domein. `/api/*`, `/webhooks/*` en `/health` naar `api.railway.internal:3000`. Caddy zet `X-Forwarded-For` op alleen Railway's `X-Real-IP`, dus `API_TRUST_PROXY=1`. `X-Robots-Tag: noindex` en security-headers op elke response. api luistert op `::` (dual stack).
- **Alternatieven:** Railway-domein direct op de api met CORS (strijdig met #021); nginx houden (gebruiker koos Caddy; eenvoudigere config).
- **Gevolgen:** Het client-IP moet na de eerste deploy getest worden met vervalste headers (docs/todo.md).

## #058 Deploy: images uit CI, migratieservice, vaste volgorde
- **Datum:** 2026-10-04
- **Status:** vervangen door #064
- **Context:** Een pre-deploy command op de api deelt de variabelen van de api, dus de eigenaar-credentials zouden daar staan. Railway's GitHub-builds kennen geen volgorde tussen services.
- **Beslissing:** `deploy-staging.yml` start na een groene CI-run op main en bouwt `effectief-{api,worker,migrate,edge}:<sha>` naar GHCR. Daarna via de Railway-API: `migrate` (pre-deploy draait de migraties, alleen deze service heeft `DATABASE_MIGRATION_URL`, restart `NEVER`) → wachten op `SUCCESS` → `api` + `worker` → `edge`. api en worker controleren in een eigen pre-deploy als app-rol dat het schema bij hun image past. Migraties zijn achterwaarts compatibel met de vorige release; terugdraaien = oude SHA zonder migrate, of een nieuwe migratie.
- **Alternatieven:** Railway bouwt uit GitHub met Wait for CI (geen volgorde, Sentry-token in Railway); migratie in de start-command van de api (eigenaar-credentials in de api).
- **Gevolgen:** Railway Pro nodig voor private images. Docker-images worden in CI gebouwd (todo uit #025 vervalt in de bouw-PR).

## #059 Login-rollen in de migratiestap, wachtwoorden uit variabelen
- **Datum:** 2026-10-04
- **Status:** voorgesteld
- **Context:** #031 maakt login-rollen buiten migraties aan (`pnpm db:roles`, alleen dev en CI); op staging mag dat niet met de hand.
- **Beslissing:** Groepsrollen en grants blijven in migraties. De migratiestap maakt na de migraties de login-rollen `effectief_app` en `effectief_auth` aan of werkt ze bij met wachtwoorden uit de gedeelde Railway-variabelen, en faalt als een login-rol superuser, BYPASSRLS of eigenaar is. De logica van `create-login-roles.ts` wordt een gedeelde functie die ook in productie mag draaien.
- **Alternatieven:** Wachtwoorden in een migratiebestand (secret in git); rollen met de hand via `psql` (niet reproduceerbaar).
- **Gevolgen:** Roteren = variabele wijzigen en deployen. Railway's superuser `postgres` is de eigenaar en zit alleen in `migrate`.

## #060 Postgres-image: Railway's postgres-ssl:17 plus pgvector
- **Datum:** 2026-10-04
- **Status:** vervangen door #063
- **Context:** Railway's standaard-Postgres heeft geen pgvector; PITR werkt via pgBackRest in `postgres-ssl`; de pgvector-templates hebben PG 16/17 zonder PITR of PG 18.
- **Beslissing:** `infra/postgres/Dockerfile`: `FROM ghcr.io/railwayapp-templates/postgres-ssl:17` plus het PGDG-pakket voor pgvector (zelfde versie als in CI). Major tag, geen minor pin (eis van PITR).
- **Alternatieven:** pgvector-template van de community (geen PITR); PG 18-template (wijkt af van dev en CI op PG 17).
- **Gevolgen:** Postgres-updates via een eigen image-build. Controleren of "Enable PITR" werkt op een eigen image.

## #061 Railway-config als IaC in .railway/railway.ts
- **Datum:** 2026-10-04
- **Status:** voorgesteld
- **Context:** `railway.json`/`railway.toml` zijn deprecated en worden vanaf 2026-12-01 niet meer gelezen; nieuwe services kunnen er niet meer voor kiezen.
- **Beslissing:** Project, services, variabelen (secrets als `preserve()`), domein en volumes in `.railway/railway.ts`. Plan op PR, apply na merge (workflow `railwayapp/config`). Verschillen per environment via `ctx.isEnvironment()`.
- **Alternatieven:** `railway.json` (stopt over twee maanden); alles via het dashboard (niet reproduceerbaar voor productie).
- **Gevolgen:** Wat IaC niet dekt (restart policy, TCP proxy, PITR, backups, registry-credentials) staat als handmatige stap in docs/todo.md. Het `railway`-package is alleen een dev-dependency van de deploy-tooling.

## #062 Afscherming staging: allowlist voor registratie en noindex
- **Datum:** 2026-10-04
- **Status:** voorgesteld
- **Context:** Daniël vroeg registratie alleen voor een allowlist en noindex op alles; staging krijgt echte mail, dus zelfde beveiligingsniveau als productie.
- **Beslissing:** Verplichte env-variabele `AUTH_SIGNUP_ALLOWLIST` (adressen, `@domein`, of expliciet `*`), afgedwongen in Better Auth `databaseHooks.user.create.before`, zodat ook uitnodigingen en OAuth later langs de check gaan. `X-Robots-Tag: noindex, nofollow` en `robots.txt` via Caddy, in elk environment. Zonder login alleen `/health`, `/webhooks` (HMAC), `/api/auth` en de statische shell.
- **Alternatieven:** Alleen de sign-up-route blokkeren (andere routes die gebruikers maken lopen er omheen); basic auth op alles (open vraag in docs/deployment.md §9).
- **Gevolgen:** Lokaal staat `AUTH_SIGNUP_ALLOWLIST=*` expliciet in `.env.example`.

## #063 Postgres: Railway's postgres-ssl:17 zonder eigen image
- **Datum:** 2026-10-04
- **Status:** voorgesteld
- **Context:** #060 ging uit van de docs: geen pgvector in Railway's Postgres. Het image `ghcr.io/railwayapp-templates/postgres-ssl:17` (build 2026-09-30, Debian trixie, PG 17.11) bevat inmiddels `postgresql-17-pgvector` 0.8.6; `CREATE EXTENSION vector` werkt.
- **Beslissing:** Railway's eigen Postgres-service op tag `17`, geen eigen image. PITR werkt daarop zoals gedocumenteerd.
- **Alternatieven:** eigen image (#060): eigen onderhoud, en onzeker of "Enable PITR" er goed mee omgaat.
- **Gevolgen:** Haalt Railway pgvector ooit weg, dan faalt migratie 0000 bij de deploy (luid, niet stil); dan alsnog #060. CI draait pgvector 0.8.7, staging 0.8.6; verschil is een patch-release.

## #064 Deploy: één IaC-apply, volgorde via pre-deploys
- **Datum:** 2026-10-04
- **Status:** voorgesteld
- **Context:** #058 liet de workflow per service uitrollen via de Railway-API. Dat botst met een IaC-file die de image vastlegt, en die API-mutaties zijn zonder account niet te testen.
- **Beslissing:** Na groene CI op main bouwt `deploy-staging.yml` de images (`:<sha>`) en doet één `railway config apply` met `IMAGE_TAG=<sha>`. De volgorde komt uit de pre-deploys: `migrate` migreert; api en worker wachten als app-rol tot hun nieuwste migratie in de database staat (max. 15 min); de edge wacht tot `/health` van de api zijn release meldt. Alleen `migrate` heeft eigenaar-credentials (test op `.railway/railway.ts`). Railway's Redis in plaats van een eigen Valkey-service.
- **Alternatieven:** per service uitrollen en pollen via GraphQL (#058; ongetest, en dubbel met IaC); alleen Wait for CI (geen volgorde).
- **Gevolgen:** Ook een handmatige redeploy start nooit op een oud schema. `/health` geeft de release (git-SHA) terug. De workflow wacht niet op het einde van de uitrol; dat ziet Daniël in Railway en Sentry.

## #065 Lokale stack en verify-job tegen de echte database
- **Datum:** 2026-10-05
- **Status:** geaccepteerd
- **Context:** De staging-opzet (images, pre-deploys, rollen, edge) was alleen los getest. De RLS- en roltests moeten ook tegen de staging-database draaien, zonder TCP proxy.
- **Beslissing:** `docker-compose.stack.yml` start dezelfde images met de env van `.railway/railway.ts` tegen de lokale Postgres (eigen database `effectief_stack`, eigen login-rollen) en Valkey; CI draait die stack met een smoketest door de edge. Image `effectief-verify` (stage `verify` in `apps/migrate/Dockerfile`) draait de RLS- en roltests van packages/db als app- en auth-rol; op Railway service `verify` bij elke deploy op staging (restart `NEVER`, resultaat in de deploy-log), niet in productie.
- **Alternatieven:** Tests via een TCP proxy vanaf een laptop (database publiek); verify alleen op verzoek (een apply zonder de service wil hem verwijderen en faalt).
- **Gevolgen:** De tests maken op staging testtenants aan en ruimen ze op. De image-matrix in CI is vervangen door de stack-job. Registry-credentials ook voor `verify`.

## #066 Custom domain eerst in het dashboard, daarna in IaC
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** De eerste `railway config plan` weigerde: "Custom-domain registration is not supported by Railway configuration. Add staging.effectiefai.nl in the dashboard". #061 zette het domein in `.railway/railway.ts`.
- **Beslissing:** `edge` zonder `domains` uitrollen; Daniël voegt `staging.effectiefai.nl` (poort 8080) in het dashboard toe zodra `edge` bestaat; daarna komt het domein terug in `railway.ts`, zodat het vastligt. Zelfde volgorde voor productie.
- **Alternatieven:** de `edge`-service met de hand aanmaken (onduidelijk of IaC hem dan overneemt).
- **Gevolgen:** Tot stap 2 test `railway-config.test.ts` dat geen service publiek is vanuit de file. Of een bestaand domein in de file wordt geaccepteerd, blijkt bij de volgende deploy.

## #067 Databases na aanmaken controleren; publieke images
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** De eerste apply maakte `postgres` (op `postgres-ssl:18`) en `redis` aan in `asia-southeast1`, ondanks `image` en `region` in `.railway/railway.ts`; de app-services stonden wel in `europe-west4`. Railway kon de images ophalen zonder registry-credentials: de repository is publiek, dus de GHCR-images ook.
- **Beslissing:** Na het aanmaken van een database (ook straks in productie) regio en image controleren en, zolang hij leeg is, corrigeren met een tweede apply en een nieuw volume. Geen registry-credentials en geen Pro-plan zolang de repository publiek is.
- **Alternatieven:** de databases met de hand in het dashboard aanmaken (buiten IaC); de repository of de packages privé maken (dan wel credentials en Pro, #058).
- **Gevolgen:** Wordt de repository privé, dan eerst registry-credentials zetten, anders faalt de volgende deploy. Een test op de gerenderde config bewijst niet wat Railway aanmaakt; het verify- en statuswerk na een deploy blijft nodig.

## #068 Door Railway aangemaakte resources in IaC opnemen
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** PITR aanzetten maakte bucket `Postgres-PITR` (regio `ams`) aan. Die stond niet in `.railway/railway.ts`, dus de volgende apply wilde hem verwijderen; de workflow weigerde dat (geen `--confirm-destructive`). Het domein van `edge`, eerst in het dashboard toegevoegd (#066), accepteert IaC daarna wel in de file zonder wijziging.
- **Beslissing:** Alles wat Railway of het dashboard aanmaakt en moet blijven (PITR-bucket, domein) komt na het aanmaken in `railway.ts`, gecontroleerd met een `config plan` zonder destroy. Bucket voorlopig alleen voor staging; productie krijgt hem na het aanzetten van PITR daar.
- **Alternatieven:** applies met `--confirm-destructive` (zou de WAL-archieven verwijderen).
- **Gevolgen:** Een handmatige wijziging in het dashboard blokkeert de volgende deploy tot ze in de file staat; dat is bedoeld.

## #069 Testfouten buiten productie, geschakeld op SENTRY_ENVIRONMENT
- **Datum:** 2026-10-05
- **Status:** geaccepteerd
- **Context:** Sentry moet per app aantoonbaar werken op staging (juist project, release, leesbare stacktrace, geen persoonsgegevens), zonder in productie een knop te hebben die fouten maakt.
- **Beslissing:** `SENTRY_ENVIRONMENT` wordt een enum (`development | test | ci | stack | staging | production`); `testErrorsEnabled()` is waar behalve in `production`, nooit op basis van een hostnaam. `SENTRY_DSN=disabled` mag alleen buiten staging en production (check in api-, worker- en web-schema, ook bij de build). Testfouten: oRPC `POST /api/test/error` (apart `testContract`, alleen voor owner, `target: api | worker`), queue `monitoring-test` (faalt altijd, 2 pogingen) en pagina `/testfout` in web. Alle drie gooien `MonitoringTestError` met een nep-adres en nep-naam in message en context.
- **Alternatieven:** een aparte variabele `TEST_ERRORS` (nog een schakelaar die in productie verkeerd kan staan); de procedure in het gewone contract met een 404-handler (dan bestaat ze wel in productie).
- **Gevolgen:** In productie zit de procedure niet in de router (404), start de worker de queue niet en geeft de route `notFound`; tests bewijzen dat. De sessie kent nu de rol (`owner | admin | member`); een onbekende rol geeft geen sessie.

## #070 Foutteksten schrappen op de eigen data van de fout; oRPC-fouten naar Sentry
- **Datum:** 2026-10-05
- **Status:** geaccepteerd
- **Context:** Een naam in een foutmelding is niet te herkennen; pino redigeerde alleen op sleutel, dus `err.message` en `err.stack` kwamen ongemoeid in de logs. Fouten uit oRPC-procedures bereikten Sentry niet: de handler vangt ze zelf af.
- **Beslissing:** `scrubErrorText()` in packages/shared vervangt e-mailadressen en haalt de waarden weg die de fout zelf onder gevoelige sleutels draagt (ook in `cause`). Gebruikt in `beforeSend` (via `hint.originalException`) en in een `err`-serializer van pino in api en worker. `extraErrorDataIntegration` zet de eigen velden van een fout in het event, waar de sleutels worden gecensureerd. De oRPC-`onError` meldt 5xx met de oorspronkelijke fout. CI bewijst het op de images met `scripts/stack-redaction.sh`.
- **Alternatieven:** de foutmelding nooit meesturen (onleesbare issues); namen herkennen met een heuristiek (onbetrouwbaar, verminkt tekst).
- **Gevolgen:** Een naam die alleen in de tekst staat en nergens in de data van de fout, blijft zichtbaar. Wie een fout met persoonsgegevens gooit, zet die gegevens dus ook in een veld met een gevoelige sleutel. De e-mailregex slaat paden met `/` over, zodat stackframes leesbaar blijven.

## #071 Lokale webhooks via een cloudflared quick tunnel; API_TRUST_PROXY=1 in dev
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** Providers moeten webhooks naar de lokale api kunnen sturen. Een tunnel maakt de dev-api publiek, en lokaal staat registratie open (`AUTH_SIGNUP_ALLOWLIST=*`).
- **Beslissing:** `pnpm tunnel` (`scripts/dev/webhook-tunnel.ts`) start een cloudflared quick tunnel naar een lokale proxy die alleen `/webhooks/*` doorlaat en `X-Forwarded-For` overschrijft met `Cf-Connecting-Ip`. Dev gebruikt `API_TRUST_PROXY=1`, net als staging: één proxy-hop die de header zet. Alleen development: weigert in CI en productie, `scripts/dev` staat in `.dockerignore`. Vaste URL (named tunnel, Cloudflare-account) pas als een provider dat vereist.
- **Alternatieven:** ngrok (account en limieten op het gratis plan); de tunnel direct op de api (zet login en registratie open); `API_TRUST_PROXY=false` in dev (alle tunnelverkeer deelt de sleutel `127.0.0.1` met de eigen browser).
- **Gevolgen:** cloudflared is een lokale tool (`brew install cloudflared`), geen dependency. Zonder tunnel stuurt niemand `X-Forwarded-For` naar de dev-api, dus `1` verandert lokaal niets. CI blijft op `false`.

## #072 verify-restore via railway ssh, read-only als superuser
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** De restore-oefening (docs/deployment.md §7.3) vraagt een vergelijking van de herstelde database met de bron. Postgres heeft geen TCP proxy, en RLS verbergt rijen voor elke rol behalve de superuser.
- **Beslissing:** `scripts/deploy/verify-restore.ts` stuurt vaste SQL via `railway ssh` naar `psql` in beide Postgres-containers, met `default_transaction_read_only=on`, als de superuser van de container. Vergelijkt migraties, tabellen, rijen van vóór het hersteltijdstip, een gehashte steekproef, geforceerde RLS en de login-rollen. Output: alleen namen, aantallen en ID's. De logica staat in `packages/db/src/deploy/verify-restore.ts`, getest in `apps/migrate`.
- **Alternatieven:** een tijdelijke job op het privénetwerk met eigenaar-credentials (nog een plek met die credentials, #064); een TCP proxy (database publiek).
- **Gevolgen:** Wie het script draait heeft de Railway-CLI met een geregistreerde SSH-sleutel nodig (docs/operations.md). Werkt ook voor productie, maar daar is steekproef-SQL als superuser op klantdata een bewuste handeling.

## #073 Spelregels voor agents bij externe accounts (Nango eerst)
- **Datum:** 2026-10-05
- **Status:** geaccepteerd
- **Context:** Nango's coding-agent-setup is ingericht: Docs MCP, Management MCP (beta, user-scope, API key), skill `building-nango-functions` en de CLI. Daarmee kan een agent integraties wijzigen, functions deployen en via providers handelen.
- **Beslissing:** Regels in CLAUDE.md, sectie "Externe accounts": alleen de Nango staging-environment, die nooit klantdata bevat; deploys naar staging via CI na merge, vanaf de laptop alleen met toestemming; lezen mag, schrijven alleen met toestemming per keer; fixtures uit echte data geanonimiseerd. Afgedwongen in `.claude/settings.json`: `nango-docs` toegestaan, `nango-management` altijd `ask`, `deny` op `.env*` (behalve `.env.example`), `~/.claude.json` en Bash-commando's met `KEY`, `SECRET` of `TOKEN` of die de omgeving tonen. gitleaks krijgt regels `nango-secret-key` en `bearer-uuid`.
- **Alternatieven:** alleen afspraken zonder permissies (een agent in auto-mode leest ze niet af); een aparte API key zonder schrijfrechten (biedt Nango niet per tool).
- **Gevolgen:** Bash-deny is case-sensitive en geen harde grens (`bash -c`, andere schrijfwijzen); de regels zijn de afspraak, de permissies het vangnet. Bash-commando's met `KEY`/`SECRET`/`TOKEN` in hoofdletters (ook commitberichten) worden geweigerd. Een `ask` op de hele server overstemt elke `allow` op één tool; leesrechten zonder vragen vereisen dus `ask` per schrijftool. Geldt straks ook voor Railway en Sentry.

## #074 Mail via eigen Nango-syncs: alleen inbox, minimale velden, 14 dagen, direct prunen
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** Sessie 4 haalt mail binnen via Nango. Het Gmail-template synct de hele mailbox zonder tekst; het Outlook-template 30 dagen met volledige HTML. Nango bewaart record-payloads 30 dagen, in AWS (regio niet gedocumenteerd).
- **Beslissing:** Eigen syncs `inbox-messages` voor Gmail (history-API) en Outlook (delta), elke 5 minuten, eerste keer 14 dagen terug. Alleen de inbox, zonder spam, prullenbak en Gmail-categorieën Promoties en Sociaal. Per mail: ID's, afzender, ontvangers (to/cc), onderwerp, platte tekst (max. 32.000 tekens), systeemlabels en bijlage-metadata; geen bijlagen, HTML of andere headers. Na het opnemen prunet de worker de records in Nango tot de cursor. Verwijderd of naar spam bij de bron → bron-inhoud weg, event blijft. Details in docs/integrations.md §3.
- **Alternatieven:** de templates (te veel of te weinig data); tekst via de proxy in plaats van in de records (geen mailtekst in Nango's cache, maar proxy-scope in de worker en meer code; open vraag 4).
- **Gevolgen:** Nieuwe kolommen `event_contents.from_name` en `cc_addresses`, `events.payload` krijgt `labels` en `backfill`. Nango op de subverwerkerslijst met regio en doorgiftegrondslag (#005).

## #075 Tenant-toewijzing van een nieuwe connectie via een connect attempt
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** De auth-webhook `creation` bevat alleen de tags van de connect session. Op het gedeelde staging-environment maken ook lokaal, het dashboard en de MCP connecties.
- **Beslissing:** `connections.startConnect` legt een rij in `connect_attempts` vast (tenant en gebruiker uit de sessie) en zet `connect_attempt_id` als tag. De webhook-route zoekt de tenant op met `resolve_connect_attempt()` (SECURITY DEFINER, alleen ID's, zoals #038); de job verbruikt de attempt in dezelfde transactie als `createConnection()`. Onbekende of verbruikte attempts: loggen, 200, niets doen, niets verwijderen. Tags zonder e-mail (`end_user`/`organization` zijn deprecated). Vangnet: `connections.complete({ attemptId })` zoekt bij Nango op de tag. Bij reconnect weigert een `validate-connection`-function een ander account.
- **Alternatieven:** tenant uit `tags.organization_id` (bewijst niet dat deze database de flow startte); een Redis-nonce met `GETDEL` (niet transactioneel met het aanmaken); `connectionId` uit de frontend.
- **Gevolgen:** `webhook_deliveries.connection_id` wordt nullable met `connect_attempt_id` ernaast. Vult de regel "Nango connect-session" in CLAUDE.md in.

## #076 Inlezen: webhook als seintje, cursor per connectie, vangnet-job
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** Nango probeert een webhook maar 2 keer opnieuw (binnen een seconde) en stuurt geen delivery-ID; sync-webhooks bevatten geen records.
- **Beslissing:** Webhook → `webhook_deliveries` (#038) → job. Job `mail-ingest` per connectie (gededupliceerd, cursorrij `FOR UPDATE`) haalt records op vanaf de cursor in `sync_cursors`; per pagina één transactie met events, bron-inhoud en de nieuwe cursor. Een `sweep` elke 10 minuten zet voor elke actieve mailconnectie een ingest-job (fan-out via `list_tenant_ids()`, zoals #052). `delivery_id` = sha256 van de body, voor auth-webhooks plus het uur.
- **Alternatieven:** records in de webhook-request verwerken (#013); alleen op webhooks vertrouwen (gemiste webhook = gemiste mail); `modified_after` in plaats van de cursor (Nango raadt de cursor aan).
- **Gevolgen:** Nieuwe tabel `sync_cursors`. Lokaal werkt zonder webhooks.

## #077 Levenscyclus van een mailconnectie
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** CLAUDE.md en #044 geven de statussen; Nango meldt refresh-fouten en herstel, opnieuw autoriseren en verwijderen als auth-webhooks.
- **Beslissing:** Refresh mislukt → `expired` (`invalid_grant`) + kaart `connection_problem` "Koppeling vernieuwen", geen ingest meer. Refresh hersteld → `active` met nieuwe reden `auth_recovered`. `override` → `expired → active` (`reauthorized`). `deletion` → `revoked` + purge. Ontkoppelen: `revoked` → job `purge-connection` verwijdert eerst de connectie bij Nango (een `pre-connection-deletion`-function trekt bij Google het token in), daarna `purgeConnection()`.
- **Alternatieven:** wachten met `expired` tot Nango opgeeft (gebruiker ziet dagen geen mail zonder uitleg); `revoked` bij een refresh-fout (niet herstelbaar, terwijl het een storing kan zijn).
- **Gevolgen:** Microsoft kent geen intrekken door de app zelf; de app wijst de gebruiker de weg naar zijn Microsoft-account. Te verifiëren in de Microsoft-docs.

## #078 Nango-keys per gebruik, gedeeld staging-environment en webhook-override voor lokaal
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** Nango-keys kunnen per key scopes krijgen. `staging` wordt gedeeld door lokaal, Claude Code en staging.effectiefai.nl; Nango heeft twee webhook-URL's per environment en een `webhook_url_override` per connectie.
- **Beslissing:** Aparte keys per environment en gebruik: `app-api` (`connect_sessions:write`), `app-worker` (`records:read/write`, `actions:execute`, `connections:delete`), `local-api`/`local-worker` (zelfde scopes), `mcp-readonly` (alleen list/read/logs, geen `connections:read`), `ci-deploy` (`deploy`). De full-access-keys worden niet gebruikt en verwijderd. Primaire webhook-URL wijst naar staging; lokaal zet `NANGO_WEBHOOK_URL_OVERRIDE` (tunnel of `none`) de override op nieuwe connecties. De webhook-route controleert `environment` tegen `NANGO_ENVIRONMENT`.
- **Alternatieven:** één full-access-key per environment (een lek geeft alles); een eigen Nango-environment voor lokaal (dubbele integraties en OAuth-apps).
- **Gevolgen:** De MCP-key kan niet meer schrijven, dus de allowlist voor leestools (#073) is veilig. Env-variabelen `NANGO_ENVIRONMENT`, `NANGO_SECRET_KEY`, `NANGO_WEBHOOK_SIGNING_KEY`, `NANGO_WEBHOOK_URL_OVERRIDE`.

## #079 nango-integrations in de repo, deploy via CI, eigen Nango-client
- **Datum:** 2026-10-05
- **Status:** voorgesteld
- **Context:** #005 wil de integratiecode in de eigen repo; CLAUDE.md noemt `packages/integrations` met `nango-integrations/`. Deployen naar Nango-staging gebeurt via CI (#073).
- **Beslissing:** `packages/integrations/nango-integrations/` als eigen workspace-package met `nango` 0.71.12; functions per provider (`syncs/`, `actions/`, `on-events/`) met fixture-tests. CI: `nango compile` + tests op PR, `nango deploy staging` in `deploy-staging.yml` na merge, zonder `--allow-destructive`. In de app een eigen `fetch`-client met Zod (geen `@nangohq/node`); in web `@nangohq/frontend` 0.71.12 voor de Connect UI. Recordmodellen alleen uitbreiden, nooit breken.
- **Alternatieven:** `@nangohq/node` (axios, geen validatie van antwoorden); `connect_link` zonder frontend-SDK (geen events).
- **Gevolgen:** Nieuwe dependencies `nango` (dev) en `@nangohq/frontend`. Een test vergelijkt het recordmodel in de function met het schema in de app.
