#pragma once

#include "xrUICore/Windows/UIWindow.h"

class CUICharacterInfo;
class CUIListBox;
class CUIScrollView;
class CUITabControl;
class CGameTask;

class CUISoCPdaSection final : public CUIWindow
{
public:
    enum class Kind { Quests, Diary, Contacts, Ranking, Encyclopedia };

    explicit CUISoCPdaSection(Kind kind);
    bool Init();
    void Show(bool status) override;
    void Refresh();
    void SendMessage(CUIWindow* sender, s16 message, void* data) override;

private:
    struct Entry
    {
        xr_string title;
        xr_string details;
        u16 characterId = u16(-1);
        const CGameTask* task = nullptr;
    };

    void CollectEntries();
    void ShowSelection();

    Kind m_kind;
    CUIListBox* m_list = nullptr;
    CUIScrollView* m_details = nullptr;
    CUITabControl* m_taskFilter = nullptr;
    CUICharacterInfo* m_character = nullptr;
    xr_vector<Entry> m_entries;
};
