// Wound.cpp: класс описания раны
//
//////////////////////////////////////////////////////////////////////

#include "StdAfx.h"
#include "Wound.h"
#include "CombatRules.h"
#include "xrCore/Animation/Bone.hpp"

CWound::CWound(u16 bone_num)
{
    m_bToBeDestroy = false;

    m_Wounds.resize(ALife::eHitTypeMax);
    for (u32 i = 0; i < ALife::eHitTypeMax; i++)
    {
        m_Wounds[i] = 0.f;
    }

    m_iBoneNum = bone_num;
    m_iParticleBoneNum = BI_NONE;

    m_fDropTime = 0.f;
}

CWound::~CWound(void) {}
// serialization
void CWound::save(NET_Packet& output_packet)
{
    output_packet.w_u8((u8)m_iBoneNum);
    for (u32 i = 0; i < ALife::eHitTypeMax; i++)
        output_packet.w_float_q8(m_Wounds[i], 0.f, xray::combat::maxWoundSize);
}
void CWound::load(IReader& input_packet)
{
    m_iBoneNum = (u8)input_packet.r_u8();
    for (u32 i = 0; i < ALife::eHitTypeMax; i++)
    {
        m_Wounds[i] = input_packet.r_float_q8(0.f, xray::combat::maxWoundSize);
        VERIFY(m_Wounds[i] >= 0.0f && m_Wounds[i] <= xray::combat::maxWoundSize);
    }
}

float CWound::TotalSize()
{
    float total_size = 0.f;
    for (u32 i = 0; i < ALife::eHitTypeMax; i++)
    {
        VERIFY(_valid(m_Wounds[i]));
        total_size += m_Wounds[i];
    }
    VERIFY(_valid(total_size));
    return total_size;
}

float CWound::TypeSize(ALife::EHitType hit_type) { return m_Wounds[hit_type]; }
//кол-во кровавых ран
float CWound::BloodSize() { return m_Wounds[ALife::eHitTypeWound] + m_Wounds[ALife::eHitTypeFireWound]; }
void CWound::AddHit(float hit_power, ALife::EHitType hit_type)
{
    m_Wounds[hit_type] = xray::combat::addWoundHit(m_Wounds[hit_type], hit_power);
}

void CWound::Incarnation(float percent, float min_wound_size)
{
    xray::combat::healWound(m_Wounds.begin(), m_Wounds.size(), percent, min_wound_size, EPS_S);
}
