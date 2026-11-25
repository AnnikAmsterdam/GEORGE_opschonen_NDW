// =========================================================
// 1. CONFIGURATION
// =========================================================

// Everything the UI needs to know about each status (GeoJSON "class").
const STATUSES = {
  match: {
    color: "green",
    label: "in beide bronnen gevonden",
  },
  only_panoramax: {
    color: "yellow",
    label: "alleen op de panoramafoto's gevonden",
  },
  only_george: {
    color: "blue",
    label: "alleen in GEORGE gevonden",
  },
  only_george_with_a_reason: {
    color: "red",
    label: "alleen in GEORGE gevonden, geen panoramafoto!",
  },
};

const UNKNOWN_STATUS_COLOR = "gray";
const UNKNOWN_RVV_CODE = "onbekend";

function getStatusColor(status) {
  return STATUSES[status]?.color ?? UNKNOWN_STATUS_COLOR;
}

function getStatusLabel(status) {
  return STATUSES[status]?.label ?? status;
}


// =========================================================
// 2. INITIAL MAP SETUP
// =========================================================

const map = L.map("map", {
  attributionControl: false,
  // Set explicitly: otherwise Leaflet borrows the minZoom of layers on the
  // map (the wegvakken layers use 14) and you can't zoom out past it.
  minZoom: 0,
  maxZoom: 22,
}).setView([52.37, 4.91], 15);

L.control.attribution({
  position: "bottomleft",
  prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>',
}).addTo(map);

// Basemap: NDW's own vector style (PDOK BRT/BGT/BAG + NWB wegvakken),
// rendered by MapLibre GL inside Leaflet.
const NDW_BASEMAP_STYLE = "https://maps.ndw.nu/styles/ndw-basemap/lib/style/style.json";

// The plugin normally builds the attribution from the style's sources,
// which lists NDW twice; customAttribution replaces that with one line.
L.maplibreGL({
  style: NDW_BASEMAP_STYLE,
  attributionControl: {
    customAttribution:
      '&copy; <a href="https://maps.ndw.nu/" target="_blank" rel="noopener noreferrer">NDW</a>, ' +
      '<a href="https://api.pdok.nl/" target="_blank" rel="noopener noreferrer">PDOK</a>, ' +
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
  },
}).addTo(map);


// =========================================================
// 3. DATA STRUCTURES
// =========================================================

const statuses = new Set();   // all statuses found in the data
const rvvCodes = new Set();   // all rvv codes found in the data

const featureRecords = [];    // one plain object per sign
const markerCache = new Map(); // record.id -> L.marker (created on demand)
const shownRecordIds = new Set(); // ids of markers currently in the cluster layer

// Clusters nearby markers so the map stays fast with ~100k signs.
// Markers outside the view are not drawn by the cluster layer itself.
const markerClusterLayer = L.markerClusterGroup({
  chunkedLoading: true,
  // Smaller clusters when zoomed in, so individual signs appear sooner
  maxClusterRadius: zoom => (zoom >= 18 ? 30 : 80),
}).addTo(map);


// =========================================================
// 4. HELPER FUNCTIONS
// =========================================================

function hasValue(value) {
  return (
    value !== null &&
    value !== undefined &&
    String(value).trim() !== "" &&
    String(value).toLowerCase() !== "none"
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value));
}

// Show a message on top of the map; pass null/"" to hide it.
function showMapMessage(text, isError = false) {
  const box = document.getElementById("mapMessage");
  box.textContent = text ?? "";
  box.classList.toggle("error", isError);
  box.hidden = !text;
}


// =========================================================
// 5. MARKERS + POPUPS
// =========================================================

// The icon is an HTML string (not DOM elements) because markers are
// re-created often by the cluster layer; all data is escaped.
function createArrowIcon(record) {

  const imagePath = `svg_verkeersborden/${encodeURIComponent(record.rvvCode)}.svg`;

  const blackCodeHtml = hasValue(record.blackCode)
    ? `<span class="marker-black-code">${escapeHtml(record.blackCode)}</span>`
    : "";

  const directionHtml = Number.isFinite(record.direction)
    ? `<div class="arrow"
            style="transform: rotate(${record.direction}deg); border-bottom-color: ${record.color};"></div>`
    : `<div class="no-direction-dot"
            style="background-color: ${record.color};"
            title="richting onbekend"></div>`;

  return L.divIcon({
    className: "arrow-marker",
    html: `
      <div class="marker-wrapper">
        <div class="marker-image-wrapper">
          <img
            class="marker-sign-image"
            src="${imagePath}"
            alt="${escapeHtml(record.rvvCode)}"
            onerror="this.style.display='none';"
          >
          ${blackCodeHtml}
        </div>
        <div class="arrow-wrapper">${directionHtml}</div>
      </div>
    `,
    iconSize: [44, 58],
    iconAnchor: [22, 43],
  });
}

