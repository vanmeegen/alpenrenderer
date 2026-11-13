# Plan: peakviewer-Engine + Mapterhorn-Terrain für alpenrenderer

Stand: 2026-09-20. Analysiert wurde `pascalbayer/peakviewer` auf Commit
`ca898e4` (17 Commits, MIT) sowie der Mapterhorn-Tileserver
(`tiles.mapterhorn.com`) mit echten Tile-Abrufen.

## 1. Ergebnis in einem Satz

Der Ansatz „peakviewer als Engine übernehmen, Terrain von AWS Terrain Tiles auf
Mapterhorn umstellen“ ist verifiziert und bleibt der beste Weg, aber mit zwei
Einschränkungen, die den Plan prägen: peakviewer rendert heute **nur Umrisse**
(Kantenfilter über einen Distanzpuffer, keine Schattierung), und es ist eine
**AR-first-App ohne Desktop-3D-Modus**. Inkrement 1 („nur 3D darstellen“) ist
deshalb nicht nur ein Datenquellentausch, sondern braucht einen neuen
Shading-Pass und eine eigene Shell. Davor steht ein Vorcheck (Inkrement 0):
ein Wegwerf-Spike, der auf iPad und Handy zeigt, dass die Daten sauber
rendern, die Bildrate reicht und die Fingersteuerung gut anfühlt.

## 2. Verifikation

### 2.1 Gemessen: Mapterhorn behebt die bekannte Schwäche

Matterhorn, Katalogwert 4478 m. Höchster DEM-Wert in Gipfelnähe, direkt aus
den Tiles dekodiert (Terrarium: `R*256 + G + B/256 − 32768`):

| Quelle     | Tile-Zoom | Pixelauflösung bei 46° | DEM-Gipfel |
|------------|-----------|------------------------|------------|
| AWS        | z11       | 53 m                   | 4341 m     |
| AWS        | z12       | 27 m                   | 4328 m     |
| AWS        | z13       | 13 m                   | 4334 m     |
| AWS        | z14       | 6,6 m                  | 4337 m     |
| Mapterhorn | z10       | 53 m                   | 4452 m     |
| Mapterhorn | z11       | 27 m                   | 4465 m     |
| Mapterhorn | z12       | 13 m                   | 4472 m     |
| Mapterhorn | z13       | 6,6 m                  | 4476 m     |
| Mapterhorn | z14       | 3,3 m                  | 4477 m     |
| Mapterhorn | z17       | 0,4 m                  | 4477 m     |

AWS bleibt bei jedem Zoom rund 140 m zu niedrig, weil die Quelle 30 m ist.
Mapterhorn liegt schon bei z12 innerhalb von 6 m am Katalogwert. Der im
peakviewer-README beschriebene Fehler („Matterhorn 4355 m, kein Zoom hilft“)
verschwindet mit dem Quellentausch.

### 2.2 Verifizierte Fakten zum Mapterhorn-Tileserver

- URL `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`, TileJSON unter
  `https://tiles.mapterhorn.com/tilejson.json` (`encoding: terrarium`,
  `tileSize: 512`, `scheme: xyz`, Bounds global).
- Standard-XYZ-Gitter, 512 × 512 px. Ein Mapterhorn-Tile bei Zoom z hat also
  die Pixelauflösung eines 256-px-Tiles bei z+1.
- WebP ist **verlustfrei** (VP8L-Chunk geprüft). Lossy wäre für Terrarium
  fatal gewesen.
- Zoom 0 bis 17 in der Schweiz vorhanden, z18 antwortet 404. Bei Zugspitze
  (DE/AT-Grenze) und Großglockner sind z14 und z16 vorhanden.
- `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=604800`,
  Cloudflare-CDN.
- Cloudflare blockt Nicht-Browser-User-Agents (Python-urllib bekam 403,
  Browser-UA bekommt 200). Für die App irrelevant, für Build-Skripte
  (Baking, Tests) muss ein Browser-ähnlicher User-Agent gesetzt werden.
- Tilegröße 150 bis 220 KB pro 512²-Tile, AWS 125 bis 145 KB pro 256²-Tile.
  Pro Pixel ist Mapterhorn also rund dreimal günstiger.
- Alpenquellen laut `download.mapterhorn.com/attribution.json` (151 Quellen):
  swissALTI3D 0,5 m (swisstopo, OGD), BEV ALS-DGM 1 m (AT, CC-BY-4.0) plus
  Landes-DGMs (Salzburg, Kärnten, OÖ), Bayern DGM1 (CC-BY-4.0), Südtirol DGM
  2,5 m (CC0), Aosta 2 m, Trentino 5 m, Lombardei/Piemont 5 m, TINITALY 10 m,
  IGN LiDAR HD 0,5 m und RGE ALTI 1 m (FR), Slowenien 1 m, Fallback
  Copernicus GLO-30.
- Attribution: Mapterhorn liefert einen `coverage-index.pmtiles` (1,5 MB,
  z4 bis z12), der pro Zelle die sichtbaren Quellen mit `producer_short`,
  `website` und `license` als JSON enthält. Das ist der vorgesehene Weg, die
  CC-BY-Pflicht pro sichtbarer Region zu erfüllen.
- PMTiles-Archive existieren (`planet.pmtiles` 355 GB, `6-33-22.pmtiles`
  615 GB für die Zentralalpen), taugen aber nur für Range-Requests, nicht für
  Offline-Downloads. Offline bleibt daher IndexedDB-Tile-Cache wie bei
  peakviewer.

### 2.3 peakviewer: Zustand und Eignung

Geprüft im Klon: `npm install`, `tsc --noEmit` (nur der erwartete Fehler wegen
der nicht generierten Demo-Region) und `tools/check_math.mjs` laufen durch.
Die Codebasis ist 6.000 Zeilen TypeScript, gut kommentiert und mit vier
GPU-freien Checks abgesichert (Shader-Uniforms, Geometrie-Referenz,
Skyline-Matching, Sensor-Fusion).

Was übernommen wird und tragfähig ist:

- `src/core/geodesy.ts`: Krümmung, Refraktion (k = 0,13), lokaler
  Erdradius, polarer Beobachterrahmen.
- `src/core/heightfield.ts` und `src/sources/clipmap.ts`: Clipmap aus
  konzentrischen Web-Mercator-Fenstern (640 px, z12 bis z7, ≈ 8,5 km bis
  272 km Reichweite), coarse-first-Streaming, IndexedDB-Cache.
- `src/render/gpu/`: Babylon.js (Core-Module), polares Mesh mit drei
  Schrittsegmenten, logarithmische Tiefe, WebGL2 und WebGPU aus einer Quelle.
- `src/core/horizon.ts` und `labels.ts`: Sichtbarkeit per DEM-Marsch,
  Label-Layout mit Kollisionsvermeidung.
- `src/core/align.ts`: Skyline-Extraktion aus dem Kamerabild (texturbasiert,
  nicht helligkeitsbasiert) und 2-Parameter-Matching (Yaw 0,05°, Pitch 0,5°).
- `src/core/pose.ts`: Gyro/Magnetometer-Fusion, WMM-2025-Deklination.

Was fehlt oder nicht passt:

- Kein Shading. Der Terrain-Pass schreibt nur die Distanz, der
  Composite-Pass macht daraus schwarze Linien über dem Kamerabild.
- Keine freie Kamera und keine Maussteuerung. Kamera sitzt immer im
  Beobachter, Yaw/Pitch kommen aus Sensoren oder Drag-Offsets.
- Shell ist Vanilla-DOM in einer 1.000-Zeilen-Datei (`src/app/app.ts`),
  Build ist esbuild, Deployment ist ein eingechecktes `docs/`.
- Alles ist auf 256-px-Tiles verdrahtet: `TILE = 256` in
  `src/sources/types.ts`, `TILE_SIZE = 256` in `geodesy.ts`, `256 * (1 << z)`
  in `heightfield.project` und `renderer.syncLevels`, Decoder liest fest
  `getImageData(0, 0, 256, 256)`.
- Projekt ist jung (0 Stars, ein Autor). Es wird als **vendored Engine**
  übernommen, nicht als Upstream, von dem Releases erwartet werden.

### 2.4 Verworfene Alternativen

| Alternative | Warum nicht als Basis |
|---|---|
| MapLibre GL + `raster-dem` (mapterrest-Stil) | Kartenzentrierte Kamera, Pitch bis ~85°, Terrain wird per Tile-Pyramide gecullt, kein 200-km-Horizont, keine Krümmung/Refraktion, keine Skyline. Gut als Standpunkt-Wähler, nicht als Panorama. |
| CesiumJS (map.geo.admin.ch-Stil) | Braucht quantized-mesh oder eigenen TerrainProvider für Terrarium, 3 bis 4 MB Bundle, keine Refraktion, AR/Skyline wäre komplett Eigenbau. |
| Three.js von Null | Würde Clipmap, Geodäsie, Horizonttest und Matching neu erfinden, die peakviewer getestet mitbringt. |
| AlpineMaps.org | C++/Qt/WASM, Datenpipeline nur Österreich, fremder Stack. |
| horizonator | C/OpenGL, SRTM, kein Web. |

Empfehlung: peakviewer-Kern als Engine, Mapterhorn als Daten, eigene
React-Shell. MapLibre höchstens später als 2D/3D-Karte zum Standpunkt wählen.

## 3. Zielarchitektur im Repo

    alpenrenderer/
      plaene/                  Pläne (diese Datei)
      src/engine/              aus peakviewer: core/, render/, sources/ (MIT-Header bleibt)
      src/app/                 React + Tailwind Shell, Vite-Build unter Bun
      tools/                   check_*.mjs aus peakviewer, angepasst
      .github/workflows/       Pages-Deploy aus dist/, kein eingechecktes docs/

Lizenz: peakviewer ist MIT. Der Copyright-Hinweis von Pascal Bayer bleibt in
`LICENSE` (Abschnitt „Third-party“) und in den übernommenen Dateien.
Babylon.js (Apache-2.0) und `geomagnetism` behalten ihre Notices, das
`gen_notices.mjs` von peakviewer erledigt das.

## 4. Mapterhorn-Umstellung (technisch)

Kernentscheidung: **Pixel-Zoom und Tile-Zoom trennen.** Die Clipmap, das
Heightfield und der Shader rechnen im Web-Mercator-Pixelgitter mit
`256 · 2^Z` Pixeln um die Erde. Das bleibt so, es ist die Koordinatendefinition
und nicht die Tilegröße. Ein Tile-Source bekommt eine `tileSize`, und ein
Level mit Pixel-Zoom Z holt bei `tileSize = 512` das Tile bei Tile-Zoom
`Z − 1`. So bleibt `BakedTileSource` (256) unverändert und der Shader auch.

Änderungen Datei für Datei:

1. `src/sources/types.ts`: `TILE`-Konstante entfernen. `TileSource` bekommt
   `readonly tileSize: 256 | 512`. `TileKey` bleibt, wird aber als Tile-Zoom
   interpretiert. Neue Hilfsfunktion `tileZoom(pixelZoom, tileSize)`.
2. `src/sources/mapterhorn.ts` (neu, aus `terrarium.ts` abgeleitet):
   URL `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`, `tileSize = 512`,
   `maxZoom = 17`, Decoder liest `bitmap.width/height` statt Konstante,
   `Blob`-Typ `image/webp`. Concurrency 6 beibehalten. `terrarium.ts` als
   Fallback-Source behalten (AWS ist außerhalb der Alpen ein legitimer
   Fallback, Mapterhorn deckt aber auch global ab, also optional).
3. `src/sources/clipmap.ts`: `setCenter`, `blit` und `planPreload` rechnen
   Tile-Indizes mit `source.tileSize` und Tile-Zoom `Z − log2(tileSize/256)`.
   `blit` nimmt die Tilebreite aus dem übergebenen Array (`heights.length`).
4. `src/sources/tilestore.ts`: Tile-ID um Quellen-Präfix erweitern
   (`mh/12/2135/1457`), damit AWS- und Mapterhorn-Bytes im selben IndexedDB
   nicht kollidieren. DB-Version auf 2, alte Einträge verwerfen.
5. `src/core/geodesy.ts`: `TILE_SIZE` in `MERC_PX = 256` umbenennen, mit
   Kommentar „Pixelgitter, nicht Tilegröße“.
6. `DEFAULT_CLIPMAP`: Pixel-Zoom 14 bis 7, also 8 Level (der Shader hat
   `uLvlA[8]`, passt genau). Bei 46,5° Breite: 6,6 m / 2,1 km Reichweite für
   das feinste Level bis 850 m / 272 km für das gröbste. Mapterhorn-Tile-Zoom
   dafür 13 bis 6. Kaltstart: 8 Level × 4 bis 9 Tiles ≈ 6 bis 12 MB. Als
   `QUALITY_LOW` 6 Level (13 bis 8) für Mobil.
7. `src/render/gpu/renderer.ts`, `radialParams`: `post = max(8, res)` nutzt
   das feinste Level als Schrittweite im mittleren Segment. Mit 6,6-m-Daten
   werden dadurch rund 325 der 600 Zeilen für die ersten 2,6 km verbraucht und
   das Fernfeld wird pro Zeile 1,7 % gröber. Entweder `rows` auf 800 bis 900
   oder `post` für die Schrittweite auf 13 m klemmen und das 6,6-m-Level nur
   fürs Sampling nutzen. Messen mit `check_math.mjs`, nicht raten.
8. `src/core/heightfield.ts`, `summitNear`: Suchradius von 120 m auf 60 m
   senken, weil der DEM-Gipfel jetzt nahe am Katalogpunkt liegt.
9. `src/core/attribution.ts`: AWS-Liste durch Mapterhorn ersetzen. Statisch
   „© Mapterhorn“ mit Link auf `mapterhorn.com/attribution`; dynamisch die
   sichtbaren Quellen aus `coverage-index.pmtiles` (Zelle z12 um den
   Standpunkt plus Ring, `pmtiles`-Paket, Range-Requests) mit
   `producer_short` und `website`. Beim Matterhorn ergibt das zum Beispiel
   swisstopo, SCT (Aosta) und INGV.
10. `tools/bake_dem.py` und `tools/check_*.mjs`: Tilegröße parametrisieren,
    Browser-User-Agent setzen, WebP-Dekodierung (Pillow kann WebP).

Akzeptanztest der Umstellung: `check_math.mjs` unverändert grün,
Matterhorn-DEM-Gipfel im Heightfield ≥ 4470 m, Kaltstart Gornergrat unter
15 MB, Level-Übergänge ohne Stufe in der Skyline (Screenshot-Vergleich mit
`tools/shots.mjs`).

## 5. Inkrement 0: Spike als Vorcheck (vor allem anderen)

**Status: bestanden (2026-09-20).** Der Spike läuft auf dem iPad, die Daten
rendern sauber, die Karten-Gesten funktionieren; Inkrement 1 wurde begonnen.

Bevor Engine, Shell und Umstellung angefasst werden, muss ein Wegwerf-Spike
drei Fragen auf dem echten Gerät beantworten. Erst wenn alle drei mit Ja
beantwortet sind, beginnt Inkrement 1. Sonst wird an dieser Stelle
nachgesteuert (andere Auflösung, anderes Rendering, andere Daten), solange es
noch billig ist.

Der Spike liegt in `spike/zugspitze/` (ein HTML-File, three.js vom CDN,
Details in `spike/zugspitze/README.md`) und wird über GitHub Pages
veröffentlicht, damit er auf iPad und Handy im Browser läuft. Er ist ein
Orbit-Viewer über einem 20-km-Fenster um einen Gipfel und bewusst nicht die
Panorama-Architektur aus Inkrement 1.

Die drei Fragen und ihre Kriterien:

1. **Werden die Daten sauber gerendert?** Grenzübergreifend an der
   Zugspitze (Bayern DGM1 gegen BEV ALS-DGM), am Watzmann (DE/AT) und am
   Matterhorn (swissALTI3D gegen Aosta-DTM). Kriterium: keine Stufen, Kanten
   oder Löcher an den Nähten, Gipfelhöhen innerhalb von 10 m der
   Katalogwerte. Headless bereits geprüft: Zugspitze 2957 m (2962),
   Großglockner 3795 m (3798), Matterhorn 4472 m (4478), Watzmann 2706 m
   (2713), keine Naht sichtbar. Auf dem Gerät gegenprüfen.
2. **Ist es performant auf dem iPad und Handy?** Kriterium: mindestens
   30 fps beim Drehen und Zoomen mit dem 768²-Gitter auf dem iPad und dem
   512²-Gitter auf dem Handy, Ladezeit unter 5 s bei WLAN, kein Absturz des
   WebGL-Kontexts beim Wechsel zwischen den Orten. Die fps stehen im
   Kopfbereich der Seite. Fällt das iPad unter 30 fps, ist die Gitterdichte
   der erste Hebel, danach die Pixelrate (`devicePixelRatio` auf 1,5 klemmen).
3. **Ist es schön steuerbar?** Karten-Schema: ein Finger verschiebt den
   Standort über das Gelände, zwei Finger zoomen (Pinch), drehen (seitlich)
   und kippen (hoch/runter). Kriterium: keine Sprünge beim Loslassen, der
   Drehpunkt bleibt auf dem Boden, der Blick geht nie unter das Gelände, und
   die Dämpfung fühlt sich wie in einer Karten-App an. Was hier an Gefühl
   und Parametern (Dämpfung, Geschwindigkeiten, Grenzen) gut ist, wird in
   Inkrement 1 übernommen.

Ergebnis des Vorchecks ist eine kurze Notiz unter „Ergebnis der Prüfung“ in
`spike/zugspitze/README.md` mit Gerät, Browser, fps und Befund. Der Spike
selbst wird danach nicht weiterentwickelt.

## 6. Inkrement 1: 3D-Panorama darstellen

**Status: umgesetzt (2026-09-20), Gerätetest offen.** Was steht:
Vite/React/Tailwind-Shell unter Bun, Engine aus peakviewer in `src/engine/`,
Mapterhorn-Umstellung mit Pixel-/Tile-Zoom-Trennung (`tools/check_clipmap.mjs`
prüft die 256/512-Abbildung), Shading-Pass in WGSL und GLSL (Normale aus dem
DEM pro Fragment, hypsometrische Tönung, Schnee nach Höhe und Neigung,
Luftperspektive, Himmelsgradient nach Blickwinkel, Umrisse zuschaltbar),
Look-Around-Steuerung mit Trägheit, URL-Hash, HUD mit Standpunkten, Quellen
aus dem Coverage-Index und Diagnostik, Pages-Deploy der gebauten App.
Headless in Chromium (WebGL2, SwiftShader) für Gornergrat und Zugspitze
gerendert: alle Pipelines kompilieren, 8 Level, 43 Tiles, 8 MB, keine
Frame-Fehler. Offen: Bildrate und Gestengefühl auf iPad und Handy, Feintuning
von Farben, Sonne und Mesh-Budget nach dem ersten Blick auf dem Gerät.

