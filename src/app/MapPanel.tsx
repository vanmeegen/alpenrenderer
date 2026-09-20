/**
 * The standpoint map: OpenStreetMap in Leaflet, full screen. Drag and pinch
 * to move around, tap to put the marker somewhere, "Panorama von hier" to
 * stand there; "Mein Standort" asks the device instead.
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { MAP_ZOOM, OSM_ATTRIBUTION, OSM_TILES, PickedPosition, locateDevice } from './mapPicker';

export interface MapPanelProps {
  lon: number;
  lat: number;
  /** Bearing of the panorama, degrees, drawn on the marker. */
  yaw: number;
  onPick: (p: PickedPosition) => void;
  onClose: () => void;
}

function arrowIcon(yaw: number): L.DivIcon {
  return L.divIcon({
    className: 'alp-marker',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<div style="width:28px;height:28px;transform:rotate(${yaw}deg);display:flex;align-items:center;justify-content:center">`
      + '<svg viewBox="0 0 28 28" width="28" height="28"><circle cx="14" cy="14" r="6" fill="#1d4ed8" stroke="#fff" stroke-width="2"/>'
      + '<path d="M14 1 L19 10 L14 8 L9 10 Z" fill="#1d4ed8" stroke="#fff" stroke-width="1"/></svg></div>',
  });
}

export function MapPanel({ lon, lat, yaw, onPick, onClose }: MapPanelProps) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const [picked, setPicked] = useState<{ lon: number; lat: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const map = L.map(host.current!, {
      center: [lat, lon], zoom: MAP_ZOOM, zoomControl: true, attributionControl: true,
      touchZoom: true, doubleClickZoom: true,
    });
    L.tileLayer(OSM_TILES, { maxZoom: 18, attribution: OSM_ATTRIBUTION, crossOrigin: true }).addTo(map);
    const marker = L.marker([lat, lon], { icon: arrowIcon(yaw), interactive: false }).addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      marker.setLatLng(e.latlng);
      setPicked({ lon: e.latlng.lng, lat: e.latlng.lat });
    });
    mapRef.current = map;
    markerRef.current = marker;
    // The panel is mounted into an already laid-out box; make sure Leaflet
    // measures it after the first paint.
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
    // The map is created once per opening; later prop changes come through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { markerRef.current?.setIcon(arrowIcon(yaw)); }, [yaw]);

  const confirm = () => {
    const p = picked ?? { lon, lat };
    onPick({ ...p, source: 'map' });
  };

  const locate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const p = await locateDevice();
      onPick(p);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-white">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[14px]" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <button className="rounded bg-blue-700 px-3 py-1.5 font-semibold text-white" onClick={confirm}>Panorama von hier</button>
        <button className="rounded border border-blue-700 px-3 py-1.5 text-blue-700 disabled:opacity-50" onClick={locate} disabled={busy}>
          {busy ? 'Suche Position…' : 'Mein Standort'}
        </button>
        <button className="rounded border border-neutral-400 px-3 py-1.5 text-neutral-700" onClick={onClose}>Schließen</button>
        <span className="text-[12px] text-neutral-600">Karte verschieben, Punkt antippen, dann „Panorama von hier“.</span>
        {message && <span className="text-[12px] text-red-700">{message}</span>}
      </div>
      <div ref={host} className="min-h-0 flex-1" />
    </div>
  );
}
