#pragma once
#include <emscripten.h>

// Shared with the optimized wasm64 ABI test; pointer arguments arrive as BigInt.
EM_JS(void, zone_weapon_fire, (unsigned tick, float yaw, float pitch, const char* item), {
    globalThis.zoneEngineFire?.({tick:tick>>>0,yaw,pitch}, item ? UTF8ToString(Number(item)) : null);
});
EM_JS(void, zone_weapon_trigger_start, (unsigned tick, float yaw, float pitch, const char* item), {
    globalThis.zoneEngineFire?.({tick:tick>>>0,yaw,pitch}, UTF8ToString(Number(item)), true);
});
EM_JS(void, zone_weapon_trigger_stop, (), {
    globalThis.zoneEngineTriggerStop?.();
});

EM_JS(void, zone_inventory_intent, (const char* id, unsigned revision, unsigned life, unsigned action, unsigned index), {
    const placement = action===2 ? {kind:'rucksack'} : action===3 ? {kind:'slot',slot:index} : {kind:'belt',cell:index};
    const kind = {1:'drop',5:'reload',6:'unload',7:'nextAmmo',9:'consume'}[action];
    const intent = {life:life>>>0,item:UTF8ToString(Number(id)),revision:revision>>>0,
        action:action===10?{kind:'fireMode',next:index===1}:
            action===13?{kind:'launcherMode',active:index===1}:kind?{kind}:{kind:'place',placement}};
    if(globalThis.zoneInventoryBatch) {globalThis.zoneInventoryBatch.push(intent);return;}
    globalThis.zoneEngineInventoryMove?.(intent).catch(error=>console.error('Inventory action:',error.message));
});

EM_JS(void, zone_inventory_batch_begin, (), {
    globalThis.zoneInventoryBatch=[];
});
EM_JS(void, zone_inventory_batch_end, (), {
    const intents=globalThis.zoneInventoryBatch;
    delete globalThis.zoneInventoryBatch;
    if(intents?.length)globalThis.zoneEngineInventoryBatch?.(intents).catch(error=>console.error('Inventory batch:',error.message));
});

EM_JS(void, zone_inventory_pickup, (const char* id, const char* source, unsigned revision, unsigned life), {
    globalThis.zoneEngineInventoryMove?.({life:life>>>0,item:UTF8ToString(Number(id)),revision:revision>>>0,action:{kind:'pickup',source:UTF8ToString(Number(source))}}).catch(error=>console.error('Pickup:',error.message));
});

EM_JS(void, zone_inventory_store, (const char* id, const char* destination, unsigned revision, unsigned life), {
    const intent = {life:life>>>0,item:UTF8ToString(Number(id)),revision:revision>>>0,
        action:{kind:'store',destination:UTF8ToString(Number(destination))}};
    if(globalThis.zoneInventoryBatch) {globalThis.zoneInventoryBatch.push(intent);return;}
    globalThis.zoneEngineInventoryMove?.(intent).catch(error=>console.error('Store:',error.message));
});
EM_JS(void, zone_inventory_attach, (const char* weapon, unsigned revision, const char* addon,
    unsigned addon_revision, unsigned life), {
    globalThis.zoneEngineInventoryMove?.({life:life>>>0,item:UTF8ToString(Number(weapon)),revision:revision>>>0,
        action:{kind:'attach',addon:UTF8ToString(Number(addon)),addonRevision:addon_revision>>>0}})
        .catch(error=>console.error('Attach addon:',error.message));
});
EM_JS(void, zone_inventory_detach, (const char* weapon, unsigned revision, unsigned life, unsigned slot), {
    const intent={life:life>>>0,item:UTF8ToString(Number(weapon)),revision:revision>>>0,
        action:{kind:'detach',slot:['scope','silencer','launcher'][slot]}};
    if(globalThis.zoneInventoryBatch) {globalThis.zoneInventoryBatch.push(intent);return;}
    globalThis.zoneEngineInventoryMove?.(intent).catch(error=>console.error('Detach addon:',error.message));
});

EM_JS(void, zone_corpse_open, (const char* source, unsigned life), {
    globalThis.zoneEngineCorpseIntent?.({kind:'open',source:UTF8ToString(Number(source)),life:life>>>0})
        .catch(error=>console.error('Corpse search:',error.message));
});

EM_JS(void, zone_corpse_dismiss, (unsigned life), {
    globalThis.zoneEngineCorpseIntent?.({kind:'dismiss',life:life>>>0})
        .catch(error=>console.error('Corpse search:',error.message));
});

EM_JS(void, zone_corpse_take, (const char* source, unsigned life, double generation, const char* ids), {
    globalThis.zoneEngineCorpseIntent?.({kind:'take',source:UTF8ToString(Number(source)),life:life>>>0,
        generation,items:UTF8ToString(Number(ids)).split(',')})
        .catch(error=>console.error('Corpse pickup:',error.message));
});