Ziel: Im Browser (Desktop und Mobil) ein schattiertes 3D-Panorama der Alpen
von einem Standpunkt aus, mit der Maus oder dem Finger umschauen, ohne
Sensoren, ohne Kamera, ohne Labels. Deployment auf GitHub Pages.

Bewusste Abgrenzung: Es ist ein **Panorama vom Standpunkt aus**
(PeakVisor-Modus), kein Freiflug. Die Clipmap und das polare Mesh sind um den
Beobachter zentriert. Bewegen des Standpunkts bedeutet `setCenter` und
Nachladen, was bei gecachten Tiles schnell ist, aber kein kontinuierliches
Fliegen erlaubt. Ein Freiflug wäre ein anderer Renderer.

Arbeitspakete:

1. **Repo-Setup.** Vite + React + Tailwind unter Bun, `src/engine/` aus
   peakviewer übernommen (nur `core/geodesy, heightfield, camera, labels,
   horizon, peaks`, `render/gpu/*`, `sources/*`), TypeScript strict,
   `tools/check_math.mjs` und `check_wgsl.mjs` als `bun run check`.
   GitHub-Actions-Workflow für Pages mit `base: '/alpenrenderer/'`.
2. **Mapterhorn-Umstellung** wie in Abschnitt 4.
3. **Shading-Pass.** Der Terrain-Vertex-Shader bekommt Normale und
   Weltposition als Varyings. Normale aus dem DEM-Gradienten (vier
   zusätzliche `sampleLevel`-Taps, ±1 Post in Ost und Nord, gleiche
   Level-Wahl wie die Höhe, damit der Level-Übergang nicht flackert).
   Fragment: Hillshade (Lambert mit Sonnenazimut/-höhe als Uniform),
   hypsometrische Tönung nach Höhe (Wiese, Fels, Schnee mit weichem Übergang
   um 2.800 m, Hangneigung entscheidet Fels vs. Schnee), Luftperspektive als
   Blende nach Distanz gegen eine Himmelsfarbe. Himmel als vertikaler
   Gradient im Composite-Pass. Der Distanzpuffer bleibt erhalten, die
   Umrisse werden ein Umschalter („Skizze“), nicht entfernt.
   Der Render-Target-Aufbau ändert sich: statt nur `rangeRtt` ein Farbziel
   plus Distanz (MRT oder zwei Passes; zwei Passes ist der sichere Weg für
   WebGL2 auf Mobil).
4. **Kamerasteuerung.** `Camera` (yaw, pitch, fov) unverändert nutzen. Maus-
   und Touch-Drag drehen Yaw/Pitch, Rad und Pinch ändern das FOV (10° bis
   90°), Tastatur-Pfeile. Trägheit ist optional. Alles im ENU-Rahmen, keine
   Änderung im Renderer.
5. **Standpunkt festverdrahtet** über URL-Hash
   `#lon=7.7847&lat=45.9835&alt=3135&yaw=225&pitch=0&fov=60` mit Gornergrat
   als Default. Augenhöhe = DEM-Boden + 1,6 m, wenn `alt` fehlt.
6. **Shell.** Ein Vollbild-Canvas, ein schmaler Balken mit Standpunktname,
   Kompassrichtung, Lade-Fortschritt (aus `FillProgress`), Credits-Panel mit
   den sichtbaren Quellen. Diagnostik (Backend, Frames, Tiles) hinter einem
   Schalter, das ist bei WebGPU/WebGL2 unverzichtbar.
7. **Qualität.** WebGL2 Default wie im Original, WebGPU per `?backend=webgpu`.
   `QUALITY_LOW` auf Mobil per `devicePixelRatio` und `hardwareConcurrency`.

Fertig, wenn: Gornergrat-Panorama zeigt Matterhorn, Monte Rosa und Dom
schattiert mit korrekter Silhouette bis 200 km, 30 fps auf einem
Mittelklasse-Handy, Kaltstart unter 10 s bei 20 Mbit/s, Attribution zeigt
swisstopo.

## 7. Inkrement 2: Eigene Position und Sichtachse festlegen

**Status 2a, Position: umgesetzt (2026-09-20), test-first.** Standpunkt per
OpenStreetMap-Karte (Leaflet, Tippen plus „Panorama von hier“, Blick bleibt)
und per GPS („Mein Standort“ mit Genauigkeit im HUD). E2E-Tests routen die
OSM-Kacheln auf ein festes PNG und emulieren GPS bzw. dessen Verweigerung;
`locateDevice` hat einen Watchdog, weil der Browser-Timeout erst nach
erteilter Berechtigung läuft. Offen in 2a: Ortssuche, Standpunkt-Verlauf,
„Standpunkt anheben“.

**Status 2b, Sichtachse per Sensoren: umgesetzt (2026-09-20), test-first.**
„Sensoren“ im HUD folgt dem Gerät: `PoseTracker` aus peakviewer (Kompass plus
Gyro, One-Euro-Filter, WMM-Deklination, iOS-Berechtigungsfluss) treibt die
Kamera einmal pro Frame über das neue Modell `src/app/sensorLook.ts`. Ein
Finger korrigiert in diesem Modus den Kompass statt die Kamera zu drehen
(`GestureModel.turnHandler`); die Korrektur steht im HUD, an der Kompassrose
und im `localStorage`, überlebt also einen Reload. „Sensoren aus“ lässt den
Blick stehen. Tests: `tests/unit/pose.test.ts` charakterisiert die Fusion
(Port von `check_pose`, dabei zwei Befunde behoben: `declinationAt` gab bei
ungültigen Koordinaten NaN, und Androids magnetische `absolute`-Richtung
bekam keine Deklination), `tests/unit/sensorLook.test.ts` das Modell,
`tests/e2e/sensors.spec.ts` speist synthetische
`deviceorientationabsolute`-Events ein und prüft, dass das Testhorn auf der
berechneten Bildzeile landet, die Korrektur gegen den Kompass besteht und
eine Verweigerung gemeldet wird. Befund aus CI: Chrome 153 gewährt die
Sensoren wie iOS erst nach `requestPermission` und antwortet headless mit
`prompt`; die Engine wertete das als Verweigerung. Jetzt zählt nur ein
explizites `denied` als Nein, und ein fehlschlagender Motion-Aufruf entwertet
die Orientierungs-Erlaubnis nicht mehr (beides per Unit-Test rot → grün); die
E2E-Sensortests injizieren die Erlaubnis wie der Verweigerungstest die
Ablehnung. Rolle wird bewusst noch nicht angewandt;
sie kommt mit dem Kamerabild in Inkrement 3. Offen: Eingabe von Azimut und
Neigung, „Richtung Gipfel X“.

Ziel: Der Nutzer bestimmt, wo er steht und wohin er schaut, auf Desktop
manuell, auf Mobil per Sensoren.

Arbeitspakete:

1. **Position.**
   - GPS über `navigator.geolocation` (peakviewer `locate()` übernehmen),
     Höhe aus dem DEM statt aus dem GPS, mit Anzeige beider Werte.
   - Manuelle Eingabe: Koordinatenfeld, Ortssuche (Nominatim mit
     User-Agent und Debounce, oder eine kleine gebundelte Liste von
     Aussichtspunkten und Gipfeln aus OSM), Klick in eine 2D-Karte
     (MapLibre mit OpenFreeMap-Vektorkacheln und Mapterhorn-Hillshade, das
     ist die Stelle, an der der mapterrest-Ansatz sinnvoll ist).
   - Standpunkt-Verlauf im `localStorage`, teilbare URL wie in Inkrement 1.
   - Zusätzlich „Standpunkt anheben“ (Höhe über Grund einstellbar), weil
     ein Panorama von 200 m über dem Gipfel oft aussagekräftiger ist.
2. **Sichtachse.**
   - Desktop: Drag wie in Inkrement 1, plus Eingabe von Azimut und
     Neigung, plus „Richtung Gipfel X“ (Peilung aus `geodesy.bearing`).
   - Mobil: `PoseTracker` aus peakviewer (`core/pose.ts`) inklusive
     One-Euro-Filter, Gyro/Magnetometer-Fusion, WMM-Deklination und
     iOS-Berechtigungsfluss (`app/permissions.ts`). Der Sensor-Check
     `tools/check_pose.mjs` kommt mit.
   - Manueller Offset (Drag korrigiert die Sensorrichtung, persistiert),
     weil der Kompass in den Alpen 10 bis 40° falsch liegen kann.
   - Kompassrose (`ui/compass.ts`) mit angezeigtem Offset.
3. **Clipmap-Recentering** bei Positionswechsel testen: Wechsel Gornergrat →
   Zugspitze muss ohne Absturz und ohne stehengebliebene alte Höhen laufen
   (Generation-Counter in `ClipmapStreamer` ist dafür da).
4. **Offline-Vorbereitung** (optional in diesem Inkrement): Region
   herunterladen (`planPreload`, 150 km) in IndexedDB, Service Worker für
   die Shell.

Fertig, wenn: Auf dem Handy am Fenster dreht sich das Panorama mit dem Gerät,
auf dem Desktop lässt sich jeder Standpunkt in den Alpen per Karte oder Suche
setzen und die URL reproduziert die Ansicht.

## 8. Inkrement 3: Berge aus Position und Bild identifizieren und labeln

Ziel: Aus einer Position und einem Bild (Live-Kamera oder hochgeladenes Foto)
die Gipfel bestimmen und beschriften.

**Status 3a, Katalog und Labels: umgesetzt (2026-09-20), test-first.** Der
Katalog ist statisch: `tools/build_peaks.mjs` holt alle benannten
`natural=peak`-Knoten der Alpen (5–17°E, 43–49°N) per Overpass und schreibt
sie als 1°×1°-Zellen nach `public/peaks/{x}_{y}.json` (kompakte Datensätze:
OSM-Id, Name, Lon, Lat, Höhe, Prominenz, Wikidata, Wikipedia). Die App lädt
über `PeakCatalog` die Zellen im Umkreis von 260 km, `?peaks=` zeigt auf einen
anderen Katalog (die E2E-Tests auf den synthetischen). Labels laufen über
peakviewers `buildTargets` (Anker auf `summitNear`), `computeVisibility`
(DEM-Marsch mit Krümmung und Refraktion) und `layoutLabels`, gezeichnet vom
`LabelPainter` auf einem Overlay-Canvas; ein Tap (neu im Gestenmodell) öffnet
die Gipfelkarte mit Höhe, Entfernung, Peilung, Wikipedia und Wikidata. Tests:
`tests/unit/peakcatalog.test.ts` (Zellenwahl, Parsen, Cache, Fehler),
`tests/unit/labels.test.ts` (Charakterisierung: Anker, Rang, Sichtbarkeit an
einem Grat, Layout ohne Überlappung, Auswahl), Tap im Gestenmodell,
`tests/e2e/labels.spec.ts` (Testhorn-Label auf der berechneten Zeile,
Hinterhorn dahinter ohne Label, Gratspitze nach Norden mit Krümmung,
Gipfelkarte, Schalter). Offen: Overpass zur Laufzeit als Fallback, Prominenz
für Gipfel ohne Tag, Label-Dichte auf dem Handy.

**Status 3b, Live-Kamera: umgesetzt (2026-09-20), test-first.** „Kamera“
öffnet die Rückkamera (`CameraFeed`, Port aus peakviewer), der Renderer
schaltet auf den AR-Pfad (Kamerabild entsättigt und weiß gewaschen, Grate als
Tinte darüber, Labels auf dem Overlay). Das Sichtfeld ist das des Objektivs,
cover-gecroppt in die Canvas (`coverFovY`), mit Regler „Objektiv“ zur
Handkorrektur, weil kein Browser das Objektiv-FOV meldet. „Foto“ rendert das
Composite samt Labels und Quellenzeile in ein PNG und geht über die
Share-API in die Fotos-App, sonst als Download. Tests: `tests/unit/camera.test.ts`
(Cover-Crop-Mathematik, Dateiname), `tests/e2e/camera.spec.ts` mit Chromiums
Fake-Kamera aus einer festen Y4M-Datei (oben helles, unten dunkles Grau):
gewaschene Grauwerte im Composite, Grat-Tinte auf der berechneten Zeile,
FOV aus dem Objektiv, Regler, PNG-Download mit Maßen, Verweigerung. Offen:
Pinch als Objektiv-Korrektur, Zoom-Objektive, Zeitstempel im Foto.

**Status 3c, Foto-Modus: umgesetzt (2026-09-20), test-first.** „Foto laden“
liest das EXIF selbst (`src/app/exif.ts`, JPEG-APP1 und PNG-eXIf, ohne
Abhängigkeit): GPS setzt den Standpunkt, Brennweite bzw. 35-mm-Äquivalent
das Sichtfeld (`fovFromExif`, Hoch- und Querformat). Das Bild liegt als
Standbild im Composite (`attachStill`, derselbe AR-Pfad wie die Kamera).
„Ausrichten“ extrahiert die Skyline des Fotos (`extractSkyline`, für Fotos
mit 288 px Arbeitsbild, weil 192 px die Rolle nicht mehr festlegen),
rechnet das Horizontprofil aus dem DEM und sucht gestuft (`alignPhoto`):
Richtung und Neigung, dann Rolle, bei unbekanntem Objektiv das Sichtfeld
und die Rolle erneut, dann Richtung und Neigung nochmals für die Konfidenz.
Angewandt wird nur ein vertrauter Treffer; sonst steht der Grund da, und der
Finger bleibt die Instanz. Tests: `tests/unit/align.test.ts`
(Charakterisierung als Port von `check_align`, dazu neu: Rolle und
Sichtfeld als Suchparameter in `matchSkyline`, `alignPhoto`),
`tests/unit/exif.test.ts` (handgebautes TIFF in JPEG und PNG),
`tests/e2e/photo.spec.ts` (Fixture-Foto aus der Geländeformel mit eXIf:
Standpunkt und Objektiv aus EXIF, Ausrichtung findet 94°/2° aus 90°/0°,
Testhorn-Label auf der Foto-Spalte; Nebelfoto ohne EXIF wird abgelehnt).
PNG-Export mit Labels gibt es über „Speichern“.

**Stand Arbeitspaket 7, erster Durchgang (2026-09-21):** zwei echte Fotos
(OnePlus Open), headless mit Chrome 153 gegen Mapterhorn-Tiles und den
OSM-Katalog, beide ohne brauchbares GPS, Standpunkt daher von Hand gesetzt.
Ferchensee: Schwenk-Panorama 4384×2064, keine Brennweite im EXIF.
Hoher Kasten: Hochformat 1800×4000, 47 mm KB, Grand-Tour-Rahmen mit Person
davor. Befunde:

1. *EXIF ohne Fix.* Das Telefon schreibt einen vollständigen GPS-Block mit
   lauter 0/0-Rationalen; der Leser machte daraus Breite 0, Länge 0, die
   App hätte auf Null Island verschoben. Behoben, Unit-Test
   `a GPS block of 0/0 rationals gives no position`.
2. *Skyline-Extraktor ohne Himmelsmodell.* Der texturbasierte Kürzeste-Pfad
   nimmt am Ferchensee rechts ein Cirrus-Band und die nahe Baumkante als
   Horizont (dort die höchste Spaltenstärke 0,4 bis 0,5), den echten Grat
   der Wettersteinspitze nicht. Ergebnis „Ausgerichtet: Fit 62 %,
   Konfidenz 28 %“ mit 14° falschem Kurs (242° statt etwa 256°), von zwei
   Startkursen (235°, 255°) aus identisch. Von Hand auf 256°/+4° gelegt,
   liegt der Grat Wettersteinspitze–Waxensteine auf der Felskante im Foto:
   Gelände und Katalog stimmen, der Extraktor nicht.
3. *Panorama.* Zylindrische Projektion, Bildverhältnis 2,1:1; das
   Lochkamera-Modell passt nur in der Bildmitte. Die Objektivsuche fand 47°
   vertikal, was für die Mitte plausibel ist.
4. *Hoher Kasten.* Die Ausrichtung lehnt korrekt ab („16 % Konfidenz“):
   Rahmen und Person verdecken die Horizontlinie. Die Kamera blickt etwa 8°
   nach unten, mehr als die Neigungssuche (±7°) erlaubt. Von Hand auf
   245°/−8° liegt der Grat auf der Kette Altmann–Säntis.
5. *Umrisse im Nahfeld.* Die Second-Difference-Kanten zeichnen auf Wiese
   und Kies Linien aus DEM-Rippeln von ein bis zwei Metern; als Grate über
   einem Foto sind sie irreführend.
6. *Hochformat.* HUD und Foto-Panel decken das obere Drittel ab, genau wo
   Skyline und Labels sitzen.

**Zweiter Durchgang (2026-09-21, sieben Fotos Berner Oberland und Bern,
alle OnePlus Open, alle ohne GPS-Fix, Standpunkte von Hand):** Schreckhorn
im Hochformat (47 mm), Bachalp-Wiese (24 mm, 20:9), Bachalpsee (14 mm, 20:9),
First mit Eiger (24 mm, 20:9), Bern mit Bundeshaus (70 mm, 20:9), dazu zwei
Bilder vom Schynige-Platte-Kamm, deren Standpunkt ich nicht sicher
verorten konnte (nicht gewertet). Befunde:

7. *35-mm-Äquivalent falsch gelesen.* Die Kurzseiten-Regel (24 mm) machte
   aus dem 20:9-Panorama bei 24 mm ein Sichtfeld von 53° vertikal; das
   Telefon schneidet sein 4:3-Sensorbild aber oben und unten ab und
   behält die Breite, real sind es etwa 36°. Behoben: die Langseite ist
   die 36 mm, die Kurzseite folgt aus dem Seitenverhältnis (20:9 → 37,3°,
   4:3 → 54,8°, 3:2 unverändert). Handläufe am First (Eiger, Jungfrau,
   Ostegg auf den Fotogipfeln) und an der Bachalp-Wiese bestätigen die
   Skala. Unit-Test in `exif.test.ts`, Fixture-Foto auf 54,8°.
8. *Objektiv-Regler.* Begann bei 25°, das 70-mm-Bild aus Bern sieht 13°;
   Minimum jetzt 8°, E2E-Schritt in `photo.spec.ts`.
