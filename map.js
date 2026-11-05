(() => {
  'use strict';
  const data = globalThis.BUS_STOP_DATA;
  const display = globalThis.BUS_ROUTE_DISPLAY;
  const roadData = globalThis.BUS_ROUTE_PATHS || { routes: {} };
  if (!data || !globalThis.L || !display) {
    document.getElementById('fatal-error').hidden = false;
    return;
  }
  const element = (id) => document.getElementById(id);
  const format = new Intl.NumberFormat('zh-TW');
  const collator = new Intl.Collator('zh-Hant', { numeric: true });
  const palette = ['#176b54', '#c65d47', '#227b98', '#a17b24', '#665e8b'];
  const operators = [...new Set(data.routes.flatMap((route) => route.operators))];
  const operatorColors = new Map(operators.map((operator, index) => [operator, palette[index % palette.length]]));
  const directionColors = { outbound: '#176b54', inbound: '#c65d47', unspecified: '#227b98' };
  const directionLabels = { outbound: '往程', inbound: '返程', unspecified: '未標方向' };
  const state = { activeId: null, view: 'routes', routeQuery: '', stopQuery: '', operator: 'all', direction: 'all', lines: true, stopKey: null };
  const map = L.map('map', { preferCanvas: true, fadeAnimation: false, zoomControl: false, attributionControl: true }).setView([24.98, 121.23], 10);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  const basemaps = [
    {
      id: 'nlsc',
      name: '臺灣通用電子地圖',
      layer: L.tileLayer('https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', {
        maxZoom: 19,
        crossOrigin: 'anonymous',
        attribution: '&copy; <a href="https://maps.nlsc.gov.tw/" target="_blank" rel="noopener">內政部國土測繪中心</a>',
      }),
    },
    {
      id: 'carto',
      name: 'CARTO 淺色底圖',
      layer: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
        crossOrigin: 'anonymous',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
      }),
    },
  ];
  const failedBasemaps = new Set();
  let activeBasemap;
  function useBasemap(provider) {
    if (provider === activeBasemap) return;
    if (activeBasemap) map.removeLayer(activeBasemap.layer);
    activeBasemap = provider;
    element('map').dataset.basemap = provider.id;
    element('tile-warning').hidden = true;
    provider.layer.addTo(map);
  }
  for (const provider of basemaps) {
    provider.layer.on('tileerror', () => {
      if (activeBasemap !== provider) return;
      failedBasemaps.add(provider.id);
      const backup = basemaps.find((candidate) => !failedBasemaps.has(candidate.id));
      if (backup) useBasemap(backup);
      else {
        element('tile-warning').textContent = '底圖連線失敗，站點仍可查詢';
        element('tile-warning').hidden = false;
      }
    });
    provider.layer.on('load', () => {
      if (activeBasemap === provider && !failedBasemaps.has(provider.id)) element('tile-warning').hidden = true;
    });
  }
  const basemapControl = L.control.layers(Object.fromEntries(basemaps.map((provider) => [provider.name, provider.layer])), null, { position: 'topright' }).addTo(map);
  const basemapToggle = basemapControl.getContainer().querySelector('.leaflet-control-layers-toggle');
  basemapToggle.title = '底圖來源';
  basemapToggle.setAttribute('aria-label', '底圖來源');
  map.on('baselayerchange', (event) => {
    const provider = basemaps.find((candidate) => candidate.layer === event.layer);
    if (provider && provider !== activeBasemap) {
      failedBasemaps.clear();
      useBasemap(provider);
    }
  });
  useBasemap(basemaps[0]);
  const markers = L.featureGroup().addTo(map);
  const lines = L.featureGroup().addTo(map);
  const markerLookup = new Map();
  const updateMarkerScale = () => {
    element('map').dataset.markerMode = display.markerMode(map.getZoom());
    element('map').dataset.zoom = map.getZoom();
  };
  map.on('zoomend', updateMarkerScale);
  updateMarkerScale();
  let currentEntries = [];
  let searchTimer;
  const selectedRoute = () => data.routes.find((route) => route.id === state.activeId);
  const routePoints = (route) => display.routePoints(route, roadData.routes[route.id]);
  const validPoints = (route) => routePoints(route).filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180);
  const keyFor = (point) => `${point.latitude.toFixed(7)},${point.longitude.toFixed(7)}`;
  const textMatches = (text, query) => (text || '').toLocaleLowerCase().includes(query);
  const create = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function filteredRoutes() {
    const query = state.routeQuery.trim().toLocaleLowerCase();
    return data.routes.filter((route) => {
      if (state.operator !== 'all' && !route.operators.includes(state.operator)) return false;
      return !query || textMatches(route.code, query) || route.operators.some((operator) => textMatches(operator, query))
        || route.points.some((point) => textMatches(point.name, query) || textMatches(point.address, query));
    }).sort((first, second) => collator.compare(first.code, second.code));
  }

  function statusFor(route) {
    if (route.status === 'missing-pdf') return { text: '站址表缺檔', className: 'missing' };
    if (!route.points.length) return { text: 'GPS 待校對', className: 'pending' };
    const warning = route.warnings.length || route.points.some((point) => point.reviewReasons.length);
    const source = route.verification?.method === 'official-route' ? ' · 官方座標' : route.verification?.method === 'official-route-supplement' ? ' · 官方補充' : route.verification?.method === 'visual-pdf-review' ? ' · 原表已核對' : '';
    return { text: `${format.format(validPoints(route).length)} 筆 GPS${warning ? ' · 部分待確認' : source}`, className: warning ? 'pending' : '' };
  }

  function renderSidebar() {
    const route = selectedRoute();
    const stationView = state.view === 'stops' && route;
    element('route-list').hidden = Boolean(stationView);
    element('stop-list').hidden = !stationView;
    element('route-filters').hidden = Boolean(stationView);
    element('stops-tab').disabled = !route;
    element('routes-tab').setAttribute('aria-selected', String(!stationView));
    element('stops-tab').setAttribute('aria-selected', String(Boolean(stationView)));
    element('search').placeholder = stationView ? '站名或站址' : '路線、站名或站址';
    element('search').value = stationView ? state.stopQuery : state.routeQuery;
    element('clear-search').hidden = !element('search').value;
    element('reset-filters').hidden = stationView || !(state.routeQuery || state.operator !== 'all');
    element('stop-tab-count').textContent = route ? format.format(route.points.length) : '0';
    if (stationView) {
      const query = state.stopQuery.trim().toLocaleLowerCase();
      const stops = routePoints(route).map((point, index) => ({ point, index })).filter(({ point }) => (state.direction === 'all' || point.direction === state.direction)
        && (!query || textMatches(point.name, query) || textMatches(point.address, query)));
      element('results-title').textContent = `${route.code} 站點`;
      element('results-count').textContent = `${stops.length} 筆`;
      const fragment = document.createDocumentFragment();
      for (const { point, index } of stops) {
        const button = create('button', `stop-row${point.reviewReasons.length ? ' review' : ''}${state.stopKey === keyFor(point) ? ' active' : ''}`);
        button.dataset.stopIndex = index;
        button.title = point.reviewReasons.length ? `原始 GPS 待確認：${point.gpsRaw.join(', ')}` : point.name || '站名未擷取';
        button.append(create('span', 'stop-number', point.sequence ?? '-'));
        const copy = create('span', 'row-copy');
        copy.append(create('span', 'stop-name', point.name || '站名未擷取'));
        copy.append(create('span', 'stop-address', point.reviewReasons.length ? `GPS 待確認 · ${point.gpsRaw.join(', ')}` : `${directionLabels[point.direction]} · ${point.address || '站址未擷取'}`));
        button.append(copy);
        fragment.append(button);
      }
      element('stop-list').replaceChildren(fragment);
      if (!stops.length) element('stop-list').append(create('p', 'list-empty', route.points.length ? '沒有相符站點' : statusFor(route).text));
    }
    else {
      const routes = filteredRoutes();
      element('results-title').textContent = '路線清單';
      element('results-count').textContent = `${routes.length} 條`;
      element('route-tab-count').textContent = routes.length;
      const fragment = document.createDocumentFragment();
      for (const route of routes) {
        const button = create('button', 'route-row');
        button.dataset.routeId = route.id;
        button.setAttribute('aria-pressed', String(route.id === state.activeId));
        button.title = `${route.code} · ${route.operators.join(' / ')}`;
        button.append(create('span', 'route-code', route.code));
        const copy = create('span', 'row-copy');
        copy.append(create('span', 'row-operator', route.operators.join(' / ')));
        const status = statusFor(route);
        const statusNode = create('span', `row-status ${status.className}`);
        statusNode.append(create('span', 'status-dot'), document.createTextNode(status.text));
        copy.append(statusNode);
        button.append(copy);
        fragment.append(button);
      }
      element('route-list').replaceChildren(fragment);
      if (!routes.length) element('route-list').append(create('p', 'list-empty', '沒有相符路線'));
    }
  }

  function popupFor(group) {
    const content = create('div', 'stop-popup');
    content.append(create('div', 'popup-title', group.entries[0].point.name || 'GPS 站點'));
    content.append(create('div', 'popup-coordinates', `緯度 ${group.point.latitude.toFixed(6)}\n經度 ${group.point.longitude.toFixed(6)}`));
    const list = create('div', 'popup-list');
    for (const { route, point } of group.entries) {
      const entry = create('div', 'popup-entry');
      const routeButton = create('button', 'command-button popup-route', `${route.code} · ${directionLabels[point.direction]}${point.sequence === null ? '' : ` ${point.sequence}`}`);
      routeButton.addEventListener('click', () => { selectRoute(route.id); state.view = 'stops'; renderSidebar(); });
      entry.append(routeButton);
      entry.append(create('p', '', point.address || '無可核對的站址表地址'));
      if (point.reviewReasons.length) entry.append(create('p', 'popup-warning', '官方座標待確認，保留官方原值'));
      const officialLink = create('a', 'command-button', '官網');
      officialLink.href = `https://ebus.tycg.gov.tw/ebus/driving-map/${route.id}`;
      officialLink.target = '_blank';
      officialLink.rel = 'noopener';
      officialLink.title = `${route.code} 官方公車路線頁面`;
      entry.append(officialLink);
      list.append(entry);
    }
    content.append(list);
    return content;
  }

  function fitMarkers() {
    map.invalidateSize({ pan: false });
    const bounds = lines.getLayers().length ? lines.getBounds() : markers.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [35, 35], maxZoom: 14, animate: false });
  }

  function renderMap(fit = false) {
    const route = selectedRoute();
    const routes = route ? [route] : filteredRoutes();
    currentEntries = routes.flatMap((route) => validPoints(route).filter((point) => state.direction === 'all' || point.direction === state.direction).map((point) => ({ route, point })));
    markers.clearLayers();
    lines.clearLayers();
    markerLookup.clear();
    const groups = new Map();
    for (const entry of currentEntries) {
      const key = keyFor(entry.point);
      if (!groups.has(key)) groups.set(key, { point: entry.point, entries: [] });
      groups.get(key).entries.push(entry);
    }
    for (const [key, group] of groups) {
      const needsReview = group.entries.some((entry) => entry.point.reviewReasons.length);
      const color = needsReview ? '#b45309' : route ? directionColors[group.point.direction] : operatorColors.get(group.entries[0].route.operators[0]);
      const position = [group.point.latitude, group.point.longitude];
      const label = display.sequenceLabel(group.entries);
      const badge = create('span', `stop-label${needsReview ? ' stop-label-warning' : ''}${label.text.length > 3 ? ' stop-label-shared' : ''}`, label.text);
      badge.style.setProperty('--marker-color', color);
      badge.title = `${group.point.name || 'GPS 站點'} · ${label.full}`;
      const marker = L.marker(position, {
        icon: L.divIcon({ html: badge, className: 'numbered-stop-marker', iconSize: [32, 32], iconAnchor: [16, 16] }),
        title: badge.title,
        riseOnHover: true,
      });
      marker.bindPopup(() => popupFor(group), { maxWidth: 295 });
      marker.bindTooltip(create('span', '', `${group.point.name || 'GPS 站點'} · ${label.full}${group.entries.length > 1 ? ` · ${group.entries.length} 筆` : ''}`), { direction: 'top' });
      marker.addTo(markers);
      markerLookup.set(key, marker);
    }
    const plans = routes.map((entry) => ({ route: entry, ...display.linePlan(entry, roadData.routes[entry.id], state.direction) })).filter((plan) => plan.lines.length);
    const sources = new Set(plans.map((plan) => plan.source));
    const lineSource = sources.size === 1 ? plans[0].source : sources.size > 1 ? 'mixed' : 'none';
    element('connect-stops').disabled = !plans.length;
    element('connect-stops').checked = Boolean(state.lines && plans.length);
    element('connection-label').textContent = lineSource === 'official' ? '官方路線' : lineSource === 'station-sequence' ? '站序連線' : '路線連線';
    let lineCount = 0;
    if (state.lines) {
      for (const plan of plans) {
        for (const line of plan.lines) {
          const color = route ? directionColors[line.direction] : operatorColors.get(plan.route.operators[0]);
          L.polyline(line.coordinates, { color, weight: plan.source === 'official' ? route ? 4 : 2.5 : 2, opacity: route ? .8 : .65, dashArray: plan.source === 'official' ? undefined : '5 6', interactive: false }).addTo(lines);
          lineCount += 1;
        }
      }
    }
    element('map').dataset.records = currentEntries.length;
    element('map').dataset.locations = groups.size;
    element('map').dataset.routes = new Set(currentEntries.map((entry) => entry.route.id)).size;
    element('map').dataset.lines = lineCount;
    element('map').dataset.lineSource = state.lines && lineCount ? lineSource : 'none';
    element('map').dataset.lineRoutes = state.lines ? plans.length : 0;
    element('map').dataset.numberedStops = groups.size;
    element('selection-copy').hidden = !route && !state.routeQuery && state.operator === 'all';
    element('selection-title').textContent = route ? route.code : state.routeQuery || state.operator !== 'all' ? '篩選站點' : '全部站點';
    element('selection-summary').textContent = route ? `${route.operators.join(' / ')} · ${format.format(currentEntries.length)} 筆 GPS` : `${new Set(currentEntries.map((entry) => entry.route.id)).size} 條路線 · ${format.format(currentEntries.length)} 筆 GPS`;
    element('clear-route').hidden = !route;
    element('map-empty').hidden = currentEntries.length > 0;
    element('empty-message').textContent = route ? route.points.length ? '此方向沒有可確認 GPS' : statusFor(route).text : '沒有相符站點';
    element('map-legend').hidden = !currentEntries.length;
    const legend = route ? Object.entries(directionLabels).filter(([direction]) => currentEntries.some((entry) => entry.point.direction === direction)).map(([direction, label]) => ({ label, color: directionColors[direction] }))
      : operators.map((operator) => ({ label: operator.replace('(9人座)', ''), color: operatorColors.get(operator) }));
    if (currentEntries.some((entry) => entry.point.reviewReasons.length)) legend.push({ label: 'GPS 異常（原值）', color: '#b45309' });
    element('map-legend').replaceChildren(...legend.map(({ label, color }) => {
      const item = create('span', 'legend-item');
      const swatch = create('span', 'legend-swatch');
      swatch.style.setProperty('--swatch', color);
      item.append(swatch, document.createTextNode(label));
      return item;
    }));
    for (const button of document.querySelectorAll('[data-direction]')) {
      button.setAttribute('aria-pressed', String(button.dataset.direction === state.direction));
      button.hidden = button.dataset.direction === 'unspecified' && (!route || !routePoints(route).some((point) => point.direction === 'unspecified'));
    }
    if (fit) fitMarkers();
  }

  function selectRoute(id) {
    state.activeId = id;
    state.direction = 'all';
    state.stopQuery = '';
    state.stopKey = null;
    state.lines = true;
    renderSidebar();
    renderMap();
  }

  function resetSelection() {
    state.activeId = null;
    state.view = 'routes';
    state.direction = 'all';
    state.stopKey = null;
    state.stopQuery = '';
    renderSidebar();
    renderMap();
  }

  element('route-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-route-id]');
    if (button) selectRoute(button.dataset.routeId);
  });
  element('stop-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-stop-index]');
    if (!button || button.disabled) return;
    const point = routePoints(selectedRoute())[Number(button.dataset.stopIndex)];
    state.stopKey = keyFor(point);
    renderSidebar();
    map.setView([point.latitude, point.longitude], 15, { animate: false });
    markerLookup.get(state.stopKey)?.openPopup();
  });
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => { state.view = button.dataset.view; renderSidebar(); });
  for (const button of document.querySelectorAll('[data-direction]')) button.addEventListener('click', () => { state.direction = button.dataset.direction; state.stopKey = null; renderSidebar(); renderMap(); });
  element('search').addEventListener('input', () => {
    const query = element('search').value;
    const stationView = state.view === 'stops' && selectedRoute();
    if (stationView) state.stopQuery = query; else state.routeQuery = query;
    element('clear-search').hidden = !query;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (stationView) renderSidebar(); else resetSelection(); }, 120);
  });
  element('clear-search').addEventListener('click', () => { if (state.view === 'stops') state.stopQuery = ''; else state.routeQuery = ''; renderSidebar(); if (state.view !== 'stops') renderMap(true); element('search').focus(); });
  element('operator').addEventListener('change', () => { state.operator = element('operator').value; resetSelection(); });
  element('reset-filters').addEventListener('click', () => { state.routeQuery = ''; state.operator = 'all'; element('operator').value = 'all'; resetSelection(); });
  element('clear-route').addEventListener('click', resetSelection);
  element('fit-map').addEventListener('click', fitMarkers);
  element('connect-stops').addEventListener('change', () => { state.lines = element('connect-stops').checked; renderMap(); });
  for (const operator of operators) {
    const option = create('option', '', operator);
    option.value = operator;
    element('operator').append(option);
  }
  element('data-summary').textContent = `官方座標 ${format.format(data.stats.officialStops || 0)} 筆 · ${data.stats.missingPDFs} 條原表缺檔 · ${data.stats.reviewStops} 筆官方 GPS 待確認`;
  const date = data.routes[0]?.retrievedAt?.slice(0, 10);
  if (date && element('data-date')) {
    element('data-date').dateTime = date;
    element('data-date').textContent = date.replaceAll('-', '.');
  }
  globalThis.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
  renderSidebar();
  renderMap(true);
  const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
  resizeObserver.observe(element('map'));
  element('map').dataset.ready = 'true';
})();