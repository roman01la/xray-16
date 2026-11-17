async function request(endpoint, params, signal, error) {
  const response = await fetch('./api/' + endpoint + '?' + params, {signal});
  if (!response.ok) throw new Error(error);
  return response;
}

export function createAssetSource() {
  return {
    async games() {
      return (await request('games', '', undefined, 'Start the OGF viewer server to browse game archives.')).json();
    },
    async catalog(game, maps, signal) {
      return (await request(maps ? 'maps' : 'catalog', new URLSearchParams({game}), signal,
        'The game catalog could not be loaded.')).json();
    },
    async placements(game, signal) {
      return (await request('placements', new URLSearchParams({game}), signal,
        'Could not load effect placements.')).json();
    },
    async motions(game, model, refs, signal) {
      const params = new URLSearchParams({game, model});
      refs.forEach(reference => params.append('ref', reference));
      return (await request('motions', params, signal, 'Could not resolve animation references.')).json();
    },
    async asset(game, path, signal) {
      return (await request('asset', new URLSearchParams({game, path}), signal,
        'Could not read ' + path + ' from the game archive.')).arrayBuffer();
    },
    orderTextures(game, textures) { return textures; },
  };
}