9. *Automatische Ausrichtung, fünf verortete Fotos:* ein Treffer
   (Bachalpsee, 14 mm: Fit 51 %, Konfidenz 27 %, Schreckhorn-Label auf der
   Fotospitze, Neigung −9° gefunden), vier korrekt abgelehnte (1 bis 12 %
   Konfidenz: Hochformat mit 14° Aufblick, Wiese mit Wolkenband, Eiger mit
   Dunst, Bern mit Dächern vor Bergen in 70 km). Im ersten Durchgang dazu
   ein falscher Treffer am Schynige-Platte-Weg (Fit 72 %, Konfidenz 21 %,
   Kurs um 29° verdreht, Cumulus-Kante als Horizont). Muster: sauberer
   blauer Himmel und eine lange Horizontlinie gelingen, alles andere
   scheitert am Extraktor, und die Konfidenzschwelle von 18 % lässt
   Wolkenkanten durch.
10. *Handplatzierung* mit der App-eigenen Objektivregel trifft bei allen
    fünf verorteten Fotos die Gipfel horizontal; vertikal fehlt meist die
    Neigung (Schreckhorn-Hochformat +14°, Bern und First −5°), die der
    Finger liefert.

Daraus die nächsten Schritte, jeder test-first: (a) Himmelsmodell im
Extraktor (Blau und Wolkenweiß von oben her als Himmel, Baumkanten und
Nahfeld abgewertet) mit einer Fixture, die Wolkenband und Baumkante enthält;
(b) Umrisse unter etwa 300 m Entfernung oder auf flachem Gelände ausblenden;
(c) Neigungssuche auf ±15°, weil Hochformate von Gipfeln 14° aufblicken;
(d) Panels im Hochformat unten oder einklappbar (2026-09-27 teilweise
erledigt: Icon-Leiste links, Panels daneben und scrollend, ganzes Menü
ausblendbar, E2E `layout.spec.ts` im Querformat 844×390); (e) Konfidenzschwelle
für Fotos anheben oder Treffer unter 30 % nur als Vorschlag zeigen. Die Regressionsmenge aus zehn Fotos mit bekanntem Standpunkt
bleibt offen; beide Bilder hier haben keinen.

Arbeitspakete:

1. **Gipfelkatalog.** `natural=peak` mit Namen aus OSM. Zwei Wege, beide
   vorsehen: Overpass zur Laufzeit (peakviewer `sources/overpass.ts`, mit
   Zellen-Cache und Rate-Limit-Handling) und ein zur Build-Zeit erzeugter
   Alpen-Katalog als JSON (Bounding Box 5°E bis 17°E, 43°N bis 49°N, per
   Overpass oder Geofabrik-Extrakt, ODbL-Hinweis). Der statische Katalog
   macht GitHub Pages unabhängig von Overpass-Ausfällen. Felder: Name
   (mehrsprachig), Höhe, Prominenz falls getaggt, Wikidata-ID.
2. **Labels im Panorama** (bereits in peakviewer): `buildTargets`,
   `computeVisibility` (DEM-Marsch mit Krümmung und Refraktion),
   `layoutLabels`, `LabelPainter`. Anker auf `summitNear` setzen. Mit
   Mapterhorn schrumpft der Abstand Katalog/DEM auf wenige Meter, die
   Toleranz im Horizonttest (`tolerance: 0.05°`) kann bleiben. Label-Karte
   mit Höhe, Distanz, Peilung, Wikipedia-Link. Das ist unabhängig vom Bild
   und kann bei Bedarf schon in Inkrement 1 oder 2 vorgezogen werden.
3. **Live-Kamera-Modus** (peakviewer-Kern): `CameraFeed`, Composite-Pass
   mit Video-Textur, Umrissmodus über dem Bild, Labels darüber, Foto
   speichern (`capture.ts`, Web Share API). FOV aus
   `MediaTrackSettings`/`getCapabilities` oder kalibriert.
4. **Foto-Modus** (neu): Bild hochladen, EXIF lesen (GPS für Position,
   `FocalLength` und `FocalLengthIn35mmFilm` für das FOV, Aufnahmezeit).
   Fehlt GPS, Position wie in Inkrement 2 setzen.
5. **Ausrichtung per Skyline-Matching** (`core/align.ts`):
   `extractSkyline` (texturbasiert, findet die oberste Sky/Land-Kante),
   `horizonProfile` aus dem DEM, `matchSkyline` liefert Yaw und Pitch mit
   Konfidenz und verweigert bei schlechtem Fit. Erweiterungen für Fotos:
   - Roll als dritter Parameter (Handyfotos sind selten waagerecht), am
     einfachsten durch Pre-Rotation des Bildes in Stufen und Wiederholung
     des 2-Parameter-Fits.
   - FOV als vierter Parameter, wenn kein EXIF vorliegt: grobe Suche über
     30° bis 80°, dann Feinfit.
   - Nutzer-Korrektur durch Drag bleibt der Fallback, wie in peakviewer.
   `tools/check_align.mjs` erweitern (synthetische Welt mit Roll und
   falschem FOV).
6. **Label-Projektion ins Bild.** Mit gefundener Pose die sichtbaren Gipfel
   über `Camera.project` ins Bild legen, Layout wie im Panorama, Export als
   PNG mit Credit-Zeile.
7. **Stresstest mit echten Fotos.** Zehn Fotos mit bekanntem Standpunkt
   (Gornergrat, Zugspitze, Schilthorn, Wank, Kitzsteinhorn) als
   Regressionsmenge, erwartete Yaw/Pitch dokumentiert.

Fertig, wenn: Ein Handyfoto vom Gornergrat mit EXIF-GPS ergibt ohne manuelle
Korrektur ein Overlay, bei dem Matterhorn, Dent Blanche und Weisshorn richtig
beschriftet sind, und der Live-Modus auf iOS und Android läuft.

### 8.x Seen (2026-09-28)

Zur Orientierung liegen benannte Seen aus OpenStreetMap blau auf dem
Gelände und tragen ihren Namen. Umsetzung:

- Katalog `public/lakes/{x}_{y}.json` wie bei den Gipfeln, gebaut von
  `tools/build_lakes.mjs` (Overpass, `natural=water` mit Namen, ohne
  Flüsse, Kanäle und Becken, ab 1 ha; Ringe aus Multipolygon-Stücken,
  Douglas-Peucker 5–25 m, Label-Punkt auf offenem Wasser, jeder See in der
  Zelle seines Label-Punkts).
- Wassermaske pro Clipmap-Level auf dem DEM-Raster (even-odd, Inseln
  trocken), im freien B-Kanal des Höhenatlas; der Shade-Pass mischt dort
  die Wasserfarbe unter dasselbe Licht und denselben Dunst.
- Seen-Labels ankern auf der Wasseroberfläche; große Seen haben bis zu acht
  Ersatzpunkte, damit ein halb verdeckter See (Walchensee vom Herzogstand)
  dort benannt wird, wo er zu sehen ist.
- Glanz (2026-09-28): Fresnel-Anteil Himmel (Schlick, f0 0,02, gedeckelt
  bei 0,6) und weicher Sonnenglanz (Phong 60, Stärke 0,35) im Shade-Pass,
  nur wo Wasser ist; keine Spiegelung des Geländes, weil die einen zweiten
  Pass bräuchte, zu teuer für 200-Euro-Handys.
- Offen: Flüsse als Linien, ein eigener Schalter für Seen-Labels.

### 8.y Label-Anker: Herleitung und Fehlerbudget (2026-09-29)

Ziel: Die Spitze einer Gipfel-Nadel liegt auf der **gezeichneten** Oberfläche,
an der sichtbaren Oberkante des Bergs, den der Name meint. Zwischen dem Namen
und dem Pixel liegen drei Raster aus zwei Quellen:

1. **Katalog (OSM):** Punkt und Höhe von Hand erfasst.
2. **Höhenmodell (Mapterhorn):** je Clipmap-Level ein Raster, 7–13 m in der
   Nähe, 52–105 m in 11–23 km, bis 417 m außen; die groben Level sind die
   Übersichtskacheln des Anbieters, Gipfel dort schon abgerundet. Beim
   Einlesen auf ganze Meter gerundet.
3. **Netz (Renderer):** Ringe in 1–2 % der Entfernung, Strahlen alle
   0,18° (Handy 0,35°); jede Zelle zwei ebene Dreiecke (Diagonale von
   Ecke (i+1, j) nach (i, j+1)), Höhe der Ecken bilinear aus dem Level für
   ihre Entfernung. Die gezeichnete Fläche ist stückweise eben; ihre hohen
   Punkte sind Netzpunkte.

Gemessen (Schynige Platte, Blick N, 22 Gipfel in 0,8–23 km):

| Stufe | Größe |
|---|---|
| OSM-Punkt → nächstes Maximum im DEM | 1–110 m seitlich; OSM-Höhe 10–67 m über dem DEM-Maximum; 4 Punkte ohne Maximum in 140 m (Schultern) |
| DEM-Level in 11–23 km | Postenabstand 52–105 m, gleiches Level wie gezeichnet |
| Netz gegenüber DEM-Maximum | 0–60 m tiefer, bis eine Zelle (130–330 m × 35–145 m) daneben |
| Rundung (ganze Meter, float32) | ±0,5 m bzw. mm: in 15 km 0,002°, bei 11° Zoom 0,1 px |

Rundung spielt also keine Rolle; die Abweichungen entstehen durch die Raster.

Herleitung, zwei Schritte mit je einer Definition:

1. **Welcher Gipfel?** Das nächste *regionale Maximum* des DEM im
   Toleranzkreis (140 m, deckt die gemessenen 1–110 m) um den OSM-Punkt:
   eine zusammenhängende Fläche gleicher Höhe, deren Nachbarn alle niedriger
   sind (wegen der ganzen Meter haben breite Gipfel mehrere gleich hohe
   Posten; eine Ebene neben etwas Höherem ist keines). Liegt der OSM-Punkt im
   Gipfelposten, bleibt er (er ist dann genauer als das Raster); sonst die
   Mitte des nächsten Gipfelpostens. Ohne Maximum in Reichweite ist der Punkt
   eine Schulter dieses DEM und bleibt, wo er ist.
2. **Wo ist er gezeichnet?** In der Netzzelle, die den Gipfel enthält; ihre
   sichtbare Oberkante ist die Ecke mit dem größten Höhenwinkel vom Auge
   (eine höhere, aber weiter hinten liegende Ecke ist von der vorderen
   verdeckt). Die Nadel geht genau auf diesen Netzpunkt, Lage und Höhe: ihre
   Spitze liegt dann auf der gezeichneten Fläche, höchstens eine Zelle vom
   Gipfel.

Nicht mehr verwendet, weil nicht aus einer Definition folgend: Höhe des
Maximums an der Lage des OSM-Punkts (Nadel neben dem Gipfel in der Luft),
unbegrenzte Suche nach dem steilsten Netzpunkt (läuft bei kleinen Gipfeln
0,5–1,3 km auf andere Berge), Klemme „nie über dem DEM-Gipfel“ (widerspricht
„auf der gezeichneten Fläche“).

Darstellung: Der Anker bleibt exakt auf der gezeichneten Fläche, aber die
Hinweislinie endet `LEADER_GAP` = 6 px darüber (`labelPainter.ts`,
`leaderLine`). Eine Linie bis auf den Anker steckt im Berg und verdeckt die
Spitze; 6 px darüber zeigt sie auf den Gipfel. Der Abstand ist ein
Bildschirmmaß und damit bei jedem Zoom und jeder Entfernung gleich – anders
als das frühere zufällige Schweben über dem DEM-Gipfel, das beim Zoomen auf
Dutzende Pixel wuchs.

### 8.z Achensee-Befund: Auge, Start, Labels, Relief (2026-10-18)

Am Achensee war die App in fünf Punkten nicht brauchbar: markante Spitzen
ohne Label, Perspektive passt nicht zum Standpunkt, Relief zu grob, Start
nicht am Standort, Auge fliegt über dem Boden. Vor den Änderungen eine
Recherche, wie andere es machen (Kurzfassung; Details im Sitzungsplan):

| Frage | Andere | Wir vorher |
|---|---|---|
| Augenhöhe | HeyWhatsThat 1,8 m, udeuschle 10 m, PeakFinder DEM + Offset; „höchster Punkt im Umkreis“ überall nur Option (30–200 m) | 1,7 m über dem höchsten Punkt in **1 km** (Schynige Platte +128 m, Seeufer Hunderte Meter) |
| Welche Gipfel | Prominenz als Rang (PeakVisor, Raposo 2013), Isolation + Zoom-Radius (OpenTopoMap), Label-Grid (Mapbox), Zoom = mehr Labels (PeakFinder) | Entfernung, 22 Plätze; OSM-Prominenz im Katalog ungenutzt |
| Sichtbarkeit | Tiefenpuffer des gezeichneten Geländes (Mapbox `text-occlusion-opacity`, MapLibre, PeakLens, MassifMaps PR 375); Anker auf der gezeichneten Höhe (MassifMaps PR 372, wie §8.y) | DEM-Strahl zum DEM-Punkt, Nadel erst danach auf das Netz |
| Gelände | Quadtree + Bildschirmfehler ≤ 2 px (Cesium, MapLibre, Google Earth, wohl PeakVisor mit 30 m); GPU-Raycasting pixelgenau, aber 2009-Desktop-GPU für 30 fps (Dick et al.) | Polarnetz, feste 0,18°/0,35° pro Spalte, Ringe 1,1–1,4 % der Entfernung: 2–4× gröber als die Daten, beim Zoomen 14–29 px pro Spalte |

Maßnahmen in dieser Reihenfolge: C1 Auge auf den Boden, C2 Start am
Standort, C3 Labels (Test am gezeichneten Punkt, Prominenz offline aus
Mapterhorn z9, Rang = Prominenz/Entfernung, Bildschirmraster statt 22),
C4 Relief (Polarnetz als Keil über den Blickkegel, Fernrohr-Fenster beim
Zoomen, blickrelatives Licht, Konturen), C5 Kamera (Roll, FOV nach
Orientierung).

**C1 (erledigt):** Auge = DEM-Boden am Standpunkt + Augenhöhe, Default
1,7 m, Regler logarithmisch 1,7–500 m (`EYE_HEIGHT`, `eyeHeightFromSlider`
in `state.ts`). Der Umkreis-Regler „Höhenbereich“ ist weg: der Boden ist
bilinear abgetastet wie das Netz, das Auge steckt also nie im Gelände, und
ein Hang, der 1,7 m bergauf auf Augenhöhe steigt, ist physikalisch richtig.
Tests: `state.test.ts` „1.7 m by default…“, „the slider is logarithmic…“;
`app.spec.ts` „the eye stands 1.7 m above the ground under it“, „on the
Testhorn's flank the eye stands 1.7 m over the slope“, „the eye height is a
logarithmic slider“ (rot gegen den alten Stand: Auge +9 m bzw. +1000 m).

**C2 (erledigt):** Ohne Standpunkt in der URL startet die App am
Gerätestandort (`startView` in `state.ts`: Hash gewinnt, sonst letzter
Standpunkt aus `localStorage`, sonst Gornergrat; dazu `locateChecked` mit
den bestehenden Prüfungen und der Hilfebox). Jede Ansicht wird als letzter
Standpunkt gemerkt (`writeLastView`). Tests: `state.test.ts` „where the app
starts“; `map.spec.ts` „the app starts at the device position when the URL
names none“, „a standpoint in the URL is kept and the device is not asked“,
„refused, the last standpoint stands and the help shows“.

**Messung Pertisau (11,70° O, 47,44° N, Auge 939 m = Boden + 1,7 m), vor C3:**
Anker treffen das Maximum im 140-m-Umkreis auf 1–5 m (Versatz 1–74 m);
der befürchtete Mikro-Buckel-Fehler (Anker auf einem Nebenmaximum hinter
dem Gipfel) tritt nicht auf. Verdeckte Gipfel sind durch Gelände bei 26–82 %
der Entfernung verdeckt, also durch vorgelagerte Rücken, nicht durch den
eigenen Gipfel – vom Westufer stehen Hochiss, Rofanspitze, Seekarlspitze
hinter dem Dalfazer Rand (Marsch-Maximum 16,3° in 2,6 km gegen 14,3°
Anker), Seebergspitze und Seekarspitze hinter ihrem eigenen Südostfuß. Das
ist geometrisch plausibel; was das Bild davon abweichend zeigt, liegt am
Netz (Rücken 0–60 m zu tief gezeichnet, §8.y) und ist C4a, nicht C3a. Von
den 12 platzierten Labels nach Osten sind alle sichtbaren im Bild gesetzt;
die Auswahl nach Entfernung (22 Plätze) ist der verbleibende Hebel → C3c.
Zweiter Standpunkt am Rofan-Fuß (11,745° O, 47,43° N, 974 m): dasselbe
Bild – alles nach Osten steht hinter dem unmittelbaren Hang (Marsch-Maximum
25–30° in 0,9–1,8 km), nach Westen sind Bärenkopf, Dristenkopf,
Seebergspitze, Falzthurnjoch, Bettlerkarspitze sichtbar und gesetzt. Einziger
Fall „eigener Berg“ (Marsch-Maximum bei 95 % der Entfernung): Hinterunnütz
von Achenkirch, 2,5 km, 1100 m tiefer – die Kuppe verdeckt den Gipfel um
0,4°, die Schulter davor ist weniger steil als die Sichtlinie; mit
13-m-Posten ist das Gelände, nicht das Raster.

**C3 (erledigt):** Rang eines Labels = scheinbare Prominenz
atan(Schartenhöhe/Entfernung) (Seen: Breite/Entfernung), Bildschirmraster
aus Zellen von einer Labelbreite × zwei Zeilen statt 22 Plätzen nach
Entfernung; Hineinzoomen gibt mehr Zellen frei. Die Schartenhöhe kommt aus
`tools/build_prominence.mjs` (Mapterhorn z9 und z10, Katalog-Höhen in die
Zellen gebrannt, 81 312 von 86 794 Gipfeln). Der DEM-Marsch bleibt der
Sichtbarkeitstest; die Messungen an drei Achensee-Standpunkten zeigten ihn
konsistent. Tests: `labels.test.ts` „orders by apparent prominence…“, „one
label per screen cell…“; `prominence.test.ts`.

