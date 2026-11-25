// =========================================================
// NDW WEGVAKKEN
//
// Draws the NWB road sections (wegvakken) from the NDW vector tiles and
// shows a popup when one is clicked. Which wegkenmerken appear in that
// popup depends on the RVV codes selected in the sidebar
// (e.g. A1 -> speed limit, C19 -> height restriction).
//
// Every NDW wegkenmerken dataset is a separate tile layer, linked to the
// NWB wegvak through `nwbRoadSectionId`. On click we look up the nearest
// NWB wegvak, then fetch the same tile from each relevant dataset and
// show the features that belong to that wegvak.
//
// Depends on (from app.js): map, hasValue, getCheckedValues
// =========================================================


// ---------------------------------------------------------
// 1. CONFIGURATION
// ---------------------------------------------------------

const NDW_TILES_BASE = "https://maps.ndw.nu/api/v1/tiles";
const NWB_TILE_URL = `${NDW_TILES_BASE}/v1.nwb.latest.mbtiles.roadSections/{z}/{x}/{y}`;

function wkdTileUrl(datasetName) {
  return `${NDW_TILES_BASE}/v1.${datasetName}.latest.mbtiles.segments/{z}/{x}/{y}`;
}

const WEGVAK_MIN_ZOOM = 14;   // below this the tiles get too heavy
const NDW_MAX_TILE_ZOOM = 20; // highest zoom the NDW server provides
const CLICK_TOLERANCE_PX = 10;

const DIRECTION_LABELS = {
  B: "beide richtingen",
  H: "heenrichting",
  T: "terugrichting",
};

function formatDirection(value) {
  return DIRECTION_LABELS[value] ?? value;
}

function withUnit(unit) {
  return value => `${value} ${unit}`;
}

// Fields shown for every restriction dataset (height, width, …)
function restrictionFields(label, unit) {
  return [
    { key: "restrictionValue", label, format: withUnit(unit) },
    { key: "dataDirection", label: "Richting", format: formatDirection },
    { key: "trafficSignVersion", label: "Versie verkeersbord" },
  ];
}

const TRAFFIC_TYPE_LABELS = {
  car: "auto",
  truck: "vrachtauto",
  bus: "bus",
  trailer: "aanhanger",
  agriculturalvehicle: "landbouwvoertuig",
  motorcycle: "motor",
  moped: "bromfiets",
  mofa: "snorfiets",
  bicycle: "fiets",
  pedestrian: "voetganger",
};

// Which NDW dataset belongs to which RVV codes.
// - appliesTo:  rvv code -> true if this dataset is relevant
// - mainKey:    a feature only counts if this field has a value
// - highlight:  colour to draw this dataset's wegvakken on the map
//               (only for datasets that cover a few roads, like restrictions)
const WEGKENMERKEN = [
  {
    dataset: "wkdSpeedLimits",
    title: "Snelheid",
    appliesTo: code => /^A\d/.test(code),
    mainKey: "speedLimit",
    fields: [
      { key: "speedLimit", label: "Maximumsnelheid", format: v => (/^\d+$/.test(v) ? `${v} km/u` : v) },
      { key: "alternateSpeedLimit", label: "Alternatieve maximumsnelheid", format: withUnit("km/u") },
      { key: "startTime", label: "Geldig vanaf (tijd)" },
      { key: "endTime", label: "Geldig tot (tijd)" },
      { key: "advisorySpeed", label: "Adviessnelheid", format: withUnit("km/u") },
      { key: "rushHourLaneSpeedLimit", label: "Snelheid spitsstrook", format: withUnit("km/u") },
      { key: "dataDirection", label: "Richting", format: formatDirection },
    ],
  },
  {
    dataset: "wkdTrafficTypes",
    title: "Toegestane verkeerssoorten",
    appliesTo: code => /^C([1-9]|1[0-6])[a-z]?$/i.test(code),
    mainKey: null,
    customRender: renderTrafficTypes,
  },
  {
    dataset: "wkdLengthRestrictions",
    title: "Maximale lengte",
    appliesTo: code => code === "C17",
    mainKey: "restrictionValue",
    fields: restrictionFields("Maximale lengte", "m"),
    highlight: "#7c3aed",
  },
  {
    dataset: "wkdWidthRestrictions",
    title: "Maximale breedte",
    appliesTo: code => code === "C18",
    mainKey: "restrictionValue",
    fields: restrictionFields("Maximale breedte", "m"),
    highlight: "#ea580c",
  },
  {
    dataset: "wkdHeightRestrictions",
    title: "Maximale hoogte",
    appliesTo: code => code === "C19",
    mainKey: "restrictionValue",
    fields: restrictionFields("Maximale hoogte", "m"),
    highlight: "#dc2626",
  },
  {
    dataset: "wkdAxleLoadRestrictions",
    title: "Maximale aslast",
    appliesTo: code => code === "C20",
    mainKey: "restrictionValue",
    fields: restrictionFields("Maximale aslast", "t"),
    highlight: "#0891b2",
  },
  {
    dataset: "wkdLoadRestrictions",
    title: "Maximaal gewicht",
    appliesTo: code => code === "C21",
    mainKey: "restrictionValue",
    fields: restrictionFields("Maximaal gewicht", "t"),
    highlight: "#db2777",
  },
  {
    dataset: "wkdRoadCategories",
    title: "Wegcategorie",
    appliesTo: code => /^G\d/.test(code),
    mainKey: "roadCategory",
    fields: [
      { key: "roadCategory", label: "Wegcategorie" },
    ],
  },
  {
    dataset: "wkdResidentialAreaBoundaries",
    title: "Bebouwde kom",
    appliesTo: code => code === "H1" || code === "H2",
    mainKey: "residentialAreaName",
    fields: [
      { key: "residentialAreaName", label: "Bebouwde kom" },
    ],
  },
];

