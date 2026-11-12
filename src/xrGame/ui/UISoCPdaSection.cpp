#include "StdAfx.h"
#include "UISoCPdaSection.h"

#include "Actor.h"
#include "GameTask.h"
#include "GameTaskManager.h"
#include "Level.h"
#include "PDA.h"
#include "UICharacterInfo.h"
#include "UIHelper.h"
#include "UIXmlInit.h"
#include "ai_space.h"
#include "alife_object_registry.h"
#include "alife_registry_wrappers.h"
#include "alife_simulator.h"
#include "encyclopedia_article.h"
#include "game_news.h"
#include "xrEngine/StringTable/StringTable.h"
#include "xrServerEntities/xrServer_Objects_ALife_Monsters.h"
#include "xrUICore/ListBox/UIListBox.h"
#include "xrUICore/Static/UIStatic.h"
#include "xrUICore/TabControl/UITabControl.h"
#include "xrUICore/Windows/UIFrameWindow.h"

CUISoCPdaSection::CUISoCPdaSection(Kind kind)
    : CUIWindow("SoC PDA section"), m_kind(kind)
{
}

bool CUISoCPdaSection::Init()
{
    // Use the original PDA layouts. The list and details widgets are shared
    // across sections, with content drawn from the current game state.
    struct Layout
    {
        pcstr xml;
        pcstr left, leftHeader, list;
        pcstr right, rightHeader, details;
    };
    static constexpr Layout layouts[] = {
        {"pda_events.xml", "main_wnd:left_frame", "main_wnd:left_frame:left_frame_header",
            "main_wnd:left_frame:list", "main_wnd:right_frame:task_descr_view:main_frame",
            "main_wnd:right_frame:task_descr_view:main_frame:header_frame_line",
            "main_wnd:right_frame:task_descr_view:main_frame:scroll_view"},
        {"events_new.xml", "main_wnd:left_frame", "main_wnd:left_frame:left_frame_header",
            "main_wnd:left_frame:work_area:src_list", "main_wnd:right_frame",
            "main_wnd:right_frame:right_frame_header", "main_wnd:right_frame:work_area:scroll_view"},
        {"pda_contacts_new.xml", "left_frame_window", "left_frame_line", "list",
            "right_frame_window", "right_frame_line", "detail_list"},
        {"stalkers_ranking.xml", "info_frame_window", "info_frame_line", "list",
            "chicon_frame_window", "chicon_frame_line", "character_info"},
        {"encyclopedia.xml", "right_frame_window", "right_frame_line", "idx_list",
            "left_frame_window", "left_frame_line", "info_list"},
    };
    const Layout& layout = layouts[static_cast<unsigned>(m_kind)];
    CUIXml xml;
    if (!xml.Load(CONFIG_PATH, UI_PATH, UI_PATH_DEFAULT, layout.xml, false) ||
        !xml.NavigateToNode(layout.list) || !xml.NavigateToNode(layout.details))
        return false;

    CUIXmlInit::InitWindow(xml, "main_wnd", 0, this);
    auto* left = UIHelper::CreateFrameWindow(xml, layout.left, this);
    auto* right = UIHelper::CreateFrameWindow(xml, layout.right, this);
    if (m_kind == Kind::Quests)
    {
        const pcstr path = "main_wnd:right_frame";
        right->SetWndPos({xml.ReadAttribFlt(path, 0, "x"), xml.ReadAttribFlt(path, 0, "y")});
    }
    UIHelper::CreateFrameLine(xml, layout.leftHeader, left);
    UIHelper::CreateFrameLine(xml, layout.rightHeader, right);

    m_list = xr_new<CUIListBox>();
    left->AttachChild(m_list);
    m_list->SetAutoDelete(true);
    CUIXmlInit::InitScrollView(xml, layout.list, 0, m_list);
    if (m_kind == Kind::Diary)
    {
        const pcstr path = "main_wnd:left_frame:work_area";
        auto pos = m_list->GetWndPos();
        pos.add(Fvector2().set(xml.ReadAttribFlt(path, 0, "x"), xml.ReadAttribFlt(path, 0, "y")));
        m_list->SetWndPos(pos);
    }
    m_list->SetItemsSelectable(true);
    m_list->SetFont(UI().Font().pFontLetterica16Russian);
    m_list->SetTextColor(color_rgba(225, 225, 250, 255));
    m_list->SetMessageTarget(this);
    if (m_kind == Kind::Ranking)
    {
        auto* frame = UIHelper::CreateNormalWindow(xml, layout.details, right);
        m_character = xr_new<CUICharacterInfo>();
        frame->AttachChild(m_character);
        m_character->SetAutoDelete(true);
        m_character->InitCharacterInfo({0, 0}, frame->GetWndSize(), "stalkers_ranking_character.xml");
        return true;
    }
    m_details = UIHelper::CreateScrollView(xml, layout.details, right);
    if (m_kind == Kind::Quests)
    {
        m_taskFilter = xr_new<CUITabControl>();
        left->AttachChild(m_taskFilter);
        m_taskFilter->SetAutoDelete(true);
        CUIXmlInit::InitTabControl(xml, "main_wnd:left_frame:filter_tab", 0, m_taskFilter, true, true);
        if (m_taskFilter->GetTabsCount())
            m_taskFilter->SetActiveTabByIndex(0);
        m_taskFilter->SetMessageTarget(this);
    }
    if (m_kind == Kind::Diary)
    {
        const pcstr path = "main_wnd:right_frame:work_area";
        auto pos = m_details->GetWndPos();
        pos.add(Fvector2().set(xml.ReadAttribFlt(path, 0, "x"), xml.ReadAttribFlt(path, 0, "y")));
        m_details->SetWndPos(pos);
    }
    return true;
}