// One popup section: a bold title with a link below it.
function createLinkSection(title, url) {
  const section = document.createElement("div");

  const heading = document.createElement("strong");
  heading.textContent = title;

  const link = document.createElement("a");
  link.href = url;
  link.textContent = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  section.append(heading, document.createElement("br"), link);
  return section;
}

function createPopupContent(record) {

  const sections = [];

  const summary = document.createElement("div");
  const statusText = document.createElement("strong");
  statusText.textContent = getStatusLabel(record.status);
  summary.append(
    statusText,
    document.createElement("br"),
    `rvv code: ${record.rvvCode}`
  );
  sections.push(summary);

  const links = [
    ["Panoramaxfoto van bord:", record.panoramaxUrl],
    ["Panoramaxfoto in de buurt van GEORGE-bord:", record.panoramaxLink],
    ["NDW-link naar GEORGE-bord:", record.georgeUrl],
  ];

  links.forEach(([title, url]) => {
    if (hasValue(url) && isHttpUrl(url)) {
      sections.push(createLinkSection(title, url));
    }
  });

  const container = document.createElement("div");
  sections.forEach((section, i) => {
    if (i > 0) container.appendChild(document.createElement("hr"));
    container.appendChild(section);
  });
  return container;
}

function getOrCreateMarker(record) {

  if (markerCache.has(record.id)) {
    return markerCache.get(record.id);
  }

  const marker = L.marker([record.lat, record.lng], {
    icon: createArrowIcon(record),
  });

  // Popup content is only built when the popup is opened
  marker.bindPopup(() => createPopupContent(record), {
    maxWidth: 500,
    minWidth: 300,
  });

  markerCache.set(record.id, marker);
  return marker;
}


// =========================================================
// 6. LOAD GEOJSON
// =========================================================

function parseFeature(feature, index) {

  // Skip invalid geometries (important for real datasets)
  if (
    !feature.geometry ||
    feature.geometry.type !== "Point" ||
    !Array.isArray(feature.geometry.coordinates)
  ) {
    console.warn("Skipping invalid feature:", feature);
    return null;
  }

  const props = feature.properties ?? {};

  let status = props.class;
  if (status === "only_george" && props.line_id === "not_seen_by_panoramax") {
    status = "only_george_with_a_reason";
  }

  const rvvCode = hasValue(props.rvvCode)
    ? String(props.rvvCode)
    : UNKNOWN_RVV_CODE;

  // direction is stored as a string in the GeoJSON; NaN if missing
  const direction = hasValue(props.direction)
    ? parseFloat(props.direction)
    : NaN;

  const [lng, lat] = feature.geometry.coordinates;

  return {
    id: feature.id ?? index,
    lat,
    lng,
    status,
    rvvCode,
    direction,
    blackCode: props.blackCode,
    panoramaxLink: props.panoramax_link,
    panoramaxUrl: props.panoramax_url,
    georgeUrl: props.george_map_url,
    color: getStatusColor(status),
  };
}

showMapMessage("Borden worden geladen…");

fetch("signs_new.geojson")
  .then(res => {
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return res.json();
  })
  .then(data => {

    data.features.forEach((feature, index) => {
      const record = parseFeature(feature, index);
      if (!record) return;

      featureRecords.push(record);
      statuses.add(record.status);
      rvvCodes.add(record.rvvCode);
    });

    createStatusCheckboxes();
    createRvvCodeCheckboxes();
    updateFilters();
  })
  .catch(err => {
    console.error("Could not load signs_new.geojson:", err);
    showMapMessage(
      `De borden konden niet worden geladen (signs_new.geojson): ${err.message}`,
      true
    );
  });