// General NWB information shown at the top of every wegvak popup
const NWB_FIELDS = [
  { key: "roadSectionId", label: "Wegvak-ID" },
  { key: "roadName", label: "Straat" },
  { key: "roadNumber", label: "Wegnummer" },
  { key: "townName", label: "Plaats" },
  { key: "roadOperatorName", label: "Wegbeheerder" },
  { key: "drivingDirection", label: "Rijrichting (NWB)" },
];


// ---------------------------------------------------------
// 2. LAYERS
// ---------------------------------------------------------

const wegvakLayerOptions = {
  rendererFactory: L.canvas.tile,
  interactive: false, // clicks are handled by onMapClick below
  minZoom: WEGVAK_MIN_ZOOM,
  maxZoom: 22,
  maxNativeZoom: NDW_MAX_TILE_ZOOM,
  // No attribution here: the basemap in app.js already credits NDW.
};

// Base layer: all NWB wegvakken as thin grey lines
const nwbLayer = L.vectorGrid.protobuf(NWB_TILE_URL, {
  ...wegvakLayerOptions,
  zIndex: 2,
  vectorTileLayerStyles: {
    roadSections: { color: "#4b5563", weight: 2, opacity: 0.6 },
  },
});

// One tile source per dataset. Only datasets with a `highlight` colour
// are drawn; the others are only used to look up popup information.
const datasetLayers = new Map();

function getDatasetLayer(wegkenmerk) {

  if (datasetLayers.has(wegkenmerk.dataset)) {
    return datasetLayers.get(wegkenmerk.dataset);
  }

  const style = properties =>
    hasValue(properties[wegkenmerk.mainKey])
      ? { color: wegkenmerk.highlight, weight: 5, opacity: 0.9 }
      : []; // [] = don't draw this feature

  const layer = L.vectorGrid.protobuf(wkdTileUrl(wegkenmerk.dataset), {
    ...wegvakLayerOptions,
    zIndex: 3,
    vectorTileLayerStyles: { segments: style },
  });

  datasetLayers.set(wegkenmerk.dataset, layer);
  return layer;
}

function wegvakkenEnabled() {
  return document.getElementById("showWegvakken").checked;
}

// Wegkenmerken that match at least one selected RVV code
function getActiveWegkenmerken() {
  const selectedRvvCodes = getCheckedValues("#rvvCodeFilters .rvvCode-checkbox:checked");
  return WEGKENMERKEN.filter(wegkenmerk =>
    Array.from(selectedRvvCodes).some(code => wegkenmerk.appliesTo(code))
  );
}

function updateWegvakLayers() {

  const enabled = wegvakkenEnabled();
  const active = getActiveWegkenmerken();

  if (enabled) {
    nwbLayer.addTo(map);
  } else {
    map.removeLayer(nwbLayer);
  }

  WEGKENMERKEN
    .filter(wegkenmerk => wegkenmerk.highlight)
    .forEach(wegkenmerk => {
      const layer = getDatasetLayer(wegkenmerk);
      if (enabled && active.includes(wegkenmerk)) {
        layer.addTo(map);
      } else {
        map.removeLayer(layer);
      }
    });

  updateWegvakInfo(enabled, active);
}

