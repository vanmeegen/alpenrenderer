import { useEffect, useRef, useState } from 'react';
import { FIXED_CREDITS } from '../engine/core/attribution';
import { EYE_RADIUS, formatHash, PLACES, readHash, readOptions, ViewState } from './state';
import { PeakInfo, PhotoStatus, Viewer, ViewerStatus } from './viewer';
import { fmtRange } from '../engine/core/labels';
import { MapPanel } from './MapPanel';
import { PickedPosition } from './mapPicker';
import { CompassRose } from './CompassRose';
import { Icon, IconName } from './icons';

const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
const compass = (yaw: number) => COMPASS[Math.round(yaw / 45) % 8];
/** HUD buttons: a visible pressed state the instant the finger lands, no tap delay, no text selection. */
const BTN = 'rounded px-1 -mx-1 text-blue-700 underline-offset-2 hover:underline active:bg-blue-200 active:text-blue-950 touch-manipulation select-none';
const fmtBytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
/** "1,7 m" to a decimal while small, whole metres once the area lifted the eye far. */
const aboveGround = (m: number) => (m < 100 ? `${m.toFixed(1).replace('.', ',')} m` : `${Math.round(m)} m`);
/** Panels beside the rail: compact, and scrolling rather than running off a phone held sideways. */
const PANEL = 'pointer-events-auto min-h-0 shrink overflow-auto rounded-lg bg-white/90 px-3 py-2 text-[13px] text-neutral-800 shadow backdrop-blur';