**C4a (erledigt):** Das Polarnetz wird ein Keil über den Blickkegel
(`wedge` in mesh.ts: Spalten über `camera.azimuthArc`, erste Spalte auf das
Spaltenraster gerastet, Uniform `uAz0`), die Ringe laufen ab dem Nahfeld mit
konstantem Faktor 1/190 (hoch, 1024 × 1600) bzw. 1/120 (niedrig, 640 × 900)
bis zur letzten Ebene – in der Größenordnung der DEM-Posten (1/318–1/159),
statt 1,1–1,4 %. Damit ist eine Spalte bei jedem Bildwinkel etwa ein Pixel
breit und ein Grat liegt dort, wo das DEM ihn hat. Die Label-Nadel wird neu
auf das Netz gesetzt, wenn sich Keil oder Schritt ändern (`drawnKey`).
Sektor-Culling entfällt, alle Vertizes sind im Bild. Tests: `mesh.test.ts`
„beyond the near field the rings are a constant fraction…“, „the wedge…“;
`labels.test.ts` „a new wedge … asked again, once“.

**C4c (erledigt):** Das Licht steht 45° hoch über der linken Schulter des
Betrachters (Azimut = yaw − 135°, `SUN.behind` in shading.ts, Uniform
`uSun` je Frame aus `camera.yaw`): Imhofs Regel „Licht von oben links“,
mit dem Blick gedreht, damit das Relief in jeder Richtung gleich lesbar ist
– die feste Sonne bei 160° beleuchtete nach Südosten flach und nach
Nordwesten gar nicht. Die echte Sonne nach Uhrzeit bleibt eine spätere
Option. Konturen (Kantenlinien aus dem Entfernungspuffer) sind jetzt ein
Regler „Konturen“ 0–100 % (Default 70 %, vorher fest 35 %), die Linie ist
einen CSS-Pixel breit statt eines Gerätepixels. Tests: `shading.test.ts`
„the light stands behind the viewer's left shoulder…“, `state.test.ts`
„contour lines…“, `app.spec.ts` „ridge lines … a slider sets how strongly“.

**C5 (erledigt):** Der Roll der Sensoren geht in die Kamera (bisher
bewusst weggelassen): kippt das Handy um die Blickachse, kippt der
gezeichnete Horizont mit dem im Kamerabild; ohne Sensoren steht die Ansicht
wieder waagerecht. Der Objektiv-Bildwinkel bezieht sich auf die lange
Bildseite (Default 66°, ein 26-mm-Äquivalent), der vertikale Winkel folgt
dem Seitenverhältnis des aktuellen Frames (`lensFovY`, `renderLensFov` in
cameraFeed.ts) – vorher fest 51° vertikal für ein 4:3-Bild bei einem
16:9-Stream, und bei gedrehtem Gerät falsch. Der Default-Bildwinkel des
Panoramas ist ebenfalls der der langen Bildseite (60°, `fovForAspect`):
quer 60° breit, hochkant 60° hoch, und beim Drehen bleibt die Vergrößerung
(`keepLongFov`). Tests: `sensorLook.test.ts` „the device's roll tilts the
view…“, `camera.test.ts` „the lens angle is the long side's…“, „the
panorama's default field of view is the long side's too“, `state.test.ts`
„without a field of view anywhere…“.

**C4b (erledigt) – das Fernrohr.** Unter 30° Bildwinkel (1) wird das
lineare Mittelsegment der Ringe zu einem Band im Postabstand um die
Entfernung, in der der Mittelstrahl den Boden trifft (`lookRange`,
`bandFor` in mesh.ts; Entfernung in ×1,25-Stufen quantisiert, damit
Schwenken die Ringe nicht verschiebt; höchstens 45 % der Reihen), und
(2) zwei zusätzliche Clipmap-Ebenen (hoch z14/z13, niedrig z13/z12,
`look` in clipmap.ts) werden um diesen Punkt geschnitten statt um den
Betrachter (`setLook`, Hysterese eine Viertel-Fensterbreite, `clearLook`
beim Herauszoomen). Der Shader nimmt sie nach Lage statt nach Entfernung
(Kennung `uLvlA.w < 0`, `lookLevel`/`lookFade`, Blende am Fensterrand,
zehn Ebenen-Slots, Atlas 640 × 6400); die CPU liest sie nur für die
Label-Nadel, die auf der gezeichneten Fläche sitzen muss (`vertexHeight`
über `HeightField.lookAt`, dieselbe Blende wie der Shader); Sichtlinien,
Boden und Gipfel bleiben auf den Betrachter-Ebenen (`role: 'look'`,
`eyeLevels()`). Der angepeilte Gipfel wird so aus 6,6-m-Posten
im Postabstand gezeichnet statt aus 26–53 m auf Ringen von 1/190 der
Entfernung. Tests: `mesh.test.ts` „the telescope…“, `clipmap.test.ts`
„look levels…“, `heightfield.test.ts` „a look level … never read on the
CPU“, `labels.spec.ts` „zoomed in, the telescope cuts its fine windows
around the Testhorn…“.

**Stand nach C4/C5 (2026-10-18):** Vertexzahl des Keils 1,6 M (hoch,
1024 × 1600) bzw. 0,58 M (niedrig, 640 × 900) – vorher 1,47 M (2048 × 720)
bzw. 0,49 M (1024 × 480) über den ganzen Kreis, davon nach dem
Sektor-Culling je nach Bildwinkel ein Viertel bis die Hälfte gezeichnet.
Die E2E-Suite läuft seit C4a mit `q=low`: der Software-Rasterizer
(SwiftShader) braucht für das hohe Netz 4–5 s pro Frame, Sichtbarkeit und
Nadeln kommen dann nie zur Ruhe. Der hohe Pfad ist damit nur über die
Unit-Tests (Netz, Shader-Preprocessing) und von Hand geprüft; FPS auf dem
200-€-Handy mit `q=high` und `q=low` stehen noch aus (HUD-Diagnose).
Offen aus der Recherche: Normale bilinear statt pro Zelle, Himmelssicht/AO
je Ebene, Skyline-Kalibrierung des Live-Bilds wie PeakLens, echte Sonne
nach Uhrzeit.

### 8.aa E2E-Laufzeit: Shade-Pass aus, drei Worker (2026-10-19)

Die volle E2E-Suite brauchte lokal 53,6 min (58 Tests, ein Worker), in CI
34 min. Vor Änderungen eine Messung (SwiftShader, Headless-Chromium,
`q=low`, 1000 × 600; Phasen per `tools/.scratch/e2e-timing.mjs`,
CDP-Profiler und Hooks auf `renderer.render`/`setHeightField`/`onLevel`):

| Phase einer Testseite | Dauer | Befund |
|---|---|---|
| Start bis `window.alp`, Shader kompiliert, erster Frame | 0,8–1,0 s | billig; eine geteilte Seite je Spec brächte fast nichts |
| 33 Fixture-Kacheln holen und dekodieren | Median 16 ms je Fetch | kein Engpass |
| `setHeightField` (Atlas packen, hochladen) | 7 Aufrufe, 10–50 ms, Summe 167 ms | kein Engpass |
| erster Frame mit gefülltem Gelände | **14–20 s**, eine einzige Frame-Lücke | SwiftShader JITtet die Pipelines beim ersten echten Draw und blockiert dabei den Hauptthread; pro Seite neu (auch zweiter Tab, neuer Context, persistentes Profil mit GPUCache); unabhängig vom Viewport; ohne Shade-Pass 8 s; `q=high` 50 s |
| Frame danach | ~1,0 s mit Shade-Pass, **17 ms ohne**; `q=high` 2,8 s | der Shade-Fragment-Shader (Gradienten über die Ebenen, Look-Blende, Wasser, Luft) ist der Frame; der Range-Pass mit demselben Netz ist billig |
| `evaluate`-Roundtrip; Kameraänderung → Hash | 2–3 ms; 0,3 s | ok |
| `relocate` → wieder bereit | 25–35 s | Frames à 1 s plus Debounce, kein zweiter Stall |

Die Schleife in `viewer.ts` zeichnet jeden Animationsframe, auch ohne
Änderung; mit 1-s-Frames hing daran alles, worauf die Tests warten
(Sichtbarkeits-Budget 4 ms je Frame, Rebuild-Debounce, HUD-Drossel,
Polls). Die zuerst geplante Abhilfe „zeichnen nur bei Änderung“ wäre
ein Produktthema (Akku), für die Tests nach dem Befund zweitrangig.

**Maßnahme:** URL-Option `?shade=0` (`readOptions`, `AppOptions.shade`)
lässt den Shade-Pass weg; der Viewer wendet sie beim Bau an, Kamera- und
Fotomodus stellen danach das Soll wieder her. Alle Specs rendern ohne
Shade-Pass; genau acht Tests brauchen ihn und setzen `shade=1` (mit
`shade=0` rot, danach grün): app.spec Konturen, Flanken, Golden;
lakes.spec Wasserlage, Wasserglanz; camera.spec Waschung/Skyline, „camera
refused … stays shaded“; photo.spec EXIF-Foto. Tests rot → grün:
`state.test.ts` „shade=0 switches the lit shade pass off…“, `app.spec.ts`
„shade=0 leaves the lit pass out…“ (Himmel weiß statt blau, Pipelines
kompiliert, Testhorn-Zeile wie die Formel), `photo.spec.ts` „…closing it
restores the view as the URL asked“. Dazu `workers: 3`
(`E2E_WORKERS` überschreibt): jeder Worker hat seinen eigenen
GPU-Prozess, die JIT-Stalls laufen parallel. Nachtrag: auf dem CI-Runner
liefen mit drei Workern zwei Tests in ihre 30-s-Polls (See-Wasserlage,
Sensoren), lokal waren sie grün; da drei Worker nur zwei Minuten bringen,
ist der Default jetzt **ein Worker**, `E2E_WORKERS=3` bleibt für schnelle
lokale Läufe.

**Zweiter Befund, Worker:** Mit zwei bzw. drei Workern wurde die Suite
kaum schneller (28,8 bzw. 25,4 min) und zwei bis drei Farbtests liefen
in ihre 30-s-Polls, jeder Test dauerte doppelt so lang. Ursache: ohne
Shade-Pass tickt die Render-Schleife mit 60 fps und belegt je Seite
einen Kern, sobald irgendetwas Frames anfordert (im Headless-Chromium
läuft `requestAnimationFrame` nur dann, etwa während `waitForFunction`
mit raf-Polling, also in jedem `ready()`); zwei bis drei Seiten
sättigen vier Kerne. Daraus wurde „zeichnen nur bei Änderung“ doch
Teil der Maßnahme, nicht wegen der Frame-Zahl, sondern wegen der
Leerlauflast: `render/redraw.ts` (`frameFingerprint`, `RedrawGate`),
der Renderer zeichnet, wenn sich eine Eingabe geändert hat (Kamera,
Größe, Auge, Ursprung, Ebenen-Versionen und -Fenster, Regler, Band,
Textur hinter dem Umriss), in den ersten drei Frames, solange Pipelines
kompilieren, auf Anforderung (Context-Restore) oder mit Kamerabild. Auf
dem Handy ist dasselbe der Akku. Tests rot → grün: `redraw.test.ts`,
`app.spec.ts` „a view nobody moves draws no further frames; a turn
draws, then quiet again“ (über 30 Animationsframe-Ticks in der Seite
gezählt: 30 gezeichnet vorher, 0 nachher).

| Lauf (58/59 Tests) | lokal (4 Kerne) | CI (ubuntu-latest) |
|---|---|---|
| vorher: Shade-Pass an, 1 Worker | 53,6 min | 34 min |
| Shade-Pass aus außer Farbtests, 1 Worker | 30,6 min | – |
| dito, 2 Worker / 3 Worker (ohne Gate) | 28,8 min, 2 rot / 25,4 min, 3 rot | – |
| dito mit Gate, 1 Worker | **12,4 min** | – |
| dito mit Gate, 3 Worker | **10,4 min**, 60/60 grün | 11,8 min, **2 rot** (See-Wasserlage, Sensoren: 30-s-Polls unter Last) |
| dito mit Gate, 1 Worker (Default) | **11,7 min**, 60/60 grün | **7,6 min**, grün |

Mit drei Workern begrenzt die größte Datei den Lauf (app.spec, 25 Tests
seriell à ~25 s unter Last); mehr Worker brächten nichts, eine Teilung
von app.spec in zwei Dateien etwa 3 min. Das Golden hängt am Dateinamen
(`__screenshots__/app.spec.ts/`), also nur mit Umzug der Datei.

Nebenbefund des Gates: `capture()` und `readRange()` setzten aus den
Puffern des letzten Frames zusammen; im Headless-Chromium läuft zwischen
einem Klick und dem nächsten `evaluate` nicht zwingend ein
Animationsframe, also zeichnen beide Ausstehendes jetzt zuerst (durch das
Gate, kostenlos wenn nichts anlag). Der EXIF-Foto-Test war bis dahin nur
durch einen veralteten Farb-Puffer grün (blauer Himmel von vor dem Foto,
wo beim 11,6°-Tele Fels steht) und prüft jetzt das Richtige: nach dem
Schließen beleuchtetes Gelände statt Foto-Grau, nach dem Weiten per URL
blauer Himmel.

### 8.ab Nahe Gipfel hinter der eigenen Kante (Mauritzalm, 2026-10-19)

Von der Mauritzalm waren Haidachstellwand und Gschöllkopf nicht
beschriftet, obwohl man sie direkt vor sich hat. Messung mit echten
Kacheln (Standpunkt 47,44379° N 11,76411° O, Boden 1841 m, Auge 1843 m;
beide im Katalog mit Schartenhöhe, Anker und Rang in Ordnung):

| Gipfel | Entfernung, Höhe im Bild | Marsch-Maximum | Ursache |
|---|---|---|---|
| Gschöllkopf 2039 m | 367 m, 28,01° | 28,27° bei 361 m (99 %) | eigene Zelle: der Marsch endete 1,5 % vor dem Anker (5,5 m, weniger als ein 13-m-Posten); bei 6,6-m-Posten beschriftet |
| Haidachstellwand 2192 m | 1225 m, 15,82° | 16,23° bei 1111 m (91 %, 2166 m) | eigene Kante: Gipfelpunkt 24 m höher, aber 114 m hinter der Oberkante der Wand, Flanke dahinter 12° flacher als die Sichtlinie 16°; bei beiden Auflösungen gleich |
| Hochiss 2299 m (Vergleich) | 1633 m, 15,5° | 25,8° bei 383 m (23 %) | Gschöllkopf-Flanke davor: zu Recht verdeckt |

**Zwei Regeln im Sichtlinien-Marsch (`horizon.ts`):** (1) Der Marsch
endet bei `range − max(1,5 % range, 2 Posten)` der dort gelesenen Ebene
(`HeightField.resAt`); auch die Zelle vor dem abgeflachten Gipfelposten
wird bilinear hochgezogen. (2) Eigene Kante (`ownCrest`): liegt das
Maximum im letzten Fünftel des Weges oder ≤ 300 m vor dem Anker, steht
der Gipfel höchstens 1,5° darunter (bei 60° Bildwinkel ≤ 14 px; in der
Ferne begrenzt die Geometrie ohnehin auf ≤ 0,7° bei 30 km) und sinkt das
Gelände zwischen Kante und Gipfel, Posten für Posten nachgelaufen,
nirgends mehr als 15 m unter die Kante (Ganzmeter ≤ 1 m, Mikrorelief
2–5 m, jede benannte Scharte mehr), dann ist der Gipfel sichtbar und die
Nadel steht auf der Kante (`labels.ts pinAt`, beweglicher `anchor`,
`settle` folgt ihm); Entfernung, Peilung, Rang und Text bleiben die des
Gipfels. Fremder Grat mit Tal dahinter und Punkt tief hinter der Kante
bleiben verdeckt, Seen nie.

Simulation über alle verdeckten Ziele bis 30 km vor der Änderung:
Mauritzalm 634 verdeckt, 9 kippen (die beiden gewollten und sieben
Gipfel in 20–28 km, deren Kuppe 0,0–0,1° hinter der eigenen Vorderkante
liegt, alle ohne Senke); Pertisau 814 verdeckt, 2 kippen (Zwölferkopf,
Hinterunnütz). Tests rot → grün: `heightfield.test.ts` „resAt…“,
`horizon.test.ts` „a near summit whose top the grid flattens…“ und „a
summit a little behind its own edge is visible…“ (mit Gegentests Tal und
tiefe Kuppe), `labels.test.ts` „a pin moved onto the visible edge…“,
`labels.spec.ts` „a summit behind its own shoulder is labelled on its
visible edge…“ auf dem neuen Fixture-Berg „Schulterkopf“ (145°, Kuppe
1,2° hinter der Kante). Messung nachher von der Mauritzalm, beide
Qualitäten: Gschöllkopf sichtbar und platziert, Nadel auf dem Gipfel (die
Rand-Regel reicht); Haidachstellwand sichtbar mit der Nadel auf der Kante
94–100 m vor dem Gipfelpunkt (2172 m, 16,3°) und platziert, sobald sie im
Bild ist; Hochiss, Streichkopf, Seekarlspitze bleiben verdeckt; keine
Kanten-Nadel innerhalb 150 m eines anderen sichtbaren Ziels. Volle
E2E-Suite 61/61 grün.

### 8.ac Plan 4, Etappe 1: Tuschelinien, Dunstsaum, Höhennebel, Auflösungs-Deckel (2026-11-12)

Anlass: „Die Berge haben einen sehr schlecht zu erkennenden Umriss“, die
Darstellung soll schöner werden und auf schwächeren Geräten stufenweise
abbauen. Plan 4 hat acht Etappen (E1 Linien und Dunst, E2 Standort
robust, E3 Sichtbarkeit und Labels neu, E4 Geräteklassen, E5 Fläche, E6
Landbedeckung, E7 Standort-Komfort, E8 Luftbild-Stil); dies ist E1.

**Befund vorher.** Kontur = 5-Tap-Laplace auf der Log-Entfernung, volle
Linie erst bei 38 % Entfernungssprung, 1 px, nur abdunkelnd: ein Grat
10 % hinter dem nächsten bekam 13 % einer Linie, und zwar auf beiden
Graten. Fels begann erst bei 49° Neigung und war bei 66° voll, Schnee
hielt bis 63–73° (Haidachstellwand = grüner Hügel, Matterhorn ganz weiß).
Nebel nur nach Entfernung. Kein Deckel für die Auflösung.

**Die Linie (`render/outline.ts`).** Auf vier Achsen eines Achter-Rings
um das Pixel sind `a` und `b` die Schritte der Log-Entfernung zu den
beiden Nachbarn eine Linienbreite weiter. `a + b` ist die zweite
Differenz: positiv, wo das Pixel näher ist als seine Umgebung, also auf
der nahen Seite einer Silhouette; die Linie liegt damit auf dem Berg
vorn und nie doppelt. Flach angeschnittener Boden hat auch eine zweite
Differenz, aber mit einem Schritt auf beiden Seiten; `κ · min(|a|, |b|)`
(κ = 0,5) abgezogen bleibt die Silhouette übrig. Volle Linie ab 6 %
Sprung (Beginn 2 %), der Himmel zählt als „hinter der Fernebene“ und ist
immer eine Kante. Breite 1 CSS-px in der Ferne bis 2,5 in der Nähe
(800 m bis 25 km), Tusche als dunkles Blaugrau (0,10; 0,12; 0,17)
eingemischt statt multipliziert, damit sie auf dunklem Wald wie auf
Schnee liest; fern verblasst sie mit dem Dunst (60 %, 1/e bei 55 km).
Glättung kommt aus der Abdeckung des Rings, nicht aus MSAA.

