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

## 9. Risiken und offene Punkte

- **Tileserver ohne SLA.** Mapterhorn ist ein Community-Projekt auf
  Cloudflare. Gegenmaßnahme: IndexedDB-Cache, AWS-Terrarium als
  konfigurierbarer Fallback-Source, später eigener PMTiles-Ausschnitt der
  Alpen auf eigenem Hosting (Range-Requests, kein GitHub Pages wegen
  Dateigröße).
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

## 10. Reihenfolge und Aufwand (grob)

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
