(() => {
  'use strict';

  function initialState() {
    return { activeId: null, view: 'routes', routeQuery: '', stopQuery: '', operator: 'all', direction: 'all', stopKey: null };
  }

  function selectRoute(state, routeId) {
    return { ...state, activeId: routeId, direction: 'all', stopQuery: '', stopKey: null };
  }

  function resetSelection(state) {
    return { ...state, activeId: null, view: 'routes', direction: 'all', stopKey: null, stopQuery: '' };
  }

  function transition(state, action) {
    let next = { ...state };
    const effects = { render: 'all', fit: false };
    switch (action.type) {
      case 'route':
        if (action.source === 'path' && state.activeId === action.routeId) {
          effects.render = 'none';
          break;
        }
        next = selectRoute(state, action.routeId);
        if (action.source === 'popup') next.view = 'stops';
        effects.fit = action.source === 'list';
        break;
      case 'station': {
        const changed = state.activeId !== action.routeId;
        if (changed) next = selectRoute(state, action.routeId);
        next.view = 'stops';
        next.stopKey = action.key;
        effects.render = changed ? 'all' : 'sidebar';
        if (changed) effects.stop = { key: action.key };
        break;
      }
      case 'stop':
        next.stopKey = `${action.point.latitude.toFixed(7)},${action.point.longitude.toFixed(7)}`;
        effects.render = 'sidebar';
        effects.stop = { key: next.stopKey, position: [action.point.latitude, action.point.longitude] };
        break;
      case 'view':
        next.view = action.view;
        effects.render = 'sidebar';
        break;
      case 'direction':
        next.direction = action.direction;
        next.stopKey = null;
        break;
      case 'search-input': {
        const stationView = state.view === 'stops' && Boolean(state.activeId);
        if (stationView) next.stopQuery = action.value;
        else next.routeQuery = action.value;
        effects.render = 'none';
        effects.searchView = stationView ? 'stops' : 'routes';
        break;
      }
      case 'search-apply':
        if (action.view === 'stops') effects.render = 'sidebar';
        else next = resetSelection(state);
        break;
      case 'clear-search':
        if (state.view === 'stops') next.stopQuery = '';
        else next.routeQuery = '';
        effects.render = state.view === 'stops' ? 'sidebar' : 'all';
        effects.fit = state.view !== 'stops';
        effects.focusSearch = true;
        break;
      case 'operator':
        next = resetSelection({ ...state, operator: action.operator });
        break;
      case 'reset-filters':
        next = resetSelection({ ...state, routeQuery: '', operator: 'all' });
        break;
      case 'reset':
        next = resetSelection(state);
        break;
      case 'district':
        effects.render = 'none';
        effects.district = action.district;
        break;
      default:
        throw new Error(`Unknown selection action: ${action.type}`);
    }
    return { state: next, effects };
  }

  globalThis.BUS_MAP_SELECTION = Object.freeze({ initialState, transition });
})();