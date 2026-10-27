# Repository Guidelines

## Project Structure & Architecture

Build a production-quality mobile Weather app with React Native, Expo, TypeScript, and Expo Router. Keep routes in `src/app/` and screen implementations in `src/screens/`. Separate reusable UI, API access, stateful logic, domain models, pure helpers, and shared values into `src/components/`, `src/services/`, `src/hooks/`, `src/types/`, `src/utils/`, and `src/constants/`, respectively.

Prefer simple, maintainable architecture over unnecessary abstraction. Keep routes thin and network access out of UI components. Explain important architecture decisions briefly in pull requests or implementation summaries.

## Development Commands

- `npm install`: install dependencies; commit the generated lockfile.
- `npm start`: start the Expo development server.
- `npm run ios`: build and launch locally with Xcode on macOS.
- `npm run android`: build and launch with an Android SDK and emulator/device.
- `npm run lint`: check code with Expo's ESLint configuration.
- `npm run typecheck`: check TypeScript without emitting files.
- `npm run build`: export JavaScript bundles, not signed store binaries.

Run lint and typecheck after significant changes. Report checks that could not run and why.

## Coding Style & Engineering Rules

Use TypeScript strict mode, functional React components, and hooks. Keep components small and reusable. Use two-space indentation, PascalCase for components, camelCase for functions, and `use` prefixes for hooks. Avoid unnecessary dependencies; prefer existing tooling and platform APIs.

Handle loading, error, and empty states for asynchronous screens, with actionable recovery where appropriate.

## Configuration & Security

Never hardcode API keys or secrets. Use environment variables and document public configuration in `.env.example`. Expo's `EXPO_PUBLIC_` values are bundled into the app; keep provider credentials on a backend. Never commit local environment files or log credentials.

## Change & Review Workflow

Before a large change, inspect the repository and provide a short implementation plan. Do not delete or rewrite unrelated code. Make the smallest changes necessary for each task. After implementation, review changes for bugs and regressions.

No test framework or coverage threshold is configured yet. Add focused tests with new behavior, including deterministic weather fixtures and failure cases. Use imperative commit subjects. Pull requests should explain behavior changes, link relevant issues, and record verification results; include screenshots for UI changes.
