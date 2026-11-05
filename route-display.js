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

  globalThis.BUS_ROUTE_DISPLAY = Object.freeze({ routePoints, linePlan, sequenceLabel, stationName, markerMode });
})();