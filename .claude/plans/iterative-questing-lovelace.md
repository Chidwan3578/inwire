# Plan — Dossier `examples/`

## Context
Le package inwire n'a pas d'exemples concrets au-delà du README. On crée 3 fichiers TypeScript auto-suffisants (sans dépendances externes) qui montrent les features clés dans des scénarios réalistes.

## Fichiers à créer

### `examples/web-api.ts` — Backend API classique
Scénario : API REST avec config, database, repository, service, logger.
Features illustrées :
- `createContainer` avec chaîne de dépendances
- Annotation de return type pour dependency inversion (`: UserRepository =>`)
- `OnInit` / `OnDestroy` lifecycle
- `preload()` pour init async
- `dispose()` pour shutdown graceful
- `inspect()` pour debug

### `examples/multi-tenant.ts` — Isolation per-request
Scénario : SaaS multi-tenant avec un container parent (infra) et des scopes per-request.
Features illustrées :
- `scope()` avec `{ name }` pour isolation per-request
- `transient()` pour request ID
- Héritage parent → child
- `health()` + scope mismatch awareness
- `reset()` pour hot-reload de config

### `examples/plugin-system.ts` — Composition modulaire
Scénario : App extensible via modules (core, auth, notifications) composés avec `extend()`.
Features illustrées :
- Modules = plain objects spread
- `extend()` pour composition additive
- `detectDuplicateKeys()` pour safety check
- `describe()` pour introspection d'un provider
- Error handling avec `ContainerError`

## Contraintes
- Chaque fichier est self-contained : classes/interfaces définies inline (stubs réalistes)
- Pas de dépendances externes (pas d'Express, Prisma, etc.)
- Import depuis `inwire` (pas de chemins relatifs `../src/`)
- Commentaires concis expliquant ce qui se passe
- Chaque fichier ~60-100 lignes

## Vérification
- Le tsconfig principal n'inclut que `src/` — les exemples ne sont pas type-checkés par défaut
- Vérifier avec `npx tsc --noEmit -p tsconfig.json` (projet principal inchangé)
- Vérifier les exemples avec `npx tsc --noEmit --strict --module ES2022 --moduleResolution bundler --target ES2022 examples/*.ts`
- `npm test` + `npm run build` restent verts
