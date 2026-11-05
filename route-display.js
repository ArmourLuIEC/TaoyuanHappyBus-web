(() => {
  'use strict';
  const directions = ['outbound', 'inbound', 'unspecified'];
  const stationName = (text) => (text || '').normalize('NFKC').replace(/\s+/g, '').replace(/^(?:站距)?\d+\.\d+/, '');

  function routePoints(route, official) {
    if (!official || !route.points.length || route.points.some((point) => point.direction !== 'unspecified')) return route.points;
    const available = ['outbound', 'inbound'].filter((direction) => official.stations[direction]?.length);
    const starts = route.points.filter((point) => point.sequence === 1);
    if (!available.length || starts.length !== available.length) return route.points;
    const ordered = starts.map((point) => available.find((direction) => stationName(official.stations[direction][0].name) === stationName(point.name)));
    if (ordered.some((direction) => !direction) || new Set(ordered).size !== available.length) return route.points;
    const occurrences = new Map();
    const inferred = route.points.map((point) => {
      const occurrence = occurrences.get(point.sequence) || 0;
      occurrences.set(point.sequence, occurrence + 1);
      return { ...point, direction: ordered[occurrence], directionSource: 'official-sequence-endpoints' };
    });
    if (inferred.some((point) => !point.direction || !Number.isInteger(point.sequence))) return route.points;
    for (const direction of available) {
      const points = inferred.filter((point) => point.direction === direction).sort((first, second) => first.sequence - second.sequence);
      const stations = official.stations[direction];
      if (points.length !== stations.length || points.some((point, index) => point.sequence !== stations[index].sequence)
        || stationName(points.at(-1).name) !== stationName(stations.at(-1).name)) return route.points;
    }
    return inferred;
  }

  function linePlan(route, official, direction = 'all') {
    if (!route || !route.points.length) return { source: 'none', lines: [] };
    const activeDirections = directions.filter((entry) => direction === 'all' || entry === direction);
    const roads = activeDirections.filter((entry) => official?.paths[entry]?.length > 1)
      .map((entry) => ({ direction: entry, coordinates: official.paths[entry] }));
    if (roads.length) return { source: 'official', lines: roads };
    const points = routePoints(route, official);
    const lines = [];
    for (const entry of activeDirections) {
      const ordered = points.filter((point) => point.direction === entry).sort((first, second) => first.sequence - second.sequence);
      if (!ordered.length || ordered.some((point) => !Number.isInteger(point.sequence)) || new Set(ordered.map((point) => point.sequence)).size !== ordered.length) continue;
      let segment = [];
      const flush = () => {
        if (segment.length > 1) lines.push({ direction: entry, coordinates: segment.map((point) => [point.latitude, point.longitude]) });
        segment = [];
      };
      for (const point of ordered) {
        if (point.reviewReasons.length || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
          flush();
          continue;
        }
        if (segment.length && point.sequence !== segment.at(-1).sequence + 1) flush();
        segment.push(point);
      }
      flush();
    }
    return { source: lines.length ? 'station-sequence' : 'none', lines };
  }

  function sequenceLabel(entries) {
    const values = [...new Set(entries.map((entry) => entry.point.sequence).filter((value) => Number.isInteger(value) && value > 0))].sort((first, second) => first - second);
    if (!values.length) return { text: '?', full: '站序未擷取' };
    const full = values.join('/');
    return { text: full.length <= 5 ? full : `${values[0]}+`, full: `站序 ${full}` };
  }

  function markerMode(zoom) {
    if (zoom < 12) return 'overview';
    if (zoom < 15) return 'compact';
    return 'full';
  }

  function coordinateBounds(coordinates) {
    if (!coordinates.length) return [];
    let south = Infinity;
    let west = Infinity;
    let north = -Infinity;
    let east = -Infinity;
    for (const [latitude, longitude] of coordinates) {
      south = Math.min(south, latitude);
      west = Math.min(west, longitude);
      north = Math.max(north, latitude);
      east = Math.max(east, longitude);
    }
    return [[south, west], [north, east]];
  }

  function createRouteContext(data, roadData = { routes: {} }) {
    const collator = new Intl.Collator('zh-Hant', { numeric: true });
    const palette = ['#137b49', '#bb3540', '#1767b0', '#ba6100', '#783d99', '#008478', '#b43173', '#695e11'];
    const directionColors = { outbound: '#176b54', inbound: '#c65d47', unspecified: '#227b98' };
    const labels = { outbound: '往程', inbound: '返程', unspecified: '未標方向' };
    const matches = (text, query) => (text || '').toLocaleLowerCase().includes(query);
    const routes = [...data.routes].sort((first, second) => collator.compare(first.code, second.code)).map((route, index) => ({
      ...route,
      color: palette[index % palette.length],
      mappedPoints: routePoints(route, roadData.routes[route.id]).filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
        && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180),
    }));
    const plans = new Map(routes.map((route) => [route.id, new Map(['all', ...directions].map((direction) => [direction, linePlan(route, roadData.routes[route.id], direction)]))]));
    let lastKey;
    let lastContext;

    return (state = {}) => {
      const key = JSON.stringify([state.activeId, state.operator, state.routeQuery, state.direction]);
      if (key === lastKey) return lastContext;
      const route = routes.find((entry) => entry.id === state.activeId);
      const query = (state.routeQuery || '').trim().toLocaleLowerCase();
      const direction = state.direction || 'all';
      const filtered = routes.filter((entry) => (!state.operator || state.operator === 'all' || entry.operators.includes(state.operator))
        && (!query || matches(entry.code, query) || entry.operators.some((operator) => matches(operator, query))
          || entry.points.some((point) => matches(point.name, query) || matches(point.address, query))));
      const visibleRoutes = route && !filtered.includes(route) ? [...filtered, route] : filtered;
      const entries = visibleRoutes.flatMap((entry) => entry.mappedPoints.filter((point) => (route && entry !== route) || direction === 'all' || point.direction === direction)
        .map((point) => ({ route: entry, point })));
      const currentEntries = route ? entries.filter((entry) => entry.route === route) : entries;
      const locations = new Map();
      for (const entry of entries) {
        const key = `${entry.point.latitude.toFixed(7)},${entry.point.longitude.toFixed(7)}`;
        if (!locations.has(key)) locations.set(key, { key, point: entry.point, entries: [] });
        locations.get(key).entries.push(entry);
      }
      const groups = [...locations.values()].map((group) => {
        const activeEntries = route ? group.entries.filter((entry) => entry.route === route) : [];
        const selected = activeEntries.length > 0;
        const shownEntries = selected ? activeEntries : group.entries;
        const needsReview = shownEntries.some((entry) => entry.point.reviewReasons.length);
        const label = sequenceLabel(shownEntries);
        const title = `${group.point.name || 'GPS 站點'}${selected ? ` · ${label.full}` : ''}`;
        return {
          ...group,
          entries: group.entries.map((entry) => ({
            ...entry,
            color: entry.route === route ? directionColors[entry.point.direction] : entry.route.color,
            opacity: route && entry.route !== route ? .33 : 1,
          })),
          routeId: (activeEntries[0] || group.entries[0]).route.id,
          selected,
          needsReview,
          color: needsReview ? '#b45309' : selected ? directionColors[shownEntries[0].point.direction] : group.entries[0].route.color,
          opacity: route && !selected ? .33 : 1,
          text: selected ? label.text : '',
          sharedLabel: label.text.length > 3,
          title,
          tooltip: `${title}${group.entries.length > 1 ? ` · ${group.entries.length} 筆` : ''}`,
        };
      });
      const visiblePlans = visibleRoutes.map((entry) => ({ route: entry, ...plans.get(entry.id).get(!route || entry === route ? direction : 'all') }))
        .filter((plan) => plan.lines.length);
      if (route) visiblePlans.sort((first, second) => Number(first.route === route) - Number(second.route === route));
      const paths = visiblePlans.flatMap((plan) => plan.lines.map((line) => {
        const selected = plan.route === route;
        return {
          routeId: plan.route.id,
          coordinates: line.coordinates,
          selected,
          style: {
            color: selected ? directionColors[line.direction] : plan.route.color,
            weight: plan.source === 'official' ? selected ? 4 : 2.5 : 2,
            opacity: route ? selected ? .8 : .33 : .65,
            dashArray: plan.source === 'official' ? undefined : '5 6',
          },
        };
      }));
      const sources = new Set(visiblePlans.map((plan) => plan.source));
      const fitPaths = route ? paths.filter((path) => path.selected) : paths;
      const fitStops = route ? groups.filter((group) => group.selected) : groups;
      const legend = route ? Object.entries(labels).filter(([entry]) => currentEntries.some(({ point }) => point.direction === entry))
        .map(([entry, label]) => ({ label, color: directionColors[entry] })) : [];
      if (currentEntries.some(({ point }) => point.reviewReasons.length)) legend.push({ label: 'GPS 異常（原值）', color: '#b45309' });
      lastContext = {
        route,
        routes: filtered,
        currentEntries,
        groups,
        paths,
        legend,
        fitBounds: coordinateBounds(fitPaths.length ? fitPaths.flatMap((path) => path.coordinates) : fitStops.map((group) => [group.point.latitude, group.point.longitude])),
        lineSource: sources.size === 1 ? visiblePlans[0].source : sources.size > 1 ? 'mixed' : 'none',
        lineRoutes: visiblePlans.length,
      };
      lastKey = key;
      return lastContext;
    };
  }

  globalThis.BUS_ROUTE_DISPLAY = Object.freeze({ routePoints, linePlan, sequenceLabel, stationName, markerMode, createRouteContext });
})();