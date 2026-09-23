export const GO_CHROME_ENABLED_TOOLS = [
  'click', 'coordinate_mode', 'coordinate_observe', 'form_input', 'get_page_text',
  'key_press', 'key_type', 'mouse_click', 'mouse_drag', 'mouse_move', 'mouse_scroll',
  'navigate', 'read_console', 'read_page', 'screenshot', 'tabs_close', 'tabs_create',
  'tabs_list', 'release_tab',
] as const
export const GO_CHROME_DISABLED_TOOLS = ['cookies_get', 'fetch_as_page', 'javascript_exec'] as const
