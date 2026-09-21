# alpenrenderer

Die Alpen in 3D aus offenen Höhendaten, im Browser, PeakVisor-ähnlich:
Panorama von jedem Standpunkt, Gipfelnamen, später AR über dem Kamerabild.
Nur frei verfügbare Daten.

Live: https://vanmeegen.github.io/alpenrenderer/

## Stand

- **Inkrement 0** (Spike, Vorcheck): [Zugspitze 3D](spike/zugspitze/) als
  WebGL-Heightmap mit Karten-Gesten, live unter
  https://vanmeegen.github.io/alpenrenderer/spike/zugspitze/.
- **Inkrement 1** (3D-Panorama): die App. Schattiertes Panorama bis 270 km
  von einem Standpunkt aus, Mapterhorn-Terrain (LiDAR-Auflösung in D/A/CH),
  Krümmung und Refraktion, ein Finger schaut um, zwei Finger zoomen.
  Standpunkt und Blick stehen in der URL.
- **Inkrement 2a** (Standpunkt wählen): „Karte“ öffnet OpenStreetMap, mit den
  Fingern verschieben und zoomen, Punkt antippen, „Panorama von hier“;
  „Mein Standort“ nimmt die GPS-Position. Der Blick bleibt dabei erhalten.
- **Inkrement 2b** (Sichtachse per Sensoren): „Sensoren“ lässt das Panorama
  dem Handy folgen (Kompass plus Gyro, Deklination aus dem Weltmagnetmodell).
  Weil der Kompass in den Bergen oft daneben liegt, korrigiert ein Finger in
  diesem Modus die Richtung; die Korrektur bleibt gespeichert und steht an
  der Kompassrose.
- **Inkrement 3a** (Gipfelnamen): Gipfel aus OpenStreetMap stehen als Label
  im Panorama, verdeckte bleiben weg (DEM-Marsch mit Krümmung und
  Refraktion), Tippen öffnet Höhe, Entfernung, Peilung und Wikipedia. Der
  Katalog liegt statisch als Zellen unter `public/peaks/` (Build:
  `node tools/build_peaks.mjs`), die App fragt Overpass nie selbst.
- **Inkrement 3b** (Live-Kamera): „Kamera“ legt die Grate und Gipfelnamen
  über das Kamerabild (weiß gewaschen, damit die Linien tragen), das
  Sichtfeld folgt dem Objektiv und lässt sich mit einem Regler korrigieren,
  „Foto“ speichert das Bild mit Labels und Quellenzeile als PNG.
- **Inkrement 3c** (Foto): „Foto laden“ legt die Grate und Namen über ein
  Foto. Standpunkt und Objektiv kommen aus dem EXIF (GPS, Brennweite),
  „Ausrichten“ legt die berechnete Skyline auf die des Fotos (Richtung,
  Neigung, Rolle, bei unbekanntem Objektiv auch das Sichtfeld) und sagt, wie
  sicher es sich ist; ein Finger korrigiert weiterhin von Hand.
- Der Plan: [plaene/](plaene/2026-09-20-peakviewer-mapterhorn.md).

## Entwicklung

    bun install
    bun run dev            # http://localhost:5173
    bun run check          # tsc + Unit-Tests (bun test tests/unit)
    bun run build          # -> dist/
    bun run test:e2e       # Playwright, App im Chromium gegen synthetisches Gelände
    bun run test           # Unit + E2E

Gearbeitet wird test-first (Red-Green), siehe `CLAUDE.md`. Unit-Tests
liegen in `tests/unit/` (Engine, Zustand, Gesten, Shader-Preprocessing),
E2E-Tests in `tests/e2e/` (die gebaute App in Chromium mit Software-WebGL2,
Gelände aus der Formel in `tests/e2e/fixtures/terrain.ts`, kein Netz; GPS und
Orientierungssensoren werden emuliert bzw. als synthetische Events eingespeist,
die Kamera ist Chromiums Fake-Gerät mit einem festen Y4M-Bild, das Foto ein
aus der Geländeformel gerendertes PNG mit eXIf-Chunk). CI
(`.github/workflows/ci.yml`) führt beides auf jedem Push aus.

