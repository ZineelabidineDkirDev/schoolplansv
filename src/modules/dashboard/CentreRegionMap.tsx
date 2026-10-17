import { useEffect, useRef, useState } from 'react';
import { getSupabaseClient } from '../../data/supabase/client';

type MapState = { status: 'loading' } | { status: 'ready'; city: string; region: string | null; note: string | null } | { status: 'error'; message: string };

type GeoJsonResult = {
  display_name?: string;
  lat?: string;
  lon?: string;
  boundingbox?: string[];
  geojson?: unknown;
  address?: Record<string, unknown>;
};

type LeafletBounds = { isValid(): boolean };
type LeafletMap = {
  setView(center: [number, number], zoom: number): LeafletMap;
  fitBounds(bounds: LeafletBounds, options?: { padding?: [number, number] }): LeafletMap;
  remove(): void;
  invalidateSize(): void;
};
type LeafletLayer = { addTo(map: LeafletMap): LeafletLayer; bindPopup(content: string): LeafletLayer };
type LeafletGeoJson = LeafletLayer & { getBounds(): LeafletBounds };
type LeafletApi = {
  map(element: HTMLElement, options?: Record<string, unknown>): LeafletMap;
  tileLayer(url: string, options: Record<string, unknown>): LeafletLayer;
  marker(position: [number, number]): LeafletLayer;
  geoJSON(data: unknown, options?: Record<string, unknown>): LeafletGeoJson;
};
declare global {
  interface Window { L?: LeafletApi }
}

let leafletPromise: Promise<LeafletApi> | null = null;

function loadLeaflet(): Promise<LeafletApi> {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const cssId = 'schoolplans-leaflet-css';
    if (!document.getElementById(cssId)) {
      const link = document.createElement('link');
      link.id = cssId;
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-schoolplans-leaflet]');
    if (existing) {
      existing.addEventListener('load', () => window.L ? resolve(window.L) : reject(new Error('La bibliothèque cartographique n’a pas démarré.')), { once: true });
      existing.addEventListener('error', () => reject(new Error('Impossible de charger la bibliothèque cartographique.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.dataset.schoolplansLeaflet = 'true';
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.onload = () => window.L ? resolve(window.L) : reject(new Error('La bibliothèque cartographique n’a pas démarré.'));
    script.onerror = () => reject(new Error('Impossible de charger la bibliothèque cartographique.'));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    leafletPromise = null;
    throw error;
  });
  return leafletPromise;
}

function isAreaGeometry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'Polygon' || type === 'MultiPolygon';
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function addressField(address: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!address) return null;
  for (const key of keys) {
    const value = textField(address[key]);
    if (value) return value;
  }
  return null;
}

async function findCityBoundary(city: string, address: string | null): Promise<GeoJsonResult | null> {
  const candidates = [city, address].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  for (const candidate of candidates) {
    const params = new URLSearchParams({ format: 'jsonv2', polygon_geojson: '1', addressdetails: '1', limit: '1', q: candidate.includes('Maroc') ? candidate : `${candidate}, Maroc` });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) continue;
    const result: unknown = await response.json();
    if (!Array.isArray(result) || !result.length || typeof result[0] !== 'object' || result[0] === null) continue;
    const first = result[0] as GeoJsonResult;
    if (first.geojson && first.lat && first.lon) return first;
  }
  return null;
}

export function CentreRegionMap({ centreId }: { centreId: string }) {
  const mapElement = useRef<HTMLDivElement | null>(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<MapState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    let map: LeafletMap | null = null;

    async function renderMap() {
      if (!centreId) {
        setState({ status: 'error', message: 'Aucun centre sélectionné.' });
        return;
      }
      setState({ status: 'loading' });
      try {
        const client = getSupabaseClient();
        const { data, error } = await client.from('centres').select('nom,ville,adresse').eq('id', centreId).maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('Centre introuvable.');
        const city = textField(data.ville) ?? textField(data.adresse);
        if (!city) throw new Error('Renseignez la ville ou l’adresse dans le profil du centre pour le placer sur la carte.');
        const result = await findCityBoundary(city, textField(data.adresse));
        if (!active) return;
        if (!result || !mapElement.current) {
          setState({ status: 'error', message: `Aucune limite cartographique trouvée pour « ${city} ». Vérifiez la ville dans le profil du centre.` });
          return;
        }

        const L = await loadLeaflet();
        if (!active || !mapElement.current) return;
        map = L.map(mapElement.current, { scrollWheelZoom: false }).setView([Number(result.lat), Number(result.lon)], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map);

        const hasBoundary = isAreaGeometry(result.geojson);
        if (hasBoundary) {
          const boundary = L.geoJSON(result.geojson, {
            style: { color: '#2563eb', weight: 3, opacity: 0.95, fillColor: '#60a5fa', fillOpacity: 0.16 },
          }).addTo(map);
          if (boundary.getBounds().isValid()) map.fitBounds(boundary.getBounds(), { padding: [18, 18] });
        }
        L.marker([Number(result.lat), Number(result.lon)]).addTo(map).bindPopup(`<strong>${textField(data.nom) ?? 'Centre SchoolPlans'}</strong><br>${city}`);
        map.invalidateSize();
        const region = addressField(result.address, ['state', 'region', 'county']);
        setState({
          status: 'ready',
          city: addressField(result.address, ['city', 'town', 'municipality', 'village']) ?? city,
          region,
          note: hasBoundary ? null : 'La carte affiche le point trouvé, mais aucune limite de ville exploitable n’a été fournie par la source cartographique.',
        });
      } catch (error) {
        if (active) setState({ status: 'error', message: error instanceof Error ? error.message : 'La carte n’a pas pu être chargée.' });
      }
    }

    void renderMap();
    return () => {
      active = false;
      map?.remove();
    };
  }, [centreId, revision]);

  return (
    <section className="dashboard-insight-panel dashboard-centre-map" aria-label="Carte géographique du centre">
      <div className="dashboard-insight-heading">
        <span className="dashboard-insight-icon is-amber">⌖</span>
        <div><h2>Carte du centre par ville / région</h2><p>Carte réelle OpenStreetMap · limites administratives si disponibles</p></div>
      </div>
      {state.status === 'loading' && <p className="dashboard-insight-empty">Recherche de la ville et de son périmètre…</p>}
      {state.status === 'error' && (
        <div className="dashboard-centre-map-error">
          <p className="dashboard-insight-empty">{state.message}</p>
          <button type="button" className="dashboard-map-retry" onClick={() => setRevision((value) => value + 1)}>Réessayer</button>
        </div>
      )}
      <div ref={mapElement} className="dashboard-real-map" aria-label="Carte interactive OpenStreetMap" />
      {state.status === 'ready' && (
        <div className="dashboard-map-meta">
          <span><strong>Ville :</strong> {state.city}</span>
          {state.region && <span><strong>Région :</strong> {state.region}</span>}
          {state.note && <p className="dashboard-insight-empty">{state.note}</p>}
        </div>
      )}
    </section>
  );
}
