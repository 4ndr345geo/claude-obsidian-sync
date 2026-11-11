# Sync-Logik früherer Versionen

Unveränderte Kopien von `src/` der veröffentlichten Versionen (nur die Dateien, die die
Sync-Logik braucht). `test/compat.test.ts` lässt sie gegen die aktuelle Version auf demselben
simulierten Google Drive synchronisieren, damit Geräte mit unterschiedlichen Plugin-Versionen
zusammenarbeiten.

- Nicht bearbeiten, nicht von `tsc` geprüft (siehe `tsconfig.json`: nur `src/`).
- Bei einer Version, die das Verhalten in Google Drive ändert, die vorherige hier ergänzen:
  `git show <tag>:src/<datei>.ts > test/legacy/v<x_y_z>/<datei>.ts`
