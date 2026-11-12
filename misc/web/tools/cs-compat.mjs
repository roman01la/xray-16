// Apply browser menu changes to the original Clear Sky resources.
function replaceOnce(source, pattern, replacement, description) {
  if ([...source.matchAll(pattern)].length !== 1)
    throw Error('Unsupported Clear Sky ' + description);
  return source.replace(pattern, replacement);
}

export function patchCsBasicVideo(bytes) {
  let source = bytes.toString('latin1');
  source = replaceOnce(source,
    /^[ \t]*xml:InitStatic[^\r\n]*"tab_video:cap_renderer"[^\r\n]*\r?\n[ \t]*handler\.combo_renderer[^\r\n]*\r?\n[ \t]*handler:Register[^\r\n]*\r?\n/gm,
    '', 'renderer controls');
  source = source.replaceAll('tab_video:cap_fullscreen', 'tab_video:cap_window_mode');
  source = replaceOnce(source,
    /xml:InitCheck([ \t]*\("tab_video:check_fullscreen")/g,
    'xml:InitComboBox$1', 'window mode control');
  source = source.replaceAll('tab_video:check_fullscreen', 'tab_video:list_window_mode');
  source = replaceOnce(source, /(self\.bk = xml:InitFrame[^\r\n]*\r?\n)/g,
    '$1\txml:InitStatic("tab_video:cap_fps_limit", self)\n\txml:InitComboBox("tab_video:list_fps_limit", self)\n',
    'basic video frame');
  return Buffer.from(source, 'latin1');
}

export function patchCsAdvancedVideo(bytes) {
  let source = bytes.toString('latin1');
  // The WebGPU backend supports the effects formerly gated on R3 or DX10.1.
  source = replaceOnce(source, /local bEnabled\s*= render_get_dx_level\(\)>=655361/g,
    'local bEnabled = true', 'MSAA optimization gate');
  for (const name of ['r1_no_detail_textures', '60hz']) {
    const row = new RegExp('^[ \\t]*_st[^\\r\\n]*xml:InitStatic[^\\r\\n]*"video_adv:templ_item"[^\\r\\n]*\\r?\\n' +
      '[ \\t]*xml:InitStatic[^\\r\\n]*"video_adv:cap_' + name + '"[^\\r\\n]*\\r?\\n' +
      '[ \\t]*(?:ctl[^\\r\\n]*= )?xml:InitCheck[^\\r\\n]*"video_adv:check_' + name + '"[^\\r\\n]*\\r?\\n' +
      '(?:[ \\t]*handler\\.m_preconditions\\[ctl\\][^\\r\\n]*\\r?\\n)?', 'gm');
    source = replaceOnce(source, row, '', name + ' row');
  }
  return Buffer.from(source, 'latin1');
}

export function patchCsOptionsScript(bytes) {
  let source = bytes.toString('latin1');
  source = replaceOnce(source, /--\[\[\r?\n\s*if not xrRender_test_r2_hw\(\) then[\s\S]*?\]\]/g,
    '', 'obsolete hardware check');
  source = replaceOnce(source, /local _current_id\s*= self\.combo_renderer:CurrentID\(\)/g,
    'local _current_id = 4 -- WebGPU supports the R3 effect controls.', 'effect capability selection');
  for (const name of ['combo_renderer', 'combo_preset']) {
    source = replaceOnce(source, new RegExp('^[ \\t]*self:AddCallback\\("' + name + '"[^\\r\\n]*\\r?\\n', 'gm'),
      '', name + ' callback');
  }
  source = replaceOnce(source, /^function options_dialog:OnPresetChanged\(\)[\s\S]*?^end\r?\n/gm,
    '', 'preset refresh');
  source = replaceOnce(source, /(opt:SaveValues\("mm_opt_controls"\)\s+opt:OptionsPostAccept\(\))/g,
    '$1\n\tconsole:execute("cfg_save")\n\tconsole:execute("browser_window_mode apply")', 'settings apply');
  source = replaceOnce(source, /(function options_dialog:OnBtnCancel\(\))/g,
    '$1\n\tget_console():execute("browser_window_mode discard")', 'settings cancel');
  return Buffer.from(source, 'latin1');
}

export function patchCsOptionsLayout(bytes) {
  let source = bytes.toString('latin1');
  const caption = source.match(/<cap_renderer\b[\s\S]*?<\/cap_renderer>/)?.[0];
  const list = source.match(/<list_renderer\b[\s\S]*?<\/list_renderer>/)?.[0];
  if (!caption || !list) throw Error('Unsupported Clear Sky renderer row');
  source = source.replace(caption, caption.replaceAll('cap_renderer', 'cap_fps_limit').replace('ui_mm_renderer', 'ui_mm_fps_limit'));
  source = source.replace(list, list.replaceAll('list_renderer', 'list_fps_limit')
    .replace('entry="renderer"', 'entry="rs_fps_limit_preset"').replace(' depend="restart"', ''));
  const resolutionList = source.match(/<list_resolution\b[\s\S]*?<\/list_resolution>/)?.[0];
  const fullscreen = source.match(/<check_fullscreen\b[\s\S]*?<\/check_fullscreen>/)?.[0];
  if (!resolutionList || !fullscreen) throw Error('Unsupported Clear Sky window mode row');
  const y = fullscreen.match(/\by="([^"]+)"/)[1];
  source = source.replaceAll('cap_fullscreen', 'cap_window_mode').replace('ui_mm_fullscreen', 'ui_mm_window_mode');
  source = source.replace(fullscreen, resolutionList.replaceAll('list_resolution', 'list_window_mode')
    .replace(/\by="[^"]+"/, `y="${y}"`).replace('entry="vid_mode"', 'entry="vid_window_mode"')
    .replace(' depend="vid"', ''));
  for (const tag of ['cap_snd_device', 'list_snd_device', 'cap_r1_no_detail_textures',
    'check_r1_no_detail_textures', 'cap_60hz', 'check_60hz']) {
    source = replaceOnce(source, new RegExp('<' + tag + '\\b[\\s\\S]*?<\\/' + tag + '>', 'g'), '', tag);
  }
  // Shader and buffer changes use the same apply-time renderer reset as CoP.
  source = source.replaceAll('depend="restart"', 'depend="vid"');
  source = replaceOnce(source, /(<options_item entry="r__detail_density" group="mm_opt_video_adv")\s*\/>/g,
    '$1 depend="vid"/>', 'grass density reset');
  source = replaceOnce(source, /(<options_item entry="r2_sun_quality" group="mm_opt_video")\s*\/>/g,
    '$1 depend="vid"/>', 'shadow quality reset');
  const difficultyCaption = source.match(/<cap_difficulty\b[\s\S]*?<\/cap_difficulty>/)?.[0];
  const difficultyList = source.match(/<list_difficulty\b[\s\S]*?<\/list_difficulty>/)?.[0];
  if (!difficultyCaption || !difficultyList) throw Error('Unsupported Clear Sky gameplay options');
  const languageCaption = difficultyCaption.replaceAll('cap_difficulty', 'cap_localization')
    .replace(/\by="[^"]+"/, 'y="50"').replace('ui_mm_difficulty', 'ui_mm_localization');
  const languageList = difficultyList.replaceAll('list_difficulty', 'list_localization')
    .replace(/\by="[^"]+"/, 'y="50"').replace('entry="g_game_difficulty"', 'entry="g_language"');
  if (!languageList.includes('entry="g_language"')) throw Error('Missing Clear Sky language option');
  source = source.replace(difficultyList, difficultyList + '\n' + languageCaption + '\n' + languageList);
  return Buffer.from(source, 'latin1');
}

export function patchCsGameplayOptions(bytes) {
  let source = replaceOnce(bytes.toString('latin1'),
    /([ \t]*xml:InitComboBox[^\r\n]*"tab_gameplay:list_difficulty"[^\r\n]*)/g,
    '$1\n\txml:InitStatic("tab_gameplay:cap_localization", self)\n\txml:InitComboBox("tab_gameplay:list_localization", self)',
    'gameplay language controls');
  source = replaceOnce(source,
    /\s*local btn\r?\n\s*btn = xml:Init3tButton[^\r\n]*"tab_gameplay:btn_check_updates"[^\r\n]*\r?\n\s*handler:Register[^\r\n]*\r?\n/g,
    '\n', 'desktop update button');
  return Buffer.from(source, 'latin1');
}

export function patchCsSoundOptions(bytes) {
  let source = bytes.toString('latin1');
  for (const name of ['cap_snd_device', 'list_snd_device']) {
    source = replaceOnce(source, new RegExp('^[ \\t]*xml:Init(?:Static|ComboBox)[^\\r\\n]*"tab_sound:' + name + '"[^\\r\\n]*\\r?\\n', 'gm'),
      '', name);
  }
  return Buffer.from(source, 'latin1');
}