// Short explanation in the sidebar of what is shown / clickable
function updateWegvakInfo(enabled, active) {

  const info = document.getElementById("wegvakInfo");
  info.innerHTML = "";

  if (!enabled) return;

  const addParagraph = text => {
    const p = document.createElement("p");
    p.textContent = text;
    info.appendChild(p);
  };

  if (map.getZoom() < WEGVAK_MIN_ZOOM) {
    addParagraph(`Zoom verder in (niveau ${WEGVAK_MIN_ZOOM} of hoger) om de wegvakken te zien.`);
  }

  if (active.length === 0) {
    addParagraph(
      "Klik op een wegvak voor algemene informatie. Selecteer RVV-codes " +
      "(bijv. A1 of C19) om ook de bijbehorende wegkenmerken te zien."
    );
    return;
  }

  addParagraph("Klik op een wegvak om te zien:");

  const list = document.createElement("ul");
  active.forEach(wegkenmerk => {
    const item = document.createElement("li");
    if (wegkenmerk.highlight) {
      const swatch = document.createElement("span");
      swatch.className = "legend-line";
      swatch.style.backgroundColor = wegkenmerk.highlight;
      swatch.title = "wegvakken met deze beperking zijn in deze kleur getekend";
      item.appendChild(swatch);
    }
    item.append(wegkenmerk.title);
    list.appendChild(item);
  });
  info.appendChild(list);
}


// ---------------------------------------------------------
// 3. TILE LOOKUP (for clicks)
// ---------------------------------------------------------

const TILE_SIZE = 256;
const tileCache = new Map(); // "url|z/x/y" -> Promise<decoded tile>
const TILE_CACHE_LIMIT = 200;

// Uses VectorGrid's own (internal) tile loader, so tiles are decoded
// exactly like the ones on screen. Pinned to leaflet.vectorgrid@1.3.0.
function loadTile(layer, coords) {

  const key = `${layer._url}|${coords.z}/${coords.x}/${coords.y}`;

  if (!tileCache.has(key)) {
    if (tileCache.size >= TILE_CACHE_LIMIT) tileCache.clear();
    tileCache.set(key, layer._getVectorTilePromise(coords));
  }
  return tileCache.get(key);
}

