#pragma once
#include "Snapshot.h"
#include "InventoryState.h"
#include "WorldItemsState.h"
#include "CorpseSearchState.h"
class IGame_Level;
namespace zone {
IGame_Level* createMapPreview();
bool mapPreviewEnabled();
void frame();
const SnapshotState& snapshot();
const InventoryState& inventory();
const WorldItemsState& worldItems();
const CorpseSearchState& corpseSearch();
}
