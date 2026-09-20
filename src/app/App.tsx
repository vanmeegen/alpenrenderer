import { useEffect, useRef, useState } from 'react';
import { FIXED_CREDITS } from '../engine/core/attribution';
import { formatHash, PLACES, readHash, readOptions, ViewState } from './state';
import { PeakInfo, Viewer, ViewerStatus } from './viewer';
import { fmtRange } from '../engine/core/labels';
import { MapPanel } from './MapPanel';
import { PickedPosition } from './mapPicker';
import { CompassRose } from './CompassRose';

const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
const compass = (yaw: number) => COMPASS[Math.round(yaw / 45) % 8];
const fmtBytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const [view, setView] = useState<ViewState>(() => readHash());
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'places' | 'credits' | 'check' | 'map'>('none');
  const [outline, setOutline] = useState(true);
  const [positionSource, setPositionSource] = useState<'url' | 'map' | 'gps' | 'place'>('url');
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [sensors, setSensors] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [labelsOn, setLabelsOn] = useState(true);
  const [camera, setCamera] = useState(false);
  const [lensFov, setLensFov] = useState(51);
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
    viewerRef.current?.setLensFov(deg);
  };

  const photo = async () => {
    const r = await viewerRef.current?.snapshot();
    if (r === 'failed') setNote('Foto konnte nicht gespeichert werden.');
  };

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

      {/* HUD */}
      <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-col gap-2"
        style={{ top: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <div className="pointer-events-auto max-w-md rounded-lg bg-white/85 px-3 py-2 text-[13px] leading-snug text-neutral-800 shadow backdrop-blur">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <b className="text-[15px] font-semibold">alpenrenderer</b>
            <span className="tabular-nums">{compass(view.yaw)} {view.yaw.toFixed(0)}°</span>
            <span className="tabular-nums">{view.pitch >= 0 ? '+' : ''}{view.pitch.toFixed(0)}°</span>
            <span className="tabular-nums">FOV {view.fov.toFixed(0)}°</span>
            {status && <span className="tabular-nums text-neutral-500">{status.fps} fps</span>}
          </div>
          <div className="mt-0.5 text-neutral-600">
            <span className="tabular-nums">{view.lat.toFixed(4)}, {view.lon.toFixed(4)}</span>
            {positionSource === 'gps' && <span> (GPS{gpsAccuracy !== null ? `, ±${Math.round(gpsAccuracy)} m` : ''})</span>}
            {positionSource === 'map' && <span> (Karte)</span>}
            {sensors && <span> · Sensoren{corrected ? `, Korrektur ${signed(offsetYaw)} / ${signed(offsetPitch)}` : ''}</span>}
            {camera && <span> · Kamera</span>}
            {status && (
              <span> · Auge {Math.round(status.eyeAltitude)} m
                {status.altitudeSource === 'dem' ? ' (Boden + 1,7 m)' : ''}</span>
            )}
          </div>
          <div className="mt-0.5 text-neutral-600">
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
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
            <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => setPanel('map')}>Karte</button>
            <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => setPanel(panel === 'places' ? 'none' : 'places')}>Standpunkt</button>
            <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => void toggleSensors()}>{sensors ? 'Sensoren aus' : 'Sensoren'}</button>
            <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => void toggleCamera()}>{camera ? 'Kamera aus' : 'Kamera'}</button>
            {camera && <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => void photo()}>Foto</button>}
            {corrected && (
              <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => viewerRef.current?.sensors.resetOffset()}>Korrektur zurücksetzen</button>
            )}
            <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => setLabelsOn(!labelsOn)}>Gipfel {labelsOn ? 'aus' : 'an'}</button>
            <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => setOutline(!outline)}>Umrisse {outline ? 'aus' : 'an'}</button>
            <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => setPanel(panel === 'credits' ? 'none' : 'credits')}>Quellen</button>
            <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => setPanel(panel === 'check' ? 'none' : 'check')}>Check</button>
          </div>
        </div>

        {camera && (
          <div className="pointer-events-auto max-w-md rounded-lg bg-white/90 px-3 py-2 text-[13px] text-neutral-800 shadow backdrop-blur">
            <label className="flex items-center gap-2">
              <span>Objektiv {lensFov.toFixed(0)}°</span>
              <input type="range" min={25} max={90} step={0.5} value={lensFov} aria-label="Objektiv"
                onChange={(e) => lens(Number(e.target.value))} className="flex-1" />
            </label>
            <div className="mt-0.5 text-neutral-500">Regler schieben, bis die gezeichneten Grate auf den echten liegen.</div>
          </div>
        )}

        {panel === 'places' && (
          <div className="pointer-events-auto max-w-md rounded-lg bg-white/90 px-3 py-2 text-[13px] text-neutral-800 shadow backdrop-blur">
            <div className="mb-1 font-semibold">Standpunkt wählen</div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {PLACES.map((p) => (
                <button key={p.id} className="text-blue-700 hover:underline" onClick={() => go(p.id)}>{p.name}</button>
              ))}
            </div>
            <div className="mt-1 text-neutral-500">Oder in der URL: #lon=…&amp;lat=…&amp;alt=…&amp;yaw=…</div>
          </div>
        )}

        {panel === 'credits' && (
          <div className="pointer-events-auto max-w-md rounded-lg bg-white/90 px-3 py-2 text-[12px] text-neutral-800 shadow backdrop-blur">
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
          <div className="pointer-events-auto max-w-md rounded-lg bg-white/90 px-3 py-2 font-mono text-[11px] text-neutral-800 shadow backdrop-blur">
            <div>{d.engine} · {d.adapter}</div>
            <div>Qualität {status?.quality} · Mesh {d.vertices.toLocaleString('de')} Vertices · Sektoren {d.sectorsDrawn}/32 · {d.size}</div>
            <div>Atlas {d.atlas} · Level {d.levels} · Frame {d.frameMs.toFixed(1)} ms · Frames {d.framesDrawn}</div>
            <div>Pipelines: terrain {d.terrainReady ? 'ok' : '…'} · shade {d.shadeReady ? 'ok' : '…'} · composite {d.compositeReady ? 'ok' : '…'}</div>
            <div>Fehler: {d.frameErrors} Frames · Device lost {d.deviceLost}</div>
            {status && <div>Boden {status.ground.toFixed(0)} m · Auge {status.eyeAltitude.toFixed(1)} m</div>}
            {d.shaderErrors.length > 0 && (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-red-700">{d.shaderErrors.join('\n')}</pre>
            )}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute right-2"
        style={{ top: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <CompassRose yaw={view.yaw} offset={offsetYaw} sensors={sensors} />
      </div>

      {peak && (
        <div className="alp-peak-card pointer-events-auto absolute left-2 max-w-md rounded-lg bg-white/90 px-3 py-2 text-[13px] text-neutral-800 shadow backdrop-blur"
          style={{ bottom: 'max(2rem, calc(env(safe-area-inset-bottom) + 1.5rem))' }}>
          <div className="flex items-baseline gap-3">
            <b className="text-[15px] font-semibold">{peak.name}</b>
            <span className="tabular-nums text-neutral-600">
              {peak.ele !== undefined ? `${Math.round(peak.ele)} m · ` : ''}{fmtRange(peak.range)} · {peak.compass} {peak.bearing.toFixed(0)}°
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3">
            {peak.wikipedia && <a className="text-blue-700 hover:underline" href={peak.wikipedia} target="_blank" rel="noopener">Wikipedia</a>}
            {peak.wikidata && <a className="text-blue-700 hover:underline" href={peak.wikidata} target="_blank" rel="noopener">Wikidata</a>}
            <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => viewerRef.current?.clearSelection()}>Schließen</button>
          </div>
        </div>
      )}

      {panel === 'map' && (
        <MapPanel lon={view.lon} lat={view.lat} yaw={view.yaw} onPick={pick} onClose={() => setPanel('none')} />
      )}

      <div className="pointer-events-none absolute inset-x-2 bottom-2 text-center text-[11px] text-white drop-shadow"
        style={{ bottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
        {sensors ? '1 Finger: Kompass korrigieren' : '1 Finger: umschauen'}{camera ? ' · Zoom: Objektiv-Regler' : ' · 2 Finger: zoomen'} · Gelände © Mapterhorn und Quellen
      </div>
    </div>
  );
}