// =========================================================
// 7. SIDEBAR: STATUS FILTER
// =========================================================

function createStatusCheckboxes() {

  const container = document.getElementById("statusFilters");
  container.innerHTML = "";

  Array.from(statuses)
    .sort()
    .forEach(status => {

      const label = document.createElement("label");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = status;

      const colorDot = document.createElement("span");
      colorDot.className = "status-color";
      colorDot.style.backgroundColor = getStatusColor(status);
      colorDot.title = getStatusColor(status);

      label.append(checkbox, ` ${getStatusLabel(status)} `, colorDot);
      container.appendChild(label);
    });

  container.addEventListener("change", updateFilters);
}

// Select or deselect all status checkboxes
function setAllStatuses(state) {

  document.querySelectorAll("#statusFilters input")
    .forEach(cb => cb.checked = state);

  updateFilters();
}


// =========================================================
// 8. SIDEBAR: RVV-CODE FILTER (grouped by letter code)
// =========================================================

// Letter prefix of an rvv code: "A1" -> "A", "BW207" -> "BW",
// "(J1004 + OB)F" -> "J". Codes without letters go to "onbekend".
function getLetterCode(rvvCode) {
  if (rvvCode === UNKNOWN_RVV_CODE) return UNKNOWN_RVV_CODE;
  const match = rvvCode.match(/[A-Za-z]+/);
  return match ? match[0].toUpperCase() : UNKNOWN_RVV_CODE;
}

const naturalSort = (a, b) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

function createCheckboxLabel(value, text, className) {
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = className;
  if (value !== null) checkbox.value = value;
  label.append(checkbox, ` ${text}`);
  return label;
}

function createRvvCodeCheckboxes() {

  const container = document.getElementById("rvvCodeFilters");
  container.innerHTML = "";

  // letter code -> [rvv codes]
  const letterGroups = {};
  rvvCodes.forEach(rvvCode => {
    const letter = getLetterCode(rvvCode);
    (letterGroups[letter] ||= []).push(rvvCode);
  });

  Object.keys(letterGroups)
    .sort(naturalSort)
    .forEach(letter => {

      const codes = letterGroups[letter].sort(naturalSort);

      const group = document.createElement("div");
      group.className = "rvvCode-group";
      group.dataset.letter = letter;

      // Header row: expand arrow + group checkbox
      const header = document.createElement("div");
      header.className = "rvvCode-group-header";

      const toggle = document.createElement("span");
      toggle.className = "rvvCode-group-toggle";
      toggle.textContent = "▸";

      const headerLabel = createCheckboxLabel(
        null,
        `${letter} (${codes.length})`,
        "rvvCode-group-checkbox"
      );
      const groupCheckbox = headerLabel.querySelector("input");

      header.append(toggle, headerLabel);

      // Individual codes (hidden until the group is opened)
      const codeList = document.createElement("div");
      codeList.className = "rvvCode-group-codes";
      codes.forEach(rvvCode => {
        codeList.appendChild(
          createCheckboxLabel(rvvCode, rvvCode, "rvvCode-checkbox")
        );
      });

      group.append(header, codeList);
      container.appendChild(group);

      toggle.addEventListener("click", () => {
        setGroupOpen(group, !group.classList.contains("open"));
      });

      // Selecting a letter code opens it and selects all its codes;
      // the user can then deselect individual codes.
      // Codes hidden by the search box are left untouched.
      groupCheckbox.addEventListener("change", () => {
        codeList.querySelectorAll("label").forEach(label => {
          if (label.style.display === "none") return;
          label.querySelector("input").checked = groupCheckbox.checked;
        });
        if (groupCheckbox.checked) setGroupOpen(group, true);
      });
    });

  // Runs after the group checkbox handler above (event bubbling)
  container.addEventListener("change", () => {
    syncGroupCheckboxes();
    updateFilters();
  });
}

function setGroupOpen(group, open) {
  group.classList.toggle("open", open);
  group.querySelector(".rvvCode-group-toggle").textContent = open ? "▾" : "▸";
}

