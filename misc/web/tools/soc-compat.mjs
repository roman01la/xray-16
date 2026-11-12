// Apply narrow compatibility changes to privately supplied SoC scripts. Keep
// original game data out of Git and preserve its legacy text encoding.
export function patchSocTaskManager(bytes) {
  let source = bytes.toString('latin1');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const target = /if selected_target ~= -1 then\s+self\.task_info\[id\]\.selected_target = selected_target\s+end/g;
  const defend = /if self\.task_info\[id\]\.type == "defend_lager" then/g;
  if ([...source.matchAll(target)].length !== 1 || [...source.matchAll(defend)].length !== 1)
    throw Error('Unsupported SoC task_manager: expected unique load-target guards');
  // w_u32(-1) is read as UINT32_MAX in the browser Lua binding. Both spellings
  // mean no target; never substitute the actor for an unassigned random task.
  source = source.replace(target, [
    'if selected_target ~= -1 and selected_target ~= 4294967295 then',
    '\t\t\tself.task_info[id].selected_target = selected_target',
    '\t\telse',
    '\t\t\tself.task_info[id].selected_target = nil',
    '\t\t\tself.task_info[id].defend_target = nil',
    '\t\tend',
  ].join(newline));
  source = source.replace(defend,
    'if self.task_info[id].type == "defend_lager" and self.task_info[id].selected_target ~= nil then');
  const killCompletion = /(elseif string\.find\(p1, "kill_stalker"\) ~= nil then\r?\n)\s*local oo = alife\(\):object\(sel_task\.selected_target\)[\s\S]*?(?=\t\telseif string\.find\(p1, "artefact"\))/g;
  const failCheck = /(function CRandomTask:task_fail\(p1, p2\)[\s\S]*?)(\t\tif sel_task\.status == "refused" or sel_task\.status == "failed" then)/g;
  const completeMethod = 'function CRandomTask:task_complete(p1, p2)';
  if ([...source.matchAll(killCompletion)].length !== 1 ||
      [...source.matchAll(failCheck)].length !== 1 ||
      source.split(completeMethod).length !== 2)
    throw Error('Unsupported SoC assassination task callbacks');

  // The A-Life registry contains offline NPCs too. An absent ID at task
  // evaluation is a lost target, while an existing dead NPC can be credited.
  source = source.replace(completeMethod, [
    'local function resolve_kill_target(task_desc)',
    '\tlocal id = task_desc.selected_target',
    '\tif type(id) ~= "number" or id < 0 or id >= 65535 then return nil end',
    '\tlocal target = alife():object(id)',
    '\tif target and target.alive then return target end',
    'end',
    '',
    completeMethod,
  ].join(newline));
  source = source.replace(killCompletion, [
    '$1\t\t\tlocal target = resolve_kill_target(sel_task)',
    '\t\t\tif sel_task.status == "completed" or sel_task.status == "rewarded" then',
    '\t\t\t\treturn true',
    '\t\t\tend',
    '\t\t\tif target and not target:alive() then',
    '\t\t\t\tsel_task.status = "completed"',
    '\t\t\t\treturn true',
    '\t\t\tend',
    '',
  ].join(newline));
  source = source.replace(failCheck, [
    '$1\t\tif sel_task.type == "kill_stalker" and sel_task.status == "selected" and not resolve_kill_target(sel_task) then',
    '\t\t\tsel_task.status = "failed"',
    '\t\tend',
    '$2',
  ].join(newline));
  return Buffer.from(source, 'latin1');
}

