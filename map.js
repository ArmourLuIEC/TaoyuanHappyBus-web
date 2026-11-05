(() => {
  'use strict';
  const data = globalThis.BUS_STOP_DATA;
  const display = globalThis.BUS_ROUTE_DISPLAY;
  const selection = globalThis.BUS_MAP_SELECTION;
  const roadData = globalThis.BUS_ROUTE_PATHS || { routes: {} };
  if (!data || !globalThis.L || !display || !selection) {
    document.getElementById('fatal-error').hidden = false;
    return;
  }
  const element = (id) => document.getElementById(id);
  const format = new Intl.NumberFormat('zh-TW');
  const operators = [...new Set(data.routes.flatMap((route) => route.operators))];
  const routeContext = display.createRouteContext(data, roadData);
  const directionLabels = { outbound: '往程', inbound: '返程', unspecified: '未標方向' };
  let state = selection.initialState();
  const map = L.map('map', { preferCanvas: true, fadeAnimation: false, zoomControl: false, attributionControl: true }).setView([24.98, 121.23], 10);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  const basemap = L.tileLayer('https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', {
    maxZoom: 19,
    crossOrigin: 'anonymous',
    attribution: '&copy; <a href="https://maps.nlsc.gov.tw/" target="_blank" rel="noopener">內政部國土測繪中心</a>',
  });
  let tileLoadFailed = false;
  basemap.on('loading', () => { tileLoadFailed = false; });
  basemap.on('tileerror', () => {
    tileLoadFailed = true;
    element('tile-warning').textContent = '底圖連線失敗，站點仍可查詢';
    element('tile-warning').hidden = false;
  });
  basemap.on('load', () => { if (!tileLoadFailed) element('tile-warning').hidden = true; });
  element('map').dataset.basemap = 'nlsc';
  basemap.addTo(map);
  const markers = L.featureGroup().addTo(map);
  const lines = L.featureGroup().addTo(map);
  const markerLookup = new Map();
  let fitBounds = [];
  function updateVisibleMarkers() {
    const bounds = map.getBounds().pad(.25);
    for (const marker of markerLookup.values()) {
      if (bounds.contains(marker.getLatLng())) {
        if (!markers.hasLayer(marker)) markers.addLayer(marker);
      } else if (markers.hasLayer(marker)) markers.removeLayer(marker);
    }
  }
  map.on('moveend', updateVisibleMarkers);
  const updateMarkerScale = () => {
    element('map').dataset.markerMode = display.markerMode(map.getZoom());
    element('map').dataset.zoom = map.getZoom();
  };
  map.on('zoomend', updateMarkerScale);
  updateMarkerScale();
  let currentEntries = [];
  let searchTimer;
  const selectedRoute = () => routeContext(state).route;
  const routePoints = (route) => display.routePoints(route, roadData.routes[route.id]);
  const keyFor = (point) => `${point.latitude.toFixed(7)},${point.longitude.toFixed(7)}`;
  const textMatches = (text, query) => (text || '').toLocaleLowerCase().includes(query);
  const create = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const filteredRoutes = () => routeContext(state).routes;

  function statusFor(route) {
    if (route.status === 'missing-pdf') return { text: '站址表缺檔', className: 'missing' };
    if (!route.points.length) return { text: 'GPS 待校對', className: 'pending' };
    const warning = route.warnings.length || route.points.some((point) => point.reviewReasons.length);
    const source = route.verification?.method === 'official-route' ? ' · 官方座標' : route.verification?.method === 'official-route-supplement' ? ' · 官方補充' : route.verification?.method === 'visual-pdf-review' ? ' · 原表已核對' : '';
    return { text: `${format.format(route.mappedPoints.length)} 筆 GPS${warning ? ' · 部分待確認' : source}`, className: warning ? 'pending' : '' };
  }

  function renderSidebar() {
    const route = selectedRoute();
    const stationView = state.view === 'stops' && route;
    element('route-list').hidden = Boolean(stationView);
    element('stop-list').hidden = !stationView;
    element('route-filters').hidden = Boolean(stationView);
    element('operator').value = state.operator;
    element('stops-tab').disabled = !route;
    element('routes-tab').setAttribute('aria-selected', String(!stationView));
    element('stops-tab').setAttribute('aria-selected', String(Boolean(stationView)));
    element('search').placeholder = stationView ? '站名或站址' : '路線、站名或站址';
    element('search').value = stationView ? state.stopQuery : state.routeQuery;
    element('clear-search').hidden = !element('search').value;
    element('reset-filters').hidden = stationView || !(state.routeQuery || state.operator !== 'all' || state.districts.length);
    element('district-label').textContent = state.districts.length ? `行政區：${state.districts.length} 個` : '行政區：全部';
    element('clear-districts').disabled = !state.districts.length;
    for (const checkbox of element('district-options').querySelectorAll('input')) checkbox.checked = state.districts.includes(checkbox.value);
    element('back-to-routes').hidden = !route;
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
        button.style.setProperty('--route-color', route.color);
        button.setAttribute('aria-pressed', String(route.id === state.activeId));
        button.title = `${route.code} · ${route.operators.join(' / ')}`;
        button.append(create('span', 'route-code', route.code));
        const copy = create('span', 'row-copy');
        copy.append(create('span', 'row-operator', route.operators.join(' / ')));
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
    for (const { route, point, color, opacity } of group.entries) {
      const entry = create('div', 'popup-entry');
      const routeButton = create('button', 'command-button popup-route', `${route.code} · ${directionLabels[point.direction]}${point.sequence === null ? '' : ` ${point.sequence}`}`);
      routeButton.style.setProperty('--route-color', color);
      routeButton.style.opacity = String(opacity);
      routeButton.title = `查看 ${route.code} 路線與站點`;
      if (globalThis.lucide) {
        const icon = globalThis.lucide.createElement(globalThis.lucide.ArrowRight);
        icon.setAttribute('aria-hidden', 'true');
        routeButton.append(icon);
      }
      routeButton.addEventListener('click', () => dispatch({ type: 'route', routeId: route.id, source: 'popup' }));
      entry.append(routeButton);
      entry.append(create('p', '', point.address || '無可核對的站址表地址'));
      if (point.reviewReasons.length) entry.append(create('p', 'popup-warning', '官方座標待確認，保留官方原值'));
      const officialLink = create('a', 'command-button', '官網');
      if (globalThis.lucide) {
        const icon = globalThis.lucide.createElement(globalThis.lucide.ArrowUpRight);
        icon.setAttribute('aria-hidden', 'true');
        officialLink.append(icon);
      }
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

  function fitMarkers(animate = false) {
    map.stop();
    map.invalidateSize({ pan: false });
    const bounds = L.latLngBounds(fitBounds);
    if (!bounds.isValid()) return;
    const options = { padding: [35, 35], maxZoom: 14 };
    if (animate && !globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches) map.flyToBounds(bounds, { ...options, duration: 0.8 });
    else map.fitBounds(bounds, { ...options, animate: false });
  }

  function renderMap(fit = false, animate = false) {
    const context = routeContext(state);
    const { route, groups } = context;
    currentEntries = context.currentEntries;
    fitBounds = context.fitBounds;
    markers.clearLayers();
    lines.clearLayers();
    markerLookup.clear();
    for (const group of groups) {
      const { key, selected, needsReview } = group;
      const position = [group.point.latitude, group.point.longitude];
      const badge = create('span', `stop-label${needsReview ? ' stop-label-warning' : ''}${group.sharedLabel ? ' stop-label-shared' : ''}`, group.text);
      badge.style.setProperty('--marker-color', group.color);
      badge.title = group.title;
      const marker = L.marker(position, {
        icon: L.divIcon({ html: badge, className: `numbered-stop-marker${selected ? '' : ' stop-marker-unselected'}`, iconSize: [32, 32], iconAnchor: [16, 16] }),
        title: badge.title,
        riseOnHover: true,
        zIndexOffset: selected ? 1000 : 0,
        opacity: group.opacity,
      });
      marker.on('click', () => dispatch({ type: 'station', routeId: group.routeId, key }));
      marker.bindPopup(() => popupFor(group), { maxWidth: 295 });
      marker.bindTooltip(create('span', '', group.tooltip), { direction: 'top' });
      markerLookup.set(key, marker);
    }
    for (const path of context.paths) {
      const polyline = L.polyline(path.coordinates, { ...path.style, interactive: true }).addTo(lines);
      polyline.on('click', () => dispatch({ type: 'route', routeId: path.routeId, source: 'path' }));
    }
    element('map').dataset.records = currentEntries.length;
    element('map').dataset.locations = groups.length;
    element('map').dataset.routes = new Set(currentEntries.map((entry) => entry.route.id)).size;
    element('map').dataset.lines = context.paths.length;
    element('map').dataset.lineSource = context.lineSource;
    element('map').dataset.lineRoutes = context.lineRoutes;
    element('map').dataset.numberedStops = groups.length;
    element('selection-copy').hidden = !route && !state.routeQuery && state.operator === 'all' && !state.districts.length;
    element('selection-title').textContent = route ? route.code : state.routeQuery || state.operator !== 'all' || state.districts.length ? '篩選站點' : '全部站點';
    element('selection-summary').textContent = route ? `${route.operators.join(' / ')} · ${format.format(currentEntries.length)} 筆 GPS` : `${new Set(currentEntries.map((entry) => entry.route.id)).size} 條路線 · ${format.format(currentEntries.length)} 筆 GPS`;
    element('clear-route').hidden = !route;
    element('map-empty').hidden = currentEntries.length > 0;
    element('empty-message').textContent = route ? route.points.length ? '此方向沒有可確認 GPS' : statusFor(route).text : '沒有相符站點';
    const legend = context.legend;
    element('map-legend').hidden = !legend.length;
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
    if (fit) fitMarkers(animate);
    updateVisibleMarkers();
  }

  function dispatch(action) {
    const result = selection.transition(state, action);
    state = result.state;
    const { effects } = result;
    if (effects.render !== 'none') renderSidebar();
    if (effects.render === 'all') renderMap(effects.fit, action.type === 'districts' || action.type === 'route');
    if (effects.stop) {
      if (effects.stop.position) map.setView(effects.stop.position, 15, { animate: false });
      markerLookup.get(effects.stop.key)?.openPopup();
    }
    if (effects.searchView) {
      element('clear-search').hidden = !element('search').value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => dispatch({ type: 'search-apply', view: effects.searchView }), 120);
    }
    if (effects.focusSearch) element('search').focus();
  }

  element('toggle-sidebar').addEventListener('click', (event) => {
    const sidebar = element('sidebar');
    const collapsed = !sidebar.hidden;
    sidebar.hidden = collapsed;
    document.querySelector('.app-body').classList.toggle('sidebar-collapsed', collapsed);
    event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
    event.currentTarget.setAttribute('aria-label', collapsed ? '展開路線與站點' : '收折路線與站點');
    event.currentTarget.title = collapsed ? '展開路線與站點' : '收折路線與站點';
    const icon = globalThis.lucide?.createElement(collapsed ? globalThis.lucide.PanelLeftOpen : globalThis.lucide.PanelLeftClose);
    if (icon) {
      icon.setAttribute('aria-hidden', 'true');
      event.currentTarget.replaceChildren(icon);
    }
    map.invalidateSize({ pan: true, animate: false });
  });
  element('route-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-route-id]');
    if (button) dispatch({ type: 'route', routeId: button.dataset.routeId, source: 'list' });
  });
  element('stop-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-stop-index]');
    if (!button || button.disabled) return;
    const point = routePoints(selectedRoute())[Number(button.dataset.stopIndex)];
    dispatch({ type: 'stop', point });
  });
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => dispatch({ type: 'view', view: button.dataset.view }));
  for (const button of document.querySelectorAll('[data-direction]')) button.addEventListener('click', () => dispatch({ type: 'direction', direction: button.dataset.direction }));
  element('search').addEventListener('input', () => dispatch({ type: 'search-input', value: element('search').value }));
  element('clear-search').addEventListener('click', () => dispatch({ type: 'clear-search' }));
  element('operator').addEventListener('change', () => dispatch({ type: 'operator', operator: element('operator').value }));
  element('reset-filters').addEventListener('click', () => dispatch({ type: 'reset-filters' }));
  element('back-to-routes').addEventListener('click', () => dispatch({ type: 'reset' }));
  element('clear-route').addEventListener('click', () => dispatch({ type: 'reset' }));
  element('fit-map').addEventListener('click', () => fitMarkers());
  for (const district of ['桃園區', '中壢區', '平鎮區', '八德區', '楊梅區', '蘆竹區', '大溪區', '龍潭區', '龜山區', '大園區', '觀音區', '新屋區', '復興區']) {
    const label = create('label');
    const checkbox = create('input');
    checkbox.type = 'checkbox';
    checkbox.value = district;
    label.append(checkbox, document.createTextNode(district));
    element('district-options').append(label);
  }
  element('district-options').addEventListener('change', () => {
    const districts = [...element('district-options').querySelectorAll('input:checked')].map((checkbox) => checkbox.value);
    dispatch({ type: 'districts', districts });
  });
  element('clear-districts').addEventListener('click', () => dispatch({ type: 'districts', districts: [] }));
  document.addEventListener('click', (event) => {
    if (!element('district-picker').contains(event.target)) element('district-picker').open = false;
  });
  element('district-picker').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && element('district-picker').open) {
      element('district-picker').open = false;
      element('district-picker').querySelector('summary').focus();
    }
  });
  for (const operator of operators) {
    const option = create('option', '', operator);
    option.value = operator;
    element('operator').append(option);
  }
  globalThis.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
  renderSidebar();
  renderMap(true);
  const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
  resizeObserver.observe(element('map'));
  element('map').dataset.ready = 'true';
})();