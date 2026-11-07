// Validate the complete contract, not just the binary packet version.
export const CONTRACT_KEYS = Object.freeze(['schema','wire','mode','authority','world','contentRevision','coordinates','tickHz','snapshotHz']);
export function validateContract(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== CONTRACT_KEYS.length || CONTRACT_KEYS.some(k=>!Object.hasOwn(value,k))) throw new Error('Invalid multiplayer contract shape');
  if(value.schema!==1 || value.wire!==2 || value.mode!=='survival' || value.authority!=='server' || value.coordinates!=='metres-y-up') throw new Error('Unsupported multiplayer contract');
  for(const key of ['world','contentRevision']) if(typeof value[key]!=='string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value[key])) throw new Error(`Invalid ${key}`);
  if(!Number.isInteger(value.tickHz) || value.tickHz<1 || value.tickHz>120 || !Number.isInteger(value.snapshotHz) || value.snapshotHz<1 || value.snapshotHz>value.tickHz) throw new Error('Invalid simulation rates');
  return Object.freeze({...value});
}
export function assertCompatible(expected, actual) {
  validateContract(expected);validateContract(actual);
  for(const key of CONTRACT_KEYS) if(expected[key]!==actual[key]) throw new Error(`Multiplayer contract mismatch: ${key}`);
}
export async function loadContract(url=new URL('./contract.json',import.meta.url)) {
  const response=await fetch(url);
  if(!response.ok)throw new Error('Cannot load multiplayer contract');
  return validateContract(await response.json());
}