**Der Dunstsaum.** Die Fläche direkt hinter einem näheren Grat wird zur
Dunstfarbe aufgehellt (Beranns Mittel, Schichten zu trennen). Acht
Nachbarn in 6 CSS-px Abstand; einer zählt, wenn er näher ist, als die
eigene Fläche mit ihrer eigenen Neigung dort wäre (auf einer Ebene also
nie). Jeder zählt einmal, wie groß der Sprung auch ist, und die Hälfte
ist der volle Saum (Stärke 0,32, am Himmel 35 % davon): er fällt zur
Kante hin ab, und eine Wiesenkante in 100 m blendet nicht stärker als
ein Grat vor dem nächsten. Der erste Entwurf (mittlerer Überstand,
Radius 8, Stärke 0,45) ergab im Bild von der Mauritzalm ein
gleichmäßiges weißes Band hinter jeder nahen Kante; deshalb die Zählung.
Nur im schattierten Bild (`uRim`): die E2E-Tests mit `shade=0` zahlen 9
statt 17 Taps.

**Luft und Boden (`render/shading.ts`).** Höhennebel: Dichte
`e^(−z/3000 m)`, entlang der Sichtlinie geschlossen integriert, also
Dunst in den Tälern und klare Gipfel; je Kanal `exp(−τ·(1; 1,12; 1,35))`,
Blau geht zuerst, die Ferne wird blau; Boden 0,12, damit der letzte Grat
ein Grat bleibt. Fels von 33° bis 45° (unter der Waldgrenze schwächer,
dort ist Steiles so oft Wald wie Wand), Schnee hält zwischen 40° und 50°
nicht mehr. `terrainColor` bekommt die Augenhöhe; Flanken- und See-Test
rechnen damit.

**Eine Quelle für die Zahlen.** `gpu/consts.ts` schreibt die Konstanten
aus `outline.ts` und `shading.ts` als Deklarationen in GLSL und WGSL;
`wgsl.test.ts` prüft beide Dialekte dagegen. Dabei gefunden: Babylons
Präprozessor schneidet eine Uniform-Zeile am Semikolon im Kommentar
dahinter ab („`uniform float uRim; // …; 0 = off`“ wurde zu einer Zeile
„`0 = off`“, Composite kompilierte nicht, Bild schwarz). Ein Wächter-Test
verbietet das Semikolon im Kommentar hinter Code.

**Auflösungs-Deckel (`render/resolution.ts`).** Drei Durchgänge je Pixel:
ein Handy mit Pixelverhältnis 3 zahlt neun Fragmente je CSS-Pixel.
Niedrige Qualität rendert mit höchstens 1,5, hohe mit höchstens 2
Gerätepixeln je CSS-Pixel (`renderer.maxPixelRatio`, über Babylons
Hardware-Skalierung); die Linienbreite ist in CSS-Pixeln definiert und
bleibt gleich. E4 ersetzt die Zweiteilung durch Geräteklassen und eine
Anpassung zur Laufzeit.

**Testlandschaft.** Hintergrat: 22 km nördlich, 2950 m, nur 7 bis 1,5 km
westlich des Meridians, damit der Blick nach Norden und die Gratspitze
bleiben, wie sie waren. `skylineRow` kann den Marsch früher beenden
(Kamm des vorderen Grats).

Tests rot → grün: `outline.test.ts` (neu: 10-%-Stufe volle Linie nur auf
der nahen Seite, 2 % keine, angeschnittene Ebene keine, Himmelslinie,
Gerätepixel; Saum hinter dem Grat, zur Kante abfallend, große Sprünge
nicht stärker, Ebene ohne, Himmel schwächer), `shading.test.ts` („at the
same range a valley floor is hazier than a summit“, „the distance turns
blue“, „a 45° face at 2000 m is rock“, „a 55° face at 3500 m is rock, not
snow“), `wgsl.test.ts` (Konstanten in beiden Dialekten, Semikolon-
Wächter), `resolution.test.ts` (neu), `app.spec.ts` „two ridges 10 %
apart are separated by one line, drawn on the near ridge“ (vorher
Helligkeit 0,91 an der Stelle der Linie), „the ground right behind a
nearer mountain is lightened towards the haze, as the formula says“ (der
Saum wird aus dem Entfernungspuffer des Frames mit `rimAt` nachgerechnet
und mit dem Bild verglichen), „a screen with a pixel ratio of 3 is
rendered at 1.5“ (vorher 3000 × 1800). Golden einmal neu. Der Foto-Test
prüfte „Gelände statt Foto“ am Blaustich des Schnees; der Gipfel des
Testhorns (45°) ist jetzt halb Fels und neutralgrau, die Prüfung
vergleicht deshalb mit dem Foto-Zustand (0,89 gegen 0,48).

Messung: volle E2E-Suite 64/64 grün in 9,1 min lokal (vorher 61 Tests in
12 bis 15 min); der ungeschattete Frame kostet in SwiftShader 20 bis 25 ms
statt 17 ms (9 statt 5 Taps), der Pipeline-Stall je Seite ist nicht
gewachsen. Vorher/Nachher von der Mauritzalm und vom Gornergrat mit
echten Kacheln: Grate tragen klare Linien, die Wände am Matterhorn sind
Fels, die Ferne ist blau statt weiß.

### 8.ad Plan 4, Etappe 2: Standpunkt robust, CPU ruhig (2026-11-12)

Befunde aus dem Review von Standort und Laden, und was jetzt gilt.

**Altes Gelände am neuen Ort.** `setCenter` setzte `px0/py0` einer Ebene
sofort auf das neue Fenster, die Daten und `filled` blieben die alten:
bis die Kacheln kamen, stand das alte Gelände unter den neuen
Koordinaten. Jetzt hält eine Ebene immer ein ganzes Fenster an seinem
eigenen Ort oder nichts. Das neue Fenster wird in einen eigenen Puffer
gefüllt und erst vollständig getauscht; das alte bleibt so lange gültig
(die Ebene reicht dann nur weniger weit), und eines, das der Betrachter
verlassen hat, wird geleert. Dazu eine Hysterese: ein Fenster folgt erst,
wenn der Betrachter mehr als ein Achtel seiner Größe von der Mitte
entfernt ist (bei 13-m-Posten etwa 1 km), vorher ändert sich nur die
Reichweite der Ebene (mindestens 75 %). Damit ist `setCenter` bei jedem
GPS-Fix billig, die Voraussetzung für das Mitlaufen in E7.

**Kacheln, die nicht kommen.** Ein Netzfehler wurde wie „gibt es nicht“
behandelt: die Kachel blieb leer, ein Loch 1000 m unter dem Meer, für
immer. `TileSource.load` unterscheidet jetzt: `null` heißt „gibt es
nicht“ (204/403/404/410, zählt als `absent`), ein Netz- oder Serverfehler
wirft (zählt als `failed`, ein Abbruch nicht). Der Streamer fragt nach
400, 1500 und 4000 ms neu; bleibt eine Kachel aus, bleibt ihre Ebene
draußen (das Bild kommt dann aus den gröberen), `progress.failed` zählt,
und nach einer aufgegebenen Ebene fragen die folgenden nur einmal (das
Netz ist offenbar weg). Das HUD zeigt „n Kacheln fehlen · Erneut laden“.
Das Overlay „Gelände lädt“ erscheint nur noch, solange eine Ebene nichts
zeigt. Hat die Quelle für einen Teil eines Fensters keine Daten (die
feinen Zooms gibt es bei Mapterhorn nur, wo eine Vermessung existiert),
bleibt die Ebene ebenfalls draußen, wird dort nicht wieder angefragt und
zählt als erledigt; das HUD nennt „n Ebenen ohne Daten“. Offen für E5:
Fenster am Rand der Abdeckung aus der gröberen Ebene auffüllen statt die
ganze Ebene wegzulassen.

**Standpunkt.**
- Ein Ortswechsel verwirft Ziele, Sichtlinien und Platzierungen sofort
  (sie tragen Peilung und Entfernung vom alten Standpunkt); nur Drehen
  oder Zoomen über `relocate` behält sie.
- „Start am Standort“ wirkte nur beim ersten Öffnen, weil die App den
  Standpunkt selbst in die URL schreibt. Der Tab merkt sich jetzt
  (`sessionStorage`), woher der Standpunkt kam und welcher es war: beim
  Neuladen wird neu geortet, wenn der Standpunkt in der URL der eigene
  vom Gerät ist; einer aus einem Link, von der Karte oder aus der Liste
  bleibt.
- Eine GPS-Antwort, die eintrifft, nachdem inzwischen anders gewählt
  wurde, wird verworfen. Ein Fix gröber als 100 m wird übernommen, mit
  dem Hinweis „Standort nur auf ± x genau … Auf der Karte nachsetzen“.
- Ein Hash ohne `lon/lat` (etwa `#yaw=180`) dreht die Ansicht und behält
  den Standpunkt; vorher sprang er zum Gornergrat.
- Die URL folgt der Ansicht alle 400 ms mit nachlaufender Kante. Vorher
  300 ms nach der letzten Änderung: mit Sensoren ändert sich die Ansicht
  jeden Frame, die URL kam erst, wenn das Handy ruhte.

**Kompass-Korrektur.** Die Korrektur des Benutzers wurde auf den
Kompasswert vor der Fusion addiert. Ein Wisch sah damit aus wie ein
Kompass, der springt, während der Kreisel stillsteht: genau das Muster,
an dem die Fusion eine magnetische Störung erkennt und dem Kompass
misstraut. Die Korrektur wird jetzt nach der Fusion addiert und steht im
selben Frame im Bild; der E2E-Test dazu läuft in 12 statt 42 s.

**CPU.** Label-Layout und Overlay liefen je Animationsframe, auch im
Stand. Jetzt nur, wenn sich Ansicht, Größe, Ziele, Zahl der entschiedenen
Sichtlinien, Netz oder Auswahl geändert haben. Ein Gipfel außer
Reichweite fällt weg, bevor sein höchster Punkt im DEM gesucht wird. Ein
See, dessen Mittelpunkt sichtbar, aber nicht im Bild ist, wird am
Ersatzpunkt im Bild benannt.

Tests rot → grün: `clipmap.test.ts` („a window stays where it is…“, „a
moved level is never the old terrain at the new place…“, „nearby, the
old window is kept whole…“, „a failed tile is asked again…“, „a tile that
keeps failing leaves its level out…“), `terrarium.test.ts` (404, 503,
Netzfehler, Abbruch), `state.test.ts` (Start-Quelle, `coarseFixNote`,
`trailing`), `pose.test.ts` („a correction dragged in applies at once and
in full…“), `sensorLook.test.ts` („…the next tick reports the change, so
the URL follows“), `labels.test.ts` (See-Ersatzpunkt im Bild, Filter vor
der Gipfelsuche), `app.spec.ts` („a hash change relocates…; a hash
without a standpoint keeps the one there is“, „tiles that do not arrive
leave their level out, not a pit…“ mit abgebrochenen Kachel-Anfragen, „a
view that keeps changing reaches the URL while it changes…“, „a view
nobody moves draws no further frames…“ um die Layouts erweitert),
`labels.spec.ts` („a new standpoint drops the labels of the old one at
once…“), `map.spec.ts` („a fix good to 850 m only is taken, with a
warning…“, „a fix that comes late is dropped…“, „reloaded, a start from
the device asks the device again; a standpoint from a link stands“).
Ein E2E-Test „URL folgt im Sensor-Modus“ war im Software-Renderer sofort
grün (die Frames sind dort langsamer als die alte Wartezeit) und ist
durch den Test am Änderungs-Handler ersetzt.

Messung: 293 Unit-Tests grün; volle E2E-Suite 70/70 grün in 7,4 min
lokal (69 im Lauf, der Test „the standpoint menu writes the place into
the URL“ erwartete noch eine Meldung für den Ort ohne Test-Kacheln, die
so nicht stimmt, weil die gröbste Ebene dorthin reicht; korrigiert und
einzeln grün).

### 8.ae Plan 4, Etappe 3: Sichtbarkeit und Labels neu (2026-11-12)

**Befund vorher.** Der Sichtlinien-Marsch begann 80 m vor dem Auge: was
näher stand, war im Bild der ganze Vordergrund und für die Labels nicht
da (Pertisau: Böschung 10 bis 30 m voraus, Labels für Gipfel, die das
Bild nicht zeigt). Er nahm 96 Proben je Gipfel, in 100 km also 6 bis
7 km auseinander: ein Grat dazwischen existierte nicht. Die Toleranz war
ein Winkel (0,05° = 87 m in 100 km, 0,9 m in 1 km). Jeder Neuaufbau der
Ziele löschte alle Sichtbarkeiten (Blinken). Das Label-Raster lag auf dem
Bildschirm, beim Schwenken wechselten die Gipfel die Zelle und damit die
Namen. Seen schlugen Gipfel, Gipfel ohne Schartenhöhe hatten Rang 0,
Labels lagen unter Menü, Statusfeld und Kompass.

**Horizonttabelle (`core/horizon.ts`).** Für 2048 Peilungen die Treppe
der höchsten scheinbaren Elevation vom Auge nach außen, als Paare
(Entfernung, tan Elevation). Eine Zeile wird erst gegangen, wenn ein
Gipfel sie braucht, die wichtigsten Gipfel also zuerst. Ab 2 m, nah in
Schritten von 10 %, dann Posten für Posten je Ebene, so weit sie reicht;
die Proben liegen auf den Linien durch die Postenmitten entlang der
Hauptachse der Zeile, dazwischen linear: ein Grat von einem Posten
Breite wird in voller Höhe gelesen. Je 48 Posten ein gerades Stück in
Mercator-Pixeln zwischen zwei Großkreis-Punkten (Abweichung wenige
Hundertstel Posten), also keine Trigonometrie je Probe. Ein Gipfel ist
sichtbar, wenn er die Treppe vor seinem eigenen Boden überragt (zwischen
den beiden Nachbar-Zeilen interpoliert), mit `2 m + 3 % der
Krümmungssenke` Spiel: 2 m in der Nähe (Rundung des DEM), 22 m in 100 km
(was die Refraktion von Tag zu Tag ausmacht). Die Eigene-Kante-Regel
(§8.ab) bleibt, gespeist aus der Tabelle. Dazu je sichtbarem Ziel „steht
am Himmel“: hinter ihm kommt nichts, das höher steht als alles bis zu
ihm. Gemessen, Mauritzalm, echte Kacheln, niedrige Qualität: 2037
Zeilen, 2,1 Mio. Posten, im Schnitt 1035 je Zeile; die Seite ist samt
Sichtbarkeit in 5 s fertig.

**Freier Blick (`core/eye.ts`).** Mit Sichtlinien ab dem Auge verdeckt
eine Böschung in 10 m jeden Gipfel dahinter, im Bild wie bei den Labels,
und der Standpunkt ist nur auf einige Meter genau. Erste Fassung wie
geplant (Ebene durch eine Scheibe um den Standpunkt, Auge über den
größten Überstand): auf der Mauritzalm, einer 20° steilen Wiese, hob sie
das Auge um 6,5 m; im Kamera-Modus stünde ein Grat in 400 m um 1°
daneben. Zweite Fassung, Richtung für Richtung: Hindernis ist Gelände in
der Scheibe (Radius = Genauigkeit des Fixes, 15 bis 50 m, ohne Fix
30 m), das über alles ragt, was dahinter kommt (Horizont jenseits der
Scheibe aus derselben Tabelle). Das Auge steigt, bis der ferne Horizont
in jeder Richtung mit 0,5 m Luft über dem nahen Boden steht, höchstens
10 m. Ein Hang hebt nichts (darüber kommt mehr Berg), ein unebener wenig
(Mauritzalm 0,9 m), ein Damm mit freiem Land dahinter und der Rand einer
Mulde schon; am Seeufer in Pertisau 0. Nicht bei expliziter Höhe in der
URL. HUD „(Boden + 2,6 m, freier Blick)“.

**Rang (`core/labels.ts`).** Scheinbare Prominenz `atan(Schartenhöhe /
Entfernung)`, ohne bekannte Schartenhöhe 25 m statt 0 (vier Fünftel des
Katalogs kamen sonst nach jedem See); mal 1,5 mit Wikipedia-Artikel, mal
1,2 mit Wikidata-Eintrag; mal 1,6, wenn der Gipfel am Himmel steht. Seen
bekommen höchstens ein Siebtel der Labels und nehmen einem Gipfel nie
die Zelle.

**Layout.** Zellen im Winkelraum (Peilung × Elevation), etwa ein Label
breit und zwei Zeilen hoch, die Größe auf einer √2-Leiter des
Bildwinkels: ein kleiner Zoom behält die Zellen, Schwenken bewegt die
Namen mit den Bergen. Je Zelle der Beste; liegt er außerhalb des Bildes,
bleibt die Zelle leer statt für einen Schwenk an den Nächsten zu gehen;
findet er keinen Platz oder liegt unter einem Bedienfeld, kommt der
Nächste dran. Zellen, die beim letzten Mal benannt waren, werden zuerst
gesetzt, in derselben Reihenfolge: ein Rangwechsel (ein Gipfel wird als
„am Himmel“ erkannt) stapelt die Kästen nicht um. Menüleiste,
Statusfeld, Kompass und Gipfelkarte meldet die App als Sperrflächen
(`data-over-view`): kein Kasten liegt darunter, ein Gipfel unter einem
Feld wird nicht benannt, und neben einem hohen Feld rückt der Kasten zur
Seite, solange er noch über seinem Gipfel steht. Die Sichtbarkeit je
Gipfel bleibt über einen Neuaufbau erhalten, bis neu entschieden ist.
HUD „n weitere im Bild“ für sichtbare Gipfel ohne Namen.

Vorher/Nachher mit echten Kacheln: am Gornergrat steht „Matterhorn“ am
Matterhorn (vorher „Picco Muzio“ und „Épaule de Furggen“, zwei Schultern
ohne Wikipedia-Artikel), von der Mauritzalm Sonnjoch, Bettlerkarspitze,
Großer Bettelwurf, Rotspitze; Gschöllkopf und Haidachstellwand (Kante)
sichtbar, Hochiss verdeckt.