// Tile coordinates + position of the clicked point inside that tile
function getTilePosition(latlng) {
  const z = Math.min(Math.round(map.getZoom()), NDW_MAX_TILE_ZOOM);
  const point = map.project(latlng, z);
  const x = Math.floor(point.x / TILE_SIZE);
  const y = Math.floor(point.y / TILE_SIZE);
  return {
    coords: { x, y, z },
    // position within the tile, 0..1
    fx: point.x / TILE_SIZE - x,
    fy: point.y / TILE_SIZE - y,
  };
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceToFeature(point, feature) {
  let min = Infinity;
  feature.geometry.forEach(line => {
    for (let i = 1; i < line.length; i++) {
      min = Math.min(min, distanceToSegment(point, line[i - 1], line[i]));
    }
  });
  return min;
}

// Nearest NWB wegvak to the clicked point, or null if none is close enough
async function findNearestWegvak(latlng) {

  const { coords, fx, fy } = getTilePosition(latlng);
  const tile = await loadTile(nwbLayer, coords);
  const roadSections = tile.layers.roadSections;
  if (!roadSections) return null;

  const extent = roadSections.extent;
  const point = { x: fx * extent, y: fy * extent };

  // tolerance in tile units (tiles may be shown larger beyond zoom 20)
  const pixelsPerUnit = (TILE_SIZE / extent) * Math.pow(2, map.getZoom() - coords.z);
  const tolerance = CLICK_TOLERANCE_PX / pixelsPerUnit;

  let nearest = null;
  let nearestDistance = tolerance;

  roadSections.features.forEach(feature => {
    const distance = distanceToFeature(point, feature);
    if (distance <= nearestDistance) {
      nearest = feature;
      nearestDistance = distance;
    }
  });

  return nearest ? { properties: nearest.properties, coords } : null;
}

// All features of a dataset that belong to the given NWB wegvak
async function findWegkenmerkFeatures(wegkenmerk, roadSectionId, coords) {

  const tile = await loadTile(getDatasetLayer(wegkenmerk), coords);
  const segments = tile.layers.segments;
  if (!segments) return [];

  return segments.features
    .map(feature => feature.properties)
    .filter(props => String(props.nwbRoadSectionId) === String(roadSectionId))
    .filter(props => !wegkenmerk.mainKey || hasValue(props[wegkenmerk.mainKey]));
}


// ---------------------------------------------------------
// 4. POPUP
// ---------------------------------------------------------

function createFieldTable(properties, fields) {

  const table = document.createElement("table");

  fields.forEach(({ key, label, format }) => {
    const value = properties[key];
    if (!hasValue(value)) return;

    const row = table.insertRow();
    const th = document.createElement("th");
    th.textContent = label;
    row.appendChild(th);
    row.insertCell().textContent = format ? format(value) : String(value);
  });

  return table;
}

function renderTrafficTypes(properties) {

  const table = document.createElement("table");

  const header = table.insertRow();
  ["", "heen", "terug"].forEach(text => {
    const th = document.createElement("th");
    th.textContent = text;
    header.appendChild(th);
  });

  Object.entries(TRAFFIC_TYPE_LABELS).forEach(([key, label]) => {
    const forward = properties[`${key}Forward`];
    const backward = properties[`${key}Backward`];
    if (forward === undefined && backward === undefined) return;

    const row = table.insertRow();
    row.insertCell().textContent = label;
    row.insertCell().textContent = forward ? "✓" : "✗";
    row.insertCell().textContent = backward ? "✓" : "✗";
  });

  return table;
}

// A wegvak can have several parts with different values (e.g. a speed
// limit that changes halfway); each part is labelled with its range.
function renderWegkenmerkSection(wegkenmerk, featuresProps) {

  const section = document.createElement("div");
  section.className = "wegvak-section";

  // Field tables already name the attribute in their rows, so only
  // custom renderings (like the traffic types table) get a heading.
  if (wegkenmerk.customRender) {
    const heading = document.createElement("h4");
    heading.textContent = wegkenmerk.title;
    section.appendChild(heading);
  }

  if (featuresProps.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-data";
    empty.textContent = `${wegkenmerk.title}: geen gegevens voor dit wegvak.`;
    section.appendChild(empty);
    return section;
  }

  featuresProps
    .sort((a, b) => (a.from ?? 0) - (b.from ?? 0))
    .forEach(props => {
      if (featuresProps.length > 1 && hasValue(props.from) && hasValue(props.to)) {
        const range = document.createElement("div");
        range.textContent = `Van ${props.from} m tot ${props.to} m:`;
        section.appendChild(range);
      }
      section.appendChild(
        wegkenmerk.customRender
          ? wegkenmerk.customRender(props)
          : createFieldTable(props, wegkenmerk.fields)
      );
    });

  return section;
}

async function onMapClick(e) {

  if (!wegvakkenEnabled() || map.getZoom() < WEGVAK_MIN_ZOOM) return;

  let wegvak;
  try {
    wegvak = await findNearestWegvak(e.latlng);
  } catch (err) {
    console.error("Could not load NWB tile:", err);
    return;
  }
  if (!wegvak) return;

  const content = document.createElement("div");
  content.className = "wegvak-popup";

  const title = document.createElement("strong");
  title.textContent = "NDW-wegvak";
  content.append(title, createFieldTable(wegvak.properties, NWB_FIELDS));

  const active = getActiveWegkenmerken();
  const loading = document.createElement("div");
  loading.className = "no-data";
  loading.textContent = active.length ? "Wegkenmerken laden…" : "";
  content.appendChild(loading);

  const popup = L.popup({ maxWidth: 400, minWidth: 250 })
    .setLatLng(e.latlng)
    .setContent(content)
    .openOn(map);

  const roadSectionId = wegvak.properties.roadSectionId;

  const sections = await Promise.all(
    active.map(async wegkenmerk => {
      try {
        const features = await findWegkenmerkFeatures(wegkenmerk, roadSectionId, wegvak.coords);
        return renderWegkenmerkSection(wegkenmerk, features);
      } catch (err) {
        console.error(`Could not load ${wegkenmerk.dataset}:`, err);
        const failed = document.createElement("div");
        failed.className = "no-data";
        failed.textContent = `${wegkenmerk.title}: kon niet worden geladen.`;
        return failed;
      }
    })
  );

  loading.remove();
  sections.forEach(section => content.appendChild(section));
  popup.update(); // resize to the new content
}


// ---------------------------------------------------------
// 5. EVENT LISTENERS
// ---------------------------------------------------------

document.getElementById("showWegvakken")
  .addEventListener("change", updateWegvakLayers);

// RVV-code selection changed (checkboxes or "Deselecteer alles")
document.getElementById("rvvCodeFilters")
  .addEventListener("change", updateWegvakLayers);
document.getElementById("clearRvvCodes")
  .addEventListener("click", updateWegvakLayers);

map.on("zoomend", () => {
  if (wegvakkenEnabled()) updateWegvakLayers();
});

map.on("click", onMapClick);
