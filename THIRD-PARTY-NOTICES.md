# Third-party notices

The code in this repository is MIT (see `LICENSE`). It builds on:

| Component | Licence | Use |
|---|---|---|
| [peakviewer](https://github.com/pascalbayer/peakviewer) by Pascal Bayer | MIT (`src/engine/LICENSE-peakviewer`) | Terrain engine in `src/engine/`: geodesy, clipmap, renderer, sources, labels, pose, skyline alignment |
| [Babylon.js](https://www.babylonjs.com) (`@babylonjs/core`) | Apache-2.0 | Rendering on WebGL2 and WebGPU |
| [geomagnetism](https://www.npmjs.com/package/geomagnetism) | Apache-2.0 | World Magnetic Model 2025 declination |
| [pmtiles](https://github.com/protomaps/PMTiles) | BSD-3-Clause | Reading Mapterhorn's coverage index |
| [React](https://react.dev) | MIT | UI shell |
| [Tailwind CSS](https://tailwindcss.com) | MIT | Styling |
| [three.js](https://threejs.org) (spike only, from CDN) | MIT | `spike/zugspitze/` |

Data:

- Elevation tiles: [Mapterhorn](https://mapterhorn.com/attribution), BSD-3
  code; the terrain itself is a composite of open surveys, each under its own
  licence (CC-BY-4.0, CC0, Open Government Data, Licence Ouverte, and others).
  The surveys under the terrain on screen are listed in the app's Credits panel
  from Mapterhorn's coverage index, with producer and licence.
- Global fallback terrain: Copernicus DEM GLO-30, © DLR e.V. 2010-2014 and
  © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the
  European Union and ESA.
- Summit names and positions: © OpenStreetMap contributors, ODbL.
- Magnetic declination: NOAA NCEI and the British Geological Survey, World
  Magnetic Model 2025.
