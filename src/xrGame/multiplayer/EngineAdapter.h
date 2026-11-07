#pragma once
#include "Snapshot.h"
class IGame_Level;
namespace zone {
IGame_Level* createMapPreview();
bool mapPreviewEnabled();
void frame();
const SnapshotState& snapshot();
}