/** One icon of the menu rail; the label is its accessible name and tooltip. */
function RailButton({ icon, label, onClick, pressed }: { icon: IconName; label: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}
      className={`flex h-8 w-9 items-center justify-center rounded text-blue-800 hover:bg-blue-100 active:bg-blue-200 active:text-blue-950 touch-manipulation select-none ${pressed ? 'bg-blue-100' : ''}`}>
      <Icon name={icon} />
    </button>
  );
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const [view, setView] = useState<ViewState>(() => readHash());
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'places' | 'credits' | 'check' | 'settings' | 'map'>('none');
  const [menuOpen, setMenuOpen] = useState(true);
  const [eyeRadius, setEyeRadius] = useState(EYE_RADIUS.initial);
  const [outline, setOutline] = useState(true);
  const [positionSource, setPositionSource] = useState<'url' | 'map' | 'gps' | 'place' | 'photo'>('url');
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [sensors, setSensors] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [labelsOn, setLabelsOn] = useState(true);
  const [camera, setCamera] = useState(false);
  const [lensFov, setLensFov] = useState(51);
  const [photo, setPhoto] = useState<PhotoStatus | null>(null);
  const [alignment, setAlignment] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [peak, setPeak] = useState<PeakInfo | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    let viewer: Viewer | null = null;
    let cancelled = false;
    let hashTimer = 0;
    const opt = readOptions();

    Viewer.create(canvas, opt, readHash(), overlayRef.current).then((v) => {
      if (cancelled) { v.dispose(); return; }
      viewer = v;
      viewerRef.current = v;
      let lastStatus = 0;
      v.onStatus = (s) => {
        const now = performance.now();
        if (now - lastStatus > 250) { lastStatus = now; setStatus({ ...s }); }
      };
      v.onSelect = (p) => setPeak(p);
      v.onView = (nv) => {
        setView(nv);
        clearTimeout(hashTimer);
        hashTimer = window.setTimeout(() => {
          history.replaceState(null, '', formatHash(nv));
        }, 300);
      };
      setEyeRadius(v.eyeRadius);
      v.start();
      // Debug handle for the console and for headless checks.
      (window as unknown as Record<string, unknown>).alp = v;
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));

    const onHash = () => { void viewer?.relocate(readHash()); };
    window.addEventListener('hashchange', onHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', onHash);
      viewer?.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const v = viewerRef.current;
    if (v) { v.renderer.outline = outline ? 0.35 : 0; v.showLabels = labelsOn; }
  });

  const go = (id: string) => {
    const p = PLACES.find((x) => x.id === id);
    if (!p) return;
    void viewerRef.current?.relocate({ lon: p.lon, lat: p.lat, alt: undefined, yaw: p.yaw, pitch: 0, fov: 60 });
    setPositionSource('place');
    setPanel('none');
  };

  /** From the map or the GPS: stand there on the ground, keep looking the same way. */
  const pick = (p: PickedPosition) => {
    void viewerRef.current?.relocate({ lon: p.lon, lat: p.lat, alt: undefined });
    setPositionSource(p.source);
    setGpsAccuracy(p.source === 'gps' ? p.accuracy ?? null : null);
    setPanel('none');
  };

  /** Follow the device's sensors, or stop. A refusal is shown, not thrown. */
  const toggleSensors = async () => {
    const v = viewerRef.current;
    if (!v) return;
    setNote(null);
    if (sensors) { v.stopSensors(); setSensors(false); return; }
    try {
      await v.startSensors();
      setSensors(true);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  /** The camera behind the outline, or back to the shaded view. */
  const toggleCamera = async () => {
    const v = viewerRef.current;
    if (!v) return;
    setNote(null);
    if (camera) { v.stopCamera(); setCamera(false); return; }
    try {
      await v.startCamera();
      setLensFov(v.feed.status.fovY);
      setCamera(true);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const lens = (deg: number) => {
    setLensFov(deg);
    if (photo) viewerRef.current?.setPhotoLensFov(deg);
    else viewerRef.current?.setLensFov(deg);
  };

  /** A photo from the file picker: EXIF for standpoint and lens, then the user or "Ausrichten" for the heading. */
  const openPhoto = async (file: File | undefined) => {
    const v = viewerRef.current;
    if (!v || !file) return;
    setNote(null);
    setAlignment(null);
    try {
      if (camera) { v.stopCamera(); setCamera(false); }
      const p = await v.openPhoto(file);
      setPhoto(p);
      setLensFov(p.lensFov);
      setPositionSource(p.positioned ? 'photo' : positionSource);
      if (!p.positioned) setNote('Foto ohne GPS: Standpunkt per Karte setzen.');
    } catch (e) {
      setNote(`Foto konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const closePhoto = () => {
    viewerRef.current?.closePhoto();
    setPhoto(null);
    setAlignment(null);
  };

  const align = () => {
    const v = viewerRef.current;
    if (!v) return;
    const r = v.alignPhotoToTerrain();
    if (!r) return;
    setAlignment(r.ok
      ? `Ausgerichtet: Fit ${Math.round(r.fit * 100)} %, Konfidenz ${Math.round(r.confidence * 100)} %`
      : `Nicht ausgerichtet: ${r.why}`);
    setPhoto(v.status().photo);
    setLensFov(v.status().photo?.lensFov ?? lensFov);
  };

  const savePhoto = async () => {
    const r = await viewerRef.current?.snapshot();
    if (r === 'failed') setNote('Foto konnte nicht gespeichert werden.');
  };

  const radius = (m: number) => {
    setEyeRadius(m);
    viewerRef.current?.setEyeRadius(m);
  };
  const toggle = (p: typeof panel) => setPanel(panel === p ? 'none' : p);

  const loading = status && status.levelsReady < status.levels;
  const d = status?.diagnostics;
  const offsetYaw = status?.sensors.offsetYaw ?? 0;
  const offsetPitch = status?.sensors.offsetPitch ?? 0;
  const corrected = sensors && (Math.abs(offsetYaw) > 0.05 || Math.abs(offsetPitch) > 0.05);
  const signed = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}°`;

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="view" />
      <canvas ref={overlayRef} className="labels" />

      {/* Menu rail at the left edge, status and panels beside it; the whole of it folds away. */}
      <div className="pointer-events-none absolute flex items-start gap-2"
        style={{
          top: 'max(0.5rem, env(safe-area-inset-top))', bottom: 'max(0.5rem, env(safe-area-inset-bottom))',
          left: 'max(0.5rem, env(safe-area-inset-left))', right: 'max(3.5rem, env(safe-area-inset-right))',
        }}>
        {!menuOpen ? (
          <div className="pointer-events-auto rounded-lg bg-white/85 shadow backdrop-blur">
            <RailButton icon="menu" label="Menü einblenden" onClick={() => setMenuOpen(true)} />
          </div>
        ) : (
          <nav aria-label="Menü" className="pointer-events-auto grid max-h-full grid-flow-col gap-x-0.5 rounded-lg bg-white/85 p-0.5 shadow backdrop-blur"
            style={{ gridTemplateRows: 'repeat(auto-fit, 2rem)' }}>
            <RailButton icon="fold" label="Menü ausblenden" onClick={() => setMenuOpen(false)} />
            <RailButton icon="map" label="Karte" onClick={() => setPanel('map')} />
            <RailButton icon="pin" label="Standpunkt" pressed={panel === 'places'} onClick={() => toggle('places')} />
            <RailButton icon="compass" label={sensors ? 'Sensoren aus' : 'Sensoren'} pressed={sensors} onClick={() => void toggleSensors()} />
            <RailButton icon="camera" label={camera ? 'Kamera aus' : 'Kamera'} pressed={camera} onClick={() => void toggleCamera()} />
            {(camera || photo) && <RailButton icon="save" label="Speichern" onClick={() => void savePhoto()} />}
            <RailButton icon="photo" label="Foto laden" pressed={!!photo} onClick={() => fileRef.current?.click()} />
            {corrected && <RailButton icon="reset" label="Korrektur zurücksetzen" onClick={() => viewerRef.current?.sensors.resetOffset()} />}
            <RailButton icon="peaks" label={labelsOn ? 'Gipfel aus' : 'Gipfel an'} pressed={labelsOn} onClick={() => setLabelsOn(!labelsOn)} />
            <RailButton icon="outline" label={outline ? 'Umrisse aus' : 'Umrisse an'} pressed={outline} onClick={() => setOutline(!outline)} />
            <RailButton icon="settings" label="Einstellungen" pressed={panel === 'settings'} onClick={() => toggle('settings')} />
            <RailButton icon="info" label="Quellen" pressed={panel === 'credits'} onClick={() => toggle('credits')} />
            <RailButton icon="check" label="Check" pressed={panel === 'check'} onClick={() => toggle('check')} />
          </nav>
        )}
        <input ref={fileRef} type="file" accept="image/*" className="hidden" aria-label="Fotodatei"
          onChange={(e) => { void openPhoto(e.target.files?.[0]); e.target.value = ''; }} />

        {menuOpen && (
        <div className="flex max-h-full min-w-0 max-w-[24rem] flex-col gap-2">
        <div className="pointer-events-auto shrink-0 rounded-lg bg-white/85 px-2.5 py-1.5 text-[12px] leading-snug text-neutral-800 shadow backdrop-blur">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="tabular-nums font-semibold">{compass(view.yaw)} {view.yaw.toFixed(0)}°</span>
            <span className="tabular-nums">{view.pitch >= 0 ? '+' : ''}{view.pitch.toFixed(0)}°</span>
            <span className="tabular-nums">FOV {view.fov.toFixed(0)}°</span>
            {status && <span className="tabular-nums text-neutral-500">{status.fps} fps</span>}
          </div>
          <div className="text-neutral-600">
            <span className="tabular-nums">{view.lat.toFixed(4)}, {view.lon.toFixed(4)}</span>
            {positionSource === 'gps' && <span> (GPS{gpsAccuracy !== null ? `, ±${Math.round(gpsAccuracy)} m` : ''})</span>}
            {positionSource === 'map' && <span> (Karte)</span>}
            {positionSource === 'photo' && <span> (Foto-GPS)</span>}
            {sensors && <span> · Sensoren{corrected ? `, Korrektur ${signed(offsetYaw)} / ${signed(offsetPitch)}` : ''}</span>}
            {camera && <span> · Kamera</span>}
            {photo && <span> · Foto</span>}
            {status && (
              <span> · Auge {Math.round(status.eyeAltitude)} m
                {status.altitudeSource === 'dem' ? ` (Boden + ${aboveGround(status.eyeAltitude - status.ground)})` : ''}</span>
            )}
          </div>
          <div className="text-neutral-600">
            {error && <span className="whitespace-pre-wrap text-red-700">{error}</span>}
            {note && !error && <span className="text-red-700">{note} </span>}
            {!error && !status && 'Renderer startet…'}
            {status && loading && (
              <span>Lade Gelände: Tiles {status.tilesDone}/{status.tilesTotal}, Level {status.levelsReady}/{status.levels}
                {status.failed > 0 ? `, ${status.failed} fehlgeschlagen` : ''}</span>
            )}
            {status && !loading && (
              <span>{status.levels} Level · {fmtBytes(status.bytes)} · {status.backend}
                {status.failed > 0 ? ` · ${status.failed} Tiles fehlgeschlagen` : ''}
                {status.peaks.total > 0 ? ` · Gipfel ${status.peaks.visible}/${status.peaks.total}` : ''}</span>
            )}
          </div>
        </div>

        {(camera || photo) && (
          <div className={PANEL}>
            {photo && (
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <b className="font-semibold">Foto</b>
                <span className="text-neutral-600">{photo.width}×{photo.height}{photo.taken ? ` · ${photo.taken}` : ''}
                  {` · Objektiv ${photo.lensSource === 'exif' ? 'aus EXIF' : photo.lensSource === 'found' ? 'gefunden' : photo.lensSource === 'manual' ? 'von Hand' : 'geschätzt'}`}</span>
                <button className={BTN} onClick={align}>Ausrichten</button>
                <button className={BTN} onClick={closePhoto}>Foto schließen</button>
              </div>
            )}
            {alignment && <div className="alp-align mb-1">{alignment}</div>}
            <label className="flex items-center gap-2">
              <span>Objektiv {lensFov.toFixed(0)}°</span>
              <input type="range" min={8} max={90} step={0.5} value={lensFov} aria-label="Objektiv"
                onChange={(e) => lens(Number(e.target.value))} className="flex-1" />
            </label>
            <div className="mt-0.5 text-neutral-500">
              {photo ? '1 Finger: Grate aufs Foto schieben, oder „Ausrichten“.' : 'Regler schieben, bis die gezeichneten Grate auf den echten liegen.'}
            </div>
          </div>
        )}

        {panel === 'places' && (
          <div className={PANEL} role="region" aria-label="Standpunkt wählen">
            <div className="mb-1 font-semibold">Standpunkt wählen</div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {PLACES.map((p) => (
                <button key={p.id} className="text-blue-700 hover:underline" onClick={() => go(p.id)}>{p.name}</button>
              ))}
            </div>
            <div className="mt-1 text-neutral-500">Oder in der URL: #lon=…&amp;lat=…&amp;alt=…&amp;yaw=…</div>
          </div>
        )}

        {panel === 'settings' && (
          <div className={PANEL} role="region" aria-label="Einstellungen">
            <div className="mb-1 font-semibold">Einstellungen</div>
            <label className="flex items-center gap-2">
              <span className="shrink-0 whitespace-nowrap tabular-nums">Höhenbereich {eyeRadius} m</span>
              <input type="range" min={EYE_RADIUS.min} max={EYE_RADIUS.max} step={5} value={eyeRadius} aria-label="Höhenbereich"
                onChange={(e) => radius(Number(e.target.value))} className="min-w-0 flex-1" />
            </label>
            <div className="mt-0.5 text-neutral-500">
              Auge 1,7 m über dem höchsten Gelände in diesem Umkreis: klein = am Standpunkt, groß = frei über nahe Kuppen.
            </div>
          </div>
        )}

        {panel === 'credits' && (
          <div className={`${PANEL} text-[12px]`} role="region" aria-label="Quellen">
            <div className="mb-1 font-semibold">Gelände unter diesem Standpunkt</div>
            {status?.surveys.length ? (
              <ul className="mb-2 list-disc pl-4">
                {status.surveys.map((s) => (
                  <li key={s.id}>
                    <a className="text-blue-700 hover:underline" href={s.website} target="_blank" rel="noopener">© {s.producerShort}</a>
                    {' '}– {s.name} ({s.resolution} m, {s.license})
                  </li>
                ))}
              </ul>
            ) : <div className="mb-2 text-neutral-500">Quellenliste wird geladen oder ist offline nicht verfügbar.</div>}
            <ul className="list-disc pl-4">
              {FIXED_CREDITS.map((c) => (
                <li key={c.who}>
                  {c.url ? <a className="text-blue-700 hover:underline" href={c.url} target="_blank" rel="noopener">{c.who}</a> : c.who}
                  {': '}{c.text}
                </li>
              ))}
            </ul>
          </div>
        )}

        {panel === 'check' && d && (
          <div className={`${PANEL} font-mono text-[11px]`} role="region" aria-label="Check">
            <div>{d.engine} · {d.adapter} · Build {__BUILD__}</div>
            <div>Qualität {status?.quality} · Mesh {d.vertices.toLocaleString('de')} Vertices · Sektoren {d.sectorsDrawn}/32 · {d.size}</div>
            <div>Atlas {d.atlas} · Level {d.levels} · Frame {d.frameMs.toFixed(1)} ms · Frames {d.framesDrawn}</div>
            <div>Pipelines: terrain {d.terrainReady ? 'ok' : '…'} · shade {d.shadeReady ? 'ok' : '…'} · composite {d.compositeReady ? 'ok' : '…'}</div>
            <div>Fehler: {d.frameErrors} Frames · Device lost {d.deviceLost}</div>
            {d.limits && <div>Limits: {d.limits} · GL-Fehler {d.glError}</div>}
            {status?.decoder && <div>Tile-Dekoder: {status.decoder}</div>}
            {status && <div>Boden {status.ground.toFixed(0)} m · Auge {status.eyeAltitude.toFixed(1)} m · Höhenbereich {eyeRadius} m</div>}
            {d.shaderErrors.length > 0 && (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-red-700">{d.shaderErrors.join('\n')}</pre>
            )}
          </div>
        )}
        </div>
        )}
      </div>

      {(!status || loading) && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-lg bg-white/85 px-4 py-3 text-[14px] text-neutral-800 shadow backdrop-blur" role="status">
            <div className="font-semibold">Gelände lädt …</div>
            {status && (
              <>
                <div className="mt-0.5 text-neutral-600">Tiles {status.tilesDone}/{status.tilesTotal} · Level {status.levelsReady}/{status.levels}</div>
                <div className="mt-1.5 h-1.5 w-56 overflow-hidden rounded bg-neutral-200">
                  <div className="h-full bg-blue-600" style={{ width: `${status.tilesTotal ? Math.round((100 * status.tilesDone) / status.tilesTotal) : 0}%` }} />
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <div className="pointer-events-none absolute right-2"
        style={{ top: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <CompassRose yaw={view.yaw} offset={offsetYaw} sensors={sensors} />
      </div>

      {peak && (
        <div className="alp-peak-card pointer-events-auto absolute max-w-md rounded-lg bg-white/90 px-3 py-2 text-[13px] text-neutral-800 shadow backdrop-blur"
          style={{
            bottom: 'max(2rem, calc(env(safe-area-inset-bottom) + 1.5rem))',
            left: menuOpen ? 'calc(max(0.5rem, env(safe-area-inset-left)) + 3rem)' : 'max(0.5rem, env(safe-area-inset-left))',
          }}>
          <div className="flex items-baseline gap-3">
            <b className="text-[15px] font-semibold">{peak.name}</b>
            <span className="tabular-nums text-neutral-600">
              {peak.ele !== undefined ? `${Math.round(peak.ele)} m · ` : ''}{fmtRange(peak.range)} · {peak.compass} {peak.bearing.toFixed(0)}°
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3">
            {peak.wikipedia && <a className="text-blue-700 hover:underline" href={peak.wikipedia} target="_blank" rel="noopener">Wikipedia</a>}
            {peak.wikidata && <a className="text-blue-700 hover:underline" href={peak.wikidata} target="_blank" rel="noopener">Wikidata</a>}
            <button className={BTN} onClick={() => viewerRef.current?.clearSelection()}>Schließen</button>
          </div>
        </div>
      )}

      {panel === 'map' && (
        <MapPanel lon={view.lon} lat={view.lat} yaw={view.yaw} onPick={pick} onClose={() => setPanel('none')} />
      )}

      <div className="pointer-events-none absolute inset-x-2 bottom-2 text-center text-[11px] text-white drop-shadow"
        style={{ bottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
        {sensors ? '1 Finger: Kompass korrigieren' : '1 Finger: umschauen'}{camera || photo ? ' · Zoom: Objektiv-Regler' : ' · 2 Finger: zoomen'} · Gelände © Mapterhorn und Quellen
      </div>
    </div>
  );
}
