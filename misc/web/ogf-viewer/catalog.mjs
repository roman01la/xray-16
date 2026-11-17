export const gameNames = {soc: 'Shadow of Chernobyl', cs: 'Clear Sky', cop: 'Call of Pripyat'};
export const maxAssetBytes = 64 * 1024 * 1024;
export const maxLevelBytes = 256 * 1024 * 1024;
export const levelFile = /^levels\/([^/]+)\/level(?:\.(?:geom|details|cform))?$/;

export function resolveMotions(game, model, reference) {
  const name = reference.trim().replaceAll('\\', '/').toLowerCase().replace(/\.omf$/, '');
  if (!name || name.startsWith('/') || name.split('/').includes('..')) return [];
  const level = /^levels\/[^/]+\//.exec(model)?.[0];
  const paths = level ? [level + name, 'meshes/' + name] : ['meshes/' + name];
  if (name.endsWith('/*')) {
    const directories = paths.map(path => path.slice(0, -1));
    return game.motions.filter(path => directories.some(dir => path.startsWith(dir) &&
      !path.slice(dir.length).includes('/')));
  }
  const match = paths.map(path => path + '.omf').find(path => game.assets.has(path));
  return match ? [match] : [];
}