void CUISoCPdaSection::CollectEntries()
{
    m_entries.clear();
    CActor* actor = Actor();
    if (!actor)
        return;

    switch (m_kind)
    {
    case Kind::Quests:
    {
        auto& manager = Level().GameTaskManager();
        auto* active = manager.ActiveTask();
        const int filter = m_taskFilter->GetActiveIndex();
        const auto state = filter == 1 ? eTaskStateCompleted : filter == 2 ? eTaskStateFail : eTaskStateInProgress;
        for (const auto& key : manager.GetGameTasks())
        {
            auto* task = key.game_task;
            if (!task || task->GetTaskState() != state)
                continue;
            Entry entry{StringTable().translate(task->GetTitle_script()).c_str(), {}};
            entry.task = task;
            if (const auto* description = task->GetDescription_script(); description && *description)
                entry.details = StringTable().translate(description).c_str();
            for (TASK_OBJECTIVE_ID i = 1; i < task->GetObjectivesCount(); ++i)
            {
                const auto* objective = task->GetObjective_script(i);
                if (!objective || (state == eTaskStateInProgress && objective->GetTaskState() != eTaskStateInProgress))
                    continue;
                const auto* text = objective->GetDescription_script();
                if (!text || !*text)
                    text = objective->GetTitle_script();
                if (text && *text)
                {
                    entry.details += "\n";
                    entry.details += StringTable().translate(text).c_str();
                }
            }
            if (task == active)
                m_entries.insert(m_entries.begin(), std::move(entry));
            else
                m_entries.push_back(std::move(entry));
        }
        break;
    }
    case Kind::Diary:
    case Kind::Encyclopedia:
    {
        const auto type = m_kind == Kind::Diary ? ARTICLE_DATA::eJournalArticle : ARTICLE_DATA::eEncyclopediaArticle;
        for (const auto& data : actor->encyclopedia_registry->registry().objects())
        {
            if (data.article_type != type)
                continue;
            CEncyclopediaArticle article;
            article.Load(data.article_id);
            m_entries.push_back({StringTable().translate(article.data()->name).c_str(), article.data()->text});
        }
        if (m_kind == Kind::Diary)
        {
            const auto& news = actor->game_news_registry->registry().objects();
            for (auto it = news.rbegin(); it != news.rend(); ++it)
                m_entries.push_back({it->news_caption.c_str(), it->news_text.c_str()});
        }
        break;
    }
    case Kind::Contacts:
    {
        xr_vector<CPda*> contacts;
        if (auto* pda = actor->GetPDA())
            pda->ActivePDAContacts(contacts);
        for (auto* pda : contacts)
        {
            auto* owner = pda->GetOriginalOwner();
            if (owner)
                m_entries.push_back({owner->Name(), owner->Name()});
        }
        break;
    }
    case Kind::Ranking:
    {
        xr_vector<const CSE_ALifeTraderAbstract*> ranked;
        if (auto* alife = ai().get_alife())
        {
            for (const auto& [id, object] : alife->objects().objects())
            {
                auto* trader = object->cast_trader_abstract();
                auto* creature = object->cast_creature_abstract();
                if (trader && creature && creature->g_Alive() && !trader->m_character_name.empty())
                    ranked.push_back(trader);
            }
        }
        std::stable_sort(ranked.begin(), ranked.end(), [](const auto* a, const auto* b) {
            return a->m_rank > b->m_rank;
        });
        for (size_t i = 0; i < ranked.size(); ++i)
        {
            const auto* trader = ranked[i];
            if (i >= 20 && trader->base()->ID != actor->ID())
                continue;
            string32 place;
            xr_sprintf(place, "%zu. ", i + 1);
            m_entries.push_back({xr_string(place) + trader->m_character_name, {}, trader->base()->ID});
        }
        break;
    }
    }
}

void CUISoCPdaSection::Show(bool status)
{
    CUIWindow::Show(status);
    if (status)
        Refresh();
}

void CUISoCPdaSection::Refresh()
{
    const auto previousIndex = m_list->GetSelectedIDX();
    const auto* selectedTask = previousIndex < m_entries.size() ? m_entries[previousIndex].task : nullptr;
    CollectEntries();
    m_list->Clear();
    u32 selectedIndex = 0;
    for (u32 i = 0; i < m_entries.size(); ++i)
    {
        const auto& entry = m_entries[i];
        m_list->AddTextItem(entry.title.c_str());
        if (selectedTask && entry.task == selectedTask)
            selectedIndex = i;
    }
    if (!m_entries.empty())
        m_list->SetSelectedIDX(selectedIndex);
    m_list->SetScrollPos(0);
    ShowSelection();
}

void CUISoCPdaSection::SendMessage(CUIWindow* sender, s16 message, void* data)
{
    if (sender == m_taskFilter && message == TAB_CHANGED)
    {
        Refresh();
        return;
    }
    if (sender == m_list && message == LIST_ITEM_CLICKED)
    {
        ShowSelection();
        return;
    }
    CUIWindow::SendMessage(sender, message, data);
}

void CUISoCPdaSection::ShowSelection()
{
    const auto index = m_list->GetSelectedIDX();
    if (m_character)
    {
        m_character->Show(index < m_entries.size());
        if (index < m_entries.size())
            m_character->InitCharacter(m_entries[index].characterId);
        return;
    }
    m_details->Clear();
    if (index >= m_entries.size())
        return;
    const auto& entry = m_entries[index];
    ADD_TEXT_TO_VIEW2(entry.title.c_str(), m_details);
    if (!entry.details.empty() && entry.details != entry.title)
    {
        ADD_TEXT_TO_VIEW2(entry.details.c_str(), m_details);
    }
    m_details->SetScrollPos(0);
}