Offen geblieben: `mesh.lookRange` (Fernrohr) und `align.horizonProfile`
(Foto-Ausrichtung) marschieren weiter selbst; sie auf die Tabelle
umzustellen ändert nichts Sichtbares und kommt, wenn dort ohnehin
gearbeitet wird.

Tests rot → grün: `horizon.test.ts` („a 3 m bank 20 m ahead hides a
summit 20 km out…“, „a ridge one post wide 88 km out hides the summit
behind it“, „40 m under the sightline at 100 km is hidden, 10 m under it
is seen…“, „a row is marched once, when a summit needs it…“, „a summit
with nothing higher behind it stands on the skyline…“, „what was seen
stays seen until it is decided anew…“), `eye.test.ts` (acht Tests),
`labels.test.ts` (Rang: 25 m, Bekanntheit, Himmelslinie; Layout:
√2-Leiter, eine Zelle ein Name, „panning a third of a cell keeps the
labels…“, Bester außerhalb des Bildes, Zelle geht an den Nächsten, Seen,
Sperrflächen, zur Seite neben der Leiste, „labels that stood last time
are placed first…“, Zähler), `app.spec.ts` („with a bank in front of the
standpoint the eye comes up until the ridges show over it…“),
`labels.spec.ts` („labels keep clear of the menu, the status panel and
the compass; a summit under a panel is named once the panel is gone“).

Im ersten Suite-Lauf fiel der Foto-Test einmal durch: ein von außen
gesetzter Hash (`fov=60`) kam nicht an. Die App liest den Hash jetzt aus
dem Ereignis (`HashChangeEvent.newURL`) statt aus der Adresszeile, die
ihr eigenes verzögertes Schreiben inzwischen überschrieben haben kann,
und verwirft dabei das ausstehende Schreiben (`app.spec.ts` „a hash set
from outside is read from the event that announces it…“, rot → grün).
Dabei gefunden: der Standpunkt aus dem eigenen Hash (fünf Nachkommastellen)
zählte gegen einen genaueren Fix als Ortswechsel um einen halben Meter;
`state.ts viewFromHash` behält den Standpunkt, wenn er derselbe ist
(`state.test.ts`).

Messung: 320 Unit-Tests grün; volle E2E-Suite 73/73 grün in 10,4 min.
Das sind 3 min mehr als bei E2, liegt aber an der Maschine: zur selben
Zeit gemessen sind E2- und E3-Build gleich schnell (Seite fertig in 4,0
gegen 3,6 s, zwanzig Schwenks mit Rücklesen 13,0 gegen 13,3 s, die beiden
langsamsten Tests 32 und 24 s gegen 30 und 27 s).

### 8.af Plan 4, Etappe 4: Geräteklassen, Anpassung zur Laufzeit, Stil (2026-11-12)

**Befund vorher.** Zwei Einstellungen, gewählt nach „kurze Seite < 600 px
oder höchstens vier Kerne“: ein iPad, das vier Kerne meldet, bekam die
Handy-Einstellung. Nichts passte sich an, wenn die Frames langsam waren.
Der Höhen-Atlas lag in einer Spalte: acht bis zehn Ebenen à 640 px sind
5120 bis 6400 px, sicher nimmt jedes Handy nur 4096; und bei jeder
Ebene, die ankam, ging der ganze Atlas neu zur GPU (bis 16 MB).

**Geräteklassen (`app/device.ts`).** Handy, Tablet, Desktop aus
User-Agent, Touch und kurzer Bildschirmseite: iPhone und Android mit
„Mobile“ sind Handys; ein iPad ist ein Tablet, auch wenn es sich als Mac
ausgibt (ein Mac hat keinen Touchscreen); ein Desktop mit höchstens vier
Kernen bekommt, was ein Tablet bekommt.

| Klasse | Netz | Ebenen | Pixel je CSS-Pixel | dekodierte Kacheln |
|---|---|---|---|---|
| Handy | 640 × 900 | 6 (13 m bis 420 m) | ≤ 1,5 | 48 |
| Tablet | 800 × 1200 (neu) | 8 (6,6 m bis 850 m) | ≤ 2 | 110 |
| Desktop | 1024 × 1600 | 8 | ≤ 2 | 220 |

`?q=low` und `?q=high` gelten auf jedem Gerät unverändert und ohne
Anpassung: die E2E-Tests und ein Vergleich sehen genau diese Einstellung.
Das Check-Panel zeigt „Gerät … · Qualität …“.

**Anpassung an langsame Frames (`render/adapt.ts`).** Die Klasse ist ein
Startwert. Solange sich die Ansicht bewegt, misst der Viewer die Zeit
zwischen gezeichneten Frames; liegt der Median von 20 Frames über 38 ms
(Budget 33 ms = 30 Bilder je Sekunde, 15 % Spiel), wird der bewegte
Frame gröber gezeichnet: ÷ 1,25, ÷ 1,5, ÷ 2 je Richtung, danach fällt
der Dunstsaum weg (8 Taps im Composite). Eine Pause über 250 ms ist
Ruhe, keine Frame-Zeit. Ruht die Ansicht 300 ms, wird sie einmal mit
allen Pixeln gezeichnet: scharf ist, was man ansieht, unscharf nur, was
sich bewegt. Sind die Frames wieder schnell (Median unter 23 ms), wird
nach 3 s eine Stufe zurück versucht; misslingt der Versuch, verdoppelt
sich die Wartezeit (bis 60 s), hält er, gilt wieder die kurze. Die
Klasse `Adaptation` bekommt nur Frame-Zeiten, keine Uhr und keine GPU,
und ist so getestet. `?adapt=1` / `?adapt=0` erzwingt sie an oder aus.
Check-Panel: „In Bewegung: Auflösung ÷ 1,5“.

**Atlas (`render/atlas.ts`).** Die Ebenen liegen zu zweit nebeneinander:
1280 × 3200 für zehn, 1280 × 2560 in der niedrigen Qualität. Beide
Shader-Dialekte finden die Ecke einer Ebene über `atlasOrigin()`, die
Spaltenzahl kommt aus `atlas.ts`. Eine geänderte Ebene wird in ihren
eigenen Block gepackt und allein geschickt (`updateTextureData`); die
Kopie des ganzen Atlas im Speicher entfällt.

**Stil (`app/state.ts Style`).** „Relief“ (beleuchtet) oder „Linien“
(nur die Umrisse auf Weiß), in den Einstellungen, auf dem Gerät gemerkt.
Linien ist der bisherige Pfad von `shade=0` mit den neuen Tuschelinien
und zugleich, was ein schwaches Gerät noch zeichnet. „Luftbild“ kommt mit
E8 dazu.

Nicht automatisch: der Wechsel auf „Linien“, wenn auch ÷ 2 nicht reicht.
Den Stil ändert nur der Benutzer.

Tests rot → grün: `device.test.ts` (neu), `adapt.test.ts` (neu: im
Budget nichts, Stufe je Fenster bis zum Dunstsaum, ein Ausreißer zählt
nicht, Pause, Versuch zurück mit wachsender Wartezeit, aus),
`atlas.test.ts` (neu), `wgsl.test.ts` („both dialects find a level by
column and row…“), `state.test.ts` (Stil, `adapt`), `app.spec.ts`
(„renders the fixture terrain…“ mit Atlas 1280×2560, „"Linien" in the
settings draws the outline alone…“, „a view that moves too slowly is
drawn with fewer pixels while it moves, and sharp again once it rests“,
Gerät im Check-Panel).

Messung: 340 Unit-Tests grün; volle E2E-Suite 75/75 grün in 12,1 min
(die Maschine ist seit dem Nachmittag langsamer, siehe §8.ae).

Echte Geräte kann ich nicht messen. Bitte auf iPad und Handy ins
Check-Panel schauen: Gerät, Qualität, Atlas, und nach einigem Schwenken
die Zeile „In Bewegung: Auflösung ÷ …“.

### 8.ag Plan 4, Etappe 5: die Fläche (2026-11-12)

**Befund vorher.** Der Shade-Pass nahm die Normale aus vier Höhen-Texeln
der DEM-Zelle, in die ein Pixel fällt: eine Normale pro Zelle. Gezoomt
war das Matterhorn ein Schachbrett, jede Zelle mit eigener Helligkeit
und, an der Schneegrenze, eigener Meinung zu Schnee oder Fels. Die Höhen
lagen auf ganzen Metern: ein 4°-Hang bekam alle 13 m eine Stufe. Im
Nahbereich blieben wenige einfarbige Riesenflächen.

**Viertelmeter.** Höhen werden in 0,25-m-Schritten gehalten
(`clipmap.ts QUANT`, im Atlas `HEIGHT_QUANT`): sechzehn Bit reichen von
−1000 m bis 15 383 m. `summitAt` vergleicht weiter ganze Meter (sonst
macht DEM-Rauschen jeden Buckel zum Gipfel) und gibt die genaue Höhe
zurück.

**Fläche je Posten (`core/surface.ts`).** Kommt eine Ebene an, rechnet
die CPU je Posten die Normale (Sobel über die acht Nachbarn) und schärft
sie nach (Unsharp-Maske auf den Steigungen, Anteil 0,5): ohne das wird
der Fuß jeder Wand rund, der Grund, aus dem geglättete Normalen früher
verworfen wurden. Dazu die Mulden-Abdunklung: Höhe minus Mittel über
9 × 9 Posten, in Einheiten der Steigung, die dazu gehört; Rinnen und
Wandfüße dunkler, Grate heller (`shade · (1 ± 0,22)`). Beides liegt in
einem zweiten Atlas im Layout des Höhen-Atlas (R, G Normale, B Mulde),
gebaut nur, wenn schattiert wird, 17 bis 39 ms je Ebene. Der Shade-Pass
liest die vier Posten um den Pixel als exakte Texel und mischt sie
selbst (aus dem Grund, aus dem die Höhen so gelesen werden: WebKit
rechnet normalisierte Koordinaten in geringer Präzision). Vier Taps wie
bisher, `gradientAt` entfällt.

**Körnung des nahen Bodens (`render/detail.ts`).** Mit glatter Normale
ist die Wiese vor den Füßen eine einfarbige Fläche: ein Posten misst
3 bis 13 m, darunter weiß das Gelände nichts. Eine 64²-Rauschkachel
(deterministisch erzeugt, ohne Naht, mit Mips; Wert und eigene Steigung
in den Kanälen) liegt in drei Größen darüber: 211 m, 23 m und 4,6 m. Sie
kippt die Normale, die das Licht sieht, und sprenkelt die Helligkeit
(± 13 %); woraus der Boden besteht (Fels, Schnee), entscheidet weiter
die glatte Normale. Voll bis 300 m, weg ab 2400 m, nicht auf Wasser. Die
Kachel ist am Boden verankert, nicht am Bildschirm oder Standpunkt:
`detailFrame(lon, lat)` rechnet in double, wo der Standpunkt in der
Kachel liegt; der Shader addiert die Mercator-Versätze, die er hat. Der
Maßstab gilt für den nächsten ganzen Breitengrad, damit Gehen das Muster
nicht dehnt. Drei Taps; die Anpassung an langsame Frames schaltet die
Körnung zusammen mit dem Dunstsaum ab.

**Nah-Ebene (`clipmap.ts DEFAULT_CLIPMAP`).** Tablet und Desktop
bekommen eine neunte Ebene, Pixel-Zoom 15: 3,3-m-Posten für den
Kilometer um den Standpunkt, wo Mapterhorn sie hat (an Mauritzalm,
Pertisau und Gornergrat vorhanden). Die Shader halten jetzt zwölf Ebenen
(`atlas.ts MAX_LEVELS`, in beide Dialekte injiziert): neun plus zwei
Fernrohr-Fenster, Atlas 1280 × 3840. Das Handy bleibt bei sechs.

**Rand der Abdeckung.** Der offene Punkt aus §8.ad: Hat die Quelle nur
einen Teil eines Fensters, wird der Rest aus der gröberen Ebene gefüllt
(zwischen ihren Posten gemischt) und die Ebene gezeigt, statt sie ganz
wegzulassen. Nur wenn die gröbere Ebene das Fenster wirklich überdeckt;
fehlt alles, bleibt die Ebene wie bisher draußen.

Tests rot → grün: `surface.test.ts` (neu: gleichmäßiger Hang, Kegel
≤ 1°, Knick bleibt Knick, Mulde dunkler als Grat, Rauschen ≤ 3°),
`detail.test.ts` (neu: Kachel ohne Naht, Mittel neutral,
Steigungskanäle; derselbe Fleck hat von zwei Standpunkten dieselbe
Körnung; Ausblendung), `clipmap.test.ts` („how finely heights are
held“, neun Ebenen, „where the source has only part of a window, the
rest is filled from the coarser level“, „…but only from a coarser level
that reaches across the window“), `heightfield.test.ts`, `wgsl.test.ts`
(Flächen-Atlas, Körnung, Ebenenzahl in beiden Dialekten),
`shading.test.ts` (Mulden-Term, Körnung ändert das Licht, nicht das
Material), `app.spec.ts` („through the telescope a face is one surface,
not a chequerboard of DEM cells“: Helligkeitssprung zwischen
Nachbarpixeln 0,022 → unter 0,008; „the ground below you has grain, and
it lies on the ground“ in zwei Blickrichtungen: jeder Messpunkt hat die
Helligkeit, die die Formel für seinen Fleck Boden sagt). Golden einmal
neu.

Ein Test war zuerst sofort grün und wurde verworfen: die Streuung der
Helligkeit in einem Fenster der Kegelflanke. Der Kegel ist dafür zu
glatt; was das Schachbrett ausmacht, ist der Sprung an der Zellgrenze.

Messung: 364 Unit-Tests grün; volle E2E-Suite 78/78 grün in 10,7 min.
Im ersten Lauf war ein Test rot, und zu Recht: „the standpoint menu
writes the place into the URL“ zählte an der Zugspitze fünf Ebenen ohne
Daten; mit dem Auffüllen vom Rand sind es die drei feinsten, die
wirklich keine Kachel haben. Die Erwartung ist angepasst. Bilder: am
Matterhorn (Bildwinkel 14°) ist das Schachbrett weg, Schneefelder und
Wände sind zusammenhängende Flächen; an der Mauritzalm liest sich die
Wiese als Boden.

Offen: `mesh.lookRange` und `align.horizonProfile` marschieren weiter
selbst (§8.ae). Die WGSL-Fassung des Flächen-Atlas und der Körnung ist
in CI nur als Text geprüft; bitte einmal `?backend=webgpu` ansehen.

### 8.ah Plan 4, Etappe 6: Landbedeckung (2026-11-12)

**Befund vorher.** Die Farbe kam allein aus Höhenstufe und Hangneigung:
bis 1100 m „Wald“, darüber „Wiese“, darüber Fels, ab der Schneegrenze
weiß. Die Haidachstellwand war ein grüner Hügel, der Gornergrat ein
Schneefeld, ein Tal ohne Wald so grün wie eines mit.

**Daten.** ESA WorldCover 2021 v200 (10 m, CC BY 4.0): Wald, Gebüsch,
Grasland, Acker, Siedlung, Fels und Schutt, Schnee und Eis, Wasser,
Feuchtgebiet, Moos. `tools/build_landcover.mjs` liest die
40-m-Übersichten der 3°-GeoTIFFs aus dem öffentlichen Bucket (je 5 s,
über Range-Requests), tastet sie viermal feiner ab als die Zielkachel,
reduziert zweimal nach Mehrheit und nimmt einzelne Streupixel heraus
(`despeckle`: Linien und Kanten bleiben). Ergebnis: eigene Kacheln unter
`public/landcover/{z}/{x}/{y}.png`, 512 px, 4-Bit-Graustufen (der
Klassenindex 0 bis 11 je Pixel), Pixel-Zoom 10 bis 7, die gröberen Stufen
als Mehrheit der feineren; `index.json` nennt Quelle und Lizenz. Kacheln
ohne Klasse (Meer außerhalb) werden nicht geschrieben.

Abweichung vom Plan: feinste Stufe ist Pixel-Zoom 10 (106 m bei 47°
Nord), nicht 11. Gemessen wären es mit 53 m 35 MB für die Alpen-Box
(5°–17° Ost, 43°–49° Nord), mit 106 m sind es 10,9 MB in 373 Kacheln:
im Rahmen der Schätzung (5 bis 20 MB) und in der Größenordnung der
Gipfel- und Seenkataloge. PNG-Zeilenfilter bringen bei Klassenkarten
nichts (gemessen: ohne Filter am kleinsten).

**Zur Laufzeit (`sources/landcover.ts`).** Wie die Seemaske: je
Clipmap-Ebene um den Beobachter die Klasse je Posten. Eine Ebene auf
einem Zoom der Kacheln liest sie eins zu eins, eine feinere liest den
feinsten Zoom, jedes Kachelpixel über die Posten gespreizt, die es
deckt. Rund zwanzig kleine Kacheln je Standpunkt. Die Klasse liegt im
freien vierten Kanal des Höhen-Atlas (sechzehn je Klasse), neben Höhe
und Seemaske; der Shade-Pass braucht einen Tap mehr. Bis die Kacheln da
sind, wird eine Ebene ohne Klasse gezeichnet, nie mit den Klassen des
alten Fensters.

**Farbe (`shading.ts COVER`).** Wo die Erhebung eine Klasse nennt,
ersetzt deren Farbe den Ton der Höhenstufe: Wald dunkelgrün, Gras im Tal
grün und ab 1400 m bis 2100 m fahler, Acker gelbgrün, Siedlung grau,
Fels grau, Eis weiß auch unter der Schneegrenze, Wasser in der Seefarbe
(Flüsse und Seen ohne Katalogeintrag). Fels am Steilhang liegt wie
bisher darüber. Der Schnee der Höhenstufe gilt voll nur noch, wo es
keine Klasse gibt oder die Klasse Eis ist; Boden, den die Erhebung
kennt, behält 30 % davon: der Gornergrat ist Fels, das Matterhorn eine
graue Pyramide mit Schneeflecken. Ohne Klasse (außerhalb der Box, vor
dem Laden) bleibt alles wie vorher.

**Kanten.** 106-m-Pixel wären im Nahbereich Treppen. Wo die Klasse
gelesen wird, verschiebt die Körnung aus E5 (Steigungskanäle der groben
und der feinen Kachel, bis etwa 50 m): die Grenze zwischen Wald und
Wiese franst aus, statt in Stufen zu laufen. In der Ferne mittelt der
Sampler die Körnung weg und nichts verschiebt sich.