// Group checkbox reflects its codes: all checked, none, or some (indeterminate)
function syncGroupCheckboxes() {
  document.querySelectorAll("#rvvCodeFilters .rvvCode-group")
    .forEach(group => {
      const total = group.querySelectorAll(".rvvCode-checkbox").length;
      const checked = group.querySelectorAll(".rvvCode-checkbox:checked").length;
      const groupCheckbox = group.querySelector(".rvvCode-group-checkbox");
      groupCheckbox.checked = checked > 0 && checked === total;
      groupCheckbox.indeterminate = checked > 0 && checked < total;
    });
}

function filterRvvCodeList(e) {

  const query = e.target.value.trim().toLowerCase();

  document.querySelectorAll("#rvvCodeFilters .rvvCode-group")
    .forEach(group => {

      const letterMatch = group.dataset.letter.toLowerCase().includes(query);
      let anyCodeMatch = false;

      group.querySelectorAll(".rvvCode-group-codes label")
        .forEach(label => {
          const codeMatch =
            letterMatch || label.textContent.toLowerCase().includes(query);
          label.style.display = codeMatch ? "block" : "none";
          if (codeMatch) anyCodeMatch = true;
        });

      group.style.display = anyCodeMatch ? "block" : "none";

      // While searching, open groups so matching codes are visible
      if (query) {
        setGroupOpen(group, anyCodeMatch);
      }
    });
}

function clearAllRvvCodes() {
  document.querySelectorAll("#rvvCodeFilters input")
    .forEach(cb => {
      cb.checked = false;
      cb.indeterminate = false;
    });

  updateFilters();
}


// =========================================================
// 9. APPLY FILTERS TO THE MAP
// =========================================================

function getCheckedValues(selector) {
  return new Set(
    Array.from(document.querySelectorAll(selector)).map(cb => cb.value)
  );
}

function updateFilters() {

  const selectedStatuses = getCheckedValues("#statusFilters input:checked");
  const selectedRvvCodes = getCheckedValues("#rvvCodeFilters .rvvCode-checkbox:checked");

  // Old minimum-zoom check from before clustering. Probably no longer
  // needed now that markercluster keeps the map fast when zoomed out.
  // const minimumMarkerZoom = 15;

  // if (map.getZoom() < minimumMarkerZoom) {
  //   visibleMarkerLayer.clearLayers();
  //   return;
  // }

  const wantedRecords = featureRecords.filter(record =>
    selectedStatuses.has(record.status) && selectedRvvCodes.has(record.rvvCode)
  );
  const wantedIds = new Set(wantedRecords.map(record => record.id));

  // Only add/remove what changed, so open popups on unchanged markers stay open
  const toRemove = [];
  shownRecordIds.forEach(id => {
    if (!wantedIds.has(id)) toRemove.push(markerCache.get(id));
  });

  const toAdd = wantedRecords
    .filter(record => !shownRecordIds.has(record.id))
    .map(getOrCreateMarker);

  // Removing many markers one by one is slow in markercluster;
  // starting over is faster in that case.
  if (toRemove.length > shownRecordIds.size / 2) {
    markerClusterLayer.clearLayers();
    markerClusterLayer.addLayers(wantedRecords.map(getOrCreateMarker));
  } else {
    markerClusterLayer.removeLayers(toRemove);
    markerClusterLayer.addLayers(toAdd);
  }

  shownRecordIds.clear();
  wantedIds.forEach(id => shownRecordIds.add(id));

  updateEmptyMessage(selectedStatuses, selectedRvvCodes, wantedRecords.length);
}

function updateEmptyMessage(selectedStatuses, selectedRvvCodes, shownCount) {
  if (selectedStatuses.size === 0 || selectedRvvCodes.size === 0) {
    showMapMessage("Kies minstens één status en één RVV-code om borden te zien.");
  } else if (shownCount === 0) {
    showMapMessage("Geen borden gevonden voor deze combinatie van filters.");
  } else {
    showMapMessage(null);
  }
}

// =========================================================
// 10. EVENT LISTENERS
// =========================================================

document.getElementById("toggleSidebar")
  .addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("closed");
  });

document.getElementById("rvvCodeSearch")
  .addEventListener("input", filterRvvCodeList);

document.getElementById("clearRvvCodes")
  .addEventListener("click", clearAllRvvCodes);

document.getElementById("selectAllStatuses")
  .addEventListener("click", () => setAllStatuses(true));

document.getElementById("clearAllStatuses")
  .addEventListener("click", () => setAllStatuses(false));
