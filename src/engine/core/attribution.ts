/**
 * Who the data belongs to.
 *
 * Terrain comes from Mapterhorn, which is itself a composite: the elevation
 * under your feet in Zermatt is swisstopo's, across the border it is the Aosta
 * region's, and most of those surveys are CC-BY, which asks to be named
 * somewhere a user would reasonably look. The app therefore shows two things:
 * the fixed credits below, and — per position — the surveys actually under the
 * loaded terrain, looked up in Mapterhorn's coverage index (see
 * sources/coverage.ts). This file is the single source for the on-screen
 * Credits panel and for THIRD-PARTY-NOTICES.md.
 */

export interface Credit {
  /** Short label for the on-screen list. */
  who: string;
  /** The notice as the provider asks for it. */
  text: string;
  url?: string;
}

/** Fixed credits: the aggregator, the summit names, the models, the renderer. */
export const FIXED_CREDITS: Credit[] = [
  {
    who: 'Mapterhorn',
    text: 'Elevation tiles by Mapterhorn (BSD-3 code), a composite of open '
      + 'national and global terrain surveys. The surveys under the terrain on '
      + 'screen are listed alongside.',
    url: 'https://mapterhorn.com/attribution',
  },
  {
    who: 'Copernicus',
    text: 'Global fallback terrain: Copernicus DEM GLO-30, © DLR e.V. 2010-2014 '
      + 'and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS '
      + 'by the European Union and ESA.',
    url: 'https://dataspace.copernicus.eu/',
  },
  {
    who: 'OpenStreetMap contributors',
    text: 'Summit names and positions © OpenStreetMap contributors, available '
      + 'under the Open Database Licence (ODbL).',
    url: 'https://www.openstreetmap.org/copyright',
  },
  {
    who: 'NOAA NCEI and the British Geological Survey',
    text: 'Magnetic declination from the World Magnetic Model 2025.',
    url: 'https://www.ncei.noaa.gov/products/world-magnetic-model',
  },
  {
    who: 'Babylon.js',
    text: 'Rendering by Babylon.js, Apache-2.0.',
    url: 'https://www.babylonjs.com',
  },
  {
    who: 'peakviewer',
    text: 'Terrain engine, geodesy, horizon test and skyline alignment derived '
      + 'from peakviewer by Pascal Bayer, MIT.',
    url: 'https://github.com/pascalbayer/peakviewer',
  },
];

/** One line suitable for a photo caption or an export footer. */
export const SHORT_CREDIT =
  'Terrain: © Mapterhorn and its sources (swisstopo, BEV, LDBV Bayern and others). '
  + 'Summits: © OpenStreetMap contributors, ODbL.';