**Quellen.** „ESA WorldCover“ steht im Quellen-Panel, in README und
THIRD-PARTY-NOTICES. `geotiff` ist nur Build-Abhängigkeit.

Tests rot → grün: `landcover.test.ts` (neu: Klassen und ihre Reihenfolge
gleich der Palette, Mehrheit, 4-Bit-PNG hin und zurück, Kachelbereich,
`mercatorTile`, `despeckle`; zur Laufzeit: eins zu eins, gespreizt,
fehlende Kachel, jede Kachel einmal, Dekodierung), `shading.test.ts`
(Wald dunkler und grüner als Wiese, Gras mit der Höhe fahler, Eis unter
der Schneegrenze, Fels über ihr mit Schneeanteil, Wasserklasse, ohne
Klasse wie vorher, `coverJitter`), `wgsl.test.ts` („both dialects read
the class from the atlas's alpha channel…“), `redraw.test.ts`
(`coverVersion`), `state.test.ts` (`cover`), `app.spec.ts` („where the
land cover says forest the ground is forest, where it says meadow,
meadow…“ gegen die Testlandschaft mit einem Wald- und einem Wiesenstück,
Abweichung von der Formel 0,065 → unter 0,02; „credits name…“ mit ESA
WorldCover). Alle E2E-URLs zeigen auf die Kacheln der Testlandschaft,
nie auf die der Alpen.

Messung: 388 Unit-Tests grün; volle E2E-Suite 79/79 grün in 12,8 min.
Backen der Alpen-Box: 4 bis 5 Minuten, 10,9 MB. Bilder: an der
Mauritzalm und über dem Achensee stehen die Hänge im Wald, die Almen
sind hell; am Gornergrat ist der Grat Fels, die Gletscher sind weiß, im
Vorfeld liegt ein Gletschersee.

Offen: Am Ufer des Achensees stehen sich Seemaske (genau) und
Wasserklasse (106 m, ausgefranst) gegenüber; am Gegenufer bleibt ein
unruhiger Saum. Die Kanten von Schneeflecken sind gezoomt gepunktet.

### 8.ai Plan 4, Etappe 7: Standort-Komfort (2026-11-13)

**Befund vorher.** Die Labels im Bild sind die wenigen, die Platz
finden: „Wo ist von hier der Großglockner?“ hatte keine Antwort, wenn
sein Label keinen Platz bekam oder ein Grat davorstand. Der Standort
wurde einmal geholt und blieb; wer weiterging, musste neu orten. Und auf
einem Gipfel lag der Fix ein paar Meter neben der Spitze, die halbe
Aussicht hinter der eigenen Kuppe.

**Gipfel suchen (`core/find.ts`).** Leistenknopf „Gipfel suchen“: ohne
Eingabe die Liste dessen, was von hier zu sehen ist, das Auffälligste
zuerst (der Rang, nach dem auch die Labels vergeben werden); mit Eingabe
alles im Umkreis, dessen Name sie enthält, auch Verdecktes und Seen.
Groß- und Kleinschreibung, Akzente und ß zählen nicht. Namensanfang vor
Sichtbarem vor Nahem. Ein Treffer wird gesucht: die Ansicht dreht sich
zu ihm (außer die Sensoren steuern), er wird im Bild markiert (Ring und
Name, auch wenn verdeckt: „(verdeckt)“), und liegt er außerhalb des
Bilds, zeigt ein Pfeil auf einem Kreis um die Bildmitte hin, mit
Gradzahl („60° rechts“). Die Karte sagt „von hier verdeckt“; ihr
Schließen beendet die Suche. Das Gesuchte hängt an der Id, überlebt also
den Neuaufbau der Ziele.

**Einrasten (`core/stand.ts summitUnder`).** Liegt ein Gipfel des
Katalogs innerhalb dessen, wofür der GPS-Fix gut ist (seine Genauigkeit,
mindestens 15 m, höchstens 60 m), steht man auf dem Gipfel: der
Standpunkt wird dorthin gesetzt, der HUD sagt „Auf dem Gipfel: …“. Nur
bei einem Fix des Geräts, nie bei Kartenwahl oder URL; nie bei einem
groben Fix (über 100 m); nie auf einen See.

**Mitlaufen (`core/stand.ts FollowFilter`, `mapPicker.ts watchDevice`).**
Schalter im Standpunkt-Panel. Das Gerät meldet laufend Fixes; der
Standpunkt folgt, wenn ein Fix weiter als zehn Meter und weiter als
seine halbe Genauigkeit vom jetzigen Standpunkt liegt (ein grober Fix
etwas daneben ist derselbe Ort, schlechter gesehen), und frühestens zwei
Sekunden nach dem letzten Versetzen. Ein Fix, der nur zu früh kam, wird
nach der Wartezeit noch einmal angeboten: ein Gerät, das danach
stehenbleibt, schickt keinen weiteren (das fand der E2E-Test). Ein
Standpunkt, der anders gewählt wird (Karte, Ort, URL, Foto), beendet das
Mitlaufen. Eine Verweigerung beendet es mit der bekannten Hilfe; ein
ausbleibender Fix (Wald) nicht. Die Clipmap-Fenster haben ihre Hysterese
aus E2, die Körnung liegt am Boden (E5): unterwegs wird wenig nachgeladen
und nichts schwimmt.

**Karte.** Kam der Standpunkt vom Gerät, zeigt die Karte den
Genauigkeitskreis um ihn.

**GPS-Höhe.** Nur im Check-Panel („wie das Gerät sie meldet, nur zur
Kontrolle“). Android liefert die Höhe über dem Ellipsoid, in den Alpen
rund 50 m neben der Landeshöhe; das Auge steht weiter auf dem
Geländemodell.

Tests rot → grün: `find.test.ts` (neu: `foldName`, `searchTargets`,
`pointerTo`, `pointerSpot`), `stand.test.ts` (neu: `summitUnder`,
`snapRadius`, `FollowFilter` mit Wackeln, Gehen, Mindestabstand, grobem
Fix, „a move that comes too soon is not lost“), `locate.test.ts`
(`watchDevice`, Höhe), `labels.spec.ts` („finding a summit: the panel
lists what is in sight; a hidden summit is found by name and marked
hidden; a tap looks at it, and once the view has turned away an arrow
points back“), `map.spec.ts` („a fix within its accuracy of a summit
stands on the summit, and the app says so“ mit Genauigkeitskreis,
„"Mitlaufen" keeps the standpoint on the device: it follows a walk, not
a wobble, and a standpoint chosen by hand ends it“). Als
Charakterisierung (vorher und nachher grün): „two hundred metres from
the top one stands where the fix says“.

Messung: 412 Unit-Tests grün; volle E2E-Suite 83/83 grün in 11,6 min.

Offen: Der Pfeil kann über einem Label stehen (er nimmt am Layout nicht
teil). Eingerastet wird auf die Katalogposition, nicht auf die Spitze
des Geländemodells; der freie Blick (E3) hebt das Auge über die Kuppe.

### 8.aj Plan 4, Etappe 8: Luftbild-Stil (2026-11-13)

**Wunsch.** „Vielleicht Tiles drauflegen“: neben dem Relief ein Stil, in
dem das Gelände die Farbe eines Luftbilds trägt.

**Daten und Lizenz.** Das einzige Luftbild der ganzen Alpen ohne
Schlüssel ist Sentinel-2 cloudless von EOX (10 m). Der Kacheldienst
weist in seinen Capabilities die Mosaike 2016 und 2017 als CC BY 4.0
aus („EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH
(Contains modified Copernicus Sentinel data 2017)“); die späteren
Jahrgänge sind es nicht. Genutzt wird 2017
(`s2cloudless-2017_3857`, 256-px-JPEG, CORS offen). Es ist EOX'
Demo-Dienst: mit Rate-Limit und ohne Zusage. Deshalb ist hier nichts ein
Fehler: was nicht kommt, bleibt Relief.

**Laufzeit (`sources/imagery.ts`).** Je Clipmap-Ebene um den Beobachter
wird das Bild in halber Auflösung der Ebene gelesen: ein Bildpixel für
zwei Posten je Richtung, aus den Kacheln einen Zoom unter der Ebene und
nie feiner als Zoom 13 (13 m bei 47° Nord, mehr sieht der Satellit
nicht). Das sind vier bis neun kleine Kacheln je Ebene. Eine Kachel, die
fehlt oder scheitert, ist im Bild durchsichtig (Alpha 0). Geladen wird
nur im Luftbild-Stil.

**Bild (`shading.ts AERIAL`, beide Shader-Dialekte).** Ein dritter
Atlas (RGBA, vom Sampler zwischen den Pixeln gelesen, eine Zelle je
Ebene wie im Höhen-Atlas, halb so groß). Wo eine Kachel Farbe gab, ist
das Foto der Boden: kein Fels, Schnee oder Klassenfarbe darüber. Das
Mosaik ist dunkel gegen die Relief-Palette, also wird jeder Kanal als
1 − (1 − c)^1,6 angehoben: Wald und Schatten heller, Schnee kann nicht
ausfressen. Das Foto hat sein eigenes Licht; das Relief-Licht liegt nur
zur Hälfte darüber, genug für die Form. Ein Satellitenpixel misst 13 m,
vor den Füßen wäre das Bild eine Farbfläche: die Körnung aus E5 bleibt
mit halber Stärke. Dunst, Linien und Seeglanz wie im Relief. Der Stil
ist ein Uniform, keine Shader-Variante.

**Bedienung.** „Darstellung“: Relief, Luftbild, Linien; das Gerät merkt
sich die Wahl. Im Luftbild-Stil nennt die Fußzeile „Luftbild © EOX,
Copernicus Sentinel 2017“, das Quellen-Panel den vollen Vermerk.
`?imagery=` setzt eine andere Kachelbasis (Tests, lokaler Cache);
`tools/cache_tiles.mjs` holt die Bildkacheln mit.

Abweichung vom Plan: „ab Tablet“ entfällt. Das Bild ist je Ebene
320 × 320 Pixel (0,4 MB), auf dem Handy sechs Ebenen; es wird nur
geladen, wenn der Stil gewählt ist.

Tests rot → grün: `imagery.test.ts` (neu: Zoom je Ebene, eins zu zwei
gelesen, Nah-Ebene vergrößert, fehlende Kachel durchsichtig, jede Kachel
einmal, Fehler ist „kein Bild“), `shading.test.ts` („the aerial
picture“: Farbe des Fotos mit Aufhellkurve, halbes Licht, halbe Körnung,
nichts vom Relief darüber, ohne Bild das Relief), `wgsl.test.ts` („both
dialects read the picture from its own atlas, by a switch that is a
uniform…“), `state.test.ts` (drei Stile, `imagery`), `redraw.test.ts`
(`imageryVersion`), `app.spec.ts` („"Luftbild" lays the satellite
picture over the terrain: each spot takes the picture's colour there,
lit softly; the source is named; "Relief" takes it off again“ gegen ein
zweifarbiges Testbild, Abweichung 0,60 → unter 0,03; „where no picture
comes, the aerial style is the relief“). Alle E2E-URLs zeigen auf die
Bildkacheln der Testlandschaft, nie auf den Dienst.

Messung: 423 Unit-Tests grün; volle E2E-Suite 85/85 grün in 12,4 min.
Bilder mit echten Kacheln (lokal zwischengespeichert): am Gornergrat
Gletscher, Fels und Moränen wie auf dem Satellitenbild, über dem
Achensee bewaldete Hänge, an der Mauritzalm die Almwiesen.

Offen: Das Mosaik hat die Schatten des Aufnahmetags und im Hochgebirge
Altschnee; es ist ein Bild von 2017. Ob der Demo-Dienst die Last einer
öffentlichen Seite trägt, zeigt der Betrieb; fällt er aus, bleibt das
Relief.

### 8.ak Dreimal weiter hineinzoomen (2026-11-13)

**Wunsch.** Weiter hineinzoomen können, „nochmal dreimal so weit“. Der
Zoom endete bei einem Bildwinkel von 8° (vertikal); jetzt bei 2,7°
(`gestures.ts MIN_FOV`). Ein Pixel ist dort 0,0045°: 80 cm in 10 km.

Der Grenzwert allein hätte nicht gereicht:

- **URL.** `formatHash` schrieb Richtung und Neigung auf 0,1° und den
  Bildwinkel ganzzahlig. Bei 2,7° ist 0,1° schon 22 Pixel, und aus 2,7°
  wäre 3° geworden. Jetzt Hundertstel Grad und der Bildwinkel unter 10°
  mit einer Nachkommastelle (ohne angehängte Nullen; ab 10° ganzzahlig
  wie bisher). `readHash` kappt bei 2,7° statt bei 5°.
- **Band im Fernrohr (`mesh.ts bandFor`).** Das dichte Band von Ringen um
  die angeschaute Entfernung reichte fest vom 0,8- bis zum 1,56-Fachen.
  In 20 km sind das 15 km auf höchstens 405 Ringe (Handy): 37 m Abstand,
  wo das Gelände 13-m-Posten hat. Unter 8° wird die Stufe der
  Quantisierung, und mit ihr das Band, im Verhältnis des Bildwinkels
  schmaler (`1 + 0,25·fov/8`, der Bildwinkel auf Viertel-Oktaven
  gerastet, damit etwas Zoomen die Ringe so wenig verschiebt wie etwas
  Schwenken). Bei 2,7° sind die Ringe in 20 km wieder 13 m auseinander.
- **Anzeige.** Der HUD zeigt den Bildwinkel unter 10° mit einer
  Nachkommastelle.

Gesten, Rad und Tasten skalieren mit dem Bildwinkel, das Label-Raster
arbeitet in √2-Stufen des Bildwinkels: dort war nichts zu tun.

Was sich nicht ändert, ist die Auflösung der Daten: 13-m-Posten auf dem
Handy, 6,6 m im Fernrohr-Fenster auf Tablet und Desktop. Die glatten
Normalen aus E5 halten das Bild ruhig, aber mehr Einzelheiten, als das
Geländemodell hat, zeigt auch der tiefere Zoom nicht.

Tests rot → grün: `gestures.test.ts` („the zoom ends at 2.7°, three
times closer than the 8° it used to end at; the wheel and the plus key
stop there“), `state.test.ts` (Hash mit `fov=2.7` gelesen, darunter
gekappt; „zoomed in, a link holds the view to the pixel…“),
`mesh.test.ts` („zoomed in below 8° the band narrows with the field of
view: the rings stay a post apart when a pixel is a metre“),
`labels.spec.ts` („the wheel zooms in to 2.7°…; the Testhorn label sits
on the apex as drawn, and a reload shows the same picture“).

Messung: 426 Unit-Tests grün; volle E2E-Suite 86/86 grün in 11,8 min.
Bild mit echten Kacheln: vom Gornergrat füllt der Gipfelaufbau des
Matterhorns (10 km) bei 2,7° das Bild, mit sauberer Silhouette; in der
hohen Qualität mit sichtbar mehr Einzelheiten.

### 8.al Fernrohr-Fenster: verschachtelt und eingeblendet (2026-11-13)

**Beobachtung des Benutzers.** Stark gezoomt (SO 137°, 2,7°, Standpunkt
47.6394/11.3761) wird das Gelände erst grob gezeichnet und springt dann
auf fein; das Feine liege „viel höher, das passt nicht genau“. Verdacht:
Rundungsfehler.

**Befund (gemessen mit echten Kacheln).** Kein Rundungs- oder Lagefehler:
Über demselben Boden liegt das feine Fenster (Zoom 14, 6,4-m-Posten) im
Mittel 0,1 m neben der Ebene, die das Auge in 15 km zeichnet (Zoom 11,
51-m-Posten), Streuung 4,7 m. An Graten aber bis +20 m und −36 m: die
grobe Ebene mittelt Spitzen weg. Bei 2,7° sind 20 m in 15 km rund 17
Pixel; im Bild lag der Kotzen-Gipfel (16 km) ohne Fenster 22 Pixel
tiefer. Der Sprung war also echt, er kam aus den Daten. Dazu ein
wirklicher Fehler: Das feinste Fenster wurde an seinem Rand (80 bis 95 %
der halben Breite) in die Ebene des **Auges** überblendet, obwohl das
gröbere Fenster darum herum den Boden feiner hatte. Am Rand entstand so
ein Ring, in dem der Grat auf die grobe Höhe absackte: die kleine Stufe
im Grat rechts im Bild.

**Umsetzung.**

- **Verschachtelt.** Die Fenster liegen übereinander, jedes mit seinem
  Anteil (`lookShare` in GLSL und WGSL, für Höhe, Flächennormale und
  Wasser; auf der CPU `HeightField.looksAt` und `mesh.ts vertexHeight`).
  Der Rand des feinen Fensters läuft jetzt in das gröbere Fenster aus.
  Die CPU legt von grob nach fein; die Shader rechnen dasselbe von fein
  nach grob („das feinste nimmt seinen Anteil, das nächste seinen Anteil
  am Rest“) und nur über die ersten drei Ebenen (`atlas.ts MAX_LOOK`),
  mit Abbruch, sobald nichts mehr übrig ist. Die erste Fassung, eine
  Schleife über alle zwölf Ebenen, kostete im Software-Renderer der Tests
  fast das Doppelte je gezoomtem Bild (435 statt 235 ms); jetzt 255 ms.
- **Drittes Fenster.** `DEFAULT_CLIPMAP.look` = Zoom 14, 13, 12 (Handy
  13, 12, 11), jedes doppelt so breit wie das innere. Mit den neun Ebenen
  des Auges sind das genau die zwölf, die die Shader halten
  (`MAX_LEVELS`). `setLook` füllt das weiteste zuerst: Das Bild wird in
  Stufen von je einem Zoom schärfer statt in einem Sprung über drei.
- **Eingeblendet.** `core/lookfade.ts LookFade`: Ein Fenster, das zum
  ersten Mal zeigt (oder um anderen Boden geschnitten wurde, oder nach
  dem Absetzen des Fernrohrs wiederkommt), steigt in 350 ms von 0 auf 1
  (`Level.weight`, weich an- und auslaufend), je Bild höchstens um ein
  Viertel des Wegs (`LOOK_FADE_STEP`): Das Bild, in dem ein Fenster
  ankommt, ist selbst ein langsames (Kacheln packen, Atlas hochladen),
  und nach der Uhr allein wäre der Anstieg halb vorbei, bevor etwas
  davon gezeichnet ist. Folgt es nur dem Blick
  (die Mitte des alten Schnitts liegt noch im neuen), behält es sein
  Gewicht: Was fein war, bleibt fein. Der Renderer gibt das Gewicht
  negiert in `uLvlA.w` an die Shader und führt es im Fingerabdruck des
  Bildes, damit die Bilder des Anstiegs gezeichnet werden. Die
  Label-Nadeln werden gesetzt, wenn die Fläche zur Ruhe gekommen ist,
  nicht dazwischen; die Bilder des Anstiegs zählen nicht in die
  Laufzeit-Anpassung (sie werden in voller Auflösung gezeichnet).
  `?fade=0` (`AppOptions.fade`) zeigt die Fenster sofort: Die E2E-Tests
  setzen es, weil der Anstieg rund 25 Bilder je gezoomter Seite sind (im
  Software-Renderer zehn Sekunden); ein eigener Test prüft ihn.

Was bleibt: Wo das Fenster beim Mitschwenken neuen Boden erreicht, wird
dieser Streifen ohne Anstieg fein (dort greift nur die Überblendung am
Fensterrand). Und der Unterschied selbst bleibt: Was fern grob gezeichnet
wird, ist niedriger als in Wirklichkeit, bis das Fernrohr es holt.

Tests rot → grün: `mesh.test.ts` („windows nest: at the fine window's
edge the height runs into the coarser window's, not down to the eye
level's and up again“, „a window that is still fading in is drawn by its
weight“), `lookfade.test.ts` (sieben Tests: Anstieg, „a hitch does not
swallow the rise“, Mitschwenken behält das Gewicht, anderer Boden
beginnt neu, Wiederkehr beginnt neu, Dauer 0 zeigt sofort, jedes Fenster
auf eigener Uhr), `clipmap.test.ts` (drei Fenster je
Konfiguration; „the windows arrive the coarsest first“), `wgsl.test.ts`
(„both dialects lay the look levels over the eye's, the coarsest
first, each by its share“), `redraw.test.ts` (Gewicht im
Fingerabdruck), `labels.spec.ts` („zoomed in, the telescope cuts its
fine windows around the Testhorn…“: drei Fenster, alle aufgestiegen,
der Gipfel dort, wo die Formel ihn hinlegt; gegen den alten Stand rot;
neu „a window of the telescope rises into the picture instead of
jumping“: rot mit `fade=0`, grün mit dem Anstieg), `state.test.ts`
(`fade=0`), `app.spec.ts` (Atlas 1280×3200 mit dem dritten Fenster).

Messung: 438 Unit-Tests grün; volle E2E-Suite 87/87 grün in 11,0 min
(vorher 11,8). Bild mit echten Kacheln am Standpunkt
des Benutzers: die Stufe im Grat des Grammersbergs am rechten Bildrand
ist weg; 8,1 statt 7,5 MB Gelände im Speicher.

### 8.am Gezoomt: Ringe und Fenster nach dem, was im Bild ist (2026-11-13)

**Beobachtung des Benutzers.** Am Standpunkt 47.6394/11.3761 bei 3,2°
zeigen SO 137° und SO 136° „eine ganz andere Bergform“; er vermutet
einen systematischen Fehler, den §8.al nicht behoben hat. Er hatte
recht, und es waren zwei.

**Befund (echte Kacheln, `q=high`).**

| | SO 137° | SO 136° |
|---|---|---|
| Bildmitte trifft das Gelände in | 15,7 km | 24,5 km |
| dichtes Band der Netzringe | 13,4–18,1 km | 22,2–29,9 km |
| Ringabstand in 16 km (Kotzen) | 7 m | 210 m |
| Ringabstand in 26 km (Montscheinspitze) | 340 m | 11 m |
| Daten der Montscheinspitze | 102-m-Raster | 6,4-m-Fenster |

1. **Das Netz.** Gezoomt lag ein einziges dichtes Band von Ringen
   (`mesh.ts bandFor`) um die Entfernung, in der der Mittelstrahl das
   Gelände traf; der Rest des Bildes hatte Ringe im Abstand von 1,2 % der
   Entfernung. Ein Grat zwischen zwei Ringen wird um Hang × halber
   Abstand zu niedrig gezeichnet: Die Montscheinspitze stand bei 137°
   45 px unter dem Kotzen, bei 136° 15 px darüber.
2. **Die Daten.** Auch die drei feinen Fenster lagen um den Punkt der
   Bildmitte (§8.al). Der Berg daneben kam aus dem Raster des
   Standpunkts: ein runder grüner Buckel statt eines Felsgipfels, weil
   das grobe Raster keine steilen Hänge kennt.

**Umsetzung.** Was fein gezeichnet wird, hängt jetzt davon ab, was das
Bild zeigt, nicht davon, wohin seine Mitte zeigt.

- **Scan (`render/framescan.ts`).** Die Entfernung ist in feste
  logarithmische Fächer geteilt (2,5 %). 25 Strahlen über den
  Bildausschnitt (Peilungsbogen, Höhenwinkel aus dem neuen
  `camera.elevationSpan`, ein Viertel Rand) geben jedem Fach eine
  Klasse (nicht im Bild, im Bild aber verdeckt, sichtbar; Sichtbares um
  ein Fach erweitert) und einen **Bedarf**: um wie viel die Horizontlinie
  des Strahls in diesem Fach innerhalb des Bildes steigt (Tangens des
  Höhenwinkels, der größte aller Strahlen). Das ist die Bildhöhe, die
  dort neu sichtbar wird. Gescannt wird nicht der Ausschnitt selbst,
  sondern seine Zelle auf einem festen Raster aus Peilung, Neigung und
  Zoom (`scanBox`: Spannen auf einer √2-Leiter aufgerundet, Mitte auf ein
  Viertel der Spanne): Dieselbe Ansicht gibt denselben Scan, wie immer
  man hingekommen ist. `FrameScanner` scannt je Zelle und Geländestand
  einmal, in Scheiben von 3 ms je Bild, und behält die letzten sechs;
  bis ein neuer Scan fertig ist, gilt der alte.
- **Ringe (`mesh.ts ringTable`, ersetzt `bandFor`).** Ein Fach bekommt
  so viele Ringe, wie es Bildzeilen neu sichtbar macht, einen je zwei
  Pixel (mit Ringen übrig je einen). Zwischen zwei Ringen ist die Fläche
  eben, ein Grat dazwischen wird also höchstens um ihren Abstand **auf
  dem Bildschirm** zu niedrig gezeichnet, wo immer er im Bild steht.
  Gelände im Bild bekommt mindestens einen Ring je Fach, der Rest einen
  je 5 % der Entfernung. Reicht die Ringzahl nicht, werden die Pixel je
  Ring für alle Fächer gemeinsam gestreckt (Schritte 2^⅛). Die Ringe
  eines Fachs liegen auf einem Raster im Logarithmus der Entfernung
  (Abstand auf einer Leiter von 2^¼), damit ein Stück Boden seine Ringe
  behält, wenn sich anderswo etwas ändert.
  Der erste Entwurf maß den Bedarf in „Pixeln am Boden“ je sichtbarem
  Fach. Das war das falsche Maß: Eine flache Ebene im Bild (E2E-Test
  „two ridges 10 % apart“) nahm neun von zehn Ringen, obwohl sie nur
  die halbe Bildhöhe füllt, und den Graten dahinter blieben 72 m
  Abstand; am Standpunkt des Benutzers waren es 20 m in 16 km.
- **Shader.** `radiusAt` liest den Radius je Ring aus einer Textur
  (`rings`, Ringe × 1, RGBA8, drei Byte Logarithmus, `encodeRings`;
  Auflösung 7·10⁻⁷) statt aus der Drei-Segment-Formel, in GLSL und
  WGSL; `uRadial`/`uRadialB` entfallen, `uRing` kommt. Das weite Netz
  (Bildwinkel ab 30°) hat dieselben Ringe wie bisher, nur über die
  Tabelle (`ringsOf`).
- **Fenster (`mesh.ts lookRanges`, `clipmap.ts setLooks`).** Die
  Fenster liegen hintereinander entlang der Bildmitte auf dem, was der
  Scan als sichtbar meldet: das feinste auf dem nächsten sichtbaren
  Boden jenseits der Reichweite der eigenen Ebene gleichen Zooms, das
  nächste dahinter, Verdecktes übersprungen. Ein Fenster bedient die
  Tiefe, die es mit vollem Gewicht zeichnet (80 % seiner Breite, weniger
  ein Achtel). Die Fenstermitte rastet auf ein Achtel der Fensterbreite
  ein (`LOOK_STEP`) statt dem Blick mit Nachlauf zu folgen: Wo ein
  Fenster liegt, hängt nur vom Punkt ab. Eine Lage, die sich nicht
  füllen ließ (Kachel fehlt), wird nicht in jedem Bild neu angefragt.
  Ohne Scan (Blick steil nach oben oder unten) liegen die Fenster wie
  bisher auf dem Punkt der Bildmitte.
- **Viewer.** `aimTelescope` setzt `renderer.rings` und die Fenster aus
  dem Scan; ändern sich die Ringe, werden die Label-Nadeln neu gesetzt;
  `status().peaks.settled` wartet auf einen laufenden Scan, auf Fenster
  unterwegs und auf ihr Einblenden.
- **Dieselbe Ansicht, dasselbe Bild.** Der erste Stand dieses Schritts
  behielt Scan und Fensterlage, solange das Bild in der Nähe blieb
  (Nachlauf). Damit hing das Bild vom Weg ab: In CI stand der Gipfel
  nach dem Neuladen derselben Ansicht 3 px anders („the wheel zooms in
  to 2.7° … a reload shows the same picture“). Scan-Zelle und
  Fensterraster sind deshalb reine Funktionen der Ansicht.

**Ergebnis an den beiden Ansichten.** Fenster sind bei 137° und 136°
dieselben: 7–10 km (6,4 m), 10–17 km (12,8 m), 14–27 km (25,6 m). Die
Ringe liegen an den Graten dicht: Grammersberg (13 km) 3,5 m, Kotzen
(16 km) 7 m, Montscheinspitze (26 km) 14–17 m, in beiden Ansichten
(vorher 7 oder 210 m und 340 oder 11 m). Im Bild sind Montscheinspitze
und Kotzen in beiden Ansichten dieselben Berge auf derselben Zeile, nur
um den Schwenk verschoben.

**Was es kostet und was bleibt.**

- Ein ferner Berg in der Bildmitte war vorher aus feineren Daten
  gezeichnet, wenn nichts Näheres im Bild stand, das jetzt das feinste
  Fenster bekommt: Montscheinspitze 25,6 m statt 6,4 m. Zwei weitere
  Fenster (Atlas dreispaltig) würden das ausgleichen; nicht Teil dieses
  Schritts.
- Beim Schwenk in die nächste Scan-Zelle (ein Viertel der Bildbreite)
  können einzelne Fächer eine Stufe auf der Leiter wechseln: Ihre Ringe
  rücken dann, ein Grat um höchstens ein, zwei Pixel; zurück in der
  alten Zelle steht wieder das alte Bild.
- Der Scan tastet 25 Peilungen ab. Ein Streifen, den kein Strahl sieht,
  hat nur den Grundabstand (ein Ring je Fach).

Tests rot → grün: `framescan.test.ts` (neu: Fächer, sichtbar/verdeckt/
nicht im Bild, Erweiterung, „need: how much of the frame's height comes
into view…“, „a plain seen from above needs the frame's height once“,
„scanBox: … depends on the frame alone“, „the same frame gets the same
scan whatever was looked at before“, Scan in Scheiben, Wiederverwendung),
`mesh.test.ts`
(„zoomed in, a mountain is drawn with the same rings wherever the
centre of the view points“, „the ring table holds every row once“, „a
plain in the frame does not take the rings from the crests behind it“,
„terrain that reaches further than the scan did…“, „with too few rings
… all that is seen is drawn coarser alike“, „a stretch of ground keeps
its rings“, „few rows go to waste“, „the telescope's data windows lie
one behind the other“, „on a table rowAt inverts radiusAt“, „three
bytes of the logarithm“), `camera.test.ts` (`elevationSpan`),
`clipmap.test.ts` („each window can be cut around a point of its
own“, Fenstermitte auf dem Raster, „a window whose tiles are not there
is asked for once, not again with every frame“), `wgsl.test.ts` („both dialects read a ring's radius from the
table“), `labels.spec.ts` („zoomed in, a summit is drawn as the terrain
has it wherever it stands in the frame“: an drei Standpunkten, gegen
den alten Stand 7,3 px daneben; der Fernrohr- und der Einblend-Test an
die Fensterkette angepasst). Zwei E2E-Erwartungen hingen an Zufällen
und sind entschärft: die Hundertstel in der URL nach dem Nachgleiten
(„wheel zooms in to 2.7°“) und der Mittelwert über drei Spalten, wo
die Himmelslinie eine Zeile springt („two ridges 10 % apart“).

Messung: 461 Unit-Tests grün; volle E2E-Suite 88/88 grün in 11,6 min.
Scan 6–16 ms, verteilt auf
zwei bis drei Bilder; Bildzeit im Software-Renderer unverändert (265 ms
gezoomt, 290 ms weit).

## 9. Arbeitsweise: Test first, automatisiert, deterministisch

Seit 2026-09-20 verbindlich (Details in `CLAUDE.md`):

- **Red-Green-TDD** für jede Verhaltensänderung: Test schreiben, rot sehen,
  kleinste Implementierung, grün, Refactoring. Bestehendes bekommt zuerst
  Charakterisierungstests.
- **Unit** (`bun test`, `tests/unit/`): Geodäsie gegen den Shader-Spiegel,
  Clipmap-Fill für 256- und 512-px-Tiles, WGSL-Preprocessing aller drei
  Shader-Paare plus GLSL-Uniform-Parität, Heightfield, Tile-Quellen,
  URL-Zustand, Gestenmodell (reine Logik, pro Frame angewandt),
  Coverage-Index mit injizierbarem Fetcher.
- **E2E** (`@playwright/test`, `tests/e2e/`): die gebaute App in Chromium
  mit Software-WebGL2 gegen ein synthetisches Gelände aus einer Formel
  (Ebene 1500 m, „Testhorn“ 4000 m in 5 km, Grat 2600 m in 20 km). Erwartete
  Bildzeilen werden aus der Formel gerechnet und gegen den Range-Puffer
  geprüft; dazu Gesten (Maus, Rad, Tastatur, Touch-Pinch per CDP),
  URL-Roundtrip, Standpunktwechsel, Panels und ein Screenshot-Golden mit
  Toleranz. Kein Netz.
- **Daten** (`tests/data/`, nur manuell per Workflow): Live-Prüfung des
  Mapterhorn-Materials gegen `reference.json` (Format, Header, Losslessness,
  Gipfelhöhen mit Toleranz, Coverage-Index, Attribution).
- **CI** auf jedem Push: Typecheck, Unit, Build, E2E. Pages-Deploy nur nach
  grünem Check.

Die Inkremente 2 und 3 werden entsprechend geplant: erst die Tests für
Positionsquellen, Sensor-Fusion (peakviewer bringt `check_pose` mit, wird
nach `tests/unit/` portiert), Skyline-Matching (`check_align`, ebenso) und
Foto-Import, dann die Implementierung.

## 10. Risiken und offene Punkte

- **Tileserver ohne SLA.** Mapterhorn ist ein Community-Projekt auf
  Cloudflare. Gegenmaßnahme: IndexedDB-Cache, AWS-Terrarium als
  konfigurierbarer Fallback-Source, später eigener PMTiles-Ausschnitt der
  Alpen auf eigenem Hosting (Range-Requests, kein GitHub Pages wegen
  Dateigröße).
- **Safari dekodiert Tiles nicht bytegenau.** Auf dem iPad (Safari, Apple
  GPU, 2026-09-21) zerfiel das Gelände in Stacheln: `createImageBitmap`
  plus OffscreenCanvas liefert dort veränderte Bytes zurück, ein Byte im
  Rotkanal ist 256 m. Chrome auf demselben iPad und der alte Spike
  (`<img>` plus Canvas) waren sauber. Gegenmaßnahme in
  `sources/terrarium.ts`: beim Start dekodiert die Quelle eine 4×4-Probe
  mit bekannten Bytes über beide Pfade und nimmt den ersten exakten; das
  Check-Panel zeigt „Tile-Dekoder: exakt (image), bitmap ±771 m“ (gemessen auf dem iPad). Ohne Probe
  bliebe jeder neue Browser ein Blindflug.
- **Datenvolumen.** 8 Level mit 512-px-Tiles sind 6 bis 12 MB pro
  Standpunkt. Auf Mobil `QUALITY_LOW` mit 6 Leveln und coarse-first ist das
  erträglich, aber messen.
- **Mesh-Budget** (Abschnitt 4, Punkt 7) muss nach der Umstellung neu
  abgestimmt werden, sonst wird das Fernfeld schlechter als vorher.
- **WebGPU** ist in peakviewer nicht visuell verifiziert. WebGL2 bleibt
  Default, bis `check_gpu.mjs` mit dem Shading-Pass Bilder liefert.
- **Overpass-Limits** sprechen für den statischen Katalog in Inkrement 3.
- **Attribution.** CC-BY-4.0 verlangt Nennung. Die dynamische Liste aus
  dem Coverage-Index ist Pflicht, nicht Kür; OSM (ODbL) und Mapterhorn
  müssen sichtbar im UI stehen, nicht nur im Repo.
- **Kompassfehler** bleibt das größte Nutzerproblem im AR-Modus. Der
  Skyline-Fit von peakviewer ist die einzige bekannte OSS-Lösung dafür,
  daher ist er der Grund für die Wahl dieser Basis.
- **Freiflug/3D-Karte** ist explizit nicht Teil der drei Inkremente. Falls
  gewünscht: MapLibre-Karte als separater Modus, nicht in den
  Panorama-Renderer einbauen.

## 11. Reihenfolge und Aufwand (grob)

| Schritt | Aufwand |
|---|---|
| Inkrement 0: Spike auf iPad und Handy prüfen, Notiz schreiben | 0,5 bis 1 Tag |
| Repo-Setup, Engine übernehmen, Checks laufen | 1 bis 2 Tage |
| Mapterhorn-Umstellung inkl. Tuning | 2 bis 3 Tage |
| Shading-Pass, Himmel, Luftperspektive | 3 bis 5 Tage |
| Kamerasteuerung, Shell, Pages-Deploy (Inkrement 1 fertig) | 2 bis 3 Tage |
| Inkrement 2 | 4 bis 6 Tage |
| Inkrement 3 | 8 bis 12 Tage |

Erster konkreter Schritt: den Spike auf dem iPad und dem Handy gegen die drei
Kriterien aus Inkrement 0 prüfen. Danach peakviewer nach `src/engine/` übernehmen,
`bun run check` grün bekommen, dann `MapterhornSource` mit `tileSize`-Umbau
und den Matterhorn-Test aus Abschnitt 2.1 als automatisierten Check.
