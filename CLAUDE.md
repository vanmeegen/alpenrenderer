# Arbeitsregeln für alpenrenderer

## Test first, Red-Green

Jede Verhaltensänderung beginnt mit einem Test, der **rot** ist, und endet,
wenn er **grün** ist. Reihenfolge, ohne Ausnahme:

1. Test schreiben, der das gewünschte Verhalten beschreibt.
2. Test ausführen und den Fehlschlag sehen (rot). Ein Test, der sofort grün
   ist, prüft nichts Neues; dann Test oder Annahme korrigieren.
3. Die kleinste Implementierung, die den Test grün macht.
4. Alle Tests ausführen. Erst dann Refactoring, dann Commit.

Bestehendes Verhalten ohne Test bekommt zuerst einen Charakterisierungstest
(grün), bevor es geändert wird. Im PR-Text steht für jede neue Fähigkeit,
welcher Test sie rot und dann grün gemacht hat.

## Was wo getestet wird

| Ebene | Werkzeug | Ort | Befehl |
|---|---|---|---|
| Unit (Engine, Zustand, Gesten, Shader-Preprocessing) | `bun test` | `tests/unit/` | `bun run test:unit` |
| End-to-End (App im Chromium, WebGL2, synthetisches Gelände) | `@playwright/test` | `tests/e2e/` | `bun run test:e2e` |
| Datenmaterial (Mapterhorn live, nur manuell) | `@playwright/test` | `tests/data/` | `bun run test:data` |

`bun run check` = Typecheck plus Unit-Tests. `bun run test` = Unit plus E2E.
CI (`.github/workflows/ci.yml`) führt beides auf jedem Push und PR aus.

## Determinismus

- E2E-Tests laden **kein** Gelände aus dem Netz. Sie rendern das
  synthetische Gelände aus `tests/e2e/fixtures/terrain.ts`, das ein Skript
  vor dem Lauf als Terrarium-Tiles erzeugt (`tests/e2e/fixtures/gen.mjs`).
  Die Formel ist die Referenz: Erwartungswerte in Tests werden daraus
  berechnet, nicht abgelesen.
- E2E rendern mit `q=low` (640 × 900 Vertizes) und ohne beleuchteten
  Shade-Pass (`shade=0`): SwiftShader im Headless-Chromium braucht pro Seite
  ~10 s, um die Shade-Pipeline zu kompilieren, und ~1 s je Frame, sie zu
  zeichnen (ohne sie 8 s und 17 ms); das hohe Netz (1,6 M Vertizes) stallt
  50 s. Nur die Farbtests (Golden, Flanken, Konturen, See, Kamera-/Foto-
  Himmel) setzen `shade=1`. Die Geometrie-Toleranzen sind auf `q=low`
  ausgelegt; `q=high` prüft der Benutzer.
- Der Renderer zeichnet nur bei Änderung (`render/redraw.ts`), und
  Headless-Chromium lässt `requestAnimationFrame` nur laufen, solange etwas
  Frames anfordert (`waitForFunction` mit raf-Polling, nicht `waitForTimeout`).
  Tests lesen Bilder deshalb über `renderer.capture()`/`readRange()`, die
  Ausstehendes zuerst zeichnen, und zählen Frames über rAF-Ticks in der Seite.
- Pixel-Erwartungen prüfen Regionen und Übergänge, keine exakten Farbwerte.
  Screenshot-Goldens nur mit Toleranz und nur für Linux-Chromium aus CI.
- Live-Daten (Tileserver, Coverage-Index) werden ausschließlich in
  `tests/data/` angefasst, und die laufen nur per `workflow_dispatch`
  (`.github/workflows/data-check.yml`), nie in CI oder E2E, damit weder
  Rate-Limits noch Datenänderungen die Builds brechen.

## Sonstiges

- Engine-Code in `src/engine/` stammt aus peakviewer (MIT); Änderungen dort
  brauchen den passenden Unit-Test in `tests/unit/`.
- Shader gibt es doppelt (WGSL und GLSL); beide ändern, `tests/unit/wgsl`
  prüft das WGSL-Preprocessing, die E2E-Tests den GLSL-Pfad im Bild.
- Deutsch in Doku und Commits, Englisch im Code.
