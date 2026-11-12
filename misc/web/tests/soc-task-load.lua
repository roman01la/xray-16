-- Usage: lua51-xray soc-task-load.lua PATH_TO_STAGED_TASK_MANAGER
local f = assert(io.open(assert(arg[1]), 'rb'))
local source = f:read('*a'); f:close()
local first = assert(source:find('function CRandomTask:load(p)', 1, true))
local last = assert(source:find('function CRandomTask:', first + 1, true))
CRandomTask = {}
printf = function() end
local marker = {}
utils = {
    r_CTime = function() return marker end,
    cfg_get_number = function(ini) assert(ini == 'target-ini'); return 88 end,
}
local lookups
alife = function() return {object = function(_, id)
    lookups = lookups + 1
    assert(id == 77, 'unset or altered task target reached alife')
    return {spawn_ini = function() return 'target-ini' end}
end} end
assert(loadstring(source:sub(first, last - 1)))()
local function check(target, kind)
    lookups = 0
    local counts, strings = 0, 0
    local packet = {
        r_u8 = function() counts = counts + 1; return counts == 1 and 1 or 0 end,
        r_stringZ = function() strings = strings + 1; return strings == 1 and 'task' or 'normal' end,
        r_bool = function() return false end,
        r_u32 = function() return target end,
    }
    local info = {type=kind, selected_target=123, defend_target=456}
    local tasks = {task_info={task=info}, active_task_by_type={}}
    CRandomTask.load(tasks, packet)
    assert(info.status == 'normal' and info.last_task_time == marker)
    if target == -1 or target == 4294967295 then
        assert(info.selected_target == nil and info.defend_target == nil)
        assert(lookups == 0)
    else
        assert(info.selected_target == target)
        assert(lookups == (kind == 'defend_lager' and 1 or 0))
        if kind == 'defend_lager' then assert(info.defend_target == 88) end
    end
end
check(-1, 'defend_lager')
check(4294967295, 'defend_lager')
check(77, 'defend_lager')
check(77, 'kill_stalker')
print('SoC task load: signed/unsigned sentinel, stale state, assigned target: passed')
