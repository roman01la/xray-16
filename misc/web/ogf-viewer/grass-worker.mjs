import {buildGroundIndex, detailInstances, readDetails} from './grass-data.mjs';

let details, groundHeight;
self.onmessage = ({data}) => {
  try {
    if (data.type === 'load') {
      details = readDetails(data.details);
      groundHeight = buildGroundIndex(data.collision, details, data.passable);
      // Keep only placement parameters on the worker side after uploading meshes.
      const prototypes = details.prototypes;
      details.prototypes = prototypes.map(({minScale, maxScale}) => ({minScale, maxScale}));
      const transfer = prototypes.flatMap(({vertices, indices, wind}) =>
        [vertices.buffer, indices.buffer, wind?.buffer].filter(Boolean));
      self.postMessage({type: 'ready', prototypes}, transfer);
    } else if (data.type === 'view') {
      const items = detailInstances(details, groundHeight, data.center, data.radius);
      self.postMessage({type: 'instances', key: data.key, items}, items.map(values => values.buffer));
    }
  } catch (error) {
    self.postMessage({type: 'error', message: error.message});
  }
};