// The browser exposes a single renderer at index zero. The original menu used
// the renderer's position to gate controls supported by that renderer today.
export function patchSocVideoOptions(bytes) {
  let source = bytes.toString('latin1');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  for (const [control, gate] of [
    ['check_r2_sun', 'only_2_mode'],
    ['check_r2_sun_details', 'only_2_mode'],
    ['track_light_distance', 'only_12_mode'],
    ['track_particles_distance', 'only_12_mode'],
  ]) {
    const pattern = new RegExp(
      `("video_adv:${control}",[^\r\n]+\\r?\\n)[ \\t]*handler\\.m_preconditions\\[ctl\\][ \\t]*=[ \\t]*${gate}`, 'g');
    if ([...source.matchAll(pattern)].length !== 1)
      throw Error('Unsupported SoC graphics option gate: ' + control);
    source = source.replace(pattern, '$1');
  }
  const firstRow = /^([ \t]*)local (_st[ \t]*=[ \t]*xml:InitStatic[ \t]*\("video_adv:templ_item",[^\r\n]+)(?=\r?\n[ \t]*xml:InitStatic[ \t]*\("video_adv:cap_vis_dist")/gm;
  if ([...source.matchAll(firstRow)].length !== 1)
    throw Error('Unsupported SoC advanced video row layout');
  source = source.replace(firstRow, [
    '$1local $2',
    '$1xml:InitStatic("video_adv:cap_fps_limit", _st)',
    '$1xml:InitComboBox("video_adv:list_fps_limit", _st)',
    '',
    '$1$2',
  ].join(newline));
  return Buffer.from(source, 'latin1');
}

export function patchSocOptionsLayout(bytes) {
  let source = bytes.toString('latin1');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  source = source.replace(/(<tab_video>)([\s\S]*?)(<\/tab_video>)/, (_, start, body, end) => {
    for (const tag of ['cap_renderer', 'list_renderer']) {
      const row = new RegExp(`^[ \\t]*<${tag}\\b[\\s\\S]*?<\\/${tag}>[ \\t]*\\r?\\n`, 'gm');
      if ([...body.matchAll(row)].length !== 1)
        throw Error('Unsupported SoC renderer option layout: ' + tag);
      body = body.replace(row, '');
    }
    return start + body.replace(/(\by=")(50|80|110|140|170|200)"/g,
      (_, prefix, y) => prefix + (Number(y) - 30) + '"') + end;
  });
  const firstAdvancedCaption = /^\t\t<cap_vis_dist\b/gm;
  if ([...source.matchAll(firstAdvancedCaption)].length !== 1)
    throw Error('Unsupported SoC advanced video captions');
  source = source.replace(firstAdvancedCaption, [
    '\t\t<cap_fps_limit x="20" y="0" width="170" height="21">',
    '\t\t\t<text font="letterica16" r="215" g="195" b="170">ui_mm_fps_limit</text>',
    '\t\t</cap_fps_limit>',
    '\t\t<list_fps_limit x="194" y="0" width="245" height="21" list_length="5" always_show_scroll="0">',
    '\t\t\t<options_item entry="rs_fps_limit_preset" group="mm_opt_video_adv"/>',
    '\t\t\t<list_font font="letterica16" r="216" g="186" b="140"/>',
    '\t\t\t<text_color>',
    '\t\t\t\t<e r="216" g="186" b="140"/>',
    '\t\t\t\t<d r="227" g="199" b="178"/>',
    '\t\t\t</text_color>',
    '\t\t</list_fps_limit>',
    '',
    '$&',
  ].join(newline));
  const difficulty = /(<tab_gameplay>[\s\S]*?<\/list_difficulty>)/g;
  if ([...source.matchAll(difficulty)].length !== 1)
    throw Error('Unsupported SoC gameplay options layout');
  source = source.replace(difficulty, [
    '$1',
    '',
    '\t\t<cap_localization x="20" y="50" width="170" height="21">',
    '\t\t\t<text font="letterica16" r="215" g="195" b="170">ui_mm_localization</text>',
    '\t\t</cap_localization>',
    '\t\t<list_localization x="194" y="50" width="261" height="21" list_length="6" always_show_scroll="0">',
    '\t\t\t<options_item entry="g_language" group="mm_opt_gameplay"/>',
    '\t\t\t<list_font font="letterica16" r="216" g="186" b="140"/>',
    '\t\t\t<text_color>',
    '\t\t\t\t<e r="216" g="186" b="140"/>',
    '\t\t\t\t<d r="227" g="199" b="178"/>',
    '\t\t\t</text_color>',
    '\t\t</list_localization>',
  ].join(newline));
  // SoC's original menu writes these commands without rebuilding render
  // targets or grass buffers. Use the shared renderer's apply-time reset.
  for (const entry of ['vid_mode', '_preset', 'r__detail_density']) {
    const pattern = new RegExp(`(<options_item\\s+entry="${entry}"\\s+group="[^"]+")\\s*/>`, 'g');
    if ([...source.matchAll(pattern)].length !== 1)
      throw Error('Unsupported SoC video restart option: ' + entry);
    source = source.replace(pattern, '$1 depend="vid"/>');
  }
  return Buffer.from(source, 'latin1');
}

export function patchSocOptionsScript(bytes) {
  let source = bytes.toString('latin1');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const refresh = /[ \t]*self:AddCallback\("combo_preset",[^\r\n]+\r?\n/g;
  const accept = /(opt:SaveValues\("mm_opt_controls"\)\r?\n[ \t]*opt:OptionsPostAccept\(\)[^\r\n]*)/g;
  if ([...source.matchAll(refresh)].length !== 1 || [...source.matchAll(accept)].length !== 1)
    throw Error('Unsupported SoC options menu callbacks');
  for (const pattern of [
    /^[ \t]*self\.m_preconditions[ \t]*=[ \t]*\{\}[^\r\n]*\r?\n/gm,
    /^[ \t]*self\.b_r2_restart_shown[ \t]*=[ \t]*false[^\r\n]*\r?\n/gm,
    /^[ \t]*if not xrRender_test_r2_hw\(\) then\r?\n[\s\S]*?^[ \t]*end\r?\n/gm,
    /^[ \t]*self:UpdateDependControls\(\)\r?\n/gm,
    /^function options_dialog:UpdateDependControls\(\)[\s\S]*?^end\r?\n/gm,
    /^[ \t]*self:AddCallback\("combo_r2",[^\r\n]+\r?\n/gm,
    /^function options_dialog:OnR2changed\(\)[\s\S]*?^end\r?\n/gm,
  ]) {
    if ([...source.matchAll(pattern)].length !== 1)
      throw Error('Unsupported SoC renderer option callbacks');
    source = source.replace(pattern, '');
  }
  // Presets are applied on Accept, so refreshing on selection would restore
  // stale values and discard other edits. Save explicitly for browser reloads.
  return Buffer.from(source.replace(refresh, '').replace(accept, `$1${newline}\tconsole:execute("cfg_save")`), 'latin1');
}

export function patchSocBasicVideoScript(bytes) {
  const source = bytes.toString('latin1');
  const rendererControls = /^[ \t]*xml:InitStatic[ \t]*\("tab_video:cap_renderer",[^\r\n]+\r?\n[ \t]*handler\.combo_r2 = xml:InitComboBox\("tab_video:list_renderer",[^\r\n]+\r?\n[ \t]*handler:Register[ \t]*\(handler\.combo_r2,[^\r\n]+\r?\n/gm;
  if ([...source.matchAll(rendererControls)].length !== 1)
    throw Error('Unsupported SoC renderer option controls');
  return Buffer.from(source.replace(rendererControls, ''), 'latin1');
}

export function patchSocGameplayOptions(bytes) {
  const source = bytes.toString('latin1');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const difficulty = /^[ \t]*xml:InitComboBox\("tab_gameplay:list_difficulty",[^\r\n]+/gm;
  if ([...source.matchAll(difficulty)].length !== 1)
    throw Error('Unsupported SoC gameplay controls');
  return Buffer.from(source.replace(difficulty, [
    '$&',
    '\txml:InitStatic("tab_gameplay:cap_localization", self)',
    '\txml:InitComboBox("tab_gameplay:list_localization", self)',
  ].join(newline)), 'latin1');
}

export function patchSocAbort(bytes) {
  const source = bytes.toString('latin1');
  const abort = /function abort\(fmt, \.\.\.\)\r?\n\s*local reason = string\.format\(fmt, \.\.\.\)\r?\n\s*assert\("ERROR: " \.\. reason\)\r?\n\s*printf\("ERROR: " \.\. reason\)\r?\n\s*printf\("%s"\)\r?\nend/g;
  if ([...source.matchAll(abort)].length !== 1)
    throw Error('Unsupported SoC abort helper');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return Buffer.from(source.replace(abort, [
    'function abort(fmt, ...)',
    '\tlocal reason = select("#", ...) == 0 and fmt or string.format(fmt, ...)',
    '\terror(reason, 2)',
    'end',
  ].join(newline)), 'latin1');
}