Die Daten-Suite `tests/data/` prüft das Live-Material von Mapterhorn
(TileJSON, Header, verlustfreies 512-px-WebP, Gipfelhöhen gegen
`tests/data/reference.json`, Coverage-Index, Attribution). Sie läuft nur von
Hand, lokal mit `bun run test:data` oder über **Actions → „Data check
(Mapterhorn, manual)“ → Run workflow**, damit weder Rate-Limits noch eine
Datenaktualisierung die Builds brechen.

Den Gipfelkatalog baut **Actions → „Build peak catalogue (OpenStreetMap,
manual)“ → Run workflow** (Overpass, mit Wiederholungen, Zeitbudget und
Wiederaufnahme fehlender Zellen). Der Lauf pusht den Branch
`peaks/<Datum>` und legt dazu einen PR an; das gelingt nur, wenn unter
Settings → Actions → General „Allow GitHub Actions to create and approve
pull requests“ eingeschaltet ist. Sonst meldet der Lauf eine Warnung mit dem
Link, unter dem der PR von Hand anzulegen ist.

Für Offline-Tests und Headless-Renders einen lokalen Tile-Cache füllen und
der App per `?tiles=` mitgeben:

    bun run cache:tiles                        # -> tile-cache/ (Gornergrat, Zugspitze)
    python3 -m http.server 8765
    # http://localhost:8765/dist/?tiles=/tile-cache/#lon=7.78472&lat=45.98333&yaw=232
    node tools/shot.mjs "http://localhost:8765/dist/?tiles=/tile-cache/#lon=7.78472&lat=45.98333&yaw=232" shots/gornergrat.png

URL-Parameter: `#lon`, `lat`, `alt` (absolute Augenhöhe, sonst Boden + 1,7 m),
`yaw`, `pitch`, `fov`, `p=<ort>` für einen der Standpunkte im Menü;
`?backend=webgpu` statt WebGL2, `?q=high|low` statt automatischer Qualität,
`?peaks=<verzeichnis>` für einen anderen Gipfelkatalog (Zellen `{x}_{y}.json`).

## Aufbau

    src/engine/     Terrain-Engine, aus peakviewer übernommen (MIT): Geodäsie,
                    Clipmap, Renderer (WGSL + GLSL), Tile-Quellen, Labels, Pose
    src/app/        React-Shell: Viewer, Steuerung, URL-Zustand, HUD
    spike/          Wegwerf-Prototypen (Inkrement 0)
    tools/          Checks und Headless-Renders
    plaene/         Pläne

Die Engine stammt aus [peakviewer](https://github.com/pascalbayer/peakviewer)
von Pascal Bayer (MIT, siehe `src/engine/LICENSE-peakviewer`), umgestellt auf
512-px-Tiles von [Mapterhorn](https://mapterhorn.com) und um einen
Shading-Pass erweitert.

## Daten und Lizenzen

- Gelände: [Mapterhorn](https://mapterhorn.com/attribution), ein Komposit
  offener nationaler Höhenmodelle (swissALTI3D, BEV, Bayern DGM1, Südtirol,
  Aosta, IGN …) mit Copernicus GLO-30 als globalem Fallback. Die Quellen
  unter dem jeweiligen Standpunkt zeigt die App unter „Quellen“.
- Gipfel (`public/peaks/`, `natural=peak` mit Namen, per Overpass gebaut) und
  Standpunkt-Karte: © OpenStreetMap contributors, ODbL; die Kartenkacheln
  kommen vom Standard-Tile-Layer der OpenStreetMap Foundation.
- Code: MIT. Drittkomponenten in `THIRD-PARTY-NOTICES.md`.
